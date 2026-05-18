/**
 * Futures Leadership Engine
 * =========================
 * NIFTY futures lead spot by 200-500ms. They show institutional
 * positioning before the index reflects it. This engine reads:
 *
 *   - futures candles (1m / 5m) — already aggregated by
 *     `futuresCandleAggregator.service`
 *   - the live tick delta classifier on the futures security
 *   - basis (futures premium/discount over spot)
 *
 * And produces:
 *   - futuresDirection      : bullish | bearish | neutral
 *   - leadLagScore          : 0..100 (50 = synced, > 60 = futures leading bullish)
 *   - basisState            : expanding | contracting | flat
 *   - aggressiveFutCandle   : true if the latest 1m bar showed strong-body close
 *   - absorptionFut         : detected on futures bid/ask if microstructure data
 *   - deltaVelocity         : rolling acceleration of the futures-side delta
 *
 * The output feeds three places:
 *   1. The direction-resolution step in `hybridEntryEngine.decide` (futures
 *      lead becomes a tie-breaker for direction)
 *   2. The confidence engine's futures pillar (currently weighted 4)
 *   3. Specific playbooks (DELTA_VELOCITY_BREAKOUT, INITIATIVE_MOMENTUM_EXPANSION)
 *      use leadLagScore + aggressiveFutCandle for confirmation
 *
 * Pure deterministic. No AI.
 */

const tickDeltaClassifier = require('./tickDeltaClassifier');

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

function _candleDirection(candle) {
  if (!candle) return 'flat';
  const o = candle.o ?? candle.open;
  const c = candle.c ?? candle.close;
  if (!Number.isFinite(o) || !Number.isFinite(c)) return 'flat';
  const range = (candle.h ?? candle.high) - (candle.l ?? candle.low);
  const body = Math.abs(c - o);
  if (range <= 0) return 'flat';
  if (body / range < 0.20) return 'flat';     // doji
  return c > o ? 'up' : 'down';
}

/**
 * Compare directional moves of futures vs spot over the last N bars.
 * Returns 0..100 where 50 = synced, >60 = futures leading bullish, <40 = leading bearish.
 */
