import { TradeRecord } from './types.js';

export interface TradeAnalysis {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
}

export interface Suggestion {
  parameter: string;
  currentValue: number | string;
  suggestedValue: number | string;
  reason: string;
  impact: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  affectedTrades: number;
}

export class TradeAnalyzer {
  public analyzeHistoricalPerformance(trades: TradeRecord[], currentParams: Record<string, any>): Suggestion[] {
    const suggestions: Suggestion[] = [];
    const closedTrades = trades.filter(t => t.exitTime && t.netProfitUsd !== undefined);
    
    if (closedTrades.length < 5) {
      return suggestions;
    }

    const wins = closedTrades.filter(t => t.netProfitUsd > 0);
    const losses = closedTrades.filter(t => t.netProfitUsd <= 0);
    const winRate = wins.length / closedTrades.length;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netProfitUsd, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netProfitUsd, 0) / losses.length : 0;

    // OBI threshold analysis
    const obiSuggestion = this.analyzeOBIThreshold(closedTrades, currentParams.obiThreshold || 0.2);
    if (obiSuggestion) suggestions.push(obiSuggestion);

    // Z-Score threshold analysis
    const zScoreSuggestion = this.analyzeZScoreThreshold(closedTrades, currentParams.zScoreThreshold || 0.8);
    if (zScoreSuggestion) suggestions.push(zScoreSuggestion);

    // TP/SL ratio analysis
    const tpSlSuggestion = this.analyzeTpSlRatio(closedTrades, currentParams.takeProfitPct || 0.015, currentParams.stopLossPct || 0.005);
    if (tpSlSuggestion) suggestions.push(tpSlSuggestion);

    // Min confirmations analysis
    const confSuggestion = this.analyzeConfirmations(closedTrades, currentParams.minConfirmations ?? 2);
    if (confSuggestion) suggestions.push(confSuggestion);

    // S/R threshold analysis
    const srSuggestion = this.analyzeSrThreshold(closedTrades, currentParams.srThresholdPct || 0.01);
    if (srSuggestion) suggestions.push(srSuggestion);

