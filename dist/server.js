import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { AITradeAnalyzer } from './ai_trade_analyzer.js';
import { TradeAnalyzer } from './trade_analyzer.js';
export class WebDashboardServer {
    server;
    wss;
    clients = new Set();
    tickCount = 0;
    lastUpdateData = null;
    onManualCloseCallback = null;
    onToggleStatusCallback = null;
    onStrategyParamCallback = null;
    onTpSlUpdateCallback = null;
    onApplySuggestionsCallback = null;
    exchange;
    performanceDataProvider = null;
    constructor(port = 3000, exchange) {
        this.exchange = exchange;
        this.server = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
            if (req.method === 'GET' && url.startsWith('/api/suggestions')) {
                const parsedUrl = new URL(url, `http://${req.headers.host}`);
                const symbolFilter = parsedUrl.searchParams.get('symbol');
                const data = this.performanceDataProvider ? this.performanceDataProvider() : { runners: {} };
                const runners = data.runners || {};
                const allTrades = [];
                for (const runner of Object.values(runners)) {
                    try {
                        const execution = runner.execution;
                        if (execution && execution.getTradesHistory) {
                            allTrades.push(...execution.getTradesHistory());
                        }
                    }
                    catch { }
                }
                const filteredTrades = (symbolFilter && symbolFilter !== 'ALL')
                    ? allTrades.filter(t => t.symbol === symbolFilter.toUpperCase())
                    : allTrades;
                const analyzer = new TradeAnalyzer();
                const firstRunner = Object.values(runners)[0];
                const strategy = firstRunner?.strategy;
                // Per-coin analysis compares against that coin's effective running params
                let analysisParams = strategy?.getAllParams?.() || {};
                const payload = { totalTrades: filteredTrades.length, symbol: symbolFilter || 'ALL' };
                if (symbolFilter && symbolFilter !== 'ALL' && strategy?.getSymbolEffectiveParams) {
                    analysisParams = strategy.getSymbolEffectiveParams(symbolFilter.toUpperCase());
                    payload.currentParams = analysisParams;
                }
                payload.suggestions = analyzer.analyzeHistoricalPerformance(filteredTrades, analysisParams);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
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
            }
            else {
                socket.destroy();
            }
        });
        // Monitor browser client connections
        this.wss.on('connection', (ws, request) => {
            this.clients.add(ws);
            // Send initial data packet immediately on connection
            if (this.lastUpdateData) {
                ws.send(JSON.stringify({
                    type: 'dashboard_update',
                    data: this.lastUpdateData
                }));
            }
            else {
                // Send a lightweight ping so the client knows the connection is alive;
                // the next broadcastUpdate will carry the full payload.
                ws.send(JSON.stringify({ type: 'heartbeat' }));
            }
            ws.on('message', (message) => {
                try {
                    const parsed = JSON.parse(message.toString());
                    if (parsed.type === 'manual_close' && parsed.symbol && parsed.modelId) {
                        console.log(`\x1b[35m[WEB-UI] Received manual close request for model ${parsed.modelId} symbol ${parsed.symbol}\x1b[0m`);
                        if (this.onManualCloseCallback) {
                            this.onManualCloseCallback(parsed.modelId, parsed.symbol);
                        }
                    }
                    else if (parsed.type === 'toggle_system_status') {
                        console.log(`\x1b[35m[WEB-UI] Received system ON/OFF status toggle request\x1b[0m`);
                        if (this.onToggleStatusCallback) {
                            this.onToggleStatusCallback();
                        }
                    }
                    else if (parsed.type === 'request_thinking_detail' && parsed.symbol) {
                        if (this.lastUpdateData) {
                            const models = this.lastUpdateData.models || {};
                            const details = {};
                            for (const [modelId, modelData] of Object.entries(models)) {
                                const aiInsights = modelData.aiInsights || {};
                                if (aiInsights[parsed.symbol]) {
                                    const insight = aiInsights[parsed.symbol];
                                    const activePos = (modelData.activePositions || []).find((p) => p.symbol === parsed.symbol);
                                    details[modelId] = {
                                        insight,
                                        position: activePos || null,
                                        stats: modelData.stats || null
                                    };
                                }
                            }
                            ws.send(JSON.stringify({
                                type: 'thinking_detail',
                                symbol: parsed.symbol,
                                details
                            }));
                        }
                    }
                    else if (parsed.type === 'request_risk_metrics' && parsed.modelId) {
                        ws.send(JSON.stringify({
                            type: 'risk_metrics_response',
                            modelId: parsed.modelId,
                            data: this.lastUpdateData?.models?.[parsed.modelId]?.riskMetrics || null
                        }));
                    }
                    else if (parsed.type === 'request_equity_curve' && parsed.modelId) {
                        ws.send(JSON.stringify({
                            type: 'equity_curve_response',
                            modelId: parsed.modelId,
                            data: this.lastUpdateData?.models?.[parsed.modelId]?.equityCurve || []
                        }));
                    }
                    else if (parsed.type === 'request_performance_attribution' && parsed.modelId) {
                        ws.send(JSON.stringify({
                            type: 'performance_attribution_response',
                            modelId: parsed.modelId,
                            data: this.lastUpdateData?.models?.[parsed.modelId]?.performanceAttribution || []
                        }));
                    }
                    else if (parsed.type === 'request_dashboard_data') {
                        if (this.lastUpdateData) {
                            ws.send(JSON.stringify({
                                type: 'dashboard_update',
                                data: this.lastUpdateData
                            }));
                        }
                    }
                    else if (parsed.type === 'update_strategy_param' && parsed.symbol && parsed.key && parsed.value !== undefined) {
                        console.log(`\x1b[35m[WEB-UI] Received strategy param update: ${parsed.symbol} ${parsed.key} = ${parsed.value}\x1b[0m`);
                        if (this.onStrategyParamCallback) {
                            if (parsed.key === 'reset') {
                                this.onStrategyParamCallback(parsed.symbol, 'reset', 0);
                            }
                            else {
                                this.onStrategyParamCallback(parsed.symbol, parsed.key, parsed.value);
                            }
                        }
                        ws.send(JSON.stringify({
                            type: 'strategy_param_updated',
                            symbol: parsed.symbol,
                            key: parsed.key,
                            value: parsed.value
                        }));
                    }
                    else if (parsed.type === 'update_tp_sl' && parsed.symbol && parsed.lineType && parsed.newPrice !== undefined) {
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
                    }
                    else if (parsed.type === 'request_suggestions') {
                        if (this.lastUpdateData) {
                            const runners = this.lastUpdateData.models || {};
                            const allTrades = [];
                            for (const runner of Object.values(runners)) {
                                try {
                                    const execution = runner.execution;
                                    if (execution && execution.getTradesHistory) {
                                        allTrades.push(...execution.getTradesHistory());
                                    }
                                }
                                catch { }
                            }
                            const analyzer = new TradeAnalyzer();
                            const firstRunner = Object.values(runners)[0];
                            const currentParams = firstRunner?.strategy?.getAllParams?.() || {};
                            const suggestions = analyzer.analyzeHistoricalPerformance(allTrades, currentParams);
                            ws.send(JSON.stringify({
                                type: 'suggestions_response',
                                suggestions,
                                totalTrades: allTrades.length
                            }));
                        }
                    }
                    else if (parsed.type === 'apply_suggestions' && parsed.suggestions) {
                        console.log(`\x1b[35m[WEB-UI] Applying suggestions:\x1b[0m`, parsed.suggestions);
                        if (this.onApplySuggestionsCallback) {
                            this.onApplySuggestionsCallback(parsed.suggestions);
                        }
                        ws.send(JSON.stringify({
                            type: 'suggestions_applied',
                            suggestions: parsed.suggestions
                        }));
                    }
                }
                catch (err) {
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
    serveFile(filename, res) {
        const filePath = path.join(process.cwd(), 'public', filename);
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading UI: ' + err.message);
                return;
            }
            const ext = path.extname(filename);
            const mimeTypes = {
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
    broadcastTick() {
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
    broadcastUpdate(engineData) {
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
    broadcast(payload) {
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        }
    }
    registerManualCloseCallback(callback) {
        this.onManualCloseCallback = callback;
    }
    registerToggleStatusCallback(callback) {
        this.onToggleStatusCallback = callback;
    }
    registerPerformanceDataProvider(provider) {
        this.performanceDataProvider = provider;
    }
    registerTpSlUpdateCallback(callback) {
        this.onTpSlUpdateCallback = callback;
    }
    registerApplySuggestionsCallback(callback) {
        this.onApplySuggestionsCallback = callback;
    }
    registerStrategyParamCallback(callback) {
        this.onStrategyParamCallback = callback;
    }
    handlePerformanceApi(req, res) {
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
                const models = {};
                const runners = data.runners || {};
                for (const [id, runner] of Object.entries(runners)) {
                    try {
                        const execution = runner.execution;
                        const stats = execution && execution.getStats ? execution.getStats() : {};
                        models[id] = { stats };
                    }
                    catch {
                        models[id] = { stats: {} };
                    }
                }
                const strategyOverrides = {};
                for (const [id, runner] of Object.entries(runners)) {
                    try {
                        const strategy = runner.strategy;
                        if (strategy && strategy.getAllOverrides) {
                            const allOverrides = strategy.getAllOverrides();
                            const firstSymbol = Object.keys(allOverrides)[0];
                            strategyOverrides[id] = firstSymbol ? allOverrides[firstSymbol] : {};
                        }
                    }
                    catch { }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ models, strategyOverrides }));
                return;
            }
            const analyzer = new AITradeAnalyzer();
            const allTrades = [];
            const runners = data.runners || {};
            let correlationMatrix = null;
            for (const runner of Object.values(runners)) {
                try {
                    const execution = runner.execution;
                    if (execution) {
                        const trades = execution.getTradesHistory ? execution.getTradesHistory() : [];
                        allTrades.push(...trades);
                    }
                }
                catch { }
            }
            const riskMetrics = null;
            const analysis = analyzer.analyze(allTrades, riskMetrics);
            const strategyOverrides = {};
            for (const [id, runner] of Object.entries(runners)) {
                try {
                    const strategy = runner.strategy;
                    if (strategy && strategy.getAllOverrides) {
                        const allOverrides = strategy.getAllOverrides();
                        const firstSymbol = Object.keys(allOverrides)[0];
                        strategyOverrides[id] = firstSymbol ? allOverrides[firstSymbol] : {};
                    }
                }
                catch { }
            }
            const responsePayload = {
                trades: allTrades,
                analysis,
                models: Object.fromEntries(Object.entries(runners).map(([id, r]) => [id, { stats: (r.execution && r.execution.getStats) ? r.execution.getStats() : {} }])),
                correlationMatrix,
                strategyOverrides
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));
        }
        catch (err) {
            console.error('[PERF API] Error:', err.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }
    }
    close() {
        this.wss.close();
        this.server.close();
    }
}
