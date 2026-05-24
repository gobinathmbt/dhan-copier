const mongoose = require('mongoose');

const ScalpingTradeSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ScalpingSession', index: true, required: true },
    signal: { type: String, enum: ['BUY_CE', 'BUY_PE'], required: true },
    strike: { type: Number, required: true },
    optionSymbol: { type: String },
    expiry: { type: Number },
    lotSize: { type: Number, required: true },
    quantity: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    currentPrice: { type: Number, default: 0 },
    exitPrice: { type: Number },
    sl: { type: Number },
    target: { type: Number },
    aiConfidence: { type: Number },
    entryReason: { type: String },
    exitReason: { type: String },
    marketRegime: { type: String },
    buildUpType: { type: String },
    vwapState: { type: String },
    oiDirection: { type: String },
    spotPriceAtEntry: { type: Number },
    spotPriceAtExit: { type: Number },
    // Strike selection fields
    strikeSelectionRationale: { type: String },
    strikeSelectionConfidence: { type: Number },
    alternativeStrike: { type: Number },
    expectedHoldDuration: { type: String },
    // Trade type: SCALP (fast, small target) or SWING (hold longer, bigger target)
    tradeType: { type: String, enum: ['SCALP', 'SWING'], default: 'SCALP' },
    // ── ENGINE & MARKET (NEW 2026-05-19) ──
    // engineType: which engine produced this trade — surfaced in UI table.
    // 'ULTRA_SCALP'   — UT Bot multi-timeframe (ultraScalpEngine)
    // 'SUPPORT_SCALP' — UT+Supertrend+VWAP+EMA+RSI confluence
    // 'PREMIUM_SWING' — Opening-range CE/PE breakout (premiumSwingEngine)
    // 'CORE'          — full institutional hybrid pipeline
    engineType: { type: String, enum: ['ULTRA_SCALP', 'SUPPORT_SCALP', 'PREMIUM_SWING', 'CORE'], default: 'CORE', index: true },
    // market: which symbol this trade was placed on (NIFTY_50 / SENSEX / etc.)
    market:     { type: String, default: 'NIFTY_50', index: true },
    // ── Premium Swing structural targets (NEW 2026-05-22) ─────────────
    // For PREMIUM_SWING trades we carry a ladder of structural premium
    // levels (T1 = first target, T2 = second target). The standard
    // `target` field stores T1 (so existing UI continues to work);
    // these mirror that with the full ladder for the exit validator.
    swingTarget1: { type: Number },
    swingTarget2: { type: Number },
    // Per-trade AI overrides (set at entry by entryEngine)
    maxHoldSeconds: { type: Number, default: 180 },
    aiEntryDecision: { type: mongoose.Schema.Types.Mixed },
    // ── Entry IV baseline (NEW 2026-05-22) ────────────────────────────
    // The exit validator compares current IV to this entry baseline to
    // decide if IV has *meaningfully crashed* (≥ 25% relative drop).
    // Without it the validator falls back to an absolute floor that
    // doesn't suit Indian indices (which trade 13-18% IV all day).
    entryIv:        { type: Number },
    entrySpotAtm:   { type: Number },
    // Hybrid engine snapshot — captured at entry, used by hybrid monitor for decay analysis
    hybridEntrySnapshot: { type: mongoose.Schema.Types.Mixed },
    hasReachedTarget: { type: Boolean, default: false },
    maxPriceReached: { type: Number, default: 0 },
    // NIFTY Futures confirmation fields
    futuresConfirmed: { type: Boolean, default: false },
    futuresDirection: { type: String },
    futuresPremium: { type: Number },
    // Live feed connection fields
    optionSecurityId: { type: Number }, // Dhan security ID for direct WebSocket access
    liveFeedConnected: { type: Boolean, default: false },
    lastPriceUpdate: { type: Date },
    priceUpdateSource: { type: String }, // 'live_feed', 'option_chain', 'atm_fallback'
    // Brokerage calculation fields
    brokerageEnabled: { type: Boolean, default: false },
    grossPnL: { type: Number },
    brokerageCharges: { type: Number },
    brokerageBreakdown: {
      brokerage: { type: Number },
      stt: { type: Number },
      exchangeCharges: { type: Number },
      gst: { type: Number },
      sebiCharges: { type: Number },
      stampDuty: { type: Number },
    },
    status: {
      type: String,
      enum: ['open', 'closed', 'rejected'],
      default: 'open',
      index: true,
    },
    result: { type: String, enum: ['WIN', 'LOSS', 'BREAKEVEN', null], default: null },
    pnl: { type: Number, default: 0 }, // Net P&L (after brokerage if enabled)
    pnlPct: { type: Number, default: 0 },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
    monitorTicks: { type: Number, default: 0 },
    aiSnapshots: [
      {
        at: Date,
        confidence: Number,
        action: String,
        rationale: String,
      },
    ],
    // Adaptive exit state — tracks partial bookings + breakeven progression
    // (used by adaptiveExitEngine to avoid re-firing the +1R partial on
    // subsequent cycles, and to know when to lock breakeven).
    partialBooked: { type: Boolean, default: false },
    partialBookedAt: { type: Date },
    partialBookedPrice: { type: Number },
    partialBookedPct: { type: Number },                       // e.g. 0.4 for 40%
    breakevenSet: { type: Boolean, default: false },
    breakevenSetAt: { type: Date },
    rRunnerHigh: { type: Number, default: 0 },                // best R-multiple seen (trail diagnostics)
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScalpingTrade', ScalpingTradeSchema);
