const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// ============ CONFIGURATION ============
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const DATA_FILE = path.join(__dirname, 'data.json');
const TIMEZONE = 'Asia/Tashkent';

// ============ DATA MANAGEMENT ============
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error('Error loading data:', error.message);
    process.exit(1);
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving data:', error.message);
  }
}

// ============ HELPER FUNCTIONS ============
function isAdmin(username, data) {
  return data.adminUsernames.some(admin => 
    admin.toLowerCase() === username?.toLowerCase()
  );
}

function getPersonByUsername(username, data) {
  return data.roommates.find(p => 
    p.username.toLowerCase() === username?.toLowerCase()
  );
}

function getTaskPerson(taskKey, data) {
  const task = data.tasks[taskKey];
  if (!task || data.roommates.length === 0) return null;
  return data.roommates[task.currentPersonIndex % data.roommates.length];
}

function getUserTasks(username, data) {
  const userTasks = [];
  for (const [key, task] of Object.entries(data.tasks)) {
    const person = getTaskPerson(key, data);
    if (person && person.username.toLowerCase() === username?.toLowerCase()) {
      userTasks.push({ key, ...task });
    }
  }
  return userTasks;
}

function getNextPersonForTask(taskKey, data) {
  const task = data.tasks[taskKey];
  if (!task || data.roommates.length === 0) return null;
  
  const currentIndex = task.currentPersonIndex;
  
  // Find next person who doesn't already have a task
  for (let i = 1; i <= data.roommates.length; i++) {
    const nextIndex = (currentIndex + i) % data.roommates.length;
    const candidate = data.roommates[nextIndex];
    
    // Check if this person already has another task
    let hasOtherTask = false;
    for (const [otherKey, otherTask] of Object.entries(data.tasks)) {
      if (otherKey !== taskKey) {
        const otherPerson = data.roommates[otherTask.currentPersonIndex % data.roommates.length];
        if (otherPerson && otherPerson.username.toLowerCase() === candidate.username.toLowerCase()) {
          hasOtherTask = true;
          break;
        }
      }
    }
    
    if (!hasOtherTask) {
      return { person: candidate, index: nextIndex };
    }
  }
  
  // Fallback: just return next in line (if all have tasks)
  const nextIndex = (currentIndex + 1) % data.roommates.length;
  return { person: data.roommates[nextIndex], index: nextIndex };
}

function rotateTask(taskKey, data) {
  const task = data.tasks[taskKey];
  
  // If it's a penalty task, don't rotate - just clear penalty
  if (task.isPenalty) {
    task.isPenalty = false;
    task.lastDone = new Date().toISOString();
    saveData(data);
    return { person: getTaskPerson(taskKey, data), wasPenalty: true };
  }
  
  // Normal rotation
  const next = getNextPersonForTask(taskKey, data);
  if (!next) return null;
  
  task.currentPersonIndex = next.index;
  task.lastDone = new Date().toISOString();
  saveData(data);
  
  return { person: next.person, wasPenalty: false };
}

function checkAndApplyPenalties(data) {
  const now = new Date();
  const penalties = [];
  
  // Skip if no roommates
  if (data.roommates.length === 0) return penalties;
  
  for (const [key, task] of Object.entries(data.tasks)) {
    // Skip if already penalty
    if (task.isPenalty) continue;
    
    // If never done, check based on a reasonable default (skip first time)
    if (!task.lastDone) continue;
    
    const lastDone = new Date(task.lastDone);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lastDoneDay = new Date(lastDone.getFullYear(), lastDone.getMonth(), lastDone.getDate());
    
    // If done recently within interval, skip
    const daysDiff = Math.floor((today - lastDoneDay) / (1000 * 60 * 60 * 24));
    if (daysDiff < task.intervalDays) continue;
    
    // Apply penalty
    task.isPenalty = true;
    const person = getTaskPerson(key, data);
    if (person) {
      penalties.push({ task, person, key });
    }
  }
  
  if (penalties.length > 0) {
    saveData(data);
  }
  
  return penalties;
}

