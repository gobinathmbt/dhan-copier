/**
 * Trap Detection Engine
 * =====================
 * Catches the institutional setups where retail tends to get trapped.
 * Each detector returns a score 0..100 (higher = more likely a trap) and a
 * reason. The combined output is used by the entry engine to either:
 *   - block a trade outright (composite score ≥ blockThreshold)
 *   - downgrade confidence (score in mid-range)
 *
 * Detectors:
 *   1. Breakout into HVN — price breaks out into a high-volume node = ceiling
 *   2. Weak-delta breakout — price expands but tape delta is flat/against
 *   3. High candle / low volume — emotional move, no participation
 *   4. Failed VWAP / AVWAP hold — price reclaims then loses key level
 *   5. Sweep without reclaim — liquidity hunt that didn't reverse
 *   6. Approaching opposing HVN — trade direction blocked by big level
 *   7. Negative price/delta divergence pre-entry — distribution forming
 *
 * No AI. Pure deterministic checks.
 */

function _safeNum(n, fb = 0) { const x = Number(n); return Number.isFinite(x) ? x : fb; }

// 1. Breakout direction's path collides with a strong HVN
function _detectBreakoutIntoHvn({ spotPrice, direction, volumeAnalysis, multiDayContext }) {
  const reasons = [];
  let score = 0;

  // Check intraday HVN ahead
  const intra = volumeAnalysis?.frvp?.hvn || [];
  for (const n of intra.slice(0, 4)) {
    const dist = direction === 'bullish' ? n.price - spotPrice : spotPrice - n.price;
    if (dist > 0 && dist < 25) { score += 40; reasons.push(`intraday HVN ${n.price} just ahead (${dist.toFixed(1)}pts)`); break; }
    if (dist > 0 && dist < 50) { score += 20; reasons.push(`intraday HVN ${n.price} ahead (${dist.toFixed(1)}pts)`); break; }
  }

  // Check composite HVN ahead
  const comp = multiDayContext?.compositeProfile?.hvn || [];
  for (const n of comp.slice(0, 4)) {
    const dist = direction === 'bullish' ? n.price - spotPrice : spotPrice - n.price;
    if (dist > 0 && dist < 25) { score += 35; reasons.push(`composite HVN ${n.price} just ahead`); break; }
    if (dist > 0 && dist < 50) { score += 15; reasons.push(`composite HVN ${n.price} ahead`); break; }
  }
  return { score: Math.min(100, score), reasons };
}

// 2. Big move on weak delta (price up but delta flat/negative for bullish)
function _detectWeakDeltaBreakout({ direction, volumeAnalysis }) {
  const reasons = [];
  if (!volumeAnalysis?.delta || !volumeAnalysis?.vsa) return { score: 0, reasons };

  const cvdPct = _safeNum(volumeAnalysis.delta.cvdPctLong, 0);
  const vsa = volumeAnalysis.vsa;

  // VSA already has 'no_demand' / 'no_supply' patterns — these ARE this signal
  if (vsa.pattern === 'no_demand' && direction === 'bullish') {
    return { score: 80, reasons: ['VSA no_demand on bullish — fake breakout'] };
  }
  if (vsa.pattern === 'no_supply' && direction === 'bearish') {
    return { score: 80, reasons: ['VSA no_supply on bearish — fake breakdown'] };
  }
  // Big candle but tape delta is opposing
  if (vsa.pattern === 'momentum') {
    if (direction === 'bullish' && cvdPct < 5)  { return { score: 55, reasons: [`bullish momentum candle but CVD only ${cvdPct}%`] }; }
    if (direction === 'bearish' && cvdPct > -5) { return { score: 55, reasons: [`bearish momentum candle but CVD only ${cvdPct}%`] }; }
  }
  return { score: 0, reasons };
}

// 3. Big candle, no real volume backing
function _detectHighCandleLowVolume({ volumeAnalysis }) {
  if (!volumeAnalysis?.vsa) return { score: 0, reasons: [] };
  const v = volumeAnalysis.vsa;
  // rangeRatio big, volRatio small
  if (v.rangeRatio >= 1.4 && v.volRatio < 0.8) {
    return { score: 70, reasons: [`big candle (${v.rangeRatio}×) on weak vol (${v.volRatio}×)`] };
  }
  if (v.rangeRatio >= 1.2 && v.volRatio < 0.7) {
    return { score: 50, reasons: [`elevated candle on weak vol`] };
  }
  return { score: 0, reasons: [] };
}

// 4. Failed VWAP / AVWAP hold — price reclaimed then lost
function _detectFailedVwapHold({ direction, vwap, multiTimeframe }) {
  if (!vwap) return { score: 0, reasons: [] };
  const pos = vwap.position || vwap.price_vs_vwap;
  if (!pos || pos === 'unknown') return { score: 0, reasons: [] };

  // If trying to go long but price is below VWAP and 5m/15m disagree → trap risk
  if (direction === 'bullish' && pos === 'below' && multiTimeframe?.timeframes?.['5m']?.trend === 'bullish') {
    return { score: 40, reasons: ['bullish entry below VWAP — failed reclaim risk'] };
  }
  if (direction === 'bearish' && pos === 'above' && multiTimeframe?.timeframes?.['5m']?.trend === 'bearish') {
    return { score: 40, reasons: ['bearish entry above VWAP — failed rejection risk'] };
  }
  return { score: 0, reasons: [] };
}

