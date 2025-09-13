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
      chat_id BIGINT NOT NULL DEFAULT 0,
      warns INT DEFAULT 0,
      banned BOOLEAN DEFAULT FALSE,
      global BOOLEAN DEFAULT FALSE,
      role TEXT DEFAULT 'пользователь',
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bans (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL DEFAULT 0,
      reason TEXT,
      banned_at TIMESTAMP DEFAULT NOW(),
      global BOOLEAN DEFAULT FALSE
    )
  `);

  console.log("✅ Таблицы инициализированы");
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
async function ensureUser(userId, chatId, role = "пользователь") {
  await pool.query(
    `INSERT INTO users (user_id, chat_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, chat_id) DO NOTHING`,
    [userId, chatId || 0, role]
  );
}

async function addWarn(userId, chatId, global = false) {
  const keyChat = global ? 0 : chatId;
  await pool.query(
    `INSERT INTO users (user_id, chat_id, warns, global)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (user_id, chat_id)
     DO UPDATE SET warns = users.warns + 1`,
    [userId, keyChat, global]
  );
}

async function banUser(userId, chatId, global = false, reason = "") {
  const keyChat = global ? 0 : chatId;
  await pool.query(
    `INSERT INTO users (user_id, chat_id, banned, global)
     VALUES ($1, $2, TRUE, $3)
     ON CONFLICT (user_id, chat_id)
     DO UPDATE SET banned = TRUE`,
    [userId, keyChat, global]
  );
  await pool.query(
    `INSERT INTO bans (user_id, chat_id, reason, global) VALUES ($1, $2, $3, $4)`,
    [userId, keyChat, reason, global]
  );
}

async function unbanUser(userId, chatId, global = false) {
  const keyChat = global ? 0 : chatId;
  await pool.query(
    `UPDATE users SET banned = FALSE WHERE user_id=$1 AND chat_id=$2`,
    [userId, keyChat]
  );
}

async function setRole(userId, chatId, role) {
  await pool.query(
    `UPDATE users SET role=$3 WHERE user_id=$1 AND chat_id=$2`,
    [userId, chatId, role]
  );
}

async function getUser(userId, chatId) {
  const res = await pool.query(
    `SELECT * FROM users WHERE user_id=$1 AND chat_id=$2`,
    [userId, chatId]
  );
  return res.rows[0];
}

async function getStats(chatId = null, userId = null) {
  if (chatId && !userId) {
    const members = await pool.query(
      "SELECT COUNT(*) FROM users WHERE chat_id=$1",
      [chatId]
    );
    const banned = await pool.query(
      "SELECT COUNT(*) FROM users WHERE chat_id=$1 AND banned=TRUE",
      [chatId]
    );
    return {
      members: members.rows[0].count,
      banned: banned.rows[0].count,
    };
  }
  if (userId) {
    const u = await pool.query(
      "SELECT * FROM users WHERE user_id=$1 AND chat_id=$2",
      [userId, chatId || 0]
    );
    return u.rows[0];
  }
  return {};
}

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

// === Обработка сообщений ===
updates.on("message_new", async (context) => {
  if (!context.isUser && !context.isChat) return;
  const peerId = context.peerId;
  const senderId = context.senderId;
  const text = context.text?.trim();
  if (!text) return;

  // Сохраняем пользователя
  await ensureUser(senderId, peerId);

  // /начать
  if (text === "/начать") {
    await pool.query(
      `INSERT INTO groups (chat_id, title, members_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET title=$2, members_count=$3`,
      [peerId, context.chatSettings?.title || "Без названия", context.chatSettings?.membersCount || 0]
    );
    await setRole(senderId, peerId, "админ");
    return context.send("✅ Группа добавлена в базу, вы назначены админом");
  }

  // Роли
  if (text.startsWith("!setrole")) {
    const parts = text.split(" ");
    if (parts.length !== 3) return context.send("Использование: !setrole <id> <админ|пользователь>");
    const targetId = parseInt(parts[1], 10);
    const role = parts[2];
    const user = await getUser(senderId, peerId);
    if (user?.role !== "админ") return context.send("⛔ Нет прав");
    await setRole(targetId, peerId, role);
    return context.send(`✅ Роль пользователя ${targetId} изменена на ${role}`);
  }

  // Warn/Ban/Kick локальные
  if (text.startsWith("!warn")) {
    const uid = parseInt(text.split(" ")[1]) || senderId;
    await addWarn(uid, peerId, false);
    return context.send(`⚠️ Пользователь ${uid} получил локальный варн`);
  }
  if (text.startsWith("!ban")) {
    const parts = text.split(" ");
    const uid = parseInt(parts[1]) || senderId;
    const reason = parts.slice(2).join(" ") || "";
    await banUser(uid, peerId, false, reason);
    try {
      await vk.api.messages.removeChatUser({ chat_id: peerId - 2000000000, member_id: uid });
    } catch (e) {
      console.error("Не удалось кикнуть:", e.message);
    }
    return context.send(`⛔ Пользователь ${uid} забанен. Причина: ${reason || "не указана"}`);
  }
  if (text.startsWith("!kick")) {
    const parts = text.split(" ");
    const uid = parseInt(parts[1]) || senderId;
    const reason = parts.slice(2).join(" ") || "";
    await pool.query(`INSERT INTO bans (user_id, chat_id, reason, global) VALUES ($1, $2, $3, $4)`,
      [uid, peerId, reason, false]);
    try {
      await vk.api.messages.removeChatUser({ chat_id: peerId - 2000000000, member_id: uid });
    } catch (e) {
      console.error("Не удалось кикнуть:", e.message);
    }
    return context.send(`👢 Пользователь ${uid} кикнут. Причина: ${reason || "не указана"}`);
  }

  // Warn/Ban/Kick глобальные
  if (text.startsWith("!aban")) {
    const parts = text.split(" ");
    const uid = parseInt(parts[1]) || senderId;
    const reason = parts.slice(2).join(" ") || "";
    await banUser(uid, 0, true, reason);
    return context.send(`⛔ Пользователь ${uid} глобально забанен. Причина: ${reason || "не указана"}`);
  }

  // Статистика
  if (text === "!stats") {
    if (context.isChat) {
      const s = await getStats(peerId);
      return context.send(`📊 Статистика чата:\n👥 Участников: ${s.members}\n⛔ Забанено: ${s.banned}`);
    } else {
      const u = await getStats(null, senderId);
      return context.send(`📊 Ваша статистика:\n👤 ID: ${u.user_id}\n⚠️ Варны: ${u.warns}\n⛔ Бан: ${u.banned ? "Да" : "Нет"}\nРоль: ${u.role}`);
    }
  }

  // !bind только для админов
  if (text.startsWith("!bind")) {
    const user = await getUser(senderId, peerId);
    if (user?.role !== "админ") return context.send("⛔ Нет прав");
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
});

// === Запуск ===
(async () => {
  console.log("🚀 Бот запущен");
  await updates.start();
})();
