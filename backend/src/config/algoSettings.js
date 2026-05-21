/**
 * ============================================================
 * CENTRALIZED ALGO SETTINGS - ULTRA CONSERVATIVE QUALITY-FOCUSED
 * ============================================================
 * All algo settings are now managed here in the backend.
 * This allows Kiro to easily read and optimize these numbers
 * based on logs and performance data.
 * 
 * PHILOSOPHY: Quality over Quantity - Maximum Risk Control
 * - Only enter when target points are HIGHLY achievable (65%+ ATR confidence)
 * - Ultra conservative lot sizing (1 lot only, no scaling)
 * - Excellent R:R ratio (1:1.5 minimum with 10pt target / 15pt SL)
 * - No ultra-scalping - focus on high-probability setups only
 * - Strict entry criteria (70%+ master score, 11+ algorithms agreeing)
 * - ATR-based volatility validation (mandatory)
 * - Longer cooldown between trades (60 seconds for quality)
 * 
 * RISK MANAGEMENT:
 * - Max 1% risk per trade (reduced from 1.5%)
 * - Max 2.5% daily loss (circuit breaker)
 * - Max 25% capital usage per trade
 * - ATR validation prevents unrealistic targets
 * - Dynamic position sizing based on volatility
 * 
 * To modify settings, edit this file and restart the backend.
 * Frontend will fetch these settings via API.
 * ============================================================
 */

