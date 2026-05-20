/**
 * SENSEX Spot Backfill
 * ====================
 * Lightweight spot-only backfill for SENSEX (security id 51 on IDX_I).
 * Writes the same JSONL layout the live recorder uses:
 *   live-feed/<YYYY-MM-DD>_SENSEX/
 *     candles-1m.jsonl
 *     candles-5m.jsonl
 *     candles-15m.jsonl
 *     candles-30m.jsonl
 *     metadata.json
 *
 * What this DOESN'T fetch (out of scope for the first SENSEX wiring):
 *   - SENSEX futures candles (BSE_FNO scrip-master resolution needed)
 *   - SENSEX option-chain snapshots (would need rollingoption with BSE_FNO)
 *
 * The ultra and support scalp engines only need spot candles to run, so
 * fetching SENSEX spot is enough to give them historical context. Once
 * SENSEX is live for a full session the recorder/synthesizer will also
 * populate option chain + 5m/15m/30m candles continuously.
 */
const fs = require('fs');
const path = require('path');
const dhanProd = require('./dhanProd.service');
const logger = require('../utils/logger');
const symbolRegistry = require('../config/symbolRegistry');

const ROOT_DIR = path.resolve(__dirname, '../../live-feed');
const IST_OFFSET_SEC = 5 * 3600 + 30 * 60;

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }

function toIST_YYYYMMDD(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function yesterdayIST() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2);
  if (day === 6) d.setDate(d.getDate() - 1);
  return toIST_YYYYMMDD(d);
}

/** Convert IST `YYYY-MM-DD HH:MM:SS` to Unix seconds. */
function istToUnix(dateStr, hhmmss) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m, s] = hhmmss.split(':').map(Number);
  const utcMs = Date.UTC(Y, M - 1, D, h - 5, m - 30, s);
  return Math.floor(utcMs / 1000);
}

/**
 * Aggregate 1m candles into N-minute bars.
 * Mirrors the live-feed candle synthesizer, so backfilled data is
 * byte-for-byte equivalent to what the recorder would have written.
 */
