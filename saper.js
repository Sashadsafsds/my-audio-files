// saper.js
const saperGames = {}; // глобальный объект для хранения игр

// Функция для отрисовки клавиатуры сапёра
function renderSaperButtons(board) {
  return {
    one_time: false,
    inline: true,
    buttons: board.map((row, x) =>
      row.map((cell, y) => ({
        action: {
          type: 'text',
          label: cell === '💣' ? '⬜' : cell,
          payload: JSON.stringify({ type: `saper_${x}_${y}` }),
        },
        color: 'secondary',
      }))
    )
  };
}

// Создание новой игры
function startGame(peerId, senderId, size = 5, bombChance = 0.2) {
  const board = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => (Math.random() < bombChance ? '💣' : '⬜'))
  );
  saperGames[senderId] = board;
  return board;
}

// Обработка нажатий
async function handleSaperClick(context, senderId, peerId, payload, vk) {
  try {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (data.type && data.type.startsWith('saper_')) {
      const [ , xStr, yStr ] = data.type.split('_');
      const x = Number(xStr);
      const y = Number(yStr);

      const board = saperGames[senderId];
      if (!board) {
        await vk.api.messages.send({
          peer_id: peerId,
          message: 'Игра не запущена. Введите "!сапер" для запуска.',
          random_id: Math.floor(Math.random() * 1e9),
        });
        return;
      }

      if (board[x][y] === '💣') {
        await vk.api.messages.send({
          peer_id: peerId,
          message: '💥 Бомба! Игра окончена.',
          random_id: Math.floor(Math.random() * 1e9),
        });
        delete saperGames[senderId];
        return;
      }

      // Открытие клетки
      const countBombsAround = (i, j) => {
        let count = 0;
        for (let a = i - 1; a <= i + 1; a++) {
          for (let b = j - 1; b <= j + 1; b++) {
            if (a >= 0 && a < board.length && b >= 0 && b < board[0].length) {
              if (board[a][b] === '💣') count++;
            }
          }
        }
        return count;
      };

      const bombsAround = countBombsAround(x, y);
      board[x][y] = bombsAround === 0 ? '⬜' : bombsAround.toString();

      // Проверка победы
      let won = true;
      for (const row of board) {
        for (const cell of row) {
          if (cell === '⬜') continue;
          if (cell === '💣') continue;
          if (!'012345678'.includes(cell)) {
            won = false;
            break;
          }
        }
        if (!won) break;
      }

      if (won) {
        await vk.api.messages.send({
          peer_id: peerId,
          message: '🎉 Поздравляем! Вы выиграли!',
          random_id: Math.floor(Math.random() * 1e9),
        });
        delete saperGames[senderId];
        return;
      }

      // Обновляем клавиатуру
      await vk.api.messages.send({
        peer_id: peerId,
        message: 'Игра продолжается. Нажимайте на клетки:',
        random_id: Math.floor(Math.random() * 1e9),
        keyboard: renderSaperButtons(board),
      });
    }
  } catch (e) {
    console.error('Ошибка обработки payload сапёра:', e);
  }
}

module.exports = {
  saperGames,
  renderSaperButtons,
  startGame,
  handleSaperClick,
};
