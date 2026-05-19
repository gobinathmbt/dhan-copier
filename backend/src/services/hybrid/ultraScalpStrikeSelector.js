/**
 * Ultra Scalp Strike Selector
 * ===========================
 * Dedicated strike picker for ULTRA_SCALP_UT_BOT entries. Optimised for
 * 5-20 point premium scalps, runner mode payoffs, and tight downside.
 *
 * Why a dedicated selector?
 *   The institutional strikeSelector is multipurpose (SCALP, SWING, expiry
 *   overrides, max-pain, IV percentile, opening-strike anchor, theta penalty,
 *   broker preference, etc). Ultra scalp has different priorities:
 *
 *     1. Tight delta band per tier (no deep ITM premium drag)
 *     2. Liquidity FIRST (spread and OI matter more than max-pain bias)
 *     3. Tier-aware moneyness (elite → slight OTM for runner leverage)
 *     4. Hard premium caps so a single SL hit doesn't blow the day
 *     5. Bid-ask spread quality check — wide spreads kill 5-pt scalps
 *
 * Returns the same shape as the institutional selector so it's a drop-in
 * replacement when invoked from the entry engine for ULTRA_SCALP entries.
 *
 *   { ok, strike, optionType, moneyness, delta, ltp, oi, score,
 *     distFromAnchor, distFromAtm, window, deltaBand, reasoning, candidates }
 *
 * The institutional selector remains the entry path for all non-ultra trades.
 */

const STRIKE_STEP = 50;

// ────────────────────────────────────────────────────────────────────────
// TIER PRESETS — delta bands, moneyness bias, premium caps per tier.
// Tuned for NIFTY 65-lot scalping where:
//   - elite scores carry conviction → can afford slight OTM (more leverage)
//   - standard wants ATM (balanced)
//   - weak should never reach for OTM (low conviction = small move only)
// ────────────────────────────────────────────────────────────────────────
const TIER_PROFILES = {
  elite: {
    deltaMin: 0.42, deltaMax: 0.58,
    deltaHardMax: 0.65,                   // never deeper ITM than this
    minPremium: 25,
    maxPremium: 200,                      // cap absolute rupee risk per lot
    moneynessBonus: { OTM: 16, ATM: 10, ITM: 0 },
    distMaxFromAtm: 100,
  },
  standard: {
    deltaMin: 0.40, deltaMax: 0.55,
    deltaHardMax: 0.62,
    minPremium: 25,
    maxPremium: 180,
    moneynessBonus: { OTM: 8, ATM: 14, ITM: 0 },
    distMaxFromAtm: 100,
  },
  weak: {
    deltaMin: 0.40, deltaMax: 0.50,
    deltaHardMax: 0.58,
    minPremium: 30,
    maxPremium: 150,
    moneynessBonus: { OTM: 2, ATM: 12, ITM: -10 },
    distMaxFromAtm: 50,
  },
};

