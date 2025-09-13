// index.js
// ============================================================================
// VK bot с расширенной логикой: миграции, роли, баны/кики, задачи, статистика.
// ============================================================================
//
// Требования: node >= 18, пакеты:
//   npm i vk-io pg dotenv node-fetch fs
//
// ENV:
//   DATABASE_URL - строка подключения к Postgres
//   VK_TOKEN     - токен сообщества VK
//
// Сохраните как index.js и запускайте.
//
// ============================================================================

// === Импорты и инициализация ===
import { VK } from "vk-io";
import fs from "fs/promises";
import express from "express";
import fetch from "node-fetch";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

// === Константы конфигурации ===
const TASKS_FILE = "./tasks.json";
const LOG_FILE = "./logs.txt";
const TIMEZONE_OFFSET = 3; // UTC+3
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL;
const VK_TOKEN = process.env.VK_TOKEN;

// Простейшая валидация env
if (!DB_URL) {
  console.error("❌ Ошибка: не задана переменная окружения DATABASE_URL");
  process.exit(1);
}
if (!VK_TOKEN) {
  console.error("❌ Ошибка: не задана переменная окружения VK_TOKEN");
  process.exit(1);
}

// === Подключение к PostgreSQL ===
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
});

// === VK API setup ===
const vk = new VK({
  token: VK_TOKEN,
  apiVersion: "5.199",
});
const { updates } = vk;

// === Express keep-alive (для платформ типа Railway/Heroku) ===
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

// ============================================================================
// УТИЛИТЫ ВРЕМЕНИ, ФАЙЛОВ, ЛОГА
// ============================================================================
function nowISO() {
  return new Date().toISOString();
}

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

async function appendLog(line) {
  try {
    await fs.appendFile(LOG_FILE, `[${nowISO()}] ${line}\n`);
  } catch (err) {
    console.error("❌ Ошибка записи в лог:", err.message);
  }
}

// ============================================================================
// ФАЙЛ-СОХРАНЕНИЕ ЗАДАЧ
// ============================================================================
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
    console.error("⚠️ Формат tasks.json неверен, сбрасываю.");
    return [];
  } catch (err) {
    console.warn("⚠️ Не удалось загрузить tasks.json, создаю новый:", err.message);
    await saveTasks([]);
    return [];
  }
}

function createTask(peerId, time, text, times) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    peerId,
    time,
    text,
    times,
    sent: false,
    createdAt: nowISO(),
  };
}

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ И МИГРАЦИИ БД
// ============================================================================

/**
 * Выполняем начальную инициализацию таблиц и авто-миграции.
 * Если таблицы не созданы — создаём. Если отсутствуют колонки — добавляем.
 */
async function initDBAndMigrate() {
  try {
    // Создаём таблицу groups (чаты)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        chat_id BIGINT PRIMARY KEY,
        title TEXT,
        members_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Создаём таблицу users, с базовой схемой (chat_id NOT NULL DEFAULT 0).
    // Если она уже существует, этот запрос ничего не сделает.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL DEFAULT 0,
        warns INT DEFAULT 0,
        banned BOOLEAN DEFAULT FALSE,
        global BOOLEAN DEFAULT FALSE,
        role TEXT DEFAULT 'пользователь',
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, chat_id)
      )
    `);

    // Создаём таблицу bans/лог банов и киков
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bans (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL DEFAULT 0,
        action TEXT NOT NULL, -- 'ban' | 'kick'
        reason TEXT,
        actor_id BIGINT, -- кто применил
        created_at TIMESTAMP DEFAULT NOW(),
        global BOOLEAN DEFAULT FALSE
      )
    `);

    // --- МИГРАЦИИ: добавляем колонки, которые могли отсутствовать в старой схеме ---
    // add column IF NOT EXISTS — Postgres поддерживает IF NOT EXISTS для ADD COLUMN
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'пользователь'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS global BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS warns INT DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);

    // Убедимся, что нет NULL в chat_id (перенос старых данных)
    await pool.query(`UPDATE users SET chat_id = 0 WHERE chat_id IS NULL`);

    console.log("✅ Инициализация БД и миграции выполнены");
  } catch (err) {
    console.error("❌ Ошибка инициализации/миграции БД:", err);
    process.exit(1);
  }
}

