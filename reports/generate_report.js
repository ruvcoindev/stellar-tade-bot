const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Ошибка подключения к БД:', err.message);
    return;
  }
  console.log('Подключение к SQLite БД для отчета успешно');
});

// Получение данных из БД
function fetchData(query) {
  return new Promise((resolve, reject) => {
    db.all(query, [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Генерация HTML-отчета с графиками
async function generateReport() {
  try {
    const indicators = await fetchData('SELECT * FROM indicators ORDER BY timestamp ASC');
    const trades = await fetchData('SELECT * FROM trades ORDER BY timestamp ASC');
    const orders = await fetchData('SELECT * FROM orders ORDER BY timestamp ASC');

    // Генерация HTML
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <title>Отчет по торговле</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <h1>Анализ работы торгового бота</h1>
  
  <h2>График индикаторов</h2>
  <canvas id="indicatorsChart" width="800" height="400"></canvas>
  
  <h2>Статистика сделок</h2>
  <table border="1">
    <tr><th>Время</th><th>Цена</th><th>Сумма</th><th>Тип</th><th>Прибыль</th></tr>
    ${trades.map(trade => `
      <tr>
        <td>${trade.timestamp}</td>
        <td>${trade.price}</td>
        <td>${trade.amount}</td>
        <td>${trade.type}</td>
        <td>${trade.profit}</td>
      </tr>
    `).join('')}
  </table>

  <script>
    const ctx = document.getElementById('indicatorsChart').getContext('2d');
    const data = {
      labels: [${indicators.map(ind => `'${ind.timestamp}'`).join(',')}],
      datasets: [
        {
          label: 'MA',
          data: [${indicators.map(ind => ind.ma).join(',')}],
          borderColor: 'blue',
          fill: false
        },
        {
          label: 'RSI',
          data: [${indicators.map(ind => ind.rsi).join(',')}],
          borderColor: 'red',
          fill: false
        },
        {
          label: 'MACD',
          data: [${indicators.map(ind => ind.macd).join(',')}],
          borderColor: 'green',
          fill: false
        },
        {
          label: 'Signal',
          data: [${indicators.map(ind => ind.signal).join(',')}],
          borderColor: 'purple',
          fill: false
        }
      ]
    };

    new Chart(ctx, {
      type: 'line',
      data: data,
      options: {
        responsive: false,
        plugins: {
          title: {
            display: true,
            text: 'Индикаторы технического анализа'
          }
        }
      }
    });
  </script>
</body>
</html>
    `;

    fs.writeFileSync(path.join(__dirname, 'report.html'), htmlContent);
    console.log('Отчет успешно сгенерирован: reports/report.html');
  } catch (error) {
    console.error('Ошибка при генерации отчета:', error.message);
  } finally {
    db.close();
  }
}

generateReport();
