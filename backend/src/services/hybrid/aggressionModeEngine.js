/**
 * Aggression Mode Engine
 * ======================
 * Picks the right aggression profile for the current market state.
 *
 * Modes:
 *   conservative   — every confirmation required, minScore 75, sizing 0.6×
 *   balanced       — 70% confirmation, minScore 65, sizing 0.85×          (default)
 *   aggressive     — earlier entries, minScore 55, sizing 1.0×
 *   institutional  — dynamic per regime
 *
 * The "institutional" mode flips internally based on:
 *   - volatility regime (expansion → aggressive; dead → conservative)
 *   - market regime (trending → aggressive; choppy → conservative)
 *   - capital state (defensive/survival → conservative)
 *
 * Outputs:
 *   {
 *     mode, minScore, sizingFactor, requireUtBot, requireFullMtf,
 *     confirmationFraction, reasoning
 *   }
 */

// CALIBRATION (2026-05-18, derived from 59-day backtest, 413 trades, 53.5% WR):
//   - Score 60-69 band held 318/413 (77%) trades but win rate barely above coinflip
//   - Score 70+ band showed dramatically better edge (small sample, but high signal)
//   - Days with 15+ trades all lost money (-₹41,459 net, 43% WR)
//   - Days with 3-9 trades made the bulk of profit (+₹157k, 60% WR)
//   - "aggressive" mode (minScore 58) is the prime source of low-edge trades — REMOVED
//
// New target: 80% win rate, 5-8 elite trades/day. Strategy now demands:
//   - score ≥ 72 (raised from 60-65)
//   - UT Bot is confirmation only, never required
//   - midday/dead-vol drastically penalised
const PROFILES = {
  conservative:  { minScore: 78, sizingFactor: 0.6,  requireUtBot: false, requireFullMtf: false, confirmationFraction: 1.00 },
  institutional: { minScore: 72, sizingFactor: 0.85, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.70 },
  // legacy aliases — kept for back-compat. They now ALL map to institutional
  // floor or higher. There is no "aggressive retail" profile any more.
  balanced:      { minScore: 72, sizingFactor: 0.85, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.70 },
  aggressive:    { minScore: 72, sizingFactor: 0.85, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.70 },
};

function _institutional(ctx) {
  const reasons = [];
  // Capital first — defensive overrides everything
  if (ctx.risk?.capitalMode === 'survival')   return { ...PROFILES.conservative, mode: 'institutional[survival]', reasoning: 'capital survival' };
  if (ctx.risk?.capitalMode === 'defensive')  return { ...PROFILES.conservative, mode: 'institutional[defensive]', reasoning: 'capital defensive' };

  // CALIBRATED Regime-driven thresholds (institutional spec):
  //   - Momentum / trend       → 78 (raised from 60)
  //   - Mean reversion / range → 72 (raised from 65)
  //   - Breakout expansion     → 82 (rare but high-quality)
  //   - Dead vol               → 78 (much pickier)
  //   - Expiry                 → 76 (volatile, demand more confirmation)
  //   - Panic                  → conservative (78)
  // Floors are STRATEGY-AGNOSTIC. The strategy selector will additionally
  // apply its own minScore (taking the max of the two).
  const regime = ctx.marketRegime?.regime;
  const vol    = ctx.volatilityRegime?.state;
  const phase  = ctx.sessionPhase?.phase;
  const expiry = ctx.sessionPhase?.isExpiryDay;

  // Midday chop is the biggest leak (231/413 trades, low WR). Tighten hard.
  if (phase === 'midday_chop') {
    reasons.push('midday_chop → 80 (suppression)');
    return { minScore: 80, sizingFactor: 0.5, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.75,
             mode: 'institutional[midday_chop]', reasoning: reasons.join(' | ') };
  }

  if ((regime === 'trending_bullish' || regime === 'trending_bearish') && (vol === 'expansion' || vol === 'normal')) {
    reasons.push(`${regime}+${vol} → trend-mode 80`);
    return { minScore: 80, sizingFactor: 1.0, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.65,
             mode: 'institutional[trend]', reasoning: reasons.join(' | ') };
  }
  if (expiry) {
    reasons.push('expiry → 76');
    return { minScore: 76, sizingFactor: 0.7, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.7,
             mode: 'institutional[expiry]', reasoning: reasons.join(' | ') };
  }
  if (regime === 'ranging' || regime === 'reversal_risk' || regime === 'choppy') {
    reasons.push(`${regime} → range-mode 74`);
    return { minScore: 74, sizingFactor: 0.7, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.7,
             mode: 'institutional[range]', reasoning: reasons.join(' | ') };
  }
  if (vol === 'dead') {
    reasons.push('dead vol → 78 small size (most chop, hardest to win)');
    return { minScore: 78, sizingFactor: 0.5, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.75,
             mode: 'institutional[dead_vol]', reasoning: reasons.join(' | ') };
  }
  if (vol === 'panic') {
    reasons.push('panic vol → conservative');
    return { ...PROFILES.conservative, mode: 'institutional[panic]', reasoning: reasons.join(' | ') };
  }
  return { ...PROFILES.institutional, mode: 'institutional[default]', reasoning: `${regime}/${vol}` };
}

/**
 * @param {Object} args
 * @param {string} [args.requestedMode] - settings.aggressionMode override
 * @param {Object} args.marketRegime
 * @param {Object} args.volatilityRegime
 * @param {Object} args.risk
 */
function evaluate({ requestedMode, marketRegime, volatilityRegime, risk, sessionPhase } = {}) {
  // Note: legacy 'aggressive' / 'balanced' values are quietly upgraded to
  // institutional minScore. There is no retail-aggressive path any more.
  if (requestedMode === 'conservative') {
    return { ...PROFILES.conservative, mode: 'conservative', reasoning: 'forced=conservative' };
  }
  // Default & all other values → institutional dynamic mode
  return _institutional({ marketRegime, volatilityRegime, risk, sessionPhase });
}

module.exports = { evaluate, PROFILES };
