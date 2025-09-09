import express from 'express';
import fs from 'fs/promises';
import fetch from 'node-fetch';

// Функция для очистки текста от невидимых/битых символов
function cleanText(str) {
  return String(str || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width и BOM
    .trim();
}

// Функция для очистки чисел: оставляем только цифры 0-9
function cleanNumber(str) {
  return String(str || '')
    .replace(/[^\d]/g, '') // оставляем только цифры
    .replace(/^0+/, '')    // убираем ведущие нули
    || '0';
}

export function keepAlive() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // --- эндпоинт для пинга ---
  app.get('/ping', (req, res) => {
    res.send('pong');
  });

  // --- главная страница со списком задач ---
  app.get('/', async (req, res) => {
    try {
      const data = await fs.readFile('./tasks.json', 'utf-8');
      let tasks = JSON.parse(data);

      // Приведение данных к корректному виду с полной очисткой
      tasks = tasks.map(task => ({
        time: cleanText(task.time),
        text: cleanText(task.text.replace(/\[id\d+\|([^\]]+)\]/g, '$1')),
        times: cleanNumber(task.times),
        peerId: cleanNumber(task.peerId),
        sent: Boolean(task.sent)
      }));

      // Формируем HTML
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
        html += `
          <tr>
            <td>${index + 1}</td>
            <td>${task.time}</td>
            <td>${task.text}</td>
            <td>${task.times}</td>
            <td class="${task.sent ? 'sent' : 'not-sent'}">${task.sent ? '✅' : '❌'}</td>
            <td>${task.peerId}</td>
          </tr>
        `;
      });

      html += `
            </table>
          </body>
        </html>
      `;

      res.send(html);
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка загрузки задач: ' + err.message);
    }
  });

  app.listen(PORT, () => {
    console.log(`✅ Keep-alive server running on port ${PORT}`);
  });

  // --- костыль: self-ping каждые 4 минуты ---
  setInterval(() => {
    fetch(`http://localhost:${PORT}/ping`)
      .then(() => console.log('🔄 Self-ping OK'))
      .catch(err => console.error('❌ Self-ping failed:', err.message));
  }, 4 * 60 * 1000);
}
