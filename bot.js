// bot.js
require('dotenv').config();
const { Horizon, Keypair, Asset, TransactionBuilder, Operation, Networks, BASE_FEE } = require('@stellar/stellar-sdk');
const winston = require('winston');
const { format, transports } = winston;
const { combine, timestamp, printf } = format;
const indicators = require('technicalindicators');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const DailyRotateFile = require('winston-daily-rotate-file');
const fetch = require('node-fetch');

// 1. ИНИЦИАЛИЗАЦИЯ ЛОГГЕРА
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
    new transports.Console()
  ]
});

// 2. КОНФИГУРАЦИЯ
const config = {
  secretKey: process.env.SECRET_KEY,
  issuerAddress: process.env.ISSUER_ADDRESS,
  baseAssetCode: process.env.BASE_ASSET_CODE,
  horizonUrl: process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
  tradeInterval: parseInt(process.env.TRADE_INTERVAL) || 30000,
  riskPerTrade: parseFloat(process.env.RISK_PER_TRADE) || 0.02,
  maxPortfolioRisk: parseFloat(process.env.MAX_PORTFOLIO_RISK) || 0.2,
  trailingStopOffset: parseFloat(process.env.TRAILING_STOP) || 1.5,
  candleInterval: '5m',
  candleLimit: 100,
  minBalanceReserve: 0.5 // Минимальный резерв XLM для комиссий
};

// 3. ИНИЦИАЛИЗАЦИЯ STELLAR
const server = new Horizon.Server(config.horizonUrl);
const accountKeypair = Keypair.fromSecret(config.secretKey);
const baseAsset = new Asset(config.baseAssetCode, config.issuerAddress);
const counterAsset = Asset.native();

