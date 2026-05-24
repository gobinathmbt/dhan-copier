/**
 * Premium Swing — Opening Range Tracker
 * =====================================
 * Captures the first-5-min CE and PE premium H/L for the primary
 * (ATM-at-9:15-IST) strike. The ranges are the foundation of the
 * Premium Swing engine — every entry/target/SL key off them.
 *
 * Source of truth: the option-chain snapshots persisted to disk by
 * feedRecorder at `live-feed/<date>_<symbol>/option-chain.jsonl`.
 * Each snapshot has shape:
 *   { t: msSinceEpoch, spot, atm, expiry, strikes: [{strike, ce:{ltp, ...}, pe:{ltp, ...}}, ...] }
 *
 * Public API:
 *   • capture(market)     — returns the H/L if the 5-min window has
 *                           closed and we can read snapshots
 *   • get(market)         — returns the cached range (or null)
 *   • clear(market)       — wipes the cache (called on session start)
 *   • clearAll()
 *
 * State is in-memory and resets per process / session. The 9:15 ATM
 * is locked once per day per market — even if spot moves and the live
 * ATM changes, the range is referenced to the *primary* strike that
 * was ATM at the open. That's how the strategy is defined.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const LIVE_FEED_ROOT = path.resolve(__dirname, '../../../live-feed');

// IST capture window — full 5-min opening range
const CAPTURE_START_MIN = 9 * 60 + 15;   // 09:15
const CAPTURE_END_MIN   = 9 * 60 + 20;   // 09:20

/** key: `${dateStr}:${market}` → range payload */
const _cache = new Map();

function _istNow() {
  const ms = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return {
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateStr: d.toISOString().slice(0, 10),
    msIst: ms,
  };
}

