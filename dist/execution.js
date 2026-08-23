import { CONFIG } from './config.js';
import { RiskManager } from './risk_manager.js';
import fs from 'fs';
import path from 'path';
export class ExecutionEngine {
    activePositions = new Map();
    tradesHistory = [];
    exchange;
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
                // Progressive Trailing Stop Tightening: tighter SL as profit climbs
                let activeStopLossPct = stopLossPct;
                if (profitPct > 0) {
                    const profitRatio = profitPct / takeProfitPct;
                    if (profitRatio >= 1.0 || position.isTakeProfitTriggered) {
                        // Runaway profit mode: trails extremely tight behind peak price
                        activeStopLossPct = stopLossPct * CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER;
                    }
                    else {
                        // Smoothly interpolate from original SL to tight runaway SL
                        const tightSl = stopLossPct * CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER;
                        activeStopLossPct = stopLossPct - (stopLossPct - tightSl) * profitRatio;
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
                const activationBuffer = position.entryPrice * (1 + roundtripFeePct + 0.001); // 0.1% buffer
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
                // Progressive Trailing Stop Tightening: tighter SL as profit drops
                let activeStopLossPct = stopLossPct;
                if (profitPct > 0) {
                    const profitRatio = profitPct / takeProfitPct;
                    if (profitRatio >= 1.0 || position.isTakeProfitTriggered) {
                        activeStopLossPct = stopLossPct * CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER;
                    }
                    else {
                        const tightSl = stopLossPct * CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER;
                        activeStopLossPct = stopLossPct - (stopLossPct - tightSl) * profitRatio;
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
                const activationBuffer = position.entryPrice * (1 - roundtripFeePct - 0.001); // 0.1% buffer
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
        const quantity = this.riskManager.calculatePositionSize(this.stats, signal.symbol, atr, entryPrice, stopLossPrice, signal.confidence);
        if (quantity <= 0) {
            console.log(`\x1b[90m[SIZING SKIP] ${signal.symbol} | ATR: ${atr.toFixed(6)} | Entry: ${entryPrice.toFixed(2)} | SL: ${stopLossPrice.toFixed(2)} | RiskDist: ${Math.abs(entryPrice - stopLossPrice).toFixed(2)} | Qty: ${quantity.toFixed(6)}\x1b[0m`);
            return;
        }
        console.log(`\x1b[36m[SIGNAL ENTRY] ${signal.symbol} | ${signal.side} at ${this.formatPrice(signal.symbol, entryPrice)} | qty: ${quantity.toFixed(6)} | SL: ${this.formatPrice(signal.symbol, stopLossPrice)} | TP: ${this.formatPrice(signal.symbol, takeProfitPrice)}\x1b[0m`);
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
                    remainingQty: quantity
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
     * Check if partial take-profit levels have been hit and scale out
     */
    checkPartialTPs(position, currentBid, currentAsk) {
        if (!position.partialTPs || position.partialTPs.every(tp => tp.isTriggered))
            return;
        const currentPrice = position.side === 'BUY' ? currentBid : currentAsk;
        for (const tp of position.partialTPs) {
            if (tp.isTriggered)
                continue;
            const hitTarget = position.side === 'BUY'
                ? currentPrice >= tp.targetPx
                : currentPrice <= tp.targetPx;
            if (hitTarget) {
                tp.isTriggered = true;
                const closeQty = position.quantity * tp.pct;
                if (closeQty > 0 && position.remainingQty && position.remainingQty >= closeQty) {
                    const grossProfit = position.side === 'BUY'
                        ? (currentPrice - position.entryPrice) * closeQty
                        : (position.entryPrice - currentPrice) * closeQty;
                    const fees = currentPrice * closeQty * CONFIG.MAKER_FEE_PCT;
                    const netProfit = grossProfit - fees;
                    position.remainingQty -= closeQty;
                    console.log(`\x1b[36m[PARTIAL TP] ${position.symbol} | ${position.side} | TP hit at ${this.formatPrice(position.symbol, currentPrice)} | Closed ${(tp.pct * 100).toFixed(0)}% | Net: $${netProfit.toFixed(4)}\x1b[0m`);
                }
            }
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
        // Compute gross profit based on direction
        let grossProfit = 0;
        if (position.side === 'BUY') {
            grossProfit = (exitPrice - position.entryPrice) * position.quantity;
        }
        else {
            grossProfit = (position.entryPrice - exitPrice) * position.quantity;
        }
        // Compute exit fee (using MAKER rate as orders are executed via Limit orders)
        const orderValue = exitPrice * position.quantity;
        const exitFee = orderValue * CONFIG.MAKER_FEE_PCT;
        const entryFee = position.entryPrice * position.quantity * CONFIG.MAKER_FEE_PCT;
        const totalFeesForTrade = entryFee + exitFee;
        const netProfit = grossProfit - totalFeesForTrade;
        this.stats.totalFeesUsd += exitFee;
        this.stats.grossProfitUsd += grossProfit;
        this.stats.netProfitUsd += netProfit;
        const result = netProfit > 0 ? 'WIN' : netProfit < 0 ? 'LOSS' : 'BREAKEVEN';
        if (result === 'WIN') {
            this.stats.winningTrades++;
        }
        else if (result === 'LOSS') {
            this.stats.losingTrades++;
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
            modelId: this.modelId
        };
        this.tradesHistory.push(record);
        this.saveTradesArchive();
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
        console.log(`\n\x1b[35m[TRADE CLOSED] ${position.symbol} | ${position.side} | Net P&L: $${netProfit.toFixed(4)} (${result}) | Hold Time: ${holdTimeSec.toFixed(1)}s | Reason: ${reason}\x1b[0m\n`);
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
        let fees = 0;
        let holdTimeSum = 0;
        for (const t of this.tradesHistory) {
            grossPnl += t.grossProfitUsd;
            fees += t.feesUsd;
            holdTimeSum += t.holdTimeSec;
            if (t.result === 'WIN')
                wins++;
            else if (t.result === 'LOSS')
                losses++;
        }
        this.stats.totalTrades = this.tradesHistory.length;
        this.stats.winningTrades = wins;
        this.stats.losingTrades = losses;
        this.stats.winRate = this.stats.totalTrades > 0 ? (wins / this.stats.totalTrades) * 100 : 0;
        this.stats.grossProfitUsd = grossPnl;
        this.stats.totalFeesUsd = fees;
        this.stats.netProfitUsd = grossPnl - fees;
        this.stats.averageHoldTimeSec = this.stats.totalTrades > 0 ? holdTimeSum / this.stats.totalTrades : 0;
    }
}
