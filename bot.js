require('dotenv').config();
const StellarSdk = require('stellar-sdk');
const axios = require('axios');
const winston = require('winston');
const { format, transports } = winston;
const { combine, timestamp, printf } = format;
const indicators = require('technicalindicators');
const nodemailer = require('nodemailer');

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
const stopLossPercent = parseFloat(process.env.STOP_LOSS_PERCENT) || 2;
const takeProfitPercent = parseFloat(process.env.TAKE_PROFIT_PERCENT) || 5;

// Настройки email
const emailUser = process.env.EMAIL_USER;
const emailPassword = process.env.EMAIL_PASSWORD;
const emailTo = process.env.EMAIL_TO;

// Инициализация Stellar SDK
StellarSdk.Server.allowHttp(true); // Разрешить HTTP (только для тестовой сети)
const server = new StellarSdk.Server(horizonUrl);
const accountKeypair = StellarSdk.Keypair.fromSecret(secretKey);

// Определение активов
const baseAsset = new StellarSdk.Asset(baseAssetCode, issuerAddress);
const counterAsset = StellarSdk.Asset.native(); // XLM

// Функция для получения баланса аккаунта
async function getAccountBalance() {
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
    logger.warn('Недостаточно данных для расчета индикatorов');
    return { ma: [], rsi: [], macd: { macd: [], signal: [] } };
  }

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

  return { ma, rsi, macd };
}

// Функция для создания ордера на покупку
async function createBuyOrder(price, amount) {
  try {
    const accountResponse = await server.loadAccount(accountKeypair.publicKey());
    const transaction = new StellarSdk.TransactionBuilder(accountResponse, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.PUBLIC
    })
      .addOperation(StellarSdk.Operation.manageSellOffer({
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

    // Отправка email-уведомления
    sendEmail('Ордер на покупку создан', `Цена: ${price}, Кол-во: ${amount}, Хэш: ${result.hash}`);

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
    const transaction = new StellarSdk.TransactionBuilder(accountResponse, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.PUBLIC
    })
      .addOperation(StellarSdk.Operation.manageSellOffer({
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

    // Отправка email-уведомления
    sendEmail('Ордер на продажу создан', `Цена: ${price}, Кол-во: ${amount}, Хэш: ${result.hash}`);

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

    if (!indicatorsData.ma.length || !indicatorsData.rsi.length || !indicatorsData.macd.macd.length) {
      logger.warn('Недостаточно данных для анализа');
      return;
    }

    const lastPrice = tradeHistory[tradeHistory.length - 1].price;
    const ma = indicatorsData.ma[indicatorsData.ma.length - 1];
    const rsi = indicatorsData.rsi[indicatorsData.rsi.length - 1];
    const macdLine = indicatorsData.macd.macd[indicatorsData.macd.macd.length - 1];
    const signalLine = indicatorsData.macd.signal[indicatorsData.macd.signal.length - 1];

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
      const orderId = await createBuyOrder(buyPrice, buyAmountXLM);
      await createStopLossAndTakeProfit(buyPrice, buyAmountXLM, true);
    } 
    else if (shouldSell && ruvBalance >= 0.001) {
      const sellPrice = lastPrice * 1.01; // Продаем на 1% выше текущей цены
      const sellAmountRUV = Math.min(ruvBalance * 0.5, 10); // Половина баланса, максимум 10 RUV
      const orderId = await createSellOrder(sellPrice, sellAmountRUV);
      await createStopLossAndTakeProfit(sellPrice, sellAmountRUV, false);
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
