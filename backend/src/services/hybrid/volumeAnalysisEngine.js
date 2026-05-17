/**
 * Volume Analysis Engine (FRVP + VSA + Time-Volume)
 * --------------------------------------------------
 * Three views of volume, fused into one institutional read:
 *
 *   1. FRVP / Volume Profile (where)
 *      - POC, VAH, VAL
 *      - HVN (high volume nodes — strong S/R)
 *      - LVN (low volume nodes — fast-move zones)
 *      - acceptance: above_va | inside_va | below_va
 *
 *   2. Time-volume (when)
 *      - last bar volume vs SMA(volume, 20)
 *      - volume spike, climax, dry-up
 *
 *   3. VSA (effort vs result)
 *      Compares current candle's spread (range) with current volume:
 *        small candle + big volume     = absorption
 *        big   candle + small volume   = no demand / no supply (fake)
 *        big   candle + big   volume   = genuine momentum
 *        small candle + small volume   = consolidation
 *      Plus wick-based variants:
 *        long upper wick + huge volume = upthrust (bearish at top)
 *        long lower wick + huge volume = spring   (bullish at bottom)
 *
 * The engine emits both raw signals (so other engines can read them) and a
 * direction-aware score (0..100, 50 = neutral) used by the probability
 * scoring engine as the volume pillar.
 *
 * Pure deterministic — no AI, no network calls.
 */

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────
function _norm(c) {
  if (!c) return null;
  const o = c.o ?? c.open;
  const h = c.h ?? c.high;
  const l = c.l ?? c.low;
  const cl = c.c ?? c.close;
  const v = c.v ?? c.volume ?? 0;
  if (![o, h, l, cl].every(Number.isFinite)) return null;
  return { o, h, l, c: cl, v: Number(v) || 0 };
}

function _safeAvg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ───────────────────────────────────────────────────────────────────────────
// FRVP — Fixed Range Volume Profile
// ───────────────────────────────────────────────────────────────────────────
function _computeFrvp(candles, buckets = 50) {
  const norm = (candles || []).map(_norm).filter(Boolean);
  if (norm.length < 10) return null;

  const minPrice = Math.min(...norm.map(c => c.l));
  const maxPrice = Math.max(...norm.map(c => c.h));
  const range = maxPrice - minPrice;
  if (range <= 0) return null;
  const bucketSize = range / buckets;

  const bins = new Array(buckets).fill(0);

  for (const c of norm) {
    const candleRange = c.h - c.l;
    if (candleRange <= 0) {
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor((c.l - minPrice) / bucketSize)));
      bins[idx] += c.v;
    } else {
      const startIdx = Math.max(0, Math.floor((c.l - minPrice) / bucketSize));
      const endIdx   = Math.min(buckets - 1, Math.floor((c.h - minPrice) / bucketSize));
      const span = Math.max(1, endIdx - startIdx + 1);
      const per = c.v / span;
      for (let i = startIdx; i <= endIdx; i++) bins[i] += per;
    }
  }

  const totalVolume = bins.reduce((a, b) => a + b, 0);
  if (totalVolume <= 0) return null;

  // POC
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[pocIdx]) pocIdx = i;
  const pocPrice = minPrice + pocIdx * bucketSize + bucketSize / 2;
  const pocVolume = bins[pocIdx];

  // Value Area (70%)
  const target = totalVolume * 0.7;
  let vol = bins[pocIdx];
  let lo = pocIdx, hi = pocIdx;
  while (vol < target && (lo > 0 || hi < bins.length - 1)) {
    const lv = lo > 0 ? bins[lo - 1] : -1;
    const hv = hi < bins.length - 1 ? bins[hi + 1] : -1;
    if (lv >= hv) { lo--; vol += Math.max(0, lv); }
    else          { hi++; vol += Math.max(0, hv); }
  }
  const vaLow  = minPrice + lo * bucketSize;
  const vaHigh = minPrice + (hi + 1) * bucketSize;

  // HVN / LVN
  const avg = totalVolume / buckets;
  const hvnCutoff = avg * 1.5;
  const lvnCutoff = avg * 0.5;
  const hvn = [], lvn = [];
  for (let i = 0; i < bins.length; i++) {
    const price = minPrice + i * bucketSize + bucketSize / 2;
    if (bins[i] >= hvnCutoff) hvn.push({ price: Number(price.toFixed(2)), volume: Math.round(bins[i]) });
    else if (bins[i] > 0 && bins[i] <= lvnCutoff) lvn.push({ price: Number(price.toFixed(2)), volume: Math.round(bins[i]) });
  }
  // Top N
  hvn.sort((a, b) => b.volume - a.volume);
  lvn.sort((a, b) => a.volume - b.volume);

  return {
    pocPrice: Number(pocPrice.toFixed(2)),
    pocVolume: Math.round(pocVolume),
    vaHigh:   Number(vaHigh.toFixed(2)),
    vaLow:    Number(vaLow.toFixed(2)),
    hvn:      hvn.slice(0, 8),
    lvn:      lvn.slice(0, 6),
    bucketSize: Number(bucketSize.toFixed(2)),
    totalVolume: Math.round(totalVolume),
    candleCount: norm.length,
  };
}

