/**
 * Tick Delta Classifier (centralized, singleton)
 * ----------------------------------------------
 * Listens to the existing Dhan live-feed singleton and classifies every print
 * into UP / DOWN / NEUTRAL using the institutional Lee-Ready rule:
 *
 *   1. LTP >= ask  → aggressive BUY  (UP volume)
 *   2. LTP <= bid  → aggressive SELL (DOWN volume)
 *   3. otherwise   → use tick rule:
 *        LTP > prevLTP → UP
 *        LTP < prevLTP → DOWN
 *        LTP == prevLTP → carry previous classification
 *
 * Because this matches `LTQ` (last traded quantity) at each tick rather than
 * splitting candle volume by wick weight, this is the TRUE institutional
 * UP/DOWN/Delta read for live data.
 *
 * Why a separate file?
 *   - Single source of truth: one classifier, many consumers (entry, monitor,
 *     decay engine, future analytics).
 *   - Decoupled from the WebSocket parser — the live-feed module emits 'tick'
 *     events; we listen. No coupling either way.
 *   - Survives reconnects: state is in-memory and rebuilds from new ticks.
 *
 * Public API:
 *   start()                                   — begin listening (idempotent)
 *   stop()
 *   getDelta(seg, securityId, opts)          — { up, down, total, delta, deltaPct, lastTickAt, sampleSize }
 *   getRollingBuckets(seg, securityId, ms)   — { tBucketStart, up, down, ... }[] for charting
 *   getStatus()
 *
 * Memory bound: per instrument we keep only:
 *   - cumulative session up/down totals (since first tick)
 *   - a rolling window of the last N ticks (default 5000) for sub-window queries
 *   - last-N small time-bucketed aggregates (default 60 buckets × 60s = 1 hour)
 *
 * No DB writes. No file I/O. Pure in-memory & event-driven.
 */

const logger = require('../../utils/logger');

// Default constants — tunable per consumer
const MAX_TICKS_PER_INSTRUMENT = 5000;
const BUCKET_MS = 60_000;        // 1-minute buckets
const MAX_BUCKETS = 90;          // 90 minutes of recall

class TickDeltaClassifier {
  constructor() {
    this.started = false;
    this.feed = null;            // bound dhanLiveFeedProd singleton
    this.handler = null;         // bound listener so we can remove it cleanly

    // Per-instrument state. Key = `${segment}:${securityId}`.
    //   {
    //     up, down, total, lastLtp, lastTickClass,
    //     ticks:   [{ t, ltp, ltq, side: 'up'|'down'|'neutral' }, ...],
    //     buckets: [{ start, up, down, total, lastLtp }, ...]
    //   }
    this.state = new Map();

    // Counters for status reporting
    this.totalProcessed = 0;
    this.totalSkipped = 0;
    this.startedAt = null;
  }

  /** Begin listening to the live feed. Safe to call multiple times. */
  start(feedSingleton = null) {
    if (this.started) return;

    // Lazy-require to avoid circulars at module load time
    if (!feedSingleton) {
      try {
        const { instance } = require('../dhanLiveFeedProd.service');
        feedSingleton = instance;
      } catch (e) {
        logger.error({ err: e.message }, '[tickDelta] could not load live feed singleton');
        return;
      }
    }
    if (!feedSingleton || typeof feedSingleton.on !== 'function') {
      logger.error('[tickDelta] feed singleton does not support events');
      return;
    }

    this.feed = feedSingleton;
    this.handler = (evt) => {
      try { this._onTick(evt); }
      catch (e) {
        // Listener must NEVER throw — swallow with log
        logger.warn({ err: e.message }, '[tickDelta] _onTick threw (swallowed)');
      }
    };
    this.feed.on('tick', this.handler);
    this.started = true;
    this.startedAt = Date.now();
    logger.info('[tickDelta] classifier started — listening to live-feed ticks');
  }

  /** Stop listening. Keeps state for late queries; call reset() to drop it. */
  stop() {
    if (!this.started) return;
    if (this.feed && this.handler) {
      try { this.feed.off('tick', this.handler); } catch (_) {}
    }
    this.feed = null;
    this.handler = null;
    this.started = false;
    logger.info('[tickDelta] classifier stopped');
  }

