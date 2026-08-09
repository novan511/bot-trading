import WebSocket from 'ws';
import { CONFIG } from './config.js';
import { OrderBook, Side, CandleSnapshot } from './types.js';
import { IExchangeConnector } from './exchange.interface.js';

type BookUpdateCallback = (book: OrderBook) => void;

export class ExchangeConnector implements IExchangeConnector {
  private ws: WebSocket | null = null;
  private onBookUpdateCallback: BookUpdateCallback | null = null;
  private isReconnecting = false;
  private connected = false;

  constructor() {}

  public onBookUpdate(callback: BookUpdateCallback) {
    this.onBookUpdateCallback = callback;
  }

  public connect() {
    if (this.connected || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const wsUrl = CONFIG.HYPERLIQUID_WS_URL;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.connected = true;
      this.isReconnecting = false;
      for (const symbolConfig of Object.values(CONFIG.SYMBOLS)) {
        this.subscribeToCoin(symbolConfig.name);
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const rawMessage = JSON.parse(data.toString());
        if (rawMessage.channel === 'l2Book' && rawMessage.data) {
          const bookData = rawMessage.data;
          const symbol = bookData.coin;
          const bids = bookData.levels[0];
          const asks = bookData.levels[1];

          if (bids && bids.length > 0 && asks && asks.length > 0) {
            const bestBidPrice = parseFloat(bids[0].px);
            const bestBidQty = parseFloat(bids[0].sz);
            const bestAskPrice = parseFloat(asks[0].px);
            const bestAskQty = parseFloat(asks[0].sz);

            const book: OrderBook = {
              symbol,
              bids: [[bestBidPrice, bestBidQty]],
              asks: [[bestAskPrice, bestAskQty]],
              updatedAt: bookData.time,
            };

            if (this.onBookUpdateCallback) {
              this.onBookUpdateCallback(book);
            }
          }
        }
      } catch (err) {
        console.error('[EXCHANGE] Error parsing Hyperliquid WebSocket message:', err);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.reconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[EXCHANGE] Hyperliquid WebSocket error:', err.message);
      this.connected = false;
      this.ws?.close();
    });
  }

  public disconnect() {
    this.connected = false;
    this.ws?.close();
    this.ws = null;
  }

  public isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private subscribeToCoin(coin: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const subMessage = {
      method: 'subscribe',
      subscription: { type: 'l2Book', coin }
    };
    this.ws.send(JSON.stringify(subMessage));
  }

  private reconnect() {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    console.log('[EXCHANGE] Reconnecting to Hyperliquid in 3 seconds...');
    setTimeout(() => {
      this.isReconnecting = false;
      this.connect();
    }, 3000);
  }

  public async submitSimulatedOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    price: number,
    quantity: number,
    isMaker = true
  ): Promise<{ orderId: string; success: boolean; executedPrice: number; feeUsd: number }> {
    const executionDelay = Math.floor(Math.random() * 4) + 2;
    return new Promise((resolve) => {
      setTimeout(() => {
        const orderId = 'hl-' + Math.random().toString(36).substring(2, 11).toUpperCase();
        const orderValue = price * quantity;
        const feeRate = isMaker ? CONFIG.MAKER_FEE_PCT : CONFIG.TAKER_FEE_PCT;
        const feeUsd = orderValue * feeRate;
        resolve({ orderId, success: true, executedPrice: price, feeUsd });
      }, executionDelay);
    });
  }

  public async getCandleSnapshot(coin: string, interval: string, limit = 10): Promise<CandleSnapshot[]> {
    const url = `${CONFIG.HYPERLIQUID_REST_URL}/info`;
    const now = Date.now();
    let intervalMs = 60 * 1000;
    if (interval === '5m') intervalMs = 5 * 60 * 1000;
    else if (interval === '15m') intervalMs = 15 * 60 * 1000;
    else if (interval === '30m') intervalMs = 30 * 60 * 1000;
    else if (interval === '1h') intervalMs = 60 * 60 * 1000;
    else if (interval === '4h') intervalMs = 4 * 60 * 60 * 1000;
    else if (interval === '1d') intervalMs = 24 * 60 * 60 * 1000;
    else if (interval === '1w') intervalMs = 7 * 24 * 60 * 60 * 1000;
    else if (interval === '1M') intervalMs = 30 * 24 * 60 * 60 * 1000;

     const startTime = now - (limit + 10) * intervalMs;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval, startTime, endTime: now }
        })
      });

      if (!response.ok) {
        throw new Error(`REST API error: ${response.status} ${response.statusText}`);
      }

      const candles = (await response.json()) as any[];
      if (!Array.isArray(candles)) return [];

      return candles.slice(-limit).map(c => ({
        time: c.t,
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
        volume: parseFloat(c.v)
      }));
    } catch (err: any) {
      console.error(`[EXCHANGE] Failed to fetch candles for ${coin} (${interval}): ${err.message}`);
      return [];
    }
  }

  public async submitLiveOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number): Promise<any> {
    if (!CONFIG.WALLET_PRIVATE_KEY) {
      throw new Error('[EXCHANGE] Cannot execute live Hyperliquid trade: WALLET_PRIVATE_KEY is missing.');
    }
    console.log(`[EXCHANGE] [LIVE ORDER] Sending ${side} signed order for ${quantity} ${symbol} perp to Hyperliquid...`);
    return { success: false, error: 'Live trade not active. Turn on simulation.' };
  }
}

