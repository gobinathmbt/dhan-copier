/**
 * Candle Synthesizer Service
 * ==========================
 * Runs every 3 seconds during market hours. Reads the 1m candles already
 * recorded in today's live-feed folder and synthesizes any missing 5m and
 * 15m candles from them. Also synthesizes futures 5m/15m from futures 1m.
 *
 * Why this is needed:
 *   - feedRecorder writes 5m/15m only when the engine calls recordCandles()
 *   - If the engine starts mid-session (e.g. 09:28 IST), the 5m/15m files
 *     are empty even though 1m data exists from 09:15
 *   - The hybrid engine needs ≥14 five-minute candles for ATR (available
 *     after 10:25 IST) — but without this synthesizer it sees 0 candles
 *     until the engine explicitly writes them
 *   - This synthesizer fills the gap: any 1m candles already on disk are
 *     immediately aggregated into 5m/15m so the hybrid engine has full
 *     history from the moment it starts
 *
 * Aggregation rules (standard OHLCV):
 *   5m  = aggregate 5 consecutive 1m bars (bar starts at :00, :05, :10, ...)
 *   15m = aggregate 15 consecutive 1m bars (bar starts at :00, :15, :30, :45)
 *
 * Only CLOSED bars are written (the current partial bar is skipped).
 * Deduplication: tracks written timestamps in memory — never writes the
 * same bar twice even across restarts (reads existing file on boot).
 */

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const symbolRegistry = require('../config/symbolRegistry');

const ROOT_DIR   = path.resolve(__dirname, '../../live-feed');
// Active underlying — driven by `settings.tradingSymbols[0]`.
function _underlying() { return symbolRegistry.getActiveSymbol(); }

// Market hours in IST (minutes since midnight)
const MKT_OPEN_MIN  = 9 * 60 + 15;   // 09:15
const MKT_CLOSE_MIN = 15 * 60 + 30;  // 15:30

// IST offset in seconds
const IST_OFFSET_SEC = 5 * 3600 + 30 * 60;

// ── Helpers ──────────────────────────────────────────────────────────────────

function istNow() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hours: Number(parts.hour),
    minutes: Number(parts.minute),
    totalMinutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function isMarketHours() {
  const { totalMinutes } = istNow();
  return totalMinutes >= MKT_OPEN_MIN && totalMinutes < MKT_CLOSE_MIN;
}

/** Read all JSONL lines from a file, return parsed objects */
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** Load existing candle timestamps from a file (for dedup) */
function loadExistingTimestamps(file) {
  const set = new Set();
  readJsonl(file).forEach(c => { if (c.t) set.add(c.t); });
  return set;
}

/**
 * Aggregate 1m candles into N-minute bars.
 * @param {Array}  candles1m  - sorted array of { t, o, h, l, c, v }
 * @param {number} intervalMin - 5 or 15
 * @returns {Array} aggregated candles
 */
