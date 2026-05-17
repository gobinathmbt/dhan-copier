/**
 * Meta-Regime Engine
 * ==================
 * The "brain" that fuses every sub-state into one institutional behavioural
 * label. Every other engine still computes its own classification — this
 * engine just READS them and outputs the ONE answer:
 *
 *   - balanced_auction
 *   - trend_auction
 *   - short_covering
 *   - long_liquidation
 *   - gamma_pin
 *   - expiry_expansion
 *   - dealer_hedging
 *   - panic
 *   - slow_grind
 *   - unknown
 *
 * The output drives:
 *   - which entry families are allowed (continuation / reversal / mean-revert / expansion)
 *   - per-family confidence offset (score nudge, NOT a hard gate)
 *   - sizing factor
 *   - max-hold extension or compression
 *
 * This is purely a CLASSIFIER — no scoring penalties live here.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : null; }

// ── Permission map: which entry families this meta-regime allows ─────────
// Allowed = preferred entry types (will get score bonus / preserved threshold).
// Discouraged = still allowed but no bonus.
// Blocked = entry type rejected unless absolutely overwhelming evidence.
const FAMILY_POLICY = {
  balanced_auction:  { allowed: ['mean_reversion','vwap_reclaim','reversal'],          discouraged: ['breakout_expansion'],     blocked: [] },
  trend_auction:     { allowed: ['momentum_continuation','breakout_expansion','pullback'], discouraged: ['mean_reversion'],         blocked: [] },
  short_covering:    { allowed: ['momentum_continuation','breakout_expansion'],         discouraged: ['reversal'],               blocked: ['mean_reversion'] },
  long_liquidation:  { allowed: ['momentum_continuation','breakout_expansion'],         discouraged: ['reversal'],               blocked: ['mean_reversion'] },
  gamma_pin:         { allowed: ['mean_reversion','vwap_reclaim'],                       discouraged: ['breakout_expansion'],     blocked: ['momentum_continuation'] },
  expiry_expansion:  { allowed: ['momentum_continuation','breakout_expansion'],         discouraged: [],                         blocked: [] },
  dealer_hedging:    { allowed: ['mean_reversion','vwap_reclaim','reversal'],            discouraged: ['breakout_expansion'],     blocked: [] },
  panic:             { allowed: ['exhaustion_fade'],                                     discouraged: [],                         blocked: ['breakout_expansion','momentum_continuation'] },
  slow_grind:        { allowed: ['pullback','vwap_reclaim'],                             discouraged: ['breakout_expansion'],     blocked: [] },
  unknown:           { allowed: ['momentum_continuation','mean_reversion','vwap_reclaim'], discouraged: [], blocked: [] },
};

const STATE_DEFAULTS = {
  balanced_auction:  { sizingFactor: 0.85, holdMultiplier: 0.9 },
  trend_auction:     { sizingFactor: 1.0,  holdMultiplier: 1.2 },
  short_covering:    { sizingFactor: 1.0,  holdMultiplier: 1.3 },
  long_liquidation:  { sizingFactor: 1.0,  holdMultiplier: 1.3 },
  gamma_pin:         { sizingFactor: 0.7,  holdMultiplier: 0.7 },
  expiry_expansion:  { sizingFactor: 0.85, holdMultiplier: 0.7 },
  dealer_hedging:    { sizingFactor: 0.8,  holdMultiplier: 0.9 },
  panic:             { sizingFactor: 0.5,  holdMultiplier: 0.5 },
  slow_grind:        { sizingFactor: 0.7,  holdMultiplier: 1.0 },
  unknown:           { sizingFactor: 0.85, holdMultiplier: 1.0 },
};

/**
 * @param {Object} args
 * @param {Object} args.marketRegime
 * @param {Object} args.volatilityRegime
 * @param {Object} args.auctionState
 * @param {Object} args.gammaRegime
 * @param {Object} args.oiAnalytics
 * @param {Object} args.trendPhase
 * @param {Object} args.sessionPhase
 * @returns {Object}
 */