function _leadLagScore(futCandles, spotCandles, lookback = 5) {
  if (!Array.isArray(futCandles) || !Array.isArray(spotCandles)) return 50;
  if (futCandles.length < lookback || spotCandles.length < lookback) return 50;

  const fut = futCandles.slice(-lookback);
  const spot = spotCandles.slice(-lookback);
  let leadCount = 0;
  let followingCount = 0;
  let alignedBars = 0;

  for (let i = 0; i < fut.length; i++) {
    const fDir = _candleDirection(fut[i]);
    const sDir = _candleDirection(spot[i]);
    if (fDir !== 'flat' && sDir !== 'flat' && fDir === sDir) alignedBars++;

    // Lead detection: when fut moved more aggressively than spot in same dir
    if (i > 0 && fDir !== 'flat') {
      const fO = fut[i].o ?? fut[i].open, fC = fut[i].c ?? fut[i].close;
      const sO = spot[i].o ?? spot[i].open, sC = spot[i].c ?? spot[i].close;
      const fPct = ((fC - fO) / Math.max(1, fO)) * 100;
      const sPct = ((sC - sO) / Math.max(1, sO)) * 100;
      if (Math.abs(fPct) > Math.abs(sPct) * 1.15 && fDir === sDir) leadCount++;
      else if (Math.abs(sPct) > Math.abs(fPct) * 1.15 && fDir === sDir) followingCount++;
    }
  }

  // Net lead direction
  const lastFut = _candleDirection(fut[fut.length - 1]);
  let score = 50;
  if (leadCount > followingCount) {
    if (lastFut === 'up') score = 50 + Math.min(40, leadCount * 8);
    else if (lastFut === 'down') score = 50 - Math.min(40, leadCount * 8);
  } else if (followingCount > leadCount) {
    score = 50;        // futures lagging → no lead signal
  }
  // Alignment quality bonus
  if (alignedBars >= lookback - 1) {
    if (lastFut === 'up') score = Math.max(score, 60);
    else if (lastFut === 'down') score = Math.min(score, 40);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Compute the futures premium (basis) and its trend.
 * Positive basis = futures > spot (bullish positioning); contracting basis =
 * futures losing premium = bearish signal.
 */
function _basis({ futuresLtp, spotLtp, futuresHistory = [] }) {
  if (!Number.isFinite(futuresLtp) || !Number.isFinite(spotLtp)) {
    return { basis: null, basisPct: null, trend: 'unknown' };
  }
  const basis = futuresLtp - spotLtp;
  const basisPct = (basis / Math.max(1, spotLtp)) * 100;

  let trend = 'flat';
  if (Array.isArray(futuresHistory) && futuresHistory.length >= 4) {
    const olderHalf = futuresHistory.slice(0, Math.floor(futuresHistory.length / 2));
    const newerHalf = futuresHistory.slice(Math.floor(futuresHistory.length / 2));
    const olderAvg = olderHalf.reduce((a, x) => a + _safe(x.basis), 0) / Math.max(1, olderHalf.length);
    const newerAvg = newerHalf.reduce((a, x) => a + _safe(x.basis), 0) / Math.max(1, newerHalf.length);
    const delta = newerAvg - olderAvg;
    if (delta > 0.5) trend = 'expanding';
    else if (delta < -0.5) trend = 'contracting';
  }
  return {
    basis: Number(basis.toFixed(2)),
    basisPct: Number(basisPct.toFixed(4)),
    trend,
  };
}

/**
 * Detect aggressive futures candle: large body, in our direction, with
 * volume support. Used by playbooks for institutional confirmation.
 */
function _aggressiveCandle(futCandles) {
  if (!Array.isArray(futCandles) || futCandles.length < 6) return { detected: false };
  const last = futCandles[futCandles.length - 1];
  const prev = futCandles.slice(-6, -1);
  const o = last.o ?? last.open, c = last.c ?? last.close;
  const h = last.h ?? last.high, l = last.l ?? last.low;
  if (![o, c, h, l].every(Number.isFinite)) return { detected: false };
  const body = Math.abs(c - o);
  const range = h - l;
  if (range <= 0) return { detected: false };
  const bodyPct = body / range;
  const avgRange = prev.reduce((a, x) => a + ((x.h ?? x.high) - (x.l ?? x.low)), 0) / Math.max(1, prev.length);
  const expansionRatio = avgRange > 0 ? range / avgRange : 1;
  const direction = c > o ? 'up' : c < o ? 'down' : 'flat';
  const detected = bodyPct >= 0.55 && expansionRatio >= 1.2 && direction !== 'flat';
  return {
    detected,
    direction,
    bodyPct: Number(bodyPct.toFixed(2)),
    expansionRatio: Number(expansionRatio.toFixed(2)),
  };
}

/**
 * Read live futures-side delta velocity from the tick classifier.
 * If futures security id is unknown we return null (futures candle deltas
 * are still available via the `_candleDirection` path above).
 */
function _futuresDelta({ futuresSecurityId }) {
  if (!futuresSecurityId) return null;
  try {
    const cls = tickDeltaClassifier.instance;
    if (!cls?.started) return null;
    const long  = cls.getDelta('NSE_FNO', futuresSecurityId, { windowMs: 180_000 });
    const short = cls.getDelta('NSE_FNO', futuresSecurityId, { windowMs: 60_000 });
    if (!long || (long.sampleSize || 0) < 20) return null;
    const longPct = Number(long.deltaPct) || 0;
    const shortPct = (Number(short?.total) > 0)
      ? (Number(short.delta) / Number(short.total)) * 100 : longPct;
    let trend = 'flat';
    if (shortPct > longPct + 5) trend = 'rising';
    else if (shortPct < longPct - 5) trend = 'falling';
    return {
      cvdPctLong: Number(longPct.toFixed(2)),
      cvdPctShort: Number(shortPct.toFixed(2)),
      delta: long.delta,
      total: long.total,
      sampleSize: long.sampleSize,
      trend,
    };
  } catch (_) { return null; }
}

/**
 * @param {Object} args
 * @param {Object} args.futuresData     - existing futuresService output (direction, momentum, ltp)
 * @param {Array}  args.futuresCandles1m
 * @param {Array}  args.futuresCandles5m
 * @param {Array}  args.candles5m       - spot candles for lead-lag
 * @param {Array}  args.candles1m
 * @param {number} args.spotPrice
 * @param {number|string} [args.futuresSecurityId]
 * @param {Array}  [args.futuresHistory] - rolling { basis } samples for trend
 * @param {string} [args.direction]
 */
function analyze({
  futuresData = null,
  futuresCandles1m = [],
  futuresCandles5m = [],
  candles1m = [],
  candles5m = [],
  spotPrice = null,
  futuresSecurityId = null,
  futuresHistory = [],
  direction = null,
} = {}) {
  // No futures data path — return a sane null state
  const futLtp = Number(futuresData?.ltp);
  if (!Number.isFinite(futLtp) && futuresCandles1m.length === 0) {
    return {
      available: false,
      direction: 'neutral',
      leadLagScore: 50,
      reasoning: 'no futures data',
    };
  }

  const lead = _leadLagScore(futuresCandles1m, candles1m, 5);
  const lead5 = _leadLagScore(futuresCandles5m, candles5m, 5);
  const aggressive = _aggressiveCandle(futuresCandles1m);
  const basisInfo = _basis({ futuresLtp: futLtp, spotLtp: spotPrice, futuresHistory });
  const futDelta = _futuresDelta({ futuresSecurityId });

  // Direction synthesis: prefer existing futuresData.direction, else derive
  let futDir = futuresData?.direction || futuresData?.futures_direction || 'neutral';
  if (futDir === 'up') futDir = 'bullish';
  if (futDir === 'down') futDir = 'bearish';
  if (futDir === 'neutral' && lead > 60) futDir = 'bullish';
  else if (futDir === 'neutral' && lead < 40) futDir = 'bearish';
  // Strong basis confirms
  if (futDir === 'neutral' && basisInfo.trend === 'expanding' && basisInfo.basis > 0) futDir = 'bullish';
  if (futDir === 'neutral' && basisInfo.trend === 'contracting' && basisInfo.basis < 0) futDir = 'bearish';

  // Score aggregation
  const reasons = [];
  let score = 50;
  if (direction === 'bullish' || direction === 'bearish') {
    const matches = futDir === direction;
    const opposes = futDir !== 'neutral' && futDir !== direction;
    if (matches) {
      score = 60;
      reasons.push(`futures ${futDir} aligned`);
      // Lead-lag bonus
      if ((direction === 'bullish' && lead > 60) || (direction === 'bearish' && lead < 40)) {
        score += Math.min(15, Math.abs(lead - 50) / 2);
        reasons.push(`futures leading (${lead})`);
      }
      // Aggressive candle bonus
      if (aggressive.detected
          && ((direction === 'bullish' && aggressive.direction === 'up')
           || (direction === 'bearish' && aggressive.direction === 'down'))) {
        score += 8;
        reasons.push(`aggressive fut candle (body ${aggressive.bodyPct})`);
      }
      // Delta velocity bonus
      if (futDelta) {
        if (direction === 'bullish' && futDelta.cvdPctLong > 5 && futDelta.trend === 'rising') {
          score += 6; reasons.push(`fut delta rising +${futDelta.cvdPctLong}%`);
        }
        if (direction === 'bearish' && futDelta.cvdPctLong < -5 && futDelta.trend === 'falling') {
          score += 6; reasons.push(`fut delta falling ${futDelta.cvdPctLong}%`);
        }
      }
      // Basis bonus
      if (direction === 'bullish' && basisInfo.trend === 'expanding') {
        score += 4; reasons.push(`basis expanding`);
      }
      if (direction === 'bearish' && basisInfo.trend === 'contracting') {
        score += 4; reasons.push(`basis contracting`);
      }
    } else if (opposes) {
      score = 30;
      reasons.push(`futures ${futDir} against direction`);
      if ((direction === 'bullish' && lead < 35) || (direction === 'bearish' && lead > 65)) {
        score -= 10; reasons.push(`futures leading opposite`);
      }
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    available: true,
    futuresDirection: futDir,
    leadLagScore: lead,
    leadLagScore5m: lead5,
    aggressiveCandle: aggressive,
    basis: basisInfo,
    delta: futDelta,
    score,
    reasoning: reasons.length ? reasons.join(' | ') : 'no clear futures signal',
  };
}

module.exports = { analyze };