function aggregate(candles1m, intervalMin) {
  if (!candles1m.length) return [];

  // Group by bar-start timestamp.
  // Bar start = floor(t / (intervalMin * 60)) * (intervalMin * 60)
  // BUT we need to align to IST market open (09:15 IST = 03:45 UTC).
  // Simpler: align to intervalMin-minute boundaries in IST.
  // t is Unix seconds (UTC). Convert to IST seconds, floor to interval, convert back.
  const intervalSec = intervalMin * 60;

  const groups = new Map(); // barStart (UTC unix) → [candles]
  for (const c of candles1m) {
    const tIst = c.t + IST_OFFSET_SEC;
    const barStartIst = Math.floor(tIst / intervalSec) * intervalSec;
    const barStartUtc = barStartIst - IST_OFFSET_SEC;
    if (!groups.has(barStartUtc)) groups.set(barStartUtc, []);
    groups.get(barStartUtc).push(c);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const result = [];

  for (const [barStart, bars] of groups) {
    // Skip the current (partial) bar — only write closed bars
    const barEnd = barStart + intervalSec;
    if (barEnd > nowSec) continue;

    // Must have at least 1 candle to form a bar
    if (!bars.length) continue;

    bars.sort((a, b) => a.t - b.t);
    const o = bars[0].o;
    const h = Math.max(...bars.map(b => b.h));
    const l = Math.min(...bars.map(b => b.l));
    const c = bars[bars.length - 1].c;
    const v = bars.reduce((s, b) => s + (b.v || 0), 0);

    result.push({ t: barStart, o, h, l, c, v });
  }

  result.sort((a, b) => a.t - b.t);
  return result;
}

// ── Per-session state ─────────────────────────────────────────────────────────
// Tracks which timestamps have already been written so we never duplicate.
// Keyed by `${dateStr}/${type}/${interval}` e.g. "2026-05-18/candles/5"
const writtenTimestamps = new Map();

function getWritten(dateStr, type, interval) {
  const key = `${dateStr}/${_underlying()}/${type}/${interval}`;
  if (!writtenTimestamps.has(key)) {
    // Load from disk on first access
    const folder = path.join(ROOT_DIR, `${dateStr}_${_underlying()}`);
    const file   = path.join(folder, `${type}-${interval}m.jsonl`);
    writtenTimestamps.set(key, loadExistingTimestamps(file));
  }
  return writtenTimestamps.get(key);
}

/**
 * Synthesize and write missing higher-timeframe candles for one type.
 * @param {string} dateStr  - e.g. "2026-05-18"
 * @param {string} type     - "candles" or "futures"
 */
function synthesizeForType(dateStr, type) {
  const folder = path.join(ROOT_DIR, `${dateStr}_${_underlying()}`);
  if (!fs.existsSync(folder)) return;

  // Read 1m source
  const src1m = path.join(folder, `${type}-1m.jsonl`);
  const candles1m = readJsonl(src1m);
  if (candles1m.length < 2) return; // need at least 2 bars to form any higher-TF bar

  for (const intervalMin of [5, 15, 30]) {
    const destFile = path.join(folder, `${type}-${intervalMin}m.jsonl`);
    const written  = getWritten(dateStr, type, String(intervalMin));

    const aggregated = aggregate(candles1m, intervalMin);
    const newBars = aggregated.filter(c => !written.has(c.t));

    if (!newBars.length) continue;

    // Append new bars
    try {
      const lines = newBars.map(c => JSON.stringify({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })).join('\n') + '\n';
      fs.appendFileSync(destFile, lines, 'utf8');
      newBars.forEach(c => written.add(c.t));
      logger.info({
        type, interval: `${intervalMin}m`, count: newBars.length,
        first: new Date((newBars[0].t + IST_OFFSET_SEC) * 1000).toISOString().slice(11, 19) + ' IST',
        last:  new Date((newBars[newBars.length - 1].t + IST_OFFSET_SEC) * 1000).toISOString().slice(11, 19) + ' IST',
      }, `[candleSynthesizer] wrote ${newBars.length} new ${type}-${intervalMin}m candles`);
    } catch (e) {
      logger.warn({ err: e.message, type, intervalMin }, '[candleSynthesizer] write failed');
    }
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

let _timer = null;
let _running = false;

function tick() {
  if (_running) return; // skip if previous tick still running
  _running = true;
  try {
    if (!isMarketHours()) return;
    const { dateStr } = istNow();
    synthesizeForType(dateStr, 'candles');
    synthesizeForType(dateStr, 'futures');
  } catch (e) {
    logger.warn({ err: e.message }, '[candleSynthesizer] tick error');
  } finally {
    _running = false;
  }
}

/**
 * Start the synthesizer. Called once at server boot.
 * Runs immediately (to backfill any gaps from before boot) then every 3s.
 */
function start() {
  if (_timer) return; // already started
  logger.info('[candleSynthesizer] started — synthesizing 5m/15m candles from 1m every 3s');
  // Run immediately to backfill any existing 1m data
  tick();
  _timer = setInterval(tick, 3000);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  logger.info('[candleSynthesizer] stopped');
}

module.exports = { start, stop, tick, aggregate };
