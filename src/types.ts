export type Side = 'BUY' | 'SELL';

export interface OrderBook {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  updatedAt: number;
}

export interface TradeTick {
  symbol: string;
  price: number;
  quantity: number;
  side: Side;
  timestamp: number;
}

export interface CandleSnapshot {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickData {
  symbol: string;
  midPrice: number;
  microPrice: number;
  obi: number;
  timestamp: number;
}

export interface TradeSignal {
  symbol: string;
  side: Side;
  price: number;
  reason: string;
  confidence: 'HIGH' | 'LOW';
  atr?: number;
}

export interface PartialTPLevel {
  pct: number;
  targetPx: number;
  isTriggered: boolean;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  highestPrice?: number;
  lowestPrice?: number;
  entryReason?: string;
  isTakeProfitTriggered?: boolean;
  modelId?: string;
  partialTPs?: PartialTPLevel[];
  remainingQty?: number;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryTime: number;
  exitTime: number;
  holdTimeSec: number;
  grossProfitUsd: number;
  feesUsd: number;
  netProfitUsd: number;
  result: 'WIN' | 'LOSS' | 'BREAKEVEN';
  entryReason?: string;
  modelId?: string;
  exitReason?: string;
  partialCloses?: { qty: number; price: number; time: number }[];
}

export interface ExecutionStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  grossProfitUsd: number;
  totalFeesUsd: number;
  netProfitUsd: number;
  averageHoldTimeSec: number;
}

export type MarketRegime = 'TRENDING_BULL' | 'TRENDING_BEAR' | 'RANGING' | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY';

export type TradingSession = 'ASIAN' | 'LONDON' | 'NEW_YORK' | 'OVERLAP' | 'OFF_HOURS';

export interface LiquiditySweepSignal {
  symbol: string;
  side: Side;
  price: number;
  reason: string;
}

export interface OrderFlowState {
  bidVolume: number;
  askVolume: number;
  totalTrades: number;
  cvd: number;
}

export interface VWAPData {
  price: number;
  upperBand: number;
  lowerBand: number;
}

export interface VolumeProfile {
  poc: number;
  vah: number;
  val: number;
}

export interface PairsSignal {
  longSymbol: string;
  shortSymbol: string;
  zScore: number;
  reason: string;
}

export interface PerformanceAttribution {
  symbol: string;
  totalTrades: number;
  winRate: number;
  netProfitUsd: number;
  profitFactor: number;
  sharpeRatio: number;
  avgReturnPerTrade: number;
  maxDrawdown: number;
}

export interface ExecutionPlan {
  slices: ExecutionSlice[];
  totalQty: number;
  expectedAvgPrice: number;
  estimatedSlippage: number;
  durationMs: number;
}

export interface ExecutionSlice {
  qty: number;
  price: number;
  delayMs: number;
}

export interface ExecutionResult {
  success: boolean;
  avgPrice: number;
  totalFilled: number;
  totalFees: number;
  slippagePct: number;
  slices: { price: number; qty: number; time: number }[];
  reason?: string;
}

export interface RiskMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  var95: number;
  expectedShortfall: number;
  consecutiveLosses: number;
  avgWin: number;
  avgLoss: number;
  avgWinLossRatio: number;
  expectancy: number;
  riskOfRuin: number;
  ulcerIndex: number;
}

export interface SymbolOptimizedParams {
  obiThreshold: number;
  zScoreThreshold: number;
  takeProfitPct: number;
  stopLossPct: number;
}

export interface SymbolAnalysis {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  rationale: string;
  current_thoughts?: string;
  planned_action?: string;
  waiting_for?: string;
  post_algorithm_thoughts?: string;
}

export interface NvidiaObserverResponse {
  parameters: Record<string, SymbolOptimizedParams>;
  analysis: Record<string, SymbolAnalysis>;
}

export interface FibonacciLevels {
  high: number;
  low: number;
  level236: number;
  level382: number;
  level500: number;
  level618: number;
  level786: number;
}

export interface FVGZone {
  top: number;
  bottom: number;
  type: 'BULLISH' | 'BEARISH';
  candleIndex: number;
  isFilled: boolean;
}

export interface SRLevel {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  strength: number;
}