// ============================================================================
// УТИЛИТЫ РАБОТЫ С DB: USERS / GROUPS / BANS
// ============================================================================

/**
 * Преобразует peerId VK в локальный chatId (для бесед peerId = 2000000000 + chat_id)
 * Для личных сообщений и групповых чатов возвращаем chat_id числом (0 для ЛС),
 * но в схеме мы используем chat_id = 0 как глобальный/личный контекст.
 */
function peerToChatId(peerId) {
  if (typeof peerId !== "number") return 0;
  // В VK беседы: peer_id = 2000000000 + chat_id
  if (peerId > 2000000000) return peerId - 2000000000;
  // Личные сообщения (профиль) — оставляем 0 (глобальная запись)
  return 0;
}

/**
 * Ensure user exists in users table, если нет — вставляем.
 * Если роль указана и запись не существует, роль будет установлена.
 */
async function ensureUser(userId, chatId = 0, role = "пользователь") {
  try {
    await pool.query(
      `INSERT INTO users (user_id, chat_id, role, global)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, chat_id) DO UPDATE
       SET role = COALESCE(users.role, EXCLUDED.role)`,
      [userId, chatId || 0, role, chatId === 0]
    );
  } catch (err) {
    console.error("❌ ensureUser error:", err.message);
    await appendLog(`ensureUser error: ${err.message}`);
  }
}

/**
 * Добавить варн (локально или глобально)
 */
async function addWarn(userId, chatId = 0, global = false) {
  const keyChat = global ? 0 : chatId || 0;
  try {
    await pool.query(
      `INSERT INTO users (user_id, chat_id, warns, global)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, chat_id)
       DO UPDATE SET warns = users.warns + 1`,
      [userId, keyChat, global]
    );
  } catch (err) {
    console.error("❌ addWarn error:", err.message);
    await appendLog(`addWarn error: ${err.message}`);
  }
}

/**
 * Бан/разбан и лог банов
 */
async function banUser(userId, chatId = 0, actorId = null, reason = null, global = false) {
  const keyChat = global ? 0 : chatId || 0;
  try {
    // Update users record
    await pool.query(
      `INSERT INTO users (user_id, chat_id, banned, global)
       VALUES ($1, $2, TRUE, $3)
       ON CONFLICT (user_id, chat_id)
       DO UPDATE SET banned = TRUE, global = $3`,
      [userId, keyChat, global]
    );

    // Add to bans log
    await pool.query(
      `INSERT INTO bans (user_id, chat_id, action, reason, actor_id, global)
       VALUES ($1, $2, 'ban', $3, $4, $5)`,
      [userId, keyChat, reason, actorId, global]
    );
  } catch (err) {
    console.error("❌ banUser error:", err.message);
    await appendLog(`banUser error: ${err.message}`);
  }
}

async function unbanUser(userId, chatId = 0, actorId = null, global = false) {
  const keyChat = global ? 0 : chatId || 0;
  try {
    await pool.query(`UPDATE users SET banned = FALSE WHERE user_id=$1 AND chat_id=$2`, [userId, keyChat]);
    // записываем в лог разбана
    await pool.query(
      `INSERT INTO bans (user_id, chat_id, action, reason, actor_id, global)
       VALUES ($1, $2, 'unban', $3, $4, $5)`,
      [userId, keyChat, null, actorId, global]
    );
  } catch (err) {
    console.error("❌ unbanUser error:", err.message);
    await appendLog(`unbanUser error: ${err.message}`);
  }
}

/**
 * Кик: только логируем в таблицу bans и пытаемся удалить из чата через VK API.
 * Глобальные кики записываем с chat_id = 0.
 */
async function kickUser(userId, chatId = 0, actorId = null, reason = null, global = false) {
  const keyChat = global ? 0 : chatId || 0;
  try {
    await pool.query(
      `INSERT INTO bans (user_id, chat_id, action, reason, actor_id, global)
       VALUES ($1, $2, 'kick', $3, $4, $5)`,
      [userId, keyChat, reason, actorId, global]
    );
  } catch (err) {
    console.error("❌ kickUser error:", err.message);
    await appendLog(`kickUser error: ${err.message}`);
  }

  // Попытка реального удаления из беседы, если ключ chatId ненулевой
  if (!global && chatId && chatId > 0) {
    try {
      // Для VK API запрос требует chat_id (локальный ID) — у нас chatId уже локальный
      await vk.api.messages.removeChatUser({ chat_id: chatId, member_id: userId });
      console.log(`✅ Удалил пользователя ${userId} из чата ${chatId} через VK API`);
    } catch (err) {
      console.warn(`⚠️ Не удалось удалить пользователя ${userId} из чата ${chatId}:`, err.message);
      await appendLog(`VK removeChatUser failed: ${err.message}`);
    }
  }
}