function _absDelta(strike, direction) {
  const greeks = direction === 'bullish'
    ? (strike?.ce?.delta ?? strike?.call?.greeks?.delta)
    : Math.abs(strike?.pe?.delta ?? strike?.put?.greeks?.delta ?? 0);
  return Math.abs(Number(greeks) || 0);
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

function _bidAsk(strike, direction) {
  const c = direction === 'bullish' ? (strike?.ce || strike?.call) : (strike?.pe || strike?.put);
  return { bid: Number(c?.bid) || 0, ask: Number(c?.ask) || 0 };
}

function _moneyness(strikeVal, atmStrike, direction) {
  if (strikeVal === atmStrike) return 'ATM';
  const diff = strikeVal - atmStrike;
  if (direction === 'bullish') return diff < 0 ? 'ITM' : 'OTM';
  return diff > 0 ? 'ITM' : 'OTM';
}

/**
 * @param {Object} opts
 * @param {string} opts.direction        'bullish' → CE, 'bearish' → PE
 * @param {number} opts.atmStrike
 * @param {Array}  opts.primaryStrikes   chain rows
 * @param {string} [opts.tier='standard'] 'elite' | 'standard' | 'weak'
 * @param {number} [opts.openingStrike]  day's opening reference strike
 * @param {number} [opts.maxPain]
 * @param {number} [opts.windowHalf=4]   max strikes from anchor
 * @param {number} [opts.hhmm]           IST hh*100+mm — late-day theta penalty
 * @param {Object} [opts.expiryOverrides] forward to honour ITM bias on expiry
 * @returns {Object}
 */
function select({
  direction,
  atmStrike,
  primaryStrikes = [],
  tier = 'standard',
  openingStrike = null,
  maxPain = null,
  windowHalf = 4,
  hhmm = null,
  expiryOverrides = null,
} = {}) {
  if (!primaryStrikes.length || !atmStrike) {
    return { ok: false, reason: 'no chain or atm', strike: null };
  }
  const profile = TIER_PROFILES[tier] || TIER_PROFILES.standard;

  const anchor = Number.isFinite(openingStrike) ? openingStrike : atmStrike;
  const windowLow  = anchor - windowHalf * STRIKE_STEP;
  const windowHigh = anchor + windowHalf * STRIKE_STEP;
  const lateAfternoon = Number.isFinite(hhmm) && hhmm >= 1400;

  const candidates = primaryStrikes
    .filter(s => s && Number.isFinite(s.strike))
    .filter(s => s.strike >= windowLow && s.strike <= windowHigh)
    .filter(s => Math.abs(s.strike - atmStrike) <= profile.distMaxFromAtm)
    .map(s => {
      const ltp = _ltp(s, direction);
      const oi  = _oi(s, direction);
      const dlt = _absDelta(s, direction);
      const moneyness = s.moneyness || _moneyness(s.strike, atmStrike, direction);
      const { bid, ask } = _bidAsk(s, direction);
      const reasons = [];
      let score = 50;

      // Hard premium gates
      if (ltp < profile.minPremium) {
        score = 0;
        reasons.push(`ltp ${ltp} < min ${profile.minPremium}`);
      }
      if (ltp > profile.maxPremium) {
        score = Math.min(score, 5);
        reasons.push(`ltp ${ltp} > max ${profile.maxPremium} (premium cap)`);
      }
      if (oi < 1000) {
        score = Math.min(score, 10);
        reasons.push(`oi ${oi} too low for ultra scalp`);
      }

      // Hard delta cap — ultra scalps never go too deep ITM
      if (dlt > profile.deltaHardMax) {
        score = Math.min(score, 5);
        reasons.push(`delta ${dlt.toFixed(2)} > tier hard max ${profile.deltaHardMax}`);
      }

      // Delta band scoring
      if (dlt >= profile.deltaMin && dlt <= profile.deltaMax) {
        score += 30;
        reasons.push(`delta ${dlt.toFixed(2)} in band ${profile.deltaMin}-${profile.deltaMax}`);
      } else if (dlt > 0) {
        score -= 12;
        reasons.push(`delta ${dlt.toFixed(2)} out of tier band`);
      }

      // Distance from ATM
      const distFromAtm = Math.abs(s.strike - atmStrike);
      if (distFromAtm === 0)         score += 14;
      else if (distFromAtm <= 50)    score += 10;
      else if (distFromAtm <= 100)   score += 4;
      else                            score -= 8;

      // Distance from anchor
      const distFromAnchor = Math.abs(s.strike - anchor);
      if (distFromAnchor <= STRIKE_STEP)        score += 8;
      else if (distFromAnchor <= 2 * STRIKE_STEP) score += 3;
      else if (distFromAnchor >= 4 * STRIKE_STEP) score -= 8;

      // Bid-ask spread — wider than 1.5pt destroys a 5-pt scalp
      if (bid > 0 && ask > 0) {
        const spreadAbs = ask - bid;
        const spreadPct = ltp > 0 ? (spreadAbs / ltp) * 100 : 0;
        if (spreadAbs <= 1)       { score += 8;  reasons.push(`tight spread ${spreadAbs.toFixed(2)}`); }
        else if (spreadAbs <= 2)  { score += 3;  reasons.push(`ok spread ${spreadAbs.toFixed(2)}`); }
        else if (spreadAbs <= 4)  { score -= 4;  reasons.push(`wide spread ${spreadAbs.toFixed(2)}`); }
        else                      { score -= 12; reasons.push(`very wide spread ${spreadAbs.toFixed(2)}`); }
        if (spreadPct >= 5)       { score -= 6;  reasons.push(`spread ${spreadPct.toFixed(1)}% of ltp`); }
      }

      // Max-pain — light penalty (ultra scalp is short-duration; pin matters less)
      if (Number.isFinite(maxPain) && Math.abs(s.strike - maxPain) < 25) {
        score -= 12;
        reasons.push(`within 25 of max-pain ${maxPain}`);
      }

      // Late-day OTM theta — heavy penalty
      if (lateAfternoon && moneyness === 'OTM') {
        score -= 18;
        reasons.push('late-day OTM theta penalty');
      }
      // Expiry override — prefer ITM/ATM only
      if (expiryOverrides?.preferITM && moneyness === 'OTM') {
        score -= 25;
        reasons.push('expiry override prefers ITM');
      }

      // Tier-aware moneyness bias (only when expiry/late-day haven't penalised)
      if (!expiryOverrides?.preferITM && !lateAfternoon) {
        const bonus = profile.moneynessBonus[moneyness] || 0;
        if (bonus !== 0) {
          score += bonus;
          reasons.push(`tier ${tier} ${moneyness} ${bonus > 0 ? '+' : ''}${bonus}`);
        }
      }

      return {
        strike: s.strike,
        ltp, oi, delta: dlt, moneyness,
        score, distFromAtm, distFromAnchor,
        bid, ask, spreadAbs: bid > 0 && ask > 0 ? ask - bid : null,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score <= 0) {
    return {
      ok: false, reason: 'no viable ultra-scalp strike in window',
      strike: null, candidates: candidates.slice(0, 5),
      window: { low: windowLow, high: windowHigh, anchor },
      tier,
    };
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
    bid: best.bid, ask: best.ask, spreadAbs: best.spreadAbs,
    window: { low: windowLow, high: windowHigh, anchor },
    deltaBand: { min: profile.deltaMin, max: profile.deltaMax },
    tier,
    reasoning: best.reasons.join(' | '),
    candidates: candidates.slice(0, 5),
  };
}

module.exports = {
  select,
  TIER_PROFILES,
};