// 4. БАЗА ДАННЫХ
const db = new sqlite3.Database(path.join(__dirname, 'trading.db'), err => {
  if (err) logger.error('DB error:', err);
  else logger.info('Connected to SQLite');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY,
    entry_price REAL,
    position_size REAL,
    direction TEXT,
    stop_loss REAL,
    take_profit REAL,
    trailing_stop REAL,
    opened_at DATETIME,
    closed_at DATETIME
  )`, [], (err) => {
    if (err) logger.error('Positions table error:', err);
  });

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    type TEXT,
    price REAL,
    amount REAL,
    status TEXT,
    created_at DATETIME,
    updated_at DATETIME
  )`, [], (err) => {
    if (err) logger.error('Orders table error:', err);
  });

  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,
    position_id INTEGER,
    type TEXT,
    price REAL,
    amount REAL,
    profit REAL,
    timestamp DATETIME
  )`, [], (err) => {
    if (err) logger.error('Trades table error:', err);
  });
});

// 5. МОДУЛЬ АГРЕГАЦИИ СВЕЧЕЙ
class CandleAggregator {
  constructor(interval) {
    this.interval = this.parseInterval(interval);
    this.buckets = {};
  }

  parseInterval(interval) {
    const units = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '1d': 86400
    };
    return units[interval] || 300;
  }

  roundTimestamp(timestamp) {
    return Math.floor(timestamp / this.interval) * this.interval;
  }

  addTrade(trade) {
    const timestamp = this.roundTimestamp(new Date(trade.ledger_close_time).getTime() / 1000);
    
    if (!this.buckets[timestamp]) {
      this.buckets[timestamp] = {
        open: parseFloat(trade.price),
        high: parseFloat(trade.price),
        low: parseFloat(trade.price),
        close: parseFloat(trade.price),
        volume: parseFloat(trade.amount),
        count: 1
      };
    } else {
      const bucket = this.buckets[timestamp];
      bucket.close = parseFloat(trade.price);
      bucket.high = Math.max(bucket.high, parseFloat(trade.price));
      bucket.low = Math.min(bucket.low, parseFloat(trade.price));
      bucket.volume += parseFloat(trade.amount);
      bucket.count++;
    }
  }

  getCandles(limit) {
    const sorted = Object.entries(this.buckets)
      .map(([ts, data]) => ({
        ...data,
        timestamp: parseInt(ts),
        time: new Date(ts * 1000).toISOString()
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    
    return sorted.slice(-limit);
  }
}

// 6. МОДУЛЬ УПРАВЛЕНИЯ РИСКАМИ
class RiskManager {
  constructor() {
    this.volatilityWindow = 14;
    this.positionHistory = [];
  }

  async getPortfolioValue() {
    try {
      const account = await server.loadAccount(accountKeypair.publicKey());
      const balance = account.balances.find(b => b.asset_type === 'native')?.balance || 0;
      return parseFloat(balance) - config.minBalanceReserve;
    } catch (error) {
      logger.error('Failed to load portfolio value:', error);
      return 0;
    }
  }

  async calculateDrawdown() {
    if (this.positionHistory.length < 2) return 0;
    
    const peak = Math.max(...this.positionHistory.map(p => p.profit));
    const latest = this.positionHistory[this.positionHistory.length - 1].profit;
    return (peak - latest) / peak;
  }

  async calculateATR(candles) {
    try {
      const values = candles.map(c => ({
        high: c.high,
        low: c.low,
        close: c.close
      }));
      
      const atrResult = indicators.ATR.calculate({ values, period: 14 });
      return atrResult[atrResult.length - 1];
    } catch (error) {
      logger.error('ATR calculation failed:', error);
      return 0;
    }
  }

  async calculatePositionSize(entryPrice, stopLossPrice) {
    try {
      const portfolioValue = await this.getPortfolioValue();
      if (portfolioValue <= 0) return 0;

      const riskAmount = portfolioValue * config.riskPerTrade;
      const priceDistance = Math.abs(entryPrice - stopLossPrice);
      
      if (priceDistance <= 0) return 0;

      const candles = await getCandleData();
      const atr = await this.calculateATR(candles);
      
      const positionSize = (riskAmount / priceDistance) * (1 - atr/entryPrice);
      return Math.min(positionSize, portfolioValue * config.maxPortfolioRisk);
    } catch (error) {
      logger.error('Position size calculation failed:', error);
      return 0;
    }
  }

  async adjustRiskParameters() {
    const portfolioValue = await this.getPortfolioValue();
    const drawdown = await this.calculateDrawdown();
    
    if (drawdown > 0.1) {
      config.riskPerTrade = Math.max(0.01, config.riskPerTrade * 0.8);
    }
    
    if (portfolioValue > config.startingBalance * 1.2) {
      config.riskPerTrade = Math.min(0.05, config.riskPerTrade * 1.1);
    }
  }

  async recordTrade(trade) {
    this.positionHistory.push(trade);
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO trades (position_id, type, price, amount, profit, timestamp) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [trade.position_id, trade.type, trade.price, trade.amount, trade.profit, trade.timestamp],
        function(err) {
          if (err) {
            logger.error('Failed to record trade:', err);
            reject(err);
          } else {
            resolve(this.lastID);
          }
        }
      );
    });
  }
}

// 7. ТОРГОВЫЙ ДВИЖОК
class TradingEngine {
  constructor() {
    this.activePositions = [];
    this.pendingOrders = [];
    this.candleAggregator = new CandleAggregator(config.candleInterval);
    this.lastCandleTime = 0;
  }

  async syncOpenPositions() {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM positions WHERE closed_at IS NULL', [], (err, rows) => {
        if (err) {
          logger.error('Failed to load positions:', err);
          reject(err);
        } else {
          this.activePositions = rows;
          resolve(rows);
        }
      });
    });
  }

  async executeStrategy() {
    try {
      // Получаем свечи
      const candles = await getCandleData();
      if (candles.length < 20) {
        logger.warn('Not enough data for analysis');
        return;
      }

      // Рассчитываем индикаторы
      const { ma, rsi, macd, atr } = calculateIndicators(candles);
      const lastClose = candles[candles.length-1].close;
      const signal = this.generateSignal(lastClose, ma, rsi, macd);

      // Управление риском
      const riskManager = new RiskManager();
      await riskManager.adjustRiskParameters();
      
      // Исполнение сделок
      if (signal === 'BUY') {
        await this.executeBuy(lastClose, atr);
      } else if (signal === 'SELL') {
        await this.executeSell(lastClose, atr);
      }

      // Мониторинг позиций
      await this.monitorPositions(lastClose);

    } catch (error) {
      logger.error('Strategy execution error:', error);
    }
  }

  generateSignal(lastClose, ma, rsi, macd) {
    if (!ma || !rsi || !macd) return 'HOLD';
    
    const lastMA = ma[ma.length - 1];
    const lastRSI = rsi[rsi.length - 1];
    const lastMACD = macd[macd.length - 1];

    // Пример простой стратегии
    if (lastClose > lastMA && lastRSI < 30 && lastMACD.histogram > 0) {
      return 'BUY';
    } else if (lastClose < lastMA && lastRSI > 70 && lastMACD.histogram < 0) {
      return 'SELL';
    }
    return 'HOLD';
  }

  async executeBuy(price, atr) {
    try {
      // Расчет стоп-лосса
      const stopLossPrice = price * (1 - (atr/price + config.trailingStopOffset/100));
      
      // Расчет размера позиции
      const positionSize = await new RiskManager().calculatePositionSize(price, stopLossPrice);
      
      if (positionSize <= 0) {
        logger.warn('Position size too small', { positionSize });
        return;
      }
      
      // Проверка баланса
      const portfolioValue = await new RiskManager().getPortfolioValue();
      if (portfolioValue < positionSize) {
        logger.warn('Insufficient balance', { required: positionSize, available: portfolioValue });
        return;
      }
      
      // Создание транзакции Stellar
      const account = await server.loadAccount(accountKeypair.publicKey());
      
      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET
      })
        .addOperation(Operation.payment({
          destination: accountKeypair.publicKey(),
          asset: baseAsset,
          amount: positionSize.toString()
        }))
        .setTimeout(30)
        .build();
      
      transaction.sign(accountKeypair);
      const result = await server.submitTransaction(transaction);
      
      logger.info('Buy order executed:', { hash: result.hash, positionSize });
      
      // Сохранение позиции в БД
      const positionId = await this.savePosition(price, positionSize, 'LONG', stopLossPrice, price * 1.05);
      
      // Запись в историю
      await new RiskManager().recordTrade({
        position_id: positionId,
        type: 'BUY',
        price: price,
        amount: positionSize,
        profit: 0,
        timestamp: Math.floor(Date.now() / 1000)
      });
    } catch (error) {
      logger.error('Buy order failed:', error);
    }
  }

  async executeSell(price, atr) {
    try {
      // Расчет стоп-лосса
      const stopLossPrice = price * (1 + (atr/price + config.trailingStopOffset/100));
      
      // Расчет размера позиции
      const positionSize = await new RiskManager().calculatePositionSize(price, stopLossPrice);
      
      if (positionSize <= 0) {
        logger.warn('Position size too small', { positionSize });
        return;
      }
      
      // Проверка баланса
      const account = await server.loadAccount(accountKeypair.publicKey());
      const balance = account.balances.find(b => 
        b.asset_type === 'credit_alphanum4' && 
        b.asset_code === config.baseAssetCode &&
        b.issuer === config.issuerAddress
      )?.balance || 0;
      
      if (parseFloat(balance) < positionSize) {
        logger.warn('Insufficient asset balance', { required: positionSize, available: balance });
        return;
      }
      
      // Создание транзакции Stellar
      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET
      })
        .addOperation(Operation.payment({
          destination: accountKeypair.publicKey(),
          asset: counterAsset,
          amount: positionSize.toString()
        }))
        .setTimeout(30)
        .build();
      
      transaction.sign(accountKeypair);
      const result = await server.submitTransaction(transaction);
      
      logger.info('Sell order executed:', { hash: result.hash, positionSize });
      
      // Сохранение позиции в БД
      const positionId = await this.savePosition(price, positionSize, 'SHORT', stopLossPrice, price * 0.95);
      
      // Запись в историю
      await new RiskManager().recordTrade({
        position_id: positionId,
        type: 'SELL',
        price: price,
        amount: positionSize,
        profit: 0,
        timestamp: Math.floor(Date.now() / 1000)
      });
    } catch (error) {
      logger.error('Sell order failed:', error);
    }
  }

  async savePosition(entryPrice, size, direction, stopLoss, takeProfit) {
    return new Promise((resolve, reject) => {
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO positions (entry_price, position_size, direction, stop_loss, take_profit, opened_at) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [entryPrice, size, direction, stopLoss, takeProfit, now],
        function(err) {
          if (err) {
            logger.error('Failed to save position:', err);
            reject(err);
          } else {
            logger.info('Position saved:', { id: this.lastID });
            resolve(this.lastID);
          }
        }
      );
    });
  }

  async updateOrder(orderId, newPrice) {
    // В Stellar это требует создания нового ордера и отмены старого
    logger.info('Updating order:', { orderId, newPrice });
  }

  async monitorPositions(currentPrice) {
    for (const position of this.activePositions) {
      let shouldClose = false;
      
      // Проверка стоп-лосса
      if (position.direction === 'LONG' && currentPrice <= position.stop_loss) {
        logger.info('Stop loss triggered for long position:', { id: position.id });
        shouldClose = true;
      } else if (position.direction === 'SHORT' && currentPrice >= position.stop_loss) {
        logger.info('Stop loss triggered for short position:', { id: position.id });
        shouldClose = true;
      }
      
      // Проверка take profit
      if (position.direction === 'LONG' && currentPrice >= position.take_profit) {
        logger.info('Take profit reached for long position:', { id: position.id });
        shouldClose = true;
      } else if (position.direction === 'SHORT' && currentPrice <= position.take_profit) {
        logger.info('Take profit reached for short position:', { id: position.id });
        shouldClose = true;
      }
      
      // Обновление трейлинг-стопа
      await this.updateTrailingStop(position, currentPrice);
      
      // Закрытие позиции
      if (shouldClose) {
        await this.closePosition(position, currentPrice);
      }
    }
  }

  async updateTrailingStop(position, currentPrice) {
    const offset = currentPrice * (config.trailingStopOffset/100);
    
    if (position.direction === 'LONG') {
      const newStop = currentPrice - offset;
      if (newStop > position.stop_loss) {
        await this.updateOrder(position.id, newStop);
        db.run(`UPDATE positions SET stop_loss = ? WHERE id = ?`, [newStop, position.id]);
        logger.info('Trailing stop updated for long position:', { id: position.id, newStop });
      }
    } else {
      const newStop = currentPrice + offset;
      if (newStop < position.stop_loss) {
        await this.updateOrder(position.id, newStop);
        db.run(`UPDATE positions SET stop_loss = ? WHERE id = ?`, [newStop, position.id]);
        logger.info('Trailing stop updated for short position:', { id: position.id, newStop });
      }
    }
  }

  async closePosition(position, currentPrice) {
    try {
      // Рассчитываем прибыль
      let profit = 0;
      if (position.direction === 'LONG') {
        profit = (currentPrice - position.entry_price) / position.entry_price;
      } else {
        profit = (position.entry_price - currentPrice) / position.entry_price;
      }
      
      // Создаем транзакцию закрытия
      const account = await server.loadAccount(accountKeypair.publicKey());
      
      if (position.direction === 'LONG') {
        // Продаем актив
        const transaction = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        })
          .addOperation(Operation.payment({
            destination: accountKeypair.publicKey(),
            asset: counterAsset,
            amount: position.position_size.toString()
          }))
          .setTimeout(30)
          .build();
        
        transaction.sign(accountKeypair);
        await server.submitTransaction(transaction);
      } else {
        // Покупаем актив
        const transaction = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        })
          .addOperation(Operation.payment({
            destination: accountKeypair.publicKey(),
            asset: baseAsset,
            amount: position.position_size.toString()
          }))
          .setTimeout(30)
          .build();
        
        transaction.sign(accountKeypair);
        await server.submitTransaction(transaction);
      }
      
      // Обновляем позицию в БД
      const now = new Date().toISOString();
      db.run(`UPDATE positions SET closed_at = ? WHERE id = ?`, [now, position.id]);
      
      // Обновляем историю сделок
      await new RiskManager().recordTrade({
        position_id: position.id,
        type: 'CLOSE',
        price: currentPrice,
        amount: position.position_size,
        profit: profit,
        timestamp: Math.floor(Date.now() / 1000)
      });
      
      logger.info('Position closed:', { id: position.id, profit: profit * 100 + '%' });
    } catch (error) {
      logger.error('Failed to close position:', error);
    }
  }
}

// 8. СИСТЕМА МОНИТОРИНГА И ЗАЩИТЫ
class HealthMonitor {
  constructor() {
    this.lastHeartbeat = Date.now();
    this.systemMetrics = {
      uptime: 0,
      trades: 0,
      errors: 0,
      successRate: 100
    };
  }

  async checkHealth() {
    try {
      // Проверяем подключение к Stellar
      await server.loadAccount(accountKeypair.publicKey());
      
      // Проверяем доступность БД
      await new Promise((resolve, reject) => {
        db.get('SELECT 1', [], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      this.lastHeartbeat = Date.now();
      return true;
    } catch (error) {
      logger.error('System health check failed:', error);
      this.handleFailure();
      return false;
    }
  }

  handleFailure() {
    // Останавливаем торги
    clearInterval(this.tradingInterval);
    
    // Отправляем уведомление
    this.sendAlert('Trading bot has stopped due to system failure');
    
    // Перезапускаем систему через 5 минут
    setTimeout(() => {
      logger.info('Restarting trading bot...');
      this.startMonitoring();
    }, 300000);
  }

  sendAlert(message) {
    // Реализация отправки уведомлений (email, Telegram, Slack и т.д.)
    logger.warn('ALERT:', message);
  }

  startMonitoring() {
    this.tradingInterval = setInterval(async () => {
      const health = await this.checkHealth();
      if (health) {
        this.systemMetrics.uptime += config.tradeInterval;
      }
    }, config.tradeInterval);
  }
}

// 9. ОСНОВНЫЕ ФУНКЦИИ
async function getCandleData() {
  try {
    // Получение последних сделок из Stellar
    const tradesResponse = await server.trades()
      .forAssetPair(baseAsset, counterAsset)
      .limit(config.candleLimit)
      .order('desc')
      .call();
    
    // Агрегация в свечи
    const aggregator = new CandleAggregator(config.candleInterval);
    tradesResponse.records.forEach(trade => {
      aggregator.addTrade(trade);
    });
    
    return aggregator.getCandles(config.candleLimit);
  } catch (error) {
    logger.error('Failed to get candle data:', error);
    return [];
  }
}

function calculateIndicators(candles) {
  if (!candles.length) return {};
  
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  try {
    return {
      ma: indicators.SMA.calculate({ period: 14, values: closes }),
      rsi: indicators.RSI.calculate({ period: 14, values: closes }),
      macd: indicators.MACD.calculate({ 
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9
      }),
      atr: indicators.ATR.calculate({
        values: candles.map(c => ({ high: c.high, low: c.low, close: c.close })),
        period: 14
      })
    };
  } catch (error) {
    logger.error('Indicator calculation error:', error);
    return {};
  }
}

// 10. ОСНОВНОЙ ЦИКЛ
async function startTradingBot() {
  try {
    const trader = new TradingEngine();
    const riskManager = new RiskManager();
    const healthMonitor = new HealthMonitor();
    
    // Инициализация начального баланса
    config.startingBalance = await riskManager.getPortfolioValue();
    
    // Синхронизация позиций
    await trader.syncOpenPositions();
    
    // Запуск основного цикла
    const runCycle = async () => {
      try {
        await trader.executeStrategy();
        await riskManager.adjustRiskParameters();
      } catch (error) {
        logger.error('Cycle error:', error);
      }
    };
    
    // Запуск циклов
    healthMonitor.startMonitoring();
    setInterval(runCycle, config.tradeInterval);
    
    logger.info('Trading bot started successfully');
    runCycle(); // Запуск первого цикла сразу
    
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

// 11. ОБРАБОТЧИКИ ОШИБОК
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', error => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// 12. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ТЕСТНЕТА
function generateTestnetKeys() {
  const keypair = Keypair.random();
  const keys = {
    secret: keypair.secret(),
    publicKey: keypair.publicKey(),
    network: Networks.TESTNET
  };
  
  logger.info('Generated testnet keys:', {
    publicKey: keys.publicKey,
    secret: keys.secret
  });
  
  return keys;
}

async function fundWithFriendbot(publicKey) {
  try {
    const friendbotUrl = 'https://friendbot.stellar.org';
    const response = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`);
    
    if (response.status === 200) {
      logger.info('Account funded successfully');
      return true;
    } else {
      const error = await response.json();
      logger.error('Failed to fund account:', error);
      return false;
    }
  } catch (error) {
    logger.error('Friendbot request failed:', error);
    return false;
  }
}

