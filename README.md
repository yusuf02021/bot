# 🏠 Cleaning Duty Rotation Bot

Telegram bot to manage apartment cleaning duty rotation for roommates.

## Features

- 🔄 Automatic rotation when duty is completed
- 📋 Track current duty and tasks
- 💾 Persistent state with `data.json`
- 👥 Multi-roommate support
- 🔐 Admin commands for manual control

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the instructions
3. Copy the bot token

### 2. Install Dependencies

```bash
cd cleaning-duty-bot
npm install
```

### 3. Configure the Bot

Edit `data.json` to add your roommates:

```json
{
  "roommates": [
    { "id": 1, "name": "Ali", "username": "ali_real_username" },
    { "id": 2, "name": "Bobur", "username": "bobur_real_username" }
  ],
  "adminUsernames": ["your_admin_username"]
}
```

### 4. Set Bot Token

```bash
export BOT_TOKEN="your_bot_token_here"
```

Or edit `index.js` directly (not recommended for production).

### 5. Run the Bot

```bash
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/status` | See current duty person and tasks |
| `/list` | List all roommates |
| `/next` | See who's next in rotation |
| `/skip` | Skip to next person (admin only) |
| `/setduty [n]` | Set specific person on duty (admin only) |

## Trigger Phrases

When the person on duty finishes their tasks, they send one of these:
- `#done`
- `bajarildi`
- `tayyor`

The bot will acknowledge and rotate to the next person.

## Data Structure

```json
{
  "roommates": [...],
  "currentDutyIndex": 0,
  "lastRotation": "2024-01-15T10:30:00.000Z",
  "dutyDuration": 2,
  "adminUsernames": ["admin_username"],
  "tasks": ["Task 1", "Task 2", "Task 3"],
  "triggerPhrases": ["#done", "bajarildi", "tayyor"]
}
```

## Adding to a Group

1. Add your bot to the Telegram group
2. Make it an admin (optional, but recommended)
3. Everyone can use `/status`, `/list`, `/next`
4. Only admins can use `/skip`, `/setduty`
