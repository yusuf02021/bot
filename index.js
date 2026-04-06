const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const DATA_FILE = path.join(__dirname, 'data.json');
const TIMEZONE = 'Asia/Tashkent';

// ============ DATA MANAGEMENT ============
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    console.error('Error loading data:', error.message);
    process.exit(1);
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ============ HELPER FUNCTIONS ============
function isAdmin(username, data) {
  return data.adminUsernames.some(a => a.toLowerCase() === username?.toLowerCase());
}

function getTaskPerson(taskKey, data) {
  const task = data.tasks[taskKey];
  if (!task || data.roommates.length === 0) return null;
  return data.roommates[task.currentPersonIndex % data.roommates.length];
}

function isTaskDue(task, taskKey) {
  const now = new Date();
  
  // Vanna - faqat yakshanba kuni
  if (taskKey === 'bathroom') {
    const isSunday = now.getDay() === 0; // 0 = yakshanba
    if (!isSunday) return false;
    
    // Yakshanba, lekin bugun allaqachon qilinganmi?
    if (task.lastDone) {
      const lastDone = new Date(task.lastDone);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const lastDay = new Date(lastDone.getFullYear(), lastDone.getMonth(), lastDone.getDate());
      if (lastDay.getTime() === today.getTime()) return false; // Bugun qilingan
    }
    return true;
  }
  
  // Boshqa tasklar - intervalDays bo'yicha
  if (!task.lastDone) return true; // Hech qachon qilinmagan = due
  
  const lastDone = new Date(task.lastDone);
  const lastDay = new Date(lastDone.getFullYear(), lastDone.getMonth(), lastDone.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysDiff = Math.floor((today - lastDay) / (1000 * 60 * 60 * 24));
  
  return daysDiff >= task.intervalDays;
}

function getUserTasks(username, data) {
  const userTasks = [];
  for (const [key, task] of Object.entries(data.tasks)) {
    const person = getTaskPerson(key, data);
    if (person && person.username.toLowerCase() === username?.toLowerCase()) {
      // Only include if task is due or has penalty
      if (isTaskDue(task, key) || task.isPenalty) {
        userTasks.push({ key, ...task });
      }
    }
  }
  return userTasks;
}

function getNextPersonForTask(taskKey, data) {
  const task = data.tasks[taskKey];
  if (!task || data.roommates.length === 0) return null;
  
  const currentIndex = task.currentPersonIndex;
  
  for (let i = 1; i <= data.roommates.length; i++) {
    const nextIndex = (currentIndex + i) % data.roommates.length;
    const candidate = data.roommates[nextIndex];
    
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
  
  const nextIndex = (currentIndex + 1) % data.roommates.length;
  return { person: data.roommates[nextIndex], index: nextIndex };
}

function rotateTask(taskKey, data) {
  const task = data.tasks[taskKey];
  
  if (task.isPenalty) {
    task.isPenalty = false;
    task.lastDone = new Date().toISOString();
    saveData(data);
    return { person: getTaskPerson(taskKey, data), wasPenalty: true };
  }
  
  const next = getNextPersonForTask(taskKey, data);
  if (!next) return null;
  
  task.currentPersonIndex = next.index;
  task.lastDone = new Date().toISOString();
  saveData(data);
  
  return { person: next.person, wasPenalty: false };
}

function registerGroupChat(chatId, data) {
  if (!data.groupChatIds) data.groupChatIds = [];
  if (!data.groupChatIds.includes(chatId)) {
    data.groupChatIds.push(chatId);
    saveData(data);
  }
}

function formatStatus(data) {
  if (data.roommates.length === 0) {
    return '❌ Hech kim navbatda yo\'q. /join bilan qo\'shiling.';
  }
  
  let msg = '📋 Bugungi vazifalar:\n\n';
  let hasDueTasks = false;
  
  for (const [key, task] of Object.entries(data.tasks)) {
    const person = getTaskPerson(key, data);
    const interval = task.intervalDays === 7 ? 'haftada 1' : `${task.intervalDays} kunda 1`;
    const penalty = task.isPenalty ? ' 🔴 JARIMA' : '';
    const isDue = isTaskDue(task, key) || task.isPenalty;
    
    if (isDue) {
      hasDueTasks = true;
      msg += `${task.name}${penalty}\n`;
      msg += `   👤 ${person?.name || '?'} (@${person?.username || '?'})\n`;
      msg += `   ⏱ ${interval} marta\n\n`;
    }
  }
  
  if (!hasDueTasks) {
    msg += '✨ Bugun hech qanday vazifa yo\'q!\n\n';
  }
  
  msg += '━━━━━━━━━━━━━━━━━━━━━\n📅 Barcha vazifalar navbati: /fullstatus';
  
  return msg;
}

// ============ BOT ============
const bot = new Telegraf(BOT_TOKEN);

bot.use((ctx, next) => {
  if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
    const data = loadData();
    registerGroupChat(ctx.chat.id, data);
  }
  return next();
});

bot.start((ctx) => {
  ctx.reply(`🏠 Uy tozalash navbati boti

Buyruqlar:
/status - Hozirgi vazifalar
/join - Navbatga qo'shilish
/leave - Navbatdan chiqish
/done - Vazifani tugatdim
/list - Sheriklar ro'yxati
/mytasks - Mening vazifalarim
/help - Yordam`);
});

bot.help((ctx) => {
  ctx.reply(`📖 Yordam

Asosiy:
/status - Vazifalar va navbatchilar
/join - Navbatga qo'shilish
/leave - Chiqish
/done - Vazifa tugadi
/list - Ro'yxat
/mytasks - Mening vazifalarim

Admin:
/skip [vazifa] - O'tkazish
/setduty [vazifa] [raqam] - Navbatni belgilash
/adduser @user Ism - Qo'shish
/removeuser @user - O'chirish
/resetpenalty [vazifa] - Jarimani olib tashlash

Vazifa kodlari: trash, sweeping, bathroom`);
});

bot.command('status', (ctx) => {
  const data = loadData();
  ctx.reply(formatStatus(data));
});

// Full status - barcha vazifalar (due yoki yo'qligidan qat'i nazar)
bot.command('fullstatus', (ctx) => {
  const data = loadData();
  if (data.roommates.length === 0) {
    return ctx.reply('❌ Hech kim navbatda yo\'q. /join bilan qo\'shiling.');
  }
  
  let msg = '📋 Barcha vazifalar navbati:\n\n';
  for (const [key, task] of Object.entries(data.tasks)) {
    const person = getTaskPerson(key, data);
    const interval = task.intervalDays === 7 ? 'haftada 1' : `${task.intervalDays} kunda 1`;
    const penalty = task.isPenalty ? ' 🔴 JARIMA' : '';
    const isDue = isTaskDue(task, key) || task.isPenalty;
    const dueStatus = isDue ? '⚠️ BAJARISH KERAK' : '✅ Yaqinda bajarildi';
    const lastDone = task.lastDone ? new Date(task.lastDone).toLocaleDateString('uz-UZ') : 'hech qachon';
    
    msg += `${task.name}${penalty}\n`;
    msg += `   👤 ${person?.name || '?'} (@${person?.username || '?'})\n`;
    msg += `   ⏱ ${interval} marta\n`;
    msg += `   📅 Oxirgi: ${lastDone}\n`;
    msg += `   ${dueStatus}\n\n`;
  }
  return ctx.reply(msg);
});

bot.command('list', (ctx) => {
  const data = loadData();
  if (data.roommates.length === 0) {
    return ctx.reply('👥 Hech kim yo\'q. /join bilan qo\'shiling.');
  }
  
  let msg = '👥 Sheriklar:\n\n';
  data.roommates.forEach((p, i) => {
    const tasks = getUserTasks(p.username, data);
    const icons = tasks.map(t => t.key === 'trash' ? '🗑️' : t.key === 'sweeping' ? '🧹' : '🚿').join(' ');
    msg += `${i + 1}. ${p.name} (@${p.username}) ${icons}\n`;
  });
  ctx.reply(msg);
});

bot.command('mytasks', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  if (!username) return ctx.reply('❌ Sizda username yo\'q.');
  
  const tasks = getUserTasks(username, data);
  if (tasks.length === 0) return ctx.reply('✨ Sizda vazifa yo\'q!');
  
  let msg = '📝 Sizning vazifalaringiz:\n\n';
  tasks.forEach(t => { msg += `• ${t.name}\n`; });
  msg += '\nTugatgach /done bosing.';
  ctx.reply(msg);
});