// 5. Sweep then no reclaim — direction's "stop hunt" hasn't reversed
function _detectSweepWithoutReclaim({ direction, todayStats, spotPrice, sessionMemory }) {
  if (!sessionMemory) return { score: 0, reasons: [] };

  // Bullish entry but multiple sweeps below low without reclaim
  if (direction === 'bullish' && (sessionMemory.sweepsBelowLow || 0) >= 2 &&
      todayStats?.dayLow && spotPrice < todayStats.dayLow * 1.001) {
    return { score: 50, reasons: [`${sessionMemory.sweepsBelowLow} sweeps below low without reclaim`] };
  }
  if (direction === 'bearish' && (sessionMemory.sweepsAboveHigh || 0) >= 2 &&
      todayStats?.dayHigh && spotPrice > todayStats.dayHigh * 0.999) {
    return { score: 50, reasons: [`${sessionMemory.sweepsAboveHigh} sweeps above high without reclaim`] };
  }
  return { score: 0, reasons: [] };
}

// 6. Big OI wall sitting against the trade direction
function _detectOiWall({ direction, oiAnalytics }) {
  if (!oiAnalytics?.concentration) return { score: 0, reasons: [] };
  const c = oiAnalytics.concentration;
  const reasons = [];
  let score = 0;
  // Bullish: heavy CE peak just above current ATM = institutional resistance
  if (direction === 'bullish' && c.ceTopStrike && c.ce > 0.18) {
    score = 45;
    reasons.push(`heavy CE peak at ${c.ceTopStrike} (concentration ${c.ce})`);
  }
  if (direction === 'bearish' && c.peTopStrike && c.pe > 0.18) {
    score = 45;
    reasons.push(`heavy PE peak at ${c.peTopStrike} (concentration ${c.pe})`);
  }
  return { score, reasons };
}

// 7. Pre-entry distribution — price up but delta flat → hidden selling
function _detectHiddenAbsorption({ direction, volumeAnalysis }) {
  if (!volumeAnalysis?.delta || volumeAnalysis.delta.divergence === 'none') {
    return { score: 0, reasons: [] };
  }
  const d = volumeAnalysis.delta;
  if (d.divergenceBias && d.divergenceBias !== 'neutral' && d.divergenceBias !== direction) {
    return { score: 60, reasons: [`hidden absorption against ${direction}: ${d.divergenceReason}`] };
  }
  return { score: 0, reasons: [] };
}

// 8. Repeated failed breakouts/breakdowns earlier in the session
function _detectRepeatedFailure({ direction, sessionMemory }) {
  if (!sessionMemory) return { score: 0, reasons: [] };
  if (direction === 'bullish' && (sessionMemory.failedBreakouts || 0) >= 2) {
    return { score: 35, reasons: [`${sessionMemory.failedBreakouts} failed breakouts already today`] };
  }
  if (direction === 'bearish' && (sessionMemory.failedBreakdowns || 0) >= 2) {
    return { score: 35, reasons: [`${sessionMemory.failedBreakdowns} failed breakdowns already today`] };
  }
  return { score: 0, reasons: [] };
}

/**
 * @param {Object} ctx  - all the inputs the detectors need
 * @param {number} [blockThreshold=70] - composite score above this → block trade
 * @returns {Object} { trapScore, blocked, breakdown, reasons }
 */
function evaluate(ctx = {}, opts = {}) {
  // Calibrated thresholds:
  //   ≥ 90  → hard block (institutional fakes)
  //   75-89 → size cut + tighten + score penalty (don't block)
  //   ≥ 30  → score penalty only
  const blockThreshold = Number(opts.blockThreshold ?? 90);   // was 70 — too tight
  const detectors = {
    breakoutIntoHvn:    _detectBreakoutIntoHvn(ctx),
    weakDeltaBreakout:  _detectWeakDeltaBreakout(ctx),
    highCandleLowVol:   _detectHighCandleLowVolume(ctx),
    failedVwapHold:     _detectFailedVwapHold(ctx),
    sweepWithoutReclaim:_detectSweepWithoutReclaim(ctx),
    oiWall:             _detectOiWall(ctx),
    hiddenAbsorption:   _detectHiddenAbsorption(ctx),
    repeatedFailure:    _detectRepeatedFailure(ctx),
  };

  // Composite — take the max single trap score plus 25% of the rest
  const scores = Object.values(detectors).map(d => d.score || 0);
  const maxScore = Math.max(0, ...scores);
  const restSum = scores.reduce((a, b) => a + b, 0) - maxScore;
  const composite = Math.min(100, Math.round(maxScore + restSum * 0.25));

  const allReasons = [];
  for (const [k, v] of Object.entries(detectors)) {
    if (v.score >= 30) allReasons.push(`[${k}:${v.score}] ${(v.reasons || []).join(', ')}`);
  }

  return {
    trapScore: composite,
    blocked: composite >= blockThreshold,
    sizeReduce: composite >= 75 ? 0.5 : (composite >= 50 ? 0.7 : 1.0),
    breakdown: detectors,
    reasoning: allReasons.length ? allReasons.join(' | ') : 'no traps detected',
  };
}

module.exports = { evaluate };
