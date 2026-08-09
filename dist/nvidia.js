import { CONFIG } from './config.js';
export class NvidiaObserver {
    apiKey;
    endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
    model = 'meta/llama-3.1-8b-instruct';
    constructor() {
        this.apiKey = process.env.NVIDIA_API_KEY || '';
        if (!this.apiKey) {
            console.warn('\x1b[33m[NVIDIA OBSERVER] Warning: NVIDIA_API_KEY is not set. Dynamic optimization will fallback to defaults.\x1b[0m');
        }
    }
    /**
     * Invokes Llama 3.1 8B to analyze the session stats, technical indicators, and global dominance, returning optimized parameters.
     */
    async optimizeParameters(stats, recentTrades, activeSymbols, candleData, modelOverride, currentParamsSnapshot, calculatedIndicators, globalDominance) {
        if (!this.apiKey)
            return null;
        // Filter down to the last 15 trades to avoid prompt bloat while retaining high context density
        const subsetTrades = recentTrades.slice(-15).map(t => ({
            symbol: t.symbol,
            side: t.side,
            entry: t.entryPrice,
            exit: t.exitPrice,
            netUsd: parseFloat(t.netProfitUsd.toFixed(4)),
            result: t.result,
            holdTimeSec: Math.round(t.holdTimeSec)
        }));
        // Build current parameters snapshot to give LLM a reference point if not provided
        const paramsSnapshot = currentParamsSnapshot || {};
        if (!currentParamsSnapshot) {
            for (const symbol of activeSymbols) {
                const symConf = CONFIG.SYMBOLS[symbol];
                if (symConf) {
                    paramsSnapshot[symbol] = {
                        obiThreshold: symConf.obiThreshold,
                        zScoreThreshold: symConf.zScoreThreshold,
                        takeProfitPct: symConf.takeProfitPct,
                        stopLossPct: symConf.stopLossPct
                    };
                }
            }
        }
        const systemPrompt = `You are a premium quantitative strategist AI Observer for an advanced multi-timeframe swing/scalping trading bot.
Your role is to analyze multi-timeframe candlestick data (5m, 15m, 30m, 1h, 4h, 1d, 1w, 1M), premium technical indicators (Fibonacci Retracements, Fair Value Gaps, Support & Resistance levels, Point of Control), global market dominance stats (BTC & USDT dominance), and recent trade outcomes.
Using this information, determine the macro-to-micro market bias per symbol and optimize trading parameters dynamically for the next trading window.

MARKET DOMINANCE DATA INTEGRATION:
- BTC Dominance (BTC.D): Represents BTC's share of the market. High/Rising BTC.D during market strength means capital is flowing into BTC (favor BTC trades over altcoins). Falling BTC.D during alt-season means alts are stronger (favor SOL, SUI, XRP, DOGE, HYPE).
- USDT Dominance (USDT.D): Represents cash sideline levels. High/Rising USDT.D indicates market fear/panic selling (tighten Stop Losses, wait for deeper pullbacks). Falling USDT.D indicates high risk-on buying (loosen entry requirements, trade aggressively).

MULTI-TIMEFRAME ANALYSIS MANDATE (TOP-DOWN ANALYSIS):
Analyze the provided candle trends and premium indicators for each symbol across:
- Macro Trend: 4-Hour (4h), Daily (1d), Weekly (1w), and Monthly (1M). What is the primary swing structure?
- Mid-Term Trend: 1-Hour (1h) and 30-Minute (30m). What is the intermediate direction?
- Micro Trend: 15-Minute (15m) and 5-Minute (5m). What is the immediate execution direction?

You must synthesize these timeframes:
- If both Macro and Micro are strongly bullish, lock bias as "BULLISH".
- If they are strongly bearish, lock bias as "BEARISH".
- If conflicting, flat, or consolidating at key S/R zones, set bias to "NEUTRAL".

STRICT RISK-TO-REWARD (R:R) MANDATE (1:2 to 1:4):
1. Profit Protection & Edge: To ensure long-term profitability, you MUST enforce a Risk-to-Reward ratio between 1:2 and 1:4 for every single symbol.
2. Stop Loss limits: stopLossPct MUST be strictly between 0.25x and 0.50x of takeProfitPct.
   - For example: if takeProfitPct is 0.0200 (2.0%), stopLossPct MUST be between 0.0050 (0.50%) and 0.0100 (1.00%).
   - NEVER let stopLossPct exceed 0.50x of takeProfitPct!
3. Parameter bounds:
   - obiThreshold: [0.12 to 0.40] - Tick volume imbalance sensitivity.
   - zScoreThreshold: [0.6 to 1.8] - Mean-reversion tick trigger depth.
   - takeProfitPct: [0.0100 to 0.0500] (1.0% to 5.0%) - Swing target.
   - stopLossPct: [0.0030 to 0.0200] (0.3% to 2.0%) - Swing stop loss. MUST be 0.25x to 0.50x of takeProfitPct.

OUTPUT FORMAT:
Return ONLY a valid, raw JSON object matching the exact schema below. Do not output markdown code fences, do not write explanations outside JSON, do not add text before or after the JSON.

REQUIRED JSON SCHEMA:
{
  "parameters": {
    "SYMBOL": { "obiThreshold": number, "zScoreThreshold": number, "takeProfitPct": number, "stopLossPct": number }
  },
  "analysis": {
    "SYMBOL": { 
      "bias": "BULLISH" | "BEARISH" | "NEUTRAL", 
      "confidence": number, 
      "rationale": "Provide a very concise quantitative rationale in INDONESIAN explaining the trend and key indicator levels. Keep it under 20 words.",
      "current_thoughts": "Apa yang sedang dipikirkan AI saat ini berdasarkan data market (dalam Bahasa Indonesia)",
      "planned_action": "Apa yang akan dan mau dilakukan AI selanjutnya (contoh: cari entry long, hold, dsb)",
      "waiting_for": "Apa kondisi yang sedang ditunggu (contoh: pullback ke fib 0.618, volume spike, dsb)",
      "post_algorithm_thoughts": "Apa yang dipikirkan AI setelah mengevaluasi algoritma dan hasil parameter yang baru",
      "timeframeAnalysis": {
        "macro": { "trend": "BULLISH" | "BEARISH" | "NEUTRAL", "summary": "Ringkasan tren jangka panjang dari 1M/1w/1d dalam Bahasa Indonesia" },
        "mid": { "trend": "BULLISH" | "BEARISH" | "NEUTRAL", "summary": "Ringkasan tren intermediate dari 4h/1h/30m dalam Bahasa Indonesia" },
        "micro": { "trend": "BULLISH" | "BEARISH" | "NEUTRAL", "summary": "Ringkasan kondisi mikro dari 15m/5m untuk entry dalam Bahasa Indonesia" }
      }
    }
  }
}

Example Response:
{
  "parameters": {
    "BTC": { "obiThreshold": 0.22, "zScoreThreshold": 0.85, "takeProfitPct": 0.0150, "stopLossPct": 0.0050 }
  },
  "analysis": {
    "BTC": { 
      "bias": "BULLISH", 
      "confidence": 90, 
      "rationale": "Pantulan di Fib 0.618 dan Support $77K divalidasi.",
      "current_thoughts": "Momentum sedang kuat ke atas, indikator teknikal menunjukan dominasi buyer di zona ini.",
      "planned_action": "Mempersiapkan eksekusi LONG jika ada sedikit koreksi di timeframe kecil.",
      "waiting_for": "Tunggu FVG bullish 5m terisi sebagai konfirmasi entry optimal.",
      "post_algorithm_thoughts": "Parameter R:R 1:3 sudah dilock, risiko terjaga, siap menangkap pergerakan naik selanjutnya.",
      "timeframeAnalysis": {
        "macro": { "trend": "BULLISH", "summary": "Monthly dan weekly candle forming higher highs, daily support di area $64K valid tanpa breakdown." },
        "mid": { "trend": "BULLISH", "summary": "4h trending bullish dengan higher lows, 1h forming bullish FVG di $65K-66K." },
        "micro": { "trend": "BULLISH", "summary": "15m oversold (Z-score -1.2), OBI accumulating, siap entry di pullback ke Fib 0.618." }
      }
    }
  }
}`;
        // Build a long-term summary per symbol from the entire trade history
        const longTermStatsPerSymbol = {};
        for (const symbol of activeSymbols) {
            const symbolTrades = recentTrades.filter(t => t.symbol === symbol);
            if (symbolTrades.length > 0) {
                const wins = symbolTrades.filter(t => t.result === 'WIN').length;
                const total = symbolTrades.length;
                const netProfit = symbolTrades.reduce((sum, t) => sum + t.netProfitUsd, 0);
                longTermStatsPerSymbol[symbol] = {
                    allTimeTradesCount: total,
                    allTimeWinRate: `${((wins / total) * 100).toFixed(1)}%`,
                    allTimeNetProfitUsd: parseFloat(netProfit.toFixed(4))
                };
            }
            else {
                longTermStatsPerSymbol[symbol] = {
                    allTimeTradesCount: 0,
                    allTimeWinRate: '0.0%',
                    allTimeNetProfitUsd: 0
                };
            }
        }
        const summarizedCandles = {};
        for (const [symbol, timeframesData] of Object.entries(candleData)) {
            summarizedCandles[symbol] = {};
            for (const [tf, candles] of Object.entries(timeframesData)) {
                if (!candles || candles.length === 0) {
                    summarizedCandles[symbol][tf] = { close: 0, changePct: '0.00%', trend: 'NEUTRAL' };
                    continue;
                }
                const latestCandle = candles[candles.length - 1];
                const oldestCandle = candles[0];
                const latestClose = latestCandle.close;
                const oldestOpen = oldestCandle.open;
                const changePct = oldestOpen !== 0 ? ((latestClose - oldestOpen) / oldestOpen) * 100 : 0;
                let trend = 'NEUTRAL';
                if (changePct > 0.05)
                    trend = 'BULLISH';
                else if (changePct < -0.05)
                    trend = 'BEARISH';
                summarizedCandles[symbol][tf] = {
                    close: parseFloat(latestClose.toFixed(4)),
                    changePct: `${changePct.toFixed(2)}%`,
                    trend
                };
            }
        }
        const userPrompt = {
            allTimeStats: {
                totalTrades: stats.totalTrades,
                winningTrades: stats.winningTrades,
                losingTrades: stats.losingTrades,
                winRate: `${stats.winRate.toFixed(2)}%`,
                netProfitUsd: parseFloat(stats.netProfitUsd.toFixed(4)),
                totalFeesUsd: parseFloat(stats.totalFeesUsd.toFixed(4))
            },
            globalMarketDominance: globalDominance || { btcDom: 54.0, usdtDom: 5.5 },
            currentParameters: paramsSnapshot,
            allTimePerformancePerCoin: longTermStatsPerSymbol,
            recentTradesMicroContext: subsetTrades, // last 15 trades
            symbolsToOptimize: activeSymbols,
            multiTimeframeCandles: summarizedCandles, // Summarized trend data for each symbol
            premiumQuantitativeIndicators: calculatedIndicators || {} // Fibonacci, FVGs, S/R levels, and POC
        };
        try {
            const controller = new AbortController();
            const timeoutMs = 45000;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    model: modelOverride || this.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: JSON.stringify(userPrompt, null, 2) }
                    ],
                    max_tokens: 4096,
                    temperature: 0.2
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                console.error(`[NVIDIA OBSERVER] API Error: ${response.status} ${response.statusText} | ${errorText.slice(0, 200)}`);
                return null;
            }
            const responseBody = (await response.json());
            const content = responseBody.choices?.[0]?.message?.content?.trim();
            if (!content) {
                console.error('[NVIDIA OBSERVER] Empty response content from API.');
                return null;
            }
            // Strip markdown code fences if Llama wrapped the output in ```json ... ```
            let cleanedJson = content;
            if (cleanedJson.includes('```')) {
                const matches = cleanedJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                if (matches && matches[1]) {
                    cleanedJson = matches[1].trim();
                }
            }
            const parsed = JSON.parse(cleanedJson);
            if (!parsed.parameters || !parsed.analysis) {
                console.error('[NVIDIA OBSERVER] Received JSON missing required properties.', parsed);
                return null;
            }
            return parsed;
        }
        catch (err) {
            console.error(`[NVIDIA OBSERVER] Dynamic parameter optimization failed gracefully: ${err.message}`);
            return null;
        }
    }
}
