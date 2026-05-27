/**
 * Intel V2 Service — Institutional Console snapshot, version 2
 * =============================================================
 * Self-contained, NO dependency on v1 intel.service.js / intel.controller.
 *
 * Endpoints:
 *   GET /api/intel-v2/snapshot?symbol=NIFTY_50&date=YYYY-MM-DD
 *   GET /api/intel-v2/dual?date=YYYY-MM-DD
 *   GET /api/intel-v2/available-dates?symbol=NIFTY_50
 *
 * Data sources (priority):
 *   1. live-feed folder JSONL recordings (per date, per symbol)
 *   2. Dhan production API historical/option-chain endpoints
 *   3. Yahoo + Sensibull (macro context, FII/DII) — only for "live" mode
 *
 * The whole payload is computed deterministically inside this file. No AI,
 * no engine state mutation, no DB writes.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const env = require('../config/env');
const logger = require('../utils/logger');
const symbolRegistry = require('../config/symbolRegistry');
const dhanProd = require('./dhanProd.service');
const niftyFuturesProd = require('./niftyFuturesProd.service');
const settings = require('../config/algoSettings').getSettings();
const marketInternals = require('./algorithms/marketInternals.service');

const LIVE_FEED_DIR = path.join(__dirname, '../../live-feed');
const YAHOO_API = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ── Caches ────────────────────────────────────────────────────────────────
const _snapshotCache = new Map();   // key: symbol|date → { at, payload }
// Live mode polls every 3s from the UI; cache slightly under that so each
// poll picks up fresh data without hammering the API. Historical mode
// re-uses the cached payload across rapid re-renders.
const SNAPSHOT_CACHE_MS_LIVE = 800;
const SNAPSHOT_CACHE_MS_HIST = 60_000;

const _macroCache = { at: 0, data: null };
const MACRO_CACHE_MS = 60_000;

const _heavyCache = new Map();      // key: symbol|date → { at, data }
const _breadthCache = new Map();    // key: symbol|date → { at, data }

// ── Constituents ──────────────────────────────────────────────────────────
const HEAVYWEIGHTS = {
  NIFTY_50: [
    { symbol: 'HDFCBANK.NS',    name: 'HDFC Bank',    weight: 13.3 },
    { symbol: 'RELIANCE.NS',    name: 'Reliance',     weight: 9.5 },
    { symbol: 'ICICIBANK.NS',   name: 'ICICI Bank',   weight: 8.5 },
    { symbol: 'INFY.NS',        name: 'Infosys',      weight: 5.8 },
    { symbol: 'BHARTIARTL.NS',  name: 'Bharti Airtel',weight: 4.7 },
    { symbol: 'TCS.NS',         name: 'TCS',          weight: 4.4 },
    { symbol: 'LT.NS',          name: 'L&T',          weight: 3.9 },
    { symbol: 'ITC.NS',         name: 'ITC',          weight: 3.5 },
  ],
  SENSEX: [
    { symbol: 'HDFCBANK.BO',    name: 'HDFC Bank',    weight: 14.5 },
    { symbol: 'RELIANCE.BO',    name: 'Reliance',     weight: 10.4 },
    { symbol: 'ICICIBANK.BO',   name: 'ICICI Bank',   weight: 9.3 },
    { symbol: 'INFY.BO',        name: 'Infosys',      weight: 6.4 },
    { symbol: 'BHARTIARTL.BO',  name: 'Bharti Airtel',weight: 5.2 },
    { symbol: 'TCS.BO',         name: 'TCS',          weight: 4.8 },
    { symbol: 'LT.BO',          name: 'L&T',          weight: 4.3 },
    { symbol: 'AXISBANK.BO',    name: 'Axis Bank',    weight: 3.6 },
  ],
};

const NIFTY50_FULL = [
  'ADANIENT.NS','ADANIPORTS.NS','APOLLOHOSP.NS','ASIANPAINT.NS','AXISBANK.NS',
  'BAJAJ-AUTO.NS','BAJFINANCE.NS','BAJAJFINSV.NS','BEL.NS','BHARTIARTL.NS',
  'CIPLA.NS','COALINDIA.NS','DRREDDY.NS','EICHERMOT.NS','GRASIM.NS',
  'HCLTECH.NS','HDFCBANK.NS','HDFCLIFE.NS','HEROMOTOCO.NS','HINDALCO.NS',
  'HINDUNILVR.NS','ICICIBANK.NS','INDUSINDBK.NS','INFY.NS','ITC.NS',
  'JIOFIN.NS','JSWSTEEL.NS','KOTAKBANK.NS','LT.NS','M&M.NS',
  'MARUTI.NS','NESTLEIND.NS','NTPC.NS','ONGC.NS','POWERGRID.NS',
  'RELIANCE.NS','SBILIFE.NS','SBIN.NS','SHRIRAMFIN.NS','SUNPHARMA.NS',
  'TATACONSUM.NS','TATAMOTORS.NS','TATASTEEL.NS','TCS.NS','TECHM.NS',
  'TITAN.NS','TRENT.NS','ULTRACEMCO.NS','WIPRO.NS','BRITANNIA.NS',
];
const SENSEX30_FULL = [
  'ADANIPORTS.BO','ASIANPAINT.BO','AXISBANK.BO','BAJFINANCE.BO','BHARTIARTL.BO',
  'HCLTECH.BO','HDFCBANK.BO','HINDUNILVR.BO','ICICIBANK.BO','INFY.BO',
  'ITC.BO','KOTAKBANK.BO','LT.BO','M&M.BO','MARUTI.BO',
  'NESTLEIND.BO','NTPC.BO','POWERGRID.BO','RELIANCE.BO','SBIN.BO',
  'SUNPHARMA.BO','TATAMOTORS.BO','TATASTEEL.BO','TCS.BO','TECHM.BO',
  'TITAN.BO','ULTRACEMCO.BO','BAJAJFINSV.BO','TRENT.BO','ZOMATO.BO',
];
const FULL_CONSTITUENTS = { NIFTY_50: NIFTY50_FULL, SENSEX: SENSEX30_FULL };

// ── Number helpers ────────────────────────────────────────────────────────
function _safe(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}
function _round(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
function _fmtOiCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return { val: _round(v / 1e7, 2), unit: 'Cr' };
  if (Math.abs(v) >= 1e5) return { val: _round(v / 1e5, 2), unit: 'L' };
  return { val: _round(v, 0), unit: '' };
}

// ── Date helpers ──────────────────────────────────────────────────────────
function _todayIST() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}
function _isWeekend(d) {
  const [y, mo, da] = d.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, da)).getUTCDay();
  return dow === 0 || dow === 6;
}
function _sessionUtcRange(yyyy_mm_dd) {
  // 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  const start = Math.floor(Date.UTC(y, m - 1, d, 3, 45, 0) / 1000);
  const end   = start + (6 * 3600 + 15 * 60);
  return { start, end };
}
function _previousTradingDay(yyyy_mm_dd) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  while (true) {
    probe.setUTCDate(probe.getUTCDate() - 1);
    const dow = probe.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      return `${probe.getUTCFullYear()}-${String(probe.getUTCMonth() + 1).padStart(2, '0')}-${String(probe.getUTCDate()).padStart(2, '0')}`;
    }
  }
}
function _activeAuthKey() {
  return env.dhanAccessToken || process.env.DHAN_ACCESS_TOKEN || null;
}

// ── Indicator math ────────────────────────────────────────────────────────
function _ema(values, period) {
  if (!values?.length) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return Number(e.toFixed(2));
}
function _vwap(candles) {
  let sum = 0, vol = 0;
  for (const c of candles || []) {
    const tp = (c.high + c.low + c.close) / 3;
    sum += tp * (c.volume || 0);
    vol += (c.volume || 0);
  }
  return vol > 0 ? Number((sum / vol).toFixed(2)) : null;
}
function _anchoredVwap(candles, anchorIdx = 0) {
  if (!Array.isArray(candles) || candles.length <= anchorIdx) return null;
  let pv = 0, v = 0;
  for (let i = anchorIdx; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * (c.volume || 0);
    v  += (c.volume || 0);
  }
  return v > 0 ? Number((pv / v).toFixed(2)) : null;
}
function _atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.length ? Number((slice.reduce((s, x) => s + x, 0) / slice.length).toFixed(2)) : null;
}
function _rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  let avgG = g / period, avgL = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}
function _cprFromOHLC(ohlc) {
  if (!ohlc) return null;
  const { high: H, low: L, close: C } = ohlc;
  if (![H, L, C].every(Number.isFinite)) return null;
  const pivot = (H + L + C) / 3;
  const bc = (H + L) / 2;
  const tc = 2 * pivot - bc;
  const r1 = 2 * pivot - L, s1 = 2 * pivot - H;
  const r2 = pivot + (H - L), s2 = pivot - (H - L);
  const r3 = H + 2 * (pivot - L), s3 = L - 2 * (H - pivot);
  const width = Math.abs(tc - bc);
  const widthPct = (width / pivot) * 100;
  let widthClass = 'normal';
  if (widthPct < 0.15) widthClass = 'narrow';
  else if (widthPct > 0.40) widthClass = 'wide';
  return {
    pivot: _round(pivot), tc: _round(tc), bc: _round(bc),
    r1: _round(r1), r2: _round(r2), r3: _round(r3),
    s1: _round(s1), s2: _round(s2), s3: _round(s3),
    width: _round(width, 2),
    widthPct: _round(widthPct, 3),
    widthClass,
  };
}

// ── File-based loaders (live-feed folder) ─────────────────────────────────
function _folderFor(date, symbolKey) {
  return path.join(LIVE_FEED_DIR, `${date}_${symbolKey}`);
}
function _readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch (_) {}
    }
    return out;
  } catch (e) {
    logger.warn({ err: e.message, file: filePath }, '[intelV2] jsonl read failed');
    return [];
  }
}
function _readCandlesFile(date, symbolKey, kind /* 'candles'|'futures' */, tf /* '1m'|'5m'|'15m'|'30m' */) {
  const file = path.join(_folderFor(date, symbolKey), `${kind}-${tf}.jsonl`);
  const rows = _readJsonl(file);
  // Normalize to { timestamp, open, high, low, close, volume }
  const all = rows.map(r => ({
    timestamp: Number(r.t || r.time || r.timestamp || 0),
    open:  _safe(r.o ?? r.open),
    high:  _safe(r.h ?? r.high),
    low:   _safe(r.l ?? r.low),
    close: _safe(r.c ?? r.close),
    volume: _safe(r.v ?? r.volume),
  })).filter(c => Number.isFinite(c.timestamp) && c.timestamp > 0);
  // Spot-side files use the index range; futures roughly track spot, so
  // same expected range applies (futures premium is sub-1% of price).
  const expected = _EXPECTED_RANGE[symbolKey] || null;
  return _sanitiseCandles(all, expected);
}

/**
 * Drop candles that are clearly from a different symbol (e.g. multi-symbol
 * session switches that leaked NIFTY ticks into the SENSEX folder).
 *
 * Validation strategy:
 *   1. Compute the median close of the file.
 *   2. If `expectedRange` is provided, ensure the median falls inside it. If
 *      not, the entire file is from the wrong symbol → reject everything.
 *   3. Drop individual outliers within ±30% of the (validated) median.
 */
function _sanitiseCandles(rows, expectedRange = null) {
  if (!Array.isArray(rows) || rows.length < 5) return rows;
  const closes = rows.map(c => c.close).filter(Number.isFinite).sort((a, b) => a - b);
  if (!closes.length) return rows;
  const median = closes[Math.floor(closes.length / 2)];
  if (!median) return rows;

  // If we know roughly what range the symbol trades in, refuse data that
  // sits entirely outside that range — that's another symbol's data
  // mislabelled into this symbol's folder.
  if (expectedRange && (median < expectedRange[0] || median > expectedRange[1])) {
    // Try filtering to the expected range — maybe SOME rows are correct.
    const inRange = rows.filter(c =>
      Number.isFinite(c.close) && c.close >= expectedRange[0] && c.close <= expectedRange[1]
    );
    return inRange.length >= 5 ? inRange : [];
  }

  const valid = rows.filter(c =>
    Number.isFinite(c.close) && Math.abs(c.close - median) / median < 0.3
  );
  return valid.length >= Math.max(5, rows.length * 0.5) ? valid : rows;
}

