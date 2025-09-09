import { VK } from "vk-io";
import fs from "fs/promises";
import express from "express";
import fetch from "node-fetch";

// === Константы ===
const TASKS_FILE = "./tasks.json";
const TIMEZONE_OFFSET = 3; // Москва UTC+3
const PORT = process.env.PORT || 3000;

// === Express keep-alive ===
const app = express();

// /ping (для self-ping)
app.get("/ping", (req, res) => res.send("pong"));

// / (список задач)
app.get("/", async (req, res) => {
  try {
    const data = await fs.readFile(TASKS_FILE, "utf-8");
    const tasks = JSON.parse(data);

    let html = `
      <html>
        <head>
          <title>Задачи бота</title>
          <meta charset="utf-8">
          <style>
            body { font-family: sans-serif; padding: 20px; background: #f9f9f9; }
            h1 { color: #333; }
            table { border-collapse: collapse; width: 100%; background: #fff; }
            th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
            th { background-color: #f4f4f4; }
            tr:nth-child(even) { background-color: #fdfdfd; }
            tr:hover { background-color: #f1f7ff; }
            .sent { color: green; font-weight: bold; }
            .not-sent { color: red; font-weight: bold; }
          </style>
          <script>
            setTimeout(() => { location.reload(); }, 5000);
          </script>
        </head>
        <body>
          <h1>Список задач бота</h1>
          <table>
            <tr>
              <th>#</th>
              <th>Время (МСК)</th>
              <th>Текст</th>
              <th>Повторов</th>
              <th>Отправлено</th>
              <th>Кто создал</th>
            </tr>
    `;

    tasks.forEach((task, index) => {
      const cleanText = task.text.replace(/\[id\d+\|([^\]]+)\]/g, "$1");
      html += `
        <tr>
          <td>${index + 1}</td>
          <td>${task.time}</td>
          <td>${cleanText}</td>
          <td>${task.times}</td>
          <td class="${task.sent ? "sent" : "not-sent"}">${task.sent ? "✅" : "❌"}</td>
          <td>${task.peerId}</td>
        </tr>
      `;
    });

    html += `</table></body></html>`;
    res.send(html);
  } catch (err) {
    res.send("Ошибка загрузки задач: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
});

// self-ping костыль (каждые 4 минуты)
setInterval(
  () => {
    fetch(`http://localhost:${PORT}/ping`)
      .then(() => console.log("🔄 Self-ping OK"))
      .catch((err) => console.error("❌ Self-ping failed:", err.message));
  },
  4 * 60 * 1000,
);

// === Утилиты ===
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
    try {
      await fs.access(TASKS_FILE);
      const backupName = `tasks_backup_${Date.now()}.json`;
      await fs.copyFile(TASKS_FILE, backupName);
      console.log(`💾 Создана резервная копия: ${backupName}`);
    } catch {}
    await saveTasks([]);
    return [];
  }
}

// === Глобальное хранилище задач ===
let tasks = [];
(async () => {
  tasks = await loadTasks();
  console.log(`✅ Загружено задач: ${tasks.length}`);
})();

// === VK API ===
const vk = new VK({
  token:
    "vk1.a.F3Zjpr-ACP9y4IGgB718zAUCTQUci4jeRkw04gctIKdOSD_406C7BJh7w1qzKGT6junxgDnni3yg2prsgXr_ANuVnWwOwNikTg3fEyRLYnFt-85i62uEw8mWxLLOfQpyOH3x5hmW8imKVIeWl1cJWOGW7LmlsJoSXQRJuMKLUsh8kQObgJc1asHNhrtscv7w3s53UzCk0PWr19jz2j42yQ",
  apiVersion: "5.199",
});

const { updates } = vk;

// === Отправка сообщений ===
async function sendMessage(peerId, text) {
  try {
    await vk.api.messages.send({
      peer_id: peerId,
      message: text,
      random_id: Math.floor(Math.random() * 1e9),
    });
    return true;
  } catch (err) {
    console.error(`❌ Ошибка отправки peer_id=${peerId}:`, err.message);
    return false;
  }
}

// === Планировщик задач ===
setInterval(async () => {
  const currentTime = formatTime();
  let changed = false;

  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];

    if (!validateTimeString(task.time)) {
      console.error("⚠️ Задача имеет неверное время:", task);
      tasks.splice(i, 1);
      changed = true;
      continue;
    }

    if (task.time === currentTime && !task.sent) {
      console.log(
        `📨 Отправка задачи "${task.text}" → ${task.peerId} (${task.times} раз)`,
      );

      for (let j = 0; j < task.times; j++) {
        await sendMessage(task.peerId, task.text);
        console.log(`✅ Отправлено ${j + 1}/${task.times}`);
      }

      task.sent = true;
      tasks.splice(i, 1); // удаляем задачу после всех отправок
      changed = true;
    }
  }

  if (changed) await saveTasks(tasks);
}, 5 * 1000);

// === Команды ===
updates.on("message_new", async (context) => {
  if (!context.isUser && !context.isChat) return;

  const peerId = context.peerId;
  const text = context.text?.trim();
  if (!text) return;

  // === !bind с проверкой админки ===
  if (text.startsWith("!bind")) {
    if (context.isChat) {
      const members = await vk.api.messages.getConversationMembers({
        peer_id: peerId,
      });
      const member = members.items.find(
        (m) => m.member_id === context.senderId,
      );
      if (!member?.is_admin) {
        return context.send(
          "❌ Только администраторы чата могут использовать !bind",
        );
      }
    }

    const parts = text.split(" ");
    if (parts.length < 3)
      return context.send(
        "❌ Использование: !bind HH:MM текст [кол-во повторов]",
      );

    let time = parts[1];
    if (!validateTimeString(time))
      return context.send("❌ Неверный формат времени");

    let repeatCount = 1;
    let msgText = "";
    if (!isNaN(parts[parts.length - 1])) {
      repeatCount = parseInt(parts[parts.length - 1], 10);
      msgText = parts.slice(2, -1).join(" ");
    } else {
      msgText = parts.slice(2).join(" ");
    }

    if (!msgText) return context.send("❌ Текст задачи не может быть пустым");
    if (repeatCount < 1)
      return context.send("❌ Количество повторов должно быть > 0");

    const newTask = createTask(peerId, time, msgText, repeatCount);
    tasks.push(newTask);
    await saveTasks(tasks);

    return context.send(
      `✅ Задача добавлена:\n🕒 ${time}\n💬 "${msgText}"\n🔁 ${repeatCount} раз`,
    );
  }

  // === !tasks ===
  if (text === "!tasks") {
    if (tasks.length === 0) return context.send("📭 Нет активных задач");
    let list = "📋 Активные задачи:\n";
    tasks.forEach((t, i) => {
      list += `${i + 1}. [${t.time}] "${t.text}" ×${t.times}\n`;
    });
    return context.send(list);
  }

  // === !deltask ===
  if (text.startsWith("!deltask")) {
    const parts = text.split(" ");
    if (parts.length !== 2)
      return context.send("❌ Использование: !deltask номер");
    const idx = parseInt(parts[1], 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= tasks.length)
      return context.send("❌ Неверный номер задачи");
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
