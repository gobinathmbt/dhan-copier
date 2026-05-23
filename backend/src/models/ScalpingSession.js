const mongoose = require('mongoose');

const ScalpingSessionSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['running', 'stopped', 'finished', 'error'],
      default: 'running',
      index: true,
    },
    aiModel: { type: String, default: 'gpt-4o-mini' },
    settings: {
      capital: { type: Number, required: true },
      maxCapitalUsagePct: { type: Number, default: 30 },  // REDUCED from 50 - more conservative
      riskPerTradePct: { type: Number, default: 1 },
      maxDailyLossPct: { type: Number, default: 3 },
      
      // ── INSTITUTIONAL THRESHOLDS ─────────────────────────────────────────
      minConfidence: { type: Number, default: 8 },        // RAISED from 7 - institutional standard
      minBreakoutProb: { type: Number, default: 0.7 },    // RAISED from 0.6 - higher probability required
      minTrendStrength: { type: Number, default: 0.3 },   // RAISED from 6 - stronger trends only
      minRR: { type: Number, default: 2.0 },              // RAISED from 1.5 - enforce 1:2 minimum
      
      lotSize: { type: Number, default: 65 },

      // ── LOT MANAGEMENT ──────────────────────────────────────────────────
      minLots: { type: Number, default: 1 },
      maxLots: { type: Number, default: 3 },              // Max lots per trade
      // ── ANTI-OVERTRADING ────────────────────────────────────────────────
      maxConcurrentTrades: { type: Number, default: 3 },  // PER-SYMBOL cap (NIFTY 3 + SENSEX 3 = 6 total)
      cooldownSec: { type: Number, default: 120 },        // INCREASED from 30 - prevent overtrading

      // ── IMPROVED RISK MANAGEMENT ────────────────────────────────────────
      targetPoints: { type: Number, default: 15 },        // INCREASED from 5 - realistic targets
      slPoints: { type: Number, default: 10 },            // KEPT at 10 - proper 1:1.5 RR
      maxHoldTimeSeconds: { type: Number, default: 180 }, // REDUCED from 300 - faster exits

      // ── SWING SETTINGS ───────────────────────────────────────────────────
      enableSwing: { type: Boolean, default: false },     // DISABLED - focus on scalping first
      swingMinPoints: { type: Number, default: 40 },
      swingMaxHoldMinutes: { type: Number, default: 15 },

      // ── MASTER ALGORITHM (INSTITUTIONAL GRADE) ───────────────────────────
      masterMinScore: { type: Number, default: 70 },      // RAISED from 50 - much higher bar
      masterMinConfidence: { type: Number, default: 8 },  // RAISED from 5 - high confidence required
      masterMinAgreement: { type: Number, default: 10 },  // RAISED from 7 - more algorithms must agree
      minDirectionSpread: { type: Number, default: 5 },   // RAISED from 2 - clear directional bias
      ensembleMinVotes: { type: Number, default: 3 },     // RAISED from 2 - more consensus required

      // ── MARKET REGIME FILTERS (NEW) ──────────────────────────────────────
      minVolatility: { type: Number, default: 0.3 },      // NEW - minimum volatility for entry
      minMarketActivity: { type: Number, default: 0.2 },  // NEW - minimum activity level
      blockQuietMarket: { type: Boolean, default: true }, // NEW - block quiet markets
      blockRangingMarket: { type: Boolean, default: true }, // NEW - block ranging markets
      minRegimeConfidence: { type: Number, default: 6 },  // NEW - regime confidence threshold

      // ── CONFIRMATION REQUIREMENTS (NEW) ──────────────────────────────────
      minConfirmations: { type: Number, default: 8 },     // NEW - 8+ confirmations required
      minConfirmationScore: { type: Number, default: 10 }, // NEW - minimum confirmation score
      requireHTFAlignment: { type: Boolean, default: true }, // NEW - require higher timeframe alignment
      requireVWAPConfirmation: { type: Boolean, default: true }, // NEW - require VWAP confirmation
      requireFuturesConfirmation: { type: Boolean, default: true }, // NEW - require futures confirmation

      // ── FEATURE FLAGS ────────────────────────────────────────────────────
      enableTrailingSL: { type: Boolean, default: true },
      enableDynamicExit: { type: Boolean, default: true },
      enableAIRevalidation: { type: Boolean, default: true },
      enableBrokerageCalculation: { type: Boolean, default: false },
      enableFuturesConfirmation: { type: Boolean, default: true }, // ENABLED - futures are critical
      useMasterSignalWhenNeutral: { type: Boolean, default: false }, // DISABLED - wait for clear signals

      // ── HYBRID ENGINE (institutional deterministic core) ─────────────────
      // When true, entry/monitor decisions come from the deterministic hybrid
      // engine (no AI in the path). Defaults ON.
      useHybridEngine: { type: Boolean, default: true },
      // Minimum hybrid score (0-100) required to enter
      hybridMinScore: { type: Number, default: 65 },
      // Minimum trade quality grade required (A+/A/B/C/D)
      hybridMinGrade: { type: String, default: 'C' },
      // Minimum execution-quality score before placing the order
      executionMinScore: { type: Number, default: 50 },
      // Optional AI advisory side-channel (off by default — purely advisory)
      enableHybridAIAdvisory: { type: Boolean, default: false },
      // Consecutive-loss kill switch (used by hybrid risk engine)
      consecutiveLossStop: { type: Number, default: 3 },

      // ── PHASE 6 INSTITUTIONAL ENGINES (2026-05-18) ───────────────────────
      // Microstructure (bid/ask depth + absorption + iceberg + spoof)
      enableMicrostructureEngine: { type: Boolean, default: true },
      // Futures leadership (lead-lag + basis + aggressive futures candle)
      enableFuturesLeadershipEngine: { type: Boolean, default: true },
      // Delta velocity / acceleration / flip / exhaustion
      enableDeltaVelocityEngine: { type: Boolean, default: true },
      // Confidence-tier probe sizing (elite 1.0× / standard 0.6× / probe 0.35×)
      enableTierSizing: { type: Boolean, default: true },

      // ── TRADE WINDOW (IST HHMM) ──────────────────────────────────────────
      // Hybrid engine restricts NEW entries to this window. 920..1500 default.
      tradeWindowStart: { type: Number, default: 920 },
      tradeWindowEnd:   { type: Number, default: 1500 },

      // ── ULTRA SCALP ENGINE (UT Bot mirror, 5-20pt scalps) ────────────────
      // Mirrors the user's TradingView UT Bot Alerts indicator. Each TF has
      // its own keyValue/atrPeriod and target/SL profile. mongoose.Mixed so
      // partial overrides survive without explicit sub-schemas.
      ultraScalp: { type: mongoose.Schema.Types.Mixed, default: () => ({
        enable1m: true, enable3m: true, enable5m: true,
        vwapStrict: true, requireBarColor: true, allowStaleBar: false,
        tf1m: { keyValue: 1, atrPeriod: 5,  maxHoldSec:  90, slPtsMin: 4, slPtsMax: 8,  targetMin: 5,  targetMax: 12, sizingFactor: 0.5 },
        tf3m: { keyValue: 1, atrPeriod: 3,  maxHoldSec: 120, slPtsMin: 5, slPtsMax: 10, targetMin: 6,  targetMax: 15, sizingFactor: 0.6 },
        tf5m: { keyValue: 2, atrPeriod: 1,  maxHoldSec: 150, slPtsMin: 6, slPtsMax: 12, targetMin: 8,  targetMax: 20, sizingFactor: 0.7 },
      }) },
      // Hard kill switch
      disableUltraScalp: { type: Boolean, default: false },

      // ── ENGINE ROUTING (CALIBRATED 2026-05-21) ───────────────────────
      // Per user spec: ULTRA OFF, SUPPORT ON, CORE OFF.
      ultraScalpingEngine: { type: Boolean, default: false },
      supportScalpEngine:  { type: Boolean, default: true },
      coreEngine:          { type: Boolean, default: false },

      // ── SUPPORT SCALP ENGINE (CALIBRATED 2026-05-21 v2 — scoring) ────
      // Replaced strict 5-of-5 confluence with weighted scoring system.
      // Each factor contributes to a 0-100 score; threshold 60 to pass.
      supportScalp: { type: mongoose.Schema.Types.Mixed, default: () => ({
        primaryTf: '3m', confirmationTf: '15m',
        utBot: { keyValue: 1.5, atrPeriod: 10 },
        supertrend: { atrPeriod: 10, multiplier: 2.5 },
        ema:   { fastPeriod: 9, slowPeriod: 20, tolerancePct: 0.01 },
        rsi:   { period: 14, longMin: 52, shortMax: 48 },
        scoring: {
          minScore: 55, wUtBot: 30, wMtfTrend: 20,
          wSupertrend: 15, wMomentum: 15, wVwap: 10,
          wEmaAlign: 10, wRsi: 10, allowOppositeOf: 1,
        },
        maxHoldSec: 300, slPtsMin: 6, slPtsMax: 10,
        targetMin: 15, targetMax: 22, sizingFactor: 0.7,
      }) },

      // ── 15-Point Guarantee Validator (CALIBRATED 2026-05-22) ───────
      supportScalpValidator: { type: mongoose.Schema.Types.Mixed, default: () => ({
        minDeltaAbs: 0.30, minVolSpikeMul: 0.8,
        minIv: 10, maxIv: 90, maxSpreadPct: 2.0,
        maxThetaPct: 250, minAtrPts: 8,
        minTfsAligned: 2, requireMtfUtBot: true,
        skipLast1mCheck: false,
        effectiveDeltaMul: 0.85,
      }) },

      // ── Support Scalp EXIT Validator (CALIBRATED 2026-05-22) ───────
      // Mirrors the entry validator — re-checks the same microstructure
      // factors mid-trade. If 2+ of 6 flip, exit fast (zero-loss tolerance).
      supportScalpExit: { type: mongoose.Schema.Types.Mixed, default: () => ({
        minHoldSec: 30, maxHoldSec: 300,
        peakGiveBackPct: 0.50, minProfitToTrail: 10,
        minTfsAligned: 2, maxFailedFactors: 2,
        ivDropExitPct: 0.25,
        postLossCooldownSec: 300,
        quickFailSec: 60, quickFailMinPnlPts: 0.5,
      }) },

      // ── Premium Velocity Gate (NEW 2026-05-22) ─────────────────────
      premiumVelocityGate: { type: mongoose.Schema.Types.Mixed, default: () => ({
        enabled: true,
        checkAtSec: 30,
        minVelocityPtsPerSec: 0.05,
        minPnlAt30s: 0.5,
        maxNegativePts: -2.5,
        onlyEvaluateAtCheckSec: false,
      }) },

      // ── Session Regime Adapter (NEW 2026-05-22) ────────────────────
      sessionRegimeAdapter: { type: mongoose.Schema.Types.Mixed, default: () => ({
        enabled: true,
      }) },

      // ── Daily Kill Switch (NEW 2026-05-22) ─────────────────────────
      dailyKillSwitch: { type: mongoose.Schema.Types.Mixed, default: () => ({
        enabled: true,
        maxConsecutiveLosses: 3,
        maxDailyLossPct: 2.0,
      }) },

      // ── Futures Leadership Filter (NEW 2026-05-22) ─────────────────
      futuresLeadershipFilter: { type: mongoose.Schema.Types.Mixed, default: () => ({
        enabled: true,
        minScoreToBonus: 60,
        maxScoreToPenalty: 35,
        bonusPoints: 10,
        penaltyPoints: 8,
        countAsOpposite: true,
      }) },

      // ── TRADING SYMBOLS (NEW 2026-05-19) ─────────────────────────────
      // Each symbol routes the engine pipeline against that market.
      // Default NIFTY_50 only. SENSEX requires Sensex live feed wiring.
      tradingSymbols: { type: [String], default: ['NIFTY_50'] },

      // ── STRATEGY ─────────────────────────────────────────────────────────
      strategyMode: { type: String, default: 'Institutional Multi-Factor' }, // UPDATED name
      executionMode: { type: String, enum: ['simulation', 'live'], default: 'simulation' },

      // ── FILTERS (ALL ENABLED) ────────────────────────────────────────────
      filters: {
        vwap: { type: Boolean, default: true },
        oi: { type: Boolean, default: true },
        regime: { type: Boolean, default: true },
        liquiditySweep: { type: Boolean, default: true },
        volumeSpike: { type: Boolean, default: true },
        bankNifty: { type: Boolean, default: true },
        volatility: { type: Boolean, default: true },
        gamma: { type: Boolean, default: true },          // ENABLED - important for options
        maxPain: { type: Boolean, default: true },
        buildUp: { type: Boolean, default: true },
        htfAlignment: { type: Boolean, default: true },   // NEW - higher timeframe filter
        dataQuality: { type: Boolean, default: true },    // NEW - data quality check
        apiHealth: { type: Boolean, default: true },      // NEW - API health check
      },
    },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    initialCapital: { type: Number, required: true },
    currentCapital: { type: Number, required: true },
    realizedPnL: { type: Number, default: 0 },
    totalBrokerageCharges: { type: Number, default: 0 },  // cumulative brokerage across all trades
    totalTrades: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    cycleCount: { type: Number, default: 0 },
    lastCycleAt: { type: Date },
    lastError: { type: String },
    notes: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScalpingSession', ScalpingSessionSchema);