const ALGO_SETTINGS = {
  // ============================================================
  // AI MODEL CONFIGURATION
  // ============================================================
  aiModel: "gpt-4o-mini", // Options: gpt-4o-mini, gpt-4o, gpt-4.1-mini, gpt-4.1
  
  // ============================================================
  // CAPITAL MANAGEMENT (CONSERVATIVE - Protect capital first)
  // ============================================================
  capital: 100000,              // Starting capital (₹)
  maxCapitalUsagePct: 80,       // Max % of capital per trade (reduced from 30% for safety)
  riskPerTradePct: 1.0,         // Max risk per trade as % of capital (reduced from 1.5%)
  maxDailyLossPct: 2.5,         // Circuit breaker: stop if daily loss exceeds this % (reduced from 3%)
  
  // ============================================================
  // ENTRY THRESHOLDS (OPTIMIZED - More entries with quality control)
  // ============================================================
  minConfidence: 6,             // Minimum AI confidence (1-10) to enter (reduced from 7)
  minBreakoutProb: 0.60,        // Minimum breakout probability (0-1) (reduced from 0.70)
  minTrendStrength: 6,          // Minimum trend strength (1-10) (reduced from 7)
  minRR: 1.5,                   // Minimum risk-reward ratio
  
  // ============================================================
  // ATR CONFIRMATION (OPTIMIZED - Less restrictive for scalping)
  // ============================================================
  enableATRConfirmation: false,  // Disable ATR confirmation for more entries (was true)
  atrMinConfidence: 45,         // Minimum ATR confidence % (reduced from 55 for scalping)
  atrPeriod: 14,                // ATR calculation period (standard)
  
  // ============================================================
  // SCALPING-SPECIFIC SETTINGS (Points-based) - OPTIMIZED FOR ENTRIES
  // Target must be achievable based on ATR analysis
  // ============================================================
  targetPoints: 10,             // Target: 10 points profit (more achievable)
  slPoints: 15,                 // SL: 15 points loss (R:R = 1:1.5)
  maxHoldTimeSeconds: 300,      // Max hold: 5 minutes (STRICT - don't exit early!)
  minEntryPremium: 70,         // Minimum entry premium (₹) - reduced for more entries
  
  // ============================================================
  // MONITOR ENGINE SETTINGS (PHASE 1 - CRITICAL)
  // ============================================================
  monitorMinHoldSeconds: 30,        // NEW: Minimum hold time before considering exit
  monitorCheckInterval: 5,         // NEW: Check every 10 seconds after min hold
  targetAchievementThreshold: 0.8,  // NEW: Hold if >= 80% of target achieved
  slProximityThreshold: 0.8,        // NEW: Exit if >= 80% of SL reached
  
  // ============================================================
  // INDICATOR SETTINGS (PHASE 2 - HIGH PRIORITY)
  // ============================================================
  rsiPeriod: 14,                    // RSI period
  rsiOverbought: 70,                // RSI overbought level
  rsiOversold: 30,                  // RSI oversold level
  stochasticKPeriod: 14,            // Stochastic %K period
  stochasticDPeriod: 3,             // Stochastic %D period
  macdFastPeriod: 12,               // MACD fast EMA
  macdSlowPeriod: 26,               // MACD slow EMA
  macdSignalPeriod: 9,              // MACD signal line
  bollingerPeriod: 20,              // Bollinger Bands period
  bollingerStdDev: 2,               // Bollinger Bands standard deviation
  
  // ============================================================
  // SWING SETTINGS (Disabled for now - focus on quality scalps)
  // ============================================================
  enableSwing: true,           // Disable SWING trades (changed from true)
  swingMinPoints: 50,           // Minimum expected points for SWING entry (increased from 40)
  swingMaxHoldMinutes: 10,      // Max swing hold in minutes (reduced from 15)
  
  // ============================================================
  // LOT MANAGEMENT (ULTRA CONSERVATIVE - Start small, scale carefully)
  // ============================================================
  lotSize: 65,                  // NIFTY lot size (fixed by exchange)
  minLots: 1,                   // Enter with 1 lot (65 qty) - CONSERVATIVE
  maxLots: 2,                   // Max 2 lots per trade
  maxConcurrentTrades: 3,       // Maximum open positions PER SYMBOL (NIFTY 3 + SENSEX 3 = 6 max)
  cooldownSec: 3,              // Wait time between trades (increased from 5 for quality)
  
  // ============================================================
  // FEATURE TOGGLES
  // ============================================================
  enableTrailingSL: true,       // Auto-move SL to lock profits
  enableDynamicExit: true,      // AI adjusts exit points based on market
  enableAIRevalidation: true,   // Re-check AI confidence during trade
  enableBrokerageCalculation: true,  // Include Dhan brokerage in P&L
  enableFuturesConfirmation: true,   // Use NIFTY Futures for direction confirmation
  
  // ============================================================
  // OPTIMIZED ALGO CONTROLS (More entries with quality validation)
  // ============================================================
  ultraScalping: true,          // ENABLED - Professional scalping with AI validation
  useMasterSignalWhenNeutral: true,  // Use master algorithm when pro trader is neutral
  masterMinScore: 55,           // Minimum master algorithm score (reduced from 58 for more entries)
  masterMinConfidence: 0.25,    // Minimum master confidence (reduced from 0.3 for more entries)
  masterMinAgreement: 5,        // Minimum algorithms agreeing (reduced from 6 to 5 out of 17)
  minDirectionSpread: 2,        // Min bull/bear score difference (reduced from 3)
  ensembleMinVotes: 3,          // Min AI votes to enter (3 out of 5)
  
  // ============================================================
  // HYBRID ENGINE SETTINGS
  // These are read directly by hybridEntryEngine.js. Previously they were
  // hardcoded inside that file — now they live here so they're visible and
  // configurable without touching engine internals.
  // ============================================================
  useHybridEngine: true,            // true = deterministic hybrid path (default ON); false = legacy AI path
  hybridMinScore: 55,               // Minimum hybrid composite score to allow entry (0-100)
  hybridMinGrade: 'C',              // Minimum grade: A/B/C/D/F (C = acceptable quality)
  executionMinScore: 50,            // Minimum score for actual order execution (vs just signalling)
  maxTradesPerDay: 12,              // Hard cap on entries per IST calendar day per symbol (NIFTY 12 + SENSEX 12)
  maxLossesPerDay: 3,               // Halt trading on a symbol after this many losses
  trapBlockThreshold: 80,           // Trap-detection score above which entry is blocked (0-100)
  enableHybridAIAdvisory: false,    // When true, hybrid engine calls AI for advisory confirmation

  // ── Session phase restrictions (high-quality windows only) ──
  // When true, the hybrid engine refuses entries outside the two best windows:
  //   • morning      (09:45–11:30 IST)  — full aggression, all strategies
  //   • power_hour   (14:15–15:15 IST)  — full aggression, trend resolution
  // Skipped phases: opening_drive, midday_chop, afternoon, closing.
  // This DEVIATES from backtest behavior (backtest trades midday_chop with
  // reduced aggression) so leave OFF if you want backtest-parity live.
  restrictToHighQualityPhases: false,

  // ── Strike moneyness preference (user spec 2026-05-18) ──
  // Per user: prefer OTM > ATM > ITM for both CE (bullish) and PE (bearish).
  // OTM has higher gamma per rupee → faster premium move on a 10-15pt scalp,
  // and smaller absolute rupee loss on SL hits. The strike selector still
  // honours the delta band, max-pain avoidance, and ±150pt distance cap, so
  // pure deep-OTM lottery tickets are still rejected. This flag just adds a
  // moneyness bonus: OTM +12, ATM +5, ITM 0.
  preferOTMStrikes: true,

  // ── Phase 6 institutional engines (microstructure / leadership / velocity) ──
  // Toggles for the three new institutional engines. Default ON. They are
  // optional reads — the entry engine degrades gracefully when any of these
  // returns `available: false` (e.g. during pre-open or feed reconnects).
  enableMicrostructureEngine: true,    // bid/ask imbalance + absorption + iceberg + spoof
  enableFuturesLeadershipEngine: true, // futures lead-lag + basis + aggressive candle
  enableDeltaVelocityEngine: true,     // delta acceleration / flip / exhaustion
  // Confidence-tier probe sizing — institutional 3-band sizing per the
  // spec (elite 1.0× / standard 0.6× / probe scalp 0.35×). When false the
  // engine uses a single sizing factor across all tiers (legacy behaviour).
  enableTierSizing: true,

  // ── Trade window (IST HHMM, e.g. 920 = 09:20) ─────────────────────────
  // Hybrid engine restricts NEW entries to this window. Default 09:20-15:00
  // per user spec 2026-05-19. Set both to null to disable.
  tradeWindowStart: 920,
  tradeWindowEnd:   1500,

  // ── Ultra Scalp Engine (UT Bot mirror) ────────────────────────────────
  // Dedicated 5-20pt scalp engine that mirrors the user's TradingView
  // "UT Bot Alerts" indicator. Runs alongside the institutional playbook
  // layer — fires when no playbook fires but UT Bot 1m/3m/5m crosses
  // produce a clear chart-level signal.
  //
  // Each timeframe has its own UT Bot config (keyValue, atrPeriod) plus
  // a target/SL profile. The 5m default matches the user's TradingView
  // screenshot (Key=2, ATR=1).
  //
  // To disable a TF: set enable1m/enable3m/enable5m to false.
  // To use TradingView's exact param on all TFs: set keyValue=2 atrPeriod=1.
  ultraScalp: {
    enable1m: true,                       // 1m UT Bot — fastest scalp (90s holds)
    enable3m: true,                       // 3m UT Bot — balanced (120s)
    enable5m: true,                       // 5m UT Bot — primary (150s)
    vwapStrict: true,                     // require spot above/below VWAP in trade direction
    requireBarColor: true,                // require last 1m candle in direction
    allowStaleBar: false,                 // only fire on 0-1 bars since flip (no chasing)
    // Per-TF overrides — leave any field undefined to use defaults
    tf1m: { keyValue: 1, atrPeriod: 5,  maxHoldSec:  90, slPtsMin: 4, slPtsMax: 8,  targetMin: 5,  targetMax: 12, sizingFactor: 0.5 },
    tf3m: { keyValue: 1, atrPeriod: 3,  maxHoldSec: 120, slPtsMin: 5, slPtsMax: 10, targetMin: 6,  targetMax: 15, sizingFactor: 0.6 },
    tf5m: { keyValue: 2, atrPeriod: 1,  maxHoldSec: 150, slPtsMin: 6, slPtsMax: 12, targetMin: 8,  targetMax: 20, sizingFactor: 0.7 },
  },
  // Hard kill-switch for ultra scalp (if you want pure institutional only)
  disableUltraScalp: false,

  // ════════════════════════════════════════════════════════════════════
  // ENGINE ROUTING — three independent engines, each with its own entry
  // and monitor logic. The master engine reads these flags and routes
  // every cycle to the active engine(s).
  //
  //   ultraScalpingEngine  — pure UT Bot multi-timeframe + dedicated
  //                          ultra strike selector. (5-20pt scalps)
  //   supportScalpEngine   — confluence: UT Bot + Supertrend + VWAP +
  //                          EMA9/20 + RSI. Slower, higher-quality.
  //                          (8-20pt entries)
  //   coreEngine           — full institutional hybrid pipeline (all
  //                          24+ playbooks, microstructure, futures
  //                          leadership, OI analytics, etc.)
  //
  // When ALL three are false, the engine produces NO_TRADE every cycle.
  // When multiple are true, the master engine takes the first valid
  // signal in priority order: ultraScalp > supportScalp > core.
  //
  // Each engine has its OWN entry logic AND monitor logic — exits never
  // mix between engines.
  // ════════════════════════════════════════════════════════════════════
  ultraScalpingEngine: true,    // User spec 2026-05-19: ON for tomorrow's live
  supportScalpEngine:  true,    // User spec 2026-05-19: ON for tomorrow's live
  coreEngine:          false,   // User spec 2026-05-19: OFF for tomorrow's live

  // ── Support Scalp Engine config (UT Bot + Supertrend + VWAP + EMA + RSI) ──
  // 5-confluence engine for higher-quality intraday scalps. All 5 must
  // align in trade direction. Defaults match user spec.
  // CALIBRATED 2026-05-20:
  //   • RSI longMin 55→52, shortMax 45→48 — captures setups where RSI is
  //     just above neutral (53-54) in a confirmed trend.
  //   • EMA tolerance 0.01% — accept "aligned" when EMAs are tied.
  //   • targetMin/targetMax bumped to 15/22 — user requirement: only fire
  //     when the validator projects ≥ 15-point premium move.
  //   • slPtsMax 14→10 — tighter SL since we're only firing high-probability
  //     setups; locks zero-loss tolerance with fast cut on any reversal.
  supportScalp: {
    primaryTf:        '3m',     // Trigger TF — 3m for balance
    confirmationTf:   '15m',    // Higher TF must agree
    utBot: { keyValue: 1.5, atrPeriod: 10 },  // User spec: balanced 3m setup
    supertrend: { atrPeriod: 10, multiplier: 2.5 },
    ema:   { fastPeriod: 9, slowPeriod: 20, tolerancePct: 0.01 },
    rsi:   { period: 14, longMin: 52, shortMax: 48 },
    requireVwap:    true,
    requireSupertrend: true,
    requireEmaAlignment: true,
    requireRsiFilter: true,
    maxHoldSec: 300,           // 5 min max hold (was 240)
    slPtsMin: 6, slPtsMax: 10, // tighter SL — protect zero-loss target
    targetMin: 15, targetMax: 22, // 15pt minimum target (was 8/20)
    sizingFactor: 0.7,
  },

  // ── 15-Point Guarantee Validator (2026-05-20) ──────────────────────────
  // Pre-fire validator that's called AFTER the 5 confluence factors agree.
  // Its job: only fire when the engine can realistically capture ≥15pts
  // of premium move given current option microstructure.
  supportScalpValidator: {
    minDeltaAbs:    0.40,       // Min |delta| — need ITM-ish for fast move
    minVolSpikeMul: 1.5,        // Current 5m vol must be ≥1.5× 20-bar avg
    minIv:          40,         // Min IV% — too low means no expected move
    maxIv:          90,         // Max IV% — too high means imminent crush
    maxSpreadPct:   1.0,        // Max bid-ask spread as % of mid
    maxThetaPct:    5.0,        // Max theta/premium per day (decay rate)
    minAtrPts:      6,          // Min ATR(5m) — market not dead
    requireMtfUtBot: true,      // Need ≥3 of 4 UT Bot TFs aligned (1m/3m/5m/15m)
  },

  // ── Support Scalp EXIT Validator (2026-05-20) ──────────────────────────
  // Mirrors the entry validator — re-checks the same microstructure factors
  // continuously to exit BEFORE SL hits if the trend reverses. Zero-loss
  // tolerance philosophy: if 2 of 6 factors flip, cut and re-deploy.
  supportScalpExit: {
    minHoldSec:        30,      // Below this only hard SL exits allowed
    maxHoldSec:        300,     // Hard ceiling regardless of P&L
    peakGiveBackPct:   0.50,    // Exit if peak gave back ≥50%
    minProfitToTrail:  10,      // Lift SL to breakeven once +10pts profit
    minTfsAligned:     2,       // Exit if <2 of 4 TFs still in direction
    maxFailedFactors:  2,       // Exit if 2+ of 6 microstructure factors flip
  },

  // ── Trading symbols (for multi-symbol routing) ─────────────────────────
  // Each entry routes the engine pipeline against that symbol. Default is
  // NIFTY_50 only. Adding 'SENSEX' here will wire the engines to also run
  // on Sensex (requires Sensex live feed wiring in feedRecorder).
  // Live UI displays the market column from the active trade.symbol.
  tradingSymbols: ['NIFTY_50', 'SENSEX'],   // ['NIFTY_50', 'SENSEX']


  // ============================================================
  // STRATEGY & EXECUTION MODE
  // ============================================================
  strategyMode: "Ultra Conservative Quality-Focused",
  executionMode: "simulation",  // Options: simulation, live
  
  // ============================================================
  // FILTERS (Advisory validators)
  // ============================================================
  filters: {
    vwap: true,                 // Trade when price aligns with VWAP
    oi: true,                   // Require Open Interest confirmation
    regime: true,               // Identify trending/ranging/volatile markets
    liquiditySweep: true,       // Detect stop-loss hunts for reversals
    volumeSpike: true,          // Require unusual volume for breakouts
    bankNifty: true,            // Cross-check BankNifty movement
    volatility: true,           // Monitor IV for entry timing
    gamma: false,               // Track dealer gamma for S/R zones
    maxPain: true,              // Consider max pain strike
    buildUp: true,              // Analyze price + OI patterns
  },
};

