/**
 * Premium Swing Strike Selector
 * =============================
 * Strike picker for the Premium Swing engine. Different from the scalp
 * selector because:
 *
 *   • Hold is 5min-4hr (vs 30s-5min) → theta resistance matters more
 *   • Targets are 25-60pt premium (vs 8-22pt) → need real movement
 *   • Trend trades prefer ATM/ITM (delta 0.50-0.60)
 *   • Sideways trades stick to ATM only (delta 0.50)
 *   • Cascade reversal trades on OI zones may use OTM (delta 0.40-0.50)
 *
 * The engine itself already names a specific strike (the primary or
 * a cascade strike). The selector is mostly used to:
 *   1. Verify the strike is liquid + tradable (OI, premium, spread)
 *   2. Fall back to a nearby strike if the named one isn't available
 *   3. Score moneyness to prefer ATM > 1-strike-ITM > OTM for swing
 */

const STRIKE_STEP = 50;

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

function _legOf(row, side) {
  return side === 'CE' ? (row?.ce ?? row?.call) : (row?.pe ?? row?.put);
}

function _moneyness(strike, atm, side) {
  if (strike === atm) return 'ATM';
  const diff = strike - atm;
  if (side === 'CE') return diff < 0 ? 'ITM' : 'OTM';
  return diff > 0 ? 'ITM' : 'OTM';
}

/**
 * @param {{
 *   namedStrike,     // engine-chosen strike (must be present in chain)
 *   side: 'CE'|'PE',
 *   atmStrike,
 *   primaryStrikes: Array,
 *   playKind: 'primary'|'sideways_bounce'|'cascade_support'|'cascade_resistance',
 *   hhmm,            // optional IST HHMM for late-day theta penalty
 * }} args
 */
function select({
  namedStrike,
  side,
  atmStrike,
  primaryStrikes = [],
  playKind = 'primary',
  hhmm = null,
} = {}) {
  if (!Array.isArray(primaryStrikes) || primaryStrikes.length === 0 || !atmStrike) {
    return { ok: false, reason: 'no chain or atm', strike: null };
  }
  if (!Number.isFinite(namedStrike)) {
    return { ok: false, reason: 'no named strike from engine', strike: null };
  }

  // Theta band by play kind
  const cfg = (() => {
    if (playKind === 'sideways_bounce') {
      return { deltaMin: 0.45, deltaMax: 0.55, deltaHardMax: 0.60,
               minPremium: 30, maxPremium: 250, allowITM: false };
    }
    if (playKind === 'cascade_support' || playKind === 'cascade_resistance') {
      return { deltaMin: 0.40, deltaMax: 0.55, deltaHardMax: 0.62,
               minPremium: 30, maxPremium: 280, allowITM: true };
    }
    // primary trend trade
    return { deltaMin: 0.45, deltaMax: 0.62, deltaHardMax: 0.70,
             minPremium: 35, maxPremium: 320, allowITM: true };
  })();

  // Build candidate list — prefer the named strike, then ±1 STRIKE_STEP
  const candidatesByStrike = primaryStrikes
    .filter(s => s && Number.isFinite(s.strike))
    .map(s => {
      const leg = _legOf(s, side);
      if (!leg) return null;
      const ltp   = _safe(leg.ltp);
      const oi    = _safe(leg.oi);
      const dlt   = Math.abs(_safe(leg.delta ?? leg.greeks?.delta));
      const bid   = _safe(leg.bid);
      const ask   = _safe(leg.ask);
      const moneyness = _moneyness(Number(s.strike), atmStrike, side);
      return { strike: Number(s.strike), ltp, oi, delta: dlt, bid, ask, moneyness };
    })
    .filter(Boolean);

  if (candidatesByStrike.length === 0) {
    return { ok: false, reason: 'no strike candidates with leg data', strike: null };
  }

  const lateAfternoon = Number.isFinite(hhmm) && hhmm >= 1400;

  // Score every candidate, with a hard preference for the named strike
  const scored = candidatesByStrike.map(c => {
    let score = 50;
    const reasons = [];

    // Hard prefer the named strike — but only if it's tradable.
    const isNamed = c.strike === namedStrike;
    if (isNamed) score += 30;

    // ±1 step adjacency — useful if named strike isn't liquid
    const stepsFromNamed = Math.abs(c.strike - namedStrike) / STRIKE_STEP;
    if (stepsFromNamed === 1) score += 8;
    else if (stepsFromNamed >= 3) score -= 12;

    // Premium gates
    if (c.ltp < cfg.minPremium) { score = 0; reasons.push(`ltp ${c.ltp} < min ${cfg.minPremium}`); }
    if (c.ltp > cfg.maxPremium) { score = Math.min(score, 5); reasons.push(`ltp ${c.ltp} > max ${cfg.maxPremium}`); }

    // OI floor
    if (c.oi < 5_000) { score = Math.min(score, 8); reasons.push('oi too low'); }

    // Delta band — wider for swing
    if (c.delta > cfg.deltaHardMax) {
      score = Math.min(score, 5);
      reasons.push(`delta ${c.delta.toFixed(2)} > hard max ${cfg.deltaHardMax}`);
    }
    if (c.delta >= cfg.deltaMin && c.delta <= cfg.deltaMax) {
      score += 18;
      reasons.push(`delta ${c.delta.toFixed(2)} in band`);
    } else if (c.delta > 0) {
      score -= 6;
    }

    // Moneyness — swing prefers ATM, then ITM (theta resistant), OTM penalised
    if (c.moneyness === 'ATM') score += 12;
    else if (c.moneyness === 'ITM' && cfg.allowITM) score += 8;
    else if (c.moneyness === 'OTM') score -= 4;

    // Late-day OTM penalty — even harsher than scalp because hold is longer
    if (lateAfternoon && c.moneyness === 'OTM') {
      score -= 22;
      reasons.push('late-day OTM theta penalty');
    }

    // Bid-ask spread
    if (c.bid > 0 && c.ask > 0) {
      const spread = c.ask - c.bid;
      if (spread <= 1) score += 5;
      else if (spread <= 2) score += 1;
      else if (spread <= 4) score -= 5;
      else score -= 12;
    }

    return { ...c, score, reasons };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score <= 0) {
    return {
      ok: false,
      reason: 'no viable swing strike',
      strike: null,
      candidates: scored.slice(0, 5),
    };
  }

  return {
    ok: true,
    strike: best.strike,
    optionType: side,
    moneyness: best.moneyness,
    delta: best.delta,
    ltp: best.ltp,
    oi: best.oi,
    bid: best.bid, ask: best.ask,
    score: best.score,
    reasoning: best.reasons.join(' | ') + (best.strike === namedStrike ? ' (named)' : ` (adjusted from ${namedStrike})`),
    candidates: scored.slice(0, 5),
  };
}

module.exports = { select, STRIKE_STEP };
