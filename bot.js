require('dotenv').config();
const { Horizon, Keypair, Asset, TransactionBuilder, Operation, Networks, BASE_FEE } = require('@stellar/stellar-sdk');
const axios = require('axios');
const winston = require('winston');
const { format, transports } = winston;
const { combine, timestamp, printf } = format;
const indicators = require('technicalindicators');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const DailyRotateFile = require('winston-daily-rotate-file');

// Конфигурация retry
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

// Настройка логгера с ротацией
const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});
const logger = winston.createLogger({
  level: 'debug',
  format: combine(
    timestamp(),
    logFormat
  ),
  transports: [
    new DailyRotateFile({
      filename: process.env.LOG_FILE || 'bot-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d'
    }),
    new winston.transports.Console()
  ]
});

// Конфигурация
const secretKey = process.env.SECRET_KEY;
const issuerAddress = process.env.ISSUER_ADDRESS;
const baseAssetCode = process.env.BASE_ASSET_CODE;
const counterAssetCode = process.env.COUNTER_ASSET_CODE;
const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const tradeInterval = parseInt(process.env.TRADE_INTERVAL) || 60000;
const minProfitThreshold = parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.01;
const stopLossPercent = parseFloat(process.env.STOP_LOSS_PERCENT) || 2.0;
const takeProfitPercent = parseFloat(process.env.TAKE_PROFIT_PERCENT) || 5.0;
const testMode = process.env.TEST_MODE === 'true';
const testXlmBalance = parseFloat(process.env.TEST_XLM_BALANCE) || 100;
const testRuvBalance = parseFloat(process.env.TEST_RUV_BALANCE) || 1000;

// Инициализация базы данных
const dbPath = path.join(__dirname, process.env.DATABASE_NAME || 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('Ошибка подключения к БД:', err.message);
  } else {
    logger.info('Подключение к SQLite БД успешно');
    createTables();
  }
});

function createTables() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      price REAL,
      amount REAL,
      type TEXT,
      profit REAL
    )`,
    `CREATE TABLE IF NOT EXISTS indicators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      ma REAL,
      rsi REAL,
      macd REAL,
      signal REAL,
      atr REAL
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      type TEXT,
      price REAL,
      amount REAL,
      status TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS active_orders (
      order_id TEXT PRIMARY KEY,
      type TEXT,
      price REAL,
      amount REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ];
  db.serialize(() => {
    queries.forEach(query => {
      db.run(query, (err) => {
        if (err) logger.error(`Ошибка создания таблицы: ${err.message}`);
      });
    });
  });
}

// Инициализация сервера Stellar
const server = new Horizon.Server(horizonUrl);
const accountKeypair = Keypair.fromSecret(secretKey);

// Определение активов
const baseAsset = new Asset(baseAssetCode, issuerAddress);
const counterAsset = Asset.native(); // XLM

// Универсальная функция с retry-логикой
async function withRetry(operation, retries = MAX_RETRIES, delay = INITIAL_RETRY_DELAY) {
  try {
    return await operation();
  } catch (error) {
    if (retries > 0 && (error.type === 'request-timeout' || error.status >= 500)) {
      logger.warn(`Повторная попытка через ${delay}мс. Осталось попыток: ${retries}`);
      await new Promise(res => setTimeout(res, delay));
      return withRetry(operation, retries - 1, delay * 2);
    }
    throw error;
  }
}

// Функция для проверки существующих ордеров
async function checkExistingOrders() {
  try {
    const accountId = accountKeypair.publicKey();
    const orders = await withRetry(async () => 
      await server.orders()
        .forAccount(accountId)
        .call()
    );
    
    const activeOrders = orders.records.map(order => ({
      id: order.id,
      type: order.type,
      price: parseFloat(order.price),
      amount: parseFloat(order.amount),
      createdAt: order.created_at
    }));
    
    // Обновляем БД с учетом offerId
    const stmt = db.prepare('INSERT OR IGNORE INTO active_orders (order_id, type, price, amount) VALUES (?, ?, ?, ?)');
    activeOrders.forEach(order => {
      stmt.run(
        order.id,
        order.type,
        order.price,
        order.amount
      );
    });
    stmt.finalize();
    
    return activeOrders;
  } catch (error) {
    logger.error('Ошибка при проверке ордеров:', error.message);
    return [];
  }
}

// Кэшированный баланс
let balanceCache = {
  ruvBalance: 0,
  xlmBalance: 0,
  lastUpdated: 0
};

