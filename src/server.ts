import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { IExchangeConnector } from './exchange.interface.js';
import { AITradeAnalyzer } from './ai_trade_analyzer.js';
import { TradeAnalyzer } from './trade_analyzer.js';

// ============================================================
// Trade history import: accepts the dashboard's own CSV export,
// simplified JSON export, or full TradeRecord JSON archives.
// ============================================================
const MAX_IMPORT_ROWS = 10000;

function parseImportNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return n;
}

/** Parses display timestamps like "24/08/2026, 08:56:20" (server-local) or ISO strings. */
function parseDisplayTime(s: string): number {
  const str = String(s ?? '').trim();
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, d, mo, y, hh, mm, ss] = m;
    return new Date(+y, +mo - 1, +d, +hh, +mm, +(ss || 0)).getTime();
  }
  const t = Date.parse(str.replace(',', ''));
  return isNaN(t) ? NaN : t;
}

function parseHoldSeconds(v: unknown): number {
  const m = String(v ?? '').match(/^(-?[0-9.]+)\s*s?$/);
  return m ? parseFloat(m[1]) : NaN;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === "'") {
        if (line[i + 1] === "'") { cur += "'"; i++; }
        else inQuote = false;
      } else cur += ch;
    } else if (ch === "'") inQuote = true;
    else if (ch === ',') { cells.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function normalizeDisplayRow(row: Record<string, any>): Record<string, any> | null {
  const exitTime = row.exitTime !== undefined ? Number(row.exitTime) || parseDisplayTime(row.time) : parseDisplayTime(row.time);
  const entryPrice = parseImportNumber(row.entry);
  const exitPrice = parseImportNumber(row.exit);
  const netProfitUsd = parseImportNumber(row.pnl ?? row.netProfitUsd);
  if (!isFinite(exitTime) || !isFinite(entryPrice) || !isFinite(netProfitUsd)) return null;
  const holdSec = parseHoldSeconds(row.hold);
  const normalized: Record<string, any> = {
    symbol: String(row.symbol || ''),
    side: String(row.side || 'BUY').toUpperCase(),
    entryPrice,
    exitPrice,
    quantity: isFinite(parseImportNumber(row.qty)) ? parseImportNumber(row.qty) : 0,
    exitTime,
    entryTime: isFinite(holdSec) ? exitTime - holdSec * 1000 : exitTime,
    holdTimeSec: isFinite(holdSec) ? holdSec : 0,
    netProfitUsd,
    entryReason: String(row.reason ?? '')
  };
  // Optional extended columns (Exit Reason / MFE% / MAE%) present in newer exports
  const exitReason = String(row.exitReason ?? '').trim();
  if (exitReason) normalized.exitReason = exitReason;
  const mfeNum = parseImportNumber(row.mfePctStr);
  if (isFinite(mfeNum)) normalized.mfePct = mfeNum / 100;
  const maeNum = parseImportNumber(row.maePctStr);
  if (isFinite(maeNum)) normalized.maePct = maeNum / 100;
  return normalized;
}

export function parseImportPayload(format: string, raw: string): any[] {
  let rows: any[];
  if (format === 'json' || (!format && raw.trim().startsWith('['))) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('JSON harus berupa array of trades');
    rows = arr.map((r: any) => {
      // Full TradeRecord objects pass through; simplified display objects get normalized
      if (r && typeof r === 'object' && r.exitTime !== undefined && r.netProfitUsd !== undefined && r.entryPrice !== undefined && typeof r.entryPrice === 'number') return r;
      return normalizeDisplayRow(r);
    });
  } else {
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) throw new Error('File kosong');
    const startIdx = /^'?Time'?,/i.test(lines[0]) ? 1 : 0;
    rows = [];
    for (let i = startIdx; i < lines.length && rows.length < MAX_IMPORT_ROWS; i++) {
      const cells = splitCsvLine(lines[i]);
      if (cells.length < 9) continue;
      rows.push(normalizeDisplayRow({
        time: cells[0], symbol: cells[1], side: cells[2], entry: cells[3], exit: cells[4],
        qty: cells[5], pnl: cells[6], hold: cells[7], reason: cells[8],
        exitReason: cells.length > 9 ? cells[9] : undefined,
        mfePctStr: cells.length > 10 ? cells[10] : undefined,
        maePctStr: cells.length > 11 ? cells[11] : undefined
      }));
    }
  }
  const valid = rows.filter(Boolean).slice(0, MAX_IMPORT_ROWS);
  if (valid.length === 0) throw new Error('Tidak ada baris trade yang valid ditemukan di file');
  return valid;
}