// 13. ОБРАБОТЧИК КОМАНДНОЙ СТРОКИ
async function handleCommandLineArgs() {
  const args = process.argv.slice(2);
  
  if (args.includes('--generate-keys')) {
    logger.info('Generating testnet keys...');
    const keys = generateTestnetKeys();
    logger.info(`Save these keys securely:\nSecret: ${keys.secret}\nPublic Key: ${keys.publicKey}`);
    process.exit(0);
  }
  
  if (args.includes('--fund-with-friendbot')) {
    const publicKeyIndex = args.indexOf('--fund-with-friendbot') + 1;
    if (publicKeyIndex >= args.length) {
      logger.error('Public key required for friendbot funding');
      process.exit(1);
    }
    
    const publicKey = args[publicKeyIndex];
    logger.info(`Funding account ${publicKey} with friendbot...`);
    const success = await fundWithFriendbot(publicKey);
    process.exit(success ? 0 : 1);
  }
}

// 14. ОСНОВНОЙ ЦИКЛ ЗАПУСКА
async function startTradingBot() {
  try {
    // Обработка командной строки
    await handleCommandLineArgs();
    
    // Основная логика бота
    const trader = new TradingEngine();
    const riskManager = new RiskManager();
    const healthMonitor = new HealthMonitor();
    
    // Инициализация начального баланса
    config.startingBalance = await riskManager.getPortfolioValue();
    
    // Синхронизация позиций
    await trader.syncOpenPositions();
    
    // Запуск основного цикла
    const runCycle = async () => {
      try {
        await trader.executeStrategy();
        await riskManager.adjustRiskParameters();
      } catch (error) {
        logger.error('Cycle error:', error);
      }
    };
    
    // Запуск циклов
    healthMonitor.startMonitoring();
    setInterval(runCycle, config.tradeInterval);
    
    logger.info('Trading bot started successfully');
    runCycle(); // Запуск первого цикла сразу
    
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

// ЗАПУСК БОТА
startTradingBot();
