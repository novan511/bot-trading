import { CONFIG } from './config.js';
import { RiskManager } from './risk_manager.js';
import fs from 'fs';
import path from 'path';
/**
 * Composite identity of a closed trade — used to dedupe imports across
 * differently-generated ids (bot orderIds vs import fingerprints).
 */
function tradeFingerprint(t) {
    const entry = Number.isFinite(t.entryPrice) ? t.entryPrice.toPrecision(10) : String(t.entryPrice);
    return `${t.symbol}|${t.side}|${Math.round((t.exitTime || 0) / 1000)}|${entry}|${Number(t.netProfitUsd || 0).toFixed(4)}`;
}
/**
 * Timestamp-free identity: if symbol, side, entry price, exit price, quantity
 * and net PnL are ALL exactly equal, it is the same trade — even when the
 * recorded time differs (timezone shifts between export/import machines,
 * re-parsed display formats, etc.). Exact duplicates are ignored on import.
 */
function tradeContentKey(t) {
    const num = (v, fallback) => Number.isFinite(v) ? v.toPrecision(10) : fallback;
    return [
        t.symbol,
        t.side,
        num(t.entryPrice, String(t.entryPrice)),
        num(t.exitPrice, String(t.exitPrice)),
        num(t.quantity, String(t.quantity)),
        Number(t.netProfitUsd || 0).toFixed(4)
    ].join('|');
}
export class ExecutionEngine {
    activePositions = new Map();
    tradesHistory = [];
    exchange;
    // Per-symbol timestamp of the last STOP LOSS exit — used for post-SL re-entry cooldown
    lastStopLossTimes = new Map();
    // Auto risk guards: rolling-expectancy kill switch & consecutive-loss breaker per symbol
    symbolSuspensions = new Map();
    symbolConsecutiveLosses = new Map();
    riskManager;
    stats = {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        grossProfitUsd: 0,
        totalFeesUsd: 0,
        netProfitUsd: 0,
        averageHoldTimeSec: 0
    };
    tradeMemory;
    database = null;
    modelId;
    // Optional provider for per-symbol fine-tuned TP/SL overrides (wired from StrategyManager)
    paramProvider = null;
    constructor(modelId, exchange, tradeMemory, database) {
        this.modelId = modelId;
        this.exchange = exchange;
        this.tradeMemory = tradeMemory;
        this.database = database || null;
        this.riskManager = new RiskManager();
        this.loadTradesArchive();
    }
    setParamProvider(provider) {
        this.paramProvider = provider;
    }
    /**
     * Resolves effective TP/SL for a symbol: fine-tuned override first, static config fallback
     */
    getTpSl(symbol) {
        try {
            const tuned = this.paramProvider ? this.paramProvider(symbol) : null;
            if (tuned && tuned.takeProfitPct > 0 && tuned.stopLossPct > 0)
                return tuned;
        }
        catch { }
        const cfg = Object.values(CONFIG.SYMBOLS).find(s => s.name === symbol);
        return { takeProfitPct: cfg ? cfg.takeProfitPct : 0.015, stopLossPct: cfg ? cfg.stopLossPct : 0.005 };
    }
    /**
     * Helper to format price dynamically according to each coin's tick size
     */
    formatPrice(symbol, price) {
        const coinConfig = Object.values(CONFIG.SYMBOLS).find(s => s.name === symbol);
        if (!coinConfig)
            return price.toFixed(2);
        const tickStr = coinConfig.tickSize.toString();
        const dot = tickStr.indexOf('.');
        const decimals = dot === -1 ? 0 : tickStr.length - dot - 1;
        return price.toFixed(decimals);
    }
    /**
     * Evaluates active positions to recalculate Trailing Stop Loss levels
     */
    evaluatePositions(symbol, currentBid, currentAsk) {
        const positions = this.activePositions.get(symbol);
        if (!positions || positions.length === 0)
            return;
        const now = Date.now();
        const coinConfig = Object.values(CONFIG.SYMBOLS).find(s => s.name === symbol);
        if (!coinConfig)
            return;
        // Fine-tuned per-symbol TP/SL (falls back to static config)
        const { takeProfitPct, stopLossPct } = this.getTpSl(symbol);
        const roundtripFeePct = CONFIG.TAKER_FEE_PCT * 2; // 0.06% roundtrip fee
        // Evaluate each position individually in a shallow copy to prevent concurrent modification issues during close
        for (const position of [...positions]) {
            const holdTimeSec = (now - position.entryTime) / 1000;
            // Track BOTH extremes for MFE/MAE (fine-tuning analyzer needs adverse excursion on longs and favorable on shorts too)
            if (position.highestPrice === undefined || currentBid > position.highestPrice)
                position.highestPrice = currentBid;
            if (position.lowestPrice === undefined || currentAsk < position.lowestPrice)
                position.lowestPrice = currentAsk;
            // Scale out via partial take-profits (realizes profit early, keeps runner for trailing)
            this.checkPartialTPs(position, currentBid, currentAsk);
            let shouldClose = false;
            let exitPrice = 0;
            let reason = '';
            if (position.side === 'BUY') {
                // LONG: exit by selling at current Bid
                exitPrice = currentBid;
                const profitPct = (exitPrice - position.entryPrice) / position.entryPrice;
                // Check if price hits or exceeds original Take Profit target to trigger Runaway Profit mode
                if (exitPrice >= position.takeProfitPrice) {
                    if (!position.isTakeProfitTriggered) {
                        position.isTakeProfitTriggered = true;
                        console.log(`\n\x1b[32m[RUNAWAY PROFIT MODE ACTIVATED] ${position.symbol} has breached Take Profit target (+${(profitPct * 100).toFixed(2)}%). Uncapping profit potential with progressive tight trailing stop.\x1b[0m\n`);
                    }
                }
                // Progressive Trailing Stop Tightening: tighter SL as profit climbs.
                // Only starts tightening once the trade is healthy (>= TRAILING_ACTIVATION_RATIO
                // of the TP distance). Tightening from the first profit tick was cutting winners
                // into scratches (median win $2 on the 23-26 Aug run).
                let activeStopLossPct = stopLossPct;
                if (profitPct > 0) {
                    const profitRatio = profitPct / takeProfitPct;
                    if (profitRatio >= 1.0 || position.isTakeProfitTriggered) {
                        // Runaway profit mode: trails extremely tight behind peak price
                        activeStopLossPct = stopLossPct * CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER;
                    }
                    else if (profitRatio >= CONFIG.TRAILING_ACTIVATION_RATIO) {
                        // Smoothly interpolate from original SL to tight runaway SL across
                        // the remaining distance between activation point and TP
                        const tightSl = stopLossPct * CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER;
                        const tightenProgress = (profitRatio - CONFIG.TRAILING_ACTIVATION_RATIO) / (1 - CONFIG.TRAILING_ACTIVATION_RATIO);
                        activeStopLossPct = stopLossPct - (stopLossPct - tightSl) * tightenProgress;
                    }
                }
                // Update peak price
                const peakPrice = position.highestPrice || position.entryPrice;
                if (currentBid > peakPrice) {
                    position.highestPrice = currentBid;
                }
                // Drag stop loss behind peak price
                const currentPeak = position.highestPrice || currentBid;
                const newStopLoss = currentPeak * (1 - activeStopLossPct);
                if (newStopLoss > position.stopLossPrice) {
                    position.stopLossPrice = newStopLoss;
                }
                // STOP LOSS + : Force SL to cross above entry price + roundtrip fee to lock in a free trade!
                const feePlusStopLoss = position.entryPrice * (1 + roundtripFeePct);
                const activationBuffer = position.entryPrice * (1 + roundtripFeePct + CONFIG.BREAKEVEN_STOP_ACTIVATION_BUFFER_PCT);
                if (currentBid >= activationBuffer && position.stopLossPrice < feePlusStopLoss) {
                    position.stopLossPrice = feePlusStopLoss;
                    console.log(`\x1b[32m[STOP LOSS + ACTIVATED] ${position.symbol} SL moved to fee-breakeven floor (${this.formatPrice(position.symbol, feePlusStopLoss)})\x1b[0m`);
                }
                // Close conditions: Trailing stop loss breached or hold duration expired
                if (exitPrice <= position.stopLossPrice) {
                    shouldClose = true;
                    const isWin = exitPrice > position.entryPrice * (1 + roundtripFeePct);
                    reason = isWin
                        ? `TRAILING PROFIT LOCKED (+${(profitPct * 100).toFixed(3)}%)`
                        : `STOP LOSS TRIGGERED (${(profitPct * 100).toFixed(3)}%)`;
                }
                else if (holdTimeSec >= CONFIG.MAX_HOLD_DURATION_SEC) {
                    shouldClose = true;
                    reason = `MAX TIME EXPIRED (${holdTimeSec.toFixed(1)}s)`;
                }
            }
            else {
                // SHORT: exit by buying back at current Ask
                exitPrice = currentAsk;
                const profitPct = (position.entryPrice - exitPrice) / position.entryPrice;
                // Check if price hits or drops below original Take Profit target to trigger Runaway Profit mode
                if (exitPrice <= position.takeProfitPrice) {
                    if (!position.isTakeProfitTriggered) {
                        position.isTakeProfitTriggered = true;
                        console.log(`\n\x1b[32m[RUNAWAY PROFIT MODE ACTIVATED] ${position.symbol} has breached Take Profit target (+${(profitPct * 100).toFixed(2)}%). Uncapping profit potential with progressive tight trailing stop.\x1b[0m\n`);
                    }
                }
                // Progressive Trailing Stop Tightening: tighter SL as profit drops.
                // Same activation gate as the long side (see TRAILING_ACTIVATION_RATIO).
                let activeStopLossPct = stopLossPct;
                if (profitPct > 0) {
                    const profitRatio = profitPct / takeProfitPct;
                    if (profitRatio >= 1.0 || position.isTakeProfitTriggered) {
                        activeStopLossPct = stopLossPct * CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER;
                    }
                    else if (profitRatio >= CONFIG.TRAILING_ACTIVATION_RATIO) {
                        const tightSl = stopLossPct * CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER;
                        const tightenProgress = (profitRatio - CONFIG.TRAILING_ACTIVATION_RATIO) / (1 - CONFIG.TRAILING_ACTIVATION_RATIO);
                        activeStopLossPct = stopLossPct - (stopLossPct - tightSl) * tightenProgress;
                    }
                }
                // Update trough price
                const troughPrice = position.lowestPrice || position.entryPrice;
                if (currentAsk < troughPrice) {
                    position.lowestPrice = currentAsk;
                }
                // Drag stop loss behind trough price
                const currentTrough = position.lowestPrice || currentAsk;
                const newStopLoss = currentTrough * (1 + activeStopLossPct);
                if (newStopLoss < position.stopLossPrice) {
                    position.stopLossPrice = newStopLoss;
                }
                // STOP LOSS + : Force SL to cross below entry price - roundtrip fee to lock in a free trade!
                const feePlusStopLoss = position.entryPrice * (1 - roundtripFeePct);
                const activationBuffer = position.entryPrice * (1 - roundtripFeePct - CONFIG.BREAKEVEN_STOP_ACTIVATION_BUFFER_PCT);
                if (currentAsk <= activationBuffer && position.stopLossPrice > feePlusStopLoss) {
                    position.stopLossPrice = feePlusStopLoss;
                    console.log(`\x1b[32m[STOP LOSS + ACTIVATED] ${position.symbol} SL moved to fee-breakeven floor (${this.formatPrice(position.symbol, feePlusStopLoss)})\x1b[0m`);
                }
                // Close conditions: Trailing stop loss breached or hold duration expired
                if (exitPrice >= position.stopLossPrice) {
                    shouldClose = true;
                    const isWin = exitPrice < position.entryPrice * (1 - roundtripFeePct);
                    reason = isWin
                        ? `TRAILING PROFIT LOCKED (+${(profitPct * 100).toFixed(3)}%)`
                        : `STOP LOSS TRIGGERED (${(profitPct * 100).toFixed(3)}%)`;
                }
                else if (holdTimeSec >= CONFIG.MAX_HOLD_DURATION_SEC) {
                    shouldClose = true;
                    reason = `MAX TIME EXPIRED (${holdTimeSec.toFixed(1)}s)`;
                }
            }
            if (shouldClose) {
                this.closePosition(position, exitPrice, reason);
            }
        }
        // Proactive Cumulative Drawdown Protection check
        const updatedPositions = this.activePositions.get(symbol);
        if (updatedPositions && updatedPositions.length > 0) {
            let totalCost = 0;
            let totalFloatingPnl = 0;
            for (const p of updatedPositions) {
                const cost = p.entryPrice * p.quantity;
                totalCost += cost;
                let fPnl = 0;
                if (p.side === 'BUY') {
                    fPnl = (currentBid - p.entryPrice) * p.quantity;
                }
                else {
                    fPnl = (p.entryPrice - currentAsk) * p.quantity;
                }
                totalFloatingPnl += fPnl;
            }
            const cumulativeDrawdownPct = totalCost > 0 ? (totalFloatingPnl / totalCost) : 0;
            if (cumulativeDrawdownPct <= -CONFIG.CUMULATIVE_DRAWDOWN_LIMIT_PCT) {
                console.log(`\n\x1b[31m[CUMULATIVE DRAWDOWN SAFEGUARD TRIGGERED] ${symbol} drawdown of ${(cumulativeDrawdownPct * 100).toFixed(2)}% exceeded limit of -${(CONFIG.CUMULATIVE_DRAWDOWN_LIMIT_PCT * 100).toFixed(2)}%. Closing all active positions.\x1b[0m\n`);
                // Close all positions at current market prices
                for (const pos of [...updatedPositions]) {
                    const finalExitPrice = pos.side === 'BUY' ? currentBid : currentAsk;
                    this.closePosition(pos, finalExitPrice, `CUMULATIVE DRAWDOWN SAFEGUARD TRIGGERED (${(cumulativeDrawdownPct * 100).toFixed(2)}%)`);
                }
            }
        }
    }
    /**
     * Triggers entry for a new signal
     * NEW ENHANCEMENTS:
     * - RiskManager check (daily drawdown, session filter)
     * - Kelly + ATR-based position sizing
     * - Partial take-profit levels (scale out)
     */
    async executeSignal(signal) {
        // NEW: Check risk manager is OK
        if (!this.riskManager.isTradingAllowed()) {
            console.log(`\x1b[33m[RISK] Trading paused by RiskManager. Skipping ${signal.symbol} ${signal.side} signal.\x1b[0m`);
            return;
        }
        // Per-symbol auto guards (kill switch / loss-streak breaker)
        const guard = this.checkSymbolSuspension(signal.symbol);
        if (!guard.allowed) {
            console.log(`\x1b[33m[SYMBOL GUARD] ${signal.symbol} ${signal.side} blocked: suspended until ${new Date(this.symbolSuspensions.get(signal.symbol)?.until || 0).toLocaleString()} (${guard.reason})\x1b[0m`);
            return;
        }
        const coinConfig = Object.values(CONFIG.SYMBOLS).find(s => s.name === signal.symbol);
        if (!coinConfig)
            return;
        // Evaluate spacing & time cooldown rules for existing positions on this coin
        const activeForCoin = this.activePositions.get(signal.symbol) || [];
        if (activeForCoin.length > 0) {
            // 1. Time Cooldown check (minimum spacing)
            const lastPos = activeForCoin[activeForCoin.length - 1];
            if (Date.now() - lastPos.entryTime < CONFIG.ENTRY_COOLDOWN_SEC * 1000) {
                return; // Skip signal inside cooldown
            }
            // 2. Price Spacing check (minimum spacing)
            const currentEntryPrice = signal.price;
            for (const p of activeForCoin) {
                const priceDiffPct = Math.abs(currentEntryPrice - p.entryPrice) / p.entryPrice;
                if (priceDiffPct < CONFIG.MIN_ENTRY_SPACING_PCT) {
                    return; // Skip signal too close to existing entry price
                }
            }
            // 3. Post-stop-loss cooldown: right after an SL exit the market usually keeps
            // moving against the original thesis. Re-entries within 30 min of a >=$20 loss
            // cost another -$47 across 10 occurrences in the 23-26 Aug run.
            const lastSLTime = this.lastStopLossTimes.get(signal.symbol);
            if (lastSLTime && Date.now() - lastSLTime < CONFIG.POST_STOP_LOSS_COOLDOWN_SEC * 1000) {
                console.log(`\x1b[90m[POST-SL COOLDOWN] ${signal.symbol} skipped: waiting out ${CONFIG.POST_STOP_LOSS_COOLDOWN_SEC}s after stop loss\x1b[0m`);
                return;
            }
        }
        const entryPrice = signal.price;
        // Fine-tuned per-symbol TP/SL (falls back to static config)
        const { takeProfitPct, stopLossPct } = this.getTpSl(signal.symbol);
        // Calculate stop & take profit prices
        let stopLossPrice = 0;
        let takeProfitPrice = 0;
        if (signal.side === 'BUY') {
            stopLossPrice = entryPrice * (1 - stopLossPct);
            takeProfitPrice = entryPrice * (1 + takeProfitPct);
        }
        else {
            stopLossPrice = entryPrice * (1 + stopLossPct);
            takeProfitPrice = entryPrice * (1 - takeProfitPct);
        }
        // NEW: Dynamic position sizing using RiskManager (Kelly + ATR)
        const atr = signal.atr || 0;
        const baseQuantity = this.riskManager.calculatePositionSize(this.stats, signal.symbol, atr, entryPrice, stopLossPrice, signal.confidence);
        // De-risk coins with weak historical expectancy (Bayesian review, see TRADE_FILTERS)
        const sizeMult = CONFIG.TRADE_FILTERS.SYMBOL_SIZE_MULTIPLIERS[signal.symbol] ?? 1;
        let quantity = baseQuantity * sizeMult;
        if (quantity <= 0) {
            console.log(`\x1b[90m[SIZING SKIP] ${signal.symbol} | ATR: ${atr.toFixed(6)} | Entry: ${entryPrice.toFixed(2)} | SL: ${stopLossPrice.toFixed(2)} | RiskDist: ${Math.abs(entryPrice - stopLossPrice).toFixed(2)} | Qty: ${quantity.toFixed(6)}\x1b[0m`);
            return;
        }
        // Hard risk caps: per-position notional ceiling + gross portfolio exposure cap.
        // The unbounded Kelly window (23-24 Aug) doubled notional to ~$9k and produced
        // every worst-case loss of that run (-$48..-$51 per trade).
        const grossNotional = this.getTotalGrossNotionalUsd();
        const exposureRoom = Math.max(0, CONFIG.GROSS_EXPOSURE_CAP_USD - grossNotional);
        const allowedNotional = Math.min(entryPrice * quantity, CONFIG.MAX_POSITION_NOTIONAL_USD, exposureRoom);
        if (allowedNotional < entryPrice * coinConfig.lotSize) {
            console.log(`\x1b[90m[RISK CAP] ${signal.symbol} ${signal.side} skipped: exposure limit (gross $${grossNotional.toFixed(0)} / $${CONFIG.GROSS_EXPOSURE_CAP_USD})\x1b[0m`);
            return;
        }
        if (allowedNotional < entryPrice * quantity) {
            console.log(`\x1b[33m[RISK CAP] ${signal.symbol} sized down by notional/exposure cap: $${(entryPrice * quantity).toFixed(0)} -> $${allowedNotional.toFixed(0)}\x1b[0m`);
            quantity = parseFloat((allowedNotional / entryPrice).toFixed(6));
        }
        console.log(`\x1b[36m[SIGNAL ENTRY] ${signal.symbol} | ${signal.side} at ${this.formatPrice(signal.symbol, entryPrice)} | qty: ${quantity.toFixed(6)}${sizeMult !== 1 ? ` (size x${sizeMult})` : ''} | SL: ${this.formatPrice(signal.symbol, stopLossPrice)} | TP: ${this.formatPrice(signal.symbol, takeProfitPrice)}\x1b[0m`);
        if (CONFIG.SIMULATION_MODE) {
            const order = await this.exchange.submitSimulatedOrder(signal.symbol, signal.side, entryPrice, quantity);
            if (order.success) {
                // NEW: Setup partial take-profit levels (scale out)
                const partialTPs = this.createPartialTPLevels(signal.side, entryPrice, takeProfitPrice);
                const position = {
                    id: order.orderId,
                    symbol: signal.symbol,
                    side: signal.side,
                    entryPrice: order.executedPrice,
                    quantity,
                    entryTime: Date.now(),
                    takeProfitPrice,
                    stopLossPrice,
                    highestPrice: order.executedPrice,
                    lowestPrice: order.executedPrice,
                    entryReason: signal.reason,
                    modelId: this.modelId,
                    partialTPs,
                    remainingQty: quantity,
                    entryObi: signal.obi,
                    entryZScore: signal.zScore,
                    entryConfirmations: signal.confirmations,
                    entrySrDistancePct: signal.srDistancePct,
                    entryRegime: signal.regime,
                    entryTechTag: signal.techTag
                };
                const existingList = this.activePositions.get(signal.symbol) || [];
                existingList.push(position);
                this.activePositions.set(signal.symbol, existingList);
                this.stats.totalFeesUsd += order.feeUsd;
            }
        }
        else {
            try {
                await this.exchange.submitLiveOrder(signal.symbol, signal.side, quantity);
            }
            catch (err) {
                console.error(`[EXECUTION ERROR] Live entry failed:`, err.message);
            }
        }
    }
    /**
     * NEW: Creates partial take-profit levels for scaling out
     * TP1: Close 30% of position at original TP
     * TP2: Close 30% of position at 1.5x original TP
     * TP3: Let remaining 40% run with trailing stop
     */
    createPartialTPLevels(side, entryPrice, baseTP) {
        const coinConfig = Object.values(CONFIG.SYMBOLS).find(s => s.name === side);
        const tpRange = Math.abs(baseTP - entryPrice);
        return [
            {
                pct: CONFIG.TP1_PCT,
                targetPx: side === 'BUY' ? entryPrice + tpRange : entryPrice - tpRange,
                isTriggered: false
            },
            {
                pct: CONFIG.TP2_PCT,
                targetPx: side === 'BUY' ? entryPrice + tpRange * 1.5 : entryPrice - tpRange * 1.5,
                isTriggered: false
            }
        ];
    }
    /**
     * Total notional value of all open positions across every symbol
     */
    getTotalGrossNotionalUsd() {
        let total = 0;
        for (const positions of this.activePositions.values()) {
            for (const p of positions) {
                total += p.entryPrice * (p.remainingQty ?? p.quantity);
            }
        }
        return total;
    }
    /**
     * Auto risk guards evaluated after every close:
     * 1. Consecutive-loss breaker: N losses in a row on one symbol -> short suspension.
     * 2. Rolling expectancy kill switch: if the last WINDOW trades of a symbol
     *    (min sample enforced) are net negative with WR < 50%, suspend the symbol.
     * Automates what had to be done manually for DOGE (19 trades / -$239 before lock).
     */
    evaluateSymbolRiskGuards(symbol, result) {
        const g = CONFIG.RISK_GUARDS;
        // 1. Consecutive-loss breaker
        const streak = result === 'LOSS' ? (this.symbolConsecutiveLosses.get(symbol) || 0) + 1 : 0;
        this.symbolConsecutiveLosses.set(symbol, streak);
        if (streak >= g.SYMBOL_MAX_CONSECUTIVE_LOSSES) {
            const until = Date.now() + g.SYMBOL_CONSEC_LOSS_SUSPEND_HOURS * 3600000;
            this.symbolSuspensions.set(symbol, { until, cause: `${streak} loss beruntun` });
            console.log(`\n\x1b[31m[SYMBOL GUARD] ${symbol} SUSPENDED ${g.SYMBOL_CONSEC_LOSS_SUSPEND_HOURS}h (${streak} consecutive losses)\x1b[0m\n`);
            return;
        }
        // 2. Rolling expectancy kill switch (uses closed-trade history, incl. hydrated archive)
        const recent = this.tradesHistory.filter(t => t.symbol === symbol).slice(-g.SYMBOL_KILLSWITCH_WINDOW);
        if (recent.length >= g.SYMBOL_KILLSWITCH_MIN_TRADES) {
            const netPnl = recent.reduce((s, t) => s + t.netProfitUsd, 0);
            const wins = recent.filter(t => t.netProfitUsd > 0).length;
            if (netPnl < 0 && wins / recent.length < 0.5) {
                const until = Date.now() + g.SYMBOL_KILLSWITCH_SUSPEND_HOURS * 3600000;
                this.symbolSuspensions.set(symbol, { until, cause: `expectancy negatif: $${netPnl.toFixed(2)} over ${recent.length} trade (WR ${(100 * wins / recent.length).toFixed(0)}%)` });
                console.log(`\n\x1b[31m[KILL SWITCH] ${symbol} SUSPENDED ${g.SYMBOL_KILLSWITCH_SUSPEND_HOURS}h — last ${recent.length} trades net $${netPnl.toFixed(2)}, WR ${(100 * wins / recent.length).toFixed(0)}%\x1b[0m\n`);
            }
        }
    }
    /**
     * Returns false while a symbol is suspended by the auto guards; auto-clears on expiry
     */
    checkSymbolSuspension(symbol) {
        const susp = this.symbolSuspensions.get(symbol);
        if (!susp)
            return { allowed: true };
        if (Date.now() < susp.until) {
            return { allowed: false, reason: susp.cause };
        }
        this.symbolSuspensions.delete(symbol);
        this.symbolConsecutiveLosses.set(symbol, 0);
        console.log(`\x1b[32m[SYMBOL GUARD] ${symbol} suspension expired — trading resumed\x1b[0m`);
        return { allowed: true };
    }
    /**
     * Current guard status per symbol (for dashboard / go-live report)
     */
    getSymbolGuardStatus() {
        const out = {};
        for (const [symbol, susp] of this.symbolSuspensions) {
            out[symbol] = { suspendedUntil: susp.until, cause: susp.cause };
        }
        return out;
    }
    /**
     * Forces all active positions of a symbol to close immediately at a specific market price
     */
    forceClosePosition(symbol, exitPrice, reason) {
        const positions = this.activePositions.get(symbol);
        if (!positions || positions.length === 0)
            return;
        // Close all positions for this symbol
        for (const pos of [...positions]) {
            this.closePosition(pos, exitPrice, reason);
        }
    }
    /**
     * Check if partial take-profit levels have been hit and scale out.
     * Realized gross/fees are accumulated on the position and folded into the
     * final TradeRecord at closePosition time (single source of truth per trade).
     */
    checkPartialTPs(position, currentBid, currentAsk) {
        if (!position.partialTPs || !position.remainingQty)
            return;
        if (position.partialTPs.every(tp => tp.isTriggered))
            return;
        const currentPrice = position.side === 'BUY' ? currentBid : currentAsk;
        for (const tp of position.partialTPs) {
            if (tp.isTriggered)
                continue;
            const hitTarget = position.side === 'BUY'
                ? currentPrice >= tp.targetPx
                : currentPrice <= tp.targetPx;
            if (!hitTarget)
                continue;
            const closeQty = Math.min(position.quantity * tp.pct, position.remainingQty);
            if (closeQty <= 0 || position.remainingQty < closeQty) {
                continue;
            }
            tp.isTriggered = true;
            const grossProfit = position.side === 'BUY'
                ? (currentPrice - position.entryPrice) * closeQty
                : (position.entryPrice - currentPrice) * closeQty;
            const fees = currentPrice * closeQty * CONFIG.MAKER_FEE_PCT;
            position.remainingQty -= closeQty;
            position.realizedGrossUsd = (position.realizedGrossUsd || 0) + grossProfit;
            position.realizedFeesUsd = (position.realizedFeesUsd || 0) + fees;
            (position.partialCloses = position.partialCloses || []).push({ qty: closeQty, price: currentPrice, time: Date.now() });
            console.log(`\x1b[36m[PARTIAL TP] ${position.symbol} | ${position.side} | TP hit at ${this.formatPrice(position.symbol, currentPrice)} | Closed ${(tp.pct * 100).toFixed(0)}% | Net: $${(grossProfit - fees).toFixed(4)} | Remaining qty: ${position.remainingQty.toFixed(6)}\x1b[0m`);
        }
    }
    /**
     * Closes an active position and calculates trade performance metrics
     */
    async closePosition(position, exitPrice, reason) {
        const coinConfig = Object.values(CONFIG.SYMBOLS).find(s => s.name === position.symbol);
        if (!coinConfig)
            return;
        const now = Date.now();
        const holdTimeSec = (now - position.entryTime) / 1000;
        // Record stop-loss exits for the per-symbol re-entry cooldown
        if (reason.includes('STOP LOSS')) {
            this.lastStopLossTimes.set(position.symbol, now);
        }
        // Final close only exits the REMAINING quantity; partial TP legs were already
        // realized on the position and are folded in here so the record reflects the
        // whole trade (prevents double-counting full quantity after scale-outs).
        const closedQty = position.remainingQty ?? position.quantity;
        const partialGross = position.realizedGrossUsd || 0;
        const partialFees = position.realizedFeesUsd || 0;
        // Compute gross profit based on direction
        let grossProfit = 0;
        if (position.side === 'BUY') {
            grossProfit = (exitPrice - position.entryPrice) * closedQty;
        }
        else {
            grossProfit = (position.entryPrice - exitPrice) * closedQty;
        }
        grossProfit += partialGross;
        // Compute exit fee (using MAKER rate as orders are executed via Limit orders)
        const orderValue = exitPrice * closedQty;
        const exitFee = orderValue * CONFIG.MAKER_FEE_PCT;
        const entryFee = position.entryPrice * position.quantity * CONFIG.MAKER_FEE_PCT;
        const totalFeesForTrade = entryFee + exitFee + partialFees;
        const netProfit = grossProfit - totalFeesForTrade;
        this.stats.totalFeesUsd += exitFee + partialFees;
        this.stats.grossProfitUsd += grossProfit;
        this.stats.netProfitUsd += netProfit;
        const result = netProfit > 0 ? 'WIN' : netProfit < 0 ? 'LOSS' : 'BREAKEVEN';
        // MFE/MAE as fraction of entry price (side-aware)
        const highest = position.highestPrice ?? position.entryPrice;
        const lowest = position.lowestPrice ?? position.entryPrice;
        const mfePct = position.side === 'BUY'
            ? Math.max(0, (highest - position.entryPrice) / position.entryPrice)
            : Math.max(0, (position.entryPrice - lowest) / position.entryPrice);
        const maePct = position.side === 'BUY'
            ? Math.max(0, (position.entryPrice - lowest) / position.entryPrice)
            : Math.max(0, (highest - position.entryPrice) / position.entryPrice);
        if (result === 'WIN') {
            this.stats.winningTrades++;
            this.stats.grossWinUsd = (this.stats.grossWinUsd || 0) + Math.max(0, grossProfit);
        }
        else if (result === 'LOSS') {
            this.stats.losingTrades++;
            this.stats.grossLossUsd = (this.stats.grossLossUsd || 0) + Math.abs(Math.min(0, grossProfit));
        }
        this.stats.totalTrades++;
        this.stats.winRate = (this.stats.winningTrades / this.stats.totalTrades) * 100;
        this.stats.averageHoldTimeSec =
            (this.stats.averageHoldTimeSec * (this.stats.totalTrades - 1) + holdTimeSec) / this.stats.totalTrades;
        const record = {
            id: position.id,
            symbol: position.symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            quantity: position.quantity,
            entryTime: position.entryTime,
            exitTime: now,
            holdTimeSec,
            grossProfitUsd: grossProfit,
            feesUsd: totalFeesForTrade,
            netProfitUsd: netProfit,
            result,
            entryReason: position.entryReason,
            exitReason: reason,
            modelId: this.modelId,
            entryObi: position.entryObi,
            entryZScore: position.entryZScore,
            entryConfirmations: position.entryConfirmations,
            entrySrDistancePct: position.entrySrDistancePct,
            entryRegime: position.entryRegime,
            entryTechTag: position.entryTechTag,
            mfePct,
            maePct
        };
        this.tradesHistory.push(record);
        this.saveTradesArchive();
        // Auto risk guards run after the closed trade is recorded in history
        this.evaluateSymbolRiskGuards(position.symbol, result);
        if (this.tradeMemory) {
            this.tradeMemory.add(record);
        }
        if (this.database) {
            this.database.saveTrade(record);
        }
        // NEW: Update RiskManager
        this.riskManager.updateBalance(netProfit, position.symbol, result);
        // Remove individual position from array in Map
        const existingList = this.activePositions.get(position.symbol) || [];
        const updatedList = existingList.filter(p => p.id !== position.id);
        if (updatedList.length === 0) {
            this.activePositions.delete(position.symbol);
        }
        else {
            this.activePositions.set(position.symbol, updatedList);
        }
        // Log complete exit details to console
        const partialInfo = position.partialCloses && position.partialCloses.length > 0
            ? ` | Partials: ${position.partialCloses.length} (realized $${(partialGross - partialFees).toFixed(2)})`
            : '';
        console.log(`\n\x1b[35m[TRADE CLOSED] ${position.symbol} | ${position.side} | Net P&L: $${netProfit.toFixed(4)} (${result}) | Hold Time: ${holdTimeSec.toFixed(1)}s${partialInfo} | Reason: ${reason}\x1b[0m\n`);
        this.renderDashboard();
    }
    /**
     */
    getLotDecimalPlaces(lotSize) {
        if (lotSize >= 1)
            return 0;
        const s = lotSize.toString();
        const dot = s.indexOf('.');
        return dot === -1 ? 0 : s.length - dot - 1;
    }
    /**
     * Sleek, high-frequency real-time dashboard printed to console
     */
    renderDashboard() {
        // console.clear(); // Disabled clear to prevent terminal flickering in multi-model parallel run
        console.log('\x1b[35m================================================================================\x1b[0m');
        console.log('\x1b[1m\x1b[33m                   HIGH-FREQUENCY TRADING (HFT) DASHBOARD                      \x1b[0m');
        console.log(`\x1b[37m Running Mode   : ${CONFIG.SIMULATION_MODE ? 'LIVE SIMULATION (Safe)' : 'LIVE TRADING (Real API)'}\x1b[0m`);
        console.log(`\x1b[37m Start Time     : ${new Date().toLocaleString()}\x1b[0m`);
        console.log('\x1b[35m================================================================================\x1b[0m');
        const winRateColor = this.stats.winRate >= 70 ? '\x1b[32m' : this.stats.winRate >= 50 ? '\x1b[33m' : '\x1b[31m';
        const netProfitColor = this.stats.netProfitUsd >= 0 ? '\x1b[32m' : '\x1b[31m';
        console.log(`\x1b[1m Performance Metrics:\x1b[0m`);
        console.log(`   Total Executed Trades : \x1b[1m${this.stats.totalTrades}\x1b[0m`);
        console.log(`   Wins                  : \x1b[32m${this.stats.winningTrades}\x1b[0m`);
        console.log(`   Losses                : \x1b[31m${this.stats.losingTrades}\x1b[0m`);
        console.log(`   Winning Rate          : ${winRateColor}\x1b[1m${this.stats.winRate.toFixed(2)}%\x1b[0m  \x1b[90m(Target: >70%)\x1b[0m`);
        console.log(`   Gross Profit/Loss     : ${this.stats.grossProfitUsd >= 0 ? '\x1b[32m' : '\x1b[31m'}$${this.stats.grossProfitUsd.toFixed(4)}\x1b[0m`);
        console.log(`   Exchange Fees Paid    : \x1b[31m$${this.stats.totalFeesUsd.toFixed(4)}\x1b[0m \x1b[90m(Taker Rate: ${(CONFIG.TAKER_FEE_PCT * 100).toFixed(3)}%)\x1b[0m`);
        console.log(`   Net Profit (P&L)      : ${netProfitColor}\x1b[1m$${this.stats.netProfitUsd.toFixed(4)}\x1b[0m`);
        console.log(`   Average Hold Duration : \x1b[33m${this.stats.averageHoldTimeSec.toFixed(2)} seconds\x1b[0m`);
        console.log('\x1b[35m--------------------------------------------------------------------------------\x1b[0m');
        // Active Positions
        console.log(`\x1b[1m Active Positions (Trailing Stop Loss Mode):\x1b[0m`);
        if (this.activePositions.size === 0) {
            console.log('   No active positions currently held.');
        }
        else {
            for (const [symbol, positions] of this.activePositions) {
                for (const pos of positions) {
                    const sideColor = pos.side === 'BUY' ? '\x1b[32m' : '\x1b[31m';
                    const holdTimeSec = ((Date.now() - pos.entryTime) / 1000).toFixed(1);
                    const peakPrice = pos.side === 'BUY' ? (pos.highestPrice || pos.entryPrice) : (pos.lowestPrice || pos.entryPrice);
                    const runawayText = pos.isTakeProfitTriggered ? ' [RUNAWAY]' : '';
                    console.log(`   Symbol: \x1b[1m${symbol}\x1b[0m | Side: ${sideColor}${pos.side}\x1b[0m | Entry: ${this.formatPrice(symbol, pos.entryPrice)} | SL: \x1b[31m${this.formatPrice(symbol, pos.stopLossPrice)}\x1b[0m | Peak: \x1b[32m${this.formatPrice(symbol, peakPrice)}\x1b[0m | Hold: ${holdTimeSec}s${runawayText}`);
                }
            }
        }
        console.log('\x1b[35m================================================================================\x1b[0m');
        // Recent Trade logs (last 5)
        console.log(`\x1b[1m Recent Finished Scalps:\x1b[0m`);
        const recentTrades = this.tradesHistory.slice(-5).reverse();
        if (recentTrades.length === 0) {
            console.log('   Waiting for first trade to complete...');
        }
        else {
            recentTrades.forEach(t => {
                const resultColor = t.result === 'WIN' ? '\x1b[32m' : '\x1b[31m';
                console.log(`   [${new Date(t.exitTime).toLocaleTimeString()}] ${t.symbol} | ${t.side} | Entry: ${this.formatPrice(t.symbol, t.entryPrice)} -> Exit: ${this.formatPrice(t.symbol, t.exitPrice)} | Net: ${resultColor}$${t.netProfitUsd.toFixed(3)}\x1b[0m`);
            });
        }
        console.log('\x1b[35m================================================================================\x1b[0m');
        console.log('\x1b[90m Press Ctrl+C to safely shutdown. Logs will flush to console.\x1b[0m');
    }
    getStats() {
        return this.stats;
    }
    getActivePositions() {
        const list = [];
        for (const positions of this.activePositions.values()) {
            list.push(...positions);
        }
        return list;
    }
    updatePositionTpSl(symbol, newTp, newSl) {
        const positions = this.activePositions.get(symbol);
        if (!positions || positions.length === 0)
            return false;
        const position = positions[0];
        let updated = false;
        if (newTp !== null && !isNaN(newTp) && newTp > 0) {
            position.takeProfitPrice = newTp;
            updated = true;
        }
        if (newSl !== null && !isNaN(newSl) && newSl > 0) {
            position.stopLossPrice = newSl;
            updated = true;
        }
        if (updated) {
            console.log(`\x1b[36m[TP/SL UPDATE] ${symbol} | TP: ${position.takeProfitPrice} | SL: ${position.stopLossPrice}\x1b[0m`);
        }
        return updated;
    }
    getTradesHistory() {
        return this.tradesHistory;
    }
    /**
     * Merges externally imported trades (dashboard upload) into history.
     * Triple dedupe so identical data is always ignored:
     *   1. id match (bot orderIds vs import fingerprints)
     *   2. fingerprint incl. exit time
     *   3. full content match (symbol/side/entry/exit/qty/pnl) ignoring timestamps —
     *      catches timezone-shifted or re-parsed copies of the same trade.
     */
    importTrades(records) {
        const existingIds = new Set(this.tradesHistory.map(t => t.id));
        const existingFingerprints = new Set(this.tradesHistory.map(t => tradeFingerprint(t)));
        const existingContent = new Set(this.tradesHistory.map(t => tradeContentKey(t)));
        const toInsert = [];
        let skippedDuplicate = 0;
        let skippedInvalid = 0;
        for (const raw of records || []) {
            if (!raw || typeof raw !== 'object') {
                skippedInvalid++;
                continue;
            }
            const rec = { ...raw };
            rec.symbol = String(rec.symbol || '').toUpperCase();
            rec.side = rec.side === 'SELL' ? 'SELL' : 'BUY';
            rec.entryPrice = Number(rec.entryPrice);
            rec.exitPrice = Number(rec.exitPrice);
            rec.quantity = Number(rec.quantity);
            rec.netProfitUsd = Number(rec.netProfitUsd);
            rec.exitTime = Number(rec.exitTime);
            if (!rec.symbol || !isFinite(rec.entryPrice) || !isFinite(rec.exitPrice) ||
                !isFinite(rec.quantity) || !isFinite(rec.netProfitUsd) || !isFinite(rec.exitTime)) {
                skippedInvalid++;
                continue;
            }
            rec.holdTimeSec = Number.isFinite(Number(rec.holdTimeSec))
                ? Number(rec.holdTimeSec)
                : Math.max(0, (Number(rec.exitTime) - Number(rec.entryTime)) / 1000);
            rec.entryTime = Number.isFinite(Number(rec.entryTime))
                ? Number(rec.entryTime)
                : rec.exitTime - rec.holdTimeSec * 1000;
            rec.feesUsd = Number.isFinite(Number(rec.feesUsd)) ? Number(rec.feesUsd) : 0;
            // Archive stats derive net as gross - fees; keep the identity consistent
            rec.grossProfitUsd = Number.isFinite(Number(rec.grossProfitUsd))
                ? Number(rec.grossProfitUsd)
                : rec.netProfitUsd + rec.feesUsd;
            rec.result = rec.netProfitUsd > 0 ? 'WIN' : rec.netProfitUsd < 0 ? 'LOSS' : 'BREAKEVEN';
            rec.modelId = rec.modelId || this.modelId;
            rec.id = String(rec.id || `imp_${tradeFingerprint(rec)}`);
            // Duplicate checker: exact-same data is silently ignored
            const fp = tradeFingerprint(rec);
            const contentKey = tradeContentKey(rec);
            if (existingIds.has(rec.id) || existingFingerprints.has(fp) || existingContent.has(contentKey)) {
                skippedDuplicate++;
                continue;
            }
            existingIds.add(rec.id);
            existingFingerprints.add(fp);
            existingContent.add(contentKey);
            toInsert.push(rec);
        }
        if (toInsert.length > 0) {
            this.tradesHistory.push(...toInsert);
            this.tradesHistory.sort((a, b) => a.exitTime - b.exitTime);
            this.saveTradesArchive();
            this.recalculateStats();
            for (const r of toInsert) {
                try {
                    if (this.database)
                        this.database.saveTrade(r);
                }
                catch { }
            }
            console.log(`\x1b[32m[IMPORT] ${toInsert.length} trades imported into ${this.modelId} history (${skippedDuplicate} duplicates ignored, ${skippedInvalid} invalid)\x1b[0m`);
        }
        return {
            imported: toInsert.length,
            skipped: skippedDuplicate + skippedInvalid,
            skippedDuplicate,
            skippedInvalid
        };
    }
    /**
     * Reads trade archive database to populate historical memory on startup
     */
    loadTradesArchive() {
        try {
            const filePath = path.join(process.cwd(), `trades_archive_${this.modelId}.json`);
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                this.tradesHistory = JSON.parse(data);
                this.recalculateStats();
                console.log(`\x1b[32m[PERSISTENT BRAIN] Hydrated ${this.tradesHistory.length} historical trades from trades_archive_${this.modelId}.json database.\x1b[0m`);
            }
        }
        catch (err) {
            console.error(`[PERSISTENT BRAIN] Failed to load trades archive for ${this.modelId}: ${err.message}`);
        }
    }
    /**
     * Syncs the current tradesHistory memory array with the local archive file
     */
    saveTradesArchive() {
        try {
            const filePath = path.join(process.cwd(), `trades_archive_${this.modelId}.json`);
            fs.writeFileSync(filePath, JSON.stringify(this.tradesHistory, null, 2), 'utf-8');
        }
        catch (err) {
            console.error(`[PERSISTENT BRAIN] Failed to save trades archive for ${this.modelId}: ${err.message}`);
        }
    }
    /**
     * Recalculates runtime statistics based on loaded tradesHistory records
     */
    recalculateStats() {
        if (this.tradesHistory.length === 0)
            return;
        let wins = 0;
        let losses = 0;
        let grossPnl = 0;
        let grossWins = 0;
        let grossLosses = 0;
        let fees = 0;
        let holdTimeSum = 0;
        for (const t of this.tradesHistory) {
            grossPnl += t.grossProfitUsd;
            fees += t.feesUsd;
            holdTimeSum += t.holdTimeSec;
            if (t.result === 'WIN') {
                wins++;
                grossWins += Math.max(0, t.grossProfitUsd);
            }
            else if (t.result === 'LOSS') {
                losses++;
                grossLosses += Math.abs(Math.min(0, t.grossProfitUsd));
            }
        }
        this.stats.totalTrades = this.tradesHistory.length;
        this.stats.winningTrades = wins;
        this.stats.losingTrades = losses;
        this.stats.winRate = this.stats.totalTrades > 0 ? (wins / this.stats.totalTrades) * 100 : 0;
        this.stats.grossProfitUsd = grossPnl;
        this.stats.grossWinUsd = grossWins;
        this.stats.grossLossUsd = grossLosses;
        this.stats.totalFeesUsd = fees;
        this.stats.netProfitUsd = grossPnl - fees;
        this.stats.averageHoldTimeSec = this.stats.totalTrades > 0 ? holdTimeSum / this.stats.totalTrades : 0;
    }
}
