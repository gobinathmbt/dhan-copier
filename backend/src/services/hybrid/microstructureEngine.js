/**
 * Microstructure Engine
 * =====================
 * Reads the live order-book depth from the dhanLiveFeedProd tick stream
 * (5-level depth captured in `_parseFull`) and produces an institutional
 * microstructure signal that complements the existing OI / delta /
 * volume pillars.
 *
 * Live-feed snapshot shape (see `dhanLiveFeedProd.service.js::_parseFull`):
 *   {
 *     ltp, ltq, ltt, atp, volume,
 *     totalBuyQty, totalSellQty,
 *     depth: [{ bidPrice, bidQty, bidOrders, askPrice, askQty, askOrders }, ...x5]
 *   }
 *
 * What we extract per tick:
 *   - bid/ask imbalance ratio (top + 5-level)
 *   - rolling imbalance (60-90s window — smooths spoofing)
 *   - imbalance velocity / acceleration
 *   - absorption: large bid stays + price flat + delta neg → bullish absorbing
 *   - iceberg: same price level keeps refilling (huge cumulative qty served)
 *   - spread state: tight / normal / wide / extreme (% of LTP)
 *   - liquidity pull: sudden disappearance of one side
 *   - spoofing: large order appears + cancels within < 1s repeatedly
 *
 * Aggregated read for the entry engine:
 *   {
 *     state: 'aggressive_buying' | 'aggressive_selling' | 'absorption_long' |
 *            'absorption_short' | 'iceberg_resistance' | 'iceberg_support' |
 *            'liquidity_pull_up' | 'liquidity_pull_down' | 'spoof_risk' |
 *            'balanced',
 *     bias, imbalance, imbalanceTrend,
 *     score:    0..100 directional,
 *     spread:   { abs, pct, status: 'tight'|'normal'|'wide'|'extreme' },
 *     absorption, iceberg, liquidityPull, spoof,
 *     reasoning,
 *   }
 *
 * Pure deterministic — no AI. Listens to tick events and keeps a small
 * per-instrument rolling buffer so analyse() is O(N) on a capped N.
 */

const logger = require('../../utils/logger');

// Per-instrument rolling state
const STATE = new Map();       // key = `${segment}:${securityId}`
const MAX_SAMPLES = 240;       // ~120s @ 2 samples/s — enough for 60-90s rolling
const SAMPLE_TTL_MS = 5 * 60 * 1000;

let started = false;
let feedHandler = null;
let feedRef = null;

function _key(seg, sid) { return `${seg}:${sid}`; }
function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

function _ensureState(seg, sid) {
  const k = _key(seg, sid);
  let s = STATE.get(k);
  if (!s) {
    s = {
      samples: [],            // [{ t, ltp, bid, ask, bidQty, askQty, bid5, ask5, totalBuy, totalSell }]
      pulls:   { upTs: 0, dnTs: 0 },
      icebergCounters: new Map(), // price → { hits, lastQty }
      lastTouchedAt: Date.now(),
    };
    STATE.set(k, s);
  }
  s.lastTouchedAt = Date.now();
  return s;
}

function _evictStale() {
  const now = Date.now();
  for (const [k, v] of STATE.entries()) {
    if (now - v.lastTouchedAt > SAMPLE_TTL_MS) STATE.delete(k);
  }
}