// Функция для получения баланса аккаунта
async function getAccountBalance(forceUpdate = false) {
  if (testMode && !forceUpdate) {
    logger.info(`Тестовый режим: XLM=${testXlmBalance}, RUV=${testRuvBalance}`);
    return { ruvBalance: testRuvBalance, xlmBalance: testXlmBalance };
  }
  
  // Кэшируем баланс на 10 секунд
  if (!forceUpdate && Date.now() - balanceCache.lastUpdated < 10000) {
    return balanceCache;
  }
  
  try {
    const accountResponse = await withRetry(async () =>
      await server.loadAccount(accountKeypair.publicKey())
    );
    
    let ruvBalance = 0;
    let xlmBalance = 0;
    
    for (const balance of accountResponse.balances) {
      if (balance.asset_code === baseAssetCode && balance.asset_issuer === issuerAddress) {
        ruvBalance = parseFloat(balance.balance);
      } else if (balance.asset_type === 'native') {
        xlmBalance = parseFloat(balance.balance);
      }
    }
    
    balanceCache = {
      ruvBalance,
      xlmBalance,
      lastUpdated: Date.now()
    };
    
    logger.info(`Баланс: RUV=${ruvBalance.toFixed(2)}, XLM=${xlmBalance.toFixed(7)}`);
    return balanceCache;
  } catch (error) {
    logger.error('Ошибка при получении баланса:', error.message);
    throw error;
  }
}

// Кэшированная история трейдов
let tradeHistoryCache = {
  data: [],
  lastUpdated: 0
};

// Функция для получения истории трейдов
async function getTradeHistory(limit = 100, forceUpdate = false) {
  if (!forceUpdate && Date.now() - tradeHistoryCache.lastUpdated < 5000) {
    return tradeHistoryCache.data;
  }
  
  try {
    const response = await withRetry(async () =>
      await server.trades()
        .forAssetPair(baseAsset, counterAsset)
        .limit(limit)
        .call()
    );
    
    const history = response.records.map(record => ({
      price: parseFloat(record.price),
      baseAmount: parseFloat(record.base_amount),
      counterAmount: parseFloat(record.counter_amount),
      time: record.ledger_close_time,
      volume: parseFloat(record.base_amount) * parseFloat(record.price)
    }));
    
    tradeHistoryCache = {
      data: history,
      lastUpdated: Date.now()
    };
    
    return history;
  } catch (error) {
    logger.error('Ошибка при получении истории трейдов:', error.message);
    throw error;
  }
}

// Расширенный расчет индикаторов с ATR
function calculateIndicators(prices) {
  if (!prices || prices.length < 14) {
    logger.warn('Недостаточно данных для расчета индикаторов');
    return { ma: [], rsi: [], macd: [], signal: [], atr: [] };
  }
  
  const closePrices = prices.map(p => p.price);
  const highPrices = prices.map(p => p.high || p.price * 1.01);
  const lowPrices = prices.map(p => p.low || p.price * 0.99);
  const volume = prices.map(p => p.volume);
  
  // MA (Moving Average)
  const ma = indicators.SMA.calculate({ period: 14, values: closePrices });
  
  // RSI (Relative Strength Index)
  const rsi = indicators.RSI.calculate({ period: 14, values: closePrices });
  
  // MACD (Moving Average Convergence Divergence)
  const macd = indicators.MACD.calculate({ 
    shortPeriod: 12, 
    longPeriod: 26, 
    signalPeriod: 9, 
    values: closePrices 
  });
  
  // ATR (Average True Range)
  const atr = indicators.ATR.calculate({
    period: 14,
    high: highPrices,
    low: lowPrices,
    close: closePrices
  });
  
  // Сохраняем последние значения в БД
  if (ma.length > 0 && rsi.length > 0 && macd.length > 0 && atr.length > 0) {
    const lastMa = ma[ma.length - 1];
    const lastRsi = rsi[rsi.length - 1];
    const lastMacd = macd[0][macd[0].length - 1];
    const lastSignal = macd[1][macd[1].length - 1];
    const lastAtr = atr[atr.length - 1];
    
    db.run(
      'INSERT INTO indicators (ma, rsi, macd, signal, atr) VALUES (?, ?, ?, ?, ?)',
      [lastMa, lastRsi, lastMacd, lastSignal, lastAtr],
      (err) => {
        if (err) logger.error('Ошибка сохранения индикаторов:', err.message);
      }
    );
  }
  
  return { ma, rsi, macd, signal: macd[1], atr };
}

