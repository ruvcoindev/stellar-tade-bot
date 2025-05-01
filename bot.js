require('dotenv').config();
const { Server, Keypair, Asset, TransactionBuilder, Operation, Network } = require('@stellar/stellar-sdk');
const axios = require('axios');
const winston = require('winston');
const { format, transports } = winston;
const { combine, timestamp, printf } = format;
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Настройка логгера
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
    new transports.File({ filename: process.env.LOG_FILE }),
    new transports.Console()
  ]
});

// Настройки
const secretKey = process.env.SECRET_KEY;
const issuerAddress = process.env.ISSUER_ADDRESS;
const baseAssetCode = process.env.BASE_ASSET_CODE;
const counterAssetCode = process.env.COUNTER_ASSET_CODE;
const horizonUrl = process.env.HORIZON_URL;
const tradeInterval = parseInt(process.env.TRADE_INTERVAL);
const minProfitThreshold = parseFloat(process.env.MIN_PROFIT_THRESHOLD);
const stopLossPercent = parseFloat(process.env.STOP_LOSS_PERCENT);
const takeProfitPercent = parseFloat(process.env.TAKE_PROFIT_PERCENT);
const testMode = process.env.TEST_MODE === 'true';
const testXlmBalance = parseFloat(process.env.TEST_XLM_BALANCE);
const testRuvBalance = parseFloat(process.env.TEST_RUV_BALANCE);

// Инициализация базы данных
const dbPath = path.join(__dirname, process.env.DATABASE_NAME);
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('Ошибка подключения к БД:', err.message);
  } else {
    logger.info('Подключение к SQLite БД успешно');
    createTables();
  }
});

function createTables() {
  const createTradesTable = `
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      price REAL,
      amount REAL,
      type TEXT,
      profit REAL
    )`;

  const createIndicatorsTable = `
    CREATE TABLE IF NOT EXISTS indicators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      ma REAL,
      rsi REAL,
      macd REAL,
      signal REAL
    )`;

  const createOrdersTable = `
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      type TEXT,
      price REAL,
      amount REAL,
      status TEXT
    )`;

  db.run(createTradesTable, (err) => {
    if (err) logger.error('Ошибка создания таблицы trades:', err.message);
  });
  db.run(createIndicatorsTable, (err) => {
    if (err) logger.error('Ошибка создания таблицы indicators:', err.message);
  });
  db.run(createOrdersTable, (err) => {
    if (err) logger.error('Ошибка создания таблицы orders:', err.message);
  });
}

// Инициализация Stellar SDK
Network.usePublicNetwork(); // Установка сети
const server = new Server(horizonUrl, {
  allowHttp: horizonUrl.includes('testnet') // Только для тестовой сети
});

const accountKeypair = Keypair.fromSecret(secretKey);

// Определение активов
const baseAsset = new Asset(baseAssetCode, issuerAddress);
const counterAsset = Asset.native(); // XLM

// Функция для проверки лимитов Horizon API
async function checkApiRateLimits(response) {
  const remaining = parseInt(response.headers['x-ratelimit-remaining']);
  const limit = parseInt(response.headers['x-ratelimit-limit']);
  const resetTime = new Date(parseInt(response.headers['x-ratelimit-reset']) * 1000);
  
  logger.debug(`Лимиты API: ${remaining}/${limit}, сброс через ${resetTime.toLocaleTimeString()}`);
  
  if (remaining < 10) {
    logger.warn(`Осталось менее 10 запросов до сброса лимитов!`);
    sendEmail('Предупреждение: Лимиты Horizon API', `Осталось ${remaining}/${limit} запросов. Сброс через ${resetTime.toLocaleTimeString()}`);
  }
}

// Функция для получения баланса аккаунта
async function getAccountBalance() {
  if (testMode) {
    logger.info(`Тестовый режим: XLM=${testXlmBalance}, RUV=${testRuvBalance}`);
    return { ruvBalance: testRuvBalance, xlmBalance: testXlmBalance };
  }

  try {
    const accountResponse = await server.loadAccount(accountKeypair.publicKey());
    const balances = accountResponse.balances;
    
    let ruvBalance = 0;
    let xlmBalance = 0;
    
    for (const balance of balances) {
      if (balance.asset_code === baseAssetCode && balance.asset_issuer === issuerAddress) {
        ruvBalance = parseFloat(balance.balance);
      } else if (balance.asset_type === 'native') {
        xlmBalance = parseFloat(balance.balance);
      }
    }
    
    logger.info(`Баланс: RUV=${ruvBalance.toFixed(2)}, XLM=${xlmBalance.toFixed(7)}`);
    return { ruvBalance, xlmBalance };
  } catch (error) {
    logger.error('Ошибка при получении баланса:', error.message);
    throw error;
  }
}