function _onTick(evt) {
  if (!evt?.next) return;
  const next = evt.next;
  const depth = Array.isArray(next.depth) ? next.depth : null;
  if (!depth || depth.length === 0) return;       // need full-mode feed
  const top = depth[0];
  if (!top || !Number.isFinite(top.bidPrice) || !Number.isFinite(top.askPrice)) return;

  const s = _ensureState(evt.segment, evt.securityId);

  // 5-level aggregate
  let bid5Qty = 0, ask5Qty = 0;
  for (const lvl of depth) {
    if (Number.isFinite(lvl.bidQty)) bid5Qty += lvl.bidQty;
    if (Number.isFinite(lvl.askQty)) ask5Qty += lvl.askQty;
  }

  const sample = {
    t:       next.updatedAt || Date.now(),
    ltp:     Number(next.ltp) || null,
    bid:     Number(top.bidPrice) || null,
    ask:     Number(top.askPrice) || null,
    bidQty:  Number(top.bidQty) || 0,
    askQty:  Number(top.askQty) || 0,
    bid5Qty,
    ask5Qty,
    totalBuy:  Number(next.totalBuyQty) || 0,
    totalSell: Number(next.totalSellQty) || 0,
  };

  s.samples.push(sample);
  if (s.samples.length > MAX_SAMPLES) s.samples.splice(0, s.samples.length - MAX_SAMPLES);

  // Iceberg: detect when same price level keeps absorbing the same side
  // even though LTP doesn't move. We track the top bid AND top ask price
  // across consecutive samples; a "refill" is when qty stays roughly the
  // same despite trading volume going through.
  const prevSample = s.samples[s.samples.length - 2];
  if (prevSample) {
    if (prevSample.bid === sample.bid && Math.abs(prevSample.bidQty - sample.bidQty) < sample.bidQty * 0.25
        && prevSample.totalBuy < sample.totalBuy) {
      const c = s.icebergCounters.get(`bid:${sample.bid}`) || { hits: 0, lastQty: sample.bidQty };
      c.hits++; c.lastQty = sample.bidQty;
      s.icebergCounters.set(`bid:${sample.bid}`, c);
    }
    if (prevSample.ask === sample.ask && Math.abs(prevSample.askQty - sample.askQty) < sample.askQty * 0.25
        && prevSample.totalSell < sample.totalSell) {
      const c = s.icebergCounters.get(`ask:${sample.ask}`) || { hits: 0, lastQty: sample.askQty };
      c.hits++; c.lastQty = sample.askQty;
      s.icebergCounters.set(`ask:${sample.ask}`, c);
    }
    // Liquidity pull: huge qty present last tick → near-zero this tick
    if (prevSample.bidQty > 0 && sample.bidQty / Math.max(1, prevSample.bidQty) < 0.20
        && prevSample.bidQty > sample.askQty * 1.5) {
      s.pulls.dnTs = sample.t;     // bids vanished → likely move down
    }
    if (prevSample.askQty > 0 && sample.askQty / Math.max(1, prevSample.askQty) < 0.20
        && prevSample.askQty > sample.bidQty * 1.5) {
      s.pulls.upTs = sample.t;     // asks vanished → likely move up
    }
  }

  // Cap iceberg counters Map size
  if (s.icebergCounters.size > 50) {
    const sorted = [...s.icebergCounters.entries()].sort((a, b) => b[1].hits - a[1].hits);
    s.icebergCounters = new Map(sorted.slice(0, 30));
  }
}

/**
 * Begin listening to the live feed. Idempotent.
 */
function start(feedSingleton = null) {
  if (started) return;
  if (!feedSingleton) {
    try {
      const { instance } = require('../dhanLiveFeedProd.service');
      feedSingleton = instance;
    } catch (e) {
      logger.warn({ err: e.message }, '[microstructure] could not load live feed');
      return;
    }
  }
  if (!feedSingleton || typeof feedSingleton.on !== 'function') {
    logger.warn('[microstructure] feed has no event support');
    return;
  }
  feedRef = feedSingleton;
  feedHandler = (evt) => {
    try { _onTick(evt); }
    catch (e) { logger.warn({ err: e.message }, '[microstructure] tick handler threw'); }
  };
  feedRef.on('tick', feedHandler);
  started = true;
  logger.info('[microstructure] engine started');
}

function stop() {
  if (!started) return;
  if (feedRef && feedHandler) {
    try { feedRef.off('tick', feedHandler); } catch (_) {}
  }
  feedRef = null;
  feedHandler = null;
  started = false;
}

function reset() { STATE.clear(); }

/**
 * Compute the microstructure read for an instrument.
 *
 * @param {Object} args
 * @param {string} args.segment        - 'IDX_I' for spot NIFTY, 'NSE_FNO' for futures
 * @param {number|string} args.securityId
 * @param {string} [args.direction]    - 'bullish'|'bearish' for directional score
 * @param {number} [args.windowMs=60000] - rolling window for imbalance trend
 */
