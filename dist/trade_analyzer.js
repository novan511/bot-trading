// ============================================================
// Statistical guardrails: without these, tiny samples produce noise dressed up as insight
// ============================================================
const RECENCY_WINDOW = 100; // analyze at most the last N closed trades
const MIN_CLOSED_TRADES = 10; // minimum closed trades before ANY analysis
const MIN_BUCKET = 8; // minimum trades supporting a candidate bucket
const WILSON_Z = 1.64; // one-sided ~95%
const MAX_DELTA_RATIO = 2.0; // suggested value must stay within [current/2, current*2]
/**
 * Wilson score lower bound: conservative win-rate estimate that punishes small buckets.
 */
function wilsonLowerBound(wins, n) {
    if (n === 0)
        return 0;
    const p = wins / n;
    const z = WILSON_Z;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return Math.max(0, (centre - margin) / denom);
}
function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}
function confidenceFromSize(n) {
    if (n >= 30)
        return 'HIGH';
    if (n >= 15)
        return 'MEDIUM';
    return 'LOW';
}
export class TradeAnalyzer {
    /**
     * Multi-dimension Bayesian-style breakdown of recent trade history:
     * which side / symbol / regime / indicator-tag combinations make or lose money.
     * This is the evidence base the Thinking Hub fine-tuning panel surfaces.
     */
    computeBreakdown(trades) {
        const closed = trades.filter(t => t.exitTime && t.netProfitUsd !== undefined);
        const recent = [...closed].sort((a, b) => b.exitTime - a.exitTime).slice(0, RECENCY_WINDOW);
        const bucketStat = (key, bucket) => {
            const wins = bucket.filter(t => t.netProfitUsd > 0);
            const losses = bucket.filter(t => t.netProfitUsd <= 0);
            const avgWin = wins.length ? wins.reduce((s, t) => s + t.netProfitUsd, 0) / wins.length : 0;
            const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netProfitUsd, 0) / losses.length : 0;
            return {
                key,
                trades: bucket.length,
                winRate: bucket.length ? wins.length / bucket.length : 0,
                netProfitUsd: bucket.reduce((s, t) => s + (t.netProfitUsd || 0), 0),
                avgWinUsd: avgWin,
                avgLossUsd: avgLoss
            };
        };
        const groupStats = (keyFn) => {
            const groups = {};
            for (const t of recent) {
                const keys = keyFn(t);
                if (!keys)
                    continue;
                for (const k of Array.isArray(keys) ? keys : [keys]) {
                    (groups[k] = groups[k] || []).push(t);
                }
            }
            return Object.entries(groups)
                .map(([k, v]) => bucketStat(k, v))
                .sort((a, b) => b.trades - a.trades);
        };
        return {
            bySide: groupStats(t => t.side),
            bySymbol: groupStats(t => t.symbol)
                .slice()
                .sort((a, b) => a.netProfitUsd - b.netProfitUsd), // worst first for quick toxic scan
            byRegime: groupStats(t => t.entryRegime || (t.entryReason?.match(/Regime:\s*([A-Z_]+)/)?.[1])),
            byTag: groupStats(t => {
                if (t.entryTechTag)
                    return t.entryTechTag.split(',').map(s => s.trim()).filter(Boolean);
                // Legacy records: parse from entryReason text so old history stays analyzable
                if (!t.entryReason)
                    return undefined;
                const tags = t.entryReason.split('|')[0].trim().split(/\s+/)
                    .map(s => s.replace(/\(.*?\)/g, '').replace(/[\[\]]/g, '').trim())
                    .filter(s => s.length > 2 && !/^(OBI|Z)/.test(s));
                return tags.length ? tags : undefined;
            })
        };
    }
    analyzeHistoricalPerformance(trades, currentParams) {
        const suggestions = [];
        const closedTrades = trades.filter(t => t.exitTime && t.netProfitUsd !== undefined);
        if (closedTrades.length < MIN_CLOSED_TRADES) {
            return suggestions;
        }
        // Recency window: newest trades dominate; old regimes mislead
        const recent = [...closedTrades].sort((a, b) => b.exitTime - a.exitTime).slice(0, RECENCY_WINDOW);
        // OBI threshold analysis (side-aware, requires recorded entryObi)
        const obiEligible = recent.filter(t => typeof t.entryObi === 'number');
        const obiSuggestion = this.analyzeThresholdParam('obiThreshold', obiEligible, currentParams.obiThreshold || 0.2, [0.15, 0.18, 0.20, 0.22, 0.25, 0.30], (t, v) => t.side === 'BUY' ? t.entryObi > v : t.entryObi < -v);
        if (obiSuggestion)
            suggestions.push(obiSuggestion);
        // Z-Score threshold analysis (requires recorded entryZScore)
        const zEligible = recent.filter(t => typeof t.entryZScore === 'number');
        const zScoreSuggestion = this.analyzeThresholdParam('zScoreThreshold', zEligible, currentParams.zScoreThreshold || 0.8, [0.6, 0.7, 0.8, 0.9, 1.0, 1.2], (t, v) => Math.abs(t.entryZScore) > v);
        if (zScoreSuggestion)
            suggestions.push(zScoreSuggestion);
        // Min confirmations analysis (requires recorded entryConfirmations)
        const confEligible = recent.filter(t => typeof t.entryConfirmations === 'number');
        const confSuggestion = this.analyzeThresholdParam('minConfirmations', confEligible, currentParams.minConfirmations ?? 1, [0, 1, 2, 3, 4], (t, v) => t.entryConfirmations >= v);
        if (confSuggestion)
            suggestions.push(confSuggestion);
        // S/R distance threshold analysis (requires recorded entrySrDistancePct)
        const srEligible = recent.filter(t => typeof t.entrySrDistancePct === 'number');
        const srSuggestion = this.analyzeThresholdParam('srThresholdPct', srEligible, currentParams.srThresholdPct || 0.01, [0.005, 0.008, 0.01, 0.015, 0.02], (t, v) => t.entrySrDistancePct <= v);
        if (srSuggestion)
            suggestions.push(srSuggestion);
        // TP/SL ratio analysis via MFE/MAE counterfactual simulation
        const tpSlSuggestion = this.analyzeTpSlRatio(recent, currentParams.takeProfitPct || 0.015, currentParams.stopLossPct || 0.005);
        if (tpSlSuggestion)
            suggestions.push(tpSlSuggestion);
        return suggestions;
    }
    /**
     * Generic threshold-parameter analysis.
     * Trades WITHOUT the required context field are excluded from every bucket
     * (never silently treated as passing) — insufficient context yields no suggestion.
     */
    analyzeThresholdParam(parameter, eligible, current, candidates, passes) {
        if (eligible.length < MIN_BUCKET)
            return null;
        // Evaluate candidate grid plus the currently-running value
        const grid = Array.from(new Set([...candidates, current])).sort((a, b) => a - b);
        const results = [];
        for (const value of grid) {
            const bucket = eligible.filter(t => passes(t, value));
            if (bucket.length < MIN_BUCKET)
                continue;
            results.push(this.scoreBucket(value, bucket));
        }
        if (results.length < 2)
            return null;
        const currentResult = results.find(r => r.value === current);
        const best = results.reduce((a, b) => (this.rankScore(b) > this.rankScore(a) ? b : a));
        if (!currentResult || best.value === currentResult.value)
            return null;
        // Require statistically-meaningful improvement over the running value
        const lbMarginOk = best.winRateLb > currentResult.winRateLb + 0.02;
        const returnOk = best.avgReturnPct > currentResult.avgReturnPct;
        if (!lbMarginOk || !returnOk)
            return null;
        // Delta guardrail: no wild leaps off weak evidence
        if (current > 0 && (best.value < current / MAX_DELTA_RATIO || best.value > current * MAX_DELTA_RATIO))
            return null;
        const impact = `Win rate: ${(currentResult.winRateRaw * 100).toFixed(1)}% \u2192 ${(best.winRateRaw * 100).toFixed(1)}% | Avg net/trade: ${(currentResult.avgReturnPct * 100).toFixed(3)}% \u2192 ${(best.avgReturnPct * 100).toFixed(3)}%`;
        return {
            parameter,
            currentValue: current,
            suggestedValue: best.value,
            reason: `${parameter} ${best.value} outperformed ${current} across ${best.trades} matching trades (Wilson-bound verified, last ${eligible.length} trades)`,
            impact,
            confidence: confidenceFromSize(best.trades),
            affectedTrades: best.trades
        };
    }
    /**
     * Ranks buckets: conservative (Wilson LB) win rate dominates, avg net return breaks ties.
     */
    rankScore(r) {
        const returnCredit = clamp01(0.5 + r.avgReturnPct / 0.02); // +2% avg net return = full credit
        return r.winRateLb * 0.6 + returnCredit * 0.4;
    }
    scoreBucket(value, bucket) {
        const wins = bucket.filter(t => t.netProfitUsd > 0).length;
        const notional = bucket.reduce((s, t) => s + t.entryPrice * t.quantity, 0);
        const avgReturnPct = notional > 0
            ? bucket.reduce((s, t) => s + t.netProfitUsd, 0) / notional
            : 0;
        return {
            value,
            trades: bucket.length,
            winRateLb: wilsonLowerBound(wins, bucket.length),
            winRateRaw: wins / bucket.length,
            avgReturnPct
        };
    }
    /**
     * Counterfactual TP/SL simulation from MFE/MAE fractions.
     * For each candidate ratio, replay each trade: if adverse excursion reached SL first
     * (conservative assumption when both are reachable), the trade loses -sl; if favorable
     * excursion reached TP, it wins +tp; otherwise the realized fractional return applies.
     */
    analyzeTpSlRatio(trades, currentTp, currentSl) {
        const simTrades = trades.filter(t => typeof t.mfePct === 'number' && typeof t.maePct === 'number');
        if (simTrades.length < MIN_BUCKET)
            return null;
        const ratios = [
            { tp: 0.01, sl: 0.005, label: '1:2' },
            { tp: 0.015, sl: 0.005, label: '1:3' },
            { tp: 0.02, sl: 0.005, label: '1:4' },
            { tp: 0.025, sl: 0.008, label: '1:3.125' },
            { tp: 0.015, sl: 0.006, label: '1:2.5' },
        ];
        // Include the running pair so comparison is apples-to-apples
        if (!ratios.some(r => Math.abs(r.tp - currentTp) < 1e-9 && Math.abs(r.sl - currentSl) < 1e-9)) {
            ratios.push({ tp: currentTp, sl: currentSl, label: 'current' });
        }
        let best = null;
        let bestScore = -Infinity;
        let bestStats = { avgRet: 0, wr: 0, n: 0 };
        let currentStats = { avgRet: 0, wr: 0, n: 0 };
        for (const ratio of ratios) {
            const returns = simTrades.map(t => {
                const mfe = t.mfePct;
                const mae = t.maePct;
                if (mae >= ratio.sl)
                    return -ratio.sl;
                if (mfe >= ratio.tp)
                    return ratio.tp;
                const notional = t.entryPrice * t.quantity;
                return notional > 0 ? t.netProfitUsd / notional : 0;
            });
            const n = returns.length;
            const avgRet = returns.reduce((s, r) => s + r, 0) / n;
            const wr = returns.filter(r => r > 0).length / n;
            const stats = { avgRet, wr, n };
            if (Math.abs(ratio.tp - currentTp) < 1e-9 && Math.abs(ratio.sl - currentSl) < 1e-9) {
                currentStats = stats;
            }
            const score = avgRet * 100 * 0.7 + wr * 0.3;
            if (score > bestScore) {
                bestScore = score;
                best = ratio;
                bestStats = stats;
            }
        }
        if (!best || (Math.abs(best.tp - currentTp) < 1e-9 && Math.abs(best.sl - currentSl) < 1e-9))
            return null;
        if (currentStats.n === 0)
            return null;
        // Only suggest when simulated avg return actually improves on the running pair
        if (!(bestStats.avgRet > currentStats.avgRet + 0.0005))
            return null;
        return {
            parameter: 'tpSlRatio',
            currentValue: `TP:${currentTp}/SL:${currentSl}`,
            suggestedValue: `TP:${best.tp}/SL:${best.sl}`,
            reason: `TP:${best.tp}/SL:${best.sl} (${best.label}) improved simulated avg net/trade to ${(bestStats.avgRet * 100).toFixed(3)}% vs ${(currentStats.avgRet * 100).toFixed(3)}% on ${simTrades.length} replayed trades (MFE/MAE)`,
            impact: `Simulated WR: ${(currentStats.wr * 100).toFixed(1)}% \u2192 ${(bestStats.wr * 100).toFixed(1)}%`,
            confidence: confidenceFromSize(simTrades.length),
            affectedTrades: simTrades.length
        };
    }
}
