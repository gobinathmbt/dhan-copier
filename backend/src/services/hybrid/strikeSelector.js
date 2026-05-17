/**
 * Strike Selector
 * ---------------
 * Picks the strike + option type for an institutional NIFTY entry.
 *
 * Inputs:
 *   - direction        : 'bullish' → CE, 'bearish' → PE
 *   - tradeType        : 'SCALP' | 'SWING'
 *   - atmStrike
 *   - primaryStrikes   : ATM ± 4 with greeks/OI/IV/LTP
 *   - maxPain          : optional
 *   - vix              : optional
 *
 * Rules:
 *   SCALP — prefer near-ATM with delta 0.40 .. 0.60 absolute
 *   SWING — prefer ITM with delta 0.55 .. 0.75 absolute
 *   - reject strikes within 25pts of max-pain
 *   - reject strikes with no LTP / zero OI
 *   - prefer strikes with healthy volume + spread (caller already pre-filtered)
 */

function _absDelta(strike, direction) {
  const greeks = direction === 'bullish' ? strike?.ce?.delta : Math.abs(strike?.pe?.delta || 0);
  const fallback = direction === 'bullish'
    ? strike?.call?.greeks?.delta
    : Math.abs(strike?.put?.greeks?.delta || 0);
  return Math.abs(Number(greeks ?? fallback) || 0);
}

function _ltp(strike, direction) {
  return Number(
    direction === 'bullish'
      ? (strike?.ce?.ltp ?? strike?.call?.ltp)
      : (strike?.pe?.ltp ?? strike?.put?.ltp)
  ) || 0;
}

function _oi(strike, direction) {
  return Number(
    direction === 'bullish'
      ? (strike?.ce?.oi ?? strike?.call?.oi)
      : (strike?.pe?.oi ?? strike?.put?.oi)
  ) || 0;
}

function _moneynessFromAtm(strikeVal, atmStrike, direction) {
  if (!Number.isFinite(strikeVal) || !Number.isFinite(atmStrike)) return 'unknown';
  if (strikeVal === atmStrike) return 'ATM';
  const diff = strikeVal - atmStrike;
  // For CE: ITM = below ATM, OTM = above ATM
  // For PE: ITM = above ATM, OTM = below ATM
  if (direction === 'bullish') return diff < 0 ? 'ITM' : 'OTM';
  return diff > 0 ? 'ITM' : 'OTM';
}

/**
 * @param {Object} opts
 * @param {string} opts.direction
 * @param {string} [opts.tradeType='SCALP']
 * @param {number} opts.atmStrike
 * @param {Array}  opts.primaryStrikes  - the focus chain (ATM ± up to 6)
 * @param {number} [opts.openingStrike] - day's opening reference strike (PRIMARY anchor)
 * @param {number} [opts.maxPain]
 * @param {number} [opts.minPremium=20]
 * @param {number} [opts.windowHalf=6]  - allowed distance (in strikes) from openingStrike
 * @param {number} [opts.ivPercentile]  - 0..100, rotates ITM vs OTM preference
 * @param {Object} [opts.expiryOverrides] - { preferITM, minDelta, ... }
 * @param {number} [opts.hhmm]          - current IST time, used for theta penalty
 *
 * Strategy:
 *   - Anchor on `openingStrike` when provided. Restrict candidates to
 *     openingStrike ± `windowHalf` × strikeStep (default 50).
 *   - Reject strikes outside that window even if they look attractive — that
 *     keeps execution within the day's institutional range.
 *   - Within the window, score by delta band, distance to ATM, max-pain
 *     proximity, premium, OI.
 *   - Theta penalty: same-day OTM after 14:00 IST gets a heavy minus.
 *   - High-IV regime (ivPercentile > 80) prefers ITM; low-IV (< 30) is
 *     fine with OTM.
 *   - Expiry overrides can force `preferITM` / `minDelta` (e.g. on Thursday
 *     after 14:00).
 */