function aggregateCandles(candles1m, intervalMin) {
  if (!candles1m.length) return [];
  const intervalSec = intervalMin * 60;
  const groups = new Map();
  for (const c of candles1m) {
    const tIst = c.t + IST_OFFSET_SEC;
    const barStartIst = Math.floor(tIst / intervalSec) * intervalSec;
    const barStartUtc = barStartIst - IST_OFFSET_SEC;
    if (!groups.has(barStartUtc)) groups.set(barStartUtc, []);
    groups.get(barStartUtc).push(c);
  }
  const result = [];
  for (const [barStart, bars] of groups) {
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

/**
 * Backfill SENSEX spot candles for a single trading day.
 * @param {string} dateStr   YYYY-MM-DD (IST). Defaults to yesterday.
 * @param {object} opts      { overwrite: false }
 * @returns {Promise<object>}
 */
async function backfillSensexDay(dateStr, opts = {}) {
  const { overwrite = false } = opts;
  const date = dateStr || yesterdayIST();
  const sensex = symbolRegistry.getSymbol('SENSEX');
  const folderName = `${date}_SENSEX`;
  const folder = path.join(ROOT_DIR, folderName);
  ensureDir(folder);

  // Skip if all required spot files exist and non-empty
  const required = ['candles-1m.jsonl', 'candles-5m.jsonl', 'candles-15m.jsonl', 'candles-30m.jsonl'];
  if (!overwrite) {
    const allPresent = required.every(f => {
      const fp = path.join(folder, f);
      return fs.existsSync(fp) && fs.statSync(fp).size > 0;
    });
    if (allPresent) {
      logger.info({ date }, '[sensexBackfill] skipping — all candle files present');
      return { folder, skipped: true, date };
    }
  }

  const startTs = istToUnix(date, '09:14:00');
  const endTs   = istToUnix(date, '15:30:00');

  // Fetch the 1m candles from Dhan production. SENSEX is on IDX_I:51.
  const res = await dhanProd.getDhanProdData(null, {
    securityId: sensex.indexSecurityId,
    exchange: 'IDX',
    segment: 'I',
    instrument: 'IDX',
    startTime: startTs,
    endTime: endTs,
    interval: '1',
  });
  if (!res.ok) {
    logger.warn({ date, err: res.error }, '[sensexBackfill] 1m fetch failed');
    return { folder, ok: false, error: res.error };
  }
  const candles1mRaw = res.data?.candles || [];
  if (!candles1mRaw.length) {
    logger.warn({ date }, '[sensexBackfill] 1m fetch returned 0 candles');
    return { folder, ok: false, error: 'no-candles' };
  }
  // Normalise to compact { t, o, h, l, c, v }
  const candles1m = candles1mRaw.map(c => ({
    t: Number(c.time),
    o: Number(c.open),
    h: Number(c.high),
    l: Number(c.low),
    c: Number(c.close),
    v: Number(c.volume || 0),
  })).filter(c => Number.isFinite(c.c));

  // Build higher-TF bars from 1m
  const candles5m  = aggregateCandles(candles1m, 5);
  const candles15m = aggregateCandles(candles1m, 15);
  const candles30m = aggregateCandles(candles1m, 30);

  // Atomic write helper
  const writeJsonl = (file, rows) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, file);
  };

  writeJsonl(path.join(folder, 'candles-1m.jsonl'),  candles1m);
  writeJsonl(path.join(folder, 'candles-5m.jsonl'),  candles5m);
  writeJsonl(path.join(folder, 'candles-15m.jsonl'), candles15m);
  writeJsonl(path.join(folder, 'candles-30m.jsonl'), candles30m);

  // Build a minimal spot.jsonl from the 1m closes (one synthetic tick per minute).
  const spotRows = candles1m.map(c => ({
    t: c.t * 1000,
    ltp: c.c,
    open: c.o, high: c.h, low: c.l, close: c.c,
    volume: c.v,
  }));
  writeJsonl(path.join(folder, 'spot.jsonl'), spotRows);

  // Empty placeholder files for the recorder/loader to find.
  for (const f of ['option-chain.jsonl', 'futures-ticks.jsonl',
                    'futures-1m.jsonl', 'futures-5m.jsonl',
                    'futures-15m.jsonl', 'futures-30m.jsonl']) {
    const fp = path.join(folder, f);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, '');
  }

  // Metadata
  const first = candles1m[0];
  const last  = candles1m[candles1m.length - 1];
  const high  = Math.max(...candles1m.map(c => c.h));
  const low   = Math.min(...candles1m.map(c => c.l));
  const meta = {
    date,
    underlying: 'SENSEX',
    securityId: sensex.indexSecurityId,
    source: 'sensex-backfill',
    createdAt: Date.now(),
    firstTickAt: first.t * 1000,
    openPrice: first.o,
    sessionHigh: high,
    sessionLow:  low,
    sessionClose: last.c,
    candleCounts: { '1m': candles1m.length, '5m': candles5m.length, '15m': candles15m.length, '30m': candles30m.length },
  };
  fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify(meta, null, 2));

  logger.info({
    date, folder,
    counts: meta.candleCounts,
    range: `${first.o} → ${last.c}`,
  }, '[sensexBackfill] day complete');

  return { folder, ok: true, date, meta };
}

/**
 * Backfill a range of SENSEX spot days. Skips weekends and days that
 * already have complete candle files.
 * @param {object} opts  { days = 7, overwrite = false }
 */
async function backfillSensexRange({ days = 7, overwrite = false } = {}) {
  const results = [];
  const now = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;          // skip weekends
    const dateStr = toIST_YYYYMMDD(d);
    try {
      const r = await backfillSensexDay(dateStr, { overwrite });
      results.push(r);
    } catch (e) {
      logger.warn({ err: e.message, dateStr }, '[sensexBackfill] day failed');
      results.push({ date: dateStr, ok: false, error: e.message });
    }
    // Small cooldown between days
    await new Promise(r => setTimeout(r, 800));
  }
  return { days: results };
}

module.exports = {
  backfillSensexDay,
  backfillSensexRange,
  yesterdayIST,
};