/** Convert IST HH:MM to ms-since-epoch for `dateStr` (YYYY-MM-DD). */
function _istToMs(dateStr, hh, mm) {
  const utcMs = Date.parse(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
  return utcMs;
}

function _readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

function _findStrike(snapshot, strike) {
  if (!snapshot || !Array.isArray(snapshot.strikes)) return null;
  return snapshot.strikes.find(s => Number(s.strike) === Number(strike)) || null;
}

/**
 * Build range from option-chain snapshots. Looks at all snapshots
 * within [windowStartMs, windowEndMs], finds the ATM strike that was
 * "primary" at windowStartMs, and computes H/L of that strike's CE
 * and PE legs across the window.
 *
 * @returns {{
 *   primaryStrike: number,
 *   ce: { high: number, low: number, openLtp: number, closeLtp: number },
 *   pe: { high: number, low: number, openLtp: number, closeLtp: number },
 *   regime: 'bullish_reversal' | 'bearish_reversal' | 'sideways',
 *   regimeReasoning: string,
 *   capturedAt: ISOString,
 *   snapshotCount: number,
 * }|null}
 */
function _buildRangeFromSnapshots(snaps, windowStartMs, windowEndMs) {
  const inWindow = snaps.filter(s => {
    const t = Number(s.t);
    return Number.isFinite(t) && t >= windowStartMs && t <= windowEndMs;
  });
  if (inWindow.length < 3) return null;

  // Lock the primary strike to whatever ATM was at the FIRST snapshot
  // in the window. Spot can drift mid-window but the strategy is
  // defined relative to the open ATM, not the live ATM.
  const firstSnap = inWindow[0];
  const primaryStrike = Number(firstSnap.atm);
  if (!Number.isFinite(primaryStrike) || primaryStrike <= 0) return null;

  let ceHigh = -Infinity, ceLow = Infinity;
  let peHigh = -Infinity, peLow = Infinity;
  let ceOpen = null, peOpen = null;
  let ceClose = null, peClose = null;
  let usedSnaps = 0;

  for (const s of inWindow) {
    const row = _findStrike(s, primaryStrike);
    if (!row) continue;
    const ceLtp = Number(row.ce?.ltp);
    const peLtp = Number(row.pe?.ltp);
    if (Number.isFinite(ceLtp) && ceLtp > 0) {
      if (ceOpen === null) ceOpen = ceLtp;
      ceClose = ceLtp;
      if (ceLtp > ceHigh) ceHigh = ceLtp;
      if (ceLtp < ceLow)  ceLow  = ceLtp;
    }
    if (Number.isFinite(peLtp) && peLtp > 0) {
      if (peOpen === null) peOpen = peLtp;
      peClose = peLtp;
      if (peLtp > peHigh) peHigh = peLtp;
      if (peLtp < peLow)  peLow  = peLtp;
    }
    usedSnaps++;
  }

  if (usedSnaps < 3 || !Number.isFinite(ceHigh) || !Number.isFinite(peHigh)) {
    return null;
  }

  // ── Regime classification ──────────────────────────────────────────
  // peAboveCe: PE range entirely above CE range. Market opened bearish,
  //            PE got bid up; if CE breaks higher → bullish reversal.
  // ceAbovePe: CE range entirely above PE range. Market opened bullish,
  //            CE got bid up; if PE breaks higher → bearish reversal.
  // overlap:   ranges intersect → sideways
  const peAboveCe = peLow  >= ceHigh;
  const ceAbovePe = ceLow  >= peHigh;
  let regime, regimeReasoning;
  if (peAboveCe) {
    regime = 'bullish_reversal';
    regimeReasoning = `PE range [${peLow.toFixed(1)}-${peHigh.toFixed(1)}] entirely above ` +
      `CE range [${ceLow.toFixed(1)}-${ceHigh.toFixed(1)}] — bearish open, watch for CE break above ${ceHigh.toFixed(1)}`;
  } else if (ceAbovePe) {
    regime = 'bearish_reversal';
    regimeReasoning = `CE range [${ceLow.toFixed(1)}-${ceHigh.toFixed(1)}] entirely above ` +
      `PE range [${peLow.toFixed(1)}-${peHigh.toFixed(1)}] — bullish open, watch for PE break above ${peHigh.toFixed(1)}`;
  } else {
    regime = 'sideways';
    regimeReasoning = `Ranges overlap — CE [${ceLow.toFixed(1)}-${ceHigh.toFixed(1)}] vs ` +
      `PE [${peLow.toFixed(1)}-${peHigh.toFixed(1)}]; range-bound day`;
  }

  return {
    primaryStrike,
    ce: { high: ceHigh, low: ceLow, openLtp: ceOpen, closeLtp: ceClose },
    pe: { high: peHigh, low: peLow, openLtp: peOpen, closeLtp: peClose },
    regime,
    regimeReasoning,
    capturedAt: new Date().toISOString(),
    snapshotCount: usedSnaps,
  };
}

/**
 * Try to capture the range for `market` for today. Returns the cached
 * range if already captured. Returns null if window hasn't closed yet
 * or snapshots are missing.
 */
function capture(market) {
  if (!market) return null;
  const { minutes, dateStr } = _istNow();
  const cacheKey = `${dateStr}:${market}`;

  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  // Window not yet closed — skip
  if (minutes < CAPTURE_END_MIN) return null;

  const folder = path.join(LIVE_FEED_ROOT, `${dateStr}_${market}`);
  const file = path.join(folder, 'option-chain.jsonl');
  if (!fs.existsSync(file)) {
    return null;
  }

  const snaps = _readJsonl(file);
  if (snaps.length === 0) return null;

  const windowStartMs = _istToMs(dateStr, 9, 15);
  const windowEndMs   = _istToMs(dateStr, 9, 20);
  const range = _buildRangeFromSnapshots(snaps, windowStartMs, windowEndMs);
  if (!range) return null;

  _cache.set(cacheKey, range);
  logger.info({
    market, dateStr,
    primaryStrike: range.primaryStrike,
    ceRange: `${range.ce.low.toFixed(2)}-${range.ce.high.toFixed(2)}`,
    peRange: `${range.pe.low.toFixed(2)}-${range.pe.high.toFixed(2)}`,
    regime: range.regime,
    snapshots: range.snapshotCount,
  }, '[premiumSwing] opening range captured');
  return range;
}

function get(market) {
  if (!market) return null;
  const { dateStr } = _istNow();
  return _cache.get(`${dateStr}:${market}`) || null;
}

function clear(market) {
  if (!market) return;
  const { dateStr } = _istNow();
  _cache.delete(`${dateStr}:${market}`);
}

function clearAll() {
  _cache.clear();
}

module.exports = {
  capture,
  get,
  clear,
  clearAll,
  CAPTURE_START_MIN,
  CAPTURE_END_MIN,
};