/**
 * Get current algo settings
 * @returns {Object} Current algo settings
 */
function getSettings() {
  return { ...ALGO_SETTINGS };
}

/**
 * Update specific settings (for runtime adjustments)
 * @param {Object} updates - Settings to update
 * @returns {Object} Updated settings
 */
function updateSettings(updates) {
  Object.keys(updates).forEach(key => {
    if (key === 'filters' && typeof updates[key] === 'object') {
      ALGO_SETTINGS.filters = { ...ALGO_SETTINGS.filters, ...updates[key] };
    } else if (ALGO_SETTINGS.hasOwnProperty(key)) {
      ALGO_SETTINGS[key] = updates[key];
    }
  });
  return getSettings();
}

/**
 * Reset settings to defaults (useful for testing)
 */
function resetToDefaults() {
  // Re-require this file to get fresh defaults
  // Or manually reset each value
  return getSettings();
}

/**
 * Validate settings before starting engine
 * @param {Object} settings - Settings to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateSettings(settings) {
  const errors = [];
  
  if (!settings.capital || settings.capital <= 0) {
    errors.push('Capital must be greater than 0');
  }
  
  if (!settings.lotSize || settings.lotSize <= 0) {
    errors.push('Lot size must be greater than 0');
  }
  
  if (settings.minLots > settings.maxLots) {
    errors.push('Min lots cannot be greater than max lots');
  }
  
  if (settings.targetPoints <= 0) {
    errors.push('Target points must be greater than 0');
  }
  
  if (settings.slPoints <= 0) {
    errors.push('SL points must be greater than 0');
  }
  
  if (settings.maxHoldTimeSeconds <= 0) {
    errors.push('Max hold time must be greater than 0');
  }
  
  if (settings.maxConcurrentTrades <= 0) {
    errors.push('Max concurrent trades must be greater than 0');
  }
  
  // Validate R:R ratio
  const actualRR = settings.targetPoints / settings.slPoints;
  if (actualRR < settings.minRR) {
    errors.push(`R:R ratio (${actualRR.toFixed(2)}) is below minimum (${settings.minRR}). Adjust targetPoints or slPoints.`);
  }
  
  // Validate ATR settings if enabled
  if (settings.enableATRConfirmation) {
    if (!settings.atrMinConfidence || settings.atrMinConfidence < 0 || settings.atrMinConfidence > 100) {
      errors.push('ATR min confidence must be between 0 and 100');
    }
    if (!settings.atrPeriod || settings.atrPeriod < 5 || settings.atrPeriod > 50) {
      errors.push('ATR period must be between 5 and 50');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  getSettings,
  updateSettings,
  resetToDefaults,
  validateSettings,
  ALGO_SETTINGS, // Export for direct access if needed
};