// ============================================================
// Changelog / version control — persistent log of every bot
// update (config changes, logic fixes, tuning experiments).
// Stored in changelog.json next to the runtime archives so it
// survives restarts and can be committed to git.
// ============================================================
const CHANGELOG_FILE = 'changelog.json';
const CHANGELOG_CATEGORIES = ['CONFIG', 'STRATEGY', 'RISK', 'EXIT', 'INFRA', 'DATA', 'UI'] as const;

interface ChangelogEntry {
  id: string;
  timestamp: number;
  version: string;
  category: string;
  title: string;
  description?: string;
  reason?: string;
  impact?: string;
  configSnapshot?: Record<string, any>;
}

function readChangelogFile(): ChangelogEntry[] {
  const filePath = path.join(process.cwd(), CHANGELOG_FILE);
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf-8');
      return [];
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (err: any) {
    console.error(`[CHANGELOG] Failed to read ${CHANGELOG_FILE}: ${err.message}`);
    return [];
  }
}

function writeChangelogFile(entries: ChangelogEntry[]) {
  const filePath = path.join(process.cwd(), CHANGELOG_FILE);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

// ============================================================
// Go-Live report — statistical readiness check before switching
// from simulation to live trading. Encodes the discipline:
// PF >= 1.3, DD <= 10%, >= 100 trades, edge in >= 2 regimes,
// recent consistency, MFE-based TP suggestion, BTC benchmark.
// ============================================================
function percentileOf(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function computePnlBlock(trades: any[], balanceUsd: number) {
  const sorted = [...trades].sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0));
  const wins = sorted.filter(t => t.netProfitUsd > 0);
  const losses = sorted.filter(t => t.netProfitUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netProfitUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netProfitUsd, 0));
  let equity = balanceUsd;
  let peak = balanceUsd;
  let maxDDPct = 0;
  for (const t of sorted) {
    equity += t.netProfitUsd;
    if (equity > peak) peak = equity;
    if (peak > 0) maxDDPct = Math.max(maxDDPct, ((peak - equity) / peak) * 100);
  }
  return {
    totalTrades: sorted.length,
    winRate: sorted.length ? (wins.length / sorted.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    netPnl: sorted.reduce((s, t) => s + t.netProfitUsd, 0),
    expectancy: sorted.length ? sorted.reduce((s, t) => s + t.netProfitUsd, 0) / sorted.length : 0,
    maxDrawdownPct: maxDDPct
  };
}