function select({
  direction,
  tradeType = 'SCALP',
  atmStrike,
  primaryStrikes = [],
  openingStrike = null,
  maxPain = null,
  minPremium = 20,
  windowHalf = 6,
  ivPercentile = null,
  expiryOverrides = null,
  hhmm = null,
} = {}) {
  if (!primaryStrikes.length || !atmStrike) {
    return { ok: false, reason: 'no chain or atm', strike: null };
  }

  const strikeStep = 50;
  const anchor = Number.isFinite(openingStrike) ? openingStrike : atmStrike;
  const windowLow  = anchor - windowHalf * strikeStep;
  const windowHigh = anchor + windowHalf * strikeStep;

  // Delta band — calibrated wider per institutional review:
  //   SCALP: 0.30 - 0.60 (was 0.40 - 0.60)
  //   SWING: 0.45 - 0.75 (was 0.55 - 0.75)
  let targetMin = tradeType === 'SWING' ? 0.45 : 0.30;
  let targetMax = tradeType === 'SWING' ? 0.75 : 0.60;
  if (Number.isFinite(ivPercentile)) {
    if (ivPercentile > 80)      { targetMin = Math.max(targetMin, 0.50); targetMax = Math.max(targetMax, 0.78); }
    else if (ivPercentile < 30) { targetMin = Math.min(targetMin, 0.25); }
  }
  if (expiryOverrides?.minDelta) targetMin = Math.max(targetMin, expiryOverrides.minDelta);

  // Theta penalty — same-day OTM after 14:00 is brutal
  const lateAfternoon = Number.isFinite(hhmm) && hhmm >= 1400;

  const candidates = primaryStrikes
    .filter(s => s && Number.isFinite(s.strike) && s.strike >= windowLow && s.strike <= windowHigh)
    .map(s => {
      const ltp = _ltp(s, direction);
      const oi  = _oi(s, direction);
      const dlt = _absDelta(s, direction);
      const moneyness = s.moneyness || _moneynessFromAtm(s.strike, atmStrike, direction);
      const reasons = [];
      let score = 50;

      if (ltp < minPremium) { score = 0; reasons.push(`ltp ${ltp} < min ${minPremium}`); }
      if (oi < 1)           { score = Math.min(score, 10); reasons.push('oi 0'); }

      // Delta band
      if (dlt >= targetMin && dlt <= targetMax) {
        score += 25;
        reasons.push(`delta ${dlt.toFixed(2)} in band ${targetMin.toFixed(2)}-${targetMax.toFixed(2)}`);
      } else if (dlt > 0) {
        score -= 10;
        reasons.push(`delta ${dlt.toFixed(2)} out of band`);
      }

      // Distance to ATM (closer is better for scalp)
      const distFromAtm = Math.abs(s.strike - atmStrike);
      if (tradeType === 'SCALP') {
        if (distFromAtm <= 50) score += 15;
        else if (distFromAtm <= 100) score += 5;
        else score -= 5;
      } else {
        if (moneyness === 'ITM' && distFromAtm <= 100) score += 15;
        else if (moneyness === 'ATM') score += 5;
      }

      // Distance from opening strike (anchor)
      const distFromAnchor = Math.abs(s.strike - anchor);
      if (distFromAnchor <= strikeStep) score += 8;
      else if (distFromAnchor <= 2 * strikeStep) score += 3;
      else if (distFromAnchor >= 5 * strikeStep) score -= 8;

      // Max-pain avoidance
      if (Number.isFinite(maxPain) && Math.abs(s.strike - maxPain) < 25) {
        score -= 30;
        reasons.push(`within 25 of max-pain ${maxPain}`);
      }

      // Theta / IV / expiry preferences
      if (lateAfternoon && moneyness === 'OTM') {
        score -= 20;
        reasons.push('late-day OTM theta penalty');
      }
      if (ivPercentile != null && ivPercentile > 80 && moneyness === 'OTM') {
        score -= 15;
        reasons.push(`high-IV (${ivPercentile}%) — OTM penalised`);
      }
      if (expiryOverrides?.preferITM && moneyness !== 'ITM' && moneyness !== 'ATM') {
        score -= 25;
        reasons.push('expiry override prefers ITM');
      }

      return {
        strike: s.strike, ltp, oi, delta: dlt, moneyness, score,
        distFromAtm, distFromAnchor, reasons,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score <= 0) {
    return { ok: false, reason: 'no viable strike in window', strike: null, candidates,
             window: { low: windowLow, high: windowHigh, anchor } };
  }

  return {
    ok: true,
    strike: best.strike,
    optionType: direction === 'bullish' ? 'CE' : 'PE',
    moneyness: best.moneyness,
    delta: best.delta,
    ltp: best.ltp,
    oi: best.oi,
    score: best.score,
    distFromAnchor: best.distFromAnchor,
    distFromAtm: best.distFromAtm,
    window: { low: windowLow, high: windowHigh, anchor },
    deltaBand: { min: targetMin, max: targetMax },
    ivPercentile,
    reasoning: best.reasons.join(' | '),
    candidates: candidates.slice(0, 5),
  };
}

module.exports = { select };
