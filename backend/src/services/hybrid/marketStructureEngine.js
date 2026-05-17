/**
 * Market Structure Engine
 * -----------------------
 * Computes lightweight structural context that the rest of the hybrid engine
 * needs:
 *   - day high / low
 *   - prior day high / low (PDH / PDL)
 *   - swing pivots (last 2 swing-highs / lows)
 *   - prior session opening range high / low
 *   - distance of current price to each level (in points)
 *
 * We deliberately avoid duplicating SMC analysis here — the SMC service
 * already handles BOS/CHOCH/order-blocks/FVG. This engine focuses on the
 * basic levels every institutional trader watches.
 */

function _norm(c) {
  if (!c) return null;
  const o = c.o ?? c.open;
  const h = c.h ?? c.high;
  const l = c.l ?? c.low;
  const cl = c.c ?? c.close;
  if (![o, h, l, cl].every(Number.isFinite)) return null;
  return { o, h, l, c: cl };
}

function _swingPoints(candles, leftRight = 2) {
  // Classic fractal: bar i is a swing high if its high > all neighbours
  // within `leftRight` bars on each side.
  const norm = (candles || []).map(_norm).filter(Boolean);
  const highs = [], lows = [];
  for (let i = leftRight; i < norm.length - leftRight; i++) {
    const c = norm[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= leftRight; j++) {
      if (norm[i - j].h >= c.h || norm[i + j].h >= c.h) isHigh = false;
      if (norm[i - j].l <= c.l || norm[i + j].l <= c.l) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: c.h });
    if (isLow)  lows.push({ idx: i, price: c.l });
  }
  return {
    swingHighs: highs.slice(-3),    // keep last 3
    swingLows:  lows.slice(-3),
  };
}

/**
 * @param {Object} params
 * @param {number} params.spotPrice
 * @param {Array}  params.candles5m
 * @param {Array}  params.candles15m
 * @param {Object} [params.priorDay]    - { high, low, close }
 * @param {Object} [params.todayStats]  - { high, low, open } from session aggregator
 * @returns {Object}
 */
function analyze({
  spotPrice,
  candles5m = [],
  candles15m = [],
  priorDay = null,
  todayStats = null,
} = {}) {
  const norm5 = (candles5m || []).map(_norm).filter(Boolean);

  // ── Day H/L ───────────────────────────────────────────────────────────
  const dayHigh = todayStats?.high ?? (norm5.length ? Math.max(...norm5.map(c => c.h)) : null);
  const dayLow  = todayStats?.low  ?? (norm5.length ? Math.min(...norm5.map(c => c.l)) : null);

  // ── Opening range (first 30 minutes = first 6 × 5m bars) ─────────────
  const openingRangeBars = norm5.slice(0, 6);
  const orHigh = openingRangeBars.length ? Math.max(...openingRangeBars.map(c => c.h)) : null;
  const orLow  = openingRangeBars.length ? Math.min(...openingRangeBars.map(c => c.l)) : null;

  // ── Swing pivots (5m for short-term, 15m for HTF) ─────────────────────
  const swing5  = _swingPoints(candles5m, 2);
  const swing15 = _swingPoints(candles15m, 2);

  // ── Distances ─────────────────────────────────────────────────────────
  const dist = (level) => (level == null || spotPrice == null) ? null
    : Number((spotPrice - level).toFixed(2));

  return {
    spotPrice,
    dayHigh,
    dayLow,
    openingRange: { high: orHigh, low: orLow },
    priorDay: priorDay ? {
      high: priorDay.high ?? null,
      low:  priorDay.low  ?? null,
      close: priorDay.close ?? null,
    } : null,
    swingHighs5m:  swing5.swingHighs,
    swingLows5m:   swing5.swingLows,
    swingHighs15m: swing15.swingHighs,
    swingLows15m:  swing15.swingLows,
    distances: {
      toDayHigh:    dist(dayHigh),
      toDayLow:     dist(dayLow),
      toOrHigh:     dist(orHigh),
      toOrLow:      dist(orLow),
      toPdh:        dist(priorDay?.high),
      toPdl:        dist(priorDay?.low),
      toPriorClose: dist(priorDay?.close),
    },
  };
}

module.exports = { analyze };
