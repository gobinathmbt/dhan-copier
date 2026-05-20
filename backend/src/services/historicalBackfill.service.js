/**
 * Historical Backfill service
 * Loads yesterday's (or any given date's) NIFTY 50 data from Dhan production
 * APIs and writes the same JSONL layout as the live recorder, so the existing
 * replay tooling / algo backtests can treat it identically.
 *
 * Sources used:
 *   /v2/charts/intraday       — spot OHLC for 1m / 5m / 15m
 *   /v2/charts/rollingoption  — per-minute OHLC + OI + IV + volume for ATM ± N strikes
 *                               (ATM-relative, so we pull CE for each offset, PE for each
 *                               offset, and merge by timestamp)
 *   /v2/optionchain/expirylist — resolve the correct weekly expiry code
 *
 * Output folder layout mirrors the live recorder:
 *   live-feed/<YYYY-MM-DD>_NIFTY_50/
 *     metadata.json         — { date, source: 'backfill', openPrice, openingAtm, ... }
 *     spot.jsonl            — synthetic ticks, one per 1m candle (open + close as separate points)
 *     candles-1m.jsonl
 *     candles-5m.jsonl
 *     candles-15m.jsonl
 *     option-chain.jsonl    — per-minute ATM±6 snapshot reconstructed from rollingoption
 */
const fs = require('fs');
const path = require('path');
const dhanProd = require('./dhanProd.service');
const logger = require('../utils/logger');
const axios = require('axios');
const env = require('../config/env');
const symbolRegistry = require('../config/symbolRegistry');

const ROOT_DIR = path.resolve(__dirname, '../../live-feed');
const NIFTY_SECURITY_ID = 13;
// Active underlying — driven by `settings.tradingSymbols[0]`. Defaults
// to NIFTY_50 for CLI scripts that don't go through scalpingEngine.start().
function _underlying() { return symbolRegistry.getActiveSymbol(); }
const STRIKE_STEP = 50;
const STRIKE_WINDOW = 6; // ATM ± 6  (13 strikes total)

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }

// IST offset in seconds — used by the 30m aggregator to align bars to IST
// boundaries (matches candleSynthesizer.service.js exactly).
const IST_OFFSET_SEC = 5 * 3600 + 30 * 60;

