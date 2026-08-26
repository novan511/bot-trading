import fs from 'fs';
import path from 'path';
import { ExchangeConnector } from './exchange.js';
import { StrategyManager } from './strategy.js';
import { ExecutionEngine } from './execution.js';
import { WebDashboardServer } from './server.js';
import { CONFIG } from './config.js';
import { NvidiaObserver } from './nvidia.js';
import { calculateFibonacci, calculateFVGs, calculateSRLevels, calculatePOC, calculateATR } from './indicators.js';
import { PortfolioManager } from './portfolio_manager.js';
import { TradeMemory } from './trade_memory.js';
import { TradeDatabase } from './database.js';
import { circuitBreaker } from './circuit_breaker.js';
import { SmartOrderRouter } from './smart_order_routing.js';
// Setup file debug logging to bypass console.clear() wiping diagnostic history
const logFilePath = path.join(process.cwd(), 'hft_debug.log');
fs.writeFileSync(logFilePath, `[SYSTEM] --- HFT Bot Startup Debug Log | ${new Date().toISOString()} ---\n`);
function logDebug(message) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${message}\n`;
    fs.appendFileSync(logFilePath, logMsg);
}
// Global Exception Catching to record silent failures
process.on('uncaughtException', (err) => {
    logDebug(`CRITICAL UNCAUGHT EXCEPTION: ${err.message}\nStack: ${err.stack}`);
    console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logDebug(`CRITICAL UNHANDLED REJECTION: ${reason?.message || reason}`);
    console.error('CRITICAL UNHANDLED REJECTION:', reason);
});
// Global BTC & USDT market dominance cache
let currentGlobalDominance = { btcDom: 54.0, usdtDom: 5.5 };
// Multi-timeframe market context cache (consumed by Thinking Hub fine-tuning via /api/market-context)
let latestMarketContext = {};
function emaOf(values, period) {
    if (values.length < period)
        return null;
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < values.length; i++)
        e = values[i] * k + e * (1 - k);
    return e;
}
function summarizeTimeframe(candles) {
    if (!candles || candles.length < 21)
        return null;
    const closes = candles.map(c => c.close);
    const last = closes[closes.length - 1];
    const emaFast = emaOf(closes, 9);
    const emaSlow = emaOf(closes, 21);
    const lookback = Math.min(20, closes.length - 1);
    const basePrice = closes[closes.length - 1 - lookback];
    const changePct = basePrice > 0 ? ((last - basePrice) / basePrice) * 100 : 0;
    let trend = 'NEUTRAL';
    if (emaFast !== null && emaSlow !== null) {
        if (emaFast > emaSlow && changePct > 0)
            trend = 'BULLISH';
        else if (emaFast < emaSlow && changePct < 0)
            trend = 'BEARISH';
    }
    return { trend, price: last, emaFast, emaSlow, changePct: +changePct.toFixed(2), candles: closes.length };
}
const MARKET_CONTEXT_TIMEFRAMES = ['1M', '1w', '1d', '4h', '1h', '30m', '15m', '5m'];
/**
 * Runs async tasks with bounded concurrency. Firing 70+ REST calls simultaneously
 * triggers connection resets ("fetch failed") and rate-limiting on Windows/undici.
 */
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = index++;
            results[current] = await fn(items[current]);
        }
    });
    await Promise.all(workers);
    return results;
}
function buildMarketContext(candleData, symbols) {
    const ctx = {};
    for (const s of symbols) {
        const prevTimeframes = latestMarketContext[s]?.timeframes || {};
        const perTf = {};
        for (const tf of MARKET_CONTEXT_TIMEFRAMES) {
            // Keep the last good summary when a fetch cycle comes back empty
            perTf[tf] = summarizeTimeframe(candleData[s]?.[tf] || []) || prevTimeframes[tf] || null;
        }
        // Composite bias across all timeframes
        let bull = 0, bear = 0;
        for (const tf of MARKET_CONTEXT_TIMEFRAMES) {
            const d = perTf[tf];
            if (!d)
                continue;
            if (d.trend === 'BULLISH')
                bull++;
            else if (d.trend === 'BEARISH')
                bear++;
        }
        const bias = bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'MIXED';
        ctx[s] = { timeframes: perTf, bias, updatedAt: Date.now() };
    }
    return ctx;
}
async function fetchGlobalMarketDominance() {
    return circuitBreaker.call('coingecko', async () => {
        logDebug('[COINGECKO] Fetching global market dominance...');
        const response = await fetch('https://api.coingecko.com/api/v3/global', {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000)
        });
        if (response.ok) {
            const json = await response.json();
            if (json && json.data && json.data.market_cap_percentage) {
                const btcDom = parseFloat((json.data.market_cap_percentage.btc || 54.0).toFixed(2));
                const usdtDom = parseFloat((json.data.market_cap_percentage.usdt || 5.5).toFixed(2));
                logDebug(`[COINGECKO] Success! BTC Dominance: ${btcDom}%, USDT Dominance: ${usdtDom}%`);
                return { btcDom, usdtDom };
            }
        }
        else {
            logDebug(`[COINGECKO] HTTP Error: ${response.status} ${response.statusText}`);
        }
        return { btcDom: 54.0, usdtDom: 5.5 };
    }, () => ({ btcDom: 54.0, usdtDom: 5.5 }));
}
async function main() {
    logDebug('Initializing Multi-Model HFT Bot...');
    // 1. Initialize core system components
    const exchange = new ExchangeConnector();
    const nvidiaObserver = new NvidiaObserver();
    const smartOrderRouter = new SmartOrderRouter(); // NEW: Smart Order Router
    // Create strategy manager, execution engine, and database for each configured model
    const models = {};
    const latestAiInsights = {};
    for (const modelId of Object.keys(CONFIG.MODELS)) {
        const tradeMemory = new TradeMemory(modelId);
        const database = new TradeDatabase(modelId); // NEW: SQLite database per model
        models[modelId] = {
            strategy: new StrategyManager(),
            execution: new ExecutionEngine(modelId, exchange, tradeMemory, database),
            database
        };
        // Wire fine-tuned per-symbol TP/SL overrides into the execution engine
        models[modelId].execution.setParamProvider((sym) => {
            const p = models[modelId].strategy.getSymbolEffectiveParams(sym);
            return { takeProfitPct: p.takeProfitPct, stopLossPct: p.stopLossPct };
        });
        latestAiInsights[modelId] = {};
        // Load active positions dari database setelah restart
        const savedPositions = database.getAllActivePositions();
        if (savedPositions.length > 0) {
            logDebug(`[DATABASE] Restored ${savedPositions.length} active positions for ${modelId} from SQLite`);
        }
    }
    const activeSymbols = Object.keys(CONFIG.SYMBOLS);
    const portfolioManager = new PortfolioManager(activeSymbols, 50);
    const PORT = parseInt(process.env.PORT || '3000');
    // 2. Start the Premium Real-time HTML Dashboard server — pass exchange for backtesting
    const dashboardServer = new WebDashboardServer(PORT, exchange);
    // Serve cached multi-timeframe market context to the Thinking Hub fine-tuning panel
    dashboardServer.setMarketContextProvider(() => latestMarketContext);
    dashboardServer.registerPerformanceDataProvider(() => {
        const runners = {};
        for (const [modelId, model] of Object.entries(models)) {
            runners[modelId] = model;
        }
        return { runners, models };
    });
    // Send initial dashboard update so the homepage is not empty on first load
    setTimeout(() => sendDashboardUpdate(), 500);
    // Load system active status from persistent file system_state.json
    let isTradingActive = true;
    const stateFilePath = path.join(process.cwd(), 'system_state.json');
    try {
        if (fs.existsSync(stateFilePath)) {
            const stateData = fs.readFileSync(stateFilePath, 'utf-8');
            const parsedState = JSON.parse(stateData);
            if (parsedState.isTradingActive === false) {
                isTradingActive = false;
            }
            logDebug(`[SYSTEM STATE] Hydrated isTradingActive = ${isTradingActive} from system_state.json`);
        }
    }
    catch (err) {
        logDebug(`[SYSTEM STATE] Error reading state file: ${err.message}`);
    }
    // Always start ACTIVE on fresh boot; stale paused state should not persist across restarts
    isTradingActive = true;
    // Helper to send real-time states to browser dashboard
    const lastKnownPrices = {};
    const atrResults = {};
    const sendDashboardUpdate = () => {
        const payload = {};
        for (const [modelId, model] of Object.entries(models)) {
            const mappedPositions = model.execution.getActivePositions().map(p => {
                const lastPrice = lastKnownPrices[p.symbol];
                const currentPrice = lastPrice ? (p.side === 'BUY' ? lastPrice.bid : lastPrice.ask) : p.entryPrice;
                let floatingPnlPct = 0;
                let floatingPnlUsd = 0;
                if (p.side === 'BUY') {
                    floatingPnlPct = (currentPrice - p.entryPrice) / p.entryPrice;
                    floatingPnlUsd = (currentPrice - p.entryPrice) * p.quantity;
                }
                else {
                    floatingPnlPct = (p.entryPrice - currentPrice) / p.entryPrice;
                    floatingPnlUsd = (p.entryPrice - currentPrice) * p.quantity;
                }
                return {
                    ...p,
                    floatingPnlPct,
                    floatingPnlUsd
                };
            });
            const stats = model.execution.getStats();
            const tradesHistory = model.execution.getTradesHistory();
            // NEW: Calculate risk metrics
            const riskMetrics = model.execution.riskManager.getLatestMetrics(tradesHistory);
            // NEW: Get equity curve
            const equityCurve = model.execution.riskManager.getEquityCurve();
            // NEW: Get performance attribution
            const performanceAttribution = model.execution.riskManager.getPerformanceAttribution();
            // NEW: Get circuit breaker metrics
            const circuitMetrics = circuitBreaker.getAllMetrics();
            payload[modelId] = {
                stats,
                activePositions: mappedPositions,
                tradesHistory,
                aiInsights: latestAiInsights[modelId] || {},
                riskMetrics, // NEW
                equityCurve, // NEW
                performanceAttribution, // NEW
                circuitBreaker: circuitMetrics, // NEW
                tradingSession: model.execution.riskManager.getTradingSession(),
                dailyDrawdown: model.execution.riskManager.getDailyDrawdownPct(),
                consecutiveLosses: model.execution.riskManager.getConsecutiveLosses(),
                isPaused: model.execution.riskManager.getIsPaused(),
                atrData: atrResults,
                correlationMatrix: portfolioManager.getLastMatrix(),
                marketRegime: model.strategy.getMarketRegimeInfo()
            };
        }
        // Enrich payload with calculated leverage & margin info
        for (const [modelId, modelData] of Object.entries(payload)) {
            if (modelData.activePositions) {
                modelData.activePositions = modelData.activePositions.map((p) => {
                    const notionalValue = p.entryPrice * p.quantity;
                    const estLeverage = notionalValue > 0 ? Math.min(notionalValue / CONFIG.ACCOUNT_BALANCE_USD * 10, 50) : 1;
                    const marginUsed = notionalValue / Math.max(estLeverage, 1);
                    return {
                        ...p,
                        estimatedLeverage: parseFloat(estLeverage.toFixed(2)),
                        marginUsed: parseFloat(marginUsed.toFixed(2)),
                        notionalValue: parseFloat(notionalValue.toFixed(2))
                    };
                });
            }
        }
        dashboardServer.broadcastUpdate({
            models: payload,
            isTradingActive,
            globalDominance: currentGlobalDominance,
            simMode: CONFIG.SIMULATION_MODE,
            correlationMatrix: portfolioManager.getLastMatrix()
        });
    };
    // Register dashboard status toggle WebSocket callback
    dashboardServer.registerToggleStatusCallback(() => {
        isTradingActive = !isTradingActive;
        logDebug(`[SYSTEM STATE] Toggle request received. isTradingActive is now: ${isTradingActive}`);
        try {
            fs.writeFileSync(stateFilePath, JSON.stringify({ isTradingActive }, null, 2), 'utf-8');
        }
        catch (err) {
            logDebug(`[SYSTEM STATE] Error writing state file: ${err.message}`);
        }
        // Instantly push update to refresh UI
        sendDashboardUpdate();
    });
    // 2b. Listen to browser manual position close signals
    dashboardServer.registerManualCloseCallback((modelId, symbol) => {
        logDebug(`[MANUAL CLOSE] Browser requested close for model ${modelId} symbol ${symbol}`);
        const model = models[modelId];
        if (!model) {
            logDebug(`[MANUAL CLOSE] Failed: Model ${modelId} not found.`);
            return;
        }
        const activePositions = model.execution.getActivePositions();
        const position = activePositions.find(p => p.symbol === symbol);
        if (!position) {
            logDebug(`[MANUAL CLOSE] Failed: No active position for model ${modelId} in ${symbol}`);
            return;
        }
        const lastPrice = lastKnownPrices[symbol];
        const exitPrice = lastPrice
            ? (position.side === 'BUY' ? lastPrice.bid : lastPrice.ask)
            : position.entryPrice;
        model.execution.forceClosePosition(symbol, exitPrice, 'MANUAL CLOSE FROM DASHBOARD');
        logDebug(`[MANUAL CLOSE] Model ${modelId} Position ${symbol} closed at market price ${exitPrice}`);
        // Instantly push update to refresh UI
        sendDashboardUpdate();
    });
    // 2c. Listen to browser strategy parameter updates
    dashboardServer.registerStrategyParamCallback((symbol, key, value) => {
        logDebug(`[STRATEGY PARAM] Browser requested update: ${symbol} ${key} = ${value}`);
        const model = models['Llama_8B'];
        if (!model) {
            logDebug(`[STRATEGY PARAM] Failed: Model not found.`);
            return;
        }
        const targets = symbol === 'ALL' ? Object.keys(CONFIG.SYMBOLS) : [symbol];
        if (key === 'reset') {
            for (const sym of targets) {
                model.strategy.clearStrategyOverride(sym);
            }
            logDebug(`[STRATEGY PARAM] Reset all overrides for ${targets.join(', ')}`);
        }
        else {
            for (const sym of targets) {
                model.strategy.setStrategyOverride(sym, key, value);
            }
            logDebug(`[STRATEGY PARAM] Updated ${targets.join(', ')} ${key} = ${value}`);
        }
        // Instantly push update to refresh UI
        sendDashboardUpdate();
    });
    // 2d. Listen to browser TP/SL manual updates via drag-and-drop
    dashboardServer.registerTpSlUpdateCallback((symbol, lineType, newPrice) => {
        logDebug(`[TP/SL UPDATE] Browser requested update: ${symbol} ${lineType} = ${newPrice}`);
        const model = models['Llama_8B'];
        if (!model) {
            logDebug(`[TP/SL UPDATE] Failed: Model not found.`);
            return;
        }
        const updated = model.execution.updatePositionTpSl(symbol, lineType === 'tp' ? newPrice : null, lineType === 'sl' ? newPrice : null);
        if (updated) {
            logDebug(`[TP/SL UPDATE] Updated ${symbol} ${lineType} to ${newPrice}`);
            sendDashboardUpdate();
        }
        else {
            logDebug(`[TP/SL UPDATE] No active position for ${symbol}`);
        }
    });
    // 2e. Listen to browser apply suggestions requests
    dashboardServer.registerApplySuggestionsCallback((suggestions) => {
        logDebug(`[APPLY SUGGESTIONS] Applying ${suggestions.length} suggestions`);
        const model = models['Llama_8B'];
        if (!model) {
            logDebug(`[APPLY SUGGESTIONS] Failed: Model not found.`);
            return;
        }
        // Apply consistently across ALL configured symbols via per-symbol overrides
        // (the previous hardcoded-BTC updateParams path collided with the per-coin override system)
        const targets = Object.keys(CONFIG.SYMBOLS);
        for (const suggestion of suggestions) {
            const param = suggestion.parameter;
            const rawValue = String(suggestion.suggestedValue ?? '');
            switch (param) {
                case 'obiThreshold':
                case 'zScoreThreshold': {
                    const value = parseFloat(rawValue);
                    if (isNaN(value) || value <= 0)
                        break;
                    for (const sym of targets) {
                        const eff = model.strategy.getSymbolEffectiveParams(sym);
                        const isObi = param === 'obiThreshold';
                        const base = isObi
                            ? (eff.obiThreshold || 0) / (eff.obiMultiplier || 1)
                            : (eff.zScoreThreshold || 0) / (eff.zScoreMultiplier || 1);
                        if (base <= 0)
                            continue;
                        const mult = Math.max(0.5, Math.min(2, +(value / base).toFixed(4)));
                        model.strategy.setStrategyOverride(sym, isObi ? 'obiMultiplier' : 'zScoreMultiplier', mult);
                    }
                    break;
                }
                case 'tpSlRatio': {
                    const m = rawValue.match(/TP:([0-9.]+)\/SL:([0-9.]+)/i);
                    if (!m)
                        break;
                    const tp = parseFloat(m[1]);
                    const slRaw = parseFloat(m[2]);
                    if (isNaN(tp) || isNaN(slRaw) || tp <= 0 || slRaw <= 0)
                        break;
                    // Enforce the same RR guardrail as updateParams: SL between 0.25x and 0.50x of TP
                    const sl = Math.max(tp * 0.25, Math.min(tp * 0.5, slRaw));
                    for (const sym of targets) {
                        model.strategy.setStrategyOverride(sym, 'takeProfitPct', tp);
                        model.strategy.setStrategyOverride(sym, 'stopLossPct', +sl.toFixed(6));
                    }
                    break;
                }
                case 'minConfirmations': {
                    const v = Math.round(parseFloat(rawValue));
                    if (isNaN(v) || v < 0 || v > 5)
                        break;
                    for (const sym of targets) {
                        model.strategy.setStrategyOverride(sym, 'minConfirmations', v);
                    }
                    break;
                }
                case 'srThresholdPct': {
                    const v = parseFloat(rawValue);
                    if (isNaN(v) || v <= 0)
                        break;
                    for (const sym of targets) {
                        model.strategy.setStrategyOverride(sym, 'srThresholdPct', v);
                    }
                    break;
                }
            }
        }
        logDebug(`[APPLY SUGGESTIONS] Applied ${suggestions.length} suggestions successfully`);
        sendDashboardUpdate();
    });
    let tickCount = 0;
    const symbolTickCounts = {};
    // Global BTC EMA tracking for macro trend
    const btcMacroState = { ema: null, lastUpdate: 0 };
    // 3. Set up live WebSocket order book updates
    exchange.onBookUpdate((book) => {
        tickCount++;
        symbolTickCounts[book.symbol] = (symbolTickCounts[book.symbol] || 0) + 1;
        // Flash the live browser LED indicator
        dashboardServer.broadcastTick();
        const bestBid = book.bids[0][0];
        const bestAsk = book.asks[0][0];
        // Update BTC macro trend EMA globally
        if (book.symbol === 'BTC') {
            const midPrice = (bestBid + bestAsk) / 2;
            const emaPeriod = CONFIG.EMA_FAST_PERIOD;
            const k = 2 / (emaPeriod + 1);
            if (btcMacroState.ema === null) {
                btcMacroState.ema = midPrice;
            }
            else {
                btcMacroState.ema = midPrice * k + btcMacroState.ema * (1 - k);
            }
            const trend = midPrice > btcMacroState.ema ? 'BULLISH' : midPrice < btcMacroState.ema ? 'BEARISH' : 'NEUTRAL';
            // Update macro trends for all models
            for (const model of Object.values(models)) {
                model.strategy.setMacroTrends({ BTC: trend });
            }
            if (tickCount % 500 === 0) {
                logDebug(`[MACRO TREND] BTC ${trend} (mid=${midPrice.toFixed(2)} ema=${btcMacroState.ema.toFixed(2)})`);
            }
        }
        // Cache the latest bid and ask prices for this symbol
        lastKnownPrices[book.symbol] = { bid: bestBid, ask: bestAsk };
        // Update portfolio manager with latest price
        const midPrice = (bestBid + bestAsk) / 2;
        portfolioManager.updatePrice(book.symbol, midPrice);
        // Log the first few ticks to confirm ingestion is fully working
        if (tickCount <= 10 || tickCount % 1000 === 0) {
            logDebug(`WS Packet Ingested #${tickCount} | Symbol: ${book.symbol} | Bid: ${bestBid} | Ask: ${bestAsk}`);
        }
        // Process tick for all models
        for (const [modelId, model] of Object.entries(models)) {
            try {
                // A. Evaluate active position exits on tick level (real-time risk management)
                model.execution.evaluatePositions(book.symbol, bestBid, bestAsk);
                // B. Process tick in quantitative strategy to check for entry signals
                const signal = model.strategy.processTick(book);
                // C. If an entry signal is generated, execute it immediately
                if (signal) {
                    if (!isTradingActive)
                        continue;
                    // NEW: Check entry conditions with Smart Order Router (slippage protection)
                    const entryCondition = smartOrderRouter.isGoodEntryCondition(signal.symbol, signal.side, book);
                    if (!entryCondition.allowed) {
                        logDebug(`[SOR] Skipping ${signal.symbol} ${signal.side}: ${entryCondition.reason}`);
                        continue;
                    }
                    logDebug(`[SIGNAL GENERATED] [${modelId}] ${signal.symbol} | ${signal.side} | Price: ${signal.price} | Reason: ${signal.reason}`);
                    model.execution.executeSignal(signal).then(() => {
                        // NEW: Save position snapshot to database
                        const positions = model.execution.getActivePositions();
                        for (const pos of positions.filter(p => p.symbol === signal.symbol)) {
                            model.database.savePosition(pos);
                        }
                        sendDashboardUpdate();
                    });
                }
            }
            catch (err) {
                logDebug(`ERROR in strategy or execution tick processing for ${modelId}: ${err.message}`);
            }
        }
        // Dynamic browser throttle: send general updates every 5 ticks to keep UI smooth and fluid
        if (tickCount % 5 === 0) {
            sendDashboardUpdate();
        }
    });
    // 4. Connect to the WebSocket stream
    try {
        logDebug('Connecting to Hyperliquid WebSocket...');
        exchange.connect();
        logDebug('WS Connection initiated successfully.');
    }
    catch (err) {
        logDebug(`Connection error on startup: ${err.message}`);
        process.exit(1);
    }
    // 5. Set up periodic dashboard redrawing and Safeguard Position Evaluator (once per second)
    const dashboardInterval = setInterval(() => {
        // Proactive Safeguard Evaluator for each model
        for (const [modelId, model] of Object.entries(models)) {
            const activePositions = model.execution.getActivePositions();
            for (const pos of activePositions) {
                const lastPrice = lastKnownPrices[pos.symbol];
                if (lastPrice) {
                    model.execution.evaluatePositions(pos.symbol, lastPrice.bid, lastPrice.ask);
                }
            }
        }
        // Render consolidated dashboard to console
        console.clear();
        console.log('\x1b[35m================================================================================\x1b[0m');
        console.log('\x1b[1m\x1b[33m               ANTIGRAVITY MULTI-MODEL HFT TRADING SYSTEMS                     \x1b[0m');
        console.log(`\x1b[37m Running Mode   : ${CONFIG.SIMULATION_MODE ? 'LIVE SIMULATION (Safe)' : 'LIVE TRADING (Real API)'}\x1b[0m`);
        console.log(`\x1b[37m Engine Status  : ${isTradingActive ? '\x1b[32mACTIVE\x1b[37m' : '\x1b[31mPAUSED\x1b[37m'} | Ticks Processed: ${tickCount}\x1b[0m`);
        // NEW: Show circuit breaker status
        const cbMetrics = circuitBreaker.getAllMetrics();
        const openCircuits = Object.entries(cbMetrics).filter(([_, m]) => m.state === 'OPEN');
        if (openCircuits.length > 0) {
            console.log(`\x1b[31m[CB] Open circuits: ${openCircuits.map(([n]) => n).join(', ')}\x1b[0m`);
        }
        console.log('\x1b[35m================================================================================\x1b[0m');
        // NEW: Show risk status and session
        console.log('\x1b[35m================================================================================\x1b[0m');
        console.log('\x1b[1m Model Performance Overview:\x1b[0m');
        console.log('--------------------------------------------------------------------------------');
        console.log('  Model ID       | Net Profit  | Win Rate | Trades | Active Pos | Daily DD');
        console.log('--------------------------------------------------------------------------------');
        for (const [modelId, model] of Object.entries(models)) {
            const stats = model.execution.getStats();
            const activeCount = model.execution.getActivePositions().length;
            const netProfitStr = `${stats.netProfitUsd >= 0 ? '+' : ''}$${stats.netProfitUsd.toFixed(4)}`;
            const pnlColor = stats.netProfitUsd >= 0 ? '\x1b[32m' : '\x1b[31m';
            const wrColor = stats.winRate >= 70 ? '\x1b[32m' : stats.winRate >= 50 ? '\x1b[33m' : '\x1b[31m';
            const modelPadded = modelId.padEnd(16);
            const profitPadded = `${pnlColor}${netProfitStr.padEnd(11)}\x1b[0m`;
            const wrPadded = `${wrColor}${stats.winRate.toFixed(2)}%\x1b[0m`.padEnd(19);
            const tradesPadded = stats.totalTrades.toString().padEnd(6);
            // NEW: Show daily drawdown
            const dailyDd = model.execution.riskManager.getDailyDrawdownPct();
            const ddColor = dailyDd > 0.03 ? '\x1b[31m' : dailyDd > 0.01 ? '\x1b[33m' : '\x1b[32m';
            const ddPadded = `${ddColor}${(dailyDd * 100).toFixed(2)}%\x1b[0m`.padEnd(9);
            console.log(`  ${modelPadded} | ${profitPadded} | ${wrPadded} | ${tradesPadded} | ${activeCount}     | ${ddPadded}`);
        }
        console.log('\x1b[35m================================================================================\x1b[0m');
        console.log(`\x1b[90m Active Markets Ingesting: [${Object.keys(symbolTickCounts).join(', ')}]\x1b[0m`);
        console.log(`\x1b[90m Web Dashboard  : http://localhost:${PORT}/\x1b[0m`);
        console.log(`\x1b[90m Backtest Engine: http://localhost:${PORT}/backtest\x1b[0m`);
        console.log(`\x1b[90m Diagnostic log : ${logFilePath}\x1b[0m`);
        // NEW: Show top performing coins
        const firstModel = Object.values(models)[0];
        if (firstModel) {
            const perf = firstModel.execution.riskManager.getPerformanceAttribution();
            if (perf.length > 0) {
                const top3 = perf.slice(0, 3);
                console.log(`\x1b[90m Top Performers   : ${top3.map(p => `${p.symbol} (${p.winRate.toFixed(0)}% WR, $${p.netProfitUsd.toFixed(2)})`).join(' | ')}\x1b[0m`);
            }
        }
        console.log('\x1b[35m================================================================================\x1b[0m');
    }, 1000);
    // 5b. Dynamic AI Parameter Optimizer Loop (Every 3 minutes)
    const runParameterOptimization = async () => {
        logDebug('Triggering dynamic AI parameter optimization for all active models...');
        const activeSymbols = Object.keys(CONFIG.SYMBOLS);
        const timeframes = ['5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];
        const candleData = {};
        const candleLimits = {
            '5m': 300,
            '15m': 300,
            '30m': 300,
            '1h': 300,
            '4h': 300,
            '1d': 200,
            '1w': 100,
            '1M': 50
        };
        logDebug('Fetching global market dominance stats from CoinGecko...');
        const dominance = await fetchGlobalMarketDominance();
        currentGlobalDominance = dominance;
        logDebug('Fetching multi-timeframe candles from Hyperliquid in parallel...');
        // Initialize structure
        for (const symbol of activeSymbols) {
            candleData[symbol] = {};
        }
        try {
            const jobs = [];
            for (const symbol of activeSymbols) {
                for (const tf of timeframes) {
                    jobs.push({ symbol, tf });
                }
            }
            // Bounded concurrency: bursts of 70+ simultaneous REST calls get connection-reset
            await mapWithConcurrency(jobs, 6, async ({ symbol, tf }) => {
                const tfLimit = candleLimits[tf] || 100;
                let candles = await circuitBreaker.call('hyperliquid_rest', () => exchange.getCandleSnapshot(symbol, tf, tfLimit), () => []);
                if (!candles || candles.length === 0) {
                    // Single retry after a short delay — transient network/rate-limit hiccups
                    await new Promise(resolve => setTimeout(resolve, 750));
                    try {
                        candles = await exchange.getCandleSnapshot(symbol, tf, tfLimit);
                    }
                    catch (err) {
                        logDebug(`Error retrying candles for ${symbol} (${tf}): ${err.message}`);
                        candles = [];
                    }
                }
                if (candles && candles.length > 0) {
                    candleData[symbol][tf] = candles;
                }
            });
            logDebug('Successfully fetched all multi-timeframe candles.');
            latestMarketContext = buildMarketContext(candleData, activeSymbols);
            logDebug('Multi-timeframe market context updated for Thinking Hub.');
        }
        catch (err) {
            logDebug(`Error during parallel candle fetching: ${err.message}`);
        }
        // Calculate premium indicators using indicators.ts
        const calculatedIndicators = {};
        for (const symbol of activeSymbols) {
            const h1Candles = candleData[symbol]['1h'] || [];
            if (h1Candles.length > 0) {
                const fibonacci = calculateFibonacci(h1Candles);
                const fvgs = calculateFVGs(h1Candles);
                const srLevels = calculateSRLevels(h1Candles, 5, 0.012);
                const poc = calculatePOC(h1Candles, 20);
                const atr = calculateATR(h1Candles, 14);
                calculatedIndicators[symbol] = { fibonacci, fvgs, srLevels, poc };
                if (atr) {
                    atrResults[symbol] = { atr: atr.atr, atrPct: atr.atrPct };
                }
                // Cache calculated indicators inside StrategyManager for each active model
                for (const model of Object.values(models)) {
                    model.strategy.setCalculatedIndicators(symbol, calculatedIndicators[symbol]);
                }
            }
        }
        // Feed multi-timeframe candles into the candle-based regime detector (v2):
        // makro = 1d + 4h structure, mikro = 15m ATR. Routing depends on this.
        for (const symbol of activeSymbols) {
            const regimeCandles = {
                d1: candleData[symbol]?.['1d'] || [],
                h4: candleData[symbol]?.['4h'] || [],
                m15: candleData[symbol]?.['15m'] || []
            };
            for (const model of Object.values(models)) {
                model.strategy.setRegimeCandles(symbol, regimeCandles);
            }
        }
        // Calculate correlation matrix for portfolio-level risk
        const correlationMatrix = portfolioManager.calculateCorrelationMatrix();
        if (correlationMatrix) {
            portfolioManager['lastMatrix'] = correlationMatrix;
            if (tickCount % 500 === 0) {
                logDebug(`[PORTFOLIO] Avg correlation: ${correlationMatrix.avgCorrelation.toFixed(3)} | Highest: ${correlationMatrix.highestCorrelated?.pair} (${correlationMatrix.highestCorrelated?.value.toFixed(3)})`);
            }
        }
        // Run optimization for each AI-configured model in CONFIG.MODELS in parallel
        const optimizationPromises = Object.entries(CONFIG.MODELS).map(async ([modelId, modelConf]) => {
            // If it's static, skip AI optimization
            if (modelConf.modelTag === 'static') {
                return;
            }
            const model = models[modelId];
            if (!model)
                return;
            try {
                logDebug(`[AI OPTIMIZER] [${modelId}] Calling NVIDIA API for model tag: ${modelConf.modelTag}`);
                const currentParams = model.strategy.getAllParams();
                // Wrap NVIDIA API call with circuit breaker
                const optimized = await circuitBreaker.call('nvidia_api', () => nvidiaObserver.optimizeParameters(model.execution.getStats(), model.execution.getTradesHistory(), activeSymbols, candleData, modelConf.modelTag, currentParams, calculatedIndicators, dominance), () => null // fallback = skip optimization if API down
                );
                if (optimized && optimized.parameters) {
                    // Parameter freeze (anti-overfit): insights tetap diambil untuk display
                    // Thinking Hub, tapi updateParams/setAiBiases TIDAK pernah dieksekusi
                    // kecuali AI_OPTIMIZER_ENABLED diaktifkan kembali secara sadar.
                    latestAiInsights[modelId] = optimized.analysis || {};
                    if (!CONFIG.AI_OPTIMIZER_ENABLED) {
                        logDebug(`[AI OPTIMIZER] [${modelId}] Params FROZEN — insight disimpan untuk display saja`);
                        return;
                    }
                    model.strategy.setAiBiases(latestAiInsights[modelId]);
                    for (const [symbol, params] of Object.entries(optimized.parameters)) {
                        model.strategy.updateParams(symbol, params);
                        logDebug(`[AI OPTIMIZER] [${modelId}] Applied updated params for ${symbol}`);
                    }
                }
            }
            catch (err) {
                logDebug(`Error optimizing model ${modelId}: ${err.message}`);
            }
        });
        await Promise.all(optimizationPromises);
        logDebug('Finished parallel parameter optimizations.');
        // Instantly push update to refresh UI with AI reasons
        sendDashboardUpdate();
    };
    const aiOptimizationInterval = setInterval(runParameterOptimization, 180000);
    // Warm start AI check: trigger the first optimization after 5 seconds of active trade monitoring
    const warmStartTimeout = setTimeout(() => {
        runParameterOptimization().catch(err => {
            logDebug(`Error during warm-start AI optimization: ${err.message}`);
        });
    }, 5000);
    // 6. Handle Graceful Shutdown
    const shutdown = () => {
        clearInterval(dashboardInterval);
        clearInterval(aiOptimizationInterval);
        clearTimeout(warmStartTimeout);
        dashboardServer.close();
        // NEW: Save semua active positions ke database sebelum shutdown
        for (const [modelId, model] of Object.entries(models)) {
            const positions = model.execution.getActivePositions();
            for (const pos of positions) {
                model.database.savePosition(pos);
            }
            model.database.close();
            logDebug(`[DATABASE] Saved ${positions.length} active positions for ${modelId}`);
        }
        logDebug('Shutdown signal received. Finalizing log.');
        console.log('\n\x1b[33m[SYSTEM] Shutdown signal received. Cleaning up resources...\x1b[0m');
        console.log('\x1b[36m================================================================================\x1b[0m');
        console.log('\x1b[1m\x1b[32m                        FINAL HFT TRADING SESSION SUMMARY                       \x1b[0m');
        console.log('\x1b[36m================================================================================\x1b[0m');
        for (const [modelId, model] of Object.entries(models)) {
            console.log(`\n\x1b[1m[MODEL: ${modelId}]\x1b[0m`);
            model.execution.renderDashboard();
            // NEW: Print risk metrics
            const metrics = model.execution.riskManager.getLatestMetrics(model.execution.getTradesHistory());
            console.log(`\x1b[33m  Sharpe: ${metrics.sharpeRatio} | Sortino: ${metrics.sortinoRatio} | Max DD: ${metrics.maxDrawdown}%\x1b[0m`);
            console.log(`\x1b[33m  VaR 95%: $${metrics.var95} | Profit Factor: ${metrics.profitFactor} | Consecutive Losses: ${metrics.consecutiveLosses}\x1b[0m`);
        }
        console.log('\x1b[32m[SYSTEM] Safely offline. Goodbye!\x1b[0m');
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
// Execute the async main entry point
main().catch((err) => {
    logDebug(`Unhandled critical error in main runner: ${err.message}`);
    process.exit(1);
});
