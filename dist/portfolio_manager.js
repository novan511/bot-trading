/**
 * Portfolio Manager Module
 *
 * Features:
 * - Rolling correlation matrix across monitored symbols
 * - Sector exposure / concentration risk
 * - Portfolio-level heat metrics for dashboard
 */
export class PortfolioManager {
    priceHistory = new Map();
    correlationWindow;
    lastMatrix = null;
    symbols;
    constructor(symbols, correlationWindow = 50) {
        this.symbols = symbols;
        this.correlationWindow = correlationWindow;
        for (const symbol of symbols) {
            this.priceHistory.set(symbol, []);
        }
    }
    updatePrice(symbol, price) {
        const history = this.priceHistory.get(symbol);
        if (!history)
            return;
        history.push(price);
        if (history.length > this.correlationWindow + 10) {
            history.splice(0, history.length - (this.correlationWindow + 10));
        }
    }
    updatePrices(prices) {
        for (const [symbol, price] of Object.entries(prices)) {
            this.updatePrice(symbol, price);
        }
    }
    getPriceSeries(symbol) {
        return this.priceHistory.get(symbol) || [];
    }
    calculateCorrelationMatrix() {
        const series = [];
        for (const symbol of this.symbols) {
            const prices = this.priceHistory.get(symbol) || [];
            if (prices.length >= this.correlationWindow) {
                series.push({ symbol, prices: prices.slice(-this.correlationWindow) });
            }
        }
        if (series.length < 2)
            return null;
        const matrix = {};
        const returns = {};
        for (const s of series) {
            returns[s.symbol] = [];
            const prices = s.prices;
            for (let i = 1; i < prices.length; i++) {
                const ret = (prices[i] - prices[i - 1]) / prices[i - 1];
                returns[s.symbol].push(ret);
            }
        }
        let sumCorr = 0;
        let countCorr = 0;
        let highest = null;
        let lowest = null;
        for (let i = 0; i < series.length; i++) {
            const s1 = series[i].symbol;
            matrix[s1] = {};
            for (let j = 0; j < series.length; j++) {
                const s2 = series[j].symbol;
                if (i === j) {
                    matrix[s1][s2] = 1;
                    continue;
                }
                const r1 = returns[s1];
                const r2 = returns[s2];
                const corr = pearson(r1, r2);
                matrix[s1][s2] = corr;
                sumCorr += corr;
                countCorr++;
                if (!highest || corr > highest.value)
                    highest = { pair: `${s1}-${s2}`, value: corr };
                if (!lowest || corr < lowest.value)
                    lowest = { pair: `${s1}-${s2}`, value: corr };
            }
        }
        return {
            updatedAt: Date.now(),
            window: this.correlationWindow,
            matrix,
            avgCorrelation: countCorr > 0 ? sumCorr / countCorr : 0,
            highestCorrelated: highest,
            lowestCorrelated: lowest
        };
    }
    getCorrelation(symbolA, symbolB) {
        const matrix = this.calculateCorrelationMatrix();
        if (!matrix)
            return 0;
        return matrix.matrix[symbolA]?.[symbolB] ?? 0;
    }
    getAverageCorrelation() {
        const matrix = this.calculateCorrelationMatrix();
        return matrix?.avgCorrelation ?? 0;
    }
    getLastMatrix() {
        return this.lastMatrix;
    }
    getSymbols() {
        return this.symbols;
    }
}
function pearson(x, y) {
    const n = Math.min(x.length, y.length);
    if (n === 0)
        return 0;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    let sumY2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += x[i];
        sumY += y[i];
        sumXY += x[i] * y[i];
        sumX2 += x[i] * x[i];
        sumY2 += y[i] * y[i];
    }
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (den === 0)
        return 0;
    return num / den;
}