/**
 * Aggregate 1m candles into N-minute bars.
 * Same logic as candleSynthesizer.service.js so live and backfilled files
 * are byte-for-byte equivalent.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles1m - 1m candles in unix seconds
 * @param {number} intervalMin - 5, 15, or 30
 * @returns {Array} aggregated candles
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

function toIST_YYYYMMDD(date) {
  // Format as YYYY-MM-DD in IST regardless of server timezone
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function yesterdayIST() {
  // Treat 18:00 server local as "late enough that yesterday's data is final"
  const d = new Date();
  d.setDate(d.getDate() - 1);
  // If that lands on a weekend, walk back to Friday
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2); // Sun -> Fri
  if (day === 6) d.setDate(d.getDate() - 1); // Sat -> Fri
  return toIST_YYYYMMDD(d);
}

function datePlusSec(dateStr, hhmmss) {
  // Convert IST `YYYY-MM-DD HH:MM:SS` to Unix seconds
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m, s] = hhmmss.split(':').map(Number);
  // IST is +05:30 from UTC — Date() uses local tz, so use Date.UTC and subtract 5h30m
  const utcMs = Date.UTC(Y, M - 1, D, h - 5, m - 30, s);
  return Math.floor(utcMs / 1000);
}

function toIST(ts) {
  return new Date(ts * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

// ---------------------------------------------------------------------------
//  Futures candles (NIFTY near-month FUTIDX) — same intraday endpoint but the
//  security id comes from the scrip master CSV via niftyFuturesProd.
// ---------------------------------------------------------------------------
async function fetchFuturesCandles(date, interval) {
  try {
    const futuresSvc = require('./niftyFuturesProd.service');
    const contract = await futuresSvc.getNearContract();
    if (!contract?.securityId) {
      logger.warn({ date }, '[backfill] futures contract not resolved');
      return { candles: [], contract: null };
    }
    // Request from 09:14:00 to ensure we get the 09:15 candle
    const startTs = datePlusSec(date, '09:14:00');
    const endTs = datePlusSec(date, '15:30:00');
    const res = await dhanProd.getDhanProdData(null, {
      securityId: contract.securityId,
      exchange: 'NSE',
      segment: 'D',
      instrument: 'FUTIDX',
      startTime: startTs,
      endTime: endTs,
      interval,
    });
    if (!res.ok) {
      logger.warn({ date, interval, err: res.error }, '[backfill] futures fetch failed');
      return { candles: [], contract };
    }
    return { candles: res.data.candles || [], contract };
  } catch (e) {
    logger.warn({ err: e.message, date, interval }, '[backfill] futures fetch threw');
    return { candles: [], contract: null };
  }
}

// ---------------------------------------------------------------------------
//  Spot candles
// ---------------------------------------------------------------------------
async function fetchSpotCandles(date, interval) {
  // interval: '1' | '5' | '15'
  // Request from 09:14:00 to ensure we get the 09:15 candle (Dhan API sometimes misses exact start time)
  const startTs = datePlusSec(date, '09:14:00');
  const endTs = datePlusSec(date, '15:30:00');
  const res = await dhanProd.getDhanProdData(null, {
    securityId: NIFTY_SECURITY_ID,
    exchange: 'IDX',
    segment: 'I',
    instrument: 'IDX',
    startTime: startTs,
    endTime: endTs,
    interval,
  });
  if (!res.ok) {
    logger.warn({ date, interval, err: res.error }, '[backfill] spot fetch failed');
    return [];
  }
  return res.data.candles || [];
}

// ---------------------------------------------------------------------------
//  Expiry code — /v2/charts/rollingoption uses expiryCode (0=current, 1=next, 2=far)
//  For a *past* date the weekly that was the nearest-forward expiry is expiryCode 0.
// ---------------------------------------------------------------------------
const ROLL_URL = `${env.dhanProdBaseUrl || 'https://api.dhan.co'}/v2/charts/rollingoption`;

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'access-token': env.dhanAccessToken,
    'client-id': String(env.dhanClientId),
  };
}

/**
 * Fetch a single strike leg (ATM / ATM+1 / ATM-2 / ... for a single CALL or PUT).
 * The Dhan rollingoption endpoint supports only ATM+/-3 for weekly-far,
 * but ATM±10 for near expiry.
 * @param {object} opts - { date, offset, type:'CALL'|'PUT', expiryFlag, expiryCode }
 */
async function fetchRollingOption({ date, offset, type, expiryFlag, expiryCode }) {
  const strike = offset === 0 ? 'ATM' : offset > 0 ? `ATM+${offset}` : `ATM${offset}`;
  const payload = {
    exchangeSegment: 'NSE_FNO',
    interval: '1',
    securityId: NIFTY_SECURITY_ID, // must be INTEGER (Dhan rejects string for this endpoint)
    instrument: 'OPTIDX',
    expiryFlag,   // 'WEEK' | 'MONTH'
    expiryCode,   // 1 = current expiry, 2 = next; 0 is rejected as "missing"
    strike,
    drvOptionType: type,
    requiredData: ['open', 'high', 'low', 'close', 'iv', 'volume', 'oi', 'strike', 'spot'],
    fromDate: date,
    toDate:   date,
  };

  // Retry once on ECONNRESET / rate limit
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await axios.post(ROLL_URL, payload, {
        headers: getHeaders(),
        timeout: 30000,
      });
      const leg = type === 'CALL' ? r.data?.data?.ce : r.data?.data?.pe;
      return leg || null;
    } catch (e) {
      const msg = e.response?.data || e.message;
      if (attempt < 2 && (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT')) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      logger.warn({ offset, type, expiryFlag, expiryCode, err: msg }, '[backfill] rollingoption fetch failed');
      return null;
    }
  }
  return null;
}

/**
 * Fetch all strike legs (ATM, ATM±1 ... ATM±N) for both CE and PE.
 * Returns a flat array of { offset, type, timestamps, strike, spot, open, high, low, close, iv, volume, oi }.
 */
async function fetchAllLegs(date, window, expiryFlag, expiryCode) {
  const legs = [];
  // Sequential fetch to respect Dhan rate limits — increased to 750ms between calls
  // since ECONNRESET occurred at 250ms throttle.
  for (let offset = -window; offset <= window; offset++) {
    for (const type of ['CALL', 'PUT']) {
      const leg = await fetchRollingOption({ date, offset, type, expiryFlag, expiryCode });
      if (leg) legs.push({ offset, type, ...leg });
      await new Promise(r => setTimeout(r, 750));
    }
  }
  return legs;
}