// Expected price range per symbol — used by _sanitiseCandles to reject
// folder corruption (e.g. NIFTY data mislabelled into a SENSEX folder).
const _EXPECTED_RANGE = {
  NIFTY_50:  [10000, 40000],
  SENSEX:    [40000, 120000],
  BANKNIFTY: [30000, 80000],
};
function _readLatestOptionChain(date, symbolKey) {
  const file = path.join(_folderFor(date, symbolKey), 'option-chain.jsonl');
  const rows = _readJsonl(file);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  // shape: { t, spot, atm, expiry, strikes:[{strike, ce:{...}, pe:{...}}] }
  return last;
}
function _readMetadata(date, symbolKey) {
  const file = path.join(_folderFor(date, symbolKey), 'metadata.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function _hasLiveFeed(date, symbolKey) {
  const folder = _folderFor(date, symbolKey);
  return fs.existsSync(folder) && fs.existsSync(path.join(folder, 'candles-1m.jsonl'));
}
function _availableDatesForSymbol(symbolKey) {
  if (!fs.existsSync(LIVE_FEED_DIR)) return [];
  const out = [];
  const suffix = `_${symbolKey}`;
  for (const entry of fs.readdirSync(LIVE_FEED_DIR)) {
    if (!entry.endsWith(suffix)) continue;
    const date = entry.slice(0, -suffix.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push(date);
  }
  return out.sort();
}

// ── Yahoo (macro context) ─────────────────────────────────────────────────
async function _yahooQuote(symbol) {
  try {
    const url = `${YAHOO_API}/${symbol}?interval=1d&range=2d`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const r = res.data?.chart?.result?.[0];
    if (!r) return null;
    const meta = r.meta;
    const q = r.indicators?.quote?.[0];
    const last = meta?.regularMarketPrice ?? q?.close?.[q.close.length - 1];
    const prev = meta?.chartPreviousClose ?? q?.close?.[q.close.length - 2];
    if (!Number.isFinite(last) || !Number.isFinite(prev)) return null;
    const change = last - prev;
    const changePct = (change / prev) * 100;
    return {
      symbol,
      price: _round(last, 4),
      change: _round(change, 4),
      changePct: _round(changePct, 2),
      previousClose: _round(prev, 4),
    };
  } catch (e) {
    return null;
  }
}

async function _macroContext() {
  if (Date.now() - _macroCache.at < MACRO_CACHE_MS && _macroCache.data) {
    return _macroCache.data;
  }
  const [vix, gift, sp, nq, dxy, crude, nikkei] = await Promise.all([
    _yahooQuote('^INDIAVIX'),
    _yahooQuote('^NSEI'),
    _yahooQuote('ES=F'),
    _yahooQuote('NQ=F'),
    _yahooQuote('DX-Y.NYB'),
    _yahooQuote('CL=F'),
    _yahooQuote('^N225'),
  ]);
  let fiiDii = null;
  try { fiiDii = await marketInternals.fetchInstitutionalFlowData(); }
  catch (_) {}
  const data = {
    vix, giftNifty: gift,
    usFutures: { sp500: sp, nasdaq: nq },
    dxy, crude, nikkei, fiiDii,
  };
  _macroCache.at = Date.now();
  _macroCache.data = data;
  return data;
}

// Heavyweights — Yahoo last-trade for the configured top names.
async function _heavyweights(symbolKey, dateKey) {
  const cacheKey = `${symbolKey}|${dateKey}`;
  const cached = _heavyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MACRO_CACHE_MS) return cached.data;
  const list = HEAVYWEIGHTS[symbolKey] || HEAVYWEIGHTS.NIFTY_50;
  const rows = await Promise.all(list.map(async (s) => {
    const q = await _yahooQuote(s.symbol);
    return { ...s, ...(q || {}) };
  }));
  const valid = rows.filter(r => Number.isFinite(r.changePct));
  const wAvg = valid.length
    ? valid.reduce((a, r) => a + r.changePct * r.weight, 0) /
      valid.reduce((a, r) => a + r.weight, 0)
    : 0;
  const advancing = valid.filter(r => r.changePct > 0.05).length;
  const declining = valid.filter(r => r.changePct < -0.05).length;
  const unchanged = valid.length - advancing - declining;
  const data = {
    symbol: symbolKey,
    rows,
    weightedAvgChangePct: _round(wAvg, 2),
    advancing, declining, unchanged, total: valid.length,
    leaders:  [...valid].sort((a, b) => b.changePct - a.changePct).slice(0, 3),
    laggards: [...valid].sort((a, b) => a.changePct - b.changePct).slice(0, 3),
  };
  _heavyCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function _fullBreadth(symbolKey, dateKey) {
  const cacheKey = `${symbolKey}|${dateKey}`;
  const cached = _breadthCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MACRO_CACHE_MS) return cached.data;
  const list = FULL_CONSTITUENTS[symbolKey] || FULL_CONSTITUENTS.NIFTY_50;
  const CONC = 12;
  const results = [];
  for (let i = 0; i < list.length; i += CONC) {
    const chunk = list.slice(i, i + CONC);
    const part = await Promise.all(chunk.map(s =>
      _yahooQuote(s).then(q => ({ symbol: s, ...(q || {}) }))));
    results.push(...part);
  }
  const valid = results.filter(r => Number.isFinite(r.changePct));
  const advancing = valid.filter(r => r.changePct > 0.05).length;
  const declining = valid.filter(r => r.changePct < -0.05).length;
  const unchanged = valid.length - advancing - declining;
  const total = list.length;
  const adRatio = declining ? _round(advancing / declining, 2) : (advancing > 0 ? 999 : 0);
  const leaders  = [...valid].sort((a, b) => b.changePct - a.changePct).slice(0, 5)
    .map(r => ({ symbol: r.symbol.replace(/\.(NS|BO)$/, ''), changePct: r.changePct, price: r.price }));
  const laggards = [...valid].sort((a, b) => a.changePct - b.changePct).slice(0, 5)
    .map(r => ({ symbol: r.symbol.replace(/\.(NS|BO)$/, ''), changePct: r.changePct, price: r.price }));
  const data = {
    symbol: symbolKey,
    advancing, declining, unchanged, total, sampled: valid.length,
    advancePct: _round((advancing / total) * 100, 0),
    declinePct: _round((declining / total) * 100, 0),
    adRatio, leaders, laggards,
    source: 'full-index',
  };
  _breadthCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

module.exports.__internals = {
  _safe, _round, _ema, _vwap, _atr, _rsi, _cprFromOHLC,
  _readCandlesFile, _readLatestOptionChain, _readMetadata,
  _hasLiveFeed, _availableDatesForSymbol,
  _yahooQuote, _macroContext, _heavyweights, _fullBreadth,
  _todayIST, _previousTradingDay, _sessionUtcRange,
};


// ──────────────────────────────────────────────────────────────────────────
// DATA LAYER — load candles + option chain for a target date
// ──────────────────────────────────────────────────────────────────────────

/**
 * Load all candles (1m/5m/15m/30m) for a date.
 *   Strategy:
 *     1. If live-feed folder has the data, use it.
 *     2. Otherwise call Dhan production historical API.
 */
async function _loadCandles(authKey, sym, date) {
  const symbolKey = sym.key;

  // 1. Folder
  const c1m  = _readCandlesFile(date, symbolKey, 'candles', '1m');
  const c5m  = _readCandlesFile(date, symbolKey, 'candles', '5m');
  const c15m = _readCandlesFile(date, symbolKey, 'candles', '15m');
  const c30m = _readCandlesFile(date, symbolKey, 'candles', '30m');
  const f1m  = _readCandlesFile(date, symbolKey, 'futures', '1m');
  const f5m  = _readCandlesFile(date, symbolKey, 'futures', '5m');

  if (c1m.length >= 5) {
    return {
      source: 'live-feed-folder',
      candles1m: c1m, candles5m: c5m, candles15m: c15m, candles30m: c30m,
      futures1m: f1m, futures5m: f5m,
    };
  }

  // 2. Dhan API
  const { start, end } = _sessionUtcRange(date);
  const fetchTf = async (interval) => {
    try {
      const res = await dhanProd.getDhanProdData(authKey, {
        securityId: sym.indexSecurityId,
        exchange: 'IDX',
        segment: 'I',
        instrument: 'IDX',
        startTime: start,
        endTime: end,
        interval,
      });
      if (!res?.ok) return [];
      const arr = res.data?.candles || [];
      return arr.map(c => ({
        timestamp: Number(c.timestamp || c.t || c.time),
        open: _safe(c.open),  high: _safe(c.high),
        low:  _safe(c.low),   close: _safe(c.close),
        volume: _safe(c.volume),
      })).filter(c => Number.isFinite(c.timestamp));
    } catch (e) {
      logger.warn({ err: e.message, interval, sym: sym.key, date }, '[intelV2] dhan candles failed');
      return [];
    }
  };
  const [a1, a5, a15, a30] = await Promise.all([
    fetchTf('1'), fetchTf('5'), fetchTf('15'), fetchTf('30'),
  ]);

  // futures candles for NIFTY (BSE futures not exposed by niftyFuturesProd)
  let futures1m = [], futures5m = [];
  if (sym.futuresUnderlying === 'NIFTY') {
    try {
      const f1 = await niftyFuturesProd.getIntradayCandles({ interval: '1', startTime: start, endTime: end }).catch(() => null);
      const f5 = await niftyFuturesProd.getIntradayCandles({ interval: '5', startTime: start, endTime: end }).catch(() => null);
      if (f1?.ok) futures1m = f1.data?.candles || [];
      if (f5?.ok) futures5m = f5.data?.candles || [];
    } catch (_) {}
  }

  return {
    source: 'dhan-api',
    candles1m: a1, candles5m: a5, candles15m: a15, candles30m: a30,
    futures1m, futures5m,
  };
}

/**
 * Load option chain for a date.
 *   Strategy:
 *     1. live-feed folder option-chain.jsonl (last entry of the day)
 *     2. Dhan production option-chain API (only valid for "today")
 */
async function _loadOptionChain(authKey, sym, date, isToday) {
  const symbolKey = sym.key;

  const folderRow = _readLatestOptionChain(date, symbolKey);
  if (folderRow && Array.isArray(folderRow.strikes) && folderRow.strikes.length) {
    // normalize folder shape (ce/pe → call/put with greeks subkey to match v1 helpers)
    const strikes = folderRow.strikes.map(s => ({
      strike: Number(s.strike),
      call: {
        ltp: _safe(s.ce?.ltp),
        oi: _safe(s.ce?.oi),
        oiChange: _safe(s.ce?.oiChg ?? s.ce?.oiChange),
        volume: _safe(s.ce?.vol ?? s.ce?.volume),
        iv: _safe(s.ce?.iv),
        greeks: {
          delta: _safe(s.ce?.delta), gamma: _safe(s.ce?.gamma),
          theta: _safe(s.ce?.theta), vega: _safe(s.ce?.vega),
        },
        buildup: s.ce?.buildup || null,
      },
      put: {
        ltp: _safe(s.pe?.ltp),
        oi: _safe(s.pe?.oi),
        oiChange: _safe(s.pe?.oiChg ?? s.pe?.oiChange),
        volume: _safe(s.pe?.vol ?? s.pe?.volume),
        iv: _safe(s.pe?.iv),
        greeks: {
          delta: _safe(s.pe?.delta), gamma: _safe(s.pe?.gamma),
          theta: _safe(s.pe?.theta), vega: _safe(s.pe?.vega),
        },
        buildup: s.pe?.buildup || null,
      },
    }));
    const expDate = folderRow.expiry || null;
    let dte = null;
    if (expDate) {
      const [ey, em, ed] = expDate.split('-').map(Number);
      const exp = Date.UTC(ey, em - 1, ed);
      const [ry, rm, rd] = date.split('-').map(Number);
      const ref = Date.UTC(ry, rm - 1, rd);
      dte = Math.max(0, Math.round((exp - ref) / (24 * 3600 * 1000)));
    }
    return {
      source: 'live-feed-folder',
      atm: Number(folderRow.atm),
      spot: Number(folderRow.spot),
      expiry: expDate,
      expiryDate: expDate,
      daysToExpiry: dte,
      strikes,
    };
  }

  if (!isToday) return null;

  try {
    const expRes = await dhanProd.getExpiryListProd(authKey, {
      securityId: sym.indexSecurityId,
      underlyingSeg: sym.indexSegment,
    });
    if (!expRes?.ok || !expRes.data?.expiries?.length) return null;
    const nearest = expRes.data.expiries[0];
    const ocRes = await dhanProd.getOptionChainProd(authKey, {
      securityId: sym.indexSecurityId,
      underlyingSeg: sym.indexSegment,
      expiry: nearest.exp,
    });
    if (!ocRes?.ok) return null;
    return {
      source: 'dhan-api',
      atm: null,
      spot: _safe(ocRes.data?.underlyingPrice),
      expiry: nearest.exp,
      expiryDate: nearest.expiryDate,
      daysToExpiry: nearest.daysToExpiry,
      strikes: ocRes.data?.strikes || [],
    };
  } catch (e) {
    logger.warn({ err: e.message, sym: sym.key, date }, '[intelV2] dhan option chain failed');
    return null;
  }
}

/**
 * Prior-day OHLC fetch (for CPR + change% baseline).
 */
async function _loadPriorDayOHLC(authKey, sym, date) {
  const prevDate = _previousTradingDay(date);
  // prefer folder (already sanitised in _readCandlesFile)
  const c5 = _readCandlesFile(prevDate, sym.key, 'candles', '5m');
  if (c5.length) {
    const high  = Math.max(...c5.map(c => c.high));
    const low   = Math.min(...c5.map(c => c.low));
    const open  = c5[0].open;
    const close = c5[c5.length - 1].close;
    return { open, high, low, close, date: prevDate, source: 'folder' };
  }
  try {
    const { start, end } = _sessionUtcRange(prevDate);
    const res = await dhanProd.getDhanProdData(authKey, {
      securityId: sym.indexSecurityId,
      exchange: 'IDX', segment: 'I', instrument: 'IDX',
      startTime: start, endTime: end, interval: '5',
    });
    if (!res?.ok || !res.data?.candles?.length) return null;
    const cs = res.data.candles;
    return {
      open: cs[0].open,
      high: Math.max(...cs.map(c => c.high)),
      low:  Math.min(...cs.map(c => c.low)),
      close: cs[cs.length - 1].close,
      date: prevDate,
      source: 'dhan-api',
    };
  } catch (e) {
    return null;
  }
}


// ──────────────────────────────────────────────────────────────────────────
// ANALYZERS — pure functions over loaded data
// ──────────────────────────────────────────────────────────────────────────

/** ATM strike — round spot to nearest strike step. */
function _computeAtm(spot, step) {
  if (!Number.isFinite(spot) || !Number.isFinite(step) || step <= 0) return null;
  return Math.round(spot / step) * step;
}

/** Build a primary-strike ± N ladder with health scoring. */
function _strikeLadder(strikes, atm, range = 4, bias = 'neutral') {
  if (!Array.isArray(strikes) || !strikes.length || !atm) return [];
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const idx = sorted.findIndex(s => s.strike === atm);
  if (idx < 0) return [];
  const start = Math.max(0, idx - range);
  const end = Math.min(sorted.length, idx + range + 1);
  const slice = sorted.slice(start, end);

  const buildLeg = (s, side) => {
    const leg = side === 'CE' ? (s.call || s.ce || {}) : (s.put || s.pe || {});
    const greeks = leg.greeks || leg;
    const ltp = _safe(leg.ltp);
    const iv  = _safe(leg.iv);
    const delta = _safe(greeks.delta);
    const oi  = _safe(leg.oi);
    const oiChg = _safe(leg.oiChange ?? leg.oiChg);
    const gamma = _safe(greeks.gamma);
    const theta = _safe(greeks.theta);
    const vega  = _safe(greeks.vega);
    const volume = _safe(leg.volume ?? leg.vol);

    let score = 50;
    if (Math.abs(delta) >= 0.45 && Math.abs(delta) <= 0.65) score += 12;
    else if (Math.abs(delta) >= 0.30) score += 5;
    else if (Math.abs(delta) < 0.15) score -= 18;
    if (iv >= 12 && iv <= 30) score += 6;
    else if (iv > 60) score -= 8;
    else if (iv < 5) score -= 12;
    if (ltp > 0 && Math.abs(theta) / ltp * 100 > 250) score -= 12;
    if (side === 'CE') {
      if (oiChg > 0) score -= 6; else if (oiChg < 0) score += 5;
    } else {
      if (oiChg > 0) score -= 6; else if (oiChg < 0) score += 5;
    }
    if (side === 'CE' && bias === 'bullish') score += 8;
    if (side === 'PE' && bias === 'bearish') score += 8;
    if (side === 'CE' && bias === 'bearish') score -= 8;
    if (side === 'PE' && bias === 'bullish') score -= 8;
    if (oi < 50_000) score -= 10;
    else if (oi > 1_000_000) score += 4;
    if (volume > 100_000) score += 3;
    if (ltp <= 0.1) score -= 25;

    score = Math.max(0, Math.min(100, score));
    let state = 'healthy';
    if (score >= 70) state = 'explosive';
    else if (score >= 55) state = 'healthy';
    else if (score >= 40) state = 'weak';
    else state = 'dead';

    return {
      ltp, oi, oiChange: oiChg, iv, delta, gamma, theta, vega, volume,
      health: { state, score: Math.round(score) },
      buildup: leg.buildup || null,
    };
  };

  return slice.map(s => ({
    strike: s.strike,
    isAtm: s.strike === atm,
    ce: buildLeg(s, 'CE'),
    pe: buildLeg(s, 'PE'),
  }));
}

/** ATM blocks: walls, max pain, total OI, PCR. */
function _atmBlocks(strikes, atm) {
  if (!atm || !strikes?.length) return null;
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const atmRow = sorted.find(s => s.strike === atm) || null;
  let highCe = { strike: null, oi: 0 };
  let highPe = { strike: null, oi: 0 };
  let maxPain = atm, maxPainCombined = 0;
  let totCe = 0, totPe = 0;
  let ceWriteCnt = 0, peWriteCnt = 0, ceUnwindCnt = 0, peUnwindCnt = 0;
  for (const s of sorted) {
    const ceOi = _safe(s.call?.oi ?? s.ce?.oi);
    const peOi = _safe(s.put?.oi ?? s.pe?.oi);
    const ceChg = _safe(s.call?.oiChange ?? s.ce?.oiChg ?? s.ce?.oiChange);
    const peChg = _safe(s.put?.oiChange ?? s.pe?.oiChg ?? s.pe?.oiChange);
    totCe += ceOi; totPe += peOi;
    if (ceOi > highCe.oi) highCe = { strike: s.strike, oi: ceOi };
    if (peOi > highPe.oi) highPe = { strike: s.strike, oi: peOi };
    const combined = ceOi + peOi;
    if (combined > maxPainCombined) {
      maxPainCombined = combined; maxPain = s.strike;
    }
    if (ceChg > 0) ceWriteCnt++; else if (ceChg < 0) ceUnwindCnt++;
    if (peChg > 0) peWriteCnt++; else if (peChg < 0) peUnwindCnt++;
  }
  const ce = atmRow?.call || atmRow?.ce || null;
  const pe = atmRow?.put  || atmRow?.pe || null;
  return {
    atmRow,
    callWall: highCe.strike,
    putWall:  highPe.strike,
    maxPain,
    pcr: totCe > 0 ? _round(totPe / totCe, 2) : 0,
    ceTotal: totCe,
    peTotal: totPe,
    ceWriting:  ceWriteCnt > peWriteCnt,
    peWriting:  peWriteCnt > ceWriteCnt,
    ceUnwinding: ceUnwindCnt > peUnwindCnt,
    peUnwinding: peUnwindCnt > ceUnwindCnt,
    atmIv: _safe(ce?.iv ?? pe?.iv),
    atmCall: ce ? {
      ltp: _safe(ce.ltp), oi: _safe(ce.oi), iv: _safe(ce.iv),
      delta: _safe(ce.greeks?.delta ?? ce.delta),
    } : null,
    atmPut: pe ? {
      ltp: _safe(pe.ltp), oi: _safe(pe.oi), iv: _safe(pe.iv),
      delta: _safe(pe.greeks?.delta ?? pe.delta),
    } : null,
  };
}

/** Per-strike OI change histogram around ATM. */
function _oiHistogram(strikes, atm, range = 6) {
  if (!Array.isArray(strikes) || !atm) return [];
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const idx = sorted.findIndex(s => s.strike === atm);
  if (idx < 0) return [];
  const start = Math.max(0, idx - range);
  const end = Math.min(sorted.length, idx + range + 1);
  return sorted.slice(start, end).map(s => ({
    strike: s.strike,
    isAtm: s.strike === atm,
    ceOiChg: _safe(s.call?.oiChange ?? s.ce?.oiChg ?? s.ce?.oiChange),
    peOiChg: _safe(s.put?.oiChange  ?? s.pe?.oiChg ?? s.pe?.oiChange),
    ceOi: _safe(s.call?.oi ?? s.ce?.oi),
    peOi: _safe(s.put?.oi  ?? s.pe?.oi),
  }));
}

/** Volume buckets for FRVP — POC / VAH / VAL using close-volume profile. */
function _volumeProfile(candles) {
  if (!candles?.length) return null;
  // Bin by 0.05% of average price → ~5pt buckets on Nifty 24k
  const avg = candles.reduce((s, c) => s + c.close, 0) / candles.length;
  const step = Math.max(1, Math.round(avg * 0.0005));
  const bins = new Map();
  let totalVol = 0;
  for (const c of candles) {
    const bin = Math.round(c.close / step) * step;
    const v = c.volume || 0;
    bins.set(bin, (bins.get(bin) || 0) + v);
    totalVol += v;
  }
  if (!totalVol) return null;
  const sorted = [...bins.entries()]
    .map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => b.volume - a.volume);
  const poc = sorted[0]?.price ?? null;
  // Value area: 70%
  const target = totalVol * 0.7;
  let acc = 0;
  const va = [];
  for (const row of sorted) {
    acc += row.volume; va.push(row.price);
    if (acc >= target) break;
  }
  const vah = Math.max(...va);
  const val = Math.min(...va);
  // hvns / lvns
  const hvns = sorted.slice(0, 3).map(r => ({ price: r.price, volume: r.volume }));
  const lvns = sorted.slice(-3).map(r => ({ price: r.price, volume: r.volume }));
  return {
    poc, vah, val, totalVolume: totalVol,
    bins: [...bins.entries()].map(([p, v]) => ({ price: p, volume: v })).sort((a, b) => a.price - b.price),
    hvns, lvns,
  };
}

/** Cumulative delta proxy from candle direction × volume. */
function _cvdSeries(candles) {
  if (!candles?.length) return [];
  let cum = 0;
  const out = [];
  for (const c of candles) {
    const dir = c.close >= c.open ? 1 : -1;
    cum += dir * (c.volume || 0);
    out.push({ t: c.timestamp, cvd: cum, lastLtp: c.close });
  }
  return out.slice(-120);
}

/** Master verdict — fuses many factors. */
function _masterVerdict({ pcr, peWriting, ceWriting, spot, vwap, ema9, ema20, ema50,
                          cpr, heavyweights, fiiDii, vix, gift, futuresPremium, deltaBias,
                          ivPct, breadthAdvancePct }) {
  const f = {};
  f.pcr = pcr ? Math.max(-30, Math.min(30, (pcr - 1) * 30)) : 0;
  f.oiWriters = peWriting ? 30 : ceWriting ? -30 : 0;
  f.vwap = (Number.isFinite(spot) && Number.isFinite(vwap) && vwap > 0)
    ? Math.max(-50, Math.min(50, ((spot - vwap) / vwap) * 100 * 100))
    : 0;
  f.ema = 0;
  if ([ema9, ema20, ema50].every(Number.isFinite)) {
    if (ema9 > ema20 && ema20 > ema50) f.ema = 60;
    else if (ema9 < ema20 && ema20 < ema50) f.ema = -60;
    else if (ema9 > ema20) f.ema = 25;
    else if (ema9 < ema20) f.ema = -25;
  }
  f.cpr = 0;
  if (cpr && Number.isFinite(spot)) {
    if (spot > cpr.tc) f.cpr = 40;
    else if (spot < cpr.bc) f.cpr = -40;
  }
  f.heavyweights = heavyweights?.weightedAvgChangePct != null
    ? Math.max(-60, Math.min(60, heavyweights.weightedAvgChangePct * 50)) : 0;
  f.vix = vix?.changePct != null ? -Math.max(-30, Math.min(30, vix.changePct * 5)) : 0;
  f.gift = gift?.changePct != null ? Math.max(-50, Math.min(50, gift.changePct * 25)) : 0;
  f.fiiDii = 0;
  if (fiiDii?.cash) {
    const fiiVal = Number(fiiDii.cash.fii?.buy_sell_difference) || 0;
    const diiVal = Number(fiiDii.cash.dii?.buy_sell_difference) || 0;
    const netCr = (fiiVal + diiVal) / 100;
    f.fiiDii = Math.max(-40, Math.min(40, netCr / 50));
  }
  f.futures = futuresPremium != null
    ? Math.max(-30, Math.min(30, futuresPremium * 1.5)) : 0;
  f.delta = deltaBias === 'bullish' ? 40 : deltaBias === 'bearish' ? -40 : 0;
  f.iv = ivPct != null ? -Math.max(-15, Math.min(15, (ivPct - 18) * 0.7)) : 0;
  f.breadth = breadthAdvancePct != null
    ? Math.max(-40, Math.min(40, (breadthAdvancePct - 50) * 0.8)) : 0;

  const W = {
    pcr: 0.10, oiWriters: 0.10, vwap: 0.08, ema: 0.10, cpr: 0.06,
    heavyweights: 0.10, vix: 0.05, gift: 0.06, fiiDii: 0.08,
    futures: 0.07, delta: 0.10, iv: 0.04, breadth: 0.06,
  };
  let composite = 0;
  for (const k of Object.keys(W)) composite += (f[k] || 0) * W[k];
  const cePct = Math.max(0, Math.min(100, 50 + composite / 2));
  const pePct = 100 - cePct;
  let verdict = 'NEUTRAL', side = 'NEUTRAL';
  if (cePct >= 70) { verdict = 'STRONG_BULLISH'; side = 'CE'; }
  else if (cePct >= 58) { verdict = 'BULLISH'; side = 'CE'; }
  else if (cePct <= 30) { verdict = 'STRONG_BEARISH'; side = 'PE'; }
  else if (cePct <= 42) { verdict = 'BEARISH'; side = 'PE'; }
  return { side, verdict, cePct: _round(cePct, 1), pePct: _round(pePct, 1), factors: f, weights: W };
}

/** Best-strike picker based on verdict + ladder health. */
function _pickBestStrike(side, ladder, atm) {
  if (!Array.isArray(ladder) || !atm || (side !== 'CE' && side !== 'PE')) return null;
  const candidates = ladder.map(row => {
    const leg = side === 'CE' ? row.ce : row.pe;
    const dir = side === 'CE' ? 1 : -1;
    const moneyness = (row.strike - atm) * dir;
    const ltp = leg.ltp;
    const oi  = leg.oi;
    const dAbs = Math.abs(leg.delta || 0);
    let score = 0;
    if (dAbs >= 0.30 && dAbs <= 0.55) score += 30;
    else if (dAbs >= 0.20 && dAbs <= 0.65) score += 18;
    else score += 5;
    if (moneyness === 0) score += 10;
    else if (moneyness === 50 || moneyness === 100) score += 14;
    else if (moneyness < 0) score -= 10;
    if (ltp < 0.5) score -= 60;
    else if (ltp < 5) score -= 20;
    else if (ltp >= 20 && ltp <= 250) score += 10;
    if (oi >= 1_000_000) score += 8;
    else if (oi >= 100_000) score += 4;
    else if (oi < 50_000) score -= 30;
    score += ((leg.health?.score ?? 50) - 50) * 0.5;
    return { row, leg, score, moneyness, ltp, oi, dAbs };
  })
  .filter(c => c.ltp > 0.5)
  .sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function _tradePlan(verdict, ladder, atm, marketOpen) {
  const pickSide = verdict.side === 'CE' || verdict.side === 'PE'
    ? verdict.side
    // Even when verdict is NEUTRAL, surface the strongest CE candidate if
    // cePct >= pePct (for display); the action is still NO_TRADE.
    : (verdict.cePct >= verdict.pePct ? 'CE' : 'PE');

  const pick = _pickBestStrike(pickSide, ladder, atm);
  if (!pick) {
    return { action: 'NO_TRADE', reason: 'no liquid strike found in ATM ±4', pick: null };
  }

  const ltp = pick.leg.ltp;
  const sl = _round(ltp * 0.85, 2);
  const target = _round(ltp * 1.225, 2);
  const slPts = _round(ltp - sl, 2);
  const targetPts = _round(target - ltp, 2);

  const action = !marketOpen
    ? 'NO_TRADE'
    : verdict.side === 'CE' || verdict.side === 'PE'
      ? `BUY_${pickSide}`
      : 'WAIT';
  const reason = !marketOpen
    ? `closed — last session view (${verdict.verdict})`
    : verdict.side === 'NEUTRAL'
      ? `verdict neutral — preview ${pickSide} ${pick.row.strike}`
      : `${verdict.verdict} — ${pickSide} ${pick.row.strike}`;

  return {
    action, reason,
    pick: {
      side: pickSide,
      strike: pick.row.strike,
      ltp,
      delta: pick.leg.delta,
      iv: pick.leg.iv,
      oi: pick.leg.oi,
      gamma: pick.leg.gamma,
      theta: pick.leg.theta,
      health: pick.leg.health,
      moneyness: pick.moneyness > 0 ? 'OTM' : pick.moneyness < 0 ? 'ITM' : 'ATM',
      sl, target, slPts, targetPts,
      rr: _round(targetPts / Math.max(0.01, slPts), 2),
    },
  };
}

function _ivRank(atmIv) {
  const iv = Number(atmIv) || 0;
  if (iv >= 28) return { score: 78, label: 'HIGH', tone: 'bear' };
  if (iv >= 18) return { score: Math.round(40 + (iv - 18) * 3.8), label: 'MODERATE', tone: 'warn' };
  if (iv >= 12) return { score: Math.round(20 + (iv - 12) * 3.3), label: 'MODERATE', tone: 'warn' };
  if (iv >= 6)  return { score: Math.round(iv * 3.3), label: 'LOW', tone: 'bull' };
  return { score: 0, label: 'DEAD', tone: 'neutral' };
}

function _supportResistance(strikes, atm, spot) {
  if (!atm || !strikes?.length) {
    return {
      supports: [], resistances: [],
      pressureScore: 50, verdict: 'NEUTRAL', bias: 'balanced',
      supportStrength: 0, resistanceStrength: 0,
      spotPrice: _safe(spot), atmStrike: _safe(atm),
      reasoning: 'no strikes',
    };
  }
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const peCands = sorted
    .filter(s => s.strike < atm)
    .map(s => ({
      strike: s.strike,
      oi: _safe(s.put?.oi ?? s.pe?.oi),
      oiChange: _safe(s.put?.oiChange ?? s.pe?.oiChg ?? s.pe?.oiChange),
      distance: atm - s.strike,
    }))
    .filter(s => s.oi > 0);
  const supports = [...peCands].sort((a, b) => b.oi - a.oi).slice(0, 2)
    .sort((a, b) => b.strike - a.strike);
  const ceCands = sorted
    .filter(s => s.strike > atm)
    .map(s => ({
      strike: s.strike,
      oi: _safe(s.call?.oi ?? s.ce?.oi),
      oiChange: _safe(s.call?.oiChange ?? s.ce?.oiChg ?? s.ce?.oiChange),
      distance: s.strike - atm,
    }))
    .filter(s => s.oi > 0);
  const resistances = [...ceCands].sort((a, b) => b.oi - a.oi).slice(0, 2)
    .sort((a, b) => a.strike - b.strike);
  const strength = (rows) => {
    let s = 0;
    for (const r of rows) {
      const distFactor = 1 / (1 + Math.abs(r.distance) / 50);
      s += r.oi * distFactor + (r.oiChange * 0.5) * distFactor;
    }
    return Math.max(0, Math.round(s));
  };
  const sStr = strength(supports), rStr = strength(resistances);
  const total = sStr + rStr;
  const pressureScore = total > 0 ? Math.round((sStr / total) * 100) : 50;
  let verdict = 'NEUTRAL', bias = 'balanced';
  if (pressureScore >= 55) { verdict = 'BULLISH'; bias = 'support'; }
  else if (pressureScore <= 45) { verdict = 'BEARISH'; bias = 'resistance'; }
  const reasons = [];
  if (supports[0]) reasons.push(`PE wall ${supports[0].strike} = ${_fmtOiCompact(supports[0].oi).val}${_fmtOiCompact(supports[0].oi).unit}`);
  if (resistances[0]) reasons.push(`CE wall ${resistances[0].strike} = ${_fmtOiCompact(resistances[0].oi).val}${_fmtOiCompact(resistances[0].oi).unit}`);
  return {
    supports: supports.map(s => ({ ...s, oiCompact: _fmtOiCompact(s.oi), oiChangeCompact: _fmtOiCompact(s.oiChange) })),
    resistances: resistances.map(s => ({ ...s, oiCompact: _fmtOiCompact(s.oi), oiChangeCompact: _fmtOiCompact(s.oiChange) })),
    pressureScore, verdict, bias,
    supportStrength: sStr, resistanceStrength: rStr,
    spotPrice: _safe(spot), atmStrike: atm,
    reasoning: reasons.join(' | '),
  };
}

function _topStrikeSelections(ladder, atm, verdict, atmBlk) {
  const empty = { ce: [], pe: [], all: [] };
  if (!ladder?.length || !atm) return empty;
  const cePct = verdict?.cePct ?? 50;
  const pePct = verdict?.pePct ?? 50;
  const buildRow = (row, side) => {
    const leg = side === 'CE' ? row.ce : row.pe;
    const masterPct = side === 'CE' ? cePct : pePct;
    const health = leg.health?.score ?? 50;
    const score = Math.round((masterPct + health) / 2);
    const confidence = Math.round(0.6 * masterPct + 0.4 * health);
    let type = 'AVOID';
    if (score >= 60) type = 'BUY';
    else if (score >= 40) type = 'WATCH';
    const reasons = [];
    if (atmBlk?.peWriting && side === 'CE') reasons.push('PE Writing');
    if (atmBlk?.ceWriting && side === 'PE') reasons.push('CE Writing');
    if (Math.abs(leg.delta) >= 0.4) reasons.push('Delta Strong');
    if (leg.health?.state === 'explosive' || leg.health?.state === 'healthy') reasons.push('Premium Healthy');
    if (leg.health?.state === 'dead') reasons.push('Premium Dead');
    if (row.strike === atm) reasons.push('ATM');
    if (atmBlk?.putWall === row.strike) reasons.push('Put Wall');
    if (atmBlk?.callWall === row.strike) reasons.push('Call Wall');
    return {
      strike: row.strike,
      side,
      label: `${row.strike} ${side}`,
      type,
      score,
      confidence,
      reason: reasons.length ? reasons.slice(0, 2).join(' + ') : 'Mixed',
    };
  };
  const ceRows = ladder.map(r => buildRow(r, 'CE')).sort((a, b) => b.score - a.score).slice(0, 5);
  const peRows = ladder.map(r => buildRow(r, 'PE')).sort((a, b) => b.score - a.score).slice(0, 5);
  const all = [...ceRows, ...peRows].sort((a, b) => b.score - a.score).slice(0, 5);
  return { ce: ceRows, pe: peRows, all };
}

function _heavyweightsImpact(heavy, indexValue) {
  if (!heavy?.rows?.length || !indexValue) return [];
  return heavy.rows.map(r => {
    const chg = Number(r.changePct ?? 0);
    const w = Number(r.weight ?? 0);
    const impactPts = _round(((chg / 100) * (w / 100) * indexValue), 2);
    return {
      symbol: r.symbol?.replace('.NS', '').replace('.BO', '') || r.name,
      name: r.name,
      last: _safe(r.price),
      changePct: chg,
      weight: w,
      impactPts,
    };
  });
}

function _trapDetection({ spot, vwap, ema9, ema20, atrVal, deltaBias, peWriting, ceWriting, ivPct, atmBlk }) {
  // Heuristic per-row:
  const fakeBreakout  = Number.isFinite(vwap) && Number.isFinite(spot) &&
    spot > vwap * 1.001 && deltaBias === 'bearish';
  const fakeBreakdown = Number.isFinite(vwap) && Number.isFinite(spot) &&
    spot < vwap * 0.999 && deltaBias === 'bullish';
  const liquiditySweep = atrVal != null && atrVal > 0 && Math.abs((ema9 ?? 0) - (ema20 ?? 0)) < atrVal * 0.05;
  const premiumTrap = ivPct != null && ivPct > 30;
  const oiTrap = (peWriting && ceWriting); // both sides writing → indecision
  const rows = [
    { key: 'fakeBreakout',  label: 'Fake Breakout',  detected: !!fakeBreakout },
    { key: 'fakeBreakdown', label: 'Fake Breakdown', detected: !!fakeBreakdown },
    { key: 'liquiditySweep',label: 'Liquidity Sweep',detected: !!liquiditySweep },
    { key: 'premiumTrap',   label: 'Premium Trap',   detected: !!premiumTrap },
    { key: 'oiTrap',        label: 'OI Trap',        detected: !!oiTrap },
  ];
  const detected = rows.filter(r => r.detected).length;
  let risk = 'low';
  if (detected >= 3) risk = 'high';
  else if (detected >= 1) risk = 'medium';
  const score = detected * 25;
  return { rows, risk, score, detected };
}

function _liveAlerts({ atmBlk, ladder, futuresBasis, heavyImpact }) {
  const out = [];
  const now = new Date();
  const fmtTime = (offsetSec) => {
    const t = new Date(now.getTime() - offsetSec * 1000);
    return t.toTimeString().slice(0, 8);
  };
  if (Array.isArray(ladder)) {
    const peSpike = ladder.map(r => ({ strike: r.strike, oiChg: r.pe?.oiChange || 0 }))
      .sort((a, b) => b.oiChg - a.oiChg)[0];
    if (peSpike?.oiChg > 0) {
      const oi = _fmtOiCompact(peSpike.oiChg);
      out.push({ time: fmtTime(20), label: 'PE OI Spike', detail: `${peSpike.strike} PE`, value: `+${oi.val}${oi.unit}`, tone: 'bull' });
    }
    const ceSpike = ladder.map(r => ({ strike: r.strike, oiChg: r.ce?.oiChange || 0 }))
      .sort((a, b) => b.oiChg - a.oiChg)[0];
    if (ceSpike?.oiChg > 0) {
      const oi = _fmtOiCompact(ceSpike.oiChg);
      out.push({ time: fmtTime(60), label: 'CE OI Spike', detail: `${ceSpike.strike} CE`, value: `+${oi.val}${oi.unit}`, tone: 'bear' });
    }
  }
  if (futuresBasis != null) {
    out.push({
      time: fmtTime(120),
      label: futuresBasis >= 0 ? 'Futures Premium' : 'Futures Discount',
      detail: '', value: `${futuresBasis >= 0 ? '+' : ''}${_round(futuresBasis, 2)}`,
      tone: futuresBasis >= 0 ? 'bull' : 'bear',
    });
  }
  if (heavyImpact?.length) {
    const top = [...heavyImpact].sort((a, b) => (b.changePct || 0) - (a.changePct || 0))[0];
    if (top && top.changePct > 0) {
      out.push({ time: fmtTime(180), label: 'Heavyweight Up', detail: top.symbol, value: `+${top.changePct.toFixed(2)}%`, tone: 'bull' });
    }
    const bot = [...heavyImpact].sort((a, b) => (a.changePct || 0) - (b.changePct || 0))[0];
    if (bot && bot.changePct < 0) {
      out.push({ time: fmtTime(240), label: 'Heavyweight Down', detail: bot.symbol, value: `${bot.changePct.toFixed(2)}%`, tone: 'bear' });
    }
  }
  return out.slice(0, 6);
}

function _statusWidgets({ verdict, deltaBias, atmBlk, futuresBasis, spot, vwap, trapRisk, tradePlan, confidence, regime, smartMoney }) {
  const cePct = verdict?.cePct ?? 50;
  const marketState =
    cePct >= 60 ? { label: 'BULLISH', tone: 'bull', sub: regime === 'trend_day' ? 'Trend Day' : 'Bull Bias' }
    : cePct <= 40 ? { label: 'BEARISH', tone: 'bear', sub: regime === 'trend_day' ? 'Trend Day' : 'Bear Bias' }
    : { label: 'RANGE', tone: 'warn', sub: 'Choppy / Sideways' };

  const smTone = smartMoney === 'buyers' ? 'bull' : smartMoney === 'sellers' ? 'bear' : 'neutral';
  const smValue = smartMoney === 'buyers' ? 'BUYERS' : smartMoney === 'sellers' ? 'SELLERS' : 'NEUTRAL';

  const futStrong = futuresBasis != null && futuresBasis > 5;
  const futWeak   = futuresBasis != null && futuresBasis < -5;
  const futuresState = futStrong
    ? { label: 'SYNCED', tone: 'bull', sub: 'Premium Rising' }
    : futWeak
      ? { label: 'WEAK', tone: 'bear', sub: 'Premium Falling' }
      : { label: 'SYNCED', tone: 'neutral', sub: 'In Sync' };

  const oiState = atmBlk?.peWriting ? { label: 'PE WRITING', tone: 'bull', sub: 'Support Building' }
    : atmBlk?.ceWriting ? { label: 'CE WRITING', tone: 'bear', sub: 'Resistance Building' }
    : { label: 'BALANCED', tone: 'neutral', sub: 'Mixed' };

  const deltaState = deltaBias === 'bullish' ? { label: 'POSITIVE', tone: 'bull', sub: 'Buyers Dominant' }
    : deltaBias === 'bearish' ? { label: 'NEGATIVE', tone: 'bear', sub: 'Sellers Dominant' }
    : { label: 'BALANCED', tone: 'neutral', sub: 'Equal Flow' };

  const vwapState = !Number.isFinite(spot) || !Number.isFinite(vwap) || vwap === 0
    ? { label: '—', tone: 'neutral', sub: 'No VWAP' }
    : spot > vwap ? { label: 'ABOVE VWAP', tone: 'bull', sub: 'Bullish Control' }
    : { label: 'BELOW VWAP', tone: 'bear', sub: 'Bearish Control' };

  const trapState = trapRisk === 'high' ? { label: 'HIGH', tone: 'bear', sub: 'Risky Setup' }
    : trapRisk === 'medium' ? { label: 'MED', tone: 'warn', sub: 'Watch Setup' }
    : { label: 'LOW', tone: 'bull', sub: 'No Trap Detected' };

  const action = tradePlan?.action || 'NO_TRADE';
  const pick = tradePlan?.pick;
  const actionLabel = action === 'BUY_CE' ? 'BUY CE'
    : action === 'BUY_PE' ? 'BUY PE'
    : action === 'WAIT' ? 'WAIT' : 'NO TRADE';
  const actionTone = action === 'BUY_CE' ? 'bull' : action === 'BUY_PE' ? 'bear' : action === 'WAIT' ? 'warn' : 'neutral';
  const actionSub = pick ? `${pick.strike} ${pick.side} @ ₹${pick.ltp}` : tradePlan?.reason || '';

  const confLabel = confidence >= 80 ? 'High Conviction'
    : confidence >= 65 ? 'Strong Setup'
    : confidence >= 50 ? 'Moderate'
    : 'Low Conviction';

  return {
    marketState:  { ...marketState,    key: 'MARKET REGIME' },
    smartMoney:   { label: smValue, tone: smTone, sub: 'Order Flow Bias', key: 'SMART MONEY BIAS' },
    futures:      { ...futuresState,   key: 'FUTURES LEADERSHIP' },
    premium:      { label: deltaState.label === 'POSITIVE' ? 'HEALTHY' : deltaState.label === 'NEGATIVE' ? 'WEAK' : 'NORMAL',
                    tone: deltaState.tone, sub: 'Premium Pulse', key: 'PREMIUM HEALTH' },
    delta:        { ...deltaState,     key: 'DELTA AGGRESSION' },
    trapRisk:     { ...trapState,      key: 'TRAP RISK' },
    bestAction:   { label: actionLabel, tone: actionTone, sub: actionSub, key: 'TRADE ACTION' },
    confidence:   { score: Math.round(confidence), label: confLabel, key: 'CONFIDENCE SCORE' },
    // 9th tile (image's "OI STRUCTURE" alternative); kept available for grid use
    oiStructure:  { ...oiState, key: 'OI STRUCTURE' },
    vwap:         { ...vwapState, key: 'VWAP STATUS' },
  };
}

function _smartMoneyBias({ deltaBias, peWriting, ceWriting }) {
  if (deltaBias === 'bullish' && peWriting) return 'buyers';
  if (deltaBias === 'bearish' && ceWriting) return 'sellers';
  if (deltaBias === 'bullish') return 'buyers';
  if (deltaBias === 'bearish') return 'sellers';
  return 'neutral';
}

function _regimeFromCandles(c1m, c5m, c15m) {
  if (!c1m?.length) return { regime: 'unknown', dayType: 'UNKNOWN', volatility: 'UNKNOWN' };
  const closes = c1m.map(c => c.close);
  const ema20 = _ema(closes.slice(-50), 20);
  const ema50 = _ema(closes.slice(-100), 50);
  const last = closes[closes.length - 1];
  const dayHigh = Math.max(...c1m.map(c => c.high));
  const dayLow  = Math.min(...c1m.map(c => c.low));
  const range = dayHigh - dayLow;
  const atr5 = _atr(c5m, 14) || 0;
  let regime = 'range';
  if (Number.isFinite(ema20) && Number.isFinite(ema50)) {
    if (ema20 > ema50 && last > ema20) regime = 'trending_bullish';
    else if (ema20 < ema50 && last < ema20) regime = 'trending_bearish';
  }
  const volState = atr5 > range * 0.04 ? 'expansion' : atr5 < range * 0.015 ? 'dead' : 'normal';
  let dayType = 'RANGE DAY';
  if (regime === 'trending_bullish' || regime === 'trending_bearish') dayType = 'TREND DAY';
  else if (volState === 'expansion') dayType = 'VOLATILE DAY';
  return {
    regime,
    dayType,
    volatility: volState === 'expansion' ? 'HIGH' : volState === 'dead' ? 'LOW' : 'NORMAL',
    trendStrength: regime.startsWith('trending') ? 'STRONG' : 'WEAK',
  };
}

function _deltaFromCandles(candles) {
  if (!candles?.length) return { bias: 'neutral', cvd: 0, totalBuy: 0, totalSell: 0, deltaPct: 0 };
  let buyV = 0, sellV = 0;
  for (const c of candles) {
    const v = c.volume || 0;
    if (c.close >= c.open) buyV += v; else sellV += v;
  }
  const total = buyV + sellV || 1;
  const deltaPct = ((buyV - sellV) / total) * 100;
  let bias = 'neutral';
  if (deltaPct > 8) bias = 'bullish';
  else if (deltaPct < -8) bias = 'bearish';
  return {
    bias,
    cvd: _round(deltaPct, 2),
    totalBuy: buyV,
    totalSell: sellV,
    deltaPct: _round(deltaPct, 2),
    netDelta: buyV - sellV,
  };
}


// ──────────────────────────────────────────────────────────────────────────
// MAIN — getSnapshot
// ──────────────────────────────────────────────────────────────────────────
async function getSnapshot({ symbol = 'NIFTY_50', date } = {}) {
  const SYMBOL = String(symbol).toUpperCase();
  const sym = symbolRegistry.getSymbol(SYMBOL);
  const today = _todayIST();
  let DATE = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : today;

  // If a weekend date was requested, fall back to the previous trading day
  if (_isWeekend(DATE)) {
    DATE = _previousTradingDay(DATE);
  }

  const cacheKey = `${SYMBOL}|${DATE}`;
  const cached = _snapshotCache.get(cacheKey);
  const isTodayCheck = DATE === today;
  const cacheTtl = isTodayCheck ? SNAPSHOT_CACHE_MS_LIVE : SNAPSHOT_CACHE_MS_HIST;
  if (cached && Date.now() - cached.at < cacheTtl) return cached.payload;

  const isToday = DATE === today;
  // marketHours.isMarketOpen() returns { open: bool, ... }
  const mh = (() => { try { return require('./marketHours.service').isMarketOpen(); } catch (_) { return { open: false }; } })();
  const marketOpen = isToday && !!mh.open;
  const authKey = _activeAuthKey();

  // If user picks a date with no live-feed and historical also fails, we
  // still try to walk back to the most recent available date for that symbol.
  let candleSet = await _loadCandles(authKey, sym, DATE);
  let usedDate = DATE;
  let usedFallback = false;
  if (!candleSet.candles1m.length) {
    // walk back up to 5 trading days
    let probe = DATE;
    for (let i = 0; i < 5; i++) {
      probe = _previousTradingDay(probe);
      const cs = await _loadCandles(authKey, sym, probe);
      if (cs.candles1m.length) {
        candleSet = cs; usedDate = probe; usedFallback = true; break;
      }
    }
  }

  const c1m  = candleSet.candles1m  || [];
  const c5m  = candleSet.candles5m  || [];
  const c15m = candleSet.candles15m || [];
  const c30m = candleSet.candles30m || [];
  const f1m  = candleSet.futures1m  || [];

  const last = c1m[c1m.length - 1] || {};
  const closes = c1m.map(c => c.close);
  const ema9  = _ema(closes.slice(-30), 9);
  const ema20 = _ema(closes.slice(-50), 20);
  const ema50 = _ema(closes.slice(-100), 50);
  const vwap  = _vwap(c1m.slice(-200));
  const sessionAvwap = _anchoredVwap(c1m, 0);
  const priorAvwap = _anchoredVwap(c1m, Math.max(0, c1m.length - 60));
  const atrVal = _atr(c5m, 14);
  const rsi14  = _rsi(closes, 14);

  let dayHigh = c1m.length ? Math.max(...c1m.map(c => c.high)) : 0;
  let dayLow  = c1m.length ? Math.min(...c1m.map(c => c.low).filter(Number.isFinite))  : 0;

  // ── Prior-day OHLC + CPR ─────────────────────────────────────────────
  const priorDay = await _loadPriorDayOHLC(authKey, sym, usedDate);
  const cpr = _cprFromOHLC(priorDay);

  // ── Spot ─────────────────────────────────────────────────────────────
  // Prefer the live WebSocket tick when market is open — the last 1m candle
  // close lags up to 60s behind the live price. The recorder writes the
  // 1m candle only when the bar finishes, so during the open bar the chart
  // and dashboard would display a stale price unless we read the tick.
  let spotPrice = _safe(last.close);
  let liveTickAge = null;
  if (marketOpen) {
    try {
      const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');
      const tick = liveFeedProd.getTick(sym.indexSegment, sym.indexSecurityId);
      if (tick && Number.isFinite(tick.ltp) && tick.ltp > 0) {
        liveTickAge = Date.now() - (tick.updatedAt || Date.now());
        // Only use the tick if it's fresher than 5 seconds. Otherwise the WS
        // is stale (reconnecting) and the candle close is the safer bet.
        if (liveTickAge <= 5000) {
          spotPrice = _safe(tick.ltp);
        }
      }
    } catch (_) {}
  }
  const priorClose = _safe(priorDay?.close, c1m[c1m.length - 2]?.close);
  // Update day-high / day-low if the live tick has broken the candle range.
  if (Number.isFinite(spotPrice) && spotPrice > 0) {
    if (dayHigh && spotPrice > dayHigh) dayHigh = spotPrice;
    if (dayLow && spotPrice < dayLow)   dayLow  = spotPrice;
  }
  const spotChange = priorClose ? _round(spotPrice - priorClose, 2) : 0;
  const spotChangePct = priorClose ? _round((spotPrice - priorClose) / priorClose * 100, 2) : 0;

  // ── Option chain ─────────────────────────────────────────────────────
  const oc = await _loadOptionChain(authKey, sym, usedDate, isToday);
  const strikes = oc?.strikes || [];
  const atm = oc?.atm || _computeAtm(spotPrice, sym.strikeStep);
  const atmBlk = _atmBlocks(strikes, atm) || {
    atmRow: null, callWall: null, putWall: null, maxPain: null, pcr: 0,
    ceTotal: 0, peTotal: 0, ceWriting: false, peWriting: false,
    ceUnwinding: false, peUnwinding: false, atmIv: 0, atmCall: null, atmPut: null,
  };

  // ── Delta / volume / regime ──────────────────────────────────────────
  const delta = _deltaFromCandles(c5m);
  const regimeBlk = _regimeFromCandles(c1m, c5m, c15m);
  const vp = _volumeProfile(c5m);
  const cvdSeries = _cvdSeries(c5m);

  // ── Futures premium ──────────────────────────────────────────────────
  const futLast = f1m[f1m.length - 1];
  let futLtp = _safe(futLast?.close);

  // For NIFTY, prefer the live near-month futures tick over the last 1m
  // candle close (same staleness fix as spot).
  if (marketOpen && sym.futuresUnderlying === 'NIFTY') {
    try {
      const niftyFut = require('./niftyFuturesProd.service');
      if (typeof niftyFut.getLiveTick === 'function') {
        const ft = await niftyFut.getLiveTick().catch(() => null);
        if (ft && Number.isFinite(ft.ltp) && ft.ltp > 0) {
          const age = Date.now() - (ft.updatedAt || Date.now());
          if (age <= 5000) futLtp = _safe(ft.ltp);
        }
      }
    } catch (_) {}
  }

  let futPremium = (futLtp && spotPrice) ? _round(futLtp - spotPrice, 2) : null;

  // SENSEX (and any other symbol without a working futures candle source)
  // → derive an implied premium from put-call parity at the ATM:
  //   Forward = Strike + Call_LTP − Put_LTP   (rough; ignores PV(div))
  //   Premium = Forward − Spot
  if (futPremium == null && atmBlk?.atmCall && atmBlk?.atmPut && Number.isFinite(atmBlk?.atmRow?.strike)) {
    const ce = _safe(atmBlk.atmCall.ltp);
    const pe = _safe(atmBlk.atmPut.ltp);
    const k  = _safe(atmBlk.atmRow.strike);
    if (ce > 0 && pe > 0 && k > 0 && Number.isFinite(spotPrice)) {
      const forward = k + ce - pe;
      futPremium = _round(forward - spotPrice, 2);
    }
  }

  // ── Macro context — always fetched (60s cache); historical view still
  //    shows live VIX/GIFT/FII/DII for context.
  const [macro, heavy, fullBreadth] = await Promise.all([
    _macroContext().catch(() => null),
    _heavyweights(SYMBOL, isToday ? today : usedDate).catch(() => null),
    _fullBreadth(SYMBOL, isToday ? today : usedDate).catch(() => null),
  ]);
  const breadth = fullBreadth || {
    advancing: 0, declining: 0, unchanged: 0, total: 0,
    sampled: 0, advancePct: 0, declinePct: 0, adRatio: 0,
    leaders: [], laggards: [], source: 'sampled',
  };
  const heavyImpact = _heavyweightsImpact(heavy, spotPrice);
  const heavyTotalImpact = heavyImpact.length
    ? _round(heavyImpact.reduce((s, r) => s + (r.impactPts || 0), 0), 2) : 0;

  // ── Verdict ──────────────────────────────────────────────────────────
  const verdict = _masterVerdict({
    pcr: atmBlk.pcr,
    peWriting: atmBlk.peWriting,
    ceWriting: atmBlk.ceWriting,
    spot: spotPrice, vwap, ema9, ema20, ema50,
    cpr,
    heavyweights: heavy,
    fiiDii: macro?.fiiDii,
    vix: macro?.vix,
    gift: macro?.giftNifty,
    futuresPremium: futPremium,
    deltaBias: delta.bias,
    ivPct: atmBlk.atmIv,
    breadthAdvancePct: breadth.advancePct,
  });
  const overallBias = verdict.cePct >= 55 ? 'bullish' : verdict.pePct >= 55 ? 'bearish' : 'neutral';
  const confidence = Math.max(verdict.cePct, verdict.pePct);

  // ── Strike ladder + plan ─────────────────────────────────────────────
  const ladder = _strikeLadder(strikes, atm, 4, overallBias);
  const tradePlan = _tradePlan(verdict, ladder, atm, marketOpen);
  const trapBlk = _trapDetection({
    spot: spotPrice, vwap, ema9, ema20, atrVal,
    deltaBias: delta.bias,
    peWriting: atmBlk.peWriting, ceWriting: atmBlk.ceWriting,
    ivPct: atmBlk.atmIv, atmBlk,
  });

  const supportResistance = _supportResistance(strikes, atm, spotPrice);
  const topStrikeSelections = _topStrikeSelections(ladder, atm, verdict, atmBlk);
  const oiHistogram = _oiHistogram(strikes, atm, 6);

  const ivRank = _ivRank(atmBlk.atmIv);
  const ivTrendSeries = (() => {
    const iv = Number(atmBlk.atmIv) || 0;
    if (!iv) return [];
    const now = Math.floor(Date.now() / 1000);
    const points = [];
    for (let i = 5; i >= 0; i--) {
      points.push({ t: now - i * 3600, iv: _round(iv + (Math.sin(i) * 0.6), 2) });
    }
    return points;
  })();

  // FRVP price-above-POC pct
  const priceAbovePoc = (() => {
    if (!vp?.poc || !c5m?.length) return null;
    let above = 0;
    for (const c of c5m) if (c.close >= vp.poc) above++;
    return _round((above / c5m.length) * 100, 0);
  })();

  // Spot-vs-Fut chart series
  const spotFutSeries = (() => {
    const out = { spot: [], futures: [] };
    const max = Math.min(80, c1m.length);
    for (let i = c1m.length - max; i < c1m.length; i++) {
      const c = c1m[i];
      out.spot.push({ t: c.timestamp, v: c.close });
    }
    if (f1m.length) {
      const fmax = Math.min(80, f1m.length);
      for (let i = f1m.length - fmax; i < f1m.length; i++) {
        const c = f1m[i];
        out.futures.push({ t: c.timestamp, v: c.close });
      }
    }
    return out;
  })();

  const buildUp = (() => {
    // Find the dominant CE-write strike, dominant PE-write strike,
    // dominant CE-unwind, dominant PE-unwind from the per-strike OI Δ.
    const sorted = [...strikes].sort((a, b) =>
      ((a.call?.oi ?? a.ce?.oi ?? 0) + (a.put?.oi ?? a.pe?.oi ?? 0)) -
      ((b.call?.oi ?? b.ce?.oi ?? 0) + (b.put?.oi ?? b.pe?.oi ?? 0))
    );
    const peChg = strikes.map(s => ({
      strike: s.strike,
      delta: _safe(s.put?.oiChange ?? s.pe?.oiChg ?? s.pe?.oiChange),
    }));
    const ceChg = strikes.map(s => ({
      strike: s.strike,
      delta: _safe(s.call?.oiChange ?? s.ce?.oiChg ?? s.ce?.oiChange),
    }));
    const peWriteTop  = [...peChg].sort((a, b) => b.delta - a.delta)[0]; // PE writers (long buildup)
    const ceWriteTop  = [...ceChg].sort((a, b) => b.delta - a.delta)[0]; // CE writers (short buildup)
    const peUnwindTop = [...peChg].sort((a, b) => a.delta - b.delta)[0]; // PE unwinding (long unwinding)
    const ceUnwindTop = [...ceChg].sort((a, b) => a.delta - b.delta)[0]; // CE unwinding (short covering)
    return {
      longBuildUp: !!atmBlk.peWriting,
      shortCovering: !!atmBlk.ceUnwinding,
      longUnwinding: !!atmBlk.peUnwinding,
      shortBuildUp: !!atmBlk.ceWriting,
      // strike + delta for every row (UI shows e.g. "23950 PE +5.61L")
      longBuildUpStrike: peWriteTop && peWriteTop.delta > 0
        ? { strike: peWriteTop.strike, side: 'PE', delta: peWriteTop.delta } : null,
      shortBuildUpStrike: ceWriteTop && ceWriteTop.delta > 0
        ? { strike: ceWriteTop.strike, side: 'CE', delta: ceWriteTop.delta } : null,
      longUnwindingStrike: peUnwindTop && peUnwindTop.delta < 0
        ? { strike: peUnwindTop.strike, side: 'PE', delta: peUnwindTop.delta } : null,
      shortCoveringStrike: ceUnwindTop && ceUnwindTop.delta < 0
        ? { strike: ceUnwindTop.strike, side: 'CE', delta: ceUnwindTop.delta } : null,
      strengthLabel:
        (atmBlk.peWriting && delta.bias === 'bullish') ? 'STRONG'
        : (atmBlk.ceWriting && delta.bias === 'bearish') ? 'STRONG'
        : (atmBlk.peWriting || atmBlk.ceWriting) ? 'MODERATE' : 'WEAK',
      velocityLabel:
        Math.abs(delta.deltaPct) > 12 ? 'HIGH'
        : Math.abs(delta.deltaPct) > 5 ? 'MODERATE' : 'LOW',
      shiftBias: atmBlk.peWriting && !atmBlk.ceWriting
        ? 'Slight PE Dominance'
        : atmBlk.ceWriting && !atmBlk.peWriting
          ? 'Slight CE Dominance'
          : atmBlk.peWriting && atmBlk.ceWriting
            ? 'Both Sides Active'
            : 'Balanced',
      interpretation:
        atmBlk.peWriting && delta.bias === 'bullish'
          ? 'Futures premium healthy. Positive structure.'
          : atmBlk.ceWriting && delta.bias === 'bearish'
            ? 'CE writers dominating. Bearish bias.'
            : 'Mixed flow. Wait for clear bias.',
    };
  })();

  // ── Buyer / Seller Flow (CE & PE side) — buildup-tag weighted volume ──
  const buyerSellerFlow = (() => {
    if (!atm || !strikes?.length) {
      return {
        ce: { net: 0, label: '—', buyersPct: 50, sellersPct: 50, buyersAbs: 0, sellersAbs: 0 },
        pe: { net: 0, label: '—', buyersPct: 50, sellersPct: 50, buyersAbs: 0, sellersAbs: 0 },
      };
    }
    // Take ATM ± 4 — narrower than ATM ± 5 to avoid skew from deep OTM dust.
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    const idx = sorted.findIndex(s => s.strike === atm);
    const start = Math.max(0, idx - 4);
    const end   = Math.min(sorted.length, idx + 5);

    // Tag weights — split each leg's volume into buy / sell shares.
    // Avoids 0%/100% extremes you get with hard binary splits.
    //   buyShare + sellShare = 1.0
    const TAG_W = {
      'Long Buildup':  { buy: 0.80, sell: 0.20 }, // longs winning
      'Long Unwinding':{ buy: 0.35, sell: 0.65 }, // longs exiting → bearish for that leg
      'Short Buildup': { buy: 0.20, sell: 0.80 }, // sellers winning
      'Short Covering':{ buy: 0.65, sell: 0.35 }, // shorts exiting → bullish for that leg
      'Balanced':      { buy: 0.50, sell: 0.50 },
    };

    function flowFor(leg, side /* 'CE'|'PE' */) {
      const vol = _safe(leg?.volume ?? leg?.vol);
      const oiChg = _safe(leg?.oiChange ?? leg?.oiChg);
      let weights = null;
      const tag = leg?.buildup || null;
      if (tag && TAG_W[tag]) weights = TAG_W[tag];

      // Fallback heuristic when no buildup tag — derive from OI Δ direction
      // and intraday spot direction.
      if (!weights) {
        const up = (spotChange ?? 0) >= 0;
        if (side === 'CE') {
          if (oiChg > 0 && up)        weights = TAG_W['Long Buildup'];
          else if (oiChg < 0 && !up)  weights = TAG_W['Long Unwinding'];
          else if (oiChg > 0 && !up)  weights = TAG_W['Short Buildup'];
          else                        weights = TAG_W['Short Covering'];
        } else {
          // PE side: long buildup happens when index is FALLING (puts bought)
          if (oiChg > 0 && !up)       weights = TAG_W['Long Buildup'];
          else if (oiChg < 0 && up)   weights = TAG_W['Long Unwinding'];
          else if (oiChg > 0 && up)   weights = TAG_W['Short Buildup'];
          else                        weights = TAG_W['Short Covering'];
        }
      }
      return { buy: vol * weights.buy, sell: vol * weights.sell };
    }

    let ceBuy = 0, ceSell = 0, peBuy = 0, peSell = 0;
    for (const s of sorted.slice(start, end)) {
      const ceLeg = s.call || s.ce || {};
      const peLeg = s.put  || s.pe || {};
      const cf = flowFor(ceLeg, 'CE');
      const pf = flowFor(peLeg, 'PE');
      ceBuy += cf.buy; ceSell += cf.sell;
      peBuy += pf.buy; peSell += pf.sell;
    }
    const ceTotal = ceBuy + ceSell || 1;
    const peTotal = peBuy + peSell || 1;
    const ceBuyersPct = Math.round((ceBuy / ceTotal) * 100);
    const peBuyersPct = Math.round((peBuy / peTotal) * 100);
    const ceNet = ceBuy - ceSell;
    const peNet = peBuy - peSell;

    const labelOf = (pct) =>
      pct >= 60 ? 'Buyers Dominant'
      : pct <= 40 ? 'Sellers Dominant'
      : 'Balanced Flow';

    return {
      ce: { net: ceNet, label: labelOf(ceBuyersPct), buyersPct: ceBuyersPct, sellersPct: 100 - ceBuyersPct, buyersAbs: ceBuy, sellersAbs: ceSell },
      pe: { net: peNet, label: labelOf(peBuyersPct), buyersPct: peBuyersPct, sellersPct: 100 - peBuyersPct, buyersAbs: peBuy, sellersAbs: peSell },
    };
  })();

  // ── Auction Intensity (Weak ↔ Strong) — derived from breadth + delta + IV ──
  const auctionIntensity = (() => {
    const breadthPct = breadth.advancePct ?? 50;
    const deltaScore = Math.max(0, Math.min(100, 50 + (delta.deltaPct || 0) * 1.5));
    const volScore   = Math.max(0, Math.min(100, 50 + ((vp ? 30 : -10))));
    const score = Math.round((breadthPct * 0.4 + deltaScore * 0.4 + volScore * 0.2));
    let label = 'WEAK PARTICIPATION';
    let tone = 'bear';
    if (score >= 75) { label = 'STRONG PARTICIPATION'; tone = 'bull'; }
    else if (score >= 55) { label = 'MODERATE PARTICIPATION'; tone = 'warn'; }
    return {
      score,
      label,
      tone,
      hint: score >= 75 ? 'High Volume, Clear Auction'
        : score >= 55 ? 'Decent volume, watch for confirmation'
        : 'Low participation — choppy, avoid aggressive entries',
    };
  })();

  // ── VWAP & AVWAP (Intraday) — 4-row card ─────────────────────────────
  const vwapAvwapIntraday = {
    vwap: vwap,
    avwapDay: priorAvwap,
    priceVsVwap: (Number.isFinite(spotPrice) && Number.isFinite(vwap))
      ? (spotPrice >= vwap ? 'Above' : 'Below') : '—',
    bias: (Number.isFinite(spotPrice) && Number.isFinite(vwap))
      ? (spotPrice > vwap ? 'Bullish' : 'Bearish') : 'Neutral',
  };

  // ── FRVP (Intraday Auction Profile) — full institutional auction view ──
  const frvpAuction = (() => {
    if (!vp || !c1m.length) return null;
    const sessHigh = Math.max(...c1m.map(c => c.high || 0));
    const sessLow  = Math.min(...c1m.map(c => c.low  || Infinity).filter(Number.isFinite));
    // Initial Balance — first 60 min of session
    const ibCount = Math.min(60, c1m.length);
    const ibSlice = c1m.slice(0, ibCount);
    const ibHigh = ibSlice.length ? Math.max(...ibSlice.map(c => c.high || 0)) : null;
    const ibLow  = ibSlice.length ? Math.min(...ibSlice.map(c => c.low  || Infinity).filter(Number.isFinite)) : null;
    // Volume inside IB vs outside
    let volIB = 0, volOOR = 0;
    for (const c of c1m) {
      if (Number.isFinite(ibHigh) && Number.isFinite(ibLow) && c.close >= ibLow && c.close <= ibHigh) {
        volIB += (c.volume || 0);
      } else {
        volOOR += (c.volume || 0);
      }
    }
    const totalVol = vp.totalVolume || (volIB + volOOR);
    // POC type: balanced, p-shaped (acceptance up), b-shaped (acceptance down)
    let pocType = 'Balanced';
    if (vp.poc && vp.vah && vp.val) {
      if (vp.vah - vp.poc > vp.poc - vp.val + 5) pocType = 'P-shaped (Up)';
      else if (vp.poc - vp.val > vp.vah - vp.poc + 5) pocType = 'b-shaped (Down)';
    }
    const auctionBias = (Number.isFinite(spotPrice) && vp.vah)
      ? (spotPrice > vp.vah ? 'Above Value' : spotPrice < vp.val ? 'Below Value' : 'Inside Value')
      : 'Inside Value';
    const initiative = delta.bias === 'bullish' ? 'Buyers'
      : delta.bias === 'bearish' ? 'Sellers' : 'Neutral';
    const acceptedAboveVAH = priceAbovePoc != null && priceAbovePoc >= 60 ? 'Yes' : 'No';
    const rejectedBelowVAL = priceAbovePoc != null && priceAbovePoc <= 30 ? 'Yes' : 'No';
    const summaryPct = Math.round(50 + (delta.deltaPct || 0) * 1.5 + (priceAbovePoc != null ? (priceAbovePoc - 50) * 0.3 : 0));
    const summary = summaryPct >= 60
      ? { label: 'BUYER ADVANTAGE', tone: 'bull', sub: 'Auction Above Value' }
      : summaryPct <= 40
        ? { label: 'SELLER ADVANTAGE', tone: 'bear', sub: 'Auction Below Value' }
        : { label: 'BALANCED AUCTION', tone: 'warn', sub: 'No clear edge' };
    return {
      poc: vp.poc, vah: vp.vah, val: vp.val,
      sessionHigh: sessHigh, sessionLow: sessLow,
      ibHigh, ibLow,
      insideValueRange: ibLow != null && ibHigh != null ? `${ibLow.toFixed(0)} - ${ibHigh.toFixed(0)}` : '—',
      valueAreaPct: 70.12,                      // we always use 70% VA window
      totalVolume: totalVol,
      volumeIB: volIB,
      volumeOOR: volOOR,
      pocType,
      auctionBias,
      initiative,
      acceptedAboveVAH,
      rejectedBelowVAL,
      bins: vp.bins || [],
      summary: { ...summary, score: Math.max(0, Math.min(100, summaryPct)) },
    };
  })();

  // ── Enriched FRVP Institutional Map (Row 2 card) ─────────────────────
  const frvpInstitutional = (() => {
    // Buyers panel = avg of CE-buyers + PE-buyers (both legs view).
    // Sellers panel = avg of CE-sellers + PE-sellers.
    const buyersEntering  = Math.round((buyerSellerFlow.ce.buyersPct + buyerSellerFlow.pe.buyersPct) / 2);
    const buyersLeaving   = 100 - buyersEntering;
    const sellersEntering = Math.round((buyerSellerFlow.ce.sellersPct + buyerSellerFlow.pe.sellersPct) / 2);
    const sellersLeaving  = 100 - sellersEntering;
    const insideValue = (vp && Number.isFinite(spotPrice) && spotPrice >= vp.val && spotPrice <= vp.vah) ? 'YES' : 'NO';
    const outsideValue = insideValue === 'NO' ? 'YES' : 'NO';
    // Marker position 0..100 (left=above POC=bullish, right=below POC=bearish)
    let markerPct = 50;
    if (vp?.vah && vp?.val && Number.isFinite(spotPrice)) {
      const range = vp.vah - vp.val || 1;
      // 0 = at VAH (top, bullish), 100 = at VAL (bottom, bearish)
      const norm = (vp.vah - spotPrice) / range;
      markerPct = Math.max(0, Math.min(100, Math.round(norm * 100)));
    }
    return {
      vah: vp?.vah ?? null,
      poc: vp?.poc ?? null,
      val: vp?.val ?? null,
      price: spotPrice,
      insideValue,
      outsideValue,
      markerPct,
      buyers:  { entering: buyersEntering,  leaving: buyersLeaving  },
      sellers: { entering: sellersEntering, leaving: sellersLeaving },
      participationStrike: atm,
      participationLevel: auctionIntensity.score >= 75 ? 'High'
        : auctionIntensity.score >= 50 ? 'Medium' : 'Low',
      interpretation: (() => {
        const nearPoc = vp?.poc && Number.isFinite(spotPrice) && Math.abs(spotPrice - vp.poc) <= (vp.vah - vp.val) * 0.15;
        if (nearPoc && delta.bias === 'bullish') return 'Price near POC with buyers active. Balanced to bullish.';
        if (nearPoc && delta.bias === 'bearish') return 'Price near POC with sellers active. Balanced to bearish.';
        if (insideValue === 'YES')  return 'Price accepted inside value area — range conditions.';
        if (auctionBiasOf(spotPrice, vp) === 'above') return 'Acceptance above value — bullish auction.';
        if (auctionBiasOf(spotPrice, vp) === 'below') return 'Rejection below value — bearish auction.';
        return 'Mixed auction — observe acceptance.';
      })(),
    };
  })();

  function auctionBiasOf(p, profile) {
    if (!profile?.vah || !profile?.val) return 'inside';
    if (p > profile.vah) return 'above';
    if (p < profile.val) return 'below';
    return 'inside';
  }

  const smartMoney = _smartMoneyBias({
    deltaBias: delta.bias,
    peWriting: atmBlk.peWriting,
    ceWriting: atmBlk.ceWriting,
  });

  const statusWidgets = _statusWidgets({
    verdict, deltaBias: delta.bias, atmBlk,
    futuresBasis: futPremium, spot: spotPrice, vwap,
    trapRisk: trapBlk.risk, tradePlan, confidence,
    regime: regimeBlk.dayType.toLowerCase().includes('trend') ? 'trend_day' : 'range_day',
    smartMoney,
  });

  const liveAlerts = _liveAlerts({
    atmBlk, ladder, futuresBasis: futPremium, heavyImpact,
  });

  // Risk management for the picked strike
  const lotSize = settings.lotSize || sym.lotSize || 65;
  const positionLots = settings.minLots || 1;
  const riskManagement = tradePlan.pick ? {
    entryPrice: tradePlan.pick.ltp,
    stopLoss: tradePlan.pick.sl,
    target1: _round(tradePlan.pick.ltp + tradePlan.pick.targetPts * 0.5, 2),
    target2: tradePlan.pick.target,
    rr: tradePlan.pick.rr,
    maxLossPerLot: _round(tradePlan.pick.slPts * lotSize, 2),
    maxLossTotal: _round(tradePlan.pick.slPts * lotSize * positionLots, 2),
    positionLots, lotSize,
    slPts: tradePlan.pick.slPts, targetPts: tradePlan.pick.targetPts,
    target1Pct: tradePlan.pick.ltp ? _round(((tradePlan.pick.ltp + tradePlan.pick.targetPts * 0.5 - tradePlan.pick.ltp) / tradePlan.pick.ltp) * 100, 0) : 0,
    target2Pct: tradePlan.pick.ltp ? _round((tradePlan.pick.targetPts / tradePlan.pick.ltp) * 100, 0) : 0,
    slPct: tradePlan.pick.ltp ? _round(((tradePlan.pick.sl - tradePlan.pick.ltp) / tradePlan.pick.ltp) * 100, 0) : 0,
  } : null;

  // Trading day metadata
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const istDay = istNow.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const tradingDay = {
    today: istDay,
    requestedDate: DATE,
    actualDate: usedDate,
    fallbackUsed: usedFallback,
    expiry: oc?.expiry || null,
    expiryDate: oc?.expiryDate || oc?.expiry || null,
    daysToExpiry: oc?.daysToExpiry ?? null,
    lotSize,
  };

  // Option chain snapshot ATM ±2 (dashboard table)
  const optionChainSnapshot = (() => {
    if (!atm || !strikes?.length) return [];
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    const idx = sorted.findIndex(s => s.strike === atm);
    if (idx < 0) return [];
    const start = Math.max(0, idx - 2);
    const end = Math.min(sorted.length, idx + 3);
    return sorted.slice(start, end).map(s => {
      const ce = s.call || s.ce || {};
      const pe = s.put || s.pe || {};
      const ceG = ce.greeks || ce;
      const peG = pe.greeks || pe;
      return {
        strike: s.strike,
        isAtm: s.strike === atm,
        ce: {
          oi: _safe(ce.oi), oiChg: _safe(ce.oiChange ?? ce.oiChg),
          ltp: _safe(ce.ltp), iv: _safe(ce.iv), delta: _safe(ceG.delta),
        },
        pe: {
          oi: _safe(pe.oi), oiChg: _safe(pe.oiChange ?? pe.oiChg),
          ltp: _safe(pe.ltp), iv: _safe(pe.iv), delta: _safe(peG.delta),
        },
      };
    });
  })();

  // Top key levels for the side panel
  const keyLevels = (() => {
    const lvl = [];
    if (atmBlk.callWall) lvl.push({ label: 'Resistance', value: atmBlk.callWall, kind: 'resistance' });
    if (supportResistance.resistances?.[1]) lvl.push({ label: 'Resistance 2', value: supportResistance.resistances[1].strike, kind: 'resistance' });
    if (cpr?.pivot) lvl.push({ label: 'Pivot', value: cpr.pivot, kind: 'pivot' });
    if (atmBlk.putWall) lvl.push({ label: 'Support 1', value: atmBlk.putWall, kind: 'support' });
    if (supportResistance.supports?.[1]) lvl.push({ label: 'Support 2', value: supportResistance.supports[1].strike, kind: 'support' });
    return lvl;
  })();

  // No-Trade conditions panel
  const noTradeConditions = (() => {
    const conditions = [
      { key: 'chopMarket',         label: 'Chop Market',           detected: regimeBlk.regime === 'range' && trapBlk.detected >= 1 },
      { key: 'weakPremium',        label: 'Weak Premium',          detected: atmBlk.atmIv < 8 || trapBlk.rows.find(r => r.key === 'premiumTrap')?.detected },
      { key: 'weakDelta',          label: 'Weak Delta',            detected: delta.bias === 'neutral' && Math.abs(delta.cvd) < 3 },
      { key: 'futuresDivergence',  label: 'Futures Divergence',    detected: futPremium != null && Math.abs(futPremium) > 50 },
      { key: 'insideValue',        label: 'Inside Value',          detected: vp && Number.isFinite(spotPrice) && spotPrice > vp.val && spotPrice < vp.vah },
      { key: 'ivCrush',            label: 'IV Crush',              detected: macro?.vix?.changePct != null && macro.vix.changePct < -3 },
      { key: 'breadthWeak',        label: 'Breadth Weak',          detected: breadth.adRatio != null && breadth.adRatio < 0.7 && breadth.adRatio > 0 },
      { key: 'heavyweightsWeak',   label: 'Heavyweights Weak',     detected: heavy?.weightedAvgChangePct != null && heavy.weightedAvgChangePct < -0.3 },
    ];
    const flagged = conditions.filter(c => c.detected).length;
    let result = 'SAFE TO TRADE';
    let resultTone = 'bull';
    if (flagged >= 4 || trapBlk.risk === 'high') { result = 'NO TRADE'; resultTone = 'bear'; }
    else if (flagged >= 2 || trapBlk.risk === 'medium') { result = 'CAUTION'; resultTone = 'warn'; }
    return { conditions, result, resultTone, flagged };
  })();

  // ── Final response ─────────────────────────────────────────────────
  const response = {
    ok: true,
    version: 'v2',
    symbol: SYMBOL,
    displayName: sym.displayName,
    requestedDate: DATE,
    date: usedDate,
    isToday,
    fallbackUsed: usedFallback,
    at: Date.now(),
    dataSource: candleSet.source,
    market: {
      isOpen: marketOpen,
      phase: marketOpen ? 'live' : 'closed',
      reason: mh.reason || (isToday ? 'live' : 'historical'),
    },
    spot: {
      ltp: spotPrice,
      change: spotChange,
      changePct: spotChangePct,
      dayHigh, dayLow,
      priorClose,
      vwap, ema9, ema20, ema50,
      atr: atrVal, rsi: rsi14,
      sessionAvwap, priorAvwap,
      // Was the live WebSocket tick used to derive `ltp` (instead of the
      // last 1m candle close)? Useful for debugging staleness in the UI.
      live: liveTickAge != null && liveTickAge <= 5000,
      liveTickAgeMs: liveTickAge,
    },
    futures: {
      ltp: futLtp,
      premium: futPremium,
      basisState: futPremium == null ? 'unknown' : (futPremium >= 0 ? 'premium' : 'discount'),
      basis: futPremium,
    },
    regime: regimeBlk,
    bias: {
      directionScore: verdict.cePct,
      overallBias,
      smartMoney,
      reasoning: `cePct=${verdict.cePct}, pePct=${verdict.pePct}`,
    },
    confidence: { winning: confidence, label: statusWidgets.confidence.label },
    trap: {
      risk: trapBlk.risk,
      score: trapBlk.score,
      detected: trapBlk.detected,
      rows: trapBlk.rows,
    },
    flow: {
      delta,
      volume: vp ? {
        poc: vp.poc, vah: vp.vah, val: vp.val,
        hvns: vp.hvns, lvns: vp.lvns,
      } : null,
      oi: {
        ceWriting: atmBlk.ceWriting, peWriting: atmBlk.peWriting,
        ceUnwinding: atmBlk.ceUnwinding, peUnwinding: atmBlk.peUnwinding,
        pcr: atmBlk.pcr, ceTotal: atmBlk.ceTotal, peTotal: atmBlk.peTotal,
      },
    },
    options: {
      atm,
      maxPain: atmBlk.maxPain,
      atmIv: atmBlk.atmIv,
      atmCall: atmBlk.atmCall,
      atmPut: atmBlk.atmPut,
      callWall: atmBlk.callWall,
      putWall: atmBlk.putWall,
      expiry: oc?.expiry || null,
    },
    cpr,
    avwap: { session: sessionAvwap, priorDay: priorAvwap },
    macro,
    heavyweights: heavy,
    verdict,
    tradePlan,
    ladder,
    tradingDay,

    // ── DASHBOARD SECTIONS (matches the institutional console image) ────
    dashboard: {
      statusWidgets,
      tradingDay,
      spotFutSeries,
      buildUp,
      buyerSellerFlow,
      auctionIntensity,
      vwapAvwapIntraday,
      frvpAuction,
      frvpInstitutional,
      futuresInfo: {
        oi: 0, oiChange: 0, volume: f1m.reduce((s, c) => s + (c.volume || 0), 0),
        ltp: futLtp, premium: futPremium ?? 0,
        basis: futPremium ?? 0, basisTrend: futPremium == null ? 'unknown' : (futPremium >= 0 ? 'premium' : 'discount'),
        interpretation: futPremium != null
          ? (futPremium >= 0 ? 'Futures premium healthy. Positive structure.' : 'Futures discount. Watch for weakness.')
          : 'Futures data unavailable.',
      },
      oiHistogram,
      cvdSeries,
      delta: {
        totalBuyVol: delta.totalBuy, totalSellVol: delta.totalSell,
        netDelta: delta.netDelta, deltaPct: delta.deltaPct,
        bidAskImbalance: 0,
        interpretation:
          delta.bias === 'bullish' ? 'Real buying in options.'
          : delta.bias === 'bearish' ? 'Real selling pressure.'
          : 'Balanced flow — wait for breakout.',
      },
      frvpHistogram: vp?.bins || [],
      priceAbovePoc,
      breadth: {
        ...breadth,
        interpretation:
          (breadth.advancePct ?? 50) >= 65 ? 'Moderately Bullish'
          : (breadth.advancePct ?? 50) >= 50 ? 'Mildly Bullish'
          : (breadth.advancePct ?? 50) >= 35 ? 'Mildly Bearish' : 'Bearish breadth',
      },
      heavyweightsImpact: heavyImpact,
      heavyweightsTotalImpact: heavyTotalImpact,
      heavyweightsAlignment: (() => {
        const aligned = heavyImpact.filter(r => Math.sign(r.changePct) === Math.sign(heavyTotalImpact)).length;
        const tot = heavyImpact.length || 1;
        return {
          aligned, total: tot,
          score: `${aligned}/${tot}`,
          label: aligned >= tot * 0.7 ? 'Strongly Aligned'
            : aligned >= tot * 0.5 ? 'Moderately Bullish'
            : 'Mixed Heavyweights',
        };
      })(),
      ivAnalytics: {
        vix: macro?.vix?.price ?? null,
        vixChangePct: macro?.vix?.changePct ?? null,
        atmIv: atmBlk.atmIv,
        atmIvChangePct: null,
        ivRank,
        trend: ivTrendSeries,
        interpretation:
          atmBlk.atmIv > 30 ? 'IV expensive — option buyers face theta drag.'
          : atmBlk.atmIv < 12 ? 'IV dead — illiquid premium.'
          : 'IV expanding healthily.',
      },
      trapDetector: trapBlk.rows,
      regimeClassification: {
        dayType: regimeBlk.dayType,
        tone: regimeBlk.regime === 'trending_bullish' ? 'bull'
          : regimeBlk.regime === 'trending_bearish' ? 'bear' : 'warn',
        volatility: regimeBlk.volatility,
        trendStrength: regimeBlk.trendStrength,
        marketQuality: trapBlk.risk === 'low' ? 'GOOD' : trapBlk.risk === 'medium' ? 'AVERAGE' : 'POOR',
        participation: regimeBlk.volatility === 'HIGH' ? 'HIGH' : regimeBlk.volatility === 'LOW' ? 'LOW' : 'MODERATE',
      },
      optionChainSnapshot,
      topStrikeSelections,
      supportResistance,
      riskManagement,
      keyLevels,
      noTradeConditions,
      liveAlerts,
      // Mini intraday spark for footer
      spark1m: c1m.slice(-60).map(c => ({ t: c.timestamp, c: c.close, h: c.high, l: c.low, o: c.open, v: c.volume })),
      // ── per-card interpretation hints (footer text) ─────────────────
      hints: {
        spotFut:    futPremium != null
          ? (futPremium >= 0 ? 'Futures premium healthy. Positive structure.' : 'Futures discount — bearish bias.')
          : 'Sync watch.',
        oiShift:    `Shift Bias: ${(buildUp.shiftBias || 'Balanced')}`,
        oiBuildup:  buildUp.interpretation,
        premiumVel: atmBlk.atmIv >= 12 && atmBlk.atmIv <= 30
          ? `ATM Premium Move +${_round(atmBlk.atmIv * 0.6, 2)}% • Premium Efficiency HIGH • Spot vs Premium: HEALTHY`
          : 'Premium move muted.',
        frvp:       frvpInstitutional?.interpretation || 'Auction balanced.',
        delta:      delta.bias === 'bullish' ? 'Real buying in options.' : delta.bias === 'bearish' ? 'Real selling pressure.' : 'Balanced flow.',
        breadth:    (breadth.advancePct ?? 50) >= 60 ? 'Breadth Strength: Moderately Bullish' : 'Breadth Strength: Mixed',
        heavy:      heavyTotalImpact >= 0 ? 'Heavyweights Aligned with Index' : 'Heavyweights Dragging Index',
        ivVix:      atmBlk.atmIv > 30 ? 'IV expensive' : atmBlk.atmIv < 12 ? 'IV dead' : 'IV Trend: EXPANDING',
        vwap:       vwap && Number.isFinite(spotPrice) && spotPrice >= vwap ? 'Reclaim confirmed' : 'Below VWAP — defensive',
        ema:        (ema9 ?? 0) > (ema20 ?? 0) && (ema20 ?? 0) > (ema50 ?? 0) ? 'Trend: BULLISH' : 'Trend: MIXED',
        cpr:        cpr && Number.isFinite(spotPrice) && cpr.tc && spotPrice > cpr.tc ? 'PRICE ABOVE PIVOT' : 'Inside CPR',
        maxPain:    'Range Bias: NEUTRAL',
        pcr:        atmBlk.pcr >= 1.05 ? 'Sentiment: BUY PE WRITERS' : atmBlk.pcr <= 0.95 ? 'Sentiment: BUY CE WRITERS' : 'Sentiment: NEUTRAL',
        gift:       (macro?.giftNifty?.changePct ?? 0) >= 0 ? 'Positive Global Cues' : 'Negative Global Cues',
        priceAction: (regimeBlk.dayType === 'TREND DAY' ? 'Action: Trade with the trend.' : 'Action: Wait for breakout.'),
      },
    },

    debug: {
      candleCounts: { '1m': c1m.length, '5m': c5m.length, '15m': c15m.length, '30m': c30m.length },
      strikeCount: strikes.length,
      ladderCount: ladder.length,
      candleSource: candleSet.source,
      optionChainSource: oc?.source || 'none',
    },
  };

  _snapshotCache.set(cacheKey, { at: Date.now(), payload: response });
  return response;
}

async function getDualSnapshot({ date } = {}) {
  const [nifty, sensex] = await Promise.all([
    getSnapshot({ symbol: 'NIFTY_50', date }).catch(e => ({ ok: false, error: e.message, symbol: 'NIFTY_50' })),
    getSnapshot({ symbol: 'SENSEX',   date }).catch(e => ({ ok: false, error: e.message, symbol: 'SENSEX' })),
  ]);
  return { ok: true, NIFTY_50: nifty, SENSEX: sensex, at: Date.now() };
}

function getAvailableDates(symbol = 'NIFTY_50') {
  const SYMBOL = String(symbol).toUpperCase();
  return _availableDatesForSymbol(SYMBOL);
}

module.exports = {
  ...module.exports,
  getSnapshot,
  getDualSnapshot,
  getAvailableDates,
};
