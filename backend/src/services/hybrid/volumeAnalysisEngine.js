/**
 * Volume Analysis Engine (FRVP + Delta + VSA + Time-Volume)
 * ----------------------------------------------------------
 * Four views of volume, fused into one institutional read:
 *
 *   1. FRVP / Volume Profile (where)
 *      - POC, VAH, VAL
 *      - HVN (high volume nodes — strong S/R)
 *      - LVN (low volume nodes — fast-move zones)
 *      - acceptance: above_va | inside_va | below_va
 *      - per-bucket up / down / delta volume
 *      - UP Areas (buyer-control zones) and DOWN Areas (seller-control zones)
 *
 *   2. Delta / Order-Flow (who)
 *      - cumulative delta (CVD) over short and long windows
 *      - delta bias and trend (rising / falling / flat)
 *      - price-vs-delta divergence:
 *          price ↑ + delta ↓ → hidden selling (smart money distributing)
 *          price ↓ + delta ↑ → hidden buying  (smart money accumulating)
 *      - HIGHEST priority signal in the volume pillar
 *
 *   3. Time-volume (when)
 *      - last bar volume vs SMA(volume, 20)
 *      - volume spike, climax, dry-up
 *
 *   4. VSA (effort vs result)
 *      Compares current candle's spread (range) with current volume:
 *        small candle + big volume     = absorption
 *        big   candle + small volume   = no demand / no supply (fake)
 *        big   candle + big   volume   = genuine momentum
 *        small candle + small volume   = consolidation
 *      Plus wick-based variants:
 *        long upper wick + huge volume = upthrust (bearish at top)
 *        long lower wick + huge volume = spring   (bullish at bottom)
 *
 * Up/Down volume is split per-candle using the wick-weighted proxy:
 *   upPortion   = (close - low)  / (high - low)
 *   downPortion = (high - close) / (high - low)
 * This works without raw tape data and captures intra-candle absorption.
 *
 * The engine emits both raw signals (so other engines can read them) and a
 * direction-aware score (0..100, 50 = neutral) used by the probability
 * scoring engine as the volume pillar. Pure deterministic — no AI.
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
// FRVP — Fixed Range Volume Profile (with delta + up/down + control areas)
// ───────────────────────────────────────────────────────────────────────────
//
// Up/Down volume estimation per candle (no tape data available, so we use the
// industry-standard wick-weighted proxy):
//   upPortion   = (close - low)  / (high - low)
//   downPortion = (high - close) / (high - low)
//   upVolume    = volume × upPortion
//   downVolume  = volume × downPortion
//   delta       = upVolume - downVolume
//
// This is more accurate than the "all-or-nothing by candle direction" method
// because it captures intra-candle absorption (a green candle with a long
// upper wick still has significant down-volume).
//
function _splitCandleVolume(c) {
  const range = c.h - c.l;
  if (range <= 0) {
    // Doji — split 50/50
    return { up: c.v * 0.5, down: c.v * 0.5 };
  }
  const upPortion = Math.max(0, Math.min(1, (c.c - c.l) / range));
  const downPortion = 1 - upPortion;
  return { up: c.v * upPortion, down: c.v * downPortion };
}

function _computeFrvp(candles, buckets = 50) {
  const norm = (candles || []).map(_norm).filter(Boolean);
  if (norm.length < 10) return null;

  const minPrice = Math.min(...norm.map(c => c.l));
  const maxPrice = Math.max(...norm.map(c => c.h));
  const range = maxPrice - minPrice;
  if (range <= 0) return null;
  const bucketSize = range / buckets;

  // Three parallel arrays: total / up / down per bucket
  const totalBins = new Array(buckets).fill(0);
  const upBins    = new Array(buckets).fill(0);
  const downBins  = new Array(buckets).fill(0);

  for (const c of norm) {
    const split = _splitCandleVolume(c);
    const candleRange = c.h - c.l;

    if (candleRange <= 0) {
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor((c.l - minPrice) / bucketSize)));
      totalBins[idx] += c.v;
      upBins[idx]    += split.up;
      downBins[idx]  += split.down;
    } else {
      const startIdx = Math.max(0, Math.floor((c.l - minPrice) / bucketSize));
      const endIdx   = Math.min(buckets - 1, Math.floor((c.h - minPrice) / bucketSize));
      const span = Math.max(1, endIdx - startIdx + 1);
      const totalPer = c.v       / span;
      const upPer    = split.up  / span;
      const downPer  = split.down / span;
      for (let i = startIdx; i <= endIdx; i++) {
        totalBins[i] += totalPer;
        upBins[i]    += upPer;
        downBins[i]  += downPer;
      }
    }
  }

  // Per-bucket delta
  const deltaBins = totalBins.map((_, i) => upBins[i] - downBins[i]);

  const totalVolume = totalBins.reduce((a, b) => a + b, 0);
  if (totalVolume <= 0) return null;
  const totalUp   = upBins.reduce((a, b) => a + b, 0);
  const totalDown = downBins.reduce((a, b) => a + b, 0);
  const totalDelta = totalUp - totalDown;

  // POC (still by total volume — that's the convention)
  let pocIdx = 0;
  for (let i = 1; i < totalBins.length; i++) if (totalBins[i] > totalBins[pocIdx]) pocIdx = i;
  const pocPrice = minPrice + pocIdx * bucketSize + bucketSize / 2;
  const pocVolume = totalBins[pocIdx];
  const pocDelta = deltaBins[pocIdx];

  // Value Area (70%)
  const target = totalVolume * 0.7;
  let vol = totalBins[pocIdx];
  let lo = pocIdx, hi = pocIdx;
  while (vol < target && (lo > 0 || hi < totalBins.length - 1)) {
    const lv = lo > 0 ? totalBins[lo - 1] : -1;
    const hv = hi < totalBins.length - 1 ? totalBins[hi + 1] : -1;
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
  for (let i = 0; i < totalBins.length; i++) {
    const price = minPrice + i * bucketSize + bucketSize / 2;
    if (totalBins[i] >= hvnCutoff) {
      hvn.push({
        price: Number(price.toFixed(2)),
        volume: Math.round(totalBins[i]),
        delta: Math.round(deltaBins[i]),
        bias: deltaBins[i] > 0 ? 'buyer' : deltaBins[i] < 0 ? 'seller' : 'neutral',
      });
    } else if (totalBins[i] > 0 && totalBins[i] <= lvnCutoff) {
      lvn.push({ price: Number(price.toFixed(2)), volume: Math.round(totalBins[i]) });
    }
  }
  hvn.sort((a, b) => b.volume - a.volume);
  lvn.sort((a, b) => a.volume - b.volume);

  // ── UP / DOWN Areas ────────────────────────────────────────────────────
  // A contiguous run of buckets where delta has the same sign AND magnitude
  // exceeds 10% of POC volume. These are the "buyer control" and "seller
  // control" zones the user's note refers to.
  const significantDelta = pocVolume * 0.10;
  const upAreas   = [];
  const downAreas = [];
  let runSign = 0, runStart = -1, runVol = 0;
  for (let i = 0; i < buckets; i++) {
    const d = deltaBins[i];
    const sign = Math.abs(d) < significantDelta ? 0 : (d > 0 ? 1 : -1);
    if (sign !== runSign) {
      if (runSign !== 0 && runStart >= 0) {
        const lowP  = minPrice + runStart * bucketSize;
        const highP = minPrice + i * bucketSize;
        const area = {
          low: Number(lowP.toFixed(2)),
          high: Number(highP.toFixed(2)),
          netDelta: Math.round(runVol),
          bucketCount: i - runStart,
        };
        if (runSign > 0) upAreas.push(area); else downAreas.push(area);
      }
      runSign = sign;
      runStart = sign === 0 ? -1 : i;
      runVol = sign === 0 ? 0 : d;
    } else if (sign !== 0) {
      runVol += d;
    }
  }
  // Close the trailing run
  if (runSign !== 0 && runStart >= 0) {
    const lowP  = minPrice + runStart * bucketSize;
    const highP = minPrice + buckets * bucketSize;
    const area = {
      low: Number(lowP.toFixed(2)),
      high: Number(highP.toFixed(2)),
      netDelta: Math.round(runVol),
      bucketCount: buckets - runStart,
    };
    if (runSign > 0) upAreas.push(area); else downAreas.push(area);
  }
  // Keep top 3 by absolute net delta
  upAreas.sort((a, b) => b.netDelta - a.netDelta);
  downAreas.sort((a, b) => a.netDelta - b.netDelta); // most negative first

  return {
    pocPrice: Number(pocPrice.toFixed(2)),
    pocVolume: Math.round(pocVolume),
    pocDelta:  Math.round(pocDelta),
    vaHigh:   Number(vaHigh.toFixed(2)),
    vaLow:    Number(vaLow.toFixed(2)),
    hvn:      hvn.slice(0, 8),
    lvn:      lvn.slice(0, 6),
    bucketSize: Number(bucketSize.toFixed(2)),
    totalVolume: Math.round(totalVolume),
    totalUp:     Math.round(totalUp),
    totalDown:   Math.round(totalDown),
    totalDelta:  Math.round(totalDelta),
    deltaPct:    totalVolume > 0 ? Number(((totalDelta / totalVolume) * 100).toFixed(2)) : 0,
    upAreas:     upAreas.slice(0, 3),     // strongest buyer-control zones
    downAreas:   downAreas.slice(0, 3),   // strongest seller-control zones
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
// Delta analysis — cumulative delta + price vs delta absorption
// ───────────────────────────────────────────────────────────────────────────
//
// What this catches:
//   - Cumulative delta trend (CVD): is buying or selling pressure dominating
//     across recent bars?
//   - "Hidden buyers": price ↓ but delta ↑ → smart money absorbing supply,
//     bullish reversal warning.
//   - "Hidden sellers": price ↑ but delta ↓ → smart money distributing,
//     bearish reversal warning.
//   - Pace: how aggressive is the imbalance over the last few bars vs the
//     longer window.
//
// All deterministic, computed from the wick-weighted up/down split.
//
function _deltaAnalysis(candles, lookbackShort = 5, lookbackLong = 20) {
  const norm = (candles || []).map(_norm).filter(Boolean);
  if (norm.length < lookbackLong) return null;

  // Per-candle deltas
  const deltas = norm.map(c => {
    const split = _splitCandleVolume(c);
    return { delta: split.up - split.down, up: split.up, down: split.down, close: c.c };
  });

  const sum = (arr, key) => arr.reduce((a, b) => a + b[key], 0);

  const longTail  = deltas.slice(-lookbackLong);
  const shortTail = deltas.slice(-lookbackShort);

  const cvdLong  = sum(longTail, 'delta');
  const cvdShort = sum(shortTail, 'delta');
  const upLong   = sum(longTail, 'up');
  const downLong = sum(longTail, 'down');
  const totalLong = upLong + downLong;
  const cvdPctLong = totalLong > 0 ? (cvdLong / totalLong) * 100 : 0;

  // CVD trend — comparing two consecutive halves
  const half = Math.floor(longTail.length / 2);
  const firstHalfCvd = sum(longTail.slice(0, half), 'delta');
  const secondHalfCvd = sum(longTail.slice(half), 'delta');
  let trend = 'flat';
  if (secondHalfCvd > firstHalfCvd && cvdShort > 0) trend = 'rising';
  else if (secondHalfCvd < firstHalfCvd && cvdShort < 0) trend = 'falling';

  // Price vs Delta divergence (last short-window)
  const priceFirst = shortTail[0].close;
  const priceLast  = shortTail[shortTail.length - 1].close;
  const priceUp    = priceLast > priceFirst;
  const priceDown  = priceLast < priceFirst;
  const deltaUp    = cvdShort > 0;
  const deltaDown  = cvdShort < 0;

  let divergence = 'none';
  let divergenceBias = 'neutral';
  let divergenceReason = '';
  if (priceUp && deltaDown) {
    divergence = 'hidden_selling';
    divergenceBias = 'bearish';
    divergenceReason = 'price up but delta negative — sellers absorbing buyers';
  } else if (priceDown && deltaUp) {
    divergence = 'hidden_buying';
    divergenceBias = 'bullish';
    divergenceReason = 'price down but delta positive — buyers absorbing sellers';
  }

  // Bias from raw cumulative delta percentage
  let bias = 'neutral';
  let strength = 0;
  if (cvdPctLong >= 15)      { bias = 'bullish'; strength = Math.min(100, Math.round(cvdPctLong * 2)); }
  else if (cvdPctLong <= -15){ bias = 'bearish'; strength = Math.min(100, Math.round(Math.abs(cvdPctLong) * 2)); }
  else if (cvdPctLong >= 5)  { bias = 'mild_bullish'; strength = 40; }
  else if (cvdPctLong <= -5) { bias = 'mild_bearish'; strength = 40; }

  return {
    cvdLong:  Math.round(cvdLong),
    cvdShort: Math.round(cvdShort),
    cvdPctLong: Number(cvdPctLong.toFixed(2)),
    upLong:   Math.round(upLong),
    downLong: Math.round(downLong),
    trend,                     // rising | falling | flat
    bias,                      // bullish | mild_bullish | neutral | mild_bearish | bearish
    strength,                  // 0..100
    divergence,                // none | hidden_buying | hidden_selling
    divergenceBias,            // neutral | bullish | bearish
    divergenceReason,
    lookbackShort,
    lookbackLong,
  };
}

// Locate which UP/DOWN area contains a price.
function _zoneForPrice(frvp, spotPrice) {
  if (!frvp || !Number.isFinite(spotPrice)) return { zone: 'unknown', area: null };
  for (const a of frvp.upAreas || []) {
    if (spotPrice >= a.low && spotPrice <= a.high) return { zone: 'up_area', area: a };
  }
  for (const a of frvp.downAreas || []) {
    if (spotPrice >= a.low && spotPrice <= a.high) return { zone: 'down_area', area: a };
  }
  return { zone: 'neutral', area: null };
}

// ───────────────────────────────────────────────────────────────────────────
// Direction-aware scoring (0..100, 50 = neutral)
//
// Signal priority (per the institutional ranking):
//   1) Delta — net aggression (highest priority)
//   2) UP / DOWN control area for current price
//   3) FRVP acceptance (above/inside/below value area)
//   4) VSA pattern on the latest candle
//   5) Time-volume state (spike / climax / dry-up)
//   6) HVN proximity (support / resistance)
//   7) Price-vs-delta divergence (absorption / trap)
//
// Each rule contributes a bounded delta to the score; the final result is
// clamped to 0..100 with 50 = neutral.
// ───────────────────────────────────────────────────────────────────────────
function _scoreForDirection({ frvp, acceptance, nearest, timeVolume, vsa, delta, zone, spotPrice }, direction) {
  let s = 50;
  const reasons = [];

  // 1) DELTA — strongest signal. Scaled by absolute strength.
  if (delta) {
    const matches = (direction === 'bullish' && (delta.bias === 'bullish' || delta.bias === 'mild_bullish'))
                 || (direction === 'bearish' && (delta.bias === 'bearish' || delta.bias === 'mild_bearish'));
    const opposes = (direction === 'bullish' && (delta.bias === 'bearish' || delta.bias === 'mild_bearish'))
                 || (direction === 'bearish' && (delta.bias === 'bullish' || delta.bias === 'mild_bullish'));
    if (matches) {
      s += Math.min(20, Math.round(delta.strength / 5));
      reasons.push(`delta ${delta.bias} ${delta.cvdPctLong}% (${delta.trend})`);
    } else if (opposes) {
      s -= Math.min(25, Math.round(delta.strength / 4));
      reasons.push(`delta ${delta.bias} against direction`);
    }

    // 7) Hidden absorption / trap detection (price-vs-delta divergence)
    if (delta.divergence !== 'none') {
      if (delta.divergenceBias === direction) {
        s += 12;
        reasons.push(`absorption favours ${direction}: ${delta.divergenceReason}`);
      } else if (delta.divergenceBias !== 'neutral') {
        s -= 18;
        reasons.push(`trap risk: ${delta.divergenceReason}`);
      }
    }
  }

  // 2) UP / DOWN Areas — buyer / seller control zones
  if (zone?.zone === 'up_area' && direction === 'bullish') {
    s += 8; reasons.push(`in UP area (buyer control ${zone.area.low}–${zone.area.high})`);
  } else if (zone?.zone === 'up_area' && direction === 'bearish') {
    s -= 10; reasons.push(`fighting buyer control area ${zone.area.low}–${zone.area.high}`);
  } else if (zone?.zone === 'down_area' && direction === 'bearish') {
    s += 8; reasons.push(`in DOWN area (seller control ${zone.area.low}–${zone.area.high})`);
  } else if (zone?.zone === 'down_area' && direction === 'bullish') {
    s -= 10; reasons.push(`fighting seller control area ${zone.area.low}–${zone.area.high}`);
  }

  // 3) FRVP acceptance — context only (lighter weight than delta)
  if (direction === 'bullish') {
    if (acceptance === 'above_va') { s += 8; reasons.push('above value area'); }
    else if (acceptance === 'below_va') { s += 5; reasons.push('below VA — mean-reversion long'); }
  } else if (direction === 'bearish') {
    if (acceptance === 'below_va') { s += 8; reasons.push('below value area'); }
    else if (acceptance === 'above_va') { s += 5; reasons.push('above VA — mean-reversion short'); }
  }

  // POC magnetism
  if (frvp && Number.isFinite(spotPrice)) {
    const distFromPoc = spotPrice - frvp.pocPrice;
    if (Math.abs(distFromPoc) < frvp.bucketSize) {
      s -= 5; reasons.push('at POC — likely chop');
    } else if (direction === 'bullish' && distFromPoc > 0) {
      s += 3; reasons.push('above POC');
    } else if (direction === 'bearish' && distFromPoc < 0) {
      s += 3; reasons.push('below POC');
    }
    // Reward when the POC's own delta agrees with our direction
    if (frvp.pocDelta != null) {
      if (direction === 'bullish' && frvp.pocDelta > 0) { s += 4; reasons.push(`POC delta + (${frvp.pocDelta})`); }
      if (direction === 'bearish' && frvp.pocDelta < 0) { s += 4; reasons.push(`POC delta − (${frvp.pocDelta})`); }
    }
  }

  // 6) Nearby HVN — friendly S/R for the trade direction (smaller weight now)
  if (nearest?.support && direction === 'bullish' && nearest.distSupportPts != null && nearest.distSupportPts <= 30) {
    s += 6; reasons.push(`near HVN support ${nearest.support.price}`);
  }
  if (nearest?.resistance && direction === 'bearish' && nearest.distResistancePts != null && nearest.distResistancePts <= 30) {
    s += 6; reasons.push(`near HVN resistance ${nearest.resistance.price}`);
  }
  if (nearest?.resistance && direction === 'bullish' && nearest.distResistancePts != null && nearest.distResistancePts <= 15) {
    s -= 10; reasons.push(`HVN wall ${nearest.resistance.price} just above`);
  }
  if (nearest?.support && direction === 'bearish' && nearest.distSupportPts != null && nearest.distSupportPts <= 15) {
    s -= 10; reasons.push(`HVN floor ${nearest.support.price} just below`);
  }

  // 5) Time-volume confirmation
  if (timeVolume) {
    if (timeVolume.state === 'spike' || timeVolume.state === 'climax') {
      s += 5; reasons.push(`volume ${timeVolume.state} ${timeVolume.ratio}×`);
    } else if (timeVolume.state === 'dry_up') {
      s -= 6; reasons.push('volume dry-up');
    }
  }

  // 4) VSA
  if (vsa) {
    if (vsa.bias === direction) {
      s += Math.min(12, Math.round(vsa.strength / 7));
      reasons.push(`VSA ${vsa.pattern} (${vsa.bias})`);
    } else if (vsa.bias !== 'neutral') {
      s -= Math.min(18, Math.round(vsa.strength / 5));
      reasons.push(`VSA ${vsa.pattern} against direction`);
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
  // Delta analysis runs on the same candle stream; use 5m for responsiveness.
  const delta      = _deltaAnalysis(candles5m, 5, 20);
  // Which control zone (UP / DOWN / neutral) currently holds the price?
  const zone       = _zoneForPrice(frvp, spotPrice);

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
    delta,                // { cvdPctLong, bias, strength, trend, divergence, ... }
    zone,                 // { zone: 'up_area'|'down_area'|'neutral'|'unknown', area: { low, high, netDelta } | null }
    upAreas:   frvp.upAreas,    // exposed for downstream consumers
    downAreas: frvp.downAreas,
    totalDelta: frvp.totalDelta,
    deltaPct:   frvp.deltaPct,
  };

  if (direction === 'bullish' || direction === 'bearish') {
    const scored = _scoreForDirection({ frvp, acceptance, nearest, timeVolume, vsa, delta, zone, spotPrice }, direction);
    out.directionalScore = scored.score;
    out.directionalReasons = scored.reasons;
    out.reasoning = scored.reasons.join(' | ');
  } else {
    out.reasoning = [
      `acceptance=${acceptance}`,
      `zone=${zone.zone}`,
      delta ? `delta=${delta.bias} ${delta.cvdPctLong}% (${delta.trend})` : null,
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
    delta: volumeAnalysis.delta,
    zone: volumeAnalysis.zone,
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
