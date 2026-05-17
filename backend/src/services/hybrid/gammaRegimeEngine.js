/**
 * Gamma Regime Engine
 * ===================
 * Estimates dealer gamma exposure (GEX) from the option chain and tells the
 * system which playbook applies:
 *
 *   POSITIVE GAMMA  → mean reversion works, breakouts fail, price pinned
 *   NEGATIVE GAMMA  → trends accelerate, breakouts expand violently
 *   NEUTRAL          → no edge from gamma alone
 *
 * Why this matters: in a positive gamma regime, dealers BUY weakness and SELL
 * strength to stay delta-neutral, which pins price. In a negative gamma
 * regime, dealers must SELL weakness and BUY strength, amplifying moves.
 *
 * Formula (industry-standard simplification):
 *   netGamma_per_strike = (CE_OI - PE_OI) × gamma × spotPrice² × 0.01
 *   total GEX = Σ across strikes
 *   gamma flip = price level where signed cumulative GEX crosses zero
 *
 * We don't have per-strike per-share gamma from greeks — we use a smoothed
 * synthetic gamma curve (peaks at ATM, falls off with strike distance) when
 * the chain doesn't carry gamma values. This is sufficient for regime
 * classification (we don't need precise GEX figures, only sign + magnitude).
 *
 * Pure deterministic.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

// Smoothed normalized gamma — bell curve centered on ATM
function _syntheticGamma(strike, atm, spotPrice) {
  if (!atm || !spotPrice) return 0;
  const distPct = Math.abs(strike - atm) / spotPrice;
  // Bell with sigma = 1.5%
  const sigma = 0.015;
  const x = distPct / sigma;
  return Math.exp(-0.5 * x * x);
}

/**
 * @param {Object} args
 * @param {Array}  args.strikes        - chain rows from aggregator (ATM ± N)
 * @param {number} args.spotPrice
 * @param {number} args.atmStrike
 * @returns {Object}
 */
function analyze({ strikes = [], spotPrice = null, atmStrike = null } = {}) {
  if (!strikes.length || !Number.isFinite(spotPrice) || !Number.isFinite(atmStrike)) {
    return {
      regime: 'unknown',
      netGex: 0,
      callWall: null,
      putWall: null,
      gammaFlip: null,
      pinningLevel: null,
      reasoning: 'no chain or spot',
    };
  }

  // Per-strike GEX
  const perStrike = [];
  let totalGex = 0;
  let pocCe = 0, pocPe = 0;          // OI peaks
  let pocCeStrike = null, pocPeStrike = null;
  let pinTotalOi = 0, pinSum = 0;    // for pinning level

  for (const s of strikes) {
    const ceOi = _safe(s.call?.oi ?? s.ce?.oi);
    const peOi = _safe(s.put?.oi  ?? s.pe?.oi);
    // Gamma — prefer real, else synthetic
    const ceG = _safe(s.call?.greeks?.gamma) || _syntheticGamma(s.strike, atmStrike, spotPrice);
    const peG = _safe(s.put?.greeks?.gamma)  || _syntheticGamma(s.strike, atmStrike, spotPrice);
    // GEX contribution. Sign convention: dealers are SHORT calls, LONG puts
    // (assuming retail is buying calls / selling puts most days). So:
    //   Call GEX (dealer perspective) = -ceOi × ceG × spot²
    //   Put  GEX (dealer perspective) = +peOi × peG × spot²
    // We flip the sign so positive = mean-reverting regime.
    const gex = (peOi * peG - ceOi * ceG) * spotPrice * spotPrice * 0.0001;
    perStrike.push({ strike: s.strike, ceOi, peOi, ceG, peG, gex });
    totalGex += gex;

    if (ceOi > pocCe) { pocCe = ceOi; pocCeStrike = s.strike; }
    if (peOi > pocPe) { pocPe = peOi; pocPeStrike = s.strike; }

    pinSum += s.strike * (ceOi + peOi);
    pinTotalOi += (ceOi + peOi);
  }

  // Gamma flip — strike where signed cumulative GEX crosses zero
  let gammaFlip = null;
  let cum = 0;
  // Sort by strike ascending
  const sorted = [...perStrike].sort((a, b) => a.strike - b.strike);
  for (let i = 0; i < sorted.length; i++) {
    const prevCum = cum;
    cum += sorted[i].gex;
    if (i > 0 && Math.sign(prevCum) !== Math.sign(cum) && Math.sign(cum) !== 0) {
      // Linear interp between sorted[i-1].strike and sorted[i].strike
      const x0 = sorted[i - 1].strike, x1 = sorted[i].strike;
      const y0 = prevCum,             y1 = cum;
      gammaFlip = x0 + (x1 - x0) * (-y0 / (y1 - y0));
      break;
    }
  }

  // Walls — strikes with the most CE OI (call wall = resistance)
  // and most PE OI (put wall = support)
  const callWall = pocCeStrike;
  const putWall  = pocPeStrike;

  // Pinning level — OI-weighted strike (rough max-pain proxy)
  const pinningLevel = pinTotalOi > 0 ? Number((pinSum / pinTotalOi).toFixed(2)) : null;

  // Regime classification
  // Strongly positive when net GEX > +threshold AND price near pinning
  // Strongly negative when net GEX < -threshold AND price away from pinning
  const absGex = Math.abs(totalGex);
  const distToPin = pinningLevel ? Math.abs(spotPrice - pinningLevel) / spotPrice : null;

  let regime = 'neutral';
  const reasons = [];

  if (totalGex > 0 && (distToPin == null || distToPin < 0.005)) {
    regime = 'positive';
    reasons.push(`netGEX +${totalGex.toFixed(0)}, near pin ${pinningLevel}`);
  } else if (totalGex < 0) {
    regime = 'negative';
    reasons.push(`netGEX ${totalGex.toFixed(0)}`);
    if (gammaFlip && spotPrice < gammaFlip) reasons.push(`below flip ${gammaFlip.toFixed(0)}`);
  } else if (totalGex > 0) {
    regime = 'positive';
    reasons.push(`netGEX +${totalGex.toFixed(0)}`);
  }

  // Wall warnings
  if (callWall && spotPrice < callWall) reasons.push(`call wall ${callWall} above`);
  if (putWall  && spotPrice > putWall)  reasons.push(`put wall ${putWall} below`);

  return {
    regime,                                  // positive | negative | neutral | unknown
    netGex:    Number(totalGex.toFixed(2)),
    absGex:    Number(absGex.toFixed(2)),
    callWall,
    putWall,
    gammaFlip: gammaFlip ? Number(gammaFlip.toFixed(2)) : null,
    pinningLevel,
    spotVsPin: pinningLevel ? Number((spotPrice - pinningLevel).toFixed(2)) : null,
    perStrike: sorted.map(s => ({ strike: s.strike, gex: Number(s.gex.toFixed(2)) })),
    reasoning: reasons.join(' | '),
  };
}

