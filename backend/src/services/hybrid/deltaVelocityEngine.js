/**
 * Delta Velocity Engine
 * =====================
 * Specialised reading of how fast and how aggressively delta is changing.
 * The existing `volumeAnalysisEngine` gives you the cumulative state
 * (CVD, bias, divergence). This engine gives you the DERIVATIVE — the
 * rate-of-change.
 *
 * Why separate? Velocity / acceleration spikes are a leading indicator:
 *   - "delta acceleration" precedes price expansion by a few bars
 *   - "delta exhaustion" (velocity dropping while price keeps rising) marks
 *      the end of a thrust
 *   - "delta flip" after a stall is the cleanest scalp entry trigger
 *
 * Inputs:
 *   - candles5m (recent 30+ bars)
 *   - liveTickDelta from `tickDeltaClassifier` (optional)
 *
 * Outputs:
 *   {
 *     velocityState  : 'accelerating_up' | 'accelerating_down' |
 *                       'decelerating' | 'flat' | 'flipping_up' |
 *                       'flipping_down'
 *     velocityScore  : 0..100 directional
 *     velocity       : rolling delta per minute (signed)
 *     acceleration   : derivative of velocity
 *     flipDetected   : null | 'up' | 'down'
 *     exhaustionDetected: boolean
 *     reasoning
 *   }
 *
 * Pure deterministic. No AI.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }
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

// Wick-weighted delta per candle (same proxy as volumeAnalysisEngine)
function _candleDelta(c) {
  const range = c.h - c.l;
  if (range <= 0) return 0;
  const upPortion = Math.max(0, Math.min(1, (c.c - c.l) / range));
  return c.v * (upPortion - (1 - upPortion));      // = v × (2*upPortion - 1)
}

/**
 * @param {Object} args
 * @param {Array}  args.candles5m
 * @param {Object} [args.liveTickDelta]   - { long, short } from tickDeltaClassifier
 * @param {string} [args.direction]
 */
function analyze({ candles5m = [], liveTickDelta = null, direction = null } = {}) {
  const norm = (candles5m || []).map(_norm).filter(Boolean);
  if (norm.length < 10) {
    return {
      available: false,
      velocityState: 'unknown',
      velocityScore: 50,
      reasoning: 'insufficient candles',
    };
  }

  // Compute per-candle deltas
  const deltas = norm.map(_candleDelta);
  // Velocity = mean delta over the latest 5 bars (≈ 25 minutes)
  const recent5 = deltas.slice(-5);
  const recent10 = deltas.slice(-10, -5);
  const velocityRecent = recent5.reduce((a, b) => a + b, 0) / 5;
  const velocityPrior  = recent10.length ? recent10.reduce((a, b) => a + b, 0) / recent10.length : 0;
  const acceleration   = velocityRecent - velocityPrior;

  // Live tick override — if available, use last 60s delta as instant velocity
  let liveVelocity = null;
  if (liveTickDelta?.short && liveTickDelta.short.sampleSize >= 20) {
    liveVelocity = Number(liveTickDelta.short.delta) || 0;
  }

  // Flip detection: prior 3 bars opposite sign to recent 3 bars
  const prior3 = deltas.slice(-6, -3);
  const new3 = deltas.slice(-3);
  const priorMean = prior3.reduce((a, b) => a + b, 0) / Math.max(1, prior3.length);
  const newMean = new3.reduce((a, b) => a + b, 0) / Math.max(1, new3.length);
  let flipDetected = null;
  if (priorMean < 0 && newMean > 0 && Math.abs(newMean) > Math.abs(priorMean) * 0.7) {
    flipDetected = 'up';
  } else if (priorMean > 0 && newMean < 0 && Math.abs(newMean) > Math.abs(priorMean) * 0.7) {
    flipDetected = 'down';
  }

  // Exhaustion: price rose strongly but delta velocity is dropping
  // (price up vs delta plateau / fall)
  const closes = norm.map(c => c.c);
  const priceRecent = closes[closes.length - 1] - closes[Math.max(0, closes.length - 6)];
  let exhaustionDetected = false;
  if (priceRecent > 5 && acceleration < 0 && velocityRecent < velocityPrior) {
    exhaustionDetected = true;
  } else if (priceRecent < -5 && acceleration > 0 && velocityRecent > velocityPrior) {
    exhaustionDetected = true;
  }

  // State classification
  let velocityState = 'flat';
  const reasons = [];
  if (flipDetected === 'up') {
    velocityState = 'flipping_up';
    reasons.push(`delta flipped to + (prior ${priorMean.toFixed(0)} → new ${newMean.toFixed(0)})`);
  } else if (flipDetected === 'down') {
    velocityState = 'flipping_down';
    reasons.push(`delta flipped to - (prior ${priorMean.toFixed(0)} → new ${newMean.toFixed(0)})`);
  } else if (acceleration > velocityPrior * 0.4 && velocityRecent > 0) {
    velocityState = 'accelerating_up';
    reasons.push(`accel +${acceleration.toFixed(0)} on +velocity`);
  } else if (acceleration < velocityPrior * 0.4 && velocityRecent < 0) {
    velocityState = 'accelerating_down';
    reasons.push(`accel ${acceleration.toFixed(0)} on -velocity`);
  } else if (Math.abs(acceleration) < Math.abs(velocityPrior) * 0.2) {
    velocityState = 'flat';
    reasons.push('velocity flat');
  } else {
    velocityState = 'decelerating';
    reasons.push(`decelerating (vel ${velocityRecent.toFixed(0)} accel ${acceleration.toFixed(0)})`);
  }

  if (exhaustionDetected) reasons.push('price/delta divergence — exhaustion');

  // Directional score
  let score = 50;
  if (direction === 'bullish' || direction === 'bearish') {
    if (velocityState === 'accelerating_up' && direction === 'bullish') score = 78;
    else if (velocityState === 'accelerating_down' && direction === 'bearish') score = 78;
    else if (velocityState === 'flipping_up' && direction === 'bullish') score = 70;
    else if (velocityState === 'flipping_down' && direction === 'bearish') score = 70;
    else if (velocityState === 'accelerating_up' && direction === 'bearish') score = 25;
    else if (velocityState === 'accelerating_down' && direction === 'bullish') score = 25;
    else if (velocityState === 'flat') score = 50;
    else if (velocityState === 'decelerating') score = 45;
    if (exhaustionDetected) {
      // Exhaustion favours the OPPOSITE direction (fade)
      if (direction === 'bearish' && priceRecent > 5) score = Math.max(score, 65);
      if (direction === 'bullish' && priceRecent < -5) score = Math.max(score, 65);
    }
  }

  return {
    available: true,
    velocityState,
    velocityScore: score,
    velocity:      Number(velocityRecent.toFixed(0)),
    velocityPrior: Number(velocityPrior.toFixed(0)),
    acceleration:  Number(acceleration.toFixed(0)),
    liveVelocity,
    flipDetected,
    exhaustionDetected,
    priceRecent: Number(priceRecent.toFixed(2)),
    reasoning: reasons.join(' | '),
  };
}

module.exports = { analyze };