// ---------------------------------------------------------------------------
//  Merge all legs into per-minute option-chain snapshots
// ---------------------------------------------------------------------------
function mergeLegsIntoChainSnapshots(legs) {
  // Build map: timestamp -> { offset -> { ce: {...}, pe: {...}, strike, spot } }
  const tMap = new Map();
  for (const leg of legs) {
    const { offset, type, timestamp, open, high, low, close, iv, volume, oi, strike, spot } = leg;
    if (!Array.isArray(timestamp)) continue;
    for (let i = 0; i < timestamp.length; i++) {
      const t = timestamp[i];
      if (!tMap.has(t)) tMap.set(t, {});
      const frame = tMap.get(t);
      if (!frame[offset]) frame[offset] = { strike: strike?.[i] || null, spot: spot?.[i] || null };
      const slot = {
        open: open?.[i] ?? 0,
        high: high?.[i] ?? 0,
        low: low?.[i] ?? 0,
        close: close?.[i] ?? 0,
        iv: iv?.[i] ?? 0,
        volume: volume?.[i] ?? 0,
        oi: oi?.[i] ?? 0,
      };
      if (type === 'CALL') frame[offset].ce = slot;
      else frame[offset].pe = slot;
    }
  }

  // Produce one snapshot per timestamp — sorted by strike ascending
  const snapshots = [];
  const sortedTimes = [...tMap.keys()].sort((a, b) => a - b);
  for (const t of sortedTimes) {
    const frame = tMap.get(t);
    const offsets = Object.keys(frame).map(Number).sort((a, b) => a - b);
    if (offsets.length === 0) continue;

    const rows = [];
    let spot = 0;
    for (const off of offsets) {
      const f = frame[off];
      if (f.spot) spot = f.spot;
      rows.push({
        strike: f.strike,
        ce: {
          ltp: f.ce?.close || 0,
          oi:  f.ce?.oi || 0,
          oiChg: 0,
          vol: f.ce?.volume || 0,
          iv:  f.ce?.iv || 0,
          delta: 0, theta: 0, gamma: 0, vega: 0,
          bid: 0, ask: 0,
          buildup: 'unknown',
          offset: off,
          ohlc: f.ce ? { o: f.ce.open, h: f.ce.high, l: f.ce.low, c: f.ce.close } : null,
        },
        pe: {
          ltp: f.pe?.close || 0,
          oi:  f.pe?.oi || 0,
          oiChg: 0,
          vol: f.pe?.volume || 0,
          iv:  f.pe?.iv || 0,
          delta: 0, theta: 0, gamma: 0, vega: 0,
          bid: 0, ask: 0,
          buildup: 'unknown',
          offset: off,
          ohlc: f.pe ? { o: f.pe.open, h: f.pe.high, l: f.pe.low, c: f.pe.close } : null,
        },
      });
    }
    const atmRow = rows.find(r => r.ce.offset === 0) || rows[Math.floor(rows.length / 2)];
    const atmStrike = atmRow?.strike || (spot ? Math.round(spot / STRIKE_STEP) * STRIKE_STEP : null);

    // Derive per-snapshot OI change vs previous snapshot
    if (snapshots.length > 0) {
      const prev = snapshots[snapshots.length - 1];
      for (const row of rows) {
        const prevRow = prev.strikes.find(s => s.strike === row.strike);
        if (prevRow) {
          row.ce.oiChg = row.ce.oi - prevRow.ce.oi;
          row.pe.oiChg = row.pe.oi - prevRow.pe.oi;
        }
      }
    }

    snapshots.push({
      t: t * 1000, // persist ms epoch to match live recorder
      spot,
      atm: atmStrike,
      expiry: null, // filled in below by caller
      strikes: rows,
    });
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------
/**
 * Backfill a single trading day for NIFTY 50.
 * @param {string} dateStr  YYYY-MM-DD in IST. Defaults to yesterday.
 * @param {object} opts     { window: 6, expiryFlag: 'WEEK', expiryCode: 1, overwrite: false }
 */
async function backfillDay(dateStr, opts = {}) {
  const {
    window = STRIKE_WINDOW,
    expiryFlag = 'WEEK',
    expiryCode = 1, // Dhan treats 0 as missing — use 1 for the current expiry
    overwrite = false,
    skipIfComplete = true, // skip if folder has all required files non-empty
  } = opts;
  const date = dateStr || yesterdayIST();
  const underlying = _underlying();
  const folderName = `${date}_${underlying}`;
  const folder = path.join(ROOT_DIR, folderName);
  ensureDir(folder);

  // ── Skip-if-complete check ───────────────────────────────────────────
  if (skipIfComplete) {
    const required = [
      'candles-1m.jsonl', 'candles-5m.jsonl', 'candles-15m.jsonl', 'candles-30m.jsonl',
      'futures-1m.jsonl', 'futures-5m.jsonl', 'futures-15m.jsonl', 'futures-30m.jsonl',
      'option-chain.jsonl', 'spot.jsonl', 'metadata.json',
    ];
    const allPresentAndNonEmpty = required.every(f => {
      const fp = path.join(folder, f);
      return fs.existsSync(fp) && fs.statSync(fp).size > 0;
    });
    if (allPresentAndNonEmpty) {
      logger.info({ date }, '[backfill] skipping — all files present and non-empty');
      return {
        folder,
        skipped: true,
        meta: { date, source: 'cached' },
        counts: { skipped: true },
      };
    }
  }

  const meta = {
    date,
    underlying,
    securityId: NIFTY_SECURITY_ID,
    source: 'backfill',
    expiryFlag,
    expiryCode,
    strikeWindow: window,
    createdAt: Date.now(),
  };

  logger.info({ date, window, expiryFlag, expiryCode }, '[backfill] starting');

  // ---- 1. Spot candles (1m / 5m / 15m) -----------------------------------
  const [c1, c5, c15] = await Promise.all([
    fetchSpotCandles(date, '1'),
    fetchSpotCandles(date, '5'),
    fetchSpotCandles(date, '15'),
  ]);
  logger.info({ '1m': c1.length, '5m': c5.length, '15m': c15.length }, '[backfill] spot candles loaded');

  // ---- 1b. NIFTY Futures candles (near-month) ----------------------------
  // Also fetched in parallel so backfilling a day doesn't get slower.
  const [f1, f5, f15] = await Promise.all([
    fetchFuturesCandles(date, '1'),
    fetchFuturesCandles(date, '5'),
    fetchFuturesCandles(date, '15'),
  ]);
  logger.info({
    fut1m: f1.candles.length,
    fut5m: f5.candles.length,
    fut15m: f15.candles.length,
    contract: f1.contract?.tradingSymbol,
  }, '[backfill] futures candles loaded');

  const writeJsonl = (file, rows, overwriteFile) => {
    const full = path.join(folder, file);
    if (overwriteFile || !fs.existsSync(full)) fs.writeFileSync(full, '');
    const out = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    fs.appendFileSync(full, out);
  };

  writeJsonl('candles-1m.jsonl',  c1.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 })), overwrite);
  writeJsonl('candles-5m.jsonl',  c5.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 })), overwrite);
  writeJsonl('candles-15m.jsonl', c15.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 })), overwrite);
  // 30m candles — derived locally from 1m via IST-aligned aggregation
  // (matches candleSynthesizer.service.js so live and backfilled identical)
  const c1Norm = c1.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 }));
  const c30 = aggregateCandles(c1Norm, 30);
  writeJsonl('candles-30m.jsonl', c30, overwrite);

  // Futures candles — one file per timeframe
  writeJsonl('futures-1m.jsonl',  f1.candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 })), overwrite);
  writeJsonl('futures-5m.jsonl',  f5.candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 })), overwrite);
  writeJsonl('futures-15m.jsonl', f15.candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 })), overwrite);
  // Futures 30m — also derived locally
  const f1Norm = f1.candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 }));
  const f30 = aggregateCandles(f1Norm, 30);
  writeJsonl('futures-30m.jsonl', f30, overwrite);

  // Build synthetic tick stream from 1m candles: emit close at each bar-close timestamp
  const spotTicks = c1.map(c => ({
    t: c.time * 1000,
    ltp: c.close,
    ltt: c.time,
    volume: c.volume || 0,
    open: c.open, high: c.high, low: c.low, close: c.close,
  }));
  writeJsonl('spot.jsonl', spotTicks, overwrite);

  if (c1.length) {
    meta.firstTickAt = c1[0].time * 1000;
    meta.openPrice = c1[0].open;
    meta.openCandle = { open: c1[0].open, high: c1[0].high, low: c1[0].low, close: c1[0].close };
    meta.openingAtm = Math.round(c1[0].open / STRIKE_STEP) * STRIKE_STEP;
  }

  // Futures metadata — near-month contract used that day
  if (f1.contract) {
    meta.futuresContract = {
      securityId: f1.contract.securityId,
      tradingSymbol: f1.contract.tradingSymbol,
      expiryDate: f1.contract.expiryDate,
      lotSize: f1.contract.lotSize,
    };
    if (f1.candles.length) {
      meta.futuresOpen = f1.candles[0].open;
      meta.futuresClose = f1.candles[f1.candles.length - 1].close;
      meta.futuresOpenPremium = Number((f1.candles[0].open - c1[0]?.open || 0).toFixed(2));
      meta.futuresClosePremium = Number((meta.futuresClose - (c1[c1.length - 1]?.close || 0)).toFixed(2));
    }
  }

  // ---- 2. Option chain — ATM ± N, merged per minute ----------------------
  logger.info({ legsToFetch: (window * 2 + 1) * 2 }, '[backfill] fetching option legs (may take ~30s)');
  const legs = await fetchAllLegs(date, window, expiryFlag, expiryCode);
  const snapshots = mergeLegsIntoChainSnapshots(legs);
  logger.info({ snapshots: snapshots.length, legs: legs.length }, '[backfill] option chain merged');

  // Write snapshots
  writeJsonl('option-chain.jsonl', snapshots, overwrite);

  // Metadata: latest strike list
  if (snapshots.length) {
    const last = snapshots[snapshots.length - 1];
    meta.latestAtm = last.atm;
    meta.latestStrikes = last.strikes.map(s => s.strike);
    meta.openingStrikes = snapshots[0].strikes.map(s => s.strike);
    meta.snapshotCount = snapshots.length;
  }

  fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify(meta, null, 2));

  logger.info({ folder, snapshots: snapshots.length, c1: c1.length, c5: c5.length, c15: c15.length, c30: c30.length }, '[backfill] done');
  return {
    folder,
    meta,
    counts: {
      spot: spotTicks.length,
      candles1m: c1.length,
      candles5m: c5.length,
      candles15m: c15.length,
      candles30m: c30.length,
      futures1m: f1.candles.length,
      futures5m: f5.candles.length,
      futures15m: f15.candles.length,
      futures30m: f30.length,
      chain: snapshots.length,
    },
  };
}