/**
 * Direction-aware score for the confidence engine. Maps regime + spot-vs-flip
 * to a 0..100 score. Negative gamma + price beyond flip in the trade direction
 * is the strongest setup.
 */
function score(gammaAnalysis, direction) {
  if (!gammaAnalysis || gammaAnalysis.regime === 'unknown') return { score: 50, reasons: ['no gamma'] };
  const r = gammaAnalysis;
  const reasons = [];
  let s = 50;

  if (r.regime === 'negative') {
    // negative gamma supports trend continuation
    if (direction === 'bullish' && r.gammaFlip && r.spotVsPin != null && r.spotVsPin > 0) { s = 78; reasons.push('negative gamma + above pin → bullish acceleration'); }
    else if (direction === 'bearish' && r.gammaFlip && r.spotVsPin != null && r.spotVsPin < 0) { s = 78; reasons.push('negative gamma + below pin → bearish acceleration'); }
    else { s = 65; reasons.push('negative gamma — momentum favoured'); }
  } else if (r.regime === 'positive') {
    // positive gamma supports mean reversion only
    if (direction === 'bullish' && r.spotVsPin != null && r.spotVsPin < 0) { s = 65; reasons.push('positive gamma + below pin → mean revert long'); }
    else if (direction === 'bearish' && r.spotVsPin != null && r.spotVsPin > 0) { s = 65; reasons.push('positive gamma + above pin → mean revert short'); }
    else { s = 35; reasons.push('positive gamma against direction — pin risk'); }
  }

  // Wall opposition penalty
  if (direction === 'bullish' && r.callWall && r.callWall > 0 && r.callWall - (r.pinningLevel || r.callWall) < 75) {
    s -= 8; reasons.push(`call wall ${r.callWall} ahead`);
  }
  if (direction === 'bearish' && r.putWall  && r.putWall  > 0 && (r.pinningLevel || r.putWall) - r.putWall < 75) {
    s -= 8; reasons.push(`put wall ${r.putWall} below`);
  }
  return { score: Math.max(0, Math.min(100, Math.round(s))), reasons };
}

module.exports = { analyze, score };
