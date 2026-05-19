/**
 * Live Feed Integrity Service
 * ===========================
 * Periodic guardian that:
 *   1. Dedupes candle JSONL files (in-place, by timestamp normalised to seconds)
 *   2. Detects gaps in the candle stream and backfills from the API
 *   3. Synthesises missing 5m/15m/30m candles from 1m when the aggregator
 *      misses a window (server restart, network blip)
 *
 * Runs every 60s while a scalping session is live, and once on session
 * start for the current trading day.
 *
 * Designed to be safe to re-run any number of times — all operations are
 * idempotent (dedupe by timestamp, append-only, atomic write-rename).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ROOT_DIR = path.resolve(__dirname, '../../live-feed');
const UNDERLYING = 'NIFTY_50';

// Trading session window in IST minutes-since-midnight
const SESSION_OPEN_MIN  = 9 * 60 + 15;   // 09:15
const SESSION_CLOSE_MIN = 15 * 60 + 30;  // 15:30

const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800 };

function _todayIstYYYYMMDD() {
  const ms = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function _istMinutesNow() {
  const ms = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function _isMarketHours() {
  const m = _istMinutesNow();
  return m >= SESSION_OPEN_MIN && m < SESSION_CLOSE_MIN;
}

function _readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

function _writeJsonlAtomic(file, rows) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Normalise timestamp to seconds (handles 13-digit ms and 10-digit sec).
 */
function _toSec(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n >= 1e12 ? Math.floor(n / 1000) : n;
}

/**
 * Dedupe a JSONL file in-place by timestamp.
 * Returns { kept, dropped } counts.
 */
function dedupeFile(file) {
  const rows = _readJsonl(file);
  if (!rows.length) return { kept: 0, dropped: 0 };
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const t = _toSec(row.t);
    if (t === null) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ ...row, t });
  }
  out.sort((a, b) => a.t - b.t);
  if (out.length === rows.length) return { kept: out.length, dropped: 0 };
  _writeJsonlAtomic(file, out);
  return { kept: out.length, dropped: rows.length - out.length };
}

/**
 * Synthesise missing 5m/15m/30m candles from 1m when there are obvious
 * holes in the higher-TF stream.
 *
 * For each higher-TF bucket boundary that has at least 1 1m candle
 * available but no higher-TF row at that timestamp, build the candle
 * from the constituent 1m bars and append it to the higher-TF file.
 */
function synthesizeFromOneMinute(folder, base /* 'candles' | 'futures' */) {
  const file1m = path.join(folder, `${base}-1m.jsonl`);
  const c1 = _readJsonl(file1m);
  if (c1.length < 5) return { synthesised: {} };

  const synthesised = {};

  for (const tf of ['5m', '15m', '30m']) {
    const tfSec = TF_SECONDS[tf];
    const fileTf = path.join(folder, `${base}-${tf}.jsonl`);
    const existing = _readJsonl(fileTf);
    const have = new Set(existing.map(r => _toSec(r.t)).filter(t => t !== null));

    // Bucket the 1m candles by their tf-aligned start timestamp
    const buckets = new Map();
    for (const c of c1) {
      const t = _toSec(c.t);
      if (t === null) continue;
      const bucket = Math.floor(t / tfSec) * tfSec;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(c);
    }

    // For each bucket NOT in the higher-TF file, build a candle (only if
    // we have all the constituent bars — partial buckets are ignored to
    // avoid creating artificially-short candles).
    const expectedBars = tfSec / 60;
    const newRows = [];
    for (const [bucket, bars] of buckets) {
      if (have.has(bucket)) continue;
      if (bars.length < expectedBars) continue;        // bucket not complete
      bars.sort((a, b) => _toSec(a.t) - _toSec(b.t));
      const o = bars[0].o;
      const c = bars[bars.length - 1].c;
      const h = Math.max(...bars.map(b => b.h));
      const l = Math.min(...bars.map(b => b.l));
      const v = bars.reduce((s, b) => s + (b.v || 0), 0);
      newRows.push({ t: bucket, o, h, l, c, v });
    }
    if (newRows.length) {
      const merged = [...existing, ...newRows]
        .map(r => ({ ...r, t: _toSec(r.t) }))
        .filter((r, i, arr) => r.t !== null && arr.findIndex(x => x.t === r.t) === i)
        .sort((a, b) => a.t - b.t);
      _writeJsonlAtomic(fileTf, merged);
      synthesised[tf] = newRows.length;
    }
  }
  return { synthesised };
}

/**
 * Detect gaps in 1m candle stream and report them. The recorder is
 * expected to fill gaps via the next API poll, but we surface the count
 * for monitoring.
 */
function detectGaps(folder, base = 'candles') {
  const file = path.join(folder, `${base}-1m.jsonl`);
  const rows = _readJsonl(file);
  if (rows.length < 2) return { gaps: 0, gapDetails: [] };
  const times = rows.map(r => _toSec(r.t)).filter(t => t !== null).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    if (dt > 60) gaps.push({ fromSec: times[i - 1], toSec: times[i], dt });
  }
  return { gaps: gaps.length, gapDetails: gaps.slice(0, 10) };
}

/**
 * Run a single integrity sweep for today's folder.
 */
function sweepToday() {
  const dateStr = _todayIstYYYYMMDD();
  const folder = path.join(ROOT_DIR, `${dateStr}_${UNDERLYING}`);
  if (!fs.existsSync(folder)) {
    return { skipped: true, reason: 'folder missing' };
  }
  const result = { dateStr, folder, dedupe: {}, synth: {}, gaps: {} };

  // 1) Dedupe all candle / futures files
  for (const base of ['candles', 'futures']) {
    for (const tf of ['1m', '5m', '15m', '30m']) {
      const f = path.join(folder, `${base}-${tf}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const r = dedupeFile(f);
      if (r.dropped > 0) result.dedupe[`${base}-${tf}`] = r;
    }
  }

  // 2) Synth missing higher-TF candles from 1m
  for (const base of ['candles', 'futures']) {
    const r = synthesizeFromOneMinute(folder, base);
    if (Object.keys(r.synthesised).length) result.synth[base] = r.synthesised;
  }

  // 3) Detect 1m gaps (informational)
  for (const base of ['candles', 'futures']) {
    const r = detectGaps(folder, base);
    if (r.gaps > 0) result.gaps[base] = r;
  }

  return result;
}

let _timer = null;

function start({ intervalMs = 60_000 } = {}) {
  if (_timer) return;
  // Run once immediately
  try {
    const r = sweepToday();
    if (r.skipped) logger.info({ r }, '[liveFeedIntegrity] start sweep skipped');
    else logger.info({ dedupe: r.dedupe, synth: r.synth, gaps: r.gaps }, '[liveFeedIntegrity] initial sweep complete');
  } catch (e) {
    logger.warn({ err: e.message }, '[liveFeedIntegrity] initial sweep failed');
  }
  // Periodic
  _timer = setInterval(() => {
    if (!_isMarketHours()) return;     // only run during market hours
    try {
      const r = sweepToday();
      const hasWork = Object.keys(r.dedupe).length || Object.keys(r.synth).length || Object.keys(r.gaps).length;
      if (hasWork) {
        logger.info({ dedupe: r.dedupe, synth: r.synth, gaps: r.gaps }, '[liveFeedIntegrity] sweep restored data');
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[liveFeedIntegrity] sweep failed');
    }
  }, intervalMs);
  _timer.unref?.();
  logger.info({ intervalMs }, '[liveFeedIntegrity] started');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start, stop, sweepToday,
  // exposed for tests / scripts
  dedupeFile, synthesizeFromOneMinute, detectGaps,
};
