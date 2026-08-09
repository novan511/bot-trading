/**
 * Market Regime Detection Module
 * 
 * Identifies current market conditions:
 * - Trending Bull / Trending Bear
 * - Ranging / Sideways 
 * - High Volatility / Low Volatility
 * 
 * Uses EMA slope, ATR, and price action analysis
 */

import { CONFIG } from './config.js';
import { MarketRegime } from './types.js';

export class MarketRegimeDetector {
  // EMA slopes for trend detection per symbol
  private emaValues: Map<string, number> = new Map();
  private emaSlopes: Map<string, number> = new Map();
  private atrValues: Map<string, number> = new Map();
  private priceHistory: Map<string, number[]> = new Map();
  
  // Regime cache
  private currentRegime: Map<string, MarketRegime> = new Map();

  constructor() {}

  /**
   * Process a mid-price tick to update regime indicators
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
   * Determine current market regime for a symbol
   */
  public detectRegime(symbol: string): MarketRegime {
    const prices = this.priceHistory.get(symbol);
    const atr = this.atrValues.get(symbol);
    const slope = this.emaSlopes.get(symbol);

    if (!prices || prices.length < 20) {
      return 'LOW_VOLATILITY'; // Default when not enough data
    }

    // 1. Check volatility
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const atrPct = atr ? atr / avgPrice : 0;
    const isHighVol = atrPct > 0.005; // 0.5% ATR relative to price
    const isLowVol = atrPct < 0.001; // 0.1% ATR relative to price

    // 2. Check trend strength
    // Count how many consecutive closes are above/below EMA
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
   * Get trend direction
   */
  public getTrendDirection(symbol: string): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const regime = this.currentRegime.get(symbol);
    if (regime === 'TRENDING_BULL') return 'BULLISH';
    if (regime === 'TRENDING_BEAR') return 'BEARISH';
    return 'NEUTRAL';
  }

  /**
   * Get current ATR value for position sizing
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
        return {
          obiMultiplier: 0.7,
          zScoreMultiplier: 0.7,
          tpMultiplier: 1.5,
          slMultiplier: 0.8,
          confidenceBoost: 1.3
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
   * Get current regime description for UI/debugging
   */
  public getRegimeDebugInfo(symbol: string): { regime: MarketRegime; atrPct: number; slope: number } | null {
    const regime = this.currentRegime.get(symbol);
    if (!regime) return null;
    const prices = this.priceHistory.get(symbol) || [];
    const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    const atr = this.getATR(symbol);
    const slope = this.getEMASlope(symbol);
    return {
      regime,
      atrPct: avgPrice > 0 ? atr / avgPrice : 0,
      slope
    };
  }
}
