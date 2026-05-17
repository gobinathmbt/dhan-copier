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

// Calibrated thresholds (from backtest log analysis):
//   - Score in 55-74 band was NOT predictive (wins ≈ losses)
//   - Score 75+ showed clear edge (6:2 winners)
//   - Therefore raise floors so we trade only where score predicts
const PROFILES = {
  conservative:  { minScore: 72, sizingFactor: 0.6,  requireUtBot: false, requireFullMtf: false, confirmationFraction: 1.00 },
  balanced:      { minScore: 65, sizingFactor: 0.85, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.70 },
  aggressive:    { minScore: 58, sizingFactor: 1.0,  requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.55 },
};

function _institutional(ctx) {
  const reasons = [];
  // Capital first — defensive overrides everything
  if (ctx.risk?.capitalMode === 'survival')   return { ...PROFILES.conservative, mode: 'institutional[survival]', reasoning: 'capital survival' };
  if (ctx.risk?.capitalMode === 'defensive')  return { ...PROFILES.conservative, mode: 'institutional[defensive]', reasoning: 'capital defensive' };

  // Regime-driven (calibrated thresholds per spec):
  //   trend day  → 54  (allow more entries — institutions take momentum)
  //   range day  → 60  (be selective — chop kills win rate)
  //   expiry     → 57  (faster scalps but still selective)
  const regime = ctx.marketRegime?.regime;
  const vol    = ctx.volatilityRegime?.state;
  const expiry = ctx.sessionPhase?.isExpiryDay;

  if ((regime === 'trending_bullish' || regime === 'trending_bearish') && vol !== 'dead' && vol !== 'panic') {
    reasons.push(`${regime}+${vol} → trend-mode 60`);
    return { minScore: 60, sizingFactor: 1.0, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.55,
             mode: 'institutional[trend]', reasoning: reasons.join(' | ') };
  }
  if (expiry) {
    reasons.push(`expiry → 62`);
    return { minScore: 62, sizingFactor: 0.8, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.6,
             mode: 'institutional[expiry]', reasoning: reasons.join(' | ') };
  }
  if (regime === 'ranging' || regime === 'reversal_risk' || regime === 'choppy') {
    reasons.push(`${regime} → range-mode 65`);
    return { minScore: 65, sizingFactor: 0.7, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.65,
             mode: 'institutional[range]', reasoning: reasons.join(' | ') };
  }
  if (vol === 'dead') {
    reasons.push(`dead vol → mean-revert mode 65 small size`);
    return { minScore: 65, sizingFactor: 0.5, requireUtBot: false, requireFullMtf: false, confirmationFraction: 0.65,
             mode: 'institutional[dead_vol]', reasoning: reasons.join(' | ') };
  }
  if (vol === 'panic') {
    reasons.push('panic vol → conservative');
    return { ...PROFILES.conservative, mode: 'institutional[panic]', reasoning: reasons.join(' | ') };
  }
  return { ...PROFILES.balanced, mode: 'institutional[balanced]', reasoning: `${regime}/${vol}` };
}

/**
 * @param {Object} args
 * @param {string} [args.requestedMode] - settings.aggressionMode override
 * @param {Object} args.marketRegime
 * @param {Object} args.volatilityRegime
 * @param {Object} args.risk
 */
function evaluate({ requestedMode, marketRegime, volatilityRegime, risk, sessionPhase } = {}) {
  if (requestedMode && PROFILES[requestedMode]) {
    return { ...PROFILES[requestedMode], mode: requestedMode, reasoning: `forced=${requestedMode}` };
  }
  if (requestedMode === 'institutional' || !requestedMode) {
    return _institutional({ marketRegime, volatilityRegime, risk, sessionPhase });
  }
  return { ...PROFILES.balanced, mode: 'balanced', reasoning: 'default balanced' };
}

module.exports = { evaluate, PROFILES };