// Функция для создания ордера
async function createOrder(sellingAsset, buyingAsset, amount, price, isBuy) {
  try {
    // Проверяем существующие ордера с retry
    const existingOrders = await withRetry(checkExistingOrders);
    
    // Проверка дубликатов с учетом offerId
    const isDuplicate = existingOrders.some(order => 
      Math.abs(order.price - price) < 0.000001 && 
      Math.abs(order.amount - amount) < 0.000001 &&
      order.type === (isBuy ? 'buy' : 'sell')
    );
    
    if (isDuplicate) {
      logger.warn('Обнаружен дублирующийся ордер, пропускаем создание');
      return null;
    }
    
    // Получаем аккаунт с retry
    const accountResponse = await withRetry(() => 
      server.loadAccount(accountKeypair.publicKey())
    );
    
    // Создаем транзакцию
    const transaction = new TransactionBuilder(accountResponse, {
      fee: TransactionBuilder.BASE_FEE,
      networkPassphrase: Networks.PUBLIC
    })
      .addOperation(Operation.manageSellOffer({
        selling: sellingAsset,
        buying: buyingAsset,
        amount: amount.toFixed(7),
        price: price.toString(),
        offerId: '0'
      }))
      .setTimeout(30)
      .build();
    
    transaction.sign(accountKeypair);
    
    // Отправляем транзакцию с retry
    const result = await withRetry(() => 
      server.submitTransaction(transaction)
    );
    
    // Сохраняем информацию об ордере с offerId
    db.run(
      'INSERT INTO orders (order_id, type, price, amount, status) VALUES (?, ?, ?, ?, ?)',
      [result.hash, isBuy ? 'buy' : 'sell', price, amount, 'created'],
      (err) => {
        if (err) logger.error('Ошибка сохранения ордера:', err.message);
      }
    );
    
    logger.info(`${isBuy ? 'Ордер на покупку' : 'Ордер на продажу'} создан:`, result.hash);
    return result.hash;
  } catch (error) {
    logger.error(`Ошибка при создании ордера: ${error.message}`);
    return null;
  }
}

// Функция для создания ордера на покупку
async function createBuyOrder(price, amount) {
  return createOrder(counterAsset, baseAsset, amount, price, true);
}

// Функция для создания ордера на продажу
async function createSellOrder(price, amount) {
  return createOrder(baseAsset, counterAsset, amount, price, false);
}

// Расширенная стратегия торговли
async function analyzeMarket() {
  try {
    const tradeHistory = await getTradeHistory(100);
    const indicatorsData = calculateIndicators(tradeHistory);
    
    if (!indicatorsData.ma.length || 
        !indicatorsData.rsi.length || 
        !indicatorsData.macd.length || 
        !indicatorsData.atr.length) {
      logger.warn('Недостаточно данных для анализа');
      return;
    }
    
    const lastPrice = tradeHistory[tradeHistory.length - 1].price;
    const ma = indicatorsData.ma[indicatorsData.ma.length - 1];
    const rsi = indicatorsData.rsi[indicatorsData.rsi.length - 1];
    const macdLine = indicatorsData.macd[indicatorsData.macd.length - 1];
    const signalLine = indicatorsData.signal[indicatorsData.signal.length - 1];
    const atr = indicatorsData.atr[indicatorsData.atr.length - 1];
    
    logger.info(`Текущая цена: ${lastPrice.toFixed(7)}`);
    logger.info(`MA: ${ma.toFixed(7)}, RSI: ${rsi.toFixed(2)}, MACD: ${macdLine.toFixed(7)}, Signal: ${signalLine.toFixed(7)}, ATR: ${atr.toFixed(7)}`);
    
    let shouldBuy = false;
    let shouldSell = false;
    
    // Улучшенная стратегия с учетом нескольких факторов
    if (lastPrice > ma && 
        rsi < 30 && 
        macdLine > signalLine && 
        tradeHistory[tradeHistory.length - 1].volume > 100) {
      shouldBuy = true;
    } else if (lastPrice < ma && 
               rsi > 70 && 
               macdLine < signalLine && 
               tradeHistory[tradeHistory.length - 1].volume > 100) {
      shouldSell = true;
    }
    
    if (!shouldBuy && !shouldSell) {
      logger.info('Текущие условия не подходят для сделки.');
      return;
    }
    
    const { ruvBalance, xlmBalance } = await getAccountBalance(true);
    logger.info(`Текущий баланс: RUV=${ruvBalance.toFixed(2)}, XLM=${xlmBalance.toFixed(7)}`);
    
    // Расчет позиционного размера с учетом ATR
    const positionSize = calculatePositionSize(rsi, atr, xlmBalance, ruvBalance);
    
    if (shouldBuy && xlmBalance >= positionSize.minXlm) {
      const buyPrice = calculateOptimalPrice(lastPrice, 'buy', atr);
      const buyAmount = Math.min(
        positionSize.amount, 
        xlmBalance * 0.9 // Резервируем 10% для комиссий
      );
      
      if (buyAmount >= 0.0000001) {
        await createBuyOrder(buyPrice, buyAmount);
        await createStopLossAndTakeProfit(buyPrice, buyAmount, true);
      }
    } 
    else if (shouldSell && ruvBalance >= positionSize.minRuv) {
      const sellPrice = calculateOptimalPrice(lastPrice, 'sell', atr);
      const sellAmount = Math.min(
        positionSize.amount, 
        ruvBalance * 0.9
      );
      
      if (sellAmount >= 0.001) {
        await createSellOrder(sellPrice, sellAmount);
        await createStopLossAndTakeProfit(sellPrice, sellAmount, false);
      }
    }
  } catch (error) {
    logger.error('Ошибка в анализе рынка:', error.message);
  }
}