bot.command('join', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  const name = ctx.from.first_name || 'Foydalanuvchi';
  
  if (!username) return ctx.reply('❌ Sizda username yo\'q. Settings → Username dan o\'rnating.');
  
  if (data.roommates.some(p => p.username.toLowerCase() === username.toLowerCase())) {
    return ctx.reply('⚠️ Siz allaqachon navbatdasiz!');
  }
  
  const newId = data.roommates.length > 0 ? Math.max(...data.roommates.map(p => p.id)) + 1 : 1;
  data.roommates.push({ id: newId, name, username });
  saveData(data);
  
  ctx.reply(`✅ ${name} (@${username}) navbatga qo'shildi!\n📍 O'rningiz: ${data.roommates.length}`);
});

bot.command('leave', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  if (!username) return ctx.reply('❌ Username yo\'q.');
  
  const index = data.roommates.findIndex(p => p.username.toLowerCase() === username.toLowerCase());
  if (index === -1) return ctx.reply('⚠️ Siz navbatda emassiz.');
  
  const tasks = getUserTasks(username, data);
  if (tasks.length > 0) {
    return ctx.reply('❌ Sizda vazifalar bor. Avval /done qiling yoki admin /skip qilsin.');
  }
  
  const removed = data.roommates.splice(index, 1)[0];
  for (const task of Object.values(data.tasks)) {
    if (task.currentPersonIndex >= data.roommates.length && data.roommates.length > 0) {
      task.currentPersonIndex = task.currentPersonIndex % data.roommates.length;
    }
  }
  saveData(data);
  
  ctx.reply(`👋 ${removed.name} navbatdan chiqdi.`);
});