async function sendPenaltyNotifications(bot, penalties) {
  const data = loadData();
  
  if (!data.groupChatIds || data.groupChatIds.length === 0 || penalties.length === 0) {
    return;
  }
  
  let message = `⚠️ *JARIMA!*\n\n`;
  message += `Quyidagi vazifalar bajarilmadi va jarimaga aylandi:\n\n`;
  
  for (const p of penalties) {
    message += `🔴 ${p.task.name}\n`;
    message += `   👤 *${p.person.name}* (@${p.person.username})\n`;
    message += `   ❗ Bugun + keyingi navbat ham sizniki!\n\n`;
  }
  
  message += `😤 Jarima vazifasini bajaring, keyin yana bir marta shu vazifa sizga tushadi!`;
  
  for (const chatId of data.groupChatIds) {
    try {
      await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error(`Failed to send penalty notification to ${chatId}:`, error.message);
    }
  }
}

function formatStatusMessage(data) {
  if (data.roommates.length === 0) {
    return '❌ Hech kim navbatda yo\'q. /join buyrug\'i bilan qo\'shiling.';
  }
  
  let message = '📋 *Hozirgi vazifalar:*\n\n';
  
  for (const [key, task] of Object.entries(data.tasks)) {
    const person = getTaskPerson(key, data);
    const interval = task.intervalDays === 1 ? 'har kuni' : 
                     task.intervalDays === 7 ? 'haftada 1 marta' : 
                     `${task.intervalDays} kunda 1 marta`;
    
    const penaltyBadge = task.isPenalty ? ' 🔴 *JARIMA*' : '';
    
    message += `${task.name}${penaltyBadge}\n`;
    message += `   👤 *${person?.name || '?'}* (@${person?.username || '?'})\n`;
    message += `   ⏱ ${interval}\n`;
    if (task.isPenalty) {
      message += `   ⚠️ _Kecha bajarilmagan! +1 navbat jarima_\n`;
    }
    message += `\n`;
  }
  
  message += `💡 Vazifani tugatgach /done bosing.`;
  
  return message;
}