function classify({
  marketRegime, volatilityRegime, auctionState, gammaRegime, oiAnalytics, trendPhase, sessionPhase,
} = {}) {
  const reasons = [];
  let state = 'unknown';

  // Hard precedence — panic / expiry first
  if (volatilityRegime?.state === 'panic') {
    state = 'panic';
    reasons.push('volatility panic');
  }
  else if (sessionPhase?.isExpiryDay && sessionPhase.hhmm >= 1300 && volatilityRegime?.state !== 'dead') {
    state = 'expiry_expansion';
    reasons.push('expiry post-1300 + active volatility');
  }
  // Gamma pin — positive gamma + price near pinning level
  else if (gammaRegime?.regime === 'positive' && Math.abs(_safe(gammaRegime.spotVsPin) || 999) < 30) {
    state = 'gamma_pin';
    reasons.push(`positive gamma + ${gammaRegime.spotVsPin}pts from pin`);
  }
  // OI regimes drive identifiable institutional flows
  else if (oiAnalytics?.regime === 'violent_short_covering') {
    state = 'short_covering';
    reasons.push('OI regime short-covering');
  }
  else if (oiAnalytics?.regime === 'long_unwinding_collapse') {
    state = 'long_liquidation';
    reasons.push('OI regime long-unwinding');
  }
  // Auction-driven classification
  else if (auctionState?.dayType === 'trend_up' || auctionState?.dayType === 'trend_down') {
    state = 'trend_auction';
    reasons.push(`auction ${auctionState.dayType}`);
  }
  else if (auctionState?.dayType === 'short_covering') {
    state = 'short_covering';
    reasons.push('auction short_covering');
  }
  else if (auctionState?.dayType === 'long_liquidation') {
    state = 'long_liquidation';
    reasons.push('auction long_liquidation');
  }
  // Negative gamma but no other signal → dealers must hedge into trend
  else if (gammaRegime?.regime === 'negative') {
    state = 'dealer_hedging';
    reasons.push('negative gamma → dealer hedging');
  }
  // Trending market regime + healthy volatility
  else if ((marketRegime?.regime === 'trending_bullish' || marketRegime?.regime === 'trending_bearish')
           && (volatilityRegime?.state === 'normal' || volatilityRegime?.state === 'expansion')) {
    state = 'trend_auction';
    reasons.push(`${marketRegime.regime} + ${volatilityRegime.state}`);
  }
  // Slow grind — low volatility but not dead
  else if (volatilityRegime?.state === 'dead' || volatilityRegime?.atrPercentile < 25) {
    state = 'slow_grind';
    reasons.push(`low volatility (atrPct ${volatilityRegime?.atrPercentile})`);
  }
  // Default to balanced
  else {
    state = 'balanced_auction';
    reasons.push('default balanced');
  }

  const policy = FAMILY_POLICY[state] || FAMILY_POLICY.unknown;
  const defaults = STATE_DEFAULTS[state] || STATE_DEFAULTS.unknown;

  return {
    state,
    allowedFamilies:    policy.allowed,
    discouragedFamilies: policy.discouraged,
    blockedFamilies:    policy.blocked,
    sizingFactor:       defaults.sizingFactor,
    holdMultiplier:     defaults.holdMultiplier,
    reasoning:          reasons.join(' | '),
  };
}

/**
 * Maps an entry-type string back to its family.
 */
function familyOf(entryType) {
  if (!entryType) return null;
  if (entryType === 'MOMENTUM_CONTINUATION') return 'momentum_continuation';
  if (entryType === 'BREAKOUT_EXPANSION')    return 'breakout_expansion';
  if (entryType === 'PULLBACK')              return 'pullback';
  if (entryType === 'REVERSAL')              return 'reversal';
  if (entryType === 'MEAN_REVERSION')        return 'mean_reversion';
  if (entryType === 'EXHAUSTION_FADE')       return 'exhaustion_fade';
  if (entryType === 'VWAP_RECLAIM')          return 'vwap_reclaim';
  if (entryType === 'OPENING_TRAP_REVERSAL') return 'reversal';
  if (entryType === 'GENERIC_SCALP')         return 'mean_reversion';   // treat as conservative
  return null;
}

/**
 * Score adjustment for an entry-type given current meta-regime.
 * Returns a small bonus (+) or penalty (-) on the confidence score.
 */
function familyScoreAdjustment(metaRegime, entryType) {
  if (!metaRegime || !entryType) return 0;
  const family = familyOf(entryType);
  if (!family) return 0;
  if (metaRegime.allowedFamilies?.includes(family))    return +5;
  if (metaRegime.discouragedFamilies?.includes(family)) return -3;
  if (metaRegime.blockedFamilies?.includes(family))    return -12;
  return 0;
}

module.exports = { classify, familyOf, familyScoreAdjustment, FAMILY_POLICY };