bot.command('done', (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  if (!username) return ctx.reply('❌ Username yo\'q.');
  
  const tasks = getUserTasks(username, data);
  if (tasks.length === 0) return ctx.reply('⚠️ Sizda vazifa yo\'q.');
  
  const buttons = tasks.map(t => {
    const mark = t.isPenalty ? ' 🔴' : '';
    return [Markup.button.callback(`${t.name}${mark}`, `done_${t.key}`)];
  });
  
  ctx.reply('🧹 Qaysi vazifani tugatdingiz?', Markup.inlineKeyboard(buttons));
});

bot.action(/^done_(.+)$/, (ctx) => {
  const data = loadData();
  const username = ctx.from.username;
  const taskKey = ctx.match[1];
  const task = data.tasks[taskKey];
  
  if (!task) return ctx.answerCbQuery('❌ Vazifa topilmadi!');
  
  const taskPerson = getTaskPerson(taskKey, data);
  if (!taskPerson || taskPerson.username.toLowerCase() !== username?.toLowerCase()) {
    return ctx.answerCbQuery('❌ Bu vazifa sizga tegishli emas!');
  }
  
  const person = data.roommates.find(p => p.username.toLowerCase() === username.toLowerCase());
  
  if (task.isPenalty) {
    const result = rotateTask(taskKey, data);
    ctx.editMessageText(
      `🔴 JARIMA TO'LANDI!\n\n${person.name} ${task.name} jarimani bajardi.\n\n` +
      `⚠️ Keyingi navbat ham ${person.name}ga tegishli!`
    );
    return ctx.answerCbQuery('🔴 Jarima to\'landi!');
  }
  
  ctx.editMessageText(
    `🧹 ${person.name} ${task.name} vazifasini tugatdi!\n\nHamma rozimi?`,
    Markup.inlineKeyboard([Markup.button.callback('✅ Ha, roziman', `approve_${taskKey}_${username}`)])
  );
  ctx.answerCbQuery();
});