  /** Drop all accumulated state. */
  reset() {
    this.state.clear();
    this.totalProcessed = 0;
    this.totalSkipped = 0;
  }

  /**
   * Get the current delta for an instrument.
   *
   * @param {string} segment    - e.g. 'IDX_I' or 'NSE_FNO'
   * @param {number|string} securityId
   * @param {Object} [opts]
   * @param {number} [opts.windowMs] - if given, only count ticks within this many ms
   * @returns {Object|null}
   */
  getDelta(segment, securityId, opts = {}) {
    const key = `${segment}:${securityId}`;
    const st = this.state.get(key);
    if (!st) return null;

    if (opts.windowMs && Number.isFinite(opts.windowMs) && opts.windowMs > 0) {
      const cutoff = Date.now() - opts.windowMs;
      let up = 0, down = 0, n = 0;
      // Walk from newest backward — small linear scan, ticks are already chronological
      for (let i = st.ticks.length - 1; i >= 0; i--) {
        const t = st.ticks[i];
        if (t.t < cutoff) break;
        if (t.side === 'up') up += t.ltq;
        else if (t.side === 'down') down += t.ltq;
        n++;
      }
      const total = up + down;
      const delta = up - down;
      return {
        segment, securityId,
        windowMs: opts.windowMs,
        sampleSize: n,
        up, down, total, delta,
        deltaPct: total > 0 ? Number(((delta / total) * 100).toFixed(2)) : 0,
        lastTickAt: st.lastTickAt || null,
      };
    }

    // Session totals
    const total = st.up + st.down;
    return {
      segment, securityId,
      windowMs: null,
      sampleSize: st.ticks.length,
      up: st.up, down: st.down, total,
      delta: st.up - st.down,
      deltaPct: total > 0 ? Number((((st.up - st.down) / total) * 100).toFixed(2)) : 0,
      lastTickAt: st.lastTickAt || null,
    };
  }

  /**
   * Get the rolling 1-minute (default) buckets for charting / decay analysis.
   * @returns {Array<{start, up, down, total, delta, lastLtp}>}
   */
  getRollingBuckets(segment, securityId, bucketMs = BUCKET_MS) {
    const key = `${segment}:${securityId}`;
    const st = this.state.get(key);
    if (!st) return [];
    if (bucketMs === BUCKET_MS) return st.buckets.slice();

    // Recompute on a custom bucket size on demand. Cheap because we cap ticks.
    return _bucketize(st.ticks, bucketMs);
  }

