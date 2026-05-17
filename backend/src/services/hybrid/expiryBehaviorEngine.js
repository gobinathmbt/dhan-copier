/**
 * Expiry Behavior Engine
 * ======================
 * Thursday/expiry-day-specific adjustments. Normal scalping rules don't
 * always apply on expiry — premium decay is violent, gamma squeezes are
 * common, and max-pain pinning is real.
 *
 * Behaviors detected:
 *   - gamma_squeeze     : negative gamma + initiative → trend explodes
 *   - dealer_pinning    : positive gamma + price near max-pain → mean revert
 *   - premium_collapse  : far OTM → high theta drag (avoid near close)
 *   - violent_short_cover : OI collapsing on calls + price up
 *
 * Output is a set of overrides applied to the strategy / sizing / target.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : null; }

const EXPIRY_HOURS = {
  // approximate close: 15:30 IST
  start: 1400,    // 14:00 — expiry-special window
  hardCutoff: 1500,  // 15:00 — refuse new entries on expiry
};

/**
 * @param {Object} args
 * @param {Object} args.sessionPhase  - includes isExpiryDay, isExpiryWindow, hhmm
 * @param {number} args.spotPrice
 * @param {number} args.atmStrike
 * @param {Object} args.gammaRegime
 * @param {Object} args.oiAnalytics
 * @param {Object} [args.volatilityRegime]
 * @returns {Object}
 */
function evaluate({ sessionPhase, spotPrice, atmStrike, gammaRegime, oiAnalytics, volatilityRegime } = {}) {
  if (!sessionPhase?.isExpiryDay) {
    return { active: false, behavior: 'normal', overrides: {}, reasoning: 'not expiry day' };
  }

  const hhmm = sessionPhase.hhmm;
  const reasons = [`expiry day ${sessionPhase.weekday}`];
  const overrides = {};

  // Hard cutoff after 15:00 — no new entries
  if (hhmm >= EXPIRY_HOURS.hardCutoff) {
    return {
      active: true, behavior: 'expiry_close',
      overrides: { allowEntries: false },
      reasoning: 'past 15:00 expiry cutoff',
    };
  }

  // Premium collapse zone — after 14:00 OTM premiums are deep in theta
  if (hhmm >= EXPIRY_HOURS.start) {
    overrides.preferITM = true;
    overrides.minDelta = 0.55;            // force ATM/ITM
    overrides.maxHoldSec = 120;           // tight time horizon
    reasons.push('post-14:00 — prefer ITM, tight hold');
  }

  // Gamma squeeze — negative gamma + price away from pin
  if (gammaRegime?.regime === 'negative' && Math.abs(_safe(gammaRegime.spotVsPin) || 0) > 30) {
    overrides.boostMomentumScore = 8;
    reasons.push(`gamma squeeze (netGEX ${gammaRegime.netGex})`);
  }

  // Dealer pinning — positive gamma + price near pinning level
  if (gammaRegime?.regime === 'positive' && gammaRegime.pinningLevel
      && Math.abs(spotPrice - gammaRegime.pinningLevel) < 25) {
    overrides.preferMeanReversion = true;
    overrides.maxHoldSec = 90;
    reasons.push(`dealer pinning at ${gammaRegime.pinningLevel}`);
  }

  // Violent short covering (CE OI cut while spot rising)
  if (oiAnalytics?.regime === 'violent_short_covering') {
    overrides.boostBullishScore = 10;
    reasons.push('violent short covering — bullish acceleration');
  }
  if (oiAnalytics?.regime === 'long_unwinding_collapse') {
    overrides.boostBearishScore = 10;
    reasons.push('long unwinding collapse — bearish acceleration');
  }

  return {
    active: true,
    behavior: Object.keys(overrides).length ? 'expiry_special' : 'normal',
    overrides,
    reasoning: reasons.join(' | '),
  };
}

module.exports = { evaluate };