bot.action(/^approve_(.+)_(.+)$/, (ctx) => {
  const data = loadData();
  const approver = ctx.from.first_name || 'Kimdir';
  const approverUsername = ctx.from.username;
  const taskKey = ctx.match[1];
  const dutyUsername = ctx.match[2];
  
  const task = data.tasks[taskKey];
  if (!task) return ctx.answerCbQuery('❌ Vazifa topilmadi!');
  
  // dutyUsername bo'yicha tekshirish - callback'dagi username ishlatiladi
  const dutyPerson = data.roommates.find(p => p.username.toLowerCase() === dutyUsername.toLowerCase());
  if (!dutyPerson) {
    return ctx.answerCbQuery('❌ Foydalanuvchi topilmadi!');
  }
  
  // Hozirgi navbatchi hali ham shu odammi tekshirish
  const currentPerson = getTaskPerson(taskKey, data);
  if (!currentPerson || currentPerson.username.toLowerCase() !== dutyUsername.toLowerCase()) {
    return ctx.answerCbQuery('⚠️ Navbat allaqachon almashgan!');
  }
  
  if (approverUsername?.toLowerCase() === dutyUsername.toLowerCase()) {
    return ctx.answerCbQuery('❌ O\'zingizni tasdiqlay olmaysiz!');
  }
  
  const result = rotateTask(taskKey, data);
  
  ctx.editMessageText(
    `✅ ${dutyPerson.name} ${task.name} vazifasini tugatdi!\n\n` +
    `👍 ${approver} tasdiqladi.\n\n` +
    `🔄 Navbat almashdi!\n${task.name} → ${result.person.name} (@${result.person.username})`
  );
  ctx.answerCbQuery('✅ Tasdiqlandi!');
});

// Admin commands
bot.command('skip', (ctx) => {
  const data = loadData();
  if (!isAdmin(ctx.from.username, data)) return ctx.reply('⛔ Faqat admin!');
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('Foydalanish: /skip [trash|sweeping|bathroom]');
  }
  
  const taskKey = args[0].toLowerCase();
  const task = data.tasks[taskKey];
  if (!task) return ctx.reply('❌ Vazifa topilmadi.');
  
  const oldPerson = getTaskPerson(taskKey, data);
  const result = rotateTask(taskKey, data);
  
  ctx.reply(`⏭️ Navbat o'tkazildi!\n${task.name}: ${oldPerson.name} → ${result.person.name}`);
});

bot.command('setduty', (ctx) => {
  const data = loadData();
  if (!isAdmin(ctx.from.username, data)) return ctx.reply('⛔ Faqat admin!');
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    let msg = 'Foydalanish: /setduty [vazifa] [raqam]\n\nVazifalar: trash, sweeping, bathroom\n\nOdamlar:\n';
    data.roommates.forEach((p, i) => { msg += `${i + 1}. ${p.name}\n`; });
    return ctx.reply(msg);
  }
  
  const taskKey = args[0].toLowerCase();
  const task = data.tasks[taskKey];
  if (!task) return ctx.reply('❌ Vazifa topilmadi.');
  
  let idx = -1;
  if (/^\d+$/.test(args[1])) {
    idx = parseInt(args[1]) - 1;
  } else {
    const uname = args[1].replace('@', '');
    idx = data.roommates.findIndex(p => p.username.toLowerCase() === uname.toLowerCase());
  }
  
  if (idx < 0 || idx >= data.roommates.length) return ctx.reply('❌ Odam topilmadi.');
  
  task.currentPersonIndex = idx;
  task.isPenalty = false;
  saveData(data);
  
  ctx.reply(`✅ ${task.name} → ${data.roommates[idx].name}`);
});

bot.command('adduser', (ctx) => {
  const data = loadData();
  if (!isAdmin(ctx.from.username, data)) return ctx.reply('⛔ Faqat admin!');
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('Foydalanish: /adduser @username Ism');
  
  const username = args[0].replace('@', '');
  const name = args.slice(1).join(' ');
  
  if (data.roommates.some(p => p.username.toLowerCase() === username.toLowerCase())) {
    return ctx.reply('⚠️ Allaqachon bor!');
  }
  
  const newId = data.roommates.length > 0 ? Math.max(...data.roommates.map(p => p.id)) + 1 : 1;
  data.roommates.push({ id: newId, name, username });
  saveData(data);
  
  ctx.reply(`✅ ${name} (@${username}) qo'shildi!`);
});

