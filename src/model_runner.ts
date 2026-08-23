import { CONFIG } from './config.js';
import { StrategyManager } from './strategy.js';
import { ExecutionEngine } from './execution.js';
import { TradeMemory } from './trade_memory.js';
import { TradeDatabase } from './database.js';
import { OrderBook, TradeSignal } from './types.js';
import { IExchangeConnector } from './exchange.interface.js';
import { NvidiaObserver, NvidiaObserverResponse } from './nvidia.js';
import { circuitBreaker } from './circuit_breaker.js';
import { SmartOrderRouter } from './smart_order_routing.js';
import { logger } from './logger.js';

export interface ModelRunnerOptions {
  exchange: IExchangeConnector;
  tradeMemory: TradeMemory;
  database: TradeDatabase;
  nvidiaObserver: NvidiaObserver;
  smartOrderRouter: SmartOrderRouter;
  onSignal?: (signal: TradeSignal) => Promise<void> | void;
  onMetricsUpdate?: (metrics: Record<string, any>) => void;
}

export class ModelRunner {
  public readonly id: string;
  public readonly strategy: StrategyManager;
  public readonly execution: ExecutionEngine;
  public readonly database: TradeDatabase;
  public readonly tradeMemory: TradeMemory;

  private readonly exchange: IExchangeConnector;
  private readonly nvidiaObserver: NvidiaObserver;
  private readonly smartOrderRouter: SmartOrderRouter;
  private readonly onSignal?: ModelRunnerOptions['onSignal'];
  private readonly onMetricsUpdate?: ModelRunnerOptions['onMetricsUpdate'];

  private aiInsights: Record<string, any> = {};
  private optimizationTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(id: string, options: ModelRunnerOptions) {
    this.id = id;
    this.exchange = options.exchange;
    this.nvidiaObserver = options.nvidiaObserver;
    this.smartOrderRouter = options.smartOrderRouter;
    this.onSignal = options.onSignal;
    this.onMetricsUpdate = options.onMetricsUpdate;

    this.tradeMemory = options.tradeMemory;
    this.database = options.database;
    this.strategy = new StrategyManager();
    this.execution = new ExecutionEngine(id, this.exchange, this.tradeMemory, this.database);
    // Wire fine-tuned per-symbol TP/SL overrides into the execution engine
    this.execution.setParamProvider((sym) => {
      const p = this.strategy.getSymbolEffectiveParams(sym);
      return { takeProfitPct: p.takeProfitPct, stopLossPct: p.stopLossPct };
    });

    this.loadActivePositions();
  }

  private loadActivePositions() {
    const saved = this.database.getAllActivePositions();
    if (saved.length > 0) {
      logger.info(`[${this.id}] Restored ${saved.length} active positions from database`);
    }
  }

  public processTick(book: OrderBook) {
    if (this.disposed) return;
    try {
      this.execution.evaluatePositions(book.symbol, book.bids[0][0], book.asks[0][0]);
      const signal = this.strategy.processTick(book);
      if (signal) {
        const entryCondition = this.smartOrderRouter.isGoodEntryCondition(signal.symbol, signal.side, book);
        if (!entryCondition.allowed) {
          logger.debug(`[${this.id}] [SOR] Skipping ${signal.symbol} ${signal.side}: ${entryCondition.reason}`);
          return;
        }
        logger.info(`[${this.id}] [SIGNAL] ${signal.symbol} | ${signal.side} | ${signal.reason}`);
        void this.executeSignal(signal, book);
      }
    } catch (err: any) {
      logger.error(`[${this.id}] Tick processing error: ${err.message}`);
    }
  }

  private async executeSignal(signal: TradeSignal, book: OrderBook) {
    if (!this.execution.riskManager.isTradingAllowed()) {
      logger.warn(`[${this.id}] Trading paused by RiskManager. Skipping ${signal.symbol} ${signal.side}.`);
      return;
    }

    await this.execution.executeSignal(signal);
    for (const pos of this.execution.getActivePositions().filter(p => p.symbol === signal.symbol)) {
      this.database.savePosition(pos);
    }
    this.emitMetrics();

    if (this.onSignal) {
      try { await this.onSignal(signal); } catch {}
    }
  }

  public async runParameterOptimization(activeSymbols: string[], candleData: Record<string, Record<string, any[]>>, dominance: { btcDom: number; usdtDom: number }, calculatedIndicators: Record<string, any>) {
    if (this.disposed) return;
    if (!CONFIG.AI_OPTIMIZER_ENABLED) return;

    for (const symbol of activeSymbols) {
      const h1 = candleData[symbol]?.['1h'] || [];
      if (h1.length > 0) {
        // indicators are cached in strategy on orchestrator level
      }
    }

    try {
      const currentParams = this.strategy.getAllParams();
      const optimized = await circuitBreaker.call(
        'nvidia_api',
        () => this.nvidiaObserver.optimizeParameters(
          this.execution.getStats(),
          this.execution.getTradesHistory(),
          activeSymbols,
          candleData,
          this.id,
          currentParams,
          calculatedIndicators,
          dominance
        ),
        () => null
      );

      if (optimized && optimized.parameters) {
        this.aiInsights = optimized.analysis || {};
        this.strategy.setAiBiases(this.aiInsights);
        for (const [symbol, params] of Object.entries(optimized.parameters)) {
          if (params) {
            this.strategy.updateParams(symbol, params);
            logger.info(`[${this.id}] Applied optimized params for ${symbol}`);
          }
        }
        if (this.onMetricsUpdate) {
          this.onMetricsUpdate({ aiInsights: this.aiInsights });
        }
      }
    } catch (err: any) {
      logger.error(`[${this.id}] Parameter optimization failed: ${err.message}`);
    }
  }

  public getMetrics() {
    return {
      stats: this.execution.getStats(),
      activePositions: this.execution.getActivePositions(),
      tradesHistory: this.execution.getTradesHistory(),
      aiInsights: this.aiInsights,
      riskMetrics: this.execution.riskManager.getLatestMetrics(this.execution.getTradesHistory()),
      equityCurve: this.execution.riskManager.getEquityCurve(),
      performanceAttribution: this.execution.riskManager.getPerformanceAttribution(),
      dailyDrawdown: this.execution.riskManager.getDailyDrawdownPct(),
      consecutiveLosses: this.execution.riskManager.getConsecutiveLosses(),
      isPaused: this.execution.riskManager.getIsPaused(),
      tradingSession: this.execution.riskManager.getTradingSession(),
    };
  }

  public emitMetrics() {
    if (this.onMetricsUpdate) {
      try {
        this.onMetricsUpdate(this.getMetrics());
      } catch {}
    }
  }

  public forceClosePosition(symbol: string, exitPrice: number, reason: string) {
    this.execution.forceClosePosition(symbol, exitPrice, reason);
    this.emitMetrics();
  }

  public dispose() {
    this.disposed = true;
    if (this.optimizationTimer) clearTimeout(this.optimizationTimer);
  }
}