// ============ REMINDER MESSAGES ============
function getReminderMessage(hour, data) {
  const taskList = Object.entries(data.tasks).map(([key, task]) => {
    const person = getTaskPerson(key, data);
    const penaltyMark = task.isPenalty ? ' 🔴 JARIMA' : '';
    return `• ${task.name}${penaltyMark}\n   👤 *${person?.name}* (@${person?.username})`;
  }).join('\n\n');

  if (hour === 8) {
    // 8:00 - Muloyim, do'stona
    const greetings = [
      `🌅 *Xayrli tong, do'stlar!*\n\n📋 Bugungi vazifalar:\n\n${taskList}\n\n☕ Nonushta qilib, ishga kirishamiz!`,
      `🌞 *Assalomu alaykum!*\n\nYangi kun - yangi imkoniyat!\n\n📋 Bugungi vazifalar:\n\n${taskList}\n\n💪 Barakali kun tilayman!`,
      `🌄 *Hayrli tong!*\n\n📋 Bugun navbatchilar:\n\n${taskList}\n\n😊 Yoqimli kun o'tsin!`
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }
  
  if (hour === 12) {
    // 12:00 - O'rtacha, eslatma
    const midday = [
      `🕛 *Tushlik vaqti!*\n\n📋 Eslatma - bugungi vazifalar:\n\n${taskList}\n\n🍽️ Ovqatdan keyin bajaramizmi?`,
      `☀️ *Kun yarmi o'tdi!*\n\n📋 Vazifalar hali bajarilmagan bo'lsa:\n\n${taskList}\n\n⏰ Vaqt bor hali!`,
      `🔔 *Eslatma*\n\n📋 Navbatchilar, vazifalaringizni unutmang:\n\n${taskList}`
    ];
    return midday[Math.floor(Math.random() * midday.length)];
  }
  
  if (hour === 20) {
    // 20:00 - Jiddiyroq
    const evening = [
      `🌆 *Kechqurun bo'ldi!*\n\n📋 Vazifalar bajarilganmi?\n\n${taskList}\n\n⚠️ Uxlashdan oldin tugatish kerak!`,
      `🌙 *Diqqat!*\n\nKun tugashiga oz qoldi!\n\n📋 Vazifalar:\n\n${taskList}\n\n🏃 Shoshiling!`,
      `⏰ *Vaqt o'tmoqda!*\n\n📋 Bugungi vazifalar:\n\n${taskList}\n\n❗ Iltimos, bajarilmagan bo'lsa, hozir boshlang!`
    ];
    return evening[Math.floor(Math.random() * evening.length)];
  }
  
  if (hour === 23) {
    // 23:00 - Nervous, jiddiy
    const night = [
      `🚨 *OXIRGI ESLATMA!*\n\n📋 Vazifalar HALI bajarilmadimi?!\n\n${taskList}\n\n😤 Ertaga emas, BUGUN bajaring!`,
      `‼️ *DIQQAT!*\n\nSoat 23:00!\n\n📋 Vazifalar:\n\n${taskList}\n\n😡 Hoziroq bajaring yoki jarima olasiz!`,
      `🔴 *SHOSHILINCH!*\n\nKun tugayapti!\n\n📋 Navbatchilar:\n\n${taskList}\n\n💢 /done qilmasangiz, JARIMA!`,
      `⚡ *OXIRGI OGOHLANTIRISH!*\n\n📋 Bugungi vazifalar:\n\n${taskList}\n\n🙄 1 soatdan keyin jarima yoziladi!`
    ];
    return night[Math.floor(Math.random() * night.length)];
  }
  
  return null;
}

function registerGroupChat(chatId, data) {
  if (!data.groupChatIds) {
    data.groupChatIds = [];
  }
  if (!data.groupChatIds.includes(chatId)) {
    data.groupChatIds.push(chatId);
    saveData(data);
    return true;
  }
  return false;
}

async function sendReminders(bot, hour) {
  const data = loadData();
  const message = getReminderMessage(hour, data);
  
  if (!message || !data.groupChatIds || data.groupChatIds.length === 0) {
    return;
  }
  
  for (const chatId of data.groupChatIds) {
    try {
      await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error(`Failed to send reminder to ${chatId}:`, error.message);
    }
  }
}

// ============ BOT SETUP ============
const bot = new Telegraf(BOT_TOKEN);

// Middleware to register group chat
bot.use((ctx, next) => {
  if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
    const data = loadData();
    registerGroupChat(ctx.chat.id, data);
  }
  return next();
});

// /start command
bot.start((ctx) => {
  const chatType = ctx.chat.type;
  let extraMsg = '';
  
  if (chatType === 'group' || chatType === 'supergroup') {
    const data = loadData();
    registerGroupChat(ctx.chat.id, data);
    extraMsg = '\n\n✅ Bu guruh eslatmalar uchun ro\'yxatga olindi!';
  }
  
  ctx.reply(`🏠 *Uy tozalash navbati boti*

Assalomu alaykum! Bu bot xonadoningiz uchun tozalash navbatini boshqaradi.

*Vazifalar:*
🗑️ Axlat to'kish - 2 kunda 1 marta
🧹 Supurish - 2 kunda 1 marta  
🚿 Vanna/hojatxona - haftada 1 marta

*Buyruqlar:*
/status - Hozirgi navbatlarni ko'rish
/done - Vazifani tugatganingizni bildirish
/list - Sheriklar ro'yxati
/mytasks - Mening vazifalarim
/join - Navbatga qo'shilish
/help - Yordam${extraMsg}`, 
    { parse_mode: 'Markdown' }
  );
});

// /help command
bot.help((ctx) => {
  ctx.reply(`📖 *Yordam*

*Asosiy buyruqlar:*
• /status - Hozirgi vazifalar va navbatchilar
• /done - Vazifani tugatdim (tasdiqlash so'raladi)
• /mytasks - Mening vazifalarim
• /list - Sheriklar ro'yxati
• /join - Navbatga qo'shilish
• /leave - Navbatdan chiqish

*Admin buyruqlari:*
• /skip [vazifa] - Navbatni o'tkazish
• /adduser @username Ism - Foydalanuvchi qo'shish
• /removeuser @username - Foydalanuvchi o'chirish

*Vazifa kodlari:* trash, sweeping, bathroom`,
    { parse_mode: 'Markdown' }
  );
});

