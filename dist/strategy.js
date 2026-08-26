import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { MarketMicrostructure } from './market_microstructure.js';
import { MarketRegimeDetector } from './market_regime.js';
import { PairsTrader } from './pairs_trading.js';
export class StrategyManager {
    states = new Map();
    aiBiases = {};
    macroTrends = {};
    indicatorsCache = {};
    // NEW: Advanced modules
    marketMicro;
    marketRegime;
    pairsTrader;
    setAiBiases(biases) {
        this.aiBiases = {};
        for (const [symbol, info] of Object.entries(biases)) {
            if (info && info.bias) {
                this.aiBiases[symbol] = info.bias;
            }
        }
    }
    setMacroTrends(trends) {
        this.macroTrends = trends;
    }
    /**
     * Caches premium technical indicators fetched from candle multi-timeframe analysis
     */
    setCalculatedIndicators(symbol, indicators) {
        this.indicatorsCache[symbol] = indicators;
    }
    /**
     * Compact multi-label tag string from the tech reason + strong-signal flags,
     * e.g. "SwingSupport,FibResistance,BullishFVG,CVDDivergence".
     * Consumed by the fine-tuning analyzer breakdown.
     */
    buildTechTag(techReason, cvd, sweep) {
        const tags = techReason.trim().split(/\s+/)
            .map(s => s.replace(/\(.*?\)/g, '').trim())
            .filter(s => s.length > 0 && s !== '|');
        if (cvd)
            tags.push('CVDDivergence');
        if (sweep)
            tags.push('LiquiditySweep');
        return Array.from(new Set(tags)).join(',');
    }
    /**
     * Distance (as fraction of price) to the nearest known S/R, Fib or POC level.
     * Snapshot at entry time; consumed by the fine-tuning analyzer.
     */
    getNearestLevelDistancePct(symbol, price) {
        const ind = this.indicatorsCache[symbol];
        if (!ind)
            return undefined;
        let best = undefined;
        const consider = (level) => {
            if (typeof level === 'number' && isFinite(level) && level > 0) {
                const d = Math.abs(price - level) / level;
                if (best === undefined || d < best)
                    best = d;
            }
        };
        for (const lv of (ind.srLevels || []))
            consider(lv.price);
        const fib = ind.fibonacci;
        if (fib) {
            for (const key of ['level236', 'level382', 'level500', 'level618', 'level786'])
                consider(fib[key]);
        }
        if (typeof ind.poc === 'number')
            consider(ind.poc);
        return best;
    }
    // NEW: Manual strategy parameter overrides from Performance Lab / Thinking Hub
    // Persisted to strategy_overrides.json so fine-tuning survives bot restarts
    manualOverrides = {};
    overridesFilePath = path.join(process.cwd(), 'strategy_overrides.json');
    setStrategyOverride(symbol, key, value) {
        if (!this.manualOverrides[symbol]) {
            this.manualOverrides[symbol] = {};
        }
        this.manualOverrides[symbol][key] = value;
        this.persistOverrides();
    }
    getStrategyOverride(symbol, key) {
        return this.manualOverrides[symbol]?.[key];
    }
    clearStrategyOverride(symbol, key) {
        if (!key) {
            delete this.manualOverrides[symbol];
        }
        else {
            delete this.manualOverrides[symbol]?.[key];
        }
        this.persistOverrides();
    }
    getAllOverrides() {
        return this.manualOverrides;
    }
    /**
     * Effective running parameters for one symbol:
     * base state params combined with active per-symbol overrides.
     * obi/zScore effective = base x multiplier (matches processTick logic).
     * Used by dashboard UI and trade analyzer.
     */
    getSymbolEffectiveParams(symbol) {
        const base = this.getParams(symbol) || {};
        const ov = (this.manualOverrides[symbol] || {});
        const overriddenKeys = Object.keys(ov).filter(k => ov[k] !== undefined);
        const obiMultiplier = ov.obiMultiplier ?? 1;
        const zScoreMultiplier = ov.zScoreMultiplier ?? 1;
        const takeProfitPct = ov.takeProfitPct ?? base.takeProfitPct;
        // Enforce the same RR guardrail as updateParams (SL between 0.25x and 0.50x of TP)
        // so overrides from any path stay within risk policy
        let stopLossPct = ov.stopLossPct ?? base.stopLossPct;
        if (takeProfitPct && takeProfitPct > 0) {
            stopLossPct = Math.max(takeProfitPct * 0.25, Math.min(takeProfitPct * 0.5, stopLossPct));
        }
        return {
            obiThreshold: (base.obiThreshold ?? 0) * obiMultiplier,
            zScoreThreshold: (base.zScoreThreshold ?? 0) * zScoreMultiplier,
            takeProfitPct,
            stopLossPct,
            minConfirmations: ov.minConfirmations ?? 1,
            obiMultiplier,
            zScoreMultiplier,
            srThresholdPct: ov.srThresholdPct ?? null,
            overriddenKeys
        };
    }
    loadOverrides() {
        try {
            if (fs.existsSync(this.overridesFilePath)) {
                const raw = JSON.parse(fs.readFileSync(this.overridesFilePath, 'utf-8'));
                if (raw && typeof raw === 'object') {
                    this.manualOverrides = raw;
                    const symbols = Object.keys(this.manualOverrides);
                    if (symbols.length > 0) {
                        console.log(`\x1b[35m[STRATEGY] Loaded ${symbols.length} symbol override(s) from strategy_overrides.json: ${symbols.join(', ')}\x1b[0m`);
                    }
                }
            }
        }
        catch (err) {
            console.error(`[STRATEGY] Failed to load strategy_overrides.json: ${err.message}`);
        }
    }
    persistOverrides() {
        try {
            fs.writeFileSync(this.overridesFilePath, JSON.stringify(this.manualOverrides, null, 2), 'utf-8');
        }
        catch (err) {
            console.error(`[STRATEGY] Failed to save strategy_overrides.json: ${err.message}`);
        }
    }
    constructor() {
        // Load persisted fine-tuning overrides (survives restarts)
        this.loadOverrides();
        // NEW: Initialize advanced modules
        this.marketMicro = new MarketMicrostructure();
        this.marketRegime = new MarketRegimeDetector();
        this.pairsTrader = new PairsTrader();
        // Initialize states for configured symbols
        for (const [key, symbolConfig] of Object.entries(CONFIG.SYMBOLS)) {
            this.states.set(symbolConfig.name, {
                symbol: symbolConfig.name,
                midPriceHistory: [],
                fastEma: null,
                slowEma: null,
                lastTickTime: 0,
                lastHistoryTime: 0,
                obiThreshold: symbolConfig.obiThreshold,
                zScoreThreshold: symbolConfig.zScoreThreshold,
                takeProfitPct: symbolConfig.takeProfitPct,
                stopLossPct: symbolConfig.stopLossPct
            });
        }
    }
    updateParams(symbol, params) {
        const state = this.states.get(symbol);
        if (state) {
            state.obiThreshold = params.obiThreshold;
            state.zScoreThreshold = params.zScoreThreshold;
            // Enforce strict Risk-to-Reward Ratio (1:2 to 1:4)
            // SL must be between 0.25x and 0.50x of TP
            const minSl = params.takeProfitPct * 0.25;
            const maxSl = params.takeProfitPct * 0.50;
            const clampedSl = Math.max(minSl, Math.min(maxSl, params.stopLossPct));
            state.takeProfitPct = params.takeProfitPct;
            state.stopLossPct = clampedSl;
        }
    }
    getParams(symbol) {
        const state = this.states.get(symbol);
        if (state) {
            return {
                obiThreshold: state.obiThreshold,
                zScoreThreshold: state.zScoreThreshold,
                takeProfitPct: state.takeProfitPct,
                stopLossPct: state.stopLossPct
            };
        }
        return null;
    }
    getAllParams() {
        const snapshot = {};
        for (const [symbol, state] of this.states.entries()) {
            snapshot[symbol] = {
                obiThreshold: state.obiThreshold,
                zScoreThreshold: state.zScoreThreshold,
                takeProfitPct: state.takeProfitPct,
                stopLossPct: state.stopLossPct
            };
        }
        return snapshot;
    }
    getATR(symbol) {
        return this.marketRegime.getATR(symbol);
    }
    /** Read-only view of cached chart indicators (fib/fvg/sr/poc) for dashboard visualization */
    getIndicators(symbol) {
        return this.indicatorsCache[symbol] || null;
    }
    /** Current VWAP snapshot for dashboard visualization */
    getVwapData(symbol) {
        return this.marketMicro.getVWAP(symbol);
    }
    getRegimeMultipliers(symbol) {
        return this.marketRegime.getRegimeMultipliers(symbol);
    }
    /**
     * Feed multi-timeframe candles (1d/4h/15m) into the candle-based regime detector.
     * Called from main.ts every optimization cycle.
     */
    setRegimeCandles(symbol, candles) {
        this.marketRegime.updateCandleContext(symbol, candles);
    }
    getMarketRegimeInfo() {
        const info = {};
        for (const symbol of Object.keys(CONFIG.SYMBOLS)) {
            const debug = this.marketRegime.getRegimeDebugInfo(symbol);
            if (debug) {
                info[symbol] = {
                    regime: debug.regime,
                    atrPct: parseFloat(debug.atrPct.toFixed(4)),
                    slope: parseFloat(debug.slope.toFixed(6))
                };
            }
        }
        return info;
    }
    /**
     * Process a new OrderBook tick and check for high-probability signals.
     * Leverages a premium hybrid model: candle quantitative levels act as confirmation zones,
     * while micro-imbalances (OBI & Z-score) trigger precise execution.
     *
     * NEW ENHANCEMENTS:
     * - Market regime detection
     * - Liquidity sweep detection
     * - CVD divergence confirmation
     * - OBI trend momentum
     * - VWAP proximity filter
     */
    processTick(book) {
        const state = this.states.get(book.symbol);
        if (!state)
            return null;
        const now = Date.now();
        // Micro-throttle to prevent double fills
        if (now - state.lastTickTime < 30) {
            return null;
        }
        state.lastTickTime = now;
        if (book.bids.length === 0 || book.asks.length === 0) {
            return null;
        }
        const bestBid = book.bids[0];
        const bestAsk = book.asks[0];
        const pBid = bestBid[0];
        const vBid = bestBid[1];
        const pAsk = bestAsk[0];
        const vAsk = bestAsk[1];
        const midPrice = (pBid + pAsk) / 2;
        const totalVolume = vBid + vAsk;
        if (totalVolume === 0)
            return null;
        const microPrice = (pBid * vAsk + pAsk * vBid) / totalVolume;
        const obi = (vBid - vAsk) / totalVolume;
        // ================================================================
        // NEW: Update advanced modules with current tick data
        // ================================================================
        this.marketMicro.processTick(book);
        this.marketRegime.processPrice(book.symbol, midPrice);
        this.pairsTrader.updatePrice(book.symbol, midPrice);
        // Check market regime
        const regime = this.marketRegime.detectRegime(book.symbol);
        const trendDirection = this.marketRegime.getTrendDirection(book.symbol);
        // Regime routing (candle-based v2): which sides may fire in this regime.
        // TRENDING_BULL -> long-only | TRENDING_BEAR -> short-only |
        // RANGING -> two-way MR | HIGH/LOW volatility -> stand aside entirely.
        const allowedSides = this.marketRegime.getAllowedSides(regime);
        // Check liquidity sweep (high probability entry)
        const sweepSignal = this.marketMicro.detectLiquiditySweep(book.symbol, pBid, pAsk);
        if (sweepSignal) {
            // Liquidity sweep detected! This is a potential reversal entry
            // We'll still check other conditions but prioritize sweep signals
        }
        // Check CVD divergence
        const cvdDivergence = this.marketMicro.checkCVDDivergence(book.symbol);
        // Check OBI trend (accumulating or distributing?)
        const obiTrend = this.marketMicro.getOBITrend(book.symbol);
        // Get VWAP
        const vwapData = this.marketMicro.getVWAP(book.symbol);
        // Get Volume Profile
        const volProfile = this.marketMicro.getVolumeProfile(book.symbol);
        // ================================================================
        // Decoupled Baseline: Update rolling window history & EMA
        if (now - state.lastHistoryTime >= 1000 || state.midPriceHistory.length === 0) {
            state.midPriceHistory.push(midPrice);
            if (state.midPriceHistory.length > CONFIG.ROLLING_WINDOW_SIZE) {
                state.midPriceHistory.shift();
            }
            const emaPeriod = CONFIG.EMA_FAST_PERIOD;
            const k = 2 / (emaPeriod + 1);
            if (state.fastEma === null) {
                state.fastEma = midPrice;
            }
            else {
                state.fastEma = midPrice * k + state.fastEma * (1 - k);
            }
            // NEW: Slow EMA for trend confirmation (3x period)
            const slowPeriod = CONFIG.EMA_FAST_PERIOD * 3;
            const slowK = 2 / (slowPeriod + 1);
            if (state.slowEma === null) {
                state.slowEma = midPrice;
            }
            else {
                state.slowEma = midPrice * slowK + state.slowEma * (1 - slowK);
            }
            state.lastHistoryTime = now;
        }
        if (state.midPriceHistory.length < CONFIG.ROLLING_WINDOW_SIZE || state.fastEma === null) {
            return null;
        }
        const sum = state.midPriceHistory.reduce((a, b) => a + b, 0);
        const mean = sum / state.midPriceHistory.length;
        const variance = state.midPriceHistory.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / state.midPriceHistory.length;
        const stdDev = Math.sqrt(variance);
        const zScore = stdDev > 0 ? (midPrice - mean) / stdDev : 0;
        const symbolConfig = Object.values(CONFIG.SYMBOLS).find(s => s.name === book.symbol);
        if (!symbolConfig)
            return null;
        const activeBias = this.aiBiases[book.symbol] || 'NEUTRAL';
        // =========================================================================
        // HYBRID QUANTITATIVE CONFIRMATION: Evaluate Fibonacci, S/R, FVG, POC zones
        // =========================================================================
        const indicators = this.indicatorsCache[book.symbol];
        let isNearSupportLevel = false;
        let isNearResistanceLevel = false;
        let techReason = '';
        if (indicators) {
            const price = midPrice;
            // A. Check Fibonacci Retracement Support/Resistance
            if (indicators.fibonacci) {
                const fib = indicators.fibonacci;
                const fibSupports = [fib.level500, fib.level618, fib.level786];
                for (const level of fibSupports) {
                    const diffPct = Math.abs(price - level) / level;
                    if (diffPct <= 0.010) {
                        isNearSupportLevel = true;
                        techReason += `FibSupport(${(diffPct * 100).toFixed(1)}%) `;
                        break;
                    }
                }
                const fibResists = [fib.level236, fib.level382, fib.level500, fib.level618];
                for (const level of fibResists) {
                    const diffPct = Math.abs(price - level) / level;
                    if (diffPct <= 0.010) {
                        isNearResistanceLevel = true;
                        techReason += `FibResistance(${(diffPct * 100).toFixed(1)}%) `;
                        break;
                    }
                }
            }
            // B. Check Swing Support & Resistance Lines
            if (indicators.srLevels && indicators.srLevels.length > 0) {
                for (const sr of indicators.srLevels) {
                    const diffPct = Math.abs(price - sr.price) / sr.price;
                    if (diffPct <= 0.012) {
                        if (sr.type === 'SUPPORT') {
                            isNearSupportLevel = true;
                            techReason += `SwingSupport(${sr.strength}) `;
                        }
                        else if (sr.type === 'RESISTANCE') {
                            isNearResistanceLevel = true;
                            techReason += `SwingResistance(${sr.strength}) `;
                        }
                    }
                }
            }
            // C. Check Fair Value Gaps (FVG) zones
            if (indicators.fvgs && indicators.fvgs.length > 0) {
                const unfilledFvgs = indicators.fvgs.filter(f => !f.isFilled);
                for (const fvg of unfilledFvgs) {
                    if (fvg.type === 'BULLISH' && price <= fvg.top && price >= fvg.bottom) {
                        isNearSupportLevel = true;
                        techReason += `BullishFVG `;
                        break;
                    }
                    else if (fvg.type === 'BEARISH' && price >= fvg.top && price <= fvg.bottom) {
                        isNearResistanceLevel = true;
                        techReason += `BearishFVG `;
                        break;
                    }
                }
            }
            // D. Check Point of Control (POC) Volume Magnet
            if (indicators.poc) {
                const diffPct = Math.abs(price - indicators.poc) / indicators.poc;
                if (diffPct <= 0.008) {
                    if (activeBias === 'BULLISH')
                        isNearSupportLevel = true;
                    else if (activeBias === 'BEARISH')
                        isNearResistanceLevel = true;
                    techReason += `POCMagnet `;
                }
            }
        }
        else {
            isNearSupportLevel = true;
            isNearResistanceLevel = true;
            techReason = 'OBI+Z-Score Fallback ';
        }
        // =========================================================================
        // NEW: VWAP Confirmation
        // =========================================================================
        let isAboveVWAP = true;
        let isBelowVWAP = false;
        if (vwapData) {
            isAboveVWAP = midPrice > vwapData.price;
            isBelowVWAP = midPrice < vwapData.price;
        }
        // =========================================================================
        // NEW: Volume Profile Confirmation
        // =========================================================================
        let isInValueArea = true;
        if (volProfile) {
            isInValueArea = midPrice >= volProfile.val && midPrice <= volProfile.vah;
        }
        // =========================================================================
        // NEW: Regime-Based Adjustments + Manual Overrides
        // =========================================================================
        const regimeMultipliers = this.marketRegime.getRegimeMultipliers(book.symbol);
        const obiOverride = this.manualOverrides[book.symbol]?.obiMultiplier ?? 1;
        const zScoreOverride = this.manualOverrides[book.symbol]?.zScoreMultiplier ?? 1;
        let adjustedObiThreshold = state.obiThreshold * regimeMultipliers.obiMultiplier * obiOverride;
        let adjustedZScoreThreshold = state.zScoreThreshold * regimeMultipliers.zScoreMultiplier * zScoreOverride;
        // =========================================================================
        // EXECUTION TRIGGERS: Tick Imbalance & Momentum
        // =========================================================================
        // Extreme z-score guard: |Z| beyond this means a panic flush / melt-up is in
        // progress — entries there get filled at the worst prices and stopped within
        // minutes (fastest loss of the 23-26 Aug run: -$50.78 in 26.9s at Z(-0.76)
        // during a cascade; several others entered at |Z| ~ 1.0-1.15).
        if (Math.abs(zScore) > CONFIG.EXTREME_ZSCORE_BLOCK)
            return null;
        // LONG Entry Conditions (Buy)
        const isBuyAllowedByAI = activeBias === 'NEUTRAL' || activeBias === 'BULLISH';
        const hasLongImbalance = obi > adjustedObiThreshold;
        const hasLongMicroPriceDivergence = microPrice > midPrice + (symbolConfig.tickSize * 0.1);
        const isOversold = zScore < -adjustedZScoreThreshold;
        const hasUpwardMomentum = midPrice > state.fastEma;
        // NEW: Additional long confirmations
        const hasBullishRegime = regime === 'TRENDING_BULL' || regime === 'RANGING';
        const hasBullishOBITrend = obiTrend === 'ACCUMULATING';
        const hasBullishCVD = cvdDivergence === 'BULLISH';
        const hasSweepBuy = sweepSignal?.side === 'BUY';
        const isBelowVWAPForLong = isBelowVWAP; // Buying below VWAP is favorable
        const slowEmaAboveFast = state.slowEma !== null && state.fastEma !== null && state.fastEma > state.slowEma;
        let longConfirmations = 0;
        if (hasBullishRegime)
            longConfirmations++;
        if (hasBullishOBITrend)
            longConfirmations++;
        if (hasBullishCVD)
            longConfirmations += 2; // CVD divergence is strong signal
        if (hasSweepBuy)
            longConfirmations += 2; // Liquidity sweep is strong signal
        if (isBelowVWAPForLong)
            longConfirmations++;
        if (slowEmaAboveFast)
            longConfirmations++;
        if (isInValueArea)
            longConfirmations++;
        if (isBuyAllowedByAI && allowedSides.allowLong && isNearSupportLevel && hasLongImbalance && hasLongMicroPriceDivergence && isOversold && hasUpwardMomentum) {
            // NEW: Require minimum confirmations
            const minConf = this.manualOverrides[book.symbol]?.minConfirmations ?? 1;
            if (longConfirmations < minConf)
                return null;
            if (this.macroTrends['BTC'] === 'BEARISH') {
                return null;
            }
            const confidence = (Math.abs(obi) > state.obiThreshold * 1.5 && Math.abs(zScore) > state.zScoreThreshold * 1.5 && longConfirmations >= 4) ? 'HIGH' : 'LOW';
            let reason = `${techReason.trim()}`;
            if (hasSweepBuy)
                reason = `[LIQUIDITY SWEEP] ${reason}`;
            if (hasBullishCVD)
                reason = `[CVD DIVERGENCE] ${reason}`;
            reason += ` | OBI(${obi.toFixed(2)}) > ${adjustedObiThreshold.toFixed(2)} & Z(${zScore.toFixed(2)}) < -${adjustedZScoreThreshold.toFixed(2)}`;
            reason += ` | Regime: ${regime}`;
            return {
                symbol: book.symbol,
                side: 'BUY',
                price: pAsk,
                reason,
                confidence,
                obi,
                zScore,
                confirmations: longConfirmations,
                srDistancePct: this.getNearestLevelDistancePct(book.symbol, midPrice),
                regime,
                techTag: this.buildTechTag(techReason, hasBullishCVD, hasSweepBuy)
            };
        }
        // SHORT Entry Conditions (Sell)
        const isSellAllowedByAI = activeBias === 'NEUTRAL' || activeBias === 'BEARISH';
        const hasShortImbalance = obi < -adjustedObiThreshold;
        const hasShortMicroPriceDivergence = microPrice < midPrice - (symbolConfig.tickSize * 0.1);
        const isOverbought = zScore > adjustedZScoreThreshold;
        const hasDownwardMomentum = midPrice < state.fastEma;
        // NEW: Additional short confirmations
        const hasBearishRegime = regime === 'TRENDING_BEAR' || regime === 'RANGING';
        const hasBearishOBITrend = obiTrend === 'DISTRIBUTING';
        const hasBearishCVD = cvdDivergence === 'BEARISH';
        const hasSweepSell = sweepSignal?.side === 'SELL';
        const isAboveVWAPForShort = isAboveVWAP;
        const slowEmaBelowFast = state.slowEma !== null && state.fastEma !== null && state.fastEma < state.slowEma;
        let shortConfirmations = 0;
        if (hasBearishRegime)
            shortConfirmations++;
        if (hasBearishOBITrend)
            shortConfirmations++;
        if (hasBearishCVD)
            shortConfirmations += 2;
        if (hasSweepSell)
            shortConfirmations += 2;
        if (isAboveVWAPForShort)
            shortConfirmations++;
        if (slowEmaBelowFast)
            shortConfirmations++;
        if (isInValueArea)
            shortConfirmations++;
        if (isSellAllowedByAI && allowedSides.allowShort && isNearResistanceLevel && hasShortImbalance && hasShortMicroPriceDivergence && isOverbought && hasDownwardMomentum) {
            // Data-driven trade filter: contrarian shorts during strong uptrends were the
            // single largest loss source (-$178 across 24 trades). See CONFIG.TRADE_FILTERS.
            const filters = CONFIG.TRADE_FILTERS;
            if (!filters.ENABLE_SHORTS)
                return null;
            if (filters.SHORT_BLOCKED_REGIMES.includes(regime))
                return null;
            const minConf = this.manualOverrides[book.symbol]?.minConfirmations ?? 1;
            if (shortConfirmations < minConf)
                return null;
            if (this.macroTrends['BTC'] === 'BULLISH') {
                return null;
            }
            const confidence = (Math.abs(obi) > state.obiThreshold * 1.5 && Math.abs(zScore) > state.zScoreThreshold * 1.5 && shortConfirmations >= 4) ? 'HIGH' : 'LOW';
            let reason = `${techReason.trim()}`;
            if (hasSweepSell)
                reason = `[LIQUIDITY SWEEP] ${reason}`;
            if (hasBearishCVD)
                reason = `[CVD DIVERGENCE] ${reason}`;
            reason += ` | OBI(${obi.toFixed(2)}) < -${adjustedObiThreshold.toFixed(2)} & Z(${zScore.toFixed(2)}) > ${adjustedZScoreThreshold.toFixed(2)}`;
            reason += ` | Regime: ${regime}`;
            return {
                symbol: book.symbol,
                side: 'SELL',
                price: pBid,
                reason,
                confidence,
                obi,
                zScore,
                confirmations: shortConfirmations,
                srDistancePct: this.getNearestLevelDistancePct(book.symbol, midPrice),
                regime,
                techTag: this.buildTechTag(techReason, hasBearishCVD, hasSweepSell)
            };
        }
        return null;
    }
}
