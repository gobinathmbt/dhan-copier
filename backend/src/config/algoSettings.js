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
  maxLots: 2,                   // Max 1 lot only (reduced from 2 for strict risk control)
  maxConcurrentTrades: 2,       // Maximum open positions at same time (kept at 1)
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
  maxTradesPerDay: 8,               // Hard cap on entries per IST calendar day
  maxLossesPerDay: 2,               // Halt trading after this many losses in a day
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
