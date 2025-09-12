// === Импорты ===
import { VK } from "vk-io";
import fs from "fs/promises";
import express from "express";
import fetch from "node-fetch";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

// === Константы ===
const TASKS_FILE = "./tasks.json";
const LOG_FILE = "./logs.txt";
const TIMEZONE_OFFSET = 3; // Москва UTC+3
const PORT = process.env.PORT || 3000;

// === Подключение к PostgreSQL ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// === Инициализация БД ===
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT NOT NULL,
      chat_id BIGINT,
      warns INT DEFAULT 0,
      banned BOOLEAN DEFAULT FALSE,
      global BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (user_id, chat_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id BIGINT PRIMARY KEY,
      title TEXT,
      members_count INT DEFAULT 0
    )
  `);

  console.log("✅ Таблицы users и groups инициализированы");
}

// === Express keep-alive ===
const app = express();
app.get("/ping", (req, res) => res.send("pong"));
app.listen(PORT, () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
});
setInterval(() => {
  fetch(`http://localhost:${PORT}/ping`)
    .then(() => console.log("🔄 Self-ping OK"))
    .catch((err) => console.error("❌ Self-ping failed:", err.message));
}, 4 * 60 * 1000);

// === Утилиты времени ===
function formatTime(date = new Date()) {
  const localDate = new Date(date.getTime() + TIMEZONE_OFFSET * 60 * 60 * 1000);
  const hh = localDate.getUTCHours().toString().padStart(2, "0");
  const mm = localDate.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function validateTimeString(time) {
  if (typeof time !== "string") return false;
  const parts = time.split(":");
  if (parts.length !== 2) return false;
  const [h, m] = parts.map((x) => parseInt(x, 10));
  return !isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function createTask(peerId, time, text, times) {
  return {
    peerId,
    time,
    text,
    times,
    sent: false,
    lastSentMinute: null,
    createdAt: new Date().toISOString(),
  };
}

// === Работа с файлами ===
async function saveTasks(tasks) {
  try {
    await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
  } catch (err) {
    console.error("❌ Ошибка сохранения tasks.json:", err.message);
  }
}
async function loadTasks() {
  try {
    const data = await fs.readFile(TASKS_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    console.error("❌ Ошибка формата tasks.json, заменяю на []");
    return [];
  } catch (err) {
    console.error("⚠️ Не удалось загрузить tasks.json:", err.message);
    await saveTasks([]);
    return [];
  }
}

// === Хранилище ===
let tasks = [];
(async () => {
  tasks = await loadTasks();
  console.log(`✅ Загружено задач: ${tasks.length}`);
  await initDB();
})();

let saperGames = {};

// === VK API ===
const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
});
const { updates } = vk;

// === Утилиты для работы с БД пользователей ===
async function addWarn(userId, chatId, global = false) {
  const keyChat = global ? null : chatId;
  await pool.query(
    `INSERT INTO users (user_id, chat_id, warns, global)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (user_id, chat_id)
     DO UPDATE SET warns = users.warns + 1`,
    [userId, keyChat, global]
  );
}

async function banUser(userId, chatId, global = false) {
  const keyChat = global ? null : chatId;
  await pool.query(
    `INSERT INTO users (user_id, chat_id, banned, global)
     VALUES ($1, $2, TRUE, $3)
     ON CONFLICT (user_id, chat_id)
     DO UPDATE SET banned = TRUE`,
    [userId, keyChat, global]
  );
}

async function unbanUser(userId, chatId, global = false) {
  const keyChat = global ? null : chatId;
  await pool.query(
    `UPDATE users SET banned = FALSE WHERE user_id=$1 AND chat_id IS NOT DISTINCT FROM $2`,
    [userId, keyChat]
  );
}

async function getStats() {
  const totalUsers = await pool.query("SELECT COUNT(*) FROM users");
  const totalGroups = await pool.query("SELECT COUNT(*) FROM groups");
  const banned = await pool.query("SELECT COUNT(*) FROM users WHERE banned=TRUE");
  const warns = await pool.query("SELECT SUM(warns) FROM users");
  return {
    users: totalUsers.rows[0].count,
    groups: totalGroups.rows[0].count,
    banned: banned.rows[0].count,
    warns: warns.rows[0].sum || 0,
  };
}

// === Остальной код остаётся без изменений ===

// === Логи сообщений ===
async function sendMessage(peerId, text, keyboard) {
  try {
    await vk.api.messages.send({
      peer_id: peerId,
      message: text,
      random_id: Math.floor(Math.random() * 1e9),
      keyboard: keyboard || undefined,
    });
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${peerId}: ${text}\n`);
    return true;
  } catch (err) {
    console.error(`❌ Ошибка отправки:`, err.message);
    return false;
  }
}

// === Сапёр ===
function renderSaperButtons(board) {
  return JSON.stringify({
    one_time: false,
    inline: true,
    buttons: board.map((row, x) =>
      row.map((cell, y) => ({
        action: {
          type: "text",
          label: cell === "💣" ? "⬜" : cell,
          payload: JSON.stringify({ type: `saper_${x}_${y}` }),
        },
        color: "secondary",
      }))
    ),
  });
}

// === Планировщик задач ===
setInterval(async () => {
  const currentTime = formatTime();
  let changed = false;
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];
    if (!validateTimeString(task.time)) {
      tasks.splice(i, 1);
      changed = true;
      continue;
    }
    if (task.time === currentTime && !task.sent) {
      for (let j = 0; j < task.times; j++) {
        await sendMessage(task.peerId, task.text);
      }
      task.sent = true;
      tasks.splice(i, 1);
      changed = true;
    }
  }
  if (changed) await saveTasks(tasks);
}, 5 * 1000);

// === Обработка сообщений ===
updates.on("message_new", async (context) => {
  if (!context.isUser && !context.isChat) return;
  const peerId = context.peerId;
  const text = context.text?.trim();
  const senderId = context.senderId;
  if (!text) return;
  await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${senderId}: ${text}\n`);

  // === help ===
  if (text === "!help") {
    return context.send(
      `📚 Команды бота:
!bind HH:MM текст [кол-во повторов] - добавить задачу
!tasks - список задач
!deltask номер - удалить задачу
!warn @id - варн (локально)
!ban @id - бан (локально)
!kick @id - кик (локально)
!awarn @id - варн (глобально)
!aban @id - бан (глобально)
!akick @id - кик (глобально)
!stats - статистика
!saper - сапёр
!saper_reset - сброс игры`
    );
  }

  // === Warn/Ban/Kick локальные ===
  if (text.startsWith("!warn")) {
    const uid = parseInt(text.split(" ")[1]) || senderId;
    await addWarn(uid, peerId, false);
    return context.send(`⚠️ Пользователь ${uid} получил локальный варн`);
  }
  if (text.startsWith("!ban")) {
    const uid = parseInt(text.split(" ")[1]) || senderId;
    await banUser(uid, peerId, false);
    return context.send(`⛔ Пользователь ${uid} локально забанен`);
  }
  if (text.startsWith("!kick")) {
    const uid = parseInt(text.split(" ")[1]) || senderId;
    return context.send(`👢 Пользователь ${uid} кикнут из этого чата`);
  }

  // === Warn/Ban/Kick глобальные ===
  if (text.startsWith("!awarn")) {
    const uid = parseInt(text.split(" ")[1]) || senderId;
    await addWarn(uid, null, true);
    return context.send(`⚠️ Пользователь ${uid} получил глобальный варн`);
  }
  if (text.startsWith("!aban")) {
    const uid = parseInt(text.split(" ")[1]) || senderId;
    await banUser(uid, null, true);
    return context.send(`⛔ Пользователь ${uid} глобально забанен`);
  }
  if (text.startsWith("!akick")) {
    const uid = parseInt(text.split(" ")[1]) || senderId;
    return context.send(`👢 Пользователь ${uid} кикнут глобально`);
  }

  // === Статистика ===
  if (text === "!stats") {
    const stats = await getStats();
    return context.send(
      `📊 Статистика:
👥 Пользователей: ${stats.users}
💬 Групп: ${stats.groups}
⛔ Забанено: ${stats.banned}
⚠️ Всего варнов: ${stats.warns}`
    );
  }

  // === Сапёр ===
  if (text === "!saper") {
    const board = Array.from({ length: 5 }, () =>
      Array.from({ length: 5 }, () => (Math.random() < 0.2 ? "💣" : "⬜"))
    );
    saperGames[senderId] = board;
    return context.send("💣 Игра сапёр! Нажимай:", renderSaperButtons(board));
  }
  if (text === "!saper_reset") {
    delete saperGames[senderId];
    return context.send("🔄 Игра сапёр сброшена. Напиши !saper");
  }
  let payloadStr = null;
  if (context.payload) {
    if (typeof context.payload === "string") payloadStr = context.payload;
    else if (typeof context.payload === "object" && context.payload.payload) {
      try {
        payloadStr = JSON.parse(context.payload.payload).type;
      } catch {}
    }
  }
  if (payloadStr?.startsWith("saper_")) {
    const parts = payloadStr.split("_");
    const x = parseInt(parts[1]);
    const y = parseInt(parts[2]);
    const board = saperGames[senderId];
    if (!board) return context.send("❌ Игра не найдена. Напиши !saper");
    if (board[x][y] === "💣") {
      delete saperGames[senderId];
      return context.send("💥 Бум! Вы проиграли!");
    }
    board[x][y] = "✅";
    return context.send("🟩 Открыто!", renderSaperButtons(board));
  }

  // === Задачи ===
  if (text.startsWith("!bind")) {
    const parts = text.split(" ");
    if (parts.length < 3) return context.send("❌ Использование: !bind HH:MM текст [кол-во повторов]");
    let time = parts[1];
    if (!validateTimeString(time)) return context.send("❌ Неверный формат времени");
    let repeatCount = 1;
    let msgText = "";
    if (!isNaN(parts[parts.length - 1])) {
      repeatCount = parseInt(parts[parts.length - 1], 10);
      msgText = parts.slice(2, -1).join(" ");
    } else {
      msgText = parts.slice(2).join(" ");
    }
    if (!msgText) return context.send("❌ Текст задачи не может быть пустым");
    if (repeatCount < 1) return context.send("❌ Количество повторов должно быть > 0");
    const newTask = createTask(peerId, time, msgText, repeatCount);
    tasks.push(newTask);
    await saveTasks(tasks);
    return context.send(`✅ Задача добавлена:\n🕒 ${time}\n💬 "${msgText}"\n🔁 ${repeatCount} раз`);
  }
  if (text === "!tasks") {
    if (tasks.length === 0) return context.send("📭 Нет активных задач");
    let list = "📋 Активные задачи:\n";
    tasks.forEach((t, i) => {
      list += `${i + 1}. [${t.time}] "${t.text}" ×${t.times}\n`;
    });
    return context.send(list);
  }
  if (text.startsWith("!deltask")) {
    const parts = text.split(" ");
    if (parts.length !== 2) return context.send("❌ Использование: !deltask номер");
    const idx = parseInt(parts[1], 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= tasks.length) return context.send("❌ Неверный номер задачи");
    const removed = tasks.splice(idx, 1);
    await saveTasks(tasks);
    return context.send(`🗑 Удалена задача: "${removed[0].text}"`);
  }
});

// === Запуск ===
(async () => {
  console.log("🚀 Бот запущен");
  await updates.start();
})();