bot.command('removeuser', (ctx) => {
  const data = loadData();
  if (!isAdmin(ctx.from.username, data)) return ctx.reply('⛔ Faqat admin!');
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('Foydalanish: /removeuser @username');
  
  const username = args[0].replace('@', '');
  const idx = data.roommates.findIndex(p => p.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return ctx.reply('⚠️ Topilmadi.');
  
  const removed = data.roommates.splice(idx, 1)[0];
  for (const task of Object.values(data.tasks)) {
    if (task.currentPersonIndex >= data.roommates.length && data.roommates.length > 0) {
      task.currentPersonIndex = task.currentPersonIndex % data.roommates.length;
    }
  }
  saveData(data);
  
  ctx.reply(`🗑️ ${removed.name} o'chirildi.`);
});

bot.command('resetpenalty', (ctx) => {
  const data = loadData();
  if (!isAdmin(ctx.from.username, data)) return ctx.reply('⛔ Faqat admin!');
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('Foydalanish: /resetpenalty [trash|sweeping|bathroom]');
  
  const task = data.tasks[args[0].toLowerCase()];
  if (!task) return ctx.reply('❌ Vazifa topilmadi.');
  
  task.isPenalty = false;
  saveData(data);
  ctx.reply(`✅ ${task.name} jarimasi olib tashlandi.`);
});

// ============ REMINDERS ============
function sendReminder(hour) {
  const data = loadData();
  if (!data.groupChatIds?.length || data.roommates.length === 0) return;
  
  // Faqat bugungi due vazifalarni ko'rsatish
  let taskList = '';
  let hasDueTasks = false;
  for (const [key, task] of Object.entries(data.tasks)) {
    if (!isTaskDue(task, key) && !task.isPenalty) continue; // Skip if not due
    hasDueTasks = true;
    const person = getTaskPerson(key, data);
    const penalty = task.isPenalty ? ' 🔴 JARIMA' : '';
    taskList += `• ${task.name}${penalty}\n   👤 ${person?.name} (@${person?.username})\n\n`;
  }
  
  if (!hasDueTasks) return; // Hech narsa due emas - eslatma yubormaslik
  
  let msg = '';
  if (hour === 8) {
    msg = `🌅 Xayrli tong!\n\n📋 Bugungi vazifalar:\n\n${taskList}`;
  } else if (hour === 12) {
    msg = `🕛 Tushlik vaqti!\n\n📋 Vazifalar:\n\n${taskList}`;
  } else if (hour === 20) {
    msg = `🌆 Kechqurun bo'ldi!\n\n📋 Vazifalar:\n\n${taskList}⚠️ Uxlashdan oldin tugatish kerak!`;
  } else if (hour === 23) {
    msg = `🚨 OXIRGI ESLATMA!\n\n📋 Vazifalar:\n\n${taskList}😤 /done qilmasangiz JARIMA!`;
  }
  
  data.groupChatIds.forEach(chatId => {
    bot.telegram.sendMessage(chatId, msg).catch(err => console.error(err.message));
  });
}

function checkPenalties() {
  const data = loadData();
  if (data.roommates.length === 0) return;
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const penalties = [];
  
  for (const [key, task] of Object.entries(data.tasks)) {
    if (task.isPenalty || !task.lastDone) continue;
    
    const lastDone = new Date(task.lastDone);
    const lastDay = new Date(lastDone.getFullYear(), lastDone.getMonth(), lastDone.getDate());
    const days = Math.floor((today - lastDay) / (1000 * 60 * 60 * 24));
    
    if (days >= task.intervalDays) {
      task.isPenalty = true;
      const person = getTaskPerson(key, data);
      if (person) penalties.push({ task, person });
    }
  }
  
  if (penalties.length > 0) {
    saveData(data);
    
    let msg = '⚠️ JARIMA!\n\n';
    penalties.forEach(p => {
      msg += `🔴 ${p.task.name}\n   👤 ${p.person.name} (@${p.person.username})\n\n`;
    });
    msg += 'Bugun + keyingi navbat ham sizniki!';
    
    data.groupChatIds?.forEach(chatId => {
      bot.telegram.sendMessage(chatId, msg).catch(err => console.error(err.message));
    });
  }
}

cron.schedule('0 8 * * *', () => sendReminder(8), { timezone: TIMEZONE });
cron.schedule('0 12 * * *', () => sendReminder(12), { timezone: TIMEZONE });
cron.schedule('0 20 * * *', () => sendReminder(20), { timezone: TIMEZONE });
cron.schedule('0 23 * * *', () => sendReminder(23), { timezone: TIMEZONE });
cron.schedule('1 0 * * *', () => checkPenalties(), { timezone: TIMEZONE });

bot.catch((err) => console.error('Bot error:', err.message));

bot.launch().then(() => {
  console.log('🤖 Bot ishga tushdi!');
  console.log('⏰ Eslatmalar: 08:00, 12:00, 20:00, 23:00');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