  /** Whole picture for monitoring UIs / debugging. */
  getStatus() {
    const out = {
      started: this.started,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      totalProcessed: this.totalProcessed,
      totalSkipped: this.totalSkipped,
      instruments: [],
    };
    for (const [key, st] of this.state.entries()) {
      const total = st.up + st.down;
      out.instruments.push({
        key,
        ticks: st.ticks.length,
        up: st.up,
        down: st.down,
        delta: st.up - st.down,
        deltaPct: total > 0 ? Number((((st.up - st.down) / total) * 100).toFixed(2)) : 0,
        lastTickAt: st.lastTickAt ? new Date(st.lastTickAt).toISOString() : null,
        lastLtp: st.lastLtp,
      });
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────
  _onTick(evt) {
    if (!evt || !evt.next) return;
    const next = evt.next;
    const prev = evt.prev || {};
    const patch = evt.patch || {};

    // We need at least an LTP to classify. LTQ is required to weight by quantity;
    // if missing, fall back to weight = 1 so the count still moves.
    if (!Number.isFinite(next.ltp)) { this.totalSkipped++; return; }

    // We only classify when this update actually contains a fresh PRINT, not
    // a snapshot refresh of OI / depth alone. The cheapest signal is "ltp or
    // ltq present in the patch" or "ltt advanced".
    const hasFreshPrint =
         Number.isFinite(patch.ltp)
      || Number.isFinite(patch.ltq)
      || (Number.isFinite(patch.ltt) && patch.ltt !== prev.ltt);
    if (!hasFreshPrint) { this.totalSkipped++; return; }

    const ltp = Number(next.ltp);
    const ltq = Number.isFinite(next.ltq) && next.ltq > 0 ? Number(next.ltq) : 1;

    // Best bid / ask available either at top of book (next.depth[0]) or, if
    // the instrument is in QUOTE mode, we approximate using totalBuyQty /
    // totalSellQty pressure as a coarse fallback (used only when depth absent).
    const top = Array.isArray(next.depth) && next.depth.length ? next.depth[0] : null;
    const bid = top && Number.isFinite(top.bidPrice) ? Number(top.bidPrice) : null;
    const ask = top && Number.isFinite(top.askPrice) ? Number(top.askPrice) : null;

    const key = `${evt.segment}:${evt.securityId}`;
    let st = this.state.get(key);
    if (!st) {
      st = {
        up: 0, down: 0,
        lastLtp: null,
        lastTickClass: 'neutral',
        lastTickAt: null,
        ticks: [],
        buckets: [],
      };
      this.state.set(key, st);
    }

    // ── Classification (Lee-Ready) ─────────────────────────────────────────
    let side;
    if (bid != null && ask != null && ask > bid) {
      if (ltp >= ask) side = 'up';
      else if (ltp <= bid) side = 'down';
      else side = _tickRule(ltp, st.lastLtp, st.lastTickClass);
    } else {
      // No book depth — use pure tick rule
      side = _tickRule(ltp, st.lastLtp, st.lastTickClass);
    }

    // ── Apply ──────────────────────────────────────────────────────────────
    if (side === 'up')   st.up   += ltq;
    if (side === 'down') st.down += ltq;
    st.lastLtp = ltp;
    st.lastTickClass = side;
    st.lastTickAt = next.updatedAt || Date.now();

    // Append to rolling tick log (cap to MAX_TICKS_PER_INSTRUMENT)
    st.ticks.push({ t: st.lastTickAt, ltp, ltq, side });
    if (st.ticks.length > MAX_TICKS_PER_INSTRUMENT) {
      st.ticks.splice(0, st.ticks.length - MAX_TICKS_PER_INSTRUMENT);
    }

    // ── Time bucket update ─────────────────────────────────────────────────
    const bucketStart = Math.floor(st.lastTickAt / BUCKET_MS) * BUCKET_MS;
    let last = st.buckets[st.buckets.length - 1];
    if (!last || last.start !== bucketStart) {
      last = { start: bucketStart, up: 0, down: 0, total: 0, lastLtp: ltp };
      st.buckets.push(last);
      if (st.buckets.length > MAX_BUCKETS) st.buckets.shift();
    }
    if (side === 'up')   last.up   += ltq;
    if (side === 'down') last.down += ltq;
    last.total += ltq;
    last.lastLtp = ltp;

    this.totalProcessed++;
  }
}

// Tick rule: classify when bid/ask is unknown.
function _tickRule(curLtp, prevLtp, prevClass) {
  if (prevLtp == null) return 'neutral';
  if (curLtp > prevLtp) return 'up';
  if (curLtp < prevLtp) return 'down';
  return prevClass || 'neutral';
}

function _bucketize(ticks, bucketMs) {
  const out = [];
  for (const t of ticks) {
    const start = Math.floor(t.t / bucketMs) * bucketMs;
    let last = out[out.length - 1];
    if (!last || last.start !== start) {
      last = { start, up: 0, down: 0, total: 0, lastLtp: t.ltp };
      out.push(last);
    }
    if (t.side === 'up')   last.up   += t.ltq;
    if (t.side === 'down') last.down += t.ltq;
    last.total += t.ltq;
    last.lastLtp = t.ltp;
  }
  return out;
}

// Singleton — mirrors the dhanLiveFeedProd pattern so import sites are uniform.
const instance = new TickDeltaClassifier();

module.exports = {
  instance,
  TickDeltaClassifier,
};