// Расчет размера позиции с учетом рисков
function calculatePositionSize(rsi, atr, xlmBalance, ruvBalance) {
  const baseRisk = 0.02; // 2% от капитала
  const volatilityFactor = 1 / (1 + (atr / 0.01)); // Нормализация ATR
  
  // Адаптация под RSI
  let riskMultiplier = 1;
  if (rsi < 20 || rsi > 80) riskMultiplier = 1.5; // Усиление позиции при экстремальных значениях RSI
  
  const capital = Math.min(
    xlmBalance * 0.5, // Используем максимум 50% баланса
    ruvBalance * 0.5
  );
  
  return {
    amount: capital * baseRisk * volatilityFactor * riskMultiplier,
    minXlm: 0.0000001,
    minRuv: 0.001
  };
}

// Расчет оптимальной цены с учетом ATR
function calculateOptimalPrice(lastPrice, type, atr) {
  const offset = atr * 0.5; // Половина ATR
  return type === 'buy' ? lastPrice * 0.995 - offset : lastPrice * 1.005 + offset;
}

// Функция для создания стоп-лосс и тейк-профит ордеров
async function createStopLossAndTakeProfit(entryPrice, amount, isBuyOrder) {
  try {
    const stopLossPrice = isBuyOrder 
      ? entryPrice * (1 - stopLossPercent / 100) 
      : entryPrice * (1 + stopLossPercent / 100);
    const takeProfitPrice = isBuyOrder 
      ? entryPrice * (1 + takeProfitPercent / 100) 
      : entryPrice * (1 - takeProfitPercent / 100);
    
    logger.info(`Создание стоп-лосс: ${stopLossPrice}, тейк-профит: ${takeProfitPrice}`);
    
    // Добавляем защиту от слишком близких уровней
    if (isBuyOrder) {
      if (takeProfitPrice > entryPrice * 1.001) {
        await createSellOrder(takeProfitPrice, amount);
      }
      if (stopLossPrice < entryPrice * 0.999) {
        await createSellOrder(stopLossPrice, amount);
      }
    } else {
      if (takeProfitPrice < entryPrice * 0.999) {
        await createBuyOrder(takeProfitPrice, amount);
      }
      if (stopLossPrice > entryPrice * 1.001) {
        await createBuyOrder(stopLossPrice, amount);
      }
    }
  } catch (error) {
    logger.error('Ошибка при создании стоп-лосс/тейк-профит:', error.message);
  }
}

// Запуск бота с перезапуском при критических ошибках
async function startBot() {
  logger.info('Бот запущен. Начинаю анализ рынка...');
  
  let restartAttempts = 0;
  const maxRestartAttempts = 5;
  
  try {
    const network = await withRetry(() => server.fetchBaseFee());
    logger.info(`Подключение к сети Stellar успешно. Базовая комиссия: ${network}`);
  } catch (error) {
    logger.error('Не удалось подключиться к сети Stellar:', error.message);
    process.exit(1);
  }
  
  // Первый запуск немедленно
  await analyzeMarket();
  
  // Запуск по расписанию
  setInterval(async () => {
    try {
      await analyzeMarket();
      restartAttempts = 0; // Сброс счетчика при успешном запуске
    } catch (error) {
      logger.error('Критическая ошибка в работе бота:', error.message);
      restartAttempts++;
      
      if (restartAttempts >= maxRestartAttempts) {
        logger.error(`Достигнуто максимальное количество попыток перезапуска (${maxRestartAttempts})`);
        process.exit(1);
      }
      
      logger.info(`Попытка перезапуска через ${restartAttempts * 30} секунд`);
      setTimeout(async () => {
        try {
          await analyzeMarket();
          restartAttempts = 0;
        } catch (error) {
          logger.error('Ошибка при перезапуске:', error.message);
        }
      }, restartAttempts * 30000);
    }
  }, tradeInterval);
}

startBot();