// Функция для получения истории трейдов
async function getTradeHistory(limit = 100) {
  try {
    const response = await server.trades().forAssetPair(baseAsset, counterAsset).limit(limit).call();
    await checkApiRateLimits(response); // Проверка лимитов
    return response.records.map(record => ({
      price: parseFloat(record.price),
      baseAmount: parseFloat(record.base_amount),
      counterAmount: parseFloat(record.counter_amount),
      time: record.ledger_close_time
    }));
  } catch (error) {
    logger.error('Ошибка при получении истории трейдов:', error.message);
    throw error;
  }
}

// Функция для расчета индикаторов
function calculateIndicators(prices) {
  const closePrices = prices.map(p => p.price).reverse(); // Новые данные в конце
  if (closePrices.length < 14) {
    logger.warn('Недостаточно данных для расчета индикаторов');
    return { ma: [], rsi: [], macd: [] };
  }
  
  // MA (Moving Average)
  const ma = require('technicalindicators').SMA.calculate({ period: 14, values: closePrices });
  // RSI (Relative Strength Index)
  const rsi = require('technicalindicators').RSI.calculate({ period: 14, values: closePrices });
  // MACD (Moving Average Convergence Divergence)
  const macd = require('technicalindicators').MACD.calculate({ 
    shortPeriod: 12, 
    longPeriod: 26, 
    signalPeriod: 9, 
    values: closePrices 
  });
  
  // Сохранение индикаторов в БД
  if (ma.length > 0 && rsi.length > 0 && macd.length > 0) {
    const stmt = db.prepare('INSERT INTO indicators (ma, rsi, macd, signal) VALUES (?, ?, ?, ?)');
    stmt.run(ma[ma.length - 1], rsi[rsi.length - 1], macd[0][macd[0].length - 1], macd[1][macd[1].length - 1]);
    stmt.finalize();
  }
  
  return { ma, rsi, macd };
}

// Функция для создания ордера на покупку
async function createBuyOrder(price, amount) {
  try {
    const accountResponse = await server.loadAccount(accountKeypair.publicKey());
    const transaction = new TransactionBuilder(accountResponse, {
      fee: TransactionBuilder.BASE_FEE,
      networkPassphrase: Network.current().networkPassphrase
    })
      .addOperation(Operation.manageSellOffer({
        selling: counterAsset,
        buying: baseAsset,
        amount: amount.toFixed(7),
        price: price.toString(),
        offerId: '0'
      }))
      .setTimeout(30)
      .build();
    
    transaction.sign(accountKeypair);
    const result = await server.submitTransaction(transaction);
    logger.info('Ордер на покупку создан:', result.hash);
    
    // Сохранение ордера в БД
    const stmt = db.prepare('INSERT INTO orders (type, price, amount, status) VALUES (?, ?, ?, ?)');
    stmt.run('buy', price, amount, 'pending');
    stmt.finalize();
    
    // Создание стоп-лосс и тейк-профит
    await createStopLossAndTakeProfit(price, amount, true);
    
    return result.hash;
  } catch (error) {
    logger.error('Ошибка при создании ордера на покупку:', error.message);
    throw error;
  }
}

// Функция для создания ордера на продажу
async function createSellOrder(price, amount) {
  try {
    const accountResponse = await server.loadAccount(accountKeypair.publicKey());
    const transaction = new TransactionBuilder(accountResponse, {
      fee: TransactionBuilder.BASE_FEE,
      networkPassphrase: Network.current().networkPassphrase
    })
      .addOperation(Operation.manageSellOffer({
        selling: baseAsset,
        buying: counterAsset,
        amount: amount.toFixed(7),
        price: price.toString(),
        offerId: '0'
      }))
      .setTimeout(30)
      .build();
    
    transaction.sign(accountKeypair);
    const result = await server.submitTransaction(transaction);
    logger.info('Ордер на продажу создан:', result.hash);
    
    // Сохранение ордера в БД
    const stmt = db.prepare('INSERT INTO orders (type, price, amount, status) VALUES (?, ?, ?, ?)');
    stmt.run('sell', price, amount, 'pending');
    stmt.finalize();
    
    // Создание стоп-лосс и тейк-профит
    await createStopLossAndTakeProfit(price, amount, false);
    
    return result.hash;
  } catch (error) {
    logger.error('Ошибка при создании ордера на продажу:', error.message);
    throw error;
  }
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
    
    if (isBuyOrder) {
      await createSellOrder(stopLossPrice, amount);
      await createSellOrder(takeProfitPrice, amount);
    } else {
      await createBuyOrder(stopLossPrice, amount);
      await createBuyOrder(takeProfitPrice, amount);
    }
  } catch (error) {
    logger.error('Ошибка при создании стоп-лосс/тейк-профит:', error.message);
  }
}

