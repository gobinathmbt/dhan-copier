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

// CALIBRATED Permission map (2026-05-18 institutional spec):
//   - gamma_pin       → ONLY mean-reversion / VWAP reclaim (block continuation)
//   - balanced_auction → ONLY mean-reversion (block momentum/breakout)
//   - slow_grind      → block all expansion entries (rotational scalps only)
//   - panic           → ONLY exhaustion fades (true reversal setups)
//
// The gamma_pin and balanced_auction rules alone remove the bulk of the
// 56% midday-chop trade leak observed in the 59-day backtest.
const FAMILY_POLICY = {
  balanced_auction:  { allowed: ['mean_reversion','vwap_reclaim'],                                  discouraged: ['reversal'],                                                          blocked: ['breakout_expansion','momentum_continuation','pullback'] },
  trend_auction:     { allowed: ['momentum_continuation','breakout_expansion','pullback'],          discouraged: ['mean_reversion'],                                                    blocked: [] },
  short_covering:    { allowed: ['momentum_continuation','breakout_expansion'],                     discouraged: ['reversal','mean_reversion'],                                         blocked: [] },
  long_liquidation:  { allowed: ['momentum_continuation','breakout_expansion'],                     discouraged: ['reversal','mean_reversion'],                                         blocked: [] },
  // Gamma-pin: dealers actively pin price. Continuation/breakout WILL fail.
  gamma_pin:         { allowed: ['mean_reversion','vwap_reclaim'],                                  discouraged: ['reversal'],                                                          blocked: ['breakout_expansion','momentum_continuation','pullback'] },
  expiry_expansion:  { allowed: ['momentum_continuation','breakout_expansion'],                     discouraged: ['mean_reversion'],                                                    blocked: [] },
  // Negative gamma forces dealer hedging INTO trends — momentum is fine,
  // but breakouts often fail at the next strike wall.
  dealer_hedging:    { allowed: ['momentum_continuation','pullback'],                               discouraged: ['mean_reversion','reversal'],                                         blocked: ['breakout_expansion'] },
  panic:             { allowed: ['exhaustion_fade','reversal'],                                     discouraged: [],                                                                    blocked: ['breakout_expansion','momentum_continuation','pullback','mean_reversion'] },
  slow_grind:        { allowed: ['mean_reversion','pullback','vwap_reclaim'],                       discouraged: ['reversal'],                                                          blocked: ['breakout_expansion','momentum_continuation'] },
  unknown:           { allowed: ['mean_reversion','vwap_reclaim'],                                  discouraged: ['momentum_continuation'],                                             blocked: ['breakout_expansion'] },
};