function buildGoLiveReport(allTrades: any[], guards: Record<string, any>, btcDailyCandles: any[] | null, balanceUsd: number) {
  const trades = allTrades.filter(t => Number.isFinite(t?.exitTime)).sort((a, b) => a.exitTime - b.exitTime);
  const overall = computePnlBlock(trades, balanceUsd);

  // Recent consistency: last 50 closed trades
  const recent = computePnlBlock(trades.slice(-50), balanceUsd);

  // Regime breakdown
  const byRegime: Record<string, any[]> = {};
  for (const t of trades) {
    const r = String(t.entryRegime || 'UNKNOWN');
    (byRegime[r] = byRegime[r] || []).push(t);
  }
  const regimes = Object.entries(byRegime).map(([regime, ts]) => {
    const b = computePnlBlock(ts, balanceUsd);
    return { regime, totalTrades: b.totalTrades, winRate: +b.winRate.toFixed(1), profitFactor: isFinite(b.profitFactor) ? +b.profitFactor.toFixed(2) : null, netPnl: +b.netPnl.toFixed(2), edge: b.totalTrades >= 10 && b.profitFactor >= 1 };
  }).sort((a, b) => b.netPnl - a.netPnl);
  const regimesWithEdge = regimes.filter(r => r.edge).length;

  // MFE analysis on winners -> data-driven TP suggestion
  const winnerMfe = trades
    .filter(t => t.netProfitUsd > 0 && typeof t.mfePct === 'number' && t.mfePct > 0)
    .map(t => t.mfePct * 100)
    .sort((a, b) => a - b);
  const mfeAnalysis = winnerMfe.length >= 10 ? {
    sample: winnerMfe.length,
    p50: +percentileOf(winnerMfe, 50).toFixed(3),
    p75: +percentileOf(winnerMfe, 75).toFixed(3),
    p90: +percentileOf(winnerMfe, 90).toFixed(3),
    suggestedTpPct: +percentileOf(winnerMfe, 75).toFixed(3),
    note: 'TP disarankan di P75 MFE winner: separuh lebih winner tidak pernah capai angka ini (jangan TP lebih tinggi), separuhnya menembus lebih jauh (biarkan runner mengejar).'
  } : null;

  // BTC buy & hold benchmark over the exact same period
  let benchmark: any = null;
  if (btcDailyCandles && btcDailyCandles.length > 0 && trades.length > 0) {
    const from = trades[0].exitTime;
    const to = trades[trades.length - 1].exitTime;
    const inRange = btcDailyCandles.filter(c => c.time * 1000 >= from - 86400000 && c.time * 1000 <= to + 86400000);
    if (inRange.length >= 2) {
      const first = inRange[0].close;
      const last = inRange[inRange.length - 1].close;
      const btcReturnPct = ((last - first) / first) * 100;
      const botReturnPct = (overall.netPnl / balanceUsd) * 100;
      benchmark = { symbol: 'BTC', periodDays: +((to - from) / 86400000).toFixed(1), btcReturnPct: +btcReturnPct.toFixed(2), botReturnPct: +botReturnPct.toFixed(2), botBeatsBtc: botReturnPct > btcReturnPct };
    }
  }

  // Per-symbol table with rolling window + guard status merged in
  const bySymbol: Record<string, any[]> = {};
  for (const t of trades) {
    (bySymbol[t.symbol] = bySymbol[t.symbol] || []).push(t);
  }
  const symbols = Object.entries(bySymbol).map(([symbol, ts]) => {
    const b = computePnlBlock(ts, balanceUsd);
    const roll = computePnlBlock(ts.slice(-30), balanceUsd);
    const guard = guards[symbol];
    return {
      symbol,
      totalTrades: b.totalTrades,
      winRate: +b.winRate.toFixed(1),
      profitFactor: isFinite(b.profitFactor) ? +b.profitFactor.toFixed(2) : null,
      netPnl: +b.netPnl.toFixed(2),
      last30NetPnl: +roll.netPnl.toFixed(2),
      suspended: !!guard && guard.suspendedUntil > Date.now(),
      suspendCause: guard ? guard.cause : undefined
    };
  }).sort((a, b) => b.netPnl - a.netPnl);

  const checklist = [
    { key: 'sample', label: 'Sampel cukup (>= 100 trade)', pass: overall.totalTrades >= 100, value: `${overall.totalTrades} trade` },
    { key: 'pf', label: 'Profit factor >= 1.3', pass: overall.profitFactor >= 1.3, value: isFinite(overall.profitFactor) ? overall.profitFactor.toFixed(2) : '∞' },
    { key: 'dd', label: 'Max drawdown <= 10%', pass: overall.maxDrawdownPct <= 10, value: `${overall.maxDrawdownPct.toFixed(1)}%` },
    { key: 'consistency', label: '50 trade terakhir tetap profit (PF >= 1)', pass: recent.totalTrades >= 20 && recent.profitFactor >= 1, value: recent.totalTrades ? `PF ${isFinite(recent.profitFactor) ? recent.profitFactor.toFixed(2) : '∞'}` : '-' },
    { key: 'regime', label: 'Edge di >= 2 rezim pasar (>= 10 trade per rezim)', pass: regimesWithEdge >= 2, value: `${regimesWithEdge} rezim` }
  ];

  return {
    generatedAt: new Date().toISOString(),
    readyForLive: checklist.every(c => c.pass),
    checklist,
    overall: { ...overall, profitFactor: isFinite(overall.profitFactor) ? +overall.profitFactor.toFixed(2) : null, netPnl: +overall.netPnl.toFixed(2), expectancy: +overall.expectancy.toFixed(3) },
    recent50: { totalTrades: recent.totalTrades, profitFactor: isFinite(recent.profitFactor) ? +recent.profitFactor.toFixed(2) : null },
    benchmark,
    mfeAnalysis,
    regimes,
    symbols,
    guards
  };
}

/** Current active configuration summary to attach to a changelog entry */
function buildConfigSnapshot(): Record<string, any> {  return {
    capturedAt: new Date().toISOString(),
    tradingMode: CONFIG.SIMULATION_MODE ? 'SIMULATION' : 'LIVE',
    symbols: Object.fromEntries(Object.values(CONFIG.SYMBOLS).map(s => [s.name, {
      obiThreshold: s.obiThreshold,
      zScoreThreshold: s.zScoreThreshold,
      takeProfitPct: s.takeProfitPct,
      stopLossPct: s.stopLossPct,
      tradeSizeUsd: s.tradeSizeUsd
    }])),
    tradeFilters: CONFIG.TRADE_FILTERS,
    risk: {
      accountBalanceUsd: CONFIG.ACCOUNT_BALANCE_USD,
      baseRiskPerTradeUsd: CONFIG.BASE_RISK_PER_TRADE_USD,
      maxPositionRiskPct: CONFIG.MAX_POSITION_RISK_PCT,
      maxPositionNotionalUsd: CONFIG.MAX_POSITION_NOTIONAL_USD,
      grossExposureCapUsd: CONFIG.GROSS_EXPOSURE_CAP_USD,
      maxConcurrentPositions: CONFIG.MAX_CONCURRENT_POSITIONS,
      dailyDrawdownLimitPct: CONFIG.DAILY_DRAWDOWN_LIMIT_PCT,
      postStopLossCooldownSec: CONFIG.POST_STOP_LOSS_COOLDOWN_SEC
    },
    exits: {
      breakevenStopActivationBufferPct: CONFIG.BREAKEVEN_STOP_ACTIVATION_BUFFER_PCT,
      trailingActivationRatio: CONFIG.TRAILING_ACTIVATION_RATIO,
      runawayTrailingSlMultiplier: CONFIG.RUNAWAY_TRAILING_SL_MULTIPLIER,
      extremeZscoreBlock: CONFIG.EXTREME_ZSCORE_BLOCK,
      tp1Pct: CONFIG.TP1_PCT,
      tp2Pct: CONFIG.TP2_PCT
    },
    entryGuards: {
      entryCooldownSec: CONFIG.ENTRY_COOLDOWN_SEC,
      minEntrySpacingPct: CONFIG.MIN_ENTRY_SPACING_PCT
    }
  };
}