// Функция для анализа рынка и принятия решений
async function analyzeMarket() {
  try {
    const tradeHistory = await getTradeHistory(100);
    const indicatorsData = calculateIndicators(tradeHistory);
    
    if (!indicatorsData.ma.length || !indicatorsData.rsi.length || !indicatorsData.macd[0].length) {
      logger.warn('Недостаточно данных для анализа');
      return;
    }
    
    const lastPrice = tradeHistory[tradeHistory.length - 1].price;
    const ma = indicatorsData.ma[indicatorsData.ma.length - 1];
    const rsi = indicatorsData.rsi[indicatorsData.rsi.length - 1];
    const macdLine = indicatorsData.macd[0][indicatorsData.macd[0].length - 1];
    const signalLine = indicatorsData.macd[1][indicatorsData.macd[1].length - 1];
    
    logger.info(`Текущая цена: ${lastPrice.toFixed(7)}`);
    logger.info(`MA: ${ma.toFixed(7)}, RSI: ${rsi.toFixed(2)}, MACD: ${macdLine.toFixed(7)}, Signal: ${signalLine.toFixed(7)}`);
    
    // Стратегия торговли
    let shouldBuy = false;
    let shouldSell = false;
    
    // Условия для покупки
    if (lastPrice > ma && rsi < 30 && macdLine > signalLine) {
      shouldBuy = true;
    }
    // Условия для продажи
    else if (lastPrice < ma && rsi > 70 && macdLine < signalLine) {
      shouldSell = true;
    }
    
    if (!shouldBuy && !shouldSell) {
      logger.info('Текущие условия не подходят для сделки.');
      return;
    }
    
    // Получаем баланс аккаунта
    const { ruvBalance, xlmBalance } = await getAccountBalance();
    logger.info(`Текущий баланс: RUV=${ruvBalance.toFixed(2)}, XLM=${xlmBalance.toFixed(7)}`);
    
    // Выполняем сделку
    if (shouldBuy && xlmBalance >= 0.001) {
      const buyPrice = lastPrice * 0.99; // Покупаем на 1% ниже текущей цены
      const buyAmountXLM = Math.min(xlmBalance * 0.5, 10); // Половина баланса, максимум 10 XLM
      await createBuyOrder(buyPrice, buyAmountXLM);
    } 
    else if (shouldSell && ruvBalance >= 0.001) {
      const sellPrice = lastPrice * 1.01; // Продаем на 1% выше текущей цены
      const sellAmountRUV = Math.min(ruvBalance * 0.5, 10); // Половина баланса, максимум 10 RUV
      await createSellOrder(sellPrice, sellAmountRUV);
    }
  } catch (error) {
    logger.error('Ошибка в анализе рынка:', error.message);
  }
}

// Функция для отправки email
function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailUser,
      pass: emailPassword
    }
  });
  
  const mailOptions = {
    from: emailUser,
    to: emailTo,
    subject,
    text: body
  };
  
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      logger.error('Ошибка при отправке email:', error.message);
    } else {
      logger.info('Email успешно отправлен:', info.response);
    }
  });
}

// Запуск бота
async function startBot() {
  logger.info('Бот запущен. Начинаю анализ рынка...');
  
  // Проверка подключения к сети
  try {
    const network = await server.fetchBaseFee();
    logger.info(`Подключение к сети Stellar успешно. Базовая комиссия: ${network}`);
  } catch (error) {
    logger.error('Не удалось подключиться к сети Stellar:', error.message);
    process.exit(1);
  }
  
  // Запуск анализа
  setInterval(async () => {
    try {
      await analyzeMarket();
    } catch (error) {
      logger.error('Критическая ошибка в работе бота:', error.message);
      sendEmail('Критическая ошибка в торговом боте', `Ошибка: ${error.message}`);
    }
  }, tradeInterval);
}

startBot();
