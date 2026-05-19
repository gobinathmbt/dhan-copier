/**
 * Support Scalp Strike Selector
 * =============================
 * Strike picker for SUPPORT_SCALP_CONFLUENCE entries. Targets are 8-20pt
 * which means we want enough delta but not deep ITM theta drag.
 *
 * Tuned slightly tighter than ultra scalp:
 *   delta band 0.40-0.55
 *   premium cap ₹220 (CE) / ₹160 (PE)
 *   ATM/OTM preferred over ITM
 *   bid-ask spread ≤ 2pts is healthy for these holds
 */

const STRIKE_STEP = 50;

function _absDelta(strike, direction) {
  const greeks = direction === 'bullish'
    ? (strike?.ce?.delta ?? strike?.call?.greeks?.delta)
    : Math.abs(strike?.pe?.delta ?? strike?.put?.greeks?.delta ?? 0);
  return Math.abs(Number(greeks) || 0);
}
function _ltp(strike, direction) {
  return Number(direction === 'bullish'
    ? (strike?.ce?.ltp ?? strike?.call?.ltp)
    : (strike?.pe?.ltp ?? strike?.put?.ltp)) || 0;
}
function _oi(strike, direction) {
  return Number(direction === 'bullish'
    ? (strike?.ce?.oi ?? strike?.call?.oi)
    : (strike?.pe?.oi ?? strike?.put?.oi)) || 0;
}
function _bidAsk(strike, direction) {
  const c = direction === 'bullish' ? (strike?.ce || strike?.call) : (strike?.pe || strike?.put);
  return { bid: Number(c?.bid) || 0, ask: Number(c?.ask) || 0 };
}
function _moneyness(strikeVal, atm, direction) {
  if (strikeVal === atm) return 'ATM';
  const diff = strikeVal - atm;
  if (direction === 'bullish') return diff < 0 ? 'ITM' : 'OTM';
  return diff > 0 ? 'ITM' : 'OTM';
}

function select({
  direction,
  atmStrike,
  primaryStrikes = [],
  openingStrike = null,
  maxPain = null,
  windowHalf = 5,
  hhmm = null,
  expiryOverrides = null,
} = {}) {
  if (!primaryStrikes.length || !atmStrike) {
    return { ok: false, reason: 'no chain or atm', strike: null };
  }
  const anchor = Number.isFinite(openingStrike) ? openingStrike : atmStrike;
  const windowLow  = anchor - windowHalf * STRIKE_STEP;
  const windowHigh = anchor + windowHalf * STRIKE_STEP;
  const lateAfternoon = Number.isFinite(hhmm) && hhmm >= 1400;
  const isPe = direction !== 'bullish';

  const cfg = {
    deltaMin: 0.40, deltaMax: 0.55, deltaHardMax: 0.62,
    minPremium: 25,
    maxPremium: isPe ? 160 : 220,
    distMaxFromAtm: 100,
  };

  const candidates = primaryStrikes
    .filter(s => s && Number.isFinite(s.strike))
    .filter(s => s.strike >= windowLow && s.strike <= windowHigh)
    .filter(s => Math.abs(s.strike - atmStrike) <= cfg.distMaxFromAtm)
    .map(s => {
      const ltp = _ltp(s, direction);
      const oi  = _oi(s, direction);
      const dlt = _absDelta(s, direction);
      const moneyness = s.moneyness || _moneyness(s.strike, atmStrike, direction);
      const { bid, ask } = _bidAsk(s, direction);
      const reasons = [];
      let score = 50;

      if (ltp < cfg.minPremium) { score = 0; reasons.push(`ltp ${ltp} < min ${cfg.minPremium}`); }
      if (ltp > cfg.maxPremium) { score = Math.min(score, 5); reasons.push(`ltp ${ltp} > max ${cfg.maxPremium}`); }
      if (oi < 1000) { score = Math.min(score, 10); reasons.push('oi too low'); }

      if (dlt > cfg.deltaHardMax) {
        score = Math.min(score, 5);
        reasons.push(`delta ${dlt.toFixed(2)} > hard max ${cfg.deltaHardMax}`);
      }
      if (dlt >= cfg.deltaMin && dlt <= cfg.deltaMax) {
        score += 28; reasons.push(`delta ${dlt.toFixed(2)} in band`);
      } else if (dlt > 0) {
        score -= 10; reasons.push(`delta ${dlt.toFixed(2)} out of band`);
      }

      const distFromAtm = Math.abs(s.strike - atmStrike);
      if (distFromAtm === 0) score += 12;
      else if (distFromAtm <= 50) score += 9;
      else if (distFromAtm <= 100) score += 3;
      else score -= 8;

      const distFromAnchor = Math.abs(s.strike - anchor);
      if (distFromAnchor <= STRIKE_STEP) score += 6;
      else if (distFromAnchor <= 2 * STRIKE_STEP) score += 2;
      else if (distFromAnchor >= 4 * STRIKE_STEP) score -= 6;

      // Bid-ask spread
      if (bid > 0 && ask > 0) {
        const spreadAbs = ask - bid;
        if (spreadAbs <= 1) score += 6;
        else if (spreadAbs <= 2) score += 2;
        else if (spreadAbs <= 4) score -= 4;
        else score -= 10;
      }

      if (Number.isFinite(maxPain) && Math.abs(s.strike - maxPain) < 25) {
        score -= 12; reasons.push(`near max-pain ${maxPain}`);
      }
      if (lateAfternoon && moneyness === 'OTM') {
        score -= 16; reasons.push('late-day OTM theta penalty');
      }
      if (expiryOverrides?.preferITM && moneyness === 'OTM') {
        score -= 22; reasons.push('expiry prefers ITM');
      }
      // Moneyness preference: ATM > OTM > ITM for support scalp
      if (moneyness === 'ATM') score += 10;
      else if (moneyness === 'OTM') score += 6;
      else score -= 4;

      return { strike: s.strike, ltp, oi, delta: dlt, moneyness, score, distFromAtm, distFromAnchor, bid, ask, reasons };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score <= 0) {
    return { ok: false, reason: 'no viable support-scalp strike', strike: null,
             candidates: candidates.slice(0, 5),
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
    bid: best.bid, ask: best.ask,
    window: { low: windowLow, high: windowHigh, anchor },
    deltaBand: { min: cfg.deltaMin, max: cfg.deltaMax },
    reasoning: best.reasons.join(' | '),
    candidates: candidates.slice(0, 5),
  };
}

module.exports = { select };
