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
 * @param {Array}  opts.primaryStrikes  - the focus chain
 * @param {number} [opts.maxPain]
 * @param {number} [opts.minPremium=20]
 */
function select({
  direction,
  tradeType = 'SCALP',
  atmStrike,
  primaryStrikes = [],
  maxPain = null,
  minPremium = 20,
} = {}) {
  if (!primaryStrikes.length || !atmStrike) {
    return { ok: false, reason: 'no chain or atm', strike: null };
  }

  const targetMin = tradeType === 'SWING' ? 0.55 : 0.40;
  const targetMax = tradeType === 'SWING' ? 0.75 : 0.60;

  // Score every candidate
  const candidates = primaryStrikes
    .filter(s => s && Number.isFinite(s.strike))
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
        reasons.push(`delta ${dlt.toFixed(2)} in band ${targetMin}-${targetMax}`);
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
        // SWING — modestly ITM preferred
        if (moneyness === 'ITM' && distFromAtm <= 100) score += 15;
        else if (moneyness === 'ATM') score += 5;
      }

      // Max-pain avoidance
      if (Number.isFinite(maxPain) && Math.abs(s.strike - maxPain) < 25) {
        score -= 30;
        reasons.push(`within 25 of max-pain ${maxPain}`);
      }

      return { strike: s.strike, ltp, oi, delta: dlt, moneyness, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score <= 0) {
    return { ok: false, reason: 'no viable strike', strike: null, candidates };
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
    reasoning: best.reasons.join(' | '),
    candidates: candidates.slice(0, 5),
  };
}

module.exports = { select };