/**
 * Backfill a range of days. Skips weekends. Exchange holidays where the API
 * returns zero data simply produce empty files + a warning in the log.
 *
 * @param {number|string} days  number of trading days back from today (default 7)
 * @param {object} opts         { window, expiryFlag, expiryCode, overwrite, toDate }
 */
async function backfillRange(days = 7, opts = {}) {
  const { toDate } = opts;
  const daysCount = Math.max(1, Math.min(30, Number(days) || 7));

  // Build the list of trading days working backwards from `toDate` (or today)
  const results = [];
  const ref = toDate ? new Date(`${toDate}T00:00:00Z`) : new Date();

  // Walk back up to 2× daysCount calendar days to ensure we hit `daysCount` trading days
  const dates = [];
  const cursor = new Date(ref);
  cursor.setDate(cursor.getDate() - 1); // start from yesterday, not today
  for (let i = 0; i < daysCount * 3 && dates.length < daysCount; i++) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) {
      dates.push(toIST_YYYYMMDD(cursor));
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  // Oldest -> newest for tidy ordering in logs
  dates.reverse();

  logger.info({ dates, count: dates.length }, '[backfill] starting range backfill');

  for (const d of dates) {
    try {
      const r = await backfillDay(d, opts);
      results.push({ date: d, ok: true, counts: r.counts, folder: r.folder });
    } catch (e) {
      logger.warn({ date: d, err: e.message }, '[backfill] day failed');
      results.push({ date: d, ok: false, error: e.message });
    }
    // small cooldown between days to avoid rate-limits
    await new Promise(r => setTimeout(r, 1000));
  }

  logger.info({ total: results.length, ok: results.filter(r => r.ok).length }, '[backfill] range complete');
  return { days: results };
}

module.exports = {
  backfillDay,
  backfillRange,
  yesterdayIST,
  STRIKE_WINDOW,
  // Backwards-compat: the literal default. Live consumers should call
  // `_underlying()` (private) or read via symbolRegistry directly.
  UNDERLYING: 'NIFTY_50',
  getUnderlying: _underlying,
};
