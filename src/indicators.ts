export interface ATRResult {
  atr: number;
  atrPct: number;
  smoothed: number;
}

/**
 * Calculates Average True Range (ATR) using Wilder's smoothing.
 */
export function calculateATR(candles: any[], period = 14): ATRResult | null {
  if (!candles || candles.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const high = candles[i].high;
    const low = candles[i].low;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const smoothed = [atr];
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    smoothed.push(atr);
  }

  const latestCandle = candles[candles.length - 1];
  const price = latestCandle.close;
  const atrPct = price > 0 ? atr / price : 0;

  return { atr, atrPct, smoothed: smoothed[smoothed.length - 1] };
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

/**
 * Calculates Fibonacci Retracement levels from the absolute high and low of recent candles.
 */
export function calculateFibonacci(candles: any[]): FibonacciLevels | null {
  if (candles.length === 0) return null;
  
  let high = -Infinity;
  let low = Infinity;
  
  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  
  const diff = high - low;
  if (diff === 0) {
    return {
      high,
      low,
      level236: high,
      level382: high,
      level500: high,
      level618: high,
      level786: high
    };
  }

  return {
    high,
    low,
    level236: high - 0.236 * diff,
    level382: high - 0.382 * diff,
    level500: high - 0.500 * diff,
    level618: high - 0.618 * diff,
    level786: high - 0.786 * diff
  };
}

/**
 * Detects Fair Value Gaps (FVG) in a 3-candle sequence.
 * - Bullish FVG: Low of candle 3 > High of candle 1
 * - Bearish FVG: High of candle 3 < Low of candle 1
 */
export function calculateFVGs(candles: any[]): FVGZone[] {
  const fvgs: FVGZone[] = [];
  if (candles.length < 3) return fvgs;
  
  // Analyze from oldest to newest candles
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];
    
    // Bullish FVG: gap created by large bullish candle (c2)
    if (c3.low > c1.high && c2.close > c2.open) {
      // Check if any subsequent candles filled this gap
      let isFilled = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].low <= c1.high) {
          isFilled = true;
          break;
        }
      }
      
      fvgs.push({
        top: c3.low,
        bottom: c1.high,
        type: 'BULLISH',
        candleIndex: i - 1,
        isFilled
      });
    }
    // Bearish FVG: gap created by large bearish candle (c2)
    else if (c3.high < c1.low && c2.close < c2.open) {
      let isFilled = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].high >= c1.low) {
          isFilled = true;
          break;
        }
      }
      
      fvgs.push({
        top: c1.low,
        bottom: c3.high,
        type: 'BEARISH',
        candleIndex: i - 1,
        isFilled
      });
    }
  }
  
  return fvgs;
}

/**
 * Calculates Support & Resistance levels by identifying local peaks and troughs.
 * Filters and merges levels that are very close to each other.
 */
export function calculateSRLevels(candles: any[], period = 5, tolerancePct = 0.005): SRLevel[] {
  const rawLevels: SRLevel[] = [];
  if (candles.length < period * 2 + 1) return [];

  // 1. Find local swing highs (resistance) and swing lows (support)
  for (let i = period; i < candles.length - period; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;
    
    const currentHigh = candles[i].high;
    const currentLow = candles[i].low;
    
    for (let j = 1; j <= period; j++) {
      if (candles[i - j].high > currentHigh || candles[i + j].high > currentHigh) {
        isSwingHigh = false;
      }
      if (candles[i - j].low < currentLow || candles[i + j].low < currentLow) {
        isSwingLow = false;
      }
    }
    
    if (isSwingHigh) {
      rawLevels.push({ price: currentHigh, type: 'RESISTANCE', strength: 1 });
    }
    if (isSwingLow) {
      rawLevels.push({ price: currentLow, type: 'SUPPORT', strength: 1 });
    }
  }

  // 2. Group/Merge levels that are within tolerance percentage of each other
  const mergedLevels: SRLevel[] = [];
  
  for (const level of rawLevels) {
    let foundNear = false;
    for (const merged of mergedLevels) {
      const priceDiffPct = Math.abs(merged.price - level.price) / merged.price;
      if (priceDiffPct <= tolerancePct && merged.type === level.type) {
        // Average the price and increment strength
        merged.price = (merged.price * merged.strength + level.price) / (merged.strength + 1);
        merged.strength += 1;
        foundNear = true;
        break;
      }
    }
    if (!foundNear) {
      mergedLevels.push({ ...level });
    }
  }
  
  // Sort levels by price ascending
  return mergedLevels.sort((a, b) => a.price - b.price);
}

/**
 * Calculates Point of Control (POC) / Volume Profile
 * dividing the price range into bins and returning the price bin center with the highest cumulative volume.
 */
export function calculatePOC(candles: any[], binsCount = 20): number {
  if (candles.length === 0) return 0;
  
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  
  for (const c of candles) {
    if (c.low < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
  }
  
  const range = maxPrice - minPrice;
  if (range === 0) return minPrice;
  
  const binSize = range / binsCount;
  const binsVolume = new Array(binsCount).fill(0);
  
  for (const c of candles) {
    // Distribute volume into bins that cover the candle's high-low range
    const candleMin = c.low;
    const candleMax = c.high;
    
    const startBin = Math.max(0, Math.floor((candleMin - minPrice) / binSize));
    const endBin = Math.min(binsCount - 1, Math.floor((candleMax - minPrice) / binSize));
    
    // Spread volume equally across spanned bins
    const spannedBinsCount = (endBin - startBin) + 1;
    const volumePerBin = c.volume / spannedBinsCount;
    
    for (let b = startBin; b <= endBin; b++) {
      binsVolume[b] += volumePerBin;
    }
  }
  
  // Find bin with highest volume
  let maxVolume = -1;
  let pocBinIndex = 0;
  for (let i = 0; i < binsCount; i++) {
    if (binsVolume[i] > maxVolume) {
      maxVolume = binsVolume[i];
      pocBinIndex = i;
    }
  }
  
  // Return the center price of the POC bin
  return minPrice + (pocBinIndex + 0.5) * binSize;
}
