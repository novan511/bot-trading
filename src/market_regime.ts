/**
 * Market Regime Detection Module — v2 (candle-based)
 *
 * Identifies current market conditions from REAL multi-timeframe candles:
 * - Macro trend   : 1d + 4h EMA20/EMA50 structure (both must agree for TRENDING_*)
 * - Micro regime  : ATR(14) on 15m candles classifies chaos vs dead vs orderly range
 *
 * Regime semantics (routed by StrategyManager):
 * - TRENDING_BULL    : long-only (buy-the-dip)
 * - TRENDING_BEAR    : short-only (sell-the-rip)
 * - RANGING          : two-way mean reversion, tight targets
 * - HIGH_VOLATILITY  : NO TRADE (chaos guard — fires even inside a macro trend)
 * - LOW_VOLATILITY   : NO TRADE (dead market)
 *
 * The legacy tick-based detector is kept as a DEGRADED fallback for the startup
 * window before candle data arrives (or if candle refreshes fail) so the bot
 * never freezes; it logs its source via getRegimeDebugInfo().
 */

import { CONFIG } from './config.js';
import { MarketRegime } from './types.js';
import { calculateATR } from './indicators.js';

interface CandleRegimeState {
  regime: MarketRegime;
  macroTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  dailyTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  h4Trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  atrPctMicro: number;
  updatedAt: number;
}