export class WebDashboardServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private tickCount = 0;
  private lastUpdateData: any = null;
  private onManualCloseCallback: ((modelId: string, symbol: string) => void) | null = null;
  private onToggleStatusCallback: (() => void) | null = null;
  private onStrategyParamCallback: ((symbol: string, key: string, value: number) => void) | null = null;
  private onTpSlUpdateCallback: ((symbol: string, lineType: string, newPrice: number) => void) | null = null;
  private onApplySuggestionsCallback: ((suggestions: any[]) => void) | null = null;
  private exchange: IExchangeConnector;
  private performanceDataProvider: (() => Record<string, any>) | null = null;
  private marketContextProvider: (() => Record<string, any>) | null = null;

  constructor(port: number = 3000, exchange?: IExchangeConnector) {
    this.exchange = exchange as IExchangeConnector;
    this.server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url || '/';

      if (url === '/' || url === '/index.html') {
        this.serveFile('index.html', res);
        return;
      }
      if (url === '/performance' || url === '/performance.html') {
        this.serveFile('performance.html', res);
        return;
      }
if (url.startsWith('/thinking-hub')) {
        this.serveFile('thinking-hub.html', res);
        return;
      }

      if (url === '/backtest' || url === '/backtest.html') {
        this.serveFile('backtest.html', res);
        return;
      }

      if (url === '/changelog' || url === '/changelog.html') {
        this.serveFile('changelog.html', res);
        return;
      }

      // Local vendored assets (e.g. chart library) â€” avoids CDN blocks in some networks
      if (url.startsWith('/vendor/')) {
        const asset = url.replace('/vendor/', '').split('?')[0];
        if (!/^[a-zA-Z0-9._-]+$/.test(asset)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
          return;
        }
        this.serveFile(path.join('vendor', asset), res);
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/performance')) {
        this.handlePerformanceApi(req, res);
        return;
      }

      if (req.method === 'GET' && url === '/api/dashboard') {
        const data = this.lastUpdateData || { models: {}, isTradingActive: false, simMode: true, globalDominance: {} };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/market-context')) {
        const parsedUrl = new URL(url, `http://${req.headers.host}`);
        const symbolFilter = parsedUrl.searchParams.get('symbol');
        const ctx = this.marketContextProvider ? this.marketContextProvider() : {};
        let payload: any = { symbols: Object.keys(ctx), timeframes: ['1M', '1w', '1d', '4h', '1h', '30m', '15m', '5m'] };
        if (symbolFilter && ctx[symbolFilter.toUpperCase()]) {
          payload = { ...payload, symbol: symbolFilter.toUpperCase(), ...ctx[symbolFilter.toUpperCase()] };
        } else if (symbolFilter) {
          payload = { ...payload, symbol: symbolFilter.toUpperCase(), timeframes: {}, bias: 'MIXED' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/chart-indicators')) {
        const parsedUrl = new URL(url, `http://${req.headers.host}`);
        const sym = (parsedUrl.searchParams.get('symbol') || '').toUpperCase();
        const data = this.performanceDataProvider ? this.performanceDataProvider() : { runners: {} };
        const runners = Object.values(data.runners || {}) as any[];
        const strategy = runners[0]?.strategy;

        const ind = strategy?.getIndicators?.(sym);
        const vwap = strategy?.getVwapData?.(sym) || null;
        const trades: any[] = [];
        for (const runner of runners) {
          try {
            const hist = runner?.execution?.getTradesHistory?.() || [];
            for (const t of hist) {
              if (t.symbol !== sym || !t.exitTime) continue;
              trades.push({
                entryTime: t.entryTime,
                exitTime: t.exitTime,
                side: t.side,
                entryPrice: t.entryPrice,
                exitPrice: t.exitPrice,
                netProfitUsd: t.netProfitUsd
              });
            }
          } catch {}
        }
        trades.sort((a, b) => a.entryTime - b.entryTime);

        const payload = {
          symbol: sym,
          hasIndicators: !!ind,
          srLevels: ind?.srLevels || [],
          fvgs: (ind?.fvgs || []).filter((f: any) => !f.isFilled).slice(-6),
          poc: ind?.poc ?? null,
          fib: ind?.fibonacci || null,
          vwap: vwap ? { price: vwap.price, upperBand: vwap.upperBand, lowerBand: vwap.lowerBand } : null,
          trades: trades.slice(-60)
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/suggestions')) {
        const parsedUrl = new URL(url, `http://${req.headers.host}`);
        const symbolFilter = parsedUrl.searchParams.get('symbol');
        const data = this.performanceDataProvider ? this.performanceDataProvider() : { runners: {} };
        const runners = data.runners || {};
        const allTrades: any[] = [];
        for (const runner of Object.values(runners)) {
          try {
            const execution = (runner as any).execution;
            if (execution && execution.getTradesHistory) {
              allTrades.push(...execution.getTradesHistory());
            }
          } catch {}
        }
        const filteredTrades = (symbolFilter && symbolFilter !== 'ALL')
          ? allTrades.filter(t => t.symbol === symbolFilter.toUpperCase())
          : allTrades;
        const analyzer = new TradeAnalyzer();
        const firstRunner = Object.values(runners)[0] as any;
        const strategy: any = firstRunner?.strategy;

        // Per-coin analysis compares against that coin's effective running params
        let analysisParams: Record<string, any> = strategy?.getAllParams?.() || {};
        const payload: any = { totalTrades: filteredTrades.length, symbol: symbolFilter || 'ALL' };
        if (symbolFilter && symbolFilter !== 'ALL' && strategy?.getSymbolEffectiveParams) {
          analysisParams = strategy.getSymbolEffectiveParams(symbolFilter.toUpperCase());
          payload.currentParams = analysisParams;
        }
        payload.suggestions = analyzer.analyzeHistoricalPerformance(filteredTrades, analysisParams);
        payload.breakdown = analyzer.computeBreakdown(filteredTrades);
        // Surface active trade filters so the UI can explain WHY behavior changed
        payload.filters = {
          enableShorts: CONFIG.TRADE_FILTERS.ENABLE_SHORTS,
          shortBlockedRegimes: CONFIG.TRADE_FILTERS.SHORT_BLOCKED_REGIMES,
          symbolSizeMultipliers: CONFIG.TRADE_FILTERS.SYMBOL_SIZE_MULTIPLIERS
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/historical-data')) {
        this.handleHistoricalDataApi(req, res);
        return;
      }

      if (req.method === 'POST' && url === '/api/trades/import') {
        let body = '';
        let oversized = false;
        req.on('data', (chunk: Buffer) => {
          if (body.length > 5 * 1024 * 1024) { oversized = true; req.destroy(); return; }
          body += chunk.toString('utf-8');
        });
        req.on('end', () => {
          if (oversized) return;
          try {
            const parsed = JSON.parse(body || '{}');
            const records = parseImportPayload(parsed.format, String(parsed.raw || ''));
            const data = this.performanceDataProvider ? this.performanceDataProvider() : { runners: {} };
            const runners = Object.values(data.runners || {}) as any[];
            const execution = runners[0]?.execution;
            if (!execution || typeof execution.importTrades !== 'function') {
              throw new Error('Trading engine belum siap untuk menerima import');
            }
            const result = execution.importTrades(records);
            console.log(`\x1b[35m[WEB-UI] Trade import: ${result.imported} imported, ${result.skipped} skipped\x1b[0m`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'Import gagal' }));
          }
        });
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/changelog/snapshot')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildConfigSnapshot()));
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/changelog')) {
        const entries = readChangelogFile();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entries));
        return;
      }

      if (req.method === 'POST' && url === '/api/changelog') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8'); });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const version = String(parsed.version || '').trim();
            const category = String(parsed.category || '').trim().toUpperCase();
            const title = String(parsed.title || '').trim();
            if (!title) throw new Error('Judul update wajib diisi');
            if (!CHANGELOG_CATEGORIES.includes(category as any)) throw new Error(`Kategori harus salah satu dari: ${CHANGELOG_CATEGORIES.join(', ')}`);
            const entry: ChangelogEntry = {
              id: `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              timestamp: Date.now(),
              version: version || 'untagged',
              category,
              title,
              description: String(parsed.description || '').trim() || undefined,
              reason: String(parsed.reason || '').trim() || undefined,
              impact: String(parsed.impact || '').trim() || undefined,
              configSnapshot: parsed.configSnapshot && typeof parsed.configSnapshot === 'object' ? parsed.configSnapshot : undefined
            };
            const entries = readChangelogFile();
            entries.unshift(entry);
            writeChangelogFile(entries);
            console.log(`\x1b[35m[CHANGELOG] Entry added: [${entry.version}] ${entry.category} - ${entry.title}\x1b[0m`);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(entry));
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'Gagal menambah entry changelog' }));
          }
        });
        return;
      }

      if (req.method === 'DELETE' && url.startsWith('/api/changelog')) {
        const parsedUrl = new URL(url, `http://${req.headers.host}`);
        const id = parsedUrl.searchParams.get('id');
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Parameter id wajib diisi' }));
          return;
        }
        const entries = readChangelogFile();
        const filtered = entries.filter(e => e.id !== id);
        if (filtered.length === entries.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Entry tidak ditemukan' }));
          return;
        }
        writeChangelogFile(filtered);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: id }));
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/go-live-report')) {
        if (!this.performanceDataProvider) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Performance data not available' }));
          return;
        }
        try {
          const data = this.performanceDataProvider();
          const runners = Object.values(data.runners || {}) as any[];
          const allTrades: any[] = [];
          const guards: Record<string, any> = {};
          for (const runner of runners) {
            try {
              const execution = (runner as any).execution;
              if (execution?.getTradesHistory) allTrades.push(...execution.getTradesHistory());
              if (typeof execution?.getSymbolGuardStatus === 'function') {
                Object.assign(guards, execution.getSymbolGuardStatus());
              }
            } catch {}
          }
          const sendReport = (btcCandles: any[] | null) => {
            const report = buildGoLiveReport(allTrades, guards, btcCandles, CONFIG.ACCOUNT_BALANCE_USD);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(report));
          };
          if (!this.exchange) {
            sendReport(null);
            return;
          }
          this.exchange.getCandleSnapshot('BTC', '1d', 400)
            .then(candles => sendReport(candles || null))
            .catch(() => sendReport(null));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    // 2. Create WebSocket server sharing the same port / HTTP server
    this.wss = new WebSocketServer({ noServer: true });

    // Handle WebSocket upgrade handshakes
    this.server.on('upgrade', (request, socket, head) => {
      const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : '';
      
      if (pathname === '/dashboard') {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    // Monitor browser client connections
    this.wss.on('connection', (ws: WebSocket, request: any) => {
      this.clients.add(ws);
      
      // Send initial data packet immediately on connection
      if (this.lastUpdateData) {
        ws.send(JSON.stringify({
          type: 'dashboard_update',
          data: this.lastUpdateData
        }));
      } else {
        // Send a lightweight ping so the client knows the connection is alive;
        // the next broadcastUpdate will carry the full payload.
        ws.send(JSON.stringify({ type: 'heartbeat' }));
      }

      ws.on('message', (message: string) => {
        try {
          const parsed = JSON.parse(message.toString());
          
          if (parsed.type === 'manual_close' && parsed.symbol && parsed.modelId) {
            console.log(`\x1b[35m[WEB-UI] Received manual close request for model ${parsed.modelId} symbol ${parsed.symbol}\x1b[0m`);
            if (this.onManualCloseCallback) {
              this.onManualCloseCallback(parsed.modelId, parsed.symbol);
            }
          } else if (parsed.type === 'toggle_system_status') {
            console.log(`\x1b[35m[WEB-UI] Received system ON/OFF status toggle request\x1b[0m`);
            if (this.onToggleStatusCallback) {
              this.onToggleStatusCallback();
            }
          } else if (parsed.type === 'request_thinking_detail' && parsed.symbol) {
            if (this.lastUpdateData) {
              const models = this.lastUpdateData.models || {};
              const details: Record<string, any> = {};
              for (const [modelId, modelData] of Object.entries(models)) {
                const aiInsights = (modelData as any).aiInsights || {};
                if (aiInsights[parsed.symbol]) {
                  const insight = aiInsights[parsed.symbol];
                  const activePos = ((modelData as any).activePositions || []).find((p: any) => p.symbol === parsed.symbol);
                  details[modelId] = {
                    insight,
                    position: activePos || null,
                    stats: (modelData as any).stats || null
                  };
                }
              }
              ws.send(JSON.stringify({
                type: 'thinking_detail',
                symbol: parsed.symbol,
                details
              }));
            }
          } else if (parsed.type === 'request_risk_metrics' && parsed.modelId) {
            ws.send(JSON.stringify({
              type: 'risk_metrics_response',
              modelId: parsed.modelId,
              data: this.lastUpdateData?.models?.[parsed.modelId]?.riskMetrics || null
            }));
          } else if (parsed.type === 'request_equity_curve' && parsed.modelId) {
            ws.send(JSON.stringify({
              type: 'equity_curve_response',
              modelId: parsed.modelId,
              data: this.lastUpdateData?.models?.[parsed.modelId]?.equityCurve || []
            }));
          } else if (parsed.type === 'request_performance_attribution' && parsed.modelId) {
            ws.send(JSON.stringify({
              type: 'performance_attribution_response',
              modelId: parsed.modelId,
              data: this.lastUpdateData?.models?.[parsed.modelId]?.performanceAttribution || []
            }));
          } else if (parsed.type === 'request_dashboard_data') {
            if (this.lastUpdateData) {
              ws.send(JSON.stringify({
                type: 'dashboard_update',
                data: this.lastUpdateData
              }));
            }
          } else if (parsed.type === 'update_strategy_param' && parsed.symbol && parsed.key && parsed.value !== undefined) {
            console.log(`\x1b[35m[WEB-UI] Received strategy param update: ${parsed.symbol} ${parsed.key} = ${parsed.value}\x1b[0m`);
            if (this.onStrategyParamCallback) {
              if (parsed.key === 'reset') {
                this.onStrategyParamCallback(parsed.symbol, 'reset', 0);
              } else {
                this.onStrategyParamCallback(parsed.symbol, parsed.key, parsed.value);
              }
              // Ack back so the UI can show real success/failure instead of a fake timer
              ws.send(JSON.stringify({
                type: 'strategy_param_applied',
                symbol: parsed.symbol,
                key: parsed.key,
                value: parsed.value
              }));
            }
            ws.send(JSON.stringify({
              type: 'strategy_param_updated',
              symbol: parsed.symbol,
              key: parsed.key,
              value: parsed.value
            }));
          } else if (parsed.type === 'update_tp_sl' && parsed.symbol && parsed.lineType && parsed.newPrice !== undefined) {
            console.log(`\x1b[35m[WEB-UI] Received TP/SL update: ${parsed.symbol} ${parsed.lineType} = ${parsed.newPrice}\x1b[0m`);
            if (this.onTpSlUpdateCallback) {
              this.onTpSlUpdateCallback(parsed.symbol, parsed.lineType, parsed.newPrice);
            }
            ws.send(JSON.stringify({
              type: 'tp_sl_updated',
              symbol: parsed.symbol,
              lineType: parsed.lineType,
              newPrice: parsed.newPrice
            }));
          } else if (parsed.type === 'request_suggestions') {
            if (this.lastUpdateData) {
              const runners = this.lastUpdateData.models || {};
              const allTrades: any[] = [];
              for (const runner of Object.values(runners)) {
                try {
                  const execution = (runner as any).execution;
                  if (execution && execution.getTradesHistory) {
                    allTrades.push(...execution.getTradesHistory());
                  }
                } catch {}
              }
              const analyzer = new TradeAnalyzer();
              const firstRunner = Object.values(runners)[0] as any;
              const currentParams = firstRunner?.strategy?.getAllParams?.() || {};
              const suggestions = analyzer.analyzeHistoricalPerformance(allTrades, currentParams);
              ws.send(JSON.stringify({
                type: 'suggestions_response',
                suggestions,
                totalTrades: allTrades.length
              }));
            }
          } else if (parsed.type === 'apply_suggestions' && parsed.suggestions) {
            console.log(`\x1b[35m[WEB-UI] Applying suggestions:\x1b[0m`, parsed.suggestions);
            if (this.onApplySuggestionsCallback) {
              this.onApplySuggestionsCallback(parsed.suggestions);
            }
            ws.send(JSON.stringify({
              type: 'suggestions_applied',
              suggestions: parsed.suggestions
            }));
          }
        } catch (err: any) {
          console.error('[WEB-UI] Error parsing WebSocket message:', err.message);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error('[WEB-UI] WebSocket Client Error:', err.message);
        this.clients.delete(ws);
      });
    });

    // 3. Start the Server
    this.server.listen(port, () => {
      console.log(`\n\x1b[32m\x1b[1m[WEB-UI] Premium Real-time HTML Dashboard is now online!`);
      console.log(`[WEB-UI] Open this link in your browser to view it live:`);
      console.log(`\x1b[36m\x1b[4mhttp://localhost:${port}/\x1b[0m`);

    });
  }

  // ================================================================
  // FILE SERVING
  // ================================================================

  private serveFile(filename: string, res: http.ServerResponse) {
    const filePath = path.join(process.cwd(), 'public', filename);
    
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading UI: ' + err.message);
        return;
      }
      const ext = path.extname(filename);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/html' });
      res.end(content);
    });
  }

  /**
   * Broadcasts a sub-millisecond price heartbeat tick to flash the browser LED
   */
  public broadcastTick() {
    this.tickCount++;
    const payload = JSON.stringify({
      type: 'heartbeat',
      tickCount: this.tickCount
    });
    this.broadcast(payload);
  }

  /**
   * Broadcasts a full dashboard data packet (stats, active positions, trades history) to the UI
   */
  public broadcastUpdate(engineData: any) {
    this.lastUpdateData = {
      simMode: CONFIG.SIMULATION_MODE,
      models: engineData.models,
      isTradingActive: engineData.isTradingActive,
      globalDominance: engineData.globalDominance
    };

    const payload = JSON.stringify({
      type: 'dashboard_update',
      data: this.lastUpdateData
    });
    this.broadcast(payload);
  }

  private broadcast(payload: string) {
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  public registerManualCloseCallback(callback: (modelId: string, symbol: string) => void) {
    this.onManualCloseCallback = callback;
  }

  public registerToggleStatusCallback(callback: () => void) {
    this.onToggleStatusCallback = callback;
  }

  public registerPerformanceDataProvider(provider: () => Record<string, any>) {
    this.performanceDataProvider = provider;
  }

  public registerTpSlUpdateCallback(callback: (symbol: string, lineType: string, newPrice: number) => void) {
    this.onTpSlUpdateCallback = callback;
  }

  public registerApplySuggestionsCallback(callback: (suggestions: any[]) => void) {
    this.onApplySuggestionsCallback = callback;
  }

  public setMarketContextProvider(provider: () => Record<string, any>) {
    this.marketContextProvider = provider;
  }

  public registerStrategyParamCallback(callback: (symbol: string, key: string, value: number) => void) {
    this.onStrategyParamCallback = callback;
  }

  private handlePerformanceApi(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.performanceDataProvider) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Performance data not available' }));
      return;
    }
    try {
      const url = new URL(req.url || '/api/performance', `http://${req.headers.host}`);
      const meta = url.searchParams.get('meta') === '1';
      const data = this.performanceDataProvider();
      if (meta) {
        const models: Record<string, any> = {};
        const runners = data.runners || {};
        for (const [id, runner] of Object.entries(runners)) {
          try {
            const execution = (runner as any).execution;
            const stats = execution && execution.getStats ? execution.getStats() : {};
            models[id] = { stats };
          } catch {
            models[id] = { stats: {} };
          }
        }
        const strategyOverrides: Record<string, any> = {};
        for (const [id, runner] of Object.entries(runners)) {
          try {
            const strategy = (runner as any).strategy;
            if (strategy && strategy.getAllOverrides) {
              const allOverrides = strategy.getAllOverrides();
              const firstSymbol = Object.keys(allOverrides)[0];
              strategyOverrides[id] = firstSymbol ? allOverrides[firstSymbol] : {};
            }
          } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models, strategyOverrides }));
        return;
      }

      const analyzer = new AITradeAnalyzer();
      const allTrades: any[] = [];
      const runners = data.runners || {};
      let correlationMatrix = null;
      for (const runner of Object.values(runners)) {
        try {
          const execution = (runner as any).execution;
          if (execution) {
            const trades = execution.getTradesHistory ? execution.getTradesHistory() : [];
            allTrades.push(...trades);
          }
        } catch {}
      }
      const riskMetrics = null;
      const analysis = analyzer.analyze(allTrades, riskMetrics);
      
      const strategyOverrides: Record<string, any> = {};
      for (const [id, runner] of Object.entries(runners)) {
        try {
          const strategy = (runner as any).strategy;
          if (strategy && strategy.getAllOverrides) {
            const allOverrides = strategy.getAllOverrides();
            const firstSymbol = Object.keys(allOverrides)[0];
            strategyOverrides[id] = firstSymbol ? allOverrides[firstSymbol] : {};
          }
        } catch {}
      }

      const responsePayload = {
        trades: allTrades,
        analysis,
        models: Object.fromEntries(Object.entries(runners).map(([id, r]: [string, any]) => [id, { stats: (r.execution && r.execution.getStats) ? r.execution.getStats() : {} }])),
        correlationMatrix,
        strategyOverrides
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    } catch (err: any) {
      console.error('[PERF API] Error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  private handleHistoricalDataApi(req: http.IncomingMessage, res: http.ServerResponse) {
    const parsedUrl = new URL(req.url || '/api/historical-data', `http://${req.headers.host}`);
    const symbol = (parsedUrl.searchParams.get('symbol') || 'BTC').toUpperCase();
    const timeframe = parsedUrl.searchParams.get('timeframe') || '1h';
    const limitParam = parsedUrl.searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam) : 100; // default to 100 candles

    if (!this.exchange) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Exchange connector not available' }));
      return;
    }

    this.exchange.getCandleSnapshot(symbol, timeframe, limit)
      .then((candles: any[]) => {
        // Convert to the format expected by the frontend: time in milliseconds, open, high, low, close, volume
        const result = candles.map((c: any) => ({
          time: c.time * 1000,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch((error: any) => {
        console.error('[HISTORICAL DATA API] Error:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      });
  }

  public close() {
    this.wss.close();
    this.server.close();
  }
}
