/**
 * Advanced Risk Manager Module
 *
 * Features:
 * - Daily drawdown limit (auto-pause on threshold breach)
 * - Kelly Criterion position sizing
 * - ATR-based dynamic position sizing
 * - Session-based trading filters
 * - Portfolio-level risk controls
 * - Sharpe / Sortino / Calmar Ratio
 * - VaR 95% / Expected Shortfall
 * - Consecutive loss tracking
 * - Win/Loss ratio analysis
 * - Equity curve management
 */
import { CONFIG } from './config.js';
export class RiskManager {
    dailyStartBalance = CONFIG.ACCOUNT_BALANCE_USD;
    currentBalance = CONFIG.ACCOUNT_BALANCE_USD;
    dailyPeakBalance = CONFIG.ACCOUNT_BALANCE_USD;
    isPausedForDay = false;
    pauseDate = '';
    dailyTrades = 0;
    dailyLosses = 0;
    // Performance tracking per symbol
    symbolStats = new Map();
    // Equity curve & metrics
    equityCurve = [];
    allTradeRecords = [];
    consecutiveLosses = 0;
    maxConsecutiveLosses = 0;
    // Track all daily balances for metric calculations
    allBalances = [];
    dailyReturns = [];
    constructor() {
        this.resetDaily();
    }
    /**
     * Reset daily counters (call at start of each trading day)
     */
    resetDaily() {
        const today = new Date().toDateString();
        if (this.pauseDate !== today) {
            this.dailyStartBalance = this.currentBalance;
            this.dailyPeakBalance = this.currentBalance;
            this.isPausedForDay = false;
            this.dailyTrades = 0;
            this.dailyLosses = 0;
        }
    }
    /**
     * Update balance after a trade closes
     */
    updateBalance(profitLoss, symbol, result) {
        // Track previous balance for return calculation
        const prevBalance = this.currentBalance;
        this.currentBalance += profitLoss;
        this.dailyTrades++;
        if (result === 'LOSS') {
            this.dailyLosses++;
            this.consecutiveLosses++;
            if (this.consecutiveLosses > this.maxConsecutiveLosses) {
                this.maxConsecutiveLosses = this.consecutiveLosses;
            }
        }
        else if (result === 'WIN') {
            this.consecutiveLosses = 0;
        }
        // Track per-symbol performance
        const existing = this.symbolStats.get(symbol) || { wins: 0, losses: 0, totalPnl: 0, trades: 0 };
        existing.trades++;
        existing.totalPnl += profitLoss;
        if (result === 'WIN')
            existing.wins++;
        else if (result === 'LOSS')
            existing.losses++;
        this.symbolStats.set(symbol, existing);
        // Track peak balance for drawdown calculation
        if (this.currentBalance > this.dailyPeakBalance) {
            this.dailyPeakBalance = this.currentBalance;
        }
        // Build equity curve (snapshot setiap trade closes)
        this.equityCurve.push(this.currentBalance);
        this.allBalances.push(this.currentBalance);
        // Calculate daily return
        if (prevBalance > 0) {
            this.dailyReturns.push((this.currentBalance - prevBalance) / prevBalance);
        }
        // Check daily drawdown limit
        const dailyDrawdown = (this.dailyPeakBalance - this.currentBalance) / this.dailyPeakBalance;
        if (dailyDrawdown >= CONFIG.DAILY_DRAWDOWN_LIMIT_PCT) {
            this.isPausedForDay = true;
            this.pauseDate = new Date().toDateString();
            console.log(`\n\x1b[31m[RISK MANAGER] ⛔ DAILY DRAWDOWN LIMIT REACHED! ${(dailyDrawdown * 100).toFixed(2)}% >= ${(CONFIG.DAILY_DRAWDOWN_LIMIT_PCT * 100).toFixed(2)}%. Trading PAUSED until next day.\x1b[0m\n`);
        }
    }
    // ================================================================
    // RISK METRICS CALCULATIONS
    // ================================================================
    /**
     * Calculate comprehensive risk metrics
     */
    calculateRiskMetrics(trades) {
        this.allTradeRecords = trades;
        const wins = trades.filter(t => t.result === 'WIN');
        const losses = trades.filter(t => t.result === 'LOSS');
        const totalTrades = trades.length;
        // 1. Average Win / Loss
        const avgWin = wins.length > 0
            ? wins.reduce((s, t) => s + t.netProfitUsd, 0) / wins.length
            : 0;
        const avgLoss = losses.length > 0
            ? Math.abs(losses.reduce((s, t) => s + t.netProfitUsd, 0)) / losses.length
            : 0;
        // 2. Win/Loss Ratio
        const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin;
        // 3. Profit Factor
        const grossWin = wins.reduce((s, t) => s + t.netProfitUsd, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netProfitUsd, 0));
        const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
        // 4. Expectancy (expected value per trade)
        const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;
        const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
        // 5. Max Drawdown
        let peak = -Infinity;
        let maxDrawdown = 0;
        let drawdownStart = 0;
        let drawdownEnd = 0;
        let currentDrawdownStart = 0;
        for (let i = 0; i < this.equityCurve.length; i++) {
            const value = this.equityCurve[i];
            if (value > peak) {
                peak = value;
                currentDrawdownStart = i;
            }
            const dd = (peak - value) / peak;
            if (dd > maxDrawdown) {
                maxDrawdown = dd;
                drawdownStart = currentDrawdownStart;
                drawdownEnd = i;
            }
        }
        // 6. Sharpe Ratio (annualized, assuming risk-free rate = 0 for crypto)
        let sharpeRatio = 0;
        if (this.dailyReturns.length > 1) {
            const avgReturn = this.dailyReturns.reduce((a, b) => a + b, 0) / this.dailyReturns.length;
            const variance = this.dailyReturns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / this.dailyReturns.length;
            const stdDev = Math.sqrt(variance);
            if (stdDev > 0) {
                // Annualized: multiply by sqrt(365) since we're using daily returns
                sharpeRatio = (avgReturn / stdDev) * Math.sqrt(365);
            }
        }
        // 7. Sortino Ratio (only downside deviation)
        let sortinoRatio = 0;
        if (this.dailyReturns.length > 1) {
            const avgReturn = this.dailyReturns.reduce((a, b) => a + b, 0) / this.dailyReturns.length;
            const negativeReturns = this.dailyReturns.filter(r => r < 0);
            if (negativeReturns.length > 0) {
                const downVariance = negativeReturns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / negativeReturns.length;
                const downDev = Math.sqrt(downVariance);
                if (downDev > 0) {
                    sortinoRatio = (avgReturn / downDev) * Math.sqrt(365);
                }
            }
        }
        // 8. Calmar Ratio (return / max drawdown)
        const totalReturn = this.equityCurve.length > 1
            ? (this.equityCurve[this.equityCurve.length - 1] - this.equityCurve[0]) / this.equityCurve[0]
            : 0;
        const calmarRatio = maxDrawdown > 0 ? totalReturn / maxDrawdown : totalReturn;
        // 9. VaR 95% (Value at Risk)
        const tradeReturns = trades.map(t => t.netProfitUsd).sort((a, b) => a - b);
        const var95 = tradeReturns.length > 0
            ? tradeReturns[Math.max(0, Math.floor(tradeReturns.length * 0.05))]
            : 0;
        // 10. Expected Shortfall (CVaR) — average loss beyond VaR
        const varIndex = Math.floor(tradeReturns.length * 0.05);
        const tailLosses = tradeReturns.slice(0, Math.max(1, varIndex));
        const expectedShortfall = tailLosses.length > 0
            ? tailLosses.reduce((a, b) => a + b, 0) / tailLosses.length
            : 0;
        // 11. Risk of Ruin (probability of losing 50% of account)
        const riskOfRuin = this.calculateRiskOfRuin(winRate, avgWinLossRatio);
        // 12. Ulcer Index (drawdown depth & duration)
        const ulcerIndex = this.calculateUlcerIndex();
        return {
            sharpeRatio: parseFloat(sharpeRatio.toFixed(4)),
            sortinoRatio: parseFloat(sortinoRatio.toFixed(4)),
            calmarRatio: parseFloat(calmarRatio.toFixed(4)),
            maxDrawdown: parseFloat((maxDrawdown * 100).toFixed(2)), // in percentage
            profitFactor: profitFactor === Infinity ? 999 : parseFloat(profitFactor.toFixed(4)),
            var95: parseFloat(var95.toFixed(4)),
            expectedShortfall: parseFloat(expectedShortfall.toFixed(4)),
            consecutiveLosses: this.maxConsecutiveLosses,
            avgWin: parseFloat(avgWin.toFixed(4)),
            avgLoss: parseFloat(avgLoss.toFixed(4)),
            avgWinLossRatio: parseFloat(avgWinLossRatio.toFixed(4)),
            expectancy: parseFloat(expectancy.toFixed(4)),
            riskOfRuin: parseFloat((riskOfRuin * 100).toFixed(2)), // in percentage
            ulcerIndex: parseFloat(ulcerIndex.toFixed(4))
        };
    }
    /**
     * Calculate Risk of Ruin
     * Probability of losing X% of account based on win rate and avg W/L ratio
     */
    calculateRiskOfRuin(winRate, avgWinLossRatio) {
        if (winRate <= 0 || winRate >= 1)
            return 0;
        if (avgWinLossRatio <= 0)
            return 1;
        const ruinThreshold = 0.5; // 50% drawdown = ruin
        // Simplified risk of ruin formula
        const p = winRate; // probability of win
        const q = 1 - p; // probability of loss
        const r = avgWinLossRatio; // win/loss ratio
        // Kelly optimal fraction
        const kelly = p - (q / r);
        if (kelly <= 0)
            return 1; // Negative expectancy → certain ruin
        // Probability of ruin (simplified)
        const ruinProb = Math.pow((1 - kelly) / (1 + kelly), 1 / ruinThreshold);
        return Math.min(1, Math.max(0, ruinProb));
    }
    /**
     * Calculate Ulcer Index — measures both depth and duration of drawdowns
     */
    calculateUlcerIndex() {
        if (this.equityCurve.length < 2)
            return 0;
        let peak = this.equityCurve[0];
        let sumSquaredDD = 0;
        for (const value of this.equityCurve) {
            if (value > peak)
                peak = value;
            const dd = (peak - value) / peak;
            sumSquaredDD += dd * dd;
        }
        return Math.sqrt(sumSquaredDD / this.equityCurve.length);
    }
    /**
     * Get equity curve data for dashboard
     */
    getEquityCurve() {
        // If we have trade timestamps linked to equity, use them
        // Otherwise just return index-based
        return this.equityCurve.map((equity, index) => ({
            time: index,
            equity: parseFloat(equity.toFixed(2))
        }));
    }
    /**
     * Get latest metrics snapshot for dashboard
     */
    getLatestMetrics(trades) {
        return this.calculateRiskMetrics(trades);
    }
    // ================================================================
    // EXISTING METHODS (unchanged)
    // ================================================================
    /**
     * Check if trading is allowed (not paused, good session, etc.)
     */
    isTradingAllowed() {
        if (this.isPausedForDay) {
            const today = new Date().toDateString();
            if (this.pauseDate !== today) {
                this.resetDaily();
                return true;
            }
            return false;
        }
        if (!this.isInTradingSession()) {
            return false;
        }
        return true;
    }
    isInTradingSession() {
        const now = new Date();
        const hourUtc = now.getUTCHours();
        const start = CONFIG.TRADING_SESSION_START_HOUR_UTC;
        const end = CONFIG.TRADING_SESSION_END_HOUR_UTC;
        if (start <= end) {
            return hourUtc >= start && hourUtc < end;
        }
        else {
            return hourUtc >= start || hourUtc < end;
        }
    }
    getTradingSession() {
        const now = new Date();
        const hourUtc = now.getUTCHours();
        const minuteUtc = now.getUTCMinutes();
        const timeDecimal = hourUtc + minuteUtc / 60;
        const isAsian = timeDecimal >= 0 && timeDecimal < 9;
        const isLondon = timeDecimal >= 8 && timeDecimal < 17;
        const isNewYork = timeDecimal >= 13 && timeDecimal < 22;
        if (isLondon && isNewYork)
            return 'OVERLAP';
        if (isAsian && isLondon)
            return 'OVERLAP';
        if (isAsian)
            return 'ASIAN';
        if (isLondon)
            return 'LONDON';
        if (isNewYork)
            return 'NEW_YORK';
        return 'OFF_HOURS';
    }
    calculatePositionSize(stats, symbol, atr, entryPrice, stopPrice, confidence) {
        let baseRisk = CONFIG.BASE_RISK_PER_TRADE_USD;
        if (confidence === 'LOW') {
            baseRisk *= 0.5;
        }
        if (stats.totalTrades >= 20) {
            const winRate = stats.winRate / 100;
            // Use clean win-only / loss-only gross figures (fall back to net-derived estimate
            // for archives recorded before grossWinUsd/grossLossUsd existed).
            const avgWin = stats.grossWinUsd !== undefined && stats.winningTrades > 0
                ? stats.grossWinUsd / stats.winningTrades
                : 0;
            const avgLoss = stats.grossLossUsd !== undefined && stats.losingTrades > 0
                ? stats.grossLossUsd / stats.losingTrades
                : baseRisk;
            if (avgWin > 0 && avgLoss > 0) {
                const r = avgWin / avgLoss;
                const kelly = winRate - ((1 - winRate) / r);
                const fractionKelly = Math.max(0, Math.min(0.5, kelly * CONFIG.KELLY_FRACTION));
                // Bounded tilt around base risk (0.75x - 1.25x). The previous formula
                // `fractionKelly * 10` amplified risk up to ~5x right after a hot streak,
                // which produced the doubled-position window and the worst losses of the run.
                baseRisk *= Math.max(0.75, Math.min(1.25, 0.75 + fractionKelly));
            }
        }
        const riskDistance = Math.abs(entryPrice - stopPrice);
        const atrMultiplier = riskDistance > 0
            ? Math.max(CONFIG.ATR_MULTIPLIER_MIN, Math.min(CONFIG.ATR_MULTIPLIER_MAX, atr / riskDistance))
            : 1;
        const adjustedRisk = baseRisk * atrMultiplier;
        if (riskDistance <= 0)
            return 0;
        const quantity = (adjustedRisk / riskDistance);
        const maxRiskAmount = CONFIG.ACCOUNT_BALANCE_USD * CONFIG.MAX_POSITION_RISK_PCT;
        const finalQuantity = Math.min(quantity, maxRiskAmount / riskDistance);
        return Math.max(0, parseFloat(finalQuantity.toFixed(6)));
    }
    getSymbolStats(symbol) {
        return this.symbolStats.get(symbol) || null;
    }
    getPerformanceAttribution() {
        const results = [];
        for (const [symbol, data] of this.symbolStats) {
            results.push({
                symbol,
                totalTrades: data.trades,
                winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
                netProfitUsd: parseFloat(data.totalPnl.toFixed(4)),
                profitFactor: data.losses > 0 ? (data.wins > 0 ? data.wins / data.losses : 0) : data.wins,
                trades: data.trades,
                wins: data.wins,
                losses: data.losses
            });
        }
        return results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
    }
    getIsPaused() {
        return this.isPausedForDay;
    }
    getCurrentBalance() {
        return this.currentBalance;
    }
    getDailyDrawdownPct() {
        return (this.dailyPeakBalance - this.currentBalance) / this.dailyPeakBalance;
    }
    getMaxConsecutiveLosses() {
        return this.maxConsecutiveLosses;
    }
    getConsecutiveLosses() {
        return this.consecutiveLosses;
    }
}