/**
 * Получить статистику:
 *  - если передан chatId — статистика чата
 *  - если передан userId (и, опционально, chatId) — статистика пользователя
 */
async function getChatStats(chatId) {
  try {
    const membersRes = await pool.query(`SELECT COUNT(*) FROM users WHERE chat_id=$1`, [chatId]);
    const bannedRes = await pool.query(`SELECT COUNT(*) FROM users WHERE chat_id=$1 AND banned=TRUE`, [chatId]);
    const warnsRes = await pool.query(`SELECT SUM(warns) FROM users WHERE chat_id=$1`, [chatId]);

    return {
      members: parseInt(membersRes.rows[0].count, 10) || 0,
      banned: parseInt(bannedRes.rows[0].count, 10) || 0,
      warns: parseInt(warnsRes.rows[0].sum, 10) || 0,
    };
  } catch (err) {
    console.error("❌ getChatStats error:", err.message);
    return { members: 0, banned: 0, warns: 0 };
  }
}

async function getUserStats(userId, chatId = null) {
  try {
    const keyChat = chatId || 0;
    const res = await pool.query(`SELECT * FROM users WHERE user_id=$1 AND chat_id=$2`, [userId, keyChat]);
    return res.rows[0] || null;
  } catch (err) {
    console.error("❌ getUserStats error:", err.message);
    return null;
  }
}

/**
 * Проверка, является ли пользователь админом в чате (role = 'админ')
 */
async function isAdmin(userId, chatId = 0) {
  try {
    const res = await pool.query(`SELECT role FROM users WHERE user_id=$1 AND chat_id=$2`, [userId, chatId]);
    if (res.rowCount === 0) return false;
    const role = res.rows[0].role;
    return role === "админ";
  } catch (err) {
    console.error("❌ isAdmin error:", err.message);
    return false;
  }
}

/**
 * Добавление/обновление группы в БД
 */
async function saveGroup(chatId, title = null, membersCount = 0) {
  try {
    await pool.query(
      `INSERT INTO groups (chat_id, title, members_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE
       SET title = EXCLUDED.title, members_count = EXCLUDED.members_count`,
      [chatId, title, membersCount]
    );
  } catch (err) {
    console.error("❌ saveGroup error:", err.message);
    await appendLog(`saveGroup error: ${err.message}`);
  }
}

// ============================================================================
// ПЛАНИРОВЩИК ЗАДАЧ (tasks.json)
// ============================================================================
let tasks = [];
(async () => {
  tasks = await loadTasks();
  console.log(`✅ Загружено задач: ${tasks.length}`);
})();

// Периодически проверяем задачи каждую минуту (или чаще)
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
    if (!task.sent && task.time === currentTime) {
      for (let r = 0; r < (task.times || 1); r++) {
        try {
          await vk.api.messages.send({
            peer_id: task.peerId,
            message: task.text,
            random_id: Math.floor(Math.random() * 1e9),
          });
        } catch (err) {
          console.error("❌ Ошибка отправки задачи:", err.message);
        }
      }
      task.sent = true;
      // удаляем отправленную задачу
      tasks.splice(i, 1);
      changed = true;
    }
  }
  if (changed) await saveTasks(tasks);
}, 30 * 1000);

// ============================================================================
// САПЁР (UI кнопки) — пример, необязательно менять
// ============================================================================
let saperGames = {};

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