function _frvpAcceptance(frvp, spotPrice) {
  if (!frvp || !Number.isFinite(spotPrice)) return 'unknown';
  if (spotPrice > frvp.vaHigh) return 'above_va';
  if (spotPrice < frvp.vaLow)  return 'below_va';
  return 'inside_va';
}

function _nearestNodes(frvp, spotPrice) {
  if (!frvp) return { support: null, resistance: null, distSupportPts: null, distResistancePts: null };
  let support = null, resistance = null;
  for (const n of frvp.hvn) {
    if (n.price < spotPrice) {
      if (!support || n.price > support.price) support = n;
    } else if (n.price > spotPrice) {
      if (!resistance || n.price < resistance.price) resistance = n;
    }
  }
  return {
    support,
    resistance,
    distSupportPts:    support ? Number((spotPrice - support.price).toFixed(2)) : null,
    distResistancePts: resistance ? Number((resistance.price - spotPrice).toFixed(2)) : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Time-volume (current activity vs recent average)
// ───────────────────────────────────────────────────────────────────────────
function _timeVolume(candles, lookback = 20) {
  const norm = (candles || []).map(_norm).filter(Boolean);
  if (norm.length < 5) return null;

  const tail = norm.slice(-lookback);
  const last = norm[norm.length - 1];
  const avgVol = _safeAvg(tail.map(c => c.v));
  const ratio  = avgVol > 0 ? last.v / avgVol : 0;

  let state = 'normal';
  if (ratio >= 2.5)      state = 'climax';
  else if (ratio >= 1.5) state = 'spike';
  else if (ratio <= 0.4) state = 'dry_up';

  return {
    lastVolume: last.v,
    avgVolume:  Math.round(avgVol),
    ratio:      Number(ratio.toFixed(2)),
    state,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// VSA — Volume Spread Analysis
// ───────────────────────────────────────────────────────────────────────────
function _vsa(candles) {
  const norm = (candles || []).map(_norm).filter(Boolean);
  if (norm.length < 10) return null;

  const last = norm[norm.length - 1];
  const tail = norm.slice(-20);
  const avgRange = _safeAvg(tail.map(c => c.h - c.l));
  const avgVol   = _safeAvg(tail.map(c => c.v));

  if (avgRange <= 0 || avgVol <= 0) return null;

  const lastRange = last.h - last.l;
  const body = Math.abs(last.c - last.o);
  const upperWick = last.h - Math.max(last.o, last.c);
  const lowerWick = Math.min(last.o, last.c) - last.l;

  const rangeRatio  = lastRange / avgRange;
  const volRatio    = last.v / avgVol;
  const direction   = last.c > last.o ? 'up' : last.c < last.o ? 'down' : 'doji';

  // Long wick detection — wick at least 2× body and at least 50% of range
  const longUpperWick = body > 0 && upperWick >= 2 * body && upperWick >= 0.5 * lastRange;
  const longLowerWick = body > 0 && lowerWick >= 2 * body && lowerWick >= 0.5 * lastRange;

  // Pattern classification (priority order — wick patterns first)
  let pattern = 'consolidation';
  let bias = 'neutral';
  let strength = 0;
  const reasons = [];

  if (longUpperWick && volRatio >= 1.5) {
    pattern = 'upthrust';
    bias = 'bearish';
    strength = 80;
    reasons.push(`upper wick rejection on ${volRatio.toFixed(2)}× volume`);
  } else if (longLowerWick && volRatio >= 1.5) {
    pattern = 'spring';
    bias = 'bullish';
    strength = 80;
    reasons.push(`lower wick rejection on ${volRatio.toFixed(2)}× volume`);
  } else if (rangeRatio < 0.6 && volRatio >= 1.8) {
    pattern = 'absorption';
    // Direction-of-absorption is decided by the candle close relative to its open and tail
    bias = last.c >= last.o ? 'bullish' : 'bearish';
    strength = 75;
    reasons.push(`small candle + ${volRatio.toFixed(2)}× volume`);
  } else if (rangeRatio >= 1.4 && volRatio >= 1.4) {
    pattern = 'momentum';
    bias = direction === 'up' ? 'bullish' : direction === 'down' ? 'bearish' : 'neutral';
    strength = 85;
    reasons.push(`big candle + ${volRatio.toFixed(2)}× volume`);
  } else if (rangeRatio >= 1.4 && volRatio < 0.8) {
    pattern = direction === 'up' ? 'no_demand' : 'no_supply';
    bias = direction === 'up' ? 'bearish' : 'bullish';   // contrarian — fake move
    strength = 65;
    reasons.push(`big candle on weak ${volRatio.toFixed(2)}× volume — likely fake`);
  } else if (rangeRatio < 0.7 && volRatio < 0.7) {
    pattern = 'consolidation';
    bias = 'neutral';
    strength = 30;
    reasons.push('low range + low volume');
  } else {
    reasons.push(`range ${rangeRatio.toFixed(2)}× vol ${volRatio.toFixed(2)}× — normal`);
  }

  return {
    pattern,
    bias,
    strength,
    direction,
    rangeRatio: Number(rangeRatio.toFixed(2)),
    volRatio:   Number(volRatio.toFixed(2)),
    longUpperWick,
    longLowerWick,
    reasons,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Direction-aware scoring (0..100, 50 = neutral)
// ───────────────────────────────────────────────────────────────────────────
function _scoreForDirection({ frvp, acceptance, nearest, timeVolume, vsa, spotPrice }, direction) {
  let s = 50;
  const reasons = [];

  // FRVP acceptance — a strong context signal
  if (direction === 'bullish') {
    if (acceptance === 'above_va') { s += 12; reasons.push('above value area (bullish acceptance)'); }
    else if (acceptance === 'below_va') { s += 8; reasons.push('below value area (mean-reversion long)'); }
    else { reasons.push('inside value area'); }
  } else if (direction === 'bearish') {
    if (acceptance === 'below_va') { s += 12; reasons.push('below value area (bearish acceptance)'); }
    else if (acceptance === 'above_va') { s += 8; reasons.push('above value area (mean-reversion short)'); }
    else { reasons.push('inside value area'); }
  }

  // POC magnetism — penalise being right at POC (chop) and reward break beyond it
  if (frvp && Number.isFinite(spotPrice)) {
    const distFromPoc = spotPrice - frvp.pocPrice;
    if (Math.abs(distFromPoc) < frvp.bucketSize) {
      s -= 5;
      reasons.push('at POC — likely chop');
    } else if (direction === 'bullish' && distFromPoc > 0) {
      s += 3; reasons.push('above POC');
    } else if (direction === 'bearish' && distFromPoc < 0) {
      s += 3; reasons.push('below POC');
    }
  }

  // Nearby HVN — friendly support for the trade direction
  if (nearest?.support && direction === 'bullish' && nearest.distSupportPts != null && nearest.distSupportPts <= 30) {
    s += 8;
    reasons.push(`near HVN support ${nearest.support.price}`);
  }
  if (nearest?.resistance && direction === 'bearish' && nearest.distResistancePts != null && nearest.distResistancePts <= 30) {
    s += 8;
    reasons.push(`near HVN resistance ${nearest.resistance.price}`);
  }
  if (nearest?.resistance && direction === 'bullish' && nearest.distResistancePts != null && nearest.distResistancePts <= 15) {
    s -= 12;
    reasons.push(`HVN wall ${nearest.resistance.price} just above`);
  }
  if (nearest?.support && direction === 'bearish' && nearest.distSupportPts != null && nearest.distSupportPts <= 15) {
    s -= 12;
    reasons.push(`HVN floor ${nearest.support.price} just below`);
  }

  // Time-volume confirmation — recency bias
  if (timeVolume) {
    if (timeVolume.state === 'spike' || timeVolume.state === 'climax') {
      s += 6;
      reasons.push(`volume ${timeVolume.state} ${timeVolume.ratio}×`);
    } else if (timeVolume.state === 'dry_up') {
      s -= 8;
      reasons.push('volume dry-up');
    }
  }

  // VSA pattern — strongest single signal here
  if (vsa) {
    if (vsa.bias === direction) {
      s += Math.min(15, Math.round(vsa.strength / 6));
      reasons.push(`VSA ${vsa.pattern} (${vsa.bias})`);
    } else if (vsa.bias !== 'neutral') {
      s -= Math.min(20, Math.round(vsa.strength / 5));
      reasons.push(`VSA ${vsa.pattern} against direction (${vsa.bias})`);
    }
  }

  return { score: Math.max(0, Math.min(100, Math.round(s))), reasons };
}

// ───────────────────────────────────────────────────────────────────────────
// Public — analyze
// ───────────────────────────────────────────────────────────────────────────
/**
 * @param {Object} args
 * @param {Array}  args.candles5m
 * @param {Array}  args.candles15m
 * @param {number} args.spotPrice
 * @param {string} [args.direction] - if provided, also returns directional score
 * @returns {Object|null}
 */
function analyze({ candles5m = [], candles15m = [], spotPrice = null, direction = null } = {}) {
  // Use 15m as primary FRVP basis when available — it's more stable.
  // Fall back to 5m for intraday-only sessions.
  const frvp5  = _computeFrvp(candles5m,  50);
  const frvp15 = _computeFrvp(candles15m, 50);
  const frvp   = frvp15 || frvp5;
  if (!frvp) return null;

  const acceptance = _frvpAcceptance(frvp, spotPrice);
  const nearest    = _nearestNodes(frvp, spotPrice);
  const timeVolume = _timeVolume(candles5m, 20);
  const vsa        = _vsa(candles5m);

  const out = {
    spotPrice,
    frvp,
    frvp_5m:  frvp5,
    frvp_15m: frvp15,
    acceptance,           // above_va | inside_va | below_va | unknown
    nearestSupport:    nearest.support,
    nearestResistance: nearest.resistance,
    distSupportPts:    nearest.distSupportPts,
    distResistancePts: nearest.distResistancePts,
    timeVolume,           // { lastVolume, avgVolume, ratio, state }
    vsa,                  // { pattern, bias, strength, ... }
  };

  if (direction === 'bullish' || direction === 'bearish') {
    const scored = _scoreForDirection({ frvp, acceptance, nearest, timeVolume, vsa, spotPrice }, direction);
    out.directionalScore = scored.score;
    out.directionalReasons = scored.reasons;
    out.reasoning = scored.reasons.join(' | ');
  } else {
    out.reasoning = [
      `acceptance=${acceptance}`,
      timeVolume ? `vol_state=${timeVolume.state} (${timeVolume.ratio}×)` : null,
      vsa ? `vsa=${vsa.pattern} (${vsa.bias})` : null,
    ].filter(Boolean).join(' | ');
  }

  return out;
}

/**
 * Direction-aware score helper used by probabilityScoringEngine.
 * Returns { score, reasons } in 0..100 (50 = neutral).
 */
function score(volumeAnalysis, direction) {
  if (!volumeAnalysis || !volumeAnalysis.frvp) return { score: 50, reasons: ['no volume profile'] };
  if (volumeAnalysis.directionalScore != null && volumeAnalysis.directionalReasons) {
    return { score: volumeAnalysis.directionalScore, reasons: volumeAnalysis.directionalReasons };
  }
  return _scoreForDirection({
    frvp: volumeAnalysis.frvp,
    acceptance: volumeAnalysis.acceptance,
    nearest: { support: volumeAnalysis.nearestSupport, resistance: volumeAnalysis.nearestResistance,
               distSupportPts: volumeAnalysis.distSupportPts, distResistancePts: volumeAnalysis.distResistancePts },
    timeVolume: volumeAnalysis.timeVolume,
    vsa: volumeAnalysis.vsa,
    spotPrice: volumeAnalysis.spotPrice,
  }, direction);
}

module.exports = {
  analyze,
  score,
  // exported for tests
  _computeFrvp,
  _vsa,
  _timeVolume,
};