// CALIBRATED sizing (was sometimes 1.0 — institutionally we want lower lots
// almost always, except in clear trend/short-covering setups).
const STATE_DEFAULTS = {
  balanced_auction:  { sizingFactor: 0.6,  holdMultiplier: 0.8 },   // chop = small
  trend_auction:     { sizingFactor: 1.0,  holdMultiplier: 1.4 },   // ride longer
  short_covering:    { sizingFactor: 1.0,  holdMultiplier: 1.4 },
  long_liquidation:  { sizingFactor: 1.0,  holdMultiplier: 1.4 },
  gamma_pin:         { sizingFactor: 0.5,  holdMultiplier: 0.6 },   // tight + quick
  expiry_expansion:  { sizingFactor: 0.7,  holdMultiplier: 0.7 },
  dealer_hedging:    { sizingFactor: 0.85, holdMultiplier: 1.0 },
  panic:             { sizingFactor: 0.4,  holdMultiplier: 0.5 },
  slow_grind:        { sizingFactor: 0.5,  holdMultiplier: 1.0 },   // small, patient
  unknown:           { sizingFactor: 0.6,  holdMultiplier: 0.9 },
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
 *
 * Recognises both legacy `entryTypeEngine` types AND the new
 * `strategyPlaybookEngine` playbook names so meta-regime soft/hard
 * adjustments apply consistently throughout the pipeline.
 */
function familyOf(entryType) {
  if (!entryType) return null;
  // ── Legacy entry types ────────────────────────────────────────────────
  if (entryType === 'MOMENTUM_CONTINUATION') return 'momentum_continuation';
  if (entryType === 'BREAKOUT_EXPANSION')    return 'breakout_expansion';
  if (entryType === 'PULLBACK')              return 'pullback';
  if (entryType === 'REVERSAL')              return 'reversal';
  if (entryType === 'MEAN_REVERSION')        return 'mean_reversion';
  if (entryType === 'EXHAUSTION_FADE')       return 'exhaustion_fade';
  if (entryType === 'VWAP_RECLAIM')          return 'vwap_reclaim';
  if (entryType === 'OPENING_TRAP_REVERSAL') return 'reversal';
  if (entryType === 'GENERIC_SCALP')         return 'mean_reversion';
  // ── Playbook names ────────────────────────────────────────────────────
  if (entryType === 'INITIATIVE_MOMENTUM_EXPANSION') return 'momentum_continuation';
  if (entryType === 'FAILED_AUCTION_REVERSAL')       return 'reversal';
  if (entryType === 'GAMMA_PIN_MEAN_REVERSION')      return 'mean_reversion';
  if (entryType === 'OPENING_DRIVE_CONTINUATION')    return 'momentum_continuation';
  if (entryType === 'SHORT_COVERING_SQUEEZE')        return 'momentum_continuation';
  if (entryType === 'LONG_LIQUIDATION_CASCADE')      return 'momentum_continuation';
  if (entryType === 'VWAP_RECLAIM_CLEAN')            return 'vwap_reclaim';
  if (entryType === 'HVN_REJECTION_ROTATION')        return 'mean_reversion';
  if (entryType === 'EXHAUSTION_REVERSAL')           return 'exhaustion_fade';
  if (entryType === 'PULLBACK_CONTINUATION')         return 'pullback';
  if (entryType === 'WEEKLY_EXPIRY_DEALER_UNWIND')   return 'breakout_expansion';
  if (entryType === 'COMPOSITE_PROFILE_EDGE_REJECTION') return 'mean_reversion';
  if (entryType === 'VOLATILITY_COMPRESSION_SQUEEZE') return 'breakout_expansion';
  if (entryType === 'IV_CRUSH_FADE')                  return 'mean_reversion';
  if (entryType === 'VWAP_BOUNCE_SCALP')              return 'vwap_reclaim';
  if (entryType === 'TREND_VWAP_FOLLOW')              return 'pullback';
  if (entryType === 'COUNTER_TREND_REVERSAL')         return 'reversal';
  if (entryType === 'DELTA_DRIVE_SCALP')              return 'momentum_continuation';
  // Phase 1 rotational playbooks (cycle 28)
  if (entryType === 'VALUE_AREA_ROTATION')            return 'mean_reversion';
  if (entryType === 'PIN_REVERSION')                  return 'mean_reversion';
  if (entryType === 'SWEEP_RECLAIM_SCALP')            return 'reversal';
  if (entryType === 'LVN_REJECTION_SCALP')            return 'mean_reversion';
  if (entryType === 'VWAP_OSCILLATION_SCALP')         return 'mean_reversion';
  if (entryType === 'OPENING_DRIVE_FAILURE')          return 'reversal';
  if (entryType === 'MICRO_DELTA_FLIP')               return 'momentum_continuation';
  if (entryType === 'OI_MIGRATION_TREND')             return 'momentum_continuation';
  return null;
}

/**
 * Score adjustment for an entry-type given current meta-regime.
 * Returns a small bonus (+) or penalty (-) on the confidence score.
 *
 * Calibrated 2026-05-18:
 *   - Blocked family receives -25 penalty (was -12). Combined with the
 *     entry-engine hard-block in hybridEntryEngine, blocked families
 *     should never enter at all.
 *   - Discouraged family receives -8 (was -3) — still tradeable but harder
 *     to clear the threshold.
 *   - Allowed family bonus stays at +5.
 */
function familyScoreAdjustment(metaRegime, entryType) {
  if (!metaRegime || !entryType) return 0;
  const family = familyOf(entryType);
  if (!family) return 0;
  if (metaRegime.allowedFamilies?.includes(family))    return +5;
  if (metaRegime.discouragedFamilies?.includes(family)) return -8;
  if (metaRegime.blockedFamilies?.includes(family))    return -25;
  return 0;
}

/**
 * Hard-block check: returns true if the requested entry family is
 * categorically blocked under the current meta-regime. Caller (entry engine)
 * uses this to short-circuit the cycle.
 */
function isFamilyBlocked(metaRegime, entryType) {
  if (!metaRegime || !entryType) return false;
  const family = familyOf(entryType);
  if (!family) return false;
  return !!metaRegime.blockedFamilies?.includes(family);
}

module.exports = { classify, familyOf, familyScoreAdjustment, isFamilyBlocked, FAMILY_POLICY };