function analyze({ segment = 'IDX_I', securityId = 13, direction = null, windowMs = 60_000 } = {}) {
  _evictStale();
  const s = STATE.get(_key(segment, securityId));
  if (!s || s.samples.length < 8) {
    return {
      available: false,
      state: 'unknown',
      bias: 'neutral',
      reasoning: 'insufficient depth samples',
    };
  }

  const cutoff = Date.now() - windowMs;
  const window = s.samples.filter(x => x.t >= cutoff);
  if (window.length < 6) {
    return {
      available: false,
      state: 'unknown',
      bias: 'neutral',
      reasoning: `only ${window.length} samples in last ${windowMs}ms`,
    };
  }

  const last = window[window.length - 1];
  const first = window[0];
  const half = Math.floor(window.length / 2);
  const olderHalf = window.slice(0, half);
  const newerHalf = window.slice(half);

  // 1. Top-of-book imbalance: (bidQty - askQty) / (bidQty + askQty)
  const topImbalance = (last.bidQty - last.askQty) / Math.max(1, last.bidQty + last.askQty);
  // 2. 5-level aggregate imbalance
  const deepImbalance = (last.bid5Qty - last.ask5Qty) / Math.max(1, last.bid5Qty + last.ask5Qty);
  // 3. Smoothed rolling imbalance (mean across window) — robust to spoofing
  const sumWindow = window.reduce((acc, x) => {
    acc.b += x.bidQty; acc.a += x.askQty;
    acc.b5 += x.bid5Qty; acc.a5 += x.ask5Qty;
    return acc;
  }, { b: 0, a: 0, b5: 0, a5: 0 });
  const rollingImb = (sumWindow.b - sumWindow.a) / Math.max(1, sumWindow.b + sumWindow.a);
  const rollingDeepImb = (sumWindow.b5 - sumWindow.a5) / Math.max(1, sumWindow.b5 + sumWindow.a5);

  // 4. Imbalance velocity (newer half vs older half)
  const olderImb = olderHalf.reduce((sum, x) => sum + (x.bidQty - x.askQty) / Math.max(1, x.bidQty + x.askQty), 0) / Math.max(1, olderHalf.length);
  const newerImb = newerHalf.reduce((sum, x) => sum + (x.bidQty - x.askQty) / Math.max(1, x.bidQty + x.askQty), 0) / Math.max(1, newerHalf.length);
  const imbVelocity = newerImb - olderImb;             // [-2, +2]

  // 5. Imbalance acceleration: trend of velocity (cubic — positive trend amplifies)
  let imbAccel = 0;
  if (window.length >= 12) {
    const q1 = window.slice(0, Math.floor(window.length / 4));
    const q4 = window.slice(-Math.floor(window.length / 4));
    const q1Imb = q1.reduce((sum, x) => sum + (x.bidQty - x.askQty) / Math.max(1, x.bidQty + x.askQty), 0) / Math.max(1, q1.length);
    const q4Imb = q4.reduce((sum, x) => sum + (x.bidQty - x.askQty) / Math.max(1, x.bidQty + x.askQty), 0) / Math.max(1, q4.length);
    imbAccel = q4Imb - q1Imb;
  }

  // 6. Spread state
  const spreadAbs = last.ask - last.bid;
  const spreadPct = last.ltp > 0 ? (spreadAbs / last.ltp) * 100 : 0;
  let spreadStatus = 'unknown';
  // For NIFTY index, spread is typically 0 (it's a level, not a tradable instrument)
  // For futures: ~0.05pts is tight, 0.50pts is wide
  if (spreadPct === 0)        spreadStatus = 'tight';
  else if (spreadPct < 0.005) spreadStatus = 'tight';
  else if (spreadPct < 0.02)  spreadStatus = 'normal';
  else if (spreadPct < 0.05)  spreadStatus = 'wide';
  else                        spreadStatus = 'extreme';

  // 7. Absorption detection
  // Absorption (bullish) = price flat or down + bid quantity stays large
  // (refilling) + delta proxy negative (totalSellQty rising vs totalBuyQty)
  const priceΔ = last.ltp - first.ltp;
  const totalBuyΔ = last.totalBuy - first.totalBuy;
  const totalSellΔ = last.totalSell - first.totalSell;
  const aggressivePressure = totalSellΔ - totalBuyΔ;
  const flatOrDown = priceΔ <= 1.5;
  const flatOrUp = priceΔ >= -1.5;

  let absorption = { detected: false, side: null, reason: '' };
  if (flatOrDown && rollingImb > 0.18 && aggressivePressure > 0) {
    absorption = {
      detected: true, side: 'bullish',
      reason: `bid book heavy (${(rollingImb * 100).toFixed(0)}%) + sells absorbing (Δ ${aggressivePressure}) + price flat ${priceΔ.toFixed(1)}`,
    };
  } else if (flatOrUp && rollingImb < -0.18 && aggressivePressure < 0) {
    absorption = {
      detected: true, side: 'bearish',
      reason: `ask book heavy (${(rollingImb * 100).toFixed(0)}%) + buys absorbing (Δ ${-aggressivePressure}) + price flat ${priceΔ.toFixed(1)}`,
    };
  }

  // 8. Iceberg detection
  let icebergSide = null, icebergPrice = null, icebergHits = 0;
  for (const [k, v] of s.icebergCounters.entries()) {
    if (v.hits >= 4 && v.hits > icebergHits) {
      icebergHits = v.hits;
      const [side, price] = k.split(':');
      icebergSide = side; icebergPrice = Number(price);
    }
  }
  const iceberg = icebergSide ? { side: icebergSide, price: icebergPrice, hits: icebergHits }
                              : { side: null, price: null, hits: 0 };

  // 9. Liquidity pull (recent — within last 10s)
  const tenSecAgo = Date.now() - 10_000;
  const liquidityPull = {
    up:   s.pulls.upTs > tenSecAgo,
    down: s.pulls.dnTs > tenSecAgo,
  };

  // 10. Spoofing — quick succession of large orders disappearing
  // We detect via large rolling imbalance variance vs final imbalance
  const imbValues = window.map(x => (x.bidQty - x.askQty) / Math.max(1, x.bidQty + x.askQty));
  const mean = imbValues.reduce((a, b) => a + b, 0) / imbValues.length;
  const variance = imbValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / imbValues.length;
  const stddev = Math.sqrt(variance);
  const spoofRisk = stddev > 0.35;

  // 11. State classification
  let state = 'balanced';
  let bias = 'neutral';
  const reasons = [];

  if (absorption.detected) {
    state = absorption.side === 'bullish' ? 'absorption_long' : 'absorption_short';
    bias = absorption.side;
    reasons.push(`absorption: ${absorption.reason}`);
  } else if (icebergSide === 'ask' && icebergHits >= 4) {
    // Iceberg seller — bearish (someone selling secretly)
    state = 'iceberg_resistance';
    bias = 'bearish';
    reasons.push(`iceberg ASK at ${icebergPrice} (${icebergHits} refills)`);
  } else if (icebergSide === 'bid' && icebergHits >= 4) {
    state = 'iceberg_support';
    bias = 'bullish';
    reasons.push(`iceberg BID at ${icebergPrice} (${icebergHits} refills)`);
  } else if (liquidityPull.up && rollingImb > 0.10) {
    state = 'liquidity_pull_up';
    bias = 'bullish';
    reasons.push('asks vanished + buyers stacked → upward pull');
  } else if (liquidityPull.down && rollingImb < -0.10) {
    state = 'liquidity_pull_down';
    bias = 'bearish';
    reasons.push('bids vanished + sellers stacked → downward pull');
  } else if (rollingImb > 0.25 && imbVelocity > 0.05) {
    state = 'aggressive_buying';
    bias = 'bullish';
    reasons.push(`rolling bid imbalance ${(rollingImb * 100).toFixed(0)}% + velocity ${imbVelocity.toFixed(2)}`);
  } else if (rollingImb < -0.25 && imbVelocity < -0.05) {
    state = 'aggressive_selling';
    bias = 'bearish';
    reasons.push(`rolling ask imbalance ${(rollingImb * 100).toFixed(0)}% + velocity ${imbVelocity.toFixed(2)}`);
  } else if (spoofRisk) {
    state = 'spoof_risk';
    bias = 'neutral';
    reasons.push(`high imbalance variance (σ=${stddev.toFixed(2)}) — possible spoofing`);
  } else if (Math.abs(rollingImb) > 0.12) {
    state = rollingImb > 0 ? 'mild_buying' : 'mild_selling';
    bias = rollingImb > 0 ? 'bullish' : 'bearish';
    reasons.push(`rolling imbalance ${(rollingImb * 100).toFixed(0)}%`);
  } else {
    state = 'balanced';
    reasons.push(`imbalance ${(rollingImb * 100).toFixed(0)}% within neutral band`);
  }

  // 12. Spread expansion (regime shift signal)
  if (spreadStatus === 'extreme') reasons.push(`spread extreme ${spreadPct.toFixed(3)}%`);
  else if (spreadStatus === 'wide') reasons.push(`spread wide ${spreadPct.toFixed(3)}%`);

  // 13. Directional score (0..100, 50=neutral)
  let score = 50;
  if (direction === 'bullish' || direction === 'bearish') {
    const matches = (direction === 'bullish' && bias === 'bullish')
                 || (direction === 'bearish' && bias === 'bearish');
    const opposes = (direction === 'bullish' && bias === 'bearish')
                 || (direction === 'bearish' && bias === 'bullish');
    if (matches) {
      // Base from rolling imbalance magnitude
      const mag = Math.abs(rollingImb);          // 0..1
      score = 55 + Math.min(35, Math.round(mag * 100 * 0.5));
      // Boost for confirmed setups
      if (state === 'absorption_long' || state === 'absorption_short') score += 8;
      if (state === 'iceberg_support' || state === 'iceberg_resistance') score += 6;
      if (state === 'liquidity_pull_up' || state === 'liquidity_pull_down') score += 6;
      if (state === 'aggressive_buying' || state === 'aggressive_selling') score += 4;
      // Acceleration boost
      if ((direction === 'bullish' && imbAccel > 0.05)
       || (direction === 'bearish' && imbAccel < -0.05)) {
        score += 4;
      }
      // Spoof penalty
      if (spoofRisk) score -= 10;
      // Spread penalty
      if (spreadStatus === 'wide') score -= 4;
      if (spreadStatus === 'extreme') score -= 8;
    } else if (opposes) {
      const mag = Math.abs(rollingImb);
      score = 45 - Math.min(35, Math.round(mag * 100 * 0.5));
      if (state === 'iceberg_resistance' && direction === 'bullish') score -= 10;
      if (state === 'iceberg_support' && direction === 'bearish') score -= 10;
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    available: true,
    segment, securityId,
    state,
    bias,
    score,
    imbalance:        Number(rollingImb.toFixed(3)),
    topImbalance:     Number(topImbalance.toFixed(3)),
    deepImbalance:    Number(rollingDeepImb.toFixed(3)),
    imbalanceVelocity: Number(imbVelocity.toFixed(3)),
    imbalanceAccel:    Number(imbAccel.toFixed(3)),
    imbalanceStddev:   Number(stddev.toFixed(3)),
    spread: { abs: Number(spreadAbs.toFixed(3)), pct: Number(spreadPct.toFixed(4)), status: spreadStatus },
    absorption,
    iceberg,
    liquidityPull,
    spoofRisk,
    sampleSize: window.length,
    windowMs,
    reasoning: reasons.join(' | '),
  };
}

/**
 * Convenience: get the score only (for confidence pillar use).
 */
function score(microstructure, direction) {
  if (!microstructure?.available) return { score: 50, reasons: ['no microstructure'] };
  return { score: microstructure.score, reasons: [microstructure.reasoning] };
}

module.exports = {
  start,
  stop,
  reset,
  analyze,
  score,
  // Singleton-style accessors for symmetry with tickDeltaClassifier
  isStarted: () => started,
};