// /status command
bot.command('status', (ctx) => {
  const data = loadData();
  ctx.reply(formatStatusMessage(data), { parse_mode: 'Markdown' });
});

// /mytasks command
bot.command('mytasks', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  
  if (!username) {
    return ctx.reply('❌ Sizda Telegram username yo\'q.');
  }
  
  const myTasks = getUserTasks(username, data);
  
  if (myTasks.length === 0) {
    return ctx.reply('✨ Sizda hozircha vazifa yo\'q!');
  }
  
  let message = `📝 *Sizning vazifalaringiz:*\n\n`;
  myTasks.forEach(task => {
    message += `• ${task.name}\n`;
  });
  message += `\nTugatgach /done bosing.`;
  
  ctx.reply(message, { parse_mode: 'Markdown' });
});

// /done command - show task selection
bot.command('done', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  
  if (!username) {
    return ctx.reply('❌ Sizda Telegram username yo\'q.');
  }
  
  const myTasks = getUserTasks(username, data);
  
  if (myTasks.length === 0) {
    return ctx.reply('⚠️ Sizda hozir hech qanday vazifa yo\'q.');
  }
  
  const buttons = myTasks.map(task => {
    const penaltyMark = task.isPenalty ? ' 🔴' : '';
    return [Markup.button.callback(`${task.name}${penaltyMark}`, `done_${task.key}`)];
  });
  
  ctx.reply(
    `🧹 Qaysi vazifani tugatdingiz?`,
    Markup.inlineKeyboard(buttons)
  );
});

// Handle task done selection
bot.action(/^done_(.+)$/, (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  const taskKey = ctx.match[1];
  
  const task = data.tasks[taskKey];
  if (!task) {
    return ctx.answerCbQuery('❌ Vazifa topilmadi!');
  }
  
  const taskPerson = getTaskPerson(taskKey, data);
  if (!taskPerson || taskPerson.username.toLowerCase() !== username?.toLowerCase()) {
    return ctx.answerCbQuery('❌ Bu vazifa sizga tegishli emas!');
  }
  
  const person = getPersonByUsername(username, data);
  
  // If it's a penalty task - no approval needed, just confirm
  if (task.isPenalty) {
    const result = rotateTask(taskKey, data);
    
    ctx.editMessageText(
      `🔴 *JARIMA TO'LANDI!*\n\n` +
      `*${person.name}* ${task.name} jarimani bajardi.\n\n` +
      `⚠️ Keyingi navbat ham *${person.name}*ga tegishli!\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${task.name} → *${person.name}* (@${person.username})`,
      { parse_mode: 'Markdown' }
    );
    
    return ctx.answerCbQuery('🔴 Jarima to\'landi!');
  }
  
  // Regular task - ask for approval
  ctx.editMessageText(
    `🧹 *${person.name}* ${task.name} vazifasini tugatdi!\n\n` +
    `Hamma rozimi? Tasdiqlash uchun tugmani bosing:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Ha, roziman', `approve_${taskKey}_${username}`)
      ])
    }
  );
  
  ctx.answerCbQuery();
});

// Handle approval (only for regular tasks now)
bot.action(/^approve_(.+)_(.+)$/, (ctx) => {
  const data = loadData();
  const approverUsername = ctx.from.username;
  const approverName = ctx.from.first_name || 'Kimdir';
  const taskKey = ctx.match[1];
  const dutyUsername = ctx.match[2];
  
  const task = data.tasks[taskKey];
  if (!task) {
    return ctx.answerCbQuery('❌ Vazifa topilmadi!');
  }
  
  const currentPerson = getTaskPerson(taskKey, data);
  if (!currentPerson || currentPerson.username.toLowerCase() !== dutyUsername.toLowerCase()) {
    return ctx.answerCbQuery('⚠️ Navbat allaqachon almashgan!');
  }
  
  // Don't allow self-approval
  if (approverUsername?.toLowerCase() === dutyUsername.toLowerCase()) {
    return ctx.answerCbQuery('❌ O\'zingizni o\'zingiz tasdiqlay olmaysiz!');
  }
  
  const completedPerson = currentPerson;
  const result = rotateTask(taskKey, data);
  
  ctx.editMessageText(
    `✅ *${completedPerson.name}* ${task.name} vazifasini tugatdi!\n\n` +
    `👍 *${approverName}* tasdiqladi.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔄 *Navbat almashdi!*\n` +
    `${task.name} → *${result.person.name}* (@${result.person.username})`,
    { parse_mode: 'Markdown' }
  );
  
  ctx.answerCbQuery('✅ Tasdiqlandi!');
});

// /list command
bot.command('list', (ctx) => {
  const data = loadData();
  
  if (data.roommates.length === 0) {
    return ctx.reply('👥 Hech kim navbatda yo\'q. /join bilan qo\'shiling.');
  }
  
  const list = data.roommates.map((person, index) => {
    const tasks = getUserTasks(person.username, data);
    const taskIcons = tasks.map(t => {
      if (t.key === 'trash') return '🗑️';
      if (t.key === 'sweeping') return '🧹';
      if (t.key === 'bathroom') return '🚿';
      return '📌';
    }).join(' ');
    
    return `${index + 1}. *${person.name}* (@${person.username}) ${taskIcons}`;
  }).join('\n');
  
  ctx.reply(`👥 *Sheriklar ro'yxati:*\n\n${list}`, { parse_mode: 'Markdown' });
});

// /join command
bot.command('join', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  const firstName = ctx.from.first_name || 'Foydalanuvchi';
  
  if (!username) {
    return ctx.reply('❌ Sizda Telegram username yo\'q. Settings → Username dan o\'rnating.');
  }
  
  const exists = data.roommates.some(p => p.username.toLowerCase() === username.toLowerCase());
  if (exists) {
    return ctx.reply(`⚠️ @${username}, siz allaqachon navbatdasiz!`);
  }
  
  const newId = data.roommates.length > 0 
    ? Math.max(...data.roommates.map(p => p.id)) + 1 
    : 1;
  
  data.roommates.push({
    id: newId,
    name: firstName,
    username: username
  });
  saveData(data);
  
  ctx.reply(
    `✅ *${firstName}* navbatga qo'shildi!\n📍 O'rningiz: ${data.roommates.length}`,
    { parse_mode: 'Markdown' }
  );
});