/** Last EMA value of a close series (null when insufficient data). */
function emaLast(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

type Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

/**
 * Trend structure of ONE timeframe: EMA fast/slow alignment + price position.
 */
function timeframeTrend(candles: any[]): Trend {
  if (!candles || candles.length < CONFIG.REGIME_MIN_CANDLES_MACRO) return 'NEUTRAL';
  const closes = candles.map(c => c.close);
  const emaFast = emaLast(closes, CONFIG.REGIME_MACRO_EMA_FAST);
  const emaSlow = emaLast(closes, CONFIG.REGIME_MACRO_EMA_SLOW);
  if (emaFast === null || emaSlow === null) return 'NEUTRAL';

  // EMA slope check: fast EMA rising/falling vs its value 3 candles ago
  const emaFastPrev = emaLast(closes.slice(0, -3), CONFIG.REGIME_MACRO_EMA_FAST);
  const lastClose = closes[closes.length - 1];

  if (emaFast > emaSlow && lastClose >= emaFast && (emaFastPrev === null || emaFast >= emaFastPrev)) return 'BULLISH';
  if (emaFast < emaSlow && lastClose <= emaFast && (emaFastPrev === null || emaFast <= emaFastPrev)) return 'BEARISH';
  return 'NEUTRAL';
}

export class MarketRegimeDetector {
  // Tick-based state (fallback + sizing ATR — sizing intentionally unchanged)
  private emaValues: Map<string, number> = new Map();
  private emaSlopes: Map<string, number> = new Map();
  private atrValues: Map<string, number> = new Map();
  private priceHistory: Map<string, number[]> = new Map();

  // Regime caches
  private currentRegime: Map<string, MarketRegime> = new Map();
  private candleState: Map<string, CandleRegimeState> = new Map();
  private lastLoggedRegime: Map<string, MarketRegime> = new Map();

  constructor() {}

  /**
   * Feed multi-timeframe candles (called every optimization cycle from main.ts).
   * Recomputes the authoritative candle-based regime for this symbol.
   */
  public updateCandleContext(symbol: string, candles: { d1: any[]; h4: any[]; m15: any[] }): void {
    if (!candles.d1?.length && !candles.h4?.length && !candles.m15?.length) return;

    const dailyTrend = timeframeTrend(candles.d1);
    const h4Trend = timeframeTrend(candles.h4);

    // Macro requires BOTH timeframes to agree — disagreement means structure is mixed
    const macroTrend: Trend =
      dailyTrend === 'BULLISH' && h4Trend === 'BULLISH' ? 'BULLISH' :
      dailyTrend === 'BEARISH' && h4Trend === 'BEARISH' ? 'BEARISH' : 'NEUTRAL';

    let atrPctMicro = NaN;
    if (candles.m15 && candles.m15.length >= CONFIG.REGIME_MIN_CANDLES_MICRO) {
      const atr = calculateATR(candles.m15, 14);
      if (atr) atrPctMicro = atr.atrPct;
    }

    const extremeVol = isFinite(atrPctMicro) && atrPctMicro > CONFIG.REGIME_MICRO_HIGH_VOL_ATR_PCT;
    const deadVol = isFinite(atrPctMicro) && atrPctMicro < CONFIG.REGIME_MICRO_LOW_VOL_ATR_PCT;

    let regime: MarketRegime;
    // Volatility defines TRADABILITY first, trend defines DIRECTION second:
    // chaos = no-trade, dead = no-trade (moves too small to clear costs),
    // then trend direction decides long-only vs short-only, else orderly range.
    if (extremeVol) {
      regime = 'HIGH_VOLATILITY';
    } else if (deadVol) {
      regime = 'LOW_VOLATILITY';
    } else if (macroTrend === 'BULLISH') {
      regime = 'TRENDING_BULL';
    } else if (macroTrend === 'BEARISH') {
      regime = 'TRENDING_BEAR';
    } else {
      regime = 'RANGING';
    }

    const prev = this.candleState.get(symbol);
    this.candleState.set(symbol, {
      regime,
      macroTrend,
      dailyTrend,
      h4Trend,
      atrPctMicro,
      updatedAt: Date.now()
    });

    // Surface regime transitions once per change (not per tick)
    if (prev?.regime !== regime && this.lastLoggedRegime.get(symbol) !== regime) {
      this.lastLoggedRegime.set(symbol, regime);
      console.log(`\x1b[33m[REGIME-V2] ${symbol}: ${prev?.regime || '-'} -> ${regime} | macro=${macroTrend} (1d:${dailyTrend}/4h:${h4Trend}) atr15m=${isFinite(atrPctMicro) ? (atrPctMicro * 100).toFixed(2) + '%' : 'n/a'}\x1b[0m`);
    }
  }

  /** Candle-based regime wins while fresh; otherwise degraded tick-based fallback. */
  public detectRegime(symbol: string): MarketRegime {
    const cs = this.candleState.get(symbol);
    if (cs && Date.now() - cs.updatedAt < CONFIG.REGIME_CANDLE_MAX_AGE_MS) {
      this.currentRegime.set(symbol, cs.regime);
      return cs.regime;
    }
    return this.detectRegimeFromTicks(symbol);
  }

  /**
   * LEGACY tick-based detection (50 WS ticks). Kept as degraded fallback only —
   * it labels micro pullbacks as "trends" and must not be trusted structurally.
   */
  private detectRegimeFromTicks(symbol: string): MarketRegime {
    const prices = this.priceHistory.get(symbol);
    const atr = this.atrValues.get(symbol);
    const slope = this.emaSlopes.get(symbol);

    if (!prices || prices.length < 20) {
      this.currentRegime.set(symbol, 'LOW_VOLATILITY');
      return 'LOW_VOLATILITY'; // Default when not enough data
    }

    // 1. Check volatility
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const atrPct = atr ? atr / avgPrice : 0;
    const isHighVol = atrPct > 0.005; // 0.5% ATR relative to price
    const isLowVol = atrPct < 0.001; // 0.1% ATR relative to price

    // 2. Check trend strength
    const ema = this.emaValues.get(symbol);
    const recentPrices = prices.slice(-10);

    let aboveCount = 0;
    let belowCount = 0;

    for (const p of recentPrices) {
      if (ema && p > ema) aboveCount++;
      else if (ema && p < ema) belowCount++;
    }

    const trendStrength = Math.abs(aboveCount - belowCount) / recentPrices.length;
    const isStrongTrend = trendStrength >= CONFIG.REGIME_TREND_STRENGTH_THRESHOLD;

    // 3. Determine regime
    let regime: MarketRegime;

    if (isStrongTrend && slope) {
      if (slope > 0 && aboveCount > belowCount) {
        regime = isHighVol ? 'HIGH_VOLATILITY' : 'TRENDING_BULL';
      } else if (slope < 0 && belowCount > aboveCount) {
        regime = isHighVol ? 'HIGH_VOLATILITY' : 'TRENDING_BEAR';
      } else {
        regime = isHighVol ? 'HIGH_VOLATILITY' : 'RANGING';
      }
    } else {
      if (isHighVol) regime = 'HIGH_VOLATILITY';
      else if (isLowVol) regime = 'LOW_VOLATILITY';
      else regime = 'RANGING';
    }

    this.currentRegime.set(symbol, regime);
    return regime;
  }

  /**
   * Regime routing table — which sides may fire.
   * TRENDING_BULL: long-only | TRENDING_BEAR: short-only |
   * RANGING: two-way MR | HIGH/LOW volatility: stand aside entirely.
   */
  public getAllowedSides(regime: MarketRegime): { allowLong: boolean; allowShort: boolean } {
    switch (regime) {
      case 'TRENDING_BULL': return { allowLong: true, allowShort: false };
      case 'TRENDING_BEAR': return { allowLong: false, allowShort: true };
      case 'RANGING': return { allowLong: true, allowShort: true };
      case 'HIGH_VOLATILITY':
      case 'LOW_VOLATILITY':
      default: return { allowLong: false, allowShort: false };
    }
  }

  /**
   * Get trend direction
   */
  public getTrendDirection(symbol: string): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const regime = this.currentRegime.get(symbol);
    if (regime === 'TRENDING_BULL') return 'BULLISH';
    if (regime === 'TRENDING_BEAR') return 'BEARISH';
    return 'NEUTRAL';
  }

  /**
   * Process a mid-price tick to update fallback indicators + sizing ATR
   */
  public processPrice(symbol: string, midPrice: number) {
    // 1. Update price history
    if (!this.priceHistory.has(symbol)) {
      this.priceHistory.set(symbol, []);
    }
    const prices = this.priceHistory.get(symbol)!;
    prices.push(midPrice);
    if (prices.length > CONFIG.REGIME_LOOKBACK_CANDLES) {
      prices.shift();
    }

    // 2. Update EMA
    const emaPeriod = CONFIG.REGIME_EMA_PERIOD;
    const k = 2 / (emaPeriod + 1);
    const currentEma = this.emaValues.get(symbol);

    if (currentEma === undefined) {
      this.emaValues.set(symbol, midPrice);
    } else {
      const newEma = midPrice * k + currentEma * (1 - k);
      this.emaValues.set(symbol, newEma);

      // 3. Calculate EMA slope (rate of change)
      const prevEma = currentEma;
      const slope = (newEma - prevEma) / prevEma;
      this.emaSlopes.set(symbol, slope);
    }

    // 4. Calculate ATR (simplified)
    if (prices.length >= 2) {
      const atrPeriod = CONFIG.ATR_PERIOD;
      const recentPrices = prices.slice(-atrPeriod);

      if (recentPrices.length >= 2) {
        let totalRange = 0;
        for (let i = 1; i < recentPrices.length; i++) {
          totalRange += Math.abs(recentPrices[i] - recentPrices[i - 1]);
        }
        const atr = totalRange / (recentPrices.length - 1);
        this.atrValues.set(symbol, atr);
      }
    }
  }

  /**
   * Get current ATR value for position sizing (tick-based — intentionally untouched:
   * RiskManager sizing calibration depends on these units)
   */
  public getATR(symbol: string): number {
    const val = this.atrValues.get(symbol) || 0;
    if (val === 0) {
      console.log(`\x1b[90m[ATR] ${symbol}: 0 (insufficient price history)\x1b[0m`);
    }
    return val;
  }

  /**
   * Get EMA slope for momentum confirmation
   */
  public getEMASlope(symbol: string): number {
    return this.emaSlopes.get(symbol) || 0;
  }

  /**
   * Check if market is ranging (good for mean reversion)
   */
  public isRanging(symbol: string): boolean {
    const regime = this.currentRegime.get(symbol);
    return regime === 'RANGING';
  }

  /**
   * Check if market is trending (good for momentum)
   */
  public isTrending(symbol: string): boolean {
    const regime = this.currentRegime.get(symbol);
    return regime === 'TRENDING_BULL' || regime === 'TRENDING_BEAR';
  }

  /**
   * Get regime-adaptive parameter multipliers.
   * Used by StrategyManager to adjust thresholds dynamically.
   */
  public getRegimeMultipliers(symbol: string): {
    obiMultiplier: number;
    zScoreMultiplier: number;
    tpMultiplier: number;
    slMultiplier: number;
    confidenceBoost: number;
  } {
    const regime = this.currentRegime.get(symbol);
    const atr = this.getATR(symbol);
    const history = this.priceHistory.get(symbol) || [];
    const recentSlice = history.slice(-20);
    const avgPrice = recentSlice.length > 0 ? recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length : 1;
    const atrPct = atr / avgPrice;

    switch (regime) {
      case 'TRENDING_BULL':
      case 'TRENDING_BEAR':
        return {
          obiMultiplier: 0.8,
          zScoreMultiplier: 0.8,
          tpMultiplier: 1.3,
          slMultiplier: 0.9,
          confidenceBoost: 1.2
        };
      case 'RANGING':
        return {
          obiMultiplier: 1.2,
          zScoreMultiplier: 1.2,
          tpMultiplier: 0.8,
          slMultiplier: 1.1,
          confidenceBoost: 1.0
        };
      case 'HIGH_VOLATILITY':
        return {
          obiMultiplier: 1.4,
          zScoreMultiplier: 1.5,
          tpMultiplier: 0.7,
          slMultiplier: 1.4,
          confidenceBoost: 0.8
        };
      case 'LOW_VOLATILITY':
        // FIXED (was backwards): dead markets are noise-dominated, so entries must be
        // HARDER not easier, targets CLOSER not further. Historical evidence: old
        // loosening produced WR 75% but payoff 0.24 and net losses (scratch city).
        // Routing blocks trading here entirely anyway — these are defense in depth.
        return {
          obiMultiplier: 1.4,
          zScoreMultiplier: 1.5,
          tpMultiplier: 0.7,
          slMultiplier: 1.1,
          confidenceBoost: 0.7
        };
      default:
        return {
          obiMultiplier: 1.0,
          zScoreMultiplier: 1.0,
          tpMultiplier: 1.0,
          slMultiplier: 1.0,
          confidenceBoost: 1.0
        };
    }
  }

  /**
   * Get regime description for UI/debugging, including data source transparency
   */
  public getRegimeDebugInfo(symbol: string): { regime: MarketRegime; atrPct: number; slope: number; source: 'candles' | 'ticks'; macroTrend?: string } | null {
    const regime = this.currentRegime.get(symbol);
    if (!regime) return null;
    const prices = this.priceHistory.get(symbol) || [];
    const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    const atr = this.getATR(symbol);
    const slope = this.getEMASlope(symbol);
    const cs = this.candleState.get(symbol);
    const fresh = cs && Date.now() - cs.updatedAt < CONFIG.REGIME_CANDLE_MAX_AGE_MS;
    return {
      regime,
      atrPct: avgPrice > 0 ? atr / avgPrice : 0,
      slope,
      source: fresh ? 'candles' : 'ticks',
      macroTrend: fresh ? cs!.macroTrend : undefined
    };
  }
}