    return suggestions;
  }

  private analyzeOBIThreshold(trades: TradeRecord[], current: number): Suggestion | null {
    const thresholds = [0.15, 0.18, 0.20, 0.22, 0.25, 0.30];
    let bestThreshold = current;
    let bestScore = -Infinity;
    const results: { threshold: number; winRate: number; avgProfit: number; trades: number }[] = [];

    for (const threshold of thresholds) {
      const tradesAtThresh = trades.filter(t => (t as any).obi !== undefined ? (t as any).obi > threshold : true);
      if (tradesAtThresh.length < 3) continue;
      const wr = tradesAtThresh.filter(t => t.netProfitUsd > 0).length / tradesAtThresh.length;
      const avgP = tradesAtThresh.reduce((s, t) => s + t.netProfitUsd, 0) / tradesAtThresh.length;
      const score = wr * 0.6 + (avgP > 0 ? 1 : 0) * 0.4;
      results.push({ threshold, winRate: wr, avgProfit: avgP, trades: tradesAtThresh.length });
      if (score > bestScore) {
        bestScore = score;
        bestThreshold = threshold;
      }
    }

    if (bestThreshold === current || results.length === 0) return null;
    const bestResult = results.find(r => r.threshold === bestThreshold);
    const currentResult = results.find(r => r.threshold === current);
    const impact = bestResult && currentResult
      ? `Win rate: ${(currentResult.winRate * 100).toFixed(1)}% → ${(bestResult.winRate * 100).toFixed(1)}%`
      : 'Potential improvement';
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' = (bestResult?.trades || 0) > 10 ? 'HIGH' : bestResult && bestResult.trades > 5 ? 'MEDIUM' : 'LOW';

    return {
      parameter: 'obiThreshold',
      currentValue: current,
      suggestedValue: bestThreshold,
      reason: `OBI threshold ${bestThreshold} showed better risk-adjusted returns`,
      impact,
      confidence,
      affectedTrades: bestResult?.trades || 0
    };
  }

  private analyzeZScoreThreshold(trades: TradeRecord[], current: number): Suggestion | null {
    const thresholds = [0.6, 0.7, 0.8, 0.9, 1.0, 1.2];
    let bestThreshold = current;
    let bestScore = -Infinity;
    const results: { threshold: number; winRate: number; avgProfit: number; trades: number }[] = [];

    for (const threshold of thresholds) {
      const tradesAtThresh = trades.filter(t => (t as any).zScore !== undefined ? Math.abs((t as any).zScore) > threshold : true);
      if (tradesAtThresh.length < 3) continue;
      const wr = tradesAtThresh.filter(t => t.netProfitUsd > 0).length / tradesAtThresh.length;
      const avgP = tradesAtThresh.reduce((s, t) => s + t.netProfitUsd, 0) / tradesAtThresh.length;
      const score = wr * 0.6 + (avgP > 0 ? 1 : 0) * 0.4;
      results.push({ threshold, winRate: wr, avgProfit: avgP, trades: tradesAtThresh.length });
      if (score > bestScore) {
        bestScore = score;
        bestThreshold = threshold;
      }
    }

    if (bestThreshold === current || results.length === 0) return null;
    const bestResult = results.find(r => r.threshold === bestThreshold);
    const currentResult = results.find(r => r.threshold === current);
    const impact = bestResult && currentResult
      ? `Win rate: ${(currentResult.winRate * 100).toFixed(1)}% → ${(bestResult.winRate * 100).toFixed(1)}%`
      : 'Potential improvement';
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' = (bestResult?.trades || 0) > 10 ? 'HIGH' : bestResult && bestResult.trades > 5 ? 'MEDIUM' : 'LOW';

    return {
      parameter: 'zScoreThreshold',
      currentValue: current,
      suggestedValue: bestThreshold,
      reason: `Z-score threshold ${bestThreshold} filtered out more losing trades`,
      impact,
      confidence,
      affectedTrades: bestResult?.trades || 0
    };
  }

  private analyzeTpSlRatio(trades: TradeRecord[], currentTp: number, currentSl: number): Suggestion | null {
    const ratios = [
      { tp: 0.01, sl: 0.005, label: '1:2' },
      { tp: 0.015, sl: 0.005, label: '1:3' },
      { tp: 0.02, sl: 0.005, label: '1:4' },
      { tp: 0.025, sl: 0.008, label: '1:3.125' },
      { tp: 0.015, sl: 0.006, label: '1:2.5' },
    ];

    let bestRatio = { tp: currentTp, sl: currentSl };
    let bestScore = -Infinity;
    const results: { tp: number; sl: number; label: string; profit: number; trades: number }[] = [];

    for (const ratio of ratios) {
      const simulated = trades.map(t => {
        const side = t.side;
        if (side === 'BUY') {
          if ((t as any).maxPrice && (t as any).maxPrice >= ratio.tp) return ratio.tp;
          if ((t as any).minPrice && (t as any).minPrice <= ratio.sl) return -ratio.sl;
        } else {
          if ((t as any).minPrice && (t as any).minPrice <= ratio.tp) return ratio.tp;
          if ((t as any).maxPrice && (t as any).maxPrice >= ratio.sl) return -ratio.sl;
        }
        return t.netProfitUsd || 0;
      });
      const totalProfit = simulated.reduce((s, r) => s + r, 0);
      const wins = simulated.filter(r => r > 0).length;
      const wr = wins / simulated.length;
      const score = totalProfit * 0.7 + wr * 0.3;
      results.push({ tp: ratio.tp, sl: ratio.sl, label: ratio.label, profit: totalProfit, trades: simulated.length });
      if (score > bestScore) {
        bestScore = score;
        bestRatio = { tp: ratio.tp, sl: ratio.sl };
      }
    }

    if (bestRatio.tp === currentTp && bestRatio.sl === currentSl) return null;
    const bestResult = results.find(r => r.tp === bestRatio.tp && r.sl === bestRatio.sl);
    const currentResult = results.find(r => r.tp === currentTp && r.sl === currentSl);
    const impact = bestResult && currentResult
      ? `Simulated P&L: $${currentResult.profit.toFixed(2)} → $${bestResult.profit.toFixed(2)}`
      : 'Potential improvement';
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' = (bestResult?.trades || 0) > 10 ? 'HIGH' : bestResult && bestResult.trades > 5 ? 'MEDIUM' : 'LOW';

    return {
      parameter: 'tpSlRatio',
      currentValue: `TP:${currentTp}/SL:${currentSl}`,
      suggestedValue: `TP:${bestRatio.tp}/SL:${bestRatio.sl}`,
      reason: `TP/SL ratio ${bestResult?.label || 'custom'} maximizes simulated profit`,
      impact,
      confidence,
      affectedTrades: bestResult?.trades || 0
    };
  }

  private analyzeConfirmations(trades: TradeRecord[], current: number): Suggestion | null {
    const confs = [0, 1, 2, 3, 4, 5];
    let bestConf = current;
    let bestScore = -Infinity;
    const results: { conf: number; winRate: number; avgProfit: number; trades: number }[] = [];

    for (const minConf of confs) {
      const tradesAtConf = trades.filter(t => (t as any).confirmations !== undefined ? (t as any).confirmations >= minConf : true);
      if (tradesAtConf.length < 3) continue;
      const wr = tradesAtConf.filter(t => t.netProfitUsd > 0).length / tradesAtConf.length;
      const avgP = tradesAtConf.reduce((s, t) => s + t.netProfitUsd, 0) / tradesAtConf.length;
      const score = wr * 0.6 + (avgP > 0 ? 1 : 0) * 0.4;
      results.push({ conf: minConf, winRate: wr, avgProfit: avgP, trades: tradesAtConf.length });
      if (score > bestScore) {
        bestScore = score;
        bestConf = minConf;
      }
    }

    if (bestConf === current || results.length === 0) return null;
    const bestResult = results.find(r => r.conf === bestConf);
    const currentResult = results.find(r => r.conf === current);
    const impact = bestResult && currentResult
      ? `Win rate: ${(currentResult.winRate * 100).toFixed(1)}% → ${(bestResult.winRate * 100).toFixed(1)}%`
      : 'Potential improvement';
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' = (bestResult?.trades || 0) > 10 ? 'HIGH' : bestResult && bestResult.trades > 5 ? 'MEDIUM' : 'LOW';

    return {
      parameter: 'minConfirmations',
      currentValue: current,
      suggestedValue: bestConf,
      reason: `Requiring ${bestConf} confirmations improves win rate`,
      impact,
      confidence,
      affectedTrades: bestResult?.trades || 0
    };
  }

  private analyzeSrThreshold(trades: TradeRecord[], current: number): Suggestion | null {
    const thresholds = [0.005, 0.008, 0.01, 0.015, 0.02];
    let bestThreshold = current;
    let bestScore = -Infinity;
    const results: { threshold: number; winRate: number; avgProfit: number; trades: number }[] = [];

    for (const threshold of thresholds) {
      const tradesAtThresh = trades.filter(t => (t as any).srDistance !== undefined ? (t as any).srDistance <= threshold : true);
      if (tradesAtThresh.length < 3) continue;
      const wr = tradesAtThresh.filter(t => t.netProfitUsd > 0).length / tradesAtThresh.length;
      const avgP = tradesAtThresh.reduce((s, t) => s + t.netProfitUsd, 0) / tradesAtThresh.length;
      const score = wr * 0.6 + (avgP > 0 ? 1 : 0) * 0.4;
      results.push({ threshold, winRate: wr, avgProfit: avgP, trades: tradesAtThresh.length });
      if (score > bestScore) {
        bestScore = score;
        bestThreshold = threshold;
      }
    }

    if (bestThreshold === current || results.length === 0) return null;
    const bestResult = results.find(r => r.threshold === bestThreshold);
    const currentResult = results.find(r => r.threshold === current);
    const impact = bestResult && currentResult
      ? `Win rate: ${(currentResult.winRate * 100).toFixed(1)}% → ${(bestResult.winRate * 100).toFixed(1)}%`
      : 'Potential improvement';
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' = (bestResult?.trades || 0) > 10 ? 'HIGH' : bestResult && bestResult.trades > 5 ? 'MEDIUM' : 'LOW';

    return {
      parameter: 'srThresholdPct',
      currentValue: current,
      suggestedValue: bestThreshold,
      reason: `S/R threshold ${(bestThreshold * 100).toFixed(1)}% captures more valid setups`,
      impact,
      confidence,
      affectedTrades: bestResult?.trades || 0
    };
  }
}