// /leave command
bot.command('leave', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  
  if (!username) {
    return ctx.reply('❌ Sizda Telegram username yo\'q.');
  }
  
  const index = data.roommates.findIndex(p => p.username.toLowerCase() === username.toLowerCase());
  
  if (index === -1) {
    return ctx.reply(`⚠️ @${username}, siz navbatda emassiz.`);
  }
  
  // Check if person has active tasks
  const myTasks = getUserTasks(username, data);
  if (myTasks.length > 0) {
    const taskNames = myTasks.map(t => t.name).join(', ');
    return ctx.reply(`❌ Sizda hali vazifalar bor: ${taskNames}\nAvval /done qiling yoki admin /skip qilsin.`);
  }
  
  const removedPerson = data.roommates[index];
  data.roommates.splice(index, 1);
  
  // Adjust task indices
  for (const task of Object.values(data.tasks)) {
    if (task.currentPersonIndex >= data.roommates.length && data.roommates.length > 0) {
      task.currentPersonIndex = task.currentPersonIndex % data.roommates.length;
    }
  }
  
  saveData(data);
  
  ctx.reply(`👋 *${removedPerson.name}* navbatdan chiqdi.`, { parse_mode: 'Markdown' });
});

// /skip command (admin)
bot.command('skip', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  
  if (!isAdmin(username, data)) {
    return ctx.reply('⛔ Bu buyruq faqat adminlar uchun!');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length === 0) {
    const taskList = Object.entries(data.tasks)
      .map(([key, task]) => `• \`${key}\` - ${task.name}`)
      .join('\n');
    return ctx.reply(`Foydalanish: /skip [vazifa_kodi]\n\n${taskList}`, { parse_mode: 'Markdown' });
  }
  
  const taskKey = args[0].toLowerCase();
  const task = data.tasks[taskKey];
  
  if (!task) {
    return ctx.reply('❌ Vazifa topilmadi. Kodlar: trash, sweeping, bathroom');
  }
  
  const oldPerson = getTaskPerson(taskKey, data);
  const result = rotateTask(taskKey, data);
  
  ctx.reply(
    `⏭️ *Navbat o'tkazildi!*\n\n` +
    `${task.name}:\n` +
    `${oldPerson.name} → *${result.person.name}* (@${result.person.username})`,
    { parse_mode: 'Markdown' }
  );
});

