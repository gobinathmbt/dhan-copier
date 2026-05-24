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
  //
  // CALIBRATED 2026-05-21: Per user spec, ULTRA OFF / SUPPORT ON / CORE OFF.
  // Focus exclusively on the support scalp confluence engine which has
  // been redesigned with a SCORING system instead of strict 5-of-5 pass.
  // ════════════════════════════════════════════════════════════════════
  ultraScalpingEngine: false,   // CALIBRATED 2026-05-21: turned OFF per user spec
  supportScalpEngine:  true,    // PRIMARY engine
  coreEngine:          false,   // OFF

  // ── Support Scalp Engine config (UT Bot + Supertrend + VWAP + EMA + RSI) ──
  // CALIBRATED 2026-05-21 v2 — switched from binary 5-of-5 to SCORING system.
  //
  // Why: today's logs (2026-05-21) showed 478 cycles, 0 entries. Top blockers:
  //   • 218× Supertrend opposite (Supertrend flips LATE — its job is to be
  //     a slow trailing stop, not a fast trigger)
  //   • 175× RSI threshold (mid-range RSI rejected even with strong trend)
  //   • 121× EMA not aligned (lagging on fast moves)
  //   • 105× VWAP opposite
  //
  // The fix: each factor now contributes to a 0-100 score. Factors that
  // are "slow by design" (Supertrend, EMA) only contribute small weights
  // and have soft penalties when opposite. The UT Bot trigger + multi-TF
  // trend + momentum are the strong drivers. minScore: 60 (passes ~55-65%
  // of UT Bot triggers vs. ~0% before).
  //
  //   wUtBot: 30      (mandatory trigger)
  //   wMtfTrend: 20   (5m + 15m supertrend confirmation, half weight each)
  //   wSupertrend: 15 (primary TF supertrend)
  //   wMomentum: 15   (recent 3-bar momentum on primary TF)
  //   wVwap: 10
  //   wEmaAlign: 10
  //   wRsi: 10
  //   = max ~110, threshold 60.
  supportScalp: {
    primaryTf:        '3m',
    confirmationTf:   '15m',
    utBot: { keyValue: 1.5, atrPeriod: 10 },
    supertrend: { atrPeriod: 10, multiplier: 2.5 },
    ema:   { fastPeriod: 9, slowPeriod: 20, tolerancePct: 0.01 },
    rsi:   { period: 14, longMin: 52, shortMax: 48 },
    // Scoring system (CALIBRATED 2026-05-22)
    //
    // 2026-05-21 set threshold = 70 to filter low-quality fires after
    // observing scoring=60 leaked too many losers. Today's logs (300+
    // cycles, 0 trades) showed the OPPOSITE problem: a bimodal score
    // distribution clustered at 30-49 (clear noise) and 50-59 (clean
    // 4-of-5 factor agreement that Supertrend's slow flip pushed below
    // 60). Threshold 70 caught NEITHER cohort.
    //
    // Calibration: lower to 55. The Supertrend opposite-count change
    // (see supportScalpEngine.js — slow flip no longer increments
    // oppositeCount) plus this lower bar lets the genuinely-clean
    // 50-59 setups fire while the 30-49 noise stays blocked.
    //
    //   55 → fires 4-of-5 factor setups even with Supertrend lagging
    //   60 → would have caught only 1 of today's NIFTY setups
    //   70 → caught 0 of today's NIFTY setups (300 cycles, 0 fires)
    scoring: {
      minScore:        55,    // 70→55 (slow-flip Supertrend no longer blocks)
      wUtBot:          30,    // mandatory entry trigger
      wMtfTrend:       20,    // 5m+15m supertrend confirmation
      wSupertrend:     15,    // primary TF supertrend
      wMomentum:       15,    // recent 3-bar primary momentum
      wVwap:           10,
      wEmaAlign:       10,
      wRsi:            10,
      allowOppositeOf: 1,     // max 1 strongly-opposite factor
    },
    maxHoldSec: 300,
    slPtsMin: 6, slPtsMax: 10,
    targetMin: 15, targetMax: 22,
    sizingFactor: 0.7,
  },

  // ── 15-Point Guarantee Validator (CALIBRATED 2026-05-22) ───────────────
  // Indian-index + expiry-aware thresholds.
  //
  // 2026-05-22: Tightened after observed bleed pattern in chop:
  //   • minAtrPts:     4 → 8     (rejects sub-8pt ATR; can't make 15pt premium)
  //   • minVolSpikeMul: 0.5 → 0.8 (require real participation surge, not chop)
  //   • effectiveDeltaMul: 0.85   (NEW — premium captures only 85% of
  //                                delta×spotMove in low-IV regimes — was
  //                                projecting 19pts but capturing 4pts)
  //   • requirePositivePnlByMs: 60_000 (NEW — entries that haven't moved
  //                                 in our favor by 60s are usually wrong)
  supportScalpValidator: {
    minDeltaAbs:          0.30,    // 0.40→0.30 (allow slightly OTM)
    minVolSpikeMul:       0.8,     // 0.5→0.8 (require real participation)
    minIv:                10,      // 40→10 (Indian indices trade 13-20%)
    maxIv:                90,
    maxSpreadPct:         2.0,     // 1.0→2.0 (fast-moving options)
    maxThetaPct:          250,     // 5→250 (expiry-day theta is 100-200%/day)
    minAtrPts:            8,       // 4→8 (need real volatility for 15pt scalp)
    minTfsAligned:        2,       // 3→2 (slow TFs lag fast breakouts)
    requireMtfUtBot:      true,
    skipLast1mCheck:      false,
    effectiveDeltaMul:    0.85,    // damp expected premium move (low-IV reality)
  },

  // ── Support Scalp EXIT Validator (CALIBRATED 2026-05-22) ──────────────
  // Mirrors the entry validator — re-checks the same microstructure factors
  // continuously to exit BEFORE SL hits if the trend reverses.
  //
  // 2026-05-22 changes (after 7-trade bleed pattern observed):
  //   • IV check now uses entryIv baseline + 25% drop, not absolute floor
  //     (was firing on every trade because Indian IV is 13-18%, well below
  //      the old "< 25%" absolute floor).
  //   • Added postLossCooldownSec: skip new entries on the SAME strike
  //     for 5 min after a losing exit (was re-firing identical setup
  //     every cycle, racking up 5+ losses on the same thesis).
  //   • Added quickFailSec/quickFailPnlPts: if the trade hasn't moved in
  //     our favor by 60s, the setup is wrong — exit immediately rather
  //     than waiting for time_decay at 180s.
  supportScalpExit: {
    minHoldSec:           30,      // Below this only hard SL exits allowed
    maxHoldSec:           300,     // Hard ceiling regardless of P&L
    peakGiveBackPct:      0.50,    // Exit if peak gave back ≥50%
    minProfitToTrail:     10,      // Lift SL to breakeven once +10pts profit
    minTfsAligned:        2,       // Exit if <2 of 4 TFs still in direction
    maxFailedFactors:     2,       // Exit if 2+ of 6 microstructure factors flip
    ivDropExitPct:        0.25,    // 25% relative drop from entry IV → exit
    // Post-loss cooldown — block new entries on the same strike for this
    // many seconds after a loss. Prevents "re-fire same losing thesis"
    // pattern. Honored by entry engine via state.lastLossByStrike map.
    postLossCooldownSec:  300,
    // Quick-fail: if trade hasn't reached this P&L within this time, exit
    // — the directional thesis is wrong, don't ride it to time_decay loss.
    quickFailSec:         60,
    quickFailMinPnlPts:   0.5,
  },

  // ── Premium Velocity Gate (NEW 2026-05-22) ────────────────────────────
  // After a fresh entry, measure premium acceleration in real-time.
  // If by checkAtSec the trade hasn't built minPnlAt30s and isn't moving
  // at minVelocityPtsPerSec in our favour, the setup is dead — exit
  // before time-decay erodes more.
  // Also caps absolute drawdown via maxNegativePts (-2.5pts default).
  // Opt-in via enabled flag.
  premiumVelocityGate: {
    enabled:                  true,
    checkAtSec:               30,
    minVelocityPtsPerSec:     0.05,    // 0.05 pt/s sustained = 15pt in 5min
    minPnlAt30s:              0.5,     // need at least 0.5pt by 30s
    maxNegativePts:           -2.5,    // hard floor below entry
    onlyEvaluateAtCheckSec:   false,   // keep evaluating after checkSec
  },

  // ── Session Regime Adapter (NEW 2026-05-22) ───────────────────────────
  // Time-of-day-conditioned thresholds for support scalp. Different IST
  // session windows behave differently — opening volatility, trend
  // continuation, midday chop, afternoon reversal, close chaos. Default
  // table disables entries during 11:30-13:30 IST (chop) and 14:30-15:30
  // IST (close chaos). Override via regimeTable if needed.
  sessionRegimeAdapter: {
    enabled: true,
    // regimeTable: <use defaults from sessionRegimeAdapter.js>
  },

  // ── Daily Kill Switch (NEW 2026-05-22) ────────────────────────────────
  // Operational-safety gate. After N consecutive losses or net daily loss
  // exceeding maxDailyLossPct of starting capital, blocks new entries for
  // the rest of the day. Resets on session start.
  dailyKillSwitch: {
    enabled:                true,
    maxConsecutiveLosses:   3,
    maxDailyLossPct:        2.0,    // 2% of starting capital
  },

  // ── Futures Leadership Filter (NEW 2026-05-22) ────────────────────────
  // Wires the existing hybrid/futuresLeadershipEngine into the support
  // scalp scoring path. Adds a positive bonus when futures lead spot in
  // our direction; soft penalty when futures oppose. Lead-lag, basis
  // expansion/contraction, and aggressive futures candles all feed in.
  futuresLeadershipFilter: {
    enabled:           true,
    minScoreToBonus:   60,    // futures score ≥ 60 → bonus
    maxScoreToPenalty: 35,    // futures score ≤ 35 → penalty
    bonusPoints:       10,
    penaltyPoints:     8,
    countAsOpposite:   true,  // penalty also bumps oppositeCount
  },

  // ============================================================
  // PREMIUM SWING ENGINE (NEW 2026-05-22)
  // ============================================================
  // Opening-range breakout strategy distinct from the support scalper.
  // Captures primary-strike (ATM-at-9:15) CE+PE H/L over the first 5
  // minutes, then arms one of three play archetypes:
  //   • bullish_reversal — PE range above CE range, BUY CE on CE-high break
  //   • bearish_reversal — CE range above PE range, BUY PE on PE-high break
  //   • sideways         — overlapping ranges, fade extremes
  //
  // Targets are STRUCTURAL (T1/T2 = opposite leg's range levels).
  // Hold 5min-4hr with 14:30 IST hard cutoff. Distinct strike selector
  // (premiumSwingStrikeSelector — wider delta band, ITM allowed) and
  // exit validator (premiumSwingExitValidator — partial book at T1,
  // peak giveback after T1, adverse range break, velocity stall).
  premiumSwingEngine: false,    // OFF by default — opt in to test on Monday
  premiumSwing: {
    targetMin:                 25,        // pts (T1 minimum)
    targetMax:                 70,        // pts (T2 maximum cap)
    maxHoldSec:                4 * 60 * 60, // 4 hours
    maxTradesPerDay:           4,
    sizingFactor:              0.7,
    // 2026-05-22 calibration after 41-day historical replay:
    //   • bullish_reversal: 67% win rate, +46pts net → KEEP
    //   • bearish_reversal: 46% win rate, −128pts net → DISABLED until
    //     futures-confirmation gate is added
    //   • sideways:        26% win rate, −116pts net → DISABLED
    //     (theta grind beats fade-buy strategy on flat days)
    allowReversalRegimes:      true,      // bullish only by default below
    allowBullishReversal:      true,
    allowBearishReversal:      false,     // disabled until calibration improves
    allowSidewaysRegime:       false,     // disabled — theta bleeds in flat tape
    sidewaysFadeBuffer:        1.0,       // pts within range low to fade-buy
    // OI cascade settings — for re-arming after a primary trade SLs
    enableCascade:             true,
    cascadeMaxLegs:            2,         // up to 2 cascade re-entries per direction
    // 2026-05-23 — multi-layer confirmation gate
    requireConfirmation:       true,
    minConfirmationTier:       'STANDARD', // STANDARD = score≥50; ELITE = ≥65
  },
  premiumSwingExit: {
    minHoldSec:                5 * 60,    // 5 min before non-SL exits allowed
    maxHoldSec:                4 * 60 * 60,
    peakGiveBackPct:           0.60,      // exit remainder if 60% of peak gone post-T1
    partialBookPct:            0.50,      // book 50% at T1
    stallMinutes:              3,         // stall window
    stallMoveAbs:              1.0,       // pts — premium must move > this in stall window
    adverseBreakBuffer:        1.5,       // pts above OPPOSITE-leg range high → regime broken
    // 2026-05-23 — confirmation collapse exit. Re-runs the same 9-layer
    // confirmation continuously during the trade. If score drops below
    // this threshold, exit (only if not yet partial-booked).
    exitOnScoreBelow:          25,
  },

  // ── Premium Swing Confirmation (NEW 2026-05-23) ────────────────────────
  // Multi-layer institutional confirmation engine. Used both as a fire
  // gate and as a continuous monitor during the trade. Tier mapping
  // (calibrated against historical replay — observed score range is
  // roughly -30 to +35 due to fewer base points than scalp engine):
  //   ≥25 ELITE     full size
  //   ≥15 STANDARD  60% size
  //   ≥5  PROBE     35% size, only after 10:30 IST
  //   <5  NO_TRADE  skip
  premiumSwingConfirmation: {
    eliteScore:    25,
    standardScore: 15,
    probeScore:    5,
    // Per-factor weights (default 1.0 each). Reduce / zero out a factor
    // here without code changes if it proves noisy in production.
    weights: {
      premiumExpansion:  1.0,   // most important — institutional tell
      futuresLeadership: 1.0,
      vwapSustain:       1.0,
      mtfStructure:      1.0,
      volatilityRegime:  1.0,
      oiFlow:            1.0,
      trapRisk:          1.0,
      gammaRegime:       1.0,
      crossMarket:       1.0,   // requires explicit cross-market candles
    },
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
