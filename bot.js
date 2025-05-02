require('dotenv').config();
const { Server, Keypair, Asset, TransactionBuilder, Operation, Networks } = require('@stellar/stellar-sdk');
const winston = require('winston');
const { format, transports } = winston;
const { combine, timestamp, printf } = format;
const indicators = require('technicalindicators');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const DailyRotateFile = require('winston-daily-rotate-file');

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
  candleLimit: 100
};

// 3. ИНИЦИАЛИЗАЦИЯ STELLAR SDK
const server = new Server(config.horizonUrl, {
  allowHttp: config.horizonUrl.includes('testnet')
});
const accountKeypair = Keypair.fromSecret(config.secretKey);
const baseAsset = new Asset(config.baseAssetCode, config.issuerAddress);
const counterAsset = Asset.native(); // XLM

// 4. БАЗА ДАННЫХ
const db = new sqlite3.Database(path.join(__dirname, 'trading.db'), err => {
  if (err) logger.error('DB error:', err.message);
  else logger.info('Connected to SQLite');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_price REAL,
    position_size REAL,
    direction TEXT,
    stop_loss REAL,
    take_profit REAL,
    trailing_stop REAL,
    opened_at DATETIME,
    closed_at DATETIME
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    type TEXT,
    price REAL,
    amount REAL,
    status TEXT,
    created_at DATETIME,
    updated_at DATETIME
  )`);
});

// 5. КЛАСС УПРАВЛЕНИЯ РИСКАМИ
class RiskManager {
  constructor() {
    this.volatilityWindow = 14;
    this.startingBalance = 0;
  }

  async calculatePositionSize(entryPrice, stopLossPrice) {
    try {
      const account = await server.loadAccount(accountKeypair.publicKey());
      const balance = account.balances.find(b => b.asset_type === 'native').balance;
      const portfolioValue = parseFloat(balance);
      
      // Рассчитываем риск на сделку
      const riskAmount = portfolioValue * config.riskPerTrade;
      
      // Рассчитываем волатильность
      const candles = await getCandleData();
      const atr = this.calculateATR(candles);
      
      // Размер позиции с учетом волатильности
      const priceDistance = Math.abs(entryPrice - stopLossPrice);
      const positionSize = (riskAmount / priceDistance) * (1 - atr/entryPrice);

      return Math.min(positionSize, portfolioValue * 0.2); // Макс 20% портфеля
    } catch (error) {
      logger.error('Risk calculation failed:', error);
      return 0;
    }
  }

  async adjustRiskParameters() {
    const portfolioValue = await this.getPortfolioValue();
    const drawdown = await this.calculateDrawdown();
    
    // Динамическое уменьшение риска при просадках
    if (drawdown > 0.1) {
      config.riskPerTrade = Math.max(0.01, config.riskPerTrade * 0.8);
    }
    
    // Увеличение риска при стабильной прибыли
    if (portfolioValue > this.startingBalance * 1.2) {
      config.riskPerTrade = Math.min(0.05, config.riskPerTrade * 1.1);
    }
  }

  // Вспомогательные методы...
}

// 6. ТОРГОВЫЙ ДВИЖОК
class TradingEngine {
  constructor() {
    this.activePositions = [];
    this.pendingOrders = [];
  }

  async executeStrategy() {
    try {
      // 1. Получение рыночных данных
      const candles = await getCandleData();
      if (candles.length < 20) {
        logger.warn('Not enough data for analysis');
        return;
      }

      // 2. Расчет индикаторов
      const { ma, rsi, macd } = calculateIndicators(candles);
      
      // 3. Генерация сигналов
      const lastClose = candles[candles.length-1].price;
      const signal = this.generateSignal(lastClose, ma, rsi, macd);
      
      // 4. Управление риском
      const riskManager = new RiskManager();
      await riskManager.adjustRiskParameters();
      
      // 5. Исполнение сделок
      if (signal === 'BUY') {
        await this.executeBuy(lastClose);
      } else if (signal === 'SELL') {
        await this.executeSell(lastClose);
      }

      // 6. Мониторинг позиций
      await this.monitorPositions(lastClose);

    } catch (error) {
      logger.error('Strategy error:', error.message);
    }
  }

  // Реализация трейлинг-стопа
  async updateTrailingStop(position, currentPrice) {
    const offset = currentPrice * (config.trailingStopOffset/100);
    
    if (position.direction === 'LONG') {
      const newStop = currentPrice - offset;
      if (newStop > position.stop_loss) {
        await this.updateOrder(position.stop_loss_id, newStop);
        position.stop_loss = newStop;
      }
    } else {
      const newStop = currentPrice + offset;
      if (newStop < position.stop_loss) {
        await this.updateOrder(position.stop_loss_id, newStop);
        position.stop_loss = newStop;
      }
    }
  }

  // Методы исполнения ордеров...
}

// 7. СЛОЖНЫЕ ПРАВИЛА УПРАВЛЕНИЯ КАПИТАЛОМ
class KellyCalculator {
  calculate(winRate, avgWin, avgLoss) {
    const winRatio = avgWin / avgLoss;
    return winRate - ((1 - winRate) / winRatio);
  }
}

// 8. ЗАПУСК СИСТЕМЫ
(async () => {
  try {
    // Инициализация компонентов
    const trader = new TradingEngine();
    const riskManager = new RiskManager();

    // Основной цикл
    const runCycle = async () => {
      await trader.executeStrategy();
      await riskManager.adjustRiskParameters();
      setTimeout(runCycle, config.tradeInterval);
    };

    // Первоначальная синхронизация
    await trader.syncOpenPositions();
    runCycle();

  } catch (error) {
    logger.error('Fatal error:', error.message);
    process.exit(1);
  }
})();

// 9. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
async function getCandleData() {
  try {
    const response = await server.trades()
      .forAssetPair(baseAsset, counterAsset)
      .limit(config.candleLimit)
      .call();
    
    return response.records.map(record => ({
      price: parseFloat(record.price),
      high: parseFloat(record.high),
      low: parseFloat(record.low),
      volume: parseFloat(record.volume),
      time: record.ledger_close_time
    }));
  } catch (error) {
    logger.error('Failed to get candles:', error.message);
    return [];
  }
}

function calculateIndicators(candles) {
  const closes = candles.map(c => c.price);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

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
      values: closes.map((c, i) => ({
        high: highs[i],
        low: lows[i],
        close: c
      })),
      period: 14
    })
  };
}