// /setduty command (admin) - set specific person for a task
bot.command('setduty', (ctx) => {
  const data = loadData();
  
  if (!isAdmin(ctx.from.username, data)) {
    return ctx.reply('⛔ Bu buyruq faqat adminlar uchun!');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length < 2) {
    const taskList = Object.entries(data.tasks)
      .map(([key, task]) => `• \`${key}\` - ${task.name}`)
      .join('\n');
    const personList = data.roommates
      .map((p, i) => `• ${i + 1}. ${p.name} (@${p.username})`)
      .join('\n');
    
    return ctx.reply(
      `Foydalanish: /setduty [vazifa] [raqam yoki @username]\n\n` +
      `*Vazifalar:*\n${taskList}\n\n` +
      `*Odamlar:*\n${personList}\n\n` +
      `Misol: \`/setduty trash 2\` yoki \`/setduty sweeping @username\``,
      { parse_mode: 'Markdown' }
    );
  }
  
  const taskKey = args[0].toLowerCase();
  const task = data.tasks[taskKey];
  
  if (!task) {
    return ctx.reply('❌ Vazifa topilmadi. Kodlar: trash, sweeping, bathroom');
  }
  
  let personIndex = -1;
  const personArg = args[1];
  
  // Check if it's a number or username
  if (/^\d+$/.test(personArg)) {
    personIndex = parseInt(personArg) - 1;
  } else {
    const username = personArg.replace('@', '');
    personIndex = data.roommates.findIndex(p => 
      p.username.toLowerCase() === username.toLowerCase()
    );
  }
  
  if (personIndex < 0 || personIndex >= data.roommates.length) {
    return ctx.reply('❌ Odam topilmadi. Raqam yoki @username kiriting.');
  }
  
  const oldPerson = getTaskPerson(taskKey, data);
  data.tasks[taskKey].currentPersonIndex = personIndex;
  data.tasks[taskKey].isPenalty = false; // Reset penalty when manually setting
  saveData(data);
  
  const newPerson = data.roommates[personIndex];
  
  ctx.reply(
    `✅ *Navbat o'zgartirildi!*\n\n` +
    `${task.name}:\n` +
    `${oldPerson.name} → *${newPerson.name}* (@${newPerson.username})`,
    { parse_mode: 'Markdown' }
  );
});

// /resetpenalty command (admin) - remove penalty from a task
bot.command('resetpenalty', (ctx) => {
  const data = loadData();
  
  if (!isAdmin(ctx.from.username, data)) {
    return ctx.reply('⛔ Bu buyruq faqat adminlar uchun!');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length < 1) {
    const penaltyTasks = Object.entries(data.tasks)
      .filter(([key, task]) => task.isPenalty)
      .map(([key, task]) => `• \`${key}\` - ${task.name}`)
      .join('\n');
    
    if (!penaltyTasks) {
      return ctx.reply('✅ Hozirda hech qanday jarima yo\'q.');
    }
    
    return ctx.reply(
      `Foydalanish: /resetpenalty [vazifa]\n\n` +
      `*Jarimali vazifalar:*\n${penaltyTasks}`,
      { parse_mode: 'Markdown' }
    );
  }
  
  const taskKey = args[0].toLowerCase();
  const task = data.tasks[taskKey];
  
  if (!task) {
    return ctx.reply('❌ Vazifa topilmadi. Kodlar: trash, sweeping, bathroom');
  }
  
  if (!task.isPenalty) {
    return ctx.reply(`ℹ️ ${task.name} da jarima yo'q.`);
  }
  
  task.isPenalty = false;
  saveData(data);
  
  ctx.reply(`✅ ${task.name} dan jarima olib tashlandi.`);
});