// ============================================================================
// ОБРАБОТКА ВХОДЯЩИХ СООБЩЕНИЙ
// ============================================================================
updates.on("message_new", async (context) => {
  try {
    // Игнорируем системные события
    if (!context.isUser && !context.isChat) return;

    const peerId = context.peerId;
    const senderId = context.senderId;
    const text = (context.text || "").trim();

    // Логируем сообщение
    await appendLog(`${senderId} -> ${peerId}: ${text}`);

    // Приводим peerId к chatId (локальный ID беседы)
    const localChatId = peerToChatId(peerId); // 0 или >0

    // Убедимся, что пользователь в таблице есть
    await ensureUser(senderId, localChatId, "пользователь");

    // Если это команда /начать — сохраняем группу в БД и даём роль админа тому, кто вызвал
    if (text === "/начать" || text.toLowerCase() === "начать") {
      // Попытка получить данные беседы через VK API (когда доступно)
      let title = null;
      let membersCount = 0;
      try {
        const conv = await vk.api.messages.getConversationsById({ peer_ids: peerId });
        if (conv && conv.count > 0 && conv.items && conv.items[0].chat_settings) {
          title = conv.items[0].chat_settings.title || null;
        }
        const members = await vk.api.messages.getConversationMembers({ peer_id: peerId });
        membersCount = members?.count || 0;
      } catch (e) {
        // не критично — логируем и продолжаем
        console.warn("⚠️ Не удалось получить данные беседы через VK API:", e.message);
        await appendLog(`getConversationsById error: ${e.message}`);
      }

      // Сохраняем в groups
      await saveGroup(localChatId, title, membersCount);

      // Назначаем роль админа пользователю, вызвавшему команду
      try {
        await pool.query(
          `INSERT INTO users (user_id, chat_id, role, global) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, chat_id) DO UPDATE SET role = EXCLUDED.role`,
          [senderId, localChatId, "админ", false]
        );
      } catch (e) {
        console.error("❌ Ошибка назначения роли админа:", e.message);
        await appendLog(`set admin error: ${e.message}`);
      }

      await context.send("✅ Группа сохранена в БД. Вы назначены администратором.");
      return;
    }

    // === HELP ===
    if (text === "!help") {
      const helpText = [
        "📚 Список команд:",
        "/начать — сохранить чат в базе и назначить себя админом",
        "!help — показать это сообщение",
        "!bind HH:MM текст [кол-во повторов] — добавить задачу (только для админов)",
        "!tasks — показать задачи",
        "!deltask N — удалить задачу (только для админов)",
        "!warn <id> [причина] — варн (локально)",
        "!ban <id> [причина] — бан (локально, только админ)",
        "!kick <id> [причина] — кик (локально, только админ)",
        "!awarn <id> — глобальный варн",
        "!aban <id> [причина] — глобальный бан (только админ)",
        "!akick <id> [причина] — глобальный кик (только админ)",
        "!stats — статистика чата (в чате) или пользователя (в ЛС)",
        "!setrole <id> <админ|пользователь> — назначить роль (только админ)",
        "!saper — мини-игра сапёр",
        "!saper_reset — сброс игры",
      ].join("\n");
      await context.send(helpText);
      return;
    }

    // === Обработка payload (кнопки сапёра) ===
    let payloadStr = null;
    if (context.payload) {
      if (typeof context.payload === "string") {
        payloadStr = context.payload;
      } else if (typeof context.payload === "object" && context.payload.payload) {
        try {
          const p = JSON.parse(context.payload.payload);
          payloadStr = p.type;
        } catch (e) {
          // ignore
        }
      }
    }
    if (payloadStr?.startsWith("saper_")) {
      const parts = payloadStr.split("_");
      const x = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);
      const board = saperGames[senderId];
      if (!board) {
        await context.send("❌ Игра не найдена. Напишите !saper");
        return;
      }
      if (board[x][y] === "💣") {
        delete saperGames[senderId];
        await context.send("💥 Бах! Вы проиграли!");
        return;
      }
      board[x][y] = "✅";
      await context.send("🟩 Открыто!", renderSaperButtons(board));
      return;
    }

    // === Сапёр: старт и сброс ===
    if (text === "!saper") {
      const board = Array.from({ length: 5 }, () =>
        Array.from({ length: 5 }, () => (Math.random() < 0.2 ? "💣" : "⬜"))
      );
      saperGames[senderId] = board;
      await context.send("💣 Игра «сапёр»! Нажимайте кнопки:", renderSaperButtons(board));
      return;
    }
    if (text === "!saper_reset") {
      delete saperGames[senderId];
      await context.send("🔄 Игра сброшена. Напишите !saper чтобы начать снова.");
      return;
    }

    // === Команда setrole: только админ может назначать роль ===
    if (text.startsWith("!setrole")) {
      const parts = text.split(/\s+/);
      if (parts.length !== 3) {
        await context.send("❌ Использование: !setrole <id> <админ|пользователь>");
        return;
      }
      const targetId = parseInt(parts[1], 10);
      const role = parts[2].toLowerCase();
      if (!["админ", "пользователь"].includes(role)) {
        await context.send("❌ Роль должна быть 'админ' или 'пользователь'");
        return;
      }
      const allowed = await isAdmin(senderId, localChatId);
      if (!allowed) {
        await context.send("⛔ Только администратор может менять роли");
        return;
      }
      try {
        await pool.query(
          `INSERT INTO users (user_id, chat_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, chat_id) DO UPDATE SET role = EXCLUDED.role`,
          [targetId, localChatId, role]
        );
        await context.send(`✅ Пользователю ${targetId} назначена роль ${role}`);
      } catch (e) {
        console.error("❌ setrole error:", e.message);
        await context.send("❌ Ошибка при назначении роли");
      }
      return;
    }

    // === WARN / BAN / KICK локальные ===
    // !warn <id> [reason]
    if (text.startsWith("!warn")) {
      const parts = text.split(/\s+/);
      const uid = parseInt(parts[1], 10) || senderId;
      const reason = parts.slice(2).join(" ") || null;
      await addWarn(uid, localChatId, false);
      await context.send(`⚠️ Пользователь ${uid} получил локальный варн${reason ? `: ${reason}` : ""}`);
      return;
    }

    // !ban <id> [reason]
    if (text.startsWith("!ban")) {
      const parts = text.split(/\s+/);
      const uid = parseInt(parts[1], 10) || senderId;
      const reason = parts.slice(2).join(" ") || null;
      const allowed = await isAdmin(senderId, localChatId);
      if (!allowed) {
        await context.send("⛔ Только админ может банить");
        return;
      }
      await banUser(uid, localChatId, senderId, reason, false);

      // Попытка реального удаления из беседы
      if (localChatId > 0) {
        try {
          await vk.api.messages.removeChatUser({ chat_id: localChatId, member_id: uid });
        } catch (e) {
          console.warn("⚠️ removeChatUser failed:", e.message);
          await appendLog(`removeChatUser failed: ${e.message}`);
        }
      }

      await context.send(`⛔ Пользователь ${uid} локально забанен${reason ? `: ${reason}` : ""}`);
      return;
    }

    // !kick <id> [reason]
    if (text.startsWith("!kick")) {
      const parts = text.split(/\s+/);
      const uid = parseInt(parts[1], 10) || senderId;
      const reason = parts.slice(2).join(" ") || null;
      const allowed = await isAdmin(senderId, localChatId);
      if (!allowed) {
        await context.send("⛔ Только админ может кикать");
        return;
      }
      await kickUser(uid, localChatId, senderId, reason, false);
      await context.send(`👢 Пользователь ${uid} кикнут${reason ? `: ${reason}` : ""}`);
      return;
    }

    // === Глобальные команды: awarn, aban, akick ===
    if (text.startsWith("!awarn")) {
      const parts = text.split(/\s+/);
      const uid = parseInt(parts[1], 10) || senderId;
      await addWarn(uid, 0, true);
      await context.send(`⚠️ Пользователь ${uid} получил глобальный варн`);
      return;
    }

    if (text.startsWith("!aban")) {
      const parts = text.split(/\s+/);
      const uid = parseInt(parts[1], 10) || senderId;
      const reason = parts.slice(2).join(" ") || null;
      const allowed = await isAdmin(senderId, localChatId);
      if (!allowed) {
        await context.send("⛔ Только админ может делать глобальные баны");
        return;
      }
      await banUser(uid, 0, senderId, reason, true);
      await context.send(`⛔ Пользователь ${uid} глобально забанен${reason ? `: ${reason}` : ""}`);
      return;
    }

    if (text.startsWith("!akick")) {
      const parts = text.split(/\s+/);
      const uid = parseInt(parts[1], 10) || senderId;
      const reason = parts.slice(2).join(" ") || null;
      const allowed = await isAdmin(senderId, localChatId);
      if (!allowed) {
        await context.send("⛔ Только админ может делать глобальные кики");
        return;
      }
      await kickUser(uid, 0, senderId, reason, true);
      await context.send(`👢 Пользователь ${uid} глобально кикнут${reason ? `: ${reason}` : ""}`);
      return;
    }

    // === СТАТИСТИКА ===
    if (text === "!stats") {
      if (context.isChat) {
        // В чате — статистика чата
        const stats = await getChatStats(localChatId);
        await context.send(
          `📊 Статистика чата:\n👥 Участников: ${stats.members}\n⛔ Забанено: ${stats.banned}\n⚠️ Всего варнов: ${stats.warns}`
        );
      } else {
        // В личке — статистика пользователя
        const userRec = await getUserStats(senderId, 0);
        if (!userRec) {
          await context.send("📭 Информации о вас нет в базе");
        } else {
          await context.send(
            `📊 Ваша статистика:\n👤 ID: ${userRec.user_id}\n⚠️ Варны: ${userRec.warns}\n⛔ Бан: ${userRec.banned ? "Да" : "Нет"}\nРоль: ${userRec.role}`
          );
        }
      }
      return;
    }

    // === ЗАДАЧИ: !bind / !tasks / !deltask ===
    if (text.startsWith("!bind")) {
      const user = await getUserStats(senderId, localChatId);
      if (!user || user.role !== "админ") {
        await context.send("⛔ Только модераторы (админы) могут добавлять задачи");
        return;
      }
      const parts = text.split(" ");
      if (parts.length < 3) {
        await context.send("❌ Использование: !bind HH:MM текст [кол-во повторов]");
        return;
      }
      const time = parts[1];
      if (!validateTimeString(time)) {
        await context.send("❌ Неверный формат времени (HH:MM)");
        return;
      }
      let repeatCount = 1;
      let msgText = "";
      if (!isNaN(parts[parts.length - 1])) {
        repeatCount = parseInt(parts[parts.length - 1], 10);
        msgText = parts.slice(2, -1).join(" ");
      } else {
        msgText = parts.slice(2).join(" ");
      }
      if (!msgText) {
        await context.send("❌ Текст задачи не может быть пустым");
        return;
      }
      if (repeatCount < 1) {
        await context.send("❌ Кол-во повторов должно быть >= 1");
        return;
      }
      const newTask = createTask(peerId, time, msgText, repeatCount);
      tasks.push(newTask);
      await saveTasks(tasks);
      await context.send(`✅ Задача добавлена: [${time}] "${msgText}" ×${repeatCount}`);
      return;
    }

    if (text === "!tasks") {
      if (!tasks.length) {
        await context.send("📭 Нет активных задач");
        return;
      }
      let out = "📋 Активные задачи:\n";
      tasks.forEach((t, i) => {
        out += `${i + 1}. [${t.time}] "${t.text}" ×${t.times}\n`;
      });
      await context.send(out);
      return;
    }

    if (text.startsWith("!deltask")) {
      const user = await getUserStats(senderId, localChatId);
      if (!user || user.role !== "админ") {
        await context.send("⛔ Только модераторы (админы) могут удалять задачи");
        return;
      }
      const parts = text.split(" ");
      if (parts.length !== 2) {
        await context.send("❌ Использование: !deltask <номер>");
        return;
      }
      const idx = parseInt(parts[1], 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
        await context.send("❌ Неверный номер задачи");
        return;
      }
      const removed = tasks.splice(idx, 1)[0];
      await saveTasks(tasks);
      await context.send(`🗑 Удалена задача: "${removed.text}"`);
      return;
    }

    // --- Всё остальное: игнорируем или расширяем ---
    // Можно добавить сюда обработку любых других команд
  } catch (err) {
    console.error("❌ Ошибка в updates.on(message_new):", err);
    await appendLog(`message handler error: ${err.message}`);
  }
});

// ============================================================================
// ЗАПУСК: инициализируем БД и запускаем longpoll
// ============================================================================
(async () => {
  try {
    console.log("🚀 Запуск бота — инициализация БД...");
    await initDBAndMigrate();
    console.log("🚀 Запуск VK Updates...");
    await updates.start();
    console.log("✅ Бот успешно запущен и слушает события");
  } catch (err) {
    console.error("❌ Фатальная ошибка при запуске:", err);
    process.exit(1);
  }
})();

// ============================================================================
// Конец файла
// ============================================================================
