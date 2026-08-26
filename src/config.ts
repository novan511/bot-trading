import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // Hyperliquid Endpoints
  HYPERLIQUID_WS_URL: 'wss://api.hyperliquid.xyz/ws',
  HYPERLIQUID_REST_URL: 'https://api.hyperliquid.xyz',

  // Trading Mode
  SIMULATION_MODE: true,

  // Wallet
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',

  // Model registry
  MODELS: {
    Llama_8B: {
      id: 'Llama_8B',
      name: 'Llama 3.1 8B (AI Optimizer)',
      modelTag: 'meta/llama-3.1-8b-instruct',
      color: '#00f2fe',
      capitalAllocationUsd: 10000,
    }
  },

  // API keys
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://myvuvhagzvrfkbcwekqs.supabase.co/rest/v1/',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_ENABLED: true,

  // Trading Pairs Configuration
  SYMBOLS: {
    BTC: {
      name: 'BTC',
      tradeSizeUsd: 1000,
      tickSize: 1.0,
      lotSize: 0.0001,
      obiThreshold: 0.20,
      zScoreThreshold: 0.8,
      takeProfitPct: 0.0150,
      stopLossPct: 0.0050,
    },
    ETH: {
      name: 'ETH',
      tradeSizeUsd: 1000,
      tickSize: 0.1,
      lotSize: 0.001,
      obiThreshold: 0.22,
      zScoreThreshold: 0.8,
      takeProfitPct: 0.0180,
      stopLossPct: 0.0060,
    },
    SOL: {
      name: 'SOL',
      tradeSizeUsd: 1000,
      tickSize: 0.01,
      lotSize: 0.01,
      obiThreshold: 0.25,
      zScoreThreshold: 0.9,
      takeProfitPct: 0.0240,
      stopLossPct: 0.0080,
    },
    SUI: {
      name: 'SUI',
      tradeSizeUsd: 1000,
      tickSize: 0.0001,
      lotSize: 0.1,
      obiThreshold: 0.35,
      zScoreThreshold: 0.9,
      takeProfitPct: 0.0300,
      stopLossPct: 0.0100,
    },
    XRP: {
      name: 'XRP',
      tradeSizeUsd: 1000,
      tickSize: 0.0001,
      lotSize: 1.0,
      obiThreshold: 0.25,
      zScoreThreshold: 0.9,
      takeProfitPct: 0.0200,
      stopLossPct: 0.0060,
    },
    HYPE: {
      name: 'HYPE',
      tradeSizeUsd: 1000,
      tickSize: 0.001,
      lotSize: 0.1,
      obiThreshold: 0.35,
      zScoreThreshold: 0.9,
      takeProfitPct: 0.0300,
      stopLossPct: 0.0100,
    },
    DOGE: {
      name: 'DOGE',
      tradeSizeUsd: 1000,
      tickSize: 0.00001,
      lotSize: 1.0,
      obiThreshold: 0.25,
      zScoreThreshold: 0.9,
      takeProfitPct: 0.0240,
      stopLossPct: 0.0080,
    },
    NEAR: {
      name: 'NEAR',
      tradeSizeUsd: 1000,
      tickSize: 0.001,
      lotSize: 0.1,
      obiThreshold: 0.30,
      zScoreThreshold: 0.9,
      takeProfitPct: 0.0250,
      stopLossPct: 0.0080,
    },
    FET: {
      name: 'FET',
      tradeSizeUsd: 1000,
      tickSize: 0.0001,
      lotSize: 1.0,
      obiThreshold: 0.30,
      zScoreThreshold: 0.9,
      takeProfitPct: 0.0280,
      stopLossPct: 0.0090,
    }
  },

  // Strategy Core Constants
  ROLLING_WINDOW_SIZE: 30,
  EMA_FAST_PERIOD: 10,
  MAX_HOLD_DURATION_SEC: 86400,

  // Spacing and Downside Safeguards
  MIN_ENTRY_SPACING_PCT: 0.01,
  ENTRY_COOLDOWN_SEC: 300,
  CUMULATIVE_DRAWDOWN_LIMIT_PCT: 0.020,
  RUNAWAY_TRAILING_SL_MULTIPLIER: 0.45,

  // STOP LOSS+ : SL dikunci ke breakeven+fee setelah harga bergerak menguntungkan
  // sejauh buffer ini (0.003 = 0.3%). Sebelumnya 0.001 yang terlalu cepat
  // mengubah winner menjadi scratch exit.
  // STOP LOSS+ : SL dikunci ke breakeven+fee setelah harga bergerak menguntungkan
  // sejauh buffer ini (0.005 = 0.5%). Naik dari 0.003 karena review 200 trade (23-26 Agu)
  // menunjukkan median win hanya $2 (~0.04%): BE-stop yang terlalu dini mengubah winner
  // menjadi scratch exit saat pullback normal sebelum tren lanjut.
  BREAKEVEN_STOP_ACTIVATION_BUFFER_PCT: 0.005,

  // Trailing stop baru mengencang SETELAH trade berjalan sehat (>= 50% jarak TP).
  // Sebelumnya trailing mulai ketat sejak profit pertama tick -> winner kepotong di awal.
  TRAILING_ACTIVATION_RATIO: 0.5,

  // Guard ekstrem: skip entry saat |Z-score| > nilai ini (panic flush / melt-up).
  // Loss tercepat di data (-$50 dalam 27s) masuk saat Z ~ -1.0 s/d -1.15.
  EXTREME_ZSCORE_BLOCK: 1.0,

  // Cooldown per-symbol setelah kena STOP LOSS. Data: 10x re-entry <30 menit pasca-loss
  // >= $20 menambah rugi -$47 lagi (cooldown lama hanya 300s).
  POST_STOP_LOSS_COOLDOWN_SEC: 1800,

  // Cap notional per posisi (30% equity) dan cap exposure bruto seluruh posisi terbuka.
  // Window sizing 2x (23-24 Agu) menghasilkan semua loss terbesar (-$48..-$51).
  MAX_POSITION_NOTIONAL_USD: 3000,
  GROSS_EXPOSURE_CAP_USD: 20000,

  // Trade Filters — hasil review 200 trade live (23-26 Agu 2026, net -$272, PF 0.82):
  // - SELL total -$300 vs BUY +$27 (short mean-reversion negatif di SEMUA regime,
  //   tidak hanya TRENDING_BULL) -> ENABLE_SHORTS dimatikan sampai ada edge terbukti.
  // - DOGE: WR 37%, -$239 (87% dari total rugi), mayoritas short kontra-tren -> banned (multiplier 0).
  TRADE_FILTERS: {
    ENABLE_SHORTS: false,
    SHORT_BLOCKED_REGIMES: ['TRENDING_BULL'],
    SYMBOL_SIZE_MULTIPLIERS: {
      XRP: 0.5,
      SUI: 0.5,
      DOGE: 0,
      SOL: 0.5,
    } as Record<string, number>,
  },

  // Advanced Risk Management
  DAILY_DRAWDOWN_LIMIT_PCT: 0.05,
  MAX_POSITION_RISK_PCT: 0.01,
  ACCOUNT_BALANCE_USD: 10000,
  PER_MODEL_CAPITAL_ALLOCATION_USD: 10000,
  MAX_CONCURRENT_POSITIONS: 12,
  PORTFOLIO_SECTOR_LIMIT_PCT: 0.60,

  // Per-symbol auto guards (kill switch). Data 23-26 Agu: DOGE butuh 19 trade / -$239
  // sebelum manusia sadar dan menguncinya manual -> diotomatisasi.
  RISK_GUARDS: {
    // Rolling expectancy kill switch: jika N trade terakhir sebuah simbol
    // (minimal MIN_TRADES supaya tidak overfit ke noise) net negatif DAN win rate < 50%,
    // simbol disuspend otomatis.
    SYMBOL_KILLSWITCH_WINDOW: 30,
    SYMBOL_KILLSWITCH_MIN_TRADES: 30,
    SYMBOL_KILLSWITCH_SUSPEND_HOURS: 24,
    // Circuit breaker loss beruntun: N loss berturut-turut pada simbol yang sama = suspend lebih singkat.
    SYMBOL_MAX_CONSECUTIVE_LOSSES: 5,
    SYMBOL_CONSEC_LOSS_SUSPEND_HOURS: 8,
  },

  // Partial Take Profit
  TP1_PCT: 0.30,
  TP2_PCT: 0.30,
  TP3_TRAIL_PCT: 0.40,

  // Volatility-Based Sizing
  ATR_PERIOD: 14,
  ATR_MULTIPLIER_MIN: 0.5,
  ATR_MULTIPLIER_MAX: 1.5,
  BASE_RISK_PER_TRADE_USD: 100,

  // Kelly Criterion
  KELLY_FRACTION: 0.25,

  // Time-Based Filtering
  TRADING_SESSION_START_HOUR_UTC: 1,
  TRADING_SESSION_END_HOUR_UTC: 21,

  // Liquidity Sweep Detection
  LIQUIDITY_SWEEP_WINDOW_TICKS: 50,
  SWEEP_BODY_THRESHOLD_PCT: 0.001,

  // Regime Detection
  // v2: candle-based (makro = 1d + 4h EMA structure, mikro = ATR 15m).
  // Tick-based detection tetap ada sebagai fallback degraded saat candle belum/belum lagi tersedia.
  REGIME_LOOKBACK_CANDLES: 50,
  REGIME_EMA_PERIOD: 20,
  REGIME_TREND_STRENGTH_THRESHOLD: 0.3,
  REGIME_MACRO_EMA_FAST: 20,
  REGIME_MACRO_EMA_SLOW: 50,
  REGIME_MIN_CANDLES_MACRO: 60,
  REGIME_MIN_CANDLES_MICRO: 30,
  REGIME_CANDLE_MAX_AGE_MS: 10 * 60 * 1000,
  // ATR% per candle 15m: di atas ini = chaos (no-trade), di bawah ini = dead market (no-trade)
  REGIME_MICRO_HIGH_VOL_ATR_PCT: 0.006,
  REGIME_MICRO_LOW_VOL_ATR_PCT: 0.001,

  // Market Microstructure
  OFI_WINDOW_TICKS: 10,
  CVD_WINDOW_TICKS: 20,

  // VWAP & Volume Profile
  VWAP_PERIOD_CANDLES: 24,
  VALUE_AREA_PCT: 0.70,

  // Pairs Trading
  PAIRS_ZSCORE_ENTRY: 2.0,
  PAIRS_ZSCORE_EXIT: 0.5,
  PAIRS_LOOKBACK_PERIODS: 100,
  TRADABLE_PAIRS: [
    ['BTC', 'ETH'],
    ['BTC', 'SOL'],
    ['ETH', 'SOL'],
    ['SOL', 'SUI'],
  ],

  // Performance Tracking
  PERFORMANCE_TRACKING_ENABLED: true,

  // Hyperliquid Fee Rates
  MAKER_FEE_PCT: 0.0001,
  TAKER_FEE_PCT: 0.0003,

  // Logging
  LOG_LEVEL: 'info',

  // Optimization
  // FALSE = parameter DIBEKUKAN (anti-overfit): pipeline data/indikator/regime tetap
  // jalan tiap 3 menit, tapi NVIDIA TIDAK dipanggil dan updateParams tidak pernah dieksekusi.
  // Retune hanya boleh dilakukan manual berdasarkan laporan Go-Live di /performance.
  AI_OPTIMIZER_ENABLED: false,
  // Jika ENABLED=true kembali: interval mutasi param. Disiplin sampling = minimal seminggu.
  AI_OPTIMIZATION_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000,
};

export type Config = typeof CONFIG;