// /adduser command (admin)
bot.command('adduser', (ctx) => {
  const data = loadData();
  
  if (!isAdmin(ctx.from.username, data)) {
    return ctx.reply('⛔ Bu buyruq faqat adminlar uchun!');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Foydalanish: /adduser @username Ism');
  }
  
  const targetUsername = args[0].replace('@', '');
  const name = args.slice(1).join(' ');
  
  const exists = data.roommates.some(p => p.username.toLowerCase() === targetUsername.toLowerCase());
  if (exists) {
    return ctx.reply(`⚠️ @${targetUsername} allaqachon navbatda!`);
  }
  
  const newId = data.roommates.length > 0 ? Math.max(...data.roommates.map(p => p.id)) + 1 : 1;
  
  data.roommates.push({ id: newId, name, username: targetUsername });
  saveData(data);
  
  ctx.reply(`✅ *${name}* (@${targetUsername}) qo'shildi!`, { parse_mode: 'Markdown' });
});

// /removeuser command (admin)
bot.command('removeuser', (ctx) => {
  const data = loadData();
  
  if (!isAdmin(ctx.from.username, data)) {
    return ctx.reply('⛔ Bu buyruq faqat adminlar uchun!');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Foydalanish: /removeuser @username');
  }
  
  const targetUsername = args[0].replace('@', '');
  const index = data.roommates.findIndex(p => p.username.toLowerCase() === targetUsername.toLowerCase());
  
  if (index === -1) {
    return ctx.reply(`⚠️ @${targetUsername} topilmadi.`);
  }
  
  const removed = data.roommates.splice(index, 1)[0];
  
  // Adjust task indices
  for (const task of Object.values(data.tasks)) {
    if (task.currentPersonIndex >= data.roommates.length && data.roommates.length > 0) {
      task.currentPersonIndex = task.currentPersonIndex % data.roommates.length;
    }
  }
  
  saveData(data);
  
  ctx.reply(`🗑️ *${removed.name}* o'chirildi.`, { parse_mode: 'Markdown' });
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Xatolik yuz berdi.');
});

// ============ SCHEDULED REMINDERS ============
// 08:00 - Muloyim eslatma
cron.schedule('0 8 * * *', () => {
  console.log('⏰ Sending 8:00 reminder...');
  sendReminders(bot, 8);
}, { timezone: TIMEZONE });

// 12:00 - O'rtacha eslatma
cron.schedule('0 12 * * *', () => {
  console.log('⏰ Sending 12:00 reminder...');
  sendReminders(bot, 12);
}, { timezone: TIMEZONE });

// 20:00 - Jiddiy eslatma
cron.schedule('0 20 * * *', () => {
  console.log('⏰ Sending 20:00 reminder...');
  sendReminders(bot, 20);
}, { timezone: TIMEZONE });

// 23:00 - Nervous eslatma
cron.schedule('0 23 * * *', () => {
  console.log('⏰ Sending 23:00 reminder...');
  sendReminders(bot, 23);
}, { timezone: TIMEZONE });

// 00:01 - Yarim tunda jarima tekshiruvi
cron.schedule('1 0 * * *', async () => {
  console.log('🔴 Checking for penalties...');
  const data = loadData();
  const penalties = checkAndApplyPenalties(data);
  if (penalties.length > 0) {
    console.log(`🔴 Applied ${penalties.length} penalties`);
    await sendPenaltyNotifications(bot, penalties);
  }
}, { timezone: TIMEZONE });

// ============ START BOT ============
bot.launch()
  .then(() => {
    console.log('🤖 Bot ishga tushdi!');
    console.log('⏰ Eslatmalar: 08:00, 12:00, 20:00, 23:00 (Toshkent vaqti)');
    console.log('🔴 Jarima tekshiruvi: 00:01 (Toshkent vaqti)');
  })
  .catch((err) => {
    console.error('Bot ishga tushmadi:', err.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
