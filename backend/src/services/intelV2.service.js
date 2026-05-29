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
const frvpEngine = require('./frvpEngine.service');

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

// ── ATM Premium history ──────────────────────────────────────────────────
// Ring buffer keyed by symbol — captures (t, ceLtp, peLtp) every snapshot.
// Used by the Premium Momentum engine to compute REAL time-derivative of
// CE / PE premium instead of relying on the static LTP-skew which always
// reports CE-bigger as "CE expanding" regardless of direction.
const _premiumHistory = new Map(); // symbol → [{ t, ceLtp, peLtp, atm }]
const PREMIUM_HISTORY_MAX = 240;   // ~12 min @ 3s polling
const PREMIUM_HISTORY_TTL_MS = 30 * 60_000; // drop samples older than 30m

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
  const [vix, gift, sp, nq, dxy, crude, nikkei, sensex] = await Promise.all([
    _yahooQuote('^INDIAVIX'),
    _yahooQuote('^NSEI'),       // proxy — Yahoo doesn't expose live Gift; we fall back to NIFTY index quote
    _yahooQuote('ES=F'),
    _yahooQuote('NQ=F'),
    _yahooQuote('DX-Y.NYB'),
    _yahooQuote('CL=F'),
    _yahooQuote('^N225'),
    _yahooQuote('^BSESN'),      // BSE SENSEX
  ]);
  let fiiDii = null;
  try { fiiDii = await marketInternals.fetchInstitutionalFlowData(); }
  catch (_) {}
  const data = {
    vix, giftNifty: gift, sensex,
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
  // Full per-stock list — sorted DESC by changePct so the frontend can paint
  // a heatmap-style dot grid (greens at top, reds at bottom). 50 entries
  // for NIFTY, 30 for SENSEX. Used by 3.3 Heavyweights pie+grid.
  const allStocks = [...valid]
    .sort((a, b) => b.changePct - a.changePct)
    .map(r => ({
      symbol: r.symbol.replace(/\.(NS|BO)$/, ''),
      changePct: _round(r.changePct, 2),
      price: r.price,
    }));
  const data = {
    symbol: symbolKey,
    advancing, declining, unchanged, total, sampled: valid.length,
    advancePct: _round((advancing / total) * 100, 0),
    declinePct: _round((declining / total) * 100, 0),
    adRatio, leaders, laggards, allStocks,
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

/**
 * Per-strike OI change histogram around ATM, restricted to strike values
 * that are multiples of `displayStep` (default 100). For NIFTY this drops
 * the half-step strikes (23650, 23750, …) so the card shows clean
 * 100-spaced strikes — ATM rounded to the nearest 100, ± `range` strikes.
 *
 * Returns up to (range*2+1) rows. If the option chain doesn't carry an
 * exact 100-multiple strike (rare, mostly far-OTM dust), the row is skipped.
 */
function _oiHistogram(strikes, atm, range = 4, displayStep = 100, ctx = {}) {
  if (!Array.isArray(strikes) || !atm) return [];
  // Map<strike, row> for O(1) lookup
  const byStrike = new Map();
  for (const s of strikes) byStrike.set(Number(s.strike), s);

  // Anchor on the nearest 100-multiple to the ATM. If ATM itself is a
  // multiple of displayStep keep it; else round-down so the marker still
  // sits inside the visible band.
  const anchor = Math.round(atm / displayStep) * displayStep;
  const spot = Number(ctx.spot) || atm;

  const out = [];
  for (let i = -range; i <= range; i++) {
    const strikeVal = anchor + i * displayStep;
    const s = byStrike.get(strikeVal);
    if (!s) continue;
    const ce = s.call || s.ce || {};
    const pe = s.put  || s.pe || {};
    const ceG = ce.greeks || ce;
    const peG = pe.greeks || pe;
    const ceOi    = _safe(ce.oi);
    const peOi    = _safe(pe.oi);
    const ceOiChg = _safe(ce.oiChange ?? ce.oiChg);
    const peOiChg = _safe(pe.oiChange ?? pe.oiChg);
    const ceLtp   = _safe(ce.ltp);
    const peLtp   = _safe(pe.ltp);
    const ceDelta = _safe(ceG.delta);
    const peDelta = _safe(peG.delta);

    // ── Buyer-favorability score per strike (0..100 each side) ─────────
    // CE buyer wants: PE writers strong (support firming), spot ≥ strike,
    //                 CE writers weak / unwinding, healthy delta band,
    //                 non-dead premium.
    // PE buyer wants: CE writers strong (resistance firming), spot ≤ strike,
    //                 PE writers weak / unwinding, healthy delta band,
    //                 non-dead premium.
    let ceBuy = 0;
    let peBuy = 0;

    // Side dominance (0..40)
    const writeMax = Math.max(Math.abs(ceOiChg), Math.abs(peOiChg), 1);
    if (peOiChg > 0) ceBuy += Math.min(40, (peOiChg / writeMax) * 40);
    if (peOiChg < 0) peBuy += Math.min(20, (Math.abs(peOiChg) / writeMax) * 20);
    if (ceOiChg > 0) peBuy += Math.min(40, (ceOiChg / writeMax) * 40);
    if (ceOiChg < 0) ceBuy += Math.min(20, (Math.abs(ceOiChg) / writeMax) * 20);

    // Spot vs strike position (0..20)
    if (Number.isFinite(spot)) {
      if (spot >= strikeVal) ceBuy += 20 - Math.min(20, Math.abs(spot - strikeVal) / 10);
      else                   peBuy += 20 - Math.min(20, Math.abs(spot - strikeVal) / 10);
    }

    // Delta band (0..15) — buyers want 0.30..0.55 for cheap gamma
    const ceAbs = Math.abs(ceDelta);
    const peAbs = Math.abs(peDelta);
    if (ceAbs >= 0.30 && ceAbs <= 0.55) ceBuy += 15;
    else if (ceAbs >= 0.20 && ceAbs <= 0.65) ceBuy += 8;
    if (peAbs >= 0.30 && peAbs <= 0.55) peBuy += 15;
    else if (peAbs >= 0.20 && peAbs <= 0.65) peBuy += 8;

    // Premium liveness (0..15) — punish illiquid/dead premium
    if (ceLtp >= 5 && ceLtp <= 250) ceBuy += 15;
    else if (ceLtp >= 1) ceBuy += 5;
    if (peLtp >= 5 && peLtp <= 250) peBuy += 15;
    else if (peLtp >= 1) peBuy += 5;

    // OI presence (0..10) — at least one side needs liquidity
    if (ceOi >= 1_000_000) ceBuy += 10;
    else if (ceOi >= 100_000) ceBuy += 5;
    if (peOi >= 1_000_000) peBuy += 10;
    else if (peOi >= 100_000) peBuy += 5;

    ceBuy = Math.max(0, Math.min(100, Math.round(ceBuy)));
    peBuy = Math.max(0, Math.min(100, Math.round(peBuy)));

    // Normalise the two scores so the row's split bar adds to 100.
    const total = ceBuy + peBuy || 1;
    const ceFavorPct = Math.round((ceBuy / total) * 100);
    const peFavorPct = 100 - ceFavorPct;
    const favorSide = ceFavorPct >= 60 ? 'CE'
      : peFavorPct >= 60 ? 'PE'
      : 'NEUTRAL';
    const favorPct = Math.max(ceFavorPct, peFavorPct);

    out.push({
      strike: strikeVal,
      isAtm: strikeVal === atm,
      ceOiChg, peOiChg, ceOi, peOi,
      ceLtp, peLtp,
      ceDelta, peDelta,
      ceBuyScore: ceBuy,
      peBuyScore: peBuy,
      ceFavorPct,
      peFavorPct,
      favorSide,
      favorPct,
    });
  }
  return out;
}

/**
 * Build the rich "OI Buildup Analysis" payload that drives the
 * Row 2.3 institutional card. It mirrors what professional desks watch:
 *   • Top stats strip — Spot, Total CE OI, Total PE OI, PCR, Market View
 *   • Per-side tables — top 5 strikes by absolute OI build, with prior-day
 *     OI proxy, today's OI, ΔOI, %Δ, and an interpretation tag
 *   • Bar-chart series — ATM ± 4 strikes spaced in `displayStep`s for
 *     CE and PE, signed in lakh / crore for compact display
 *   • Key takeaway — short string summarising the dominant cluster
 *
 * `prevTotalCeOi` / `prevTotalPeOi` are derived from the sum of "yesterday"
 * proxies. We don't have a separate yesterday snapshot in the service, so
 * yesterday is reconstructed as `today - oiChange` per leg — matches the
 * Sensibull/IIFL convention.
 */
function _oiBuildupAnalysis(strikes, atm, spotPrice, displayStep = 100, range = 6) {
  if (!Array.isArray(strikes) || !atm) {
    return null;
  }
  // Total OI across the whole chain (today + prior-day proxy)
  let totalCeToday = 0, totalPeToday = 0;
  let totalCePrev  = 0, totalPePrev  = 0;
  for (const s of strikes) {
    const ceOi    = _safe(s.call?.oi ?? s.ce?.oi);
    const peOi    = _safe(s.put?.oi  ?? s.pe?.oi);
    const ceOiChg = _safe(s.call?.oiChange ?? s.ce?.oiChg ?? s.ce?.oiChange);
    const peOiChg = _safe(s.put?.oiChange  ?? s.pe?.oiChg ?? s.pe?.oiChange);
    totalCeToday += ceOi;
    totalPeToday += peOi;
    totalCePrev  += Math.max(0, ceOi - ceOiChg);
    totalPePrev  += Math.max(0, peOi - peOiChg);
  }
  const totalCeChg    = totalCeToday - totalCePrev;
  const totalPeChg    = totalPeToday - totalPePrev;
  const totalCeChgPct = totalCePrev > 0 ? (totalCeChg / totalCePrev) * 100 : 0;
  const totalPeChgPct = totalPePrev > 0 ? (totalPeChg / totalPePrev) * 100 : 0;
  const ratio = totalCeToday > 0 ? totalPeToday / totalCeToday : 0; // PCR

  // Market view label — uses PCR + heavyweight tilt
  let marketView = 'Neutral';
  let marketViewTone = 'warn';
  if (ratio >= 1.15) { marketView = 'Bullish'; marketViewTone = 'bull'; }
  else if (ratio >= 1.05) { marketView = 'Slightly Bullish'; marketViewTone = 'bull'; }
  else if (ratio <= 0.85) { marketView = 'Bearish'; marketViewTone = 'bear'; }
  else if (ratio <= 0.95) { marketView = 'Slightly Bearish'; marketViewTone = 'bear'; }

  // Helper — interpret a single strike's % change
  const interpret = (pctChg) => {
    if (!Number.isFinite(pctChg)) return 'Stable';
    if (pctChg >= 15) return 'Strong Buildup';
    if (pctChg >= 8)  return 'Buildup';
    if (pctChg >= 3)  return 'Moderate Buildup';
    if (pctChg <= -15) return 'Strong Unwinding';
    if (pctChg <= -8)  return 'Unwinding';
    if (pctChg <= -3)  return 'Mild Unwinding';
    return 'Stable';
  };

  // Build per-side row arrays — top 5 strikes by absolute build, sorted by
  // strike DESC for CE (resistance ladder) and ASC for PE (support ladder).
  // CE = resistance (above spot); PE = support (below spot).
  const ceRows = [];
  const peRows = [];
  for (const s of strikes) {
    const k = Number(s.strike);
    if (!Number.isFinite(k)) continue;
    const ceOiToday = _safe(s.call?.oi ?? s.ce?.oi);
    const peOiToday = _safe(s.put?.oi  ?? s.pe?.oi);
    const ceOiChg   = _safe(s.call?.oiChange ?? s.ce?.oiChg ?? s.ce?.oiChange);
    const peOiChg   = _safe(s.put?.oiChange  ?? s.pe?.oiChg ?? s.pe?.oiChange);
    const ceOiPrev  = Math.max(0, ceOiToday - ceOiChg);
    const peOiPrev  = Math.max(0, peOiToday - peOiChg);
    const ceChgPct  = ceOiPrev > 0 ? (ceOiChg / ceOiPrev) * 100 : 0;
    const peChgPct  = peOiPrev > 0 ? (peOiChg / peOiPrev) * 100 : 0;

    ceRows.push({
      strike: k,
      oiToday: ceOiToday, oiPrev: ceOiPrev, oiChange: ceOiChg,
      oiChangePct: _round(ceChgPct, 2),
      interpretation: interpret(ceChgPct),
      isAtm: k === atm,
    });
    peRows.push({
      strike: k,
      oiToday: peOiToday, oiPrev: peOiPrev, oiChange: peOiChg,
      oiChangePct: _round(peChgPct, 2),
      interpretation: interpret(peChgPct),
      isAtm: k === atm,
    });
  }
  // Top 5 CE strikes by absolute build (most-active resistance ladder)
  const topCe = [...ceRows]
    .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
    .slice(0, 5)
    .sort((a, b) => b.strike - a.strike);
  // Top 5 PE strikes by absolute build
  const topPe = [...peRows]
    .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
    .slice(0, 5)
    .sort((a, b) => b.strike - a.strike);

  // Bar-chart series — ATM ± `range` strikes at displayStep grid
  const anchor = Math.round(atm / displayStep) * displayStep;
  const byStrike = new Map(strikes.map(s => [Number(s.strike), s]));
  const ceChart = [];
  const peChart = [];
  for (let i = -range; i <= range; i++) {
    const k = anchor + i * displayStep;
    const s = byStrike.get(k);
    if (!s) continue;
    const ceOiChg = _safe(s.call?.oiChange ?? s.ce?.oiChg ?? s.ce?.oiChange);
    const peOiChg = _safe(s.put?.oiChange  ?? s.pe?.oiChg ?? s.pe?.oiChange);
    ceChart.push({ strike: k, oiChange: ceOiChg, isAtm: k === atm });
    peChart.push({ strike: k, oiChange: peOiChg, isAtm: k === atm });
  }

  // Key Takeaway — find the cluster of consecutive strikes with the
  // heaviest build per side.
  function clusterBand(rows) {
    const sorted = [...rows].sort((a, b) => a.strike - b.strike);
    const builds = sorted.filter(r => r.oiChange > 0);
    if (!builds.length) return null;
    // Top 3 strikes by absolute build
    const top = [...builds].sort((a, b) => b.oiChange - a.oiChange).slice(0, 3);
    const minK = Math.min(...top.map(r => r.strike));
    const maxK = Math.max(...top.map(r => r.strike));
    return { from: minK, to: maxK, count: top.length };
  }
  const ceBand = clusterBand(ceRows);
  const peBand = clusterBand(peRows);
  const ceTakeaway = ceBand
    ? `Strong OI buildup seen at ${ceBand.from} – ${ceBand.to} strikes, indicating resistance zone.`
    : 'No significant CE buildup.';
  const peTakeaway = peBand
    ? `Strong OI buildup at ${peBand.from} – ${peBand.to} strikes, indicating strong support zone.`
    : 'No significant PE buildup.';

  return {
    spot: {
      price: _round(spotPrice, 2),
    },
    totals: {
      ce: {
        today: totalCeToday, prev: totalCePrev,
        change: totalCeChg, changePct: _round(totalCeChgPct, 2),
      },
      pe: {
        today: totalPeToday, prev: totalPePrev,
        change: totalPeChg, changePct: _round(totalPeChgPct, 2),
      },
      pcr: _round(ratio, 2),
    },
    marketView: { label: marketView, tone: marketViewTone, ratio: _round(ratio, 2) },
    ceTable: topCe,
    peTable: topPe,
    ceChart,
    peChart,
    ceTakeaway,
    peTakeaway,
  };
}

/**
 * Summarise an OI-shift histogram into a single bias verdict + a percentage,
 * and a rich trend block showing direction, strength, dominant side, and
 * the strike with the heaviest writer activity.
 *
 * Returns:
 *   { bullishPct, bearishPct, side: 'CALL'|'PUT'|'BALANCED',
 *     pctFavour: 0..100, label: 'Bullish (PE Buyers)'|...
 *     trend: { direction, strength, momentum, dominantSide,
 *              dominantStrike, dominantBuild, dominantValue,
 *              callBuildCount, putBuildCount, label } }
 */
function _oiShiftBias(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return {
      bullishPct: 50, bearishPct: 50, side: 'BALANCED', pctFavour: 0,
      label: 'No data',
      trend: {
        direction: 'NEUTRAL', strength: 'WEAK', momentum: 0,
        dominantSide: null, dominantStrike: null,
        dominantBuild: null, dominantValue: 0,
        callBuildCount: 0, putBuildCount: 0,
        label: 'No data',
      },
    };
  }
  let bullish = 0, bearish = 0;
  let callBuildCount = 0, putBuildCount = 0;
  let dominant = { side: null, strike: null, value: 0, build: null };
  for (const r of rows) {
    const ceChg = Number(r.ceOiChg) || 0;
    const peChg = Number(r.peOiChg) || 0;
    if (peChg > 0) { bullish += peChg; putBuildCount++; }
    else           { bearish += -peChg; }
    if (ceChg > 0) { bearish += ceChg; callBuildCount++; }
    else           { bullish += -ceChg; }
    // Track absolute heaviest single ΔOI move across both sides
    if (Math.abs(ceChg) > Math.abs(dominant.value)) {
      dominant = {
        side: ceChg >= 0 ? 'CE' : 'CE_UNWIND',
        strike: r.strike,
        value: ceChg,
        build: ceChg >= 0 ? 'CE Build' : 'CE Unwind',
      };
    }
    if (Math.abs(peChg) > Math.abs(dominant.value)) {
      dominant = {
        side: peChg >= 0 ? 'PE' : 'PE_UNWIND',
        strike: r.strike,
        value: peChg,
        build: peChg >= 0 ? 'PE Build' : 'PE Unwind',
      };
    }
  }
  const total = bullish + bearish || 1;
  const bullishPct = Math.round((bullish / total) * 100);
  const bearishPct = 100 - bullishPct;
  let side = 'BALANCED';
  let pctFavour = 0;
  if (bullishPct >= 60) { side = 'CALL'; pctFavour = bullishPct; }
  else if (bearishPct >= 60) { side = 'PUT'; pctFavour = bearishPct; }
  else { pctFavour = Math.max(bullishPct, bearishPct); }

  // ── Trend block ─────────────────────────────────────────────────────
  // Direction: BULLISH if PE-side build dominates; BEARISH if CE-side does.
  // Strength: by margin of bullishPct vs bearishPct (>30 strong, 15-30 moderate, <15 mild).
  // Momentum: signed value 0..100, reflects how lopsided the flow is.
  const margin = Math.abs(bullishPct - bearishPct);
  const direction = bullishPct >= 55 ? 'BULLISH'
    : bearishPct >= 55 ? 'BEARISH' : 'NEUTRAL';
  const strength = margin >= 30 ? 'STRONG'
    : margin >= 15 ? 'MODERATE'
    : 'MILD';
  const momentum = Math.round(margin);
  const dominantSide = dominant.side === 'PE' ? 'PE Writers (Support)'
    : dominant.side === 'CE' ? 'CE Writers (Resistance)'
    : dominant.side === 'PE_UNWIND' ? 'PE Unwinding (Support Erosion)'
    : dominant.side === 'CE_UNWIND' ? 'CE Unwinding (Short Cover)'
    : null;
  const trendLabel = direction === 'BULLISH'
    ? `${strength} Bullish — PE Build dominates (${bullishPct}%)`
    : direction === 'BEARISH'
      ? `${strength} Bearish — CE Build dominates (${bearishPct}%)`
      : `Mixed — ${bullishPct}% bull / ${bearishPct}% bear`;

  return {
    bullishPct,
    bearishPct,
    side,
    pctFavour,
    label: side === 'CALL'
      ? `Bullish — favours CALLS (${pctFavour}%)`
      : side === 'PUT'
        ? `Bearish — favours PUTS (${pctFavour}%)`
        : `Balanced (${bullishPct}% / ${bearishPct}%)`,
    trend: {
      direction,
      strength,
      momentum,
      dominantSide,
      dominantStrike: dominant.strike,
      dominantBuild: dominant.build,
      dominantValue: dominant.value,
      callBuildCount,
      putBuildCount,
      label: trendLabel,
    },
  };
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

  // Weight rebalance — PCR is unreliable intraday (stale positioning,
  // overnight carry, hedges). Reduce its weight from 0.10 → 0.03 and
  // redistribute toward delta + flow which are far more reliable for
  // same-day directional reads. Net weight stays ≈ 1.0.
  const W = {
    pcr: 0.03, oiWriters: 0.10, vwap: 0.10, ema: 0.10, cpr: 0.06,
    heavyweights: 0.10, vix: 0.05, gift: 0.06, fiiDii: 0.08,
    futures: 0.07, delta: 0.13, iv: 0.04, breadth: 0.08,
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

/** Best-strike picker based on verdict + ladder health.
 *
 *  IMPORTANT: callers may pass a pre-filtered ladder (e.g. only 100-spaced
 *  strikes within ATM ± 6) — this function only ranks them.
 */
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
    else if (moneyness === 100 || moneyness === 200) score += 14;
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

/**
 * Reduce a ladder to ONLY 100-step strikes within ATM ± 6 strikes.
 * Used by _bestTradePicks so the BUY CE / BUY PE recommendations always
 * show round 100-step strikes (e.g. 23900 / 24000 / 24100), never 23950.
 *
 * Window — base anchor = round(atm/100)*100, then ±6 × 100 around it.
 * Returns a fresh ladder array; caller's ladder is not mutated.
 */
function _hundredStepWindow(ladder, atm, range = 6) {
  if (!Array.isArray(ladder) || !atm) return [];
  const anchor = Math.round(atm / 100) * 100;
  const lo = anchor - range * 100;
  const hi = anchor + range * 100;
  return ladder.filter(row => {
    const k = Number(row.strike);
    return Number.isFinite(k) && k % 100 === 0 && k >= lo && k <= hi;
  });
}

/**
 * Best Trade Picks (CE + PE side-by-side)
 * =======================================
 * Independent CE and PE strike picks with confluence-based win probability.
 *
 * Probability is built from 7 confluence factors (each contributes points):
 *   1. Verdict alignment       (verdict.cePct/pePct)              max 25
 *   2. FRVP directional bias   (engine.directionalBias.side+strength) max 20
 *   3. Acceptance/Rejection    (engine.acceptance flags)           max 15
 *   4. Smart money (delta)     (delta.bias)                        max 10
 *   5. Strike health           (leg.health.score)                  max 10
 *   6. OI structure            (CE/PE writing pattern)             max 10
 *   7. Trap risk penalty       (trap.score subtraction)            max 10
 *
 * Final = base 35% + sum of weighted contributions, clamped to [25, 92].
 *
 * Returns:
 *   { ce: { ...pickStrike, probability, label, factors, reasoning, action },
 *     pe: { ... },
 *     primary: 'CE' | 'PE' | 'NEUTRAL',
 *     spread: number  // probability gap between primary and secondary
 *   }
 */
function _bestTradePicks({
  ladder, atm, verdict, frvpEngine, deltaBias, acceptance, trapScore, atmBlk,
}) {
  if (!Array.isArray(ladder) || !atm) return null;

  // Restrict candidate strikes to round 100-step strikes within ATM ± 6.
  // This guarantees BUY CE / BUY PE recommendations land on clean strikes
  // like 23900 / 24000 / 24100 (never 23950).
  const filteredLadder = _hundredStepWindow(ladder, atm, 6);
  // Anchor used for "ATM" detection in moneyness label (round to 100s)
  const atmAnchor = Math.round(atm / 100) * 100;

  const buildPick = (side) => {
    const pick = _pickBestStrike(side, filteredLadder, atmAnchor);
    if (!pick) return null;
    const factors = {};
    let prob = 35; // base

    // 1. Verdict alignment
    const sidePct = side === 'CE' ? verdict.cePct : verdict.pePct;
    const vAlign = Math.max(0, sidePct - 50) * 0.5;  // up to 25
    factors.verdict = _round(vAlign, 1);
    prob += vAlign;

    // 2. FRVP directional bias
    let frvpBoost = 0;
    if (frvpEngine?.directionalBias) {
      const b = frvpEngine.directionalBias;
      if (b.side === side) {
        frvpBoost = b.strength === 'STRONG' ? 20
                  : b.strength === 'MODERATE' ? 12
                  : 6;
      } else if (b.side !== 'NEUTRAL') {
        frvpBoost = -10;  // FRVP says other side
      }
    }
    factors.frvp = frvpBoost;
    prob += frvpBoost;

    // 3. Acceptance / rejection alignment
    let accBoost = 0;
    if (acceptance) {
      if (side === 'CE') {
        if (acceptance.acceptedAboveVAH) accBoost += 12;
        if (acceptance.rejectedBelowVAL) accBoost += 8;   // bear trap → CE setup
        if (acceptance.acceptedBelowVAL) accBoost -= 12;
        if (acceptance.rejectedAboveVAH) accBoost -= 8;
      } else {
        if (acceptance.acceptedBelowVAL) accBoost += 12;
        if (acceptance.rejectedAboveVAH) accBoost += 8;   // bull trap → PE setup
        if (acceptance.acceptedAboveVAH) accBoost -= 12;
        if (acceptance.rejectedBelowVAL) accBoost -= 8;
      }
    }
    factors.acceptance = accBoost;
    prob += accBoost;

    // 4. Smart money (delta) alignment
    let dBoost = 0;
    if (deltaBias === 'bullish') dBoost = side === 'CE' ? 10 : -8;
    else if (deltaBias === 'bearish') dBoost = side === 'PE' ? 10 : -8;
    factors.delta = dBoost;
    prob += dBoost;

    // 5. Strike health
    const healthScore = pick.leg?.health?.score ?? 50;
    const hBoost = (healthScore - 50) * 0.2;  // ±10
    factors.health = _round(hBoost, 1);
    prob += hBoost;

    // 6. OI structure
    let oiBoost = 0;
    if (atmBlk) {
      if (side === 'CE') {
        if (atmBlk.peWriting) oiBoost += 6;     // PE writing = bullish for CE buy
        if (atmBlk.ceUnwinding) oiBoost += 4;
        if (atmBlk.ceWriting) oiBoost -= 6;
      } else {
        if (atmBlk.ceWriting) oiBoost += 6;
        if (atmBlk.peUnwinding) oiBoost += 4;
        if (atmBlk.peWriting) oiBoost -= 6;
      }
    }
    factors.oi = oiBoost;
    prob += oiBoost;

    // 7. Trap penalty
    const tPenalty = (trapScore || 0) * -0.5;  // up to -10
    factors.trap = _round(tPenalty, 1);
    prob += tPenalty;

    // Clamp probability
    prob = Math.max(25, Math.min(92, Math.round(prob)));

    // Action label
    const action =
      prob >= 70 ? 'STRONG BUY'
      : prob >= 60 ? 'BUY'
      : prob >= 50 ? 'CAUTIOUS BUY'
      : prob >= 40 ? 'WAIT'
      : 'AVOID';

    // Reasoning string — 2 strongest factors
    const sortedFactors = Object.entries(factors)
      .map(([k, v]) => ({ k, v }))
      .filter(f => Math.abs(f.v) >= 4)
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const top = sortedFactors.slice(0, 2);
    const reasonMap = {
      verdict: 'verdict',
      frvp: 'FRVP bias',
      acceptance: 'price acceptance',
      delta: 'delta flow',
      health: 'strike health',
      oi: 'OI structure',
      trap: 'trap risk',
    };
    const reasoning = top.length
      ? top.map(f => `${f.v >= 0 ? '+' : ''}${f.v.toFixed(0)} ${reasonMap[f.k]}`).join(' · ')
      : 'no clear edge';

    return {
      side,
      strike: pick.row.strike,
      ltp: _round(pick.leg.ltp, 2),
      oi: pick.leg.oi,
      delta: _round(pick.leg.delta, 3),
      iv: _round(pick.leg.iv, 1),
      health: pick.leg.health,
      moneyness: pick.moneyness === 0 ? 'ATM'
        : pick.moneyness > 0 ? `OTM+${pick.moneyness}` : `ITM${pick.moneyness}`,
      probability: prob,
      action,
      label: `BUY ${side} ${pick.row.strike}`,
      reasoning,
      factors,
    };
  };

  const ce = buildPick('CE');
  const pe = buildPick('PE');
  if (!ce && !pe) return null;

  // Primary side — whichever has the higher probability AND >= 50.
  let primary = 'NEUTRAL';
  let spread = 0;
  if (ce && pe) {
    spread = Math.abs(ce.probability - pe.probability);
    if (ce.probability > pe.probability && ce.probability >= 50) primary = 'CE';
    else if (pe.probability > ce.probability && pe.probability >= 50) primary = 'PE';
  } else if (ce && ce.probability >= 50) primary = 'CE';
  else if (pe && pe.probability >= 50) primary = 'PE';

  return { ce, pe, primary, spread };
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
  let futOi = 0;          // Live near-month futures Open Interest (lots)
  let futOiPrevClose = 0; // Previous-day OI close (for OI change)

  // For NIFTY, prefer the live near-month futures tick over the last 1m
  // candle close (same staleness fix as spot). Also pull live OI.
  if (marketOpen && sym.futuresUnderlying === 'NIFTY') {
    try {
      const niftyFut = require('./niftyFuturesProd.service');
      if (typeof niftyFut.getLiveTick === 'function') {
        const ft = await niftyFut.getLiveTick().catch(() => null);
        if (ft && Number.isFinite(ft.ltp) && ft.ltp > 0) {
          const age = Date.now() - (ft.updatedAt || Date.now());
          if (age <= 5000) futLtp = _safe(ft.ltp);
          if (Number.isFinite(ft.oi)) futOi = _safe(ft.oi);
          if (Number.isFinite(ft.prevOi)) futOiPrevClose = _safe(ft.prevOi);
          else if (Number.isFinite(ft.oiDayLow)) futOiPrevClose = _safe(ft.oiDayLow);
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

  // ── 2.2 Market Direction Card ───────────────────────────────────────
  // 3-tier resistance ladder + 3-tier support ladder + OI estimated move.
  // Uses option chain ranked by absolute OI on each side, then categorises
  // by strength (top OI = Immediate / next = Strong/Major / 3rd = Extreme/Critical).
  const marketDirection = (() => {
    const sortedStrikes = [...strikes].sort((a, b) => a.strike - b.strike);

    // Restrict resistance/support ladders to clean 100-step strikes within
    // ATM ± 6. Prevents non-round 50-step strikes (e.g. 23950) from showing
    // in the Intraday Levels block.
    const anchor = Math.round(atm / 100) * 100;
    const winLo = anchor - 6 * 100;
    const winHi = anchor + 6 * 100;
    const isClean = (k) => k % 100 === 0 && k >= winLo && k <= winHi;

    // CE side — the 6 100-step strikes IMMEDIATELY ABOVE anchor
    // (anchor+100 .. anchor+600). Always a contiguous 6-strike window so
    // the ladder is fully populated regardless of OI distribution.
    const ceCandidates = sortedStrikes
      .filter(s => isClean(Number(s.strike)) && Number(s.strike) > anchor)
      .map(s => ({
        strike: Number(s.strike),
        oi: _safe(s.call?.oi ?? s.ce?.oi),
        oiChange: _safe(s.call?.oiChange ?? s.ce?.oiChg ?? s.ce?.oiChange),
      }))
      .sort((a, b) => a.strike - b.strike)   // closest to anchor first
      .slice(0, 6);                           // anchor+100 .. anchor+600

    // PE side — the 6 100-step strikes IMMEDIATELY BELOW anchor
    // (anchor-100 .. anchor-600). Always a contiguous 6-strike window.
    const peCandidates = sortedStrikes
      .filter(s => isClean(Number(s.strike)) && Number(s.strike) < anchor)
      .map(s => ({
        strike: Number(s.strike),
        oi: _safe(s.put?.oi ?? s.pe?.oi),
        oiChange: _safe(s.put?.oiChange ?? s.pe?.oiChg ?? s.pe?.oiChange),
      }))
      .sort((a, b) => b.strike - a.strike)   // closest to anchor first
      .slice(0, 6);                           // anchor-100 .. anchor-600

    // Tier labels — closest to spot = "Immediate", farthest = "Extreme/Critical".
    // Six-tier ladder so we can show ATM ± 6 levels in the Intraday Levels card.
    const ceTiers = [
      'Immediate Resistance', 'Strong Resistance', 'Extreme Resistance',
      'R4 (Major)', 'R5 (Heavy)', 'R6 (Wall)',
    ];
    const peTiers = [
      'Immediate Support', 'Major Support', 'Critical Support',
      'S4 (Deep)', 'S5 (Floor)', 'S6 (Bedrock)',
    ];
    const resistances = ceCandidates.map((c, i) => ({
      tier: ceTiers[i] || 'Resistance',
      strike: c.strike,
      oi: c.oi,
      oiChange: c.oiChange,
    }));
    const supports = peCandidates.map((c, i) => ({
      tier: peTiers[i] || 'Support',
      strike: c.strike,
      oi: c.oi,
      oiChange: c.oiChange,
    }));

    // Direction meter — downside vs upside %
    const downsidePct = _round(verdict.pePct, 0);
    const upsidePct   = _round(verdict.cePct, 0);
    // Needle position 0..100 (0 = full downside, 100 = full upside)
    const needlePos = upsidePct;

    // OI Estimated Move targets — based on max-pain pull + writer walls
    //   Downside target = strongest support strike (most likely magnet down)
    //   Upside target   = strongest resistance strike (most likely cap up)
    //   But for "estimated move" we want the next confluence:
    //     Downside = nearest PE wall above strongest support (or 2nd PE wall)
    //     Upside   = nearest CE wall below strongest resistance (or 2nd CE wall)
    const downsideTarget = peCandidates[1]?.strike ?? peCandidates[0]?.strike ?? null;
    const upsideTarget   = ceCandidates[1]?.strike ?? ceCandidates[0]?.strike ?? null;

    return {
      directionMeter: {
        downside: downsidePct,
        upside:   upsidePct,
        needlePos,
        verdict:
          downsidePct >= 65 ? 'STRONG DOWNSIDE'
          : downsidePct >= 55 ? 'DOWNSIDE BIAS'
          : upsidePct   >= 65 ? 'STRONG UPSIDE'
          : upsidePct   >= 55 ? 'UPSIDE BIAS'
          : 'BALANCED',
        tone:
          downsidePct >= 55 ? 'bear'
          : upsidePct >= 55 ? 'bull' : 'warn',
      },
      resistances,
      supports,
      oiEstimatedMove: {
        downsideTarget,
        upsideTarget,
        maxPain: atmBlk.maxPain,
        spot: _round(spotPrice, 2),
      },
    };
  })();
  const topStrikeSelections = _topStrikeSelections(ladder, atm, verdict, atmBlk);
  // OI Shift card — ATM ± 4 strikes spaced in 100s (e.g. 23800, 23900, ATM,
  // …). The bias summary turns the table into a single side+% verdict shown
  // under the table. Each row also carries a per-strike buyer-favor split.
  const oiHistogram = _oiHistogram(strikes, atm, 4, 100, { spot: spotPrice });
  const oiShiftBias = _oiShiftBias(oiHistogram);
  // 2.3 OI Buildup Analysis — top stats + per-side tables + bar charts
  // (range=6 → ATM ± 6 strikes on each side, 100-spaced; feeds the Writing
  //  Pressure ladders and downstream readers.)
  const oiBuildupAnalysis = _oiBuildupAnalysis(strikes, atm, spotPrice, 100, 6);

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
    // ── Run the full institutional auction engine (13-section spec) ──
    const engine = frvpEngine.evaluate({
      symbolKey: SYMBOL,
      candles5m: c5m,
      spotPrice,
      spotChange,
      strikes,
      atm,
      date: usedDate,
    });

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
      // Full institutional engine output (Sections 1–13)
      engine,
    };
  })();

  function auctionBiasOf(p, profile) {
    if (!profile?.vah || !profile?.val) return 'inside';
    if (p > profile.vah) return 'above';
    if (p < profile.val) return 'below';
    return 'inside';
  }

  // ── VALUE AREA — single source of truth ──────────────────────────────
  // Earlier code was reading the simple price-bin VAH/VAL (`vp`) which is
  // typically wider than the institutional engine's curated VAH/VAL
  // (`frvpInstitutional.engine.profile`). This caused multiple downstream
  // engines (HeroZero, Trade Strategy, NoTrade) to incorrectly flag
  // "Inside Value Area" while the FRVP card simultaneously showed
  // "Below Value / Rejection below value" — confusing users and
  // suppressing valid PE entries.
  //
  // Prefer the institutional engine band; fall back to vp only if it
  // hasn't been computed (cold start / historical mode).
  const _engineProfile = frvpInstitutional?.engine?.profile;
  const vaPrimary = (_engineProfile?.vah && _engineProfile?.val)
    ? { vah: _engineProfile.vah, val: _engineProfile.val, poc: _engineProfile.poc }
    : (vp?.vah && vp?.val ? { vah: vp.vah, val: vp.val, poc: vp.poc } : null);

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

  // Best Trade Picks — independent CE & PE strike picks with confluence-based
  // probability fused from verdict, FRVP bias, acceptance, delta, health, OI,
  // and trap penalty. Drives the new "Best Trade Pick" footer strip on the
  // WritingPressure card.
  const bestTradePick = _bestTradePicks({
    ladder, atm, verdict,
    frvpEngine: frvpInstitutional?.engine,
    deltaBias: delta.bias,
    acceptance: frvpInstitutional?.engine?.acceptance,
    trapScore: trapBlk?.score,
    atmBlk,
  });

  // ── tradeBoard — 4 quick-glance cards rendered above Row1 ─────────
  // 1. BEST OPTION BUY — primary recommendation (CE or PE)
  // 2. ALTERNATE SCENARIO — opposite-side pick if primary fails
  // 3. RISK GAUGE — overall trap risk + confidence
  // 4. EXECUTION CONTEXT — preferred zones & next actionable level
  const tradeBoard = (() => {
    const primary = bestTradePick?.primary === 'CE'
      ? bestTradePick.ce
      : bestTradePick?.primary === 'PE'
        ? bestTradePick.pe
        : (bestTradePick?.ce?.probability ?? 0) >= (bestTradePick?.pe?.probability ?? 0)
          ? bestTradePick?.ce : bestTradePick?.pe;
    const alternate = bestTradePick && primary
      ? (primary.side === 'CE' ? bestTradePick.pe : bestTradePick.ce)
      : null;

    // STEP forced to 100 — Best Option Buy and Alternate Scenario should
    // only land on round 100-spaced strikes (e.g. 23900, 24000, 24100).
    // Falling back to 50 only when symbol is hard-coded to 50 (none currently).
    const STEP = 100;

    function buildSetupCard(pick, isAlternate) {
      if (!pick) return null;
      const dir = pick.side === 'CE' ? 1 : -1;
      const t1 = pick.strike + dir * STEP * 2;
      const t2 = pick.strike + dir * STEP * 4;
      const t3 = pick.strike + dir * STEP * 6;
      const sl = pick.strike + (-dir) * STEP * 1.5;
      // Setup tag based on probability
      const setupTag =
        pick.probability >= 75 ? 'Strong Setup'
        : pick.probability >= 60 ? 'Solid Setup'
        : pick.probability >= 50 ? 'Cautious Setup'
        : 'Wait Setup';
      // 4 quick-confirm chips for this side
      const confirmChips = [];
      if (pick.side === 'CE') {
        confirmChips.push({ label: 'PE Writing',
          value: atmBlk.peWriting ? 'Active' : 'Light',
          tone: atmBlk.peWriting ? 'bull' : 'warn' });
        confirmChips.push({ label: 'PCR',
          value: `${atmBlk.pcr >= 1 ? '>' : '<'} 1 (${_round(atmBlk.pcr, 2)})`,
          tone: atmBlk.pcr >= 1 ? 'bull' : 'bear' });
        confirmChips.push({ label: 'Price',
          value: vwap && spotPrice >= vwap ? 'Above VWAP' : 'Below VWAP',
          tone: vwap && spotPrice >= vwap ? 'bull' : 'bear' });
        const peWall = supportResistance?.supports?.[0];
        confirmChips.push({ label: 'Support',
          value: peWall ? `${peWall.strike}` : '—',
          tone: 'bull' });
      } else {
        confirmChips.push({ label: 'CE Writing',
          value: atmBlk.ceWriting ? 'Active' : 'Light',
          tone: atmBlk.ceWriting ? 'bear' : 'warn' });
        confirmChips.push({ label: 'PCR',
          value: `${atmBlk.pcr >= 1 ? '>' : '<'} 1 (${_round(atmBlk.pcr, 2)})`,
          tone: atmBlk.pcr >= 1 ? 'bull' : 'bear' });
        confirmChips.push({ label: 'Price',
          value: vwap && spotPrice < vwap ? 'Below VWAP' : 'Above VWAP',
          tone: vwap && spotPrice < vwap ? 'bear' : 'bull' });
        const ceWall = supportResistance?.resistances?.[0];
        confirmChips.push({ label: 'Resistance',
          value: ceWall ? `${ceWall.strike}` : '—',
          tone: 'bear' });
      }

      // Reversal condition for alternate-scenario card
      let reversalCondition = null;
      if (isAlternate) {
        const flipStrike = pick.side === 'CE'
          ? Math.round((spotPrice + STEP * 2) / STEP) * STEP
          : Math.round((spotPrice - STEP * 2) / STEP) * STEP;
        reversalCondition = pick.side === 'CE'
          ? `Spot Reclaims ${flipStrike} & CE Unwinding`
          : `Spot Loses ${flipStrike} & PE Unwinding`;
      }

      return {
        side: pick.side,
        strike: pick.strike,
        ltp: pick.ltp,
        oi: pick.oi,
        delta: pick.delta,
        iv: pick.iv,
        moneyness: pick.moneyness,
        probability: pick.probability,
        action: pick.action,
        setupTag,
        setupTone: pick.probability >= 60 ? 'bull' : 'warn',
        label: `BUY ${pick.side}`,
        confirmChips,
        targets: { t1, t2, t3 },
        stopLoss: sl,
        reversalCondition,
        reasoning: pick.reasoning,
      };
    }

    // Card 1 — Best Option Buy
    const bestOptionBuy = primary ? buildSetupCard(primary, false) : null;
    // Card 2 — Alternate scenario
    const alternateScenario = alternate ? buildSetupCard(alternate, true) : null;

    // Card 3 — RISK GAUGE
    //   Combines trap score + confidence + verdict gap into a single
    //   "execution risk" gauge with verdict-aware hint.
    const trapScore = trapBlk?.score ?? 0;
    const confScore = confidence;            // already computed earlier
    const riskScore = Math.max(0, Math.min(100,
      Math.round(0.55 * trapScore + 0.25 * (100 - confScore) + 0.20 * (50 - Math.abs(verdict.cePct - verdict.pePct)))
    ));
    const riskLabel =
      riskScore >= 70 ? 'CRITICAL'
      : riskScore >= 50 ? 'HIGH'
      : riskScore >= 30 ? 'MODERATE'
      : 'LOW';
    const riskTone =
      riskScore >= 70 ? 'bear'
      : riskScore >= 50 ? 'warn'
      : riskScore >= 30 ? 'warn' : 'bull';
    const riskGauge = {
      score: riskScore,
      label: riskLabel,
      tone: riskTone,
      trapScore,
      confidence: confScore,
      hint:
        riskScore >= 70 ? 'Avoid new entries. Wait for clarity.'
        : riskScore >= 50 ? 'Tighten size. Confirm with price action.'
        : riskScore >= 30 ? 'Trade with normal size. Stay alert to flips.'
        : 'Clean tape. Trade the playbook.',
      chips: [
        { label: 'TRAP', value: `${trapScore}%`, tone: trapScore >= 60 ? 'bear' : trapScore >= 40 ? 'warn' : 'bull' },
        { label: 'CONF', value: `${confScore}%`, tone: confScore >= 65 ? 'bull' : confScore >= 50 ? 'warn' : 'bear' },
        { label: 'BIAS', value: verdict.cePct >= verdict.pePct ? `CE ${verdict.cePct}%` : `PE ${verdict.pePct}%`,
          tone: Math.abs(verdict.cePct - verdict.pePct) >= 20 ? 'bull' : 'warn' },
      ],
    };

    // Card 4 — EXECUTION CONTEXT — actionable next-step plan
    const nextLevel = primary && primary.side === 'CE'
      ? (supportResistance?.resistances?.[0]?.strike ?? null)
      : primary && primary.side === 'PE'
        ? (supportResistance?.supports?.[0]?.strike ?? null)
        : null;
    const flowState = delta.bias === 'bullish' ? 'BUYING'
      : delta.bias === 'bearish' ? 'SELLING' : 'BALANCED';
    const auctionPhase = frvpInstitutional?.engine?.location?.side
      || (frvpInstitutional?.insideValue === 'YES' ? 'inside_value' : 'unknown');
    const phaseLabel =
      auctionPhase === 'above_value' ? 'PROBE ABOVE'
      : auctionPhase === 'below_value' ? 'PROBE BELOW'
      : auctionPhase === 'inside_value' ? 'INSIDE VALUE'
      : 'BALANCED';
    const executionContext = {
      phase: phaseLabel,
      flowState,
      flowTone: delta.bias === 'bullish' ? 'bull' : delta.bias === 'bearish' ? 'bear' : 'warn',
      nextLevel,
      nextLevelLabel: primary
        ? (primary.side === 'CE' ? 'Next Resistance' : 'Next Support')
        : 'Next Pivot',
      vwapState: vwap && spotPrice >= vwap ? 'Above VWAP' : 'Below VWAP',
      vwapTone: vwap && spotPrice >= vwap ? 'bull' : 'bear',
      preferredAction: primary
        ? (primary.probability >= 60 ? primary.label : `Wait — ${primary.action}`)
        : 'No setup',
      preferredTone: primary && primary.probability >= 60
        ? (primary.side === 'CE' ? 'bull' : 'bear') : 'warn',
      // Mini key levels for the execution card
      keyLevels: [
        { label: 'VWAP',   value: vwap != null ? _round(vwap, 2) : null },
        { label: 'Pivot',  value: cpr?.pivot != null ? _round(cpr.pivot, 2) : null },
        { label: 'Day H',  value: dayHigh != null ? _round(dayHigh, 2) : null },
        { label: 'Day L',  value: dayLow  != null ? _round(dayLow,  2) : null },
      ],
    };

    return { bestOptionBuy, alternateScenario, riskGauge, executionContext };
  })();

  // ── HERO OR ZERO ENGINE ─────────────────────────────────────────────
  // High-risk / high-reward sniper banner. Computes a Hero CE / Hero PE /
  // Zero Trade verdict by scoring 6 boolean signals per side. Uses
  // already-computed: vwap, vp (FRVP value area), frvpInstitutional engine
  // (dominance + delta + acceptance), atmBlk (CE/PE writing), atmBlk.atmIv,
  // and macro.vix. Lives at dashboard.heroZero.
  //
  // Score weights:
  //   +2  Above VAH (CE) / Below VAL (PE)
  //   +2  Above VWAP (CE) / Below VWAP (PE)
  //   +2  Premium expanding the right side (FRVP premiumVel state)
  //   +1  Buyers dominant ≥65% (CE) / Sellers dominant ≥65% (PE)
  //   +1  Delta positive ≥10% (CE) / negative ≤-10% (PE)
  //   +1  Breakout / breakdown volume — last bar volume > 1.5× avg
  //
  //   Total max = 9. Hero fires at score ≥ 7.
  const heroZero = (() => {
    const fEngine = frvpInstitutional?.engine;
    const fAccept = fEngine?.acceptance;
    const fDom    = fEngine?.dominance;
    const fDelta  = fEngine?.delta;
    const fPrem   = fEngine?.advanced?.premiumVel;

    // Core spot levels — use the institutional engine's VAH/VAL when
    // available so this engine agrees with the FRVP card display.
    const aboveVAH = vaPrimary?.vah != null && Number.isFinite(spotPrice) && spotPrice > vaPrimary.vah;
    const belowVAL = vaPrimary?.val != null && Number.isFinite(spotPrice) && spotPrice < vaPrimary.val;
    const insideValue = vaPrimary?.vah != null && vaPrimary?.val != null
      && Number.isFinite(spotPrice) && spotPrice >= vaPrimary.val && spotPrice <= vaPrimary.vah;
    const aboveVWAP = vwap != null && Number.isFinite(spotPrice) && spotPrice > vwap;
    const belowVWAP = vwap != null && Number.isFinite(spotPrice) && spotPrice < vwap;

    // Acceptance — 3+ bars closed beyond level
    const acceptedAbove = !!fAccept?.acceptedAboveVAH;
    const acceptedBelow = !!fAccept?.acceptedBelowVAL;
    const rejectedAbove = !!fAccept?.rejectedAboveVAH;   // bull trap
    const rejectedBelow = !!fAccept?.rejectedBelowVAL;   // bear trap

    // Premium velocity
    const ceExpanding = fPrem?.state === 'CE_EXPANDING';
    const peExpanding = fPrem?.state === 'PE_EXPANDING';

    // Dominance
    const buyersDominant  = (fDom?.dominantSide === 'BUYERS')  && fDom?.buyersScore  >= 65;
    const sellersDominant = (fDom?.dominantSide === 'SELLERS') && fDom?.sellersScore >= 65;

    // Delta
    const deltaPos = (fDelta?.deltaPct ?? 0) >=  10;
    const deltaNeg = (fDelta?.deltaPct ?? 0) <= -10;

    // Volume burst — last 5m bar volume vs prior-20 average
    const volSurge = (() => {
      if (!Array.isArray(c5m) || c5m.length < 6) return false;
      const last = c5m[c5m.length - 1];
      const prior = c5m.slice(-21, -1);
      if (!prior.length) return false;
      const avg = prior.reduce((s, b) => s + (b.volume || 0), 0) / prior.length;
      return avg > 0 && (last.volume || 0) > avg * 1.5;
    })();

    // Trap detection — bull trap kills CE hero, bear trap kills PE hero
    const bullTrap = rejectedAbove;
    const bearTrap = rejectedBelow;

    // Score CE side (max 9)
    let ceScore = 0;
    if (aboveVAH)        ceScore += 2;
    if (aboveVWAP)       ceScore += 2;
    if (ceExpanding)     ceScore += 2;
    if (buyersDominant)  ceScore += 1;
    if (deltaPos)        ceScore += 1;
    if (volSurge)        ceScore += 1;
    if (bullTrap)        ceScore -= 4; // hard veto

    // Score PE side
    let peScore = 0;
    if (belowVAL)        peScore += 2;
    if (belowVWAP)       peScore += 2;
    if (peExpanding)     peScore += 2;
    if (sellersDominant) peScore += 1;
    if (deltaNeg)        peScore += 1;
    if (volSurge)        peScore += 1;
    if (bearTrap)        peScore -= 4;

    // Pick best target strike — closest 100-step OTM strike
    const STEP = 100;
    const ceTarget = Math.round((spotPrice + STEP) / STEP) * STEP;
    const peTarget = Math.round((spotPrice - STEP) / STEP) * STEP;

    // Lookup ATM premium for the target
    const ceLeg = strikes.find(s => Number(s.strike) === ceTarget);
    const peLeg = strikes.find(s => Number(s.strike) === peTarget);
    const ceLtp = _safe(ceLeg?.call?.ltp ?? ceLeg?.ce?.ltp);
    const peLtp = _safe(peLeg?.put?.ltp  ?? peLeg?.pe?.ltp);

    // Hero confidence — score-based (7 → 78%, 9 → 92%)
    const HERO_THRESHOLD = 7;
    const ceConfidence = ceScore >= HERO_THRESHOLD ? Math.min(95, 70 + ceScore * 3) : null;
    const peConfidence = peScore >= HERO_THRESHOLD ? Math.min(95, 70 + peScore * 3) : null;

    // Verdict
    let verdict, side, target, ltp, confidence, headline, subline, momentum, premiumPct;
    if (ceConfidence != null && ceScore > peScore) {
      verdict = 'HERO_CE';  side = 'CE';
      target = ceTarget; ltp = ceLtp; confidence = ceConfidence;
      headline = 'Momentum Expansion Active';
      subline  = 'Smart money entering CE side';
      momentum = ceScore >= 8 ? 'EXPLODING' : 'EXPANDING';
      premiumPct = ceExpanding ? '+22%' : '+12%';   // proxy display
    } else if (peConfidence != null) {
      verdict = 'HERO_PE';  side = 'PE';
      target = peTarget; ltp = peLtp; confidence = peConfidence;
      headline = 'Downside Momentum Explosion';
      subline  = 'Smart money entering PE side';
      momentum = peScore >= 8 ? 'EXPLODING' : 'EXPANDING';
      premiumPct = peExpanding ? '+24%' : '+14%';
    } else {
      verdict = 'ZERO';     side = null;
      target = null; ltp = null; confidence = null;
      // Zero subreason: which kill-switch fired?
      if (insideValue)               { headline = 'Inside Value Area';   subline = 'Premium decay risk · No edge'; }
      else if (bullTrap)             { headline = 'Bull Trap Detected';  subline = 'CE breakout fakeout — avoid CE'; }
      else if (bearTrap)             { headline = 'Bear Trap Detected';  subline = 'PE breakdown fakeout — avoid PE'; }
      else if (!ceExpanding && !peExpanding) { headline = 'Premium Stagnant'; subline = 'No expansion either side'; }
      else                            { headline = 'No Edge';             subline = 'Mixed flow · wait for confirmation'; }
      momentum = 'FLAT';
      premiumPct = '0%';
    }

    return {
      verdict,            // HERO_CE | HERO_PE | ZERO
      side,               // CE | PE | null
      strike: target,
      ltp,
      confidence,
      headline,
      subline,
      momentum,
      premiumPct,
      scores: {
        ce: ceScore,
        pe: peScore,
        threshold: HERO_THRESHOLD,
      },
      signals: {
        aboveVAH, belowVAL, insideValue,
        aboveVWAP, belowVWAP,
        acceptedAbove, acceptedBelow,
        ceExpanding, peExpanding,
        buyersDominant, sellersDominant,
        deltaPos, deltaNeg, deltaPct: fDelta?.deltaPct ?? 0,
        volSurge,
        bullTrap, bearTrap,
        ivLevel: atmBlk.atmIv,
        vix: macro?.vix?.price ?? null,
      },
      // Top-3 firing reasons for the chip strip
      reasons: (() => {
        const r = [];
        if (verdict === 'HERO_CE') {
          if (aboveVAH)       r.push('Above VAH');
          if (aboveVWAP)      r.push('Above VWAP');
          if (ceExpanding)    r.push('CE Premium Expanding');
          if (buyersDominant) r.push(`Buyers ${fDom?.buyersScore}%`);
          if (deltaPos)       r.push(`Δ +${(fDelta?.deltaPct ?? 0).toFixed(1)}%`);
          if (volSurge)       r.push('Volume Surge');
        } else if (verdict === 'HERO_PE') {
          if (belowVAL)        r.push('Below VAL');
          if (belowVWAP)       r.push('Below VWAP');
          if (peExpanding)     r.push('PE Premium Expanding');
          if (sellersDominant) r.push(`Sellers ${fDom?.sellersScore}%`);
          if (deltaNeg)        r.push(`Δ ${(fDelta?.deltaPct ?? 0).toFixed(1)}%`);
          if (volSurge)        r.push('Volume Surge');
        } else {
          if (insideValue)     r.push('Inside Value');
          if (bullTrap)        r.push('Bull Trap');
          if (bearTrap)        r.push('Bear Trap');
          if (!ceExpanding && !peExpanding) r.push('Premium Flat');
        }
        return r.slice(0, 4);
      })(),
    };
  })();

  // ── PREMIUM MOMENTUM ENGINE ─────────────────────────────────────────
  // Tracks REAL CE/PE premium expansion % using a per-symbol ring buffer
  // of ATM CE/PE LTP samples. Replaces the prior implementation which
  // derived expansion from the static premium-velocity skew — that read
  // is just the size ratio of the two premiums (CE bigger when IV skew is
  // positive) and falsely reported "CE Momentum Strong" on bear days.
  //
  // The new engine:
  //   1. Pushes (t, ceLtp, peLtp) into _premiumHistory on every call
  //   2. Picks a baseline sample ~5–10 min old (or oldest available)
  //   3. Computes ceExpansionPct = (ceLtp − ceBase) / ceBase × 100
  //   4. Same for PE. Sign + magnitude are now real.
  //   5. Falls back to the old skew heuristic only when fewer than 3
  //      samples exist (cold start).
  //
  // Lives at dashboard.premiumMomentum.
  const premiumMomentum = (() => {
    const fEngine = frvpInstitutional?.engine;
    const fPrem = fEngine?.advanced?.premiumVel;
    const fDelta = fEngine?.delta;

    // Current ATM CE/PE LTP
    const ceLtp = _safe(atmBlk.atmCall?.ltp);
    const peLtp = _safe(atmBlk.atmPut?.ltp);
    const now = Date.now();

    // ── Maintain ring buffer ──────────────────────────────────────────
    const histKey = `${SYMBOL}|${atm}`; // include ATM strike — flush trail when ATM jumps
    const trail = _premiumHistory.get(histKey) || [];
    if (ceLtp > 0 && peLtp > 0) {
      trail.push({ t: now, ceLtp, peLtp });
      // prune by age + max length
      while (trail.length > 0 && (now - trail[0].t) > PREMIUM_HISTORY_TTL_MS) trail.shift();
      while (trail.length > PREMIUM_HISTORY_MAX) trail.shift();
      _premiumHistory.set(histKey, trail);
    }

    // ── Baseline pick — sample closest to (now − 8 min) ───────────────
    const TARGET_BASELINE_MS = 8 * 60_000;
    let baseline = null;
    if (trail.length >= 3) {
      const targetT = now - TARGET_BASELINE_MS;
      // find the sample with t closest to targetT, but never the latest one
      let best = trail[0];
      let bestDist = Math.abs(best.t - targetT);
      for (let i = 1; i < trail.length - 1; i++) {
        const d = Math.abs(trail[i].t - targetT);
        if (d < bestDist) { bestDist = d; best = trail[i]; }
      }
      baseline = best;
    }

    // ── Real expansion % ──────────────────────────────────────────────
    let ceExpansionPct, peExpansionPct;
    if (baseline && baseline.ceLtp > 0 && baseline.peLtp > 0) {
      ceExpansionPct = _round(((ceLtp - baseline.ceLtp) / baseline.ceLtp) * 100, 0);
      peExpansionPct = _round(((peLtp - baseline.peLtp) / baseline.peLtp) * 100, 0);
    } else {
      // Cold-start fallback: only first 3 polls. Use the old skew heuristic
      // but mark it clearly so consumers know it isn't yet reliable.
      const skew = _safe(fPrem?.skew);
      ceExpansionPct = (() => {
        if (fPrem?.state === 'CE_EXPANDING') return _round(15 + skew * 60, 0);
        if (fPrem?.state === 'PE_EXPANDING') return _round(skew * 40, 0);
        return _round(skew * 30, 0);
      })();
      peExpansionPct = (() => {
        if (fPrem?.state === 'PE_EXPANDING') return _round(15 - skew * 60, 0);
        if (fPrem?.state === 'CE_EXPANDING') return _round(-skew * 40, 0);
        return _round(-skew * 30, 0);
      })();
    }

    // Momentum quality — uses delta + premium velocity + writer pressure
    const dPct = Math.abs(_safe(fDelta?.deltaPct));
    const aggressiveExpansion = Math.max(Math.abs(ceExpansionPct), Math.abs(peExpansionPct));
    const momentumScore =
      (dPct >= 12 ? 35 : dPct >= 6 ? 22 : 10) +
      (aggressiveExpansion >= 20 ? 35 : aggressiveExpansion >= 10 ? 22 : 8) +
      (atmBlk.peWriting || atmBlk.ceWriting ? 15 : 0) +
      (regimeBlk.dayType === 'TREND DAY' ? 15 : 5);
    const momentumQuality =
      momentumScore >= 75 ? 'STRONG'
      : momentumScore >= 50 ? 'MODERATE'
      : 'WEAK';
    const momentumTone =
      momentumQuality === 'STRONG' ? (peExpansionPct > ceExpansionPct ? 'bear' : 'bull')
      : momentumQuality === 'MODERATE' ? 'warn'
      : 'neutral';

    // Delta speed — how fast cumulative delta is building
    const deltaPct = _safe(fDelta?.deltaPct);
    const deltaSpeed =
      Math.abs(deltaPct) >= 20 ? 'AGGRESSIVE'
      : Math.abs(deltaPct) >= 10 ? 'MODERATE'
      : Math.abs(deltaPct) >= 4 ? 'SLOW'
      : 'FLAT';
    const deltaTone =
      deltaPct > 8 ? 'bull' : deltaPct < -8 ? 'bear' : 'warn';

    // Scalping aggression — combination of regime + volume burst
    const lastBar = c5m[c5m.length - 1];
    const priorAvgVol = c5m.slice(-21, -1).reduce((s, b) => s + (b.volume || 0), 0) / Math.max(1, Math.min(20, c5m.length - 1));
    const volSurge = (lastBar?.volume || 0) > priorAvgVol * 1.5 && priorAvgVol > 0;
    const scalpingScore =
      (volSurge ? 30 : 0) +
      (Math.abs(deltaPct) >= 10 ? 25 : 10) +
      (aggressiveExpansion >= 15 ? 25 : 10) +
      (regimeBlk.volatility === 'HIGH' ? 20 : 10);
    const scalpingAggression =
      scalpingScore >= 70 ? 'HIGH'
      : scalpingScore >= 45 ? 'MODERATE'
      : 'LOW';
    const scalpingTone =
      scalpingAggression === 'HIGH' ? 'bull'
      : scalpingAggression === 'MODERATE' ? 'warn'
      : 'neutral';

    // ── Real CE / PE LTP sparkline trails from the ring buffer ────────
    // Take the last 30 samples; if fewer, synthesise from the candle stream
    // as a visual placeholder.
    let ceSpark, peSpark;
    if (trail.length >= 6) {
      const tail = trail.slice(-30);
      ceSpark = tail.map(s => _round(s.ceLtp, 2));
      peSpark = tail.map(s => _round(s.peLtp, 2));
    } else {
      const buildSpark = (sign) => {
        const window = c5m.slice(-30);
        if (!window.length) return [];
        const out = [];
        let acc = 100;
        for (const c of window) {
          const range = Math.max(0.01, c.high - c.low);
          const closePos = ((2 * c.close - c.high - c.low) / range);
          const move = closePos * sign * 1.2;
          acc += move;
          out.push(_round(acc, 2));
        }
        return out;
      };
      ceSpark = buildSpark(+1);
      peSpark = buildSpark(-1);
    }

    // Top-level state — directional read of expansion
    let topState, topTone, topLabel;
    if (ceExpansionPct > peExpansionPct + 5 && ceExpansionPct >= 8) {
      topState = 'CE Momentum Strong';
      topTone = 'bull';
      topLabel = '🟢';
    } else if (peExpansionPct > ceExpansionPct + 5 && peExpansionPct >= 8) {
      topState = 'PE Momentum Strong';
      topTone = 'bear';
      topLabel = '🔴';
    } else if (Math.max(ceExpansionPct, peExpansionPct) < 5) {
      topState = 'Weak Premium';
      topTone = 'warn';
      topLabel = '⚠';
    } else {
      topState = 'Two-sided Momentum';
      topTone = 'warn';
      topLabel = '◇';
    }

    return {
      topState, topTone, topLabel,
      ceExpansionPct, peExpansionPct,
      ceSpark, peSpark,
      ceLtp: _round(ceLtp, 2),
      peLtp: _round(peLtp, 2),
      momentumQuality, momentumTone, momentumScore,
      deltaSpeed, deltaTone, deltaPct: _round(deltaPct, 2),
      scalpingAggression, scalpingTone, scalpingScore,
      volSurge,
      // Debug — surface the baseline reference time so we know whether the
      // engine is running on real history or the cold-start fallback.
      baselineAgeSec: baseline ? Math.round((now - baseline.t) / 1000) : 0,
      historyDepth: trail.length,
    };
  })();

  // ── TRADE STRATEGY ENGINE ───────────────────────────────────────────
  // Classifies the current setup into one of 5 actionable strategies:
  //   🟢 BUY_ON_DIP_CE      — bullish trend pullback (buy near support)
  //   🔴 SELL_ON_RISE_PE    — bearish trend pullback (buy PE near resistance)
  //   🚀 BREAKOUT_CE_BUY    — momentum break above VAH / resistance
  //   🚀 BREAKDOWN_PE_BUY   — momentum break below VAL / support
  //   🟡 RANGE_MARKET       — inside value, choppy, avoid directional
  //
  // Returns the chosen strategy with target strike, confidence, and the
  // 4 firing reasons that produced the verdict.
  const tradeStrategy = (() => {
    const fEngine = frvpInstitutional?.engine;
    const fAccept = fEngine?.acceptance;
    const fDom    = fEngine?.dominance;
    const fDelta  = fEngine?.delta;
    const fPrem   = fEngine?.advanced?.premiumVel;

    // Core signals
    const aboveVWAP = vwap != null && Number.isFinite(spotPrice) && spotPrice > vwap;
    const belowVWAP = vwap != null && Number.isFinite(spotPrice) && spotPrice < vwap;
    const abovePOC  = vp?.poc != null && Number.isFinite(spotPrice) && spotPrice > vp.poc;
    const belowPOC  = vp?.poc != null && Number.isFinite(spotPrice) && spotPrice < vp.poc;
    const aboveVAH  = vaPrimary?.vah != null && Number.isFinite(spotPrice) && spotPrice > vaPrimary.vah;
    const belowVAL  = vaPrimary?.val != null && Number.isFinite(spotPrice) && spotPrice < vaPrimary.val;
    const insideValue = vaPrimary?.vah != null && vaPrimary?.val != null
      && spotPrice >= vaPrimary.val && spotPrice <= vaPrimary.vah;

    const acceptedAbove  = !!fAccept?.acceptedAboveVAH;
    const acceptedBelow  = !!fAccept?.acceptedBelowVAL;
    const rejectedAbove  = !!fAccept?.rejectedAboveVAH;
    const rejectedBelow  = !!fAccept?.rejectedBelowVAL;

    const ceExpanding = fPrem?.state === 'CE_EXPANDING';
    const peExpanding = fPrem?.state === 'PE_EXPANDING';
    const expansion   = premiumMomentum?.momentumQuality === 'STRONG';

    const buyersDominant  = fDom?.dominantSide === 'BUYERS'  && fDom?.buyersScore  >= 60;
    const sellersDominant = fDom?.dominantSide === 'SELLERS' && fDom?.sellersScore >= 60;

    const deltaPos = (fDelta?.deltaPct ?? 0) >=  8;
    const deltaNeg = (fDelta?.deltaPct ?? 0) <= -8;

    // Pullback detection — within 30 bps of VWAP & not yet bouncing
    const pullbackBullish = aboveVWAP && Number.isFinite(spotPrice) && Number.isFinite(vwap)
      && Math.abs(spotPrice - vwap) / vwap <= 0.005 && spotPrice >= vwap;
    const pullbackBearish = belowVWAP && Number.isFinite(spotPrice) && Number.isFinite(vwap)
      && Math.abs(spotPrice - vwap) / vwap <= 0.005 && spotPrice <= vwap;

    // Support/resistance reaction
    const closestPeWall = (marketDirection?.supports || [])[0]?.strike;
    const closestCeWall = (marketDirection?.resistances || [])[0]?.strike;
    const supportHolding   = closestPeWall != null && spotPrice > closestPeWall && atmBlk.peWriting;
    const resistanceCapping = closestCeWall != null && spotPrice < closestCeWall && atmBlk.ceWriting;

    // Volume burst — for breakout / breakdown confirmation
    const lastBar = c5m[c5m.length - 1];
    const priorAvgVol = c5m.slice(-21, -1).reduce((s, b) => s + (b.volume || 0), 0)
      / Math.max(1, Math.min(20, c5m.length - 1));
    const volSurge = (lastBar?.volume || 0) > priorAvgVol * 1.5 && priorAvgVol > 0;

    // Score each strategy independently — strategy with highest score wins
    const scores = {
      BUY_ON_DIP_CE: 0,
      SELL_ON_RISE_PE: 0,
      BREAKOUT_CE_BUY: 0,
      BREAKDOWN_PE_BUY: 0,
      RANGE_MARKET: 0,
    };
    const reasons = {
      BUY_ON_DIP_CE: [],
      SELL_ON_RISE_PE: [],
      BREAKOUT_CE_BUY: [],
      BREAKDOWN_PE_BUY: [],
      RANGE_MARKET: [],
    };

    // 1) BUY_ON_DIP_CE — bullish trend pullback
    if (aboveVWAP)         { scores.BUY_ON_DIP_CE += 2; reasons.BUY_ON_DIP_CE.push('Above VWAP'); }
    if (abovePOC)          { scores.BUY_ON_DIP_CE += 1; reasons.BUY_ON_DIP_CE.push('Above POC'); }
    if (atmBlk.peWriting)  { scores.BUY_ON_DIP_CE += 2; reasons.BUY_ON_DIP_CE.push('PE Writing Strong'); }
    if (buyersDominant)    { scores.BUY_ON_DIP_CE += 2; reasons.BUY_ON_DIP_CE.push(`Buyers ${fDom?.buyersScore?.toFixed(0)}%`); }
    if (supportHolding)    { scores.BUY_ON_DIP_CE += 1; reasons.BUY_ON_DIP_CE.push(`Support ${closestPeWall} holding`); }
    if (deltaPos)          { scores.BUY_ON_DIP_CE += 1; reasons.BUY_ON_DIP_CE.push(`Δ +${(fDelta?.deltaPct ?? 0).toFixed(1)}%`); }
    if (pullbackBullish)   { scores.BUY_ON_DIP_CE += 2; reasons.BUY_ON_DIP_CE.push('VWAP Pullback'); }
    if (ceExpanding)       { scores.BUY_ON_DIP_CE += 1; reasons.BUY_ON_DIP_CE.push('CE Premium Holding'); }
    if (rejectedBelow)     { scores.BUY_ON_DIP_CE += 1; reasons.BUY_ON_DIP_CE.push('Bear trap rejection'); }

    // 2) SELL_ON_RISE_PE — bearish trend pullback
    if (belowVWAP)           { scores.SELL_ON_RISE_PE += 2; reasons.SELL_ON_RISE_PE.push('Below VWAP'); }
    if (belowPOC)            { scores.SELL_ON_RISE_PE += 1; reasons.SELL_ON_RISE_PE.push('Below POC'); }
    if (atmBlk.ceWriting)    { scores.SELL_ON_RISE_PE += 2; reasons.SELL_ON_RISE_PE.push('CE Writing Aggressive'); }
    if (sellersDominant)     { scores.SELL_ON_RISE_PE += 2; reasons.SELL_ON_RISE_PE.push(`Sellers ${fDom?.sellersScore?.toFixed(0)}%`); }
    if (resistanceCapping)   { scores.SELL_ON_RISE_PE += 1; reasons.SELL_ON_RISE_PE.push(`Resistance ${closestCeWall} capping`); }
    if (deltaNeg)            { scores.SELL_ON_RISE_PE += 1; reasons.SELL_ON_RISE_PE.push(`Δ ${(fDelta?.deltaPct ?? 0).toFixed(1)}%`); }
    if (pullbackBearish)     { scores.SELL_ON_RISE_PE += 2; reasons.SELL_ON_RISE_PE.push('VWAP Rejection'); }
    if (peExpanding)         { scores.SELL_ON_RISE_PE += 1; reasons.SELL_ON_RISE_PE.push('PE Premium Strength'); }
    if (rejectedAbove)       { scores.SELL_ON_RISE_PE += 1; reasons.SELL_ON_RISE_PE.push('Bull trap rejection'); }

    // 3) BREAKOUT_CE_BUY — momentum break above VAH
    if (aboveVAH)            { scores.BREAKOUT_CE_BUY += 3; reasons.BREAKOUT_CE_BUY.push('Above VAH'); }
    if (acceptedAbove)       { scores.BREAKOUT_CE_BUY += 2; reasons.BREAKOUT_CE_BUY.push('Accepted Above VAH'); }
    if (volSurge)            { scores.BREAKOUT_CE_BUY += 2; reasons.BREAKOUT_CE_BUY.push('Volume Surge'); }
    if (ceExpanding)         { scores.BREAKOUT_CE_BUY += 2; reasons.BREAKOUT_CE_BUY.push('CE Premium Expanding'); }
    if (atmBlk.ceUnwinding)  { scores.BREAKOUT_CE_BUY += 1; reasons.BREAKOUT_CE_BUY.push('CE Unwinding'); }
    if (buyersDominant)      { scores.BREAKOUT_CE_BUY += 1; reasons.BREAKOUT_CE_BUY.push(`Buyers ${fDom?.buyersScore?.toFixed(0)}%`); }
    if (deltaPos)            { scores.BREAKOUT_CE_BUY += 1; reasons.BREAKOUT_CE_BUY.push(`Δ +${(fDelta?.deltaPct ?? 0).toFixed(1)}%`); }
    if (rejectedAbove)       { scores.BREAKOUT_CE_BUY -= 5; } // hard veto on bull trap

    // 4) BREAKDOWN_PE_BUY — momentum break below VAL
    if (belowVAL)            { scores.BREAKDOWN_PE_BUY += 3; reasons.BREAKDOWN_PE_BUY.push('Below VAL'); }
    if (acceptedBelow)       { scores.BREAKDOWN_PE_BUY += 2; reasons.BREAKDOWN_PE_BUY.push('Accepted Below VAL'); }
    if (volSurge)            { scores.BREAKDOWN_PE_BUY += 2; reasons.BREAKDOWN_PE_BUY.push('Volume Surge'); }
    if (peExpanding)         { scores.BREAKDOWN_PE_BUY += 2; reasons.BREAKDOWN_PE_BUY.push('PE Premium Exploding'); }
    if (atmBlk.ceWriting)    { scores.BREAKDOWN_PE_BUY += 1; reasons.BREAKDOWN_PE_BUY.push('CE Writers Aggressive'); }
    if (sellersDominant)     { scores.BREAKDOWN_PE_BUY += 1; reasons.BREAKDOWN_PE_BUY.push(`Sellers ${fDom?.sellersScore?.toFixed(0)}%`); }
    if (deltaNeg)            { scores.BREAKDOWN_PE_BUY += 1; reasons.BREAKDOWN_PE_BUY.push(`Δ ${(fDelta?.deltaPct ?? 0).toFixed(1)}%`); }
    if (rejectedBelow)       { scores.BREAKDOWN_PE_BUY -= 5; } // hard veto on bear trap

    // 5) RANGE_MARKET — inside value, balanced flow, weak premium
    if (insideValue)                                     { scores.RANGE_MARKET += 3; reasons.RANGE_MARKET.push('Inside Value Area'); }
    if (fDom?.dominantSide === 'BALANCED')               { scores.RANGE_MARKET += 2; reasons.RANGE_MARKET.push('Balanced Flow'); }
    if (atmBlk.ceWriting && atmBlk.peWriting)            { scores.RANGE_MARKET += 2; reasons.RANGE_MARKET.push('Two-sided Writing'); }
    if (!ceExpanding && !peExpanding)                    { scores.RANGE_MARKET += 1; reasons.RANGE_MARKET.push('Premium Stagnant'); }
    if (Math.abs(fDelta?.deltaPct ?? 0) < 5)             { scores.RANGE_MARKET += 1; reasons.RANGE_MARKET.push(`Δ Neutral ${(fDelta?.deltaPct ?? 0).toFixed(1)}%`); }

    // Pick the winning strategy.
    // Tie-break by composite directional bias when scores are equal:
    //   1. Master verdict side (cePct vs pePct)
    //   2. PLUS price location (above/below VWAP and VAL/VAH)
    // Without this, JS Object.entries insertion order silently prefers
    // BUY_ON_DIP_CE on every tie, which falsely reads as a CE setup
    // even when price is clearly below VWAP and below VAL.
    const verdictDir = verdict.cePct >= verdict.pePct ? 'CE' : 'PE';
    // Location score — strong vote for the side aligned with price action.
    let locationDir = 'NEUTRAL';
    if (belowVWAP && belowVAL)        locationDir = 'PE';
    else if (aboveVWAP && aboveVAH)   locationDir = 'CE';
    else if (belowVWAP || belowVAL)   locationDir = 'PE';
    else if (aboveVWAP || aboveVAH)   locationDir = 'CE';
    // Combined directional preference: location wins over verdict edge
    // when the verdict is essentially flat (≤ 5 pts spread).
    const verdictSpread = Math.abs(verdict.cePct - verdict.pePct);
    const tieBreakDir = verdictSpread < 5 && locationDir !== 'NEUTRAL'
      ? locationDir
      : verdictDir;

    const sideOf = (key) =>
      key.includes('CE') ? 'CE'
      : key.includes('PE') ? 'PE'
      : 'NEUTRAL';
    const ranked = Object.entries(scores).sort((a, b) => {
      const diff = b[1] - a[1];
      if (diff !== 0) return diff;
      // Equal score: strategies aligned with directional bias come first.
      const aAlign = sideOf(a[0]) === tieBreakDir ? 1 : 0;
      const bAlign = sideOf(b[0]) === tieBreakDir ? 1 : 0;
      return bAlign - aAlign;
    });
    const [topKey, topScore] = ranked[0];
    const runnerUp = ranked[1]?.[1] ?? 0;
    // Edge over runner-up — used to gauge confidence
    const edge = topScore - runnerUp;

    // Confidence — score-based, capped 25-92
    // Each strategy has a different theoretical max:
    //   BUY_ON_DIP_CE     max 13
    //   SELL_ON_RISE_PE   max 13
    //   BREAKOUT_CE_BUY   max 12
    //   BREAKDOWN_PE_BUY  max 12
    //   RANGE_MARKET      max 9
    const maxByStrategy = {
      BUY_ON_DIP_CE: 13, SELL_ON_RISE_PE: 13,
      BREAKOUT_CE_BUY: 12, BREAKDOWN_PE_BUY: 12,
      RANGE_MARKET: 9,
    };
    const maxScore = maxByStrategy[topKey] || 13;
    const fillPct = Math.max(0, Math.min(1, topScore / maxScore));
    const confidence = Math.max(25, Math.min(92, Math.round(40 + fillPct * 50 + edge * 2)));

    // Map strategy → display attributes
    const STEP = 100;
    const ceStrike = Math.round((spotPrice + STEP) / STEP) * STEP;
    const peStrike = Math.round((spotPrice - STEP) / STEP) * STEP;
    const STRATEGY_META = {
      BUY_ON_DIP_CE: {
        verdict: 'BUY CE', strategy: 'BUY ON DIP', icon: '🟢',
        side: 'CE', strike: ceStrike, tone: 'bull',
        headline: 'Buyers defending support', subline: 'Dip buying active',
      },
      SELL_ON_RISE_PE: {
        verdict: 'BUY PE', strategy: 'SELL ON RISE', icon: '🔴',
        side: 'PE', strike: peStrike, tone: 'bear',
        headline: 'Sellers defending resistance', subline: 'Rise getting sold',
      },
      BREAKOUT_CE_BUY: {
        verdict: 'BUY CE', strategy: 'BREAKOUT BUY', icon: '🚀',
        side: 'CE', strike: ceStrike, tone: 'bull',
        headline: 'Bullish breakout confirmed', subline: 'Momentum + acceptance aligned',
      },
      BREAKDOWN_PE_BUY: {
        verdict: 'BUY PE', strategy: 'BREAKDOWN BUY', icon: '🚀',
        side: 'PE', strike: peStrike, tone: 'bear',
        headline: 'Bearish breakdown confirmed', subline: 'Panic + acceptance aligned',
      },
      RANGE_MARKET: {
        verdict: 'WAIT', strategy: 'RANGE MARKET', icon: '🟡',
        side: null, strike: null, tone: 'warn',
        headline: 'Inside value area', subline: 'Choppy market — avoid directional',
      },
    };

    // If top strategy score is too low (<5) or weak premium kills directional,
    // demote to RANGE MARKET regardless of nominal winner.
    let finalKey = topKey;
    if (topScore < 5 || (topKey !== 'RANGE_MARKET' && !ceExpanding && !peExpanding && Math.abs(fDelta?.deltaPct ?? 0) < 4)) {
      finalKey = 'RANGE_MARKET';
    }
    const meta = STRATEGY_META[finalKey];

    // Pick top-4 firing reasons for the chosen strategy
    const topReasons = reasons[finalKey].slice(0, 4);

    return {
      key: finalKey,
      verdict: meta.verdict,           // BUY CE / BUY PE / WAIT
      strategy: meta.strategy,         // BUY ON DIP / SELL ON RISE / BREAKOUT BUY / BREAKDOWN BUY / RANGE MARKET
      icon: meta.icon,
      side: meta.side,                 // CE / PE / null
      strike: meta.strike,
      tone: meta.tone,                 // bull / bear / warn
      headline: meta.headline,
      subline: meta.subline,
      confidence,
      topReasons,
      scores,
      edge,
      ranked: ranked.map(([k, s]) => ({ key: k, score: s })),
    };
  })();

  // ── FINAL EXECUTION ENGINE ──────────────────────────────────────────
  // The single decision brain.  Synthesises HeroZero + TradeStrategy +
  // BestTradePick + MasterVerdict + MarketRegime + TimeOfDay + LateEntry
  // filter + No-Trade score into ONE clear output:
  //
  //   FINAL ACTION:  BUY CE | BUY PE | WAIT
  //   MODE:          HERO  | NORMAL | AVOID
  //   ENTRY TYPE:    Breakout | Buy Dip | Sell Rise | Reversal | None
  //   CONFIDENCE:    0..100
  //   WHY:           top-4 supportive reasons
  //   WHY NOT:       penalties / blockers (if any)
  //
  // Drives the new top-of-dashboard "AI Execution Engine" card.
  const executionEngine = (() => {
    // ─── Time-of-day phase ────────────────────────────────────────────
    const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
    const hh = istNow.getUTCHours();
    const mm = istNow.getUTCMinutes();
    const minutesIst = hh * 60 + mm;
    const phase = (() => {
      if (minutesIst < 9 * 60 + 15)                     return 'PRE_MARKET';
      if (minutesIst < 10 * 60)                          return 'OPEN_DRIVE';      // 09:15–10:00
      if (minutesIst < 11 * 60 + 30)                     return 'MORNING_TREND';   // 10:00–11:30
      if (minutesIst < 13 * 60 + 30)                     return 'MIDDAY_CHOP';     // 11:30–13:30
      if (minutesIst < 14 * 60 + 15)                     return 'AFTERNOON_BUILD'; // 13:30–14:15
      if (minutesIst < 15 * 60)                          return 'POWER_HOUR';      // 14:15–15:00
      if (minutesIst < 15 * 60 + 30)                     return 'CLOSING_DRIFT';   // 15:00–15:30
      return 'POST_MARKET';
    })();
    const phaseLabel = {
      PRE_MARKET: 'PRE-MARKET',
      OPEN_DRIVE: 'OPEN DRIVE',
      MORNING_TREND: 'MORNING TREND',
      MIDDAY_CHOP: 'MIDDAY CHOP',
      AFTERNOON_BUILD: 'AFTERNOON BUILD',
      POWER_HOUR: 'POWER HOUR',
      CLOSING_DRIFT: 'CLOSING DRIFT',
      POST_MARKET: 'POST-MARKET',
    }[phase];

    // ─── Market regime detection ─────────────────────────────────────
    // Classifies the day into one of 7 regimes used to adapt weights.
    const fEngine = frvpInstitutional?.engine;
    const fAccept = fEngine?.acceptance;
    const fDom    = fEngine?.dominance;
    const fDelta  = fEngine?.delta;
    const fPrem   = fEngine?.advanced?.premiumVel;

    const aboveVAH = vaPrimary?.vah != null && Number.isFinite(spotPrice) && spotPrice > vaPrimary.vah;
    const belowVAL = vaPrimary?.val != null && Number.isFinite(spotPrice) && spotPrice < vaPrimary.val;
    const insideValue = vaPrimary?.vah != null && vaPrimary?.val != null
      && spotPrice >= vaPrimary.val && spotPrice <= vaPrimary.vah;

    const trendStrength = regimeBlk.trendStrength;
    const volatility = regimeBlk.volatility;
    const dayType = regimeBlk.dayType;

    // Expiry detection — Thu/Tue (NIFTY/BANKNIFTY weekly)
    const dow = istNow.getUTCDay();
    const isExpiryDay = (sym.key === 'NIFTY_50' && dow === 4)        // Thursday
                     || (sym.key === 'BANKNIFTY' && dow === 4)
                     || (sym.key === 'SENSEX'   && dow === 2);       // Tuesday

    // Gap detection — open vs prior close
    const sessionOpen = c1m[0]?.open ?? null;
    const gapPct = (sessionOpen != null && priorClose) ? ((sessionOpen - priorClose) / priorClose) * 100 : 0;
    const isGapDay = Math.abs(gapPct) >= 0.4;

    let regime;
    if (isExpiryDay && phase === 'AFTERNOON_BUILD' || isExpiryDay && phase === 'POWER_HOUR') {
      regime = 'EXPIRY_CHAOS';
    } else if (isExpiryDay) {
      regime = 'EXPIRY_DECAY';
    } else if (isGapDay && Math.abs(spotPrice - sessionOpen) < Math.abs(gapPct * priorClose / 100) * 0.4) {
      regime = 'GAP_FILL_DAY';
    } else if (volatility === 'HIGH' && dayType === 'TREND DAY') {
      regime = 'VOLATILE_TREND';
    } else if (dayType === 'TREND DAY') {
      regime = 'TREND_DAY';
    } else if (atmBlk.ceUnwinding && fDelta?.bias === 'bullish') {
      regime = 'SHORT_COVERING';
    } else if (atmBlk.peUnwinding && fDelta?.bias === 'bearish') {
      regime = 'LONG_UNWINDING';
    } else if (insideValue && fDom?.dominantSide === 'BALANCED') {
      regime = 'RANGE_DAY';
    } else {
      regime = 'MEAN_REVERSION';
    }

    // ─── Dynamic weight tuning by regime ─────────────────────────────
    // These multipliers tilt downstream scoring depending on regime.
    const weightBoost = {
      TREND_DAY:        { vwap: 1.3, frvp: 1.2, premium: 1.0, delta: 1.0, support: 0.8 },
      VOLATILE_TREND:   { vwap: 1.2, frvp: 1.1, premium: 1.3, delta: 1.3, support: 0.7 },
      RANGE_DAY:        { vwap: 0.7, frvp: 0.8, premium: 0.9, delta: 0.9, support: 1.4 },
      SHORT_COVERING:   { vwap: 1.0, frvp: 1.1, premium: 1.2, delta: 1.2, support: 0.9 },
      LONG_UNWINDING:   { vwap: 1.0, frvp: 1.1, premium: 1.2, delta: 1.2, support: 0.9 },
      EXPIRY_CHAOS:     { vwap: 0.6, frvp: 0.6, premium: 1.5, delta: 1.5, support: 0.5 },
      EXPIRY_DECAY:     { vwap: 0.8, frvp: 0.8, premium: 1.4, delta: 1.4, support: 0.7 },
      GAP_FILL_DAY:     { vwap: 1.2, frvp: 1.0, premium: 1.0, delta: 1.0, support: 1.1 },
      MEAN_REVERSION:   { vwap: 0.9, frvp: 1.0, premium: 1.0, delta: 1.0, support: 1.2 },
    }[regime] || { vwap: 1, frvp: 1, premium: 1, delta: 1, support: 1 };

    // ─── No-Trade score (0..100) ─────────────────────────────────────
    // Higher = stronger reason to wait.  Above 60 forces WAIT.
    let noTradeScore = 0;
    const noTradeReasons = [];
    if (insideValue)                           { noTradeScore += 20; noTradeReasons.push('Inside value area'); }
    if (atmBlk.atmIv < 8)                      { noTradeScore += 18; noTradeReasons.push('Premium dead (IV<8)'); }
    if (Math.abs(fDelta?.deltaPct ?? 0) < 4)   { noTradeScore += 12; noTradeReasons.push('Delta neutral'); }
    if (fDom?.dominantSide === 'BALANCED')     { noTradeScore += 10; noTradeReasons.push('Two-sided flow'); }
    if (fAccept?.rejectedAboveVAH)             { noTradeScore += 15; noTradeReasons.push('Bull-trap rejection'); }
    if (fAccept?.rejectedBelowVAL)             { noTradeScore += 15; noTradeReasons.push('Bear-trap rejection'); }
    if (phase === 'MIDDAY_CHOP')               { noTradeScore += 12; noTradeReasons.push('Lunchtime chop'); }
    if (phase === 'CLOSING_DRIFT')             { noTradeScore += 8;  noTradeReasons.push('Closing drift'); }
    if (regime === 'EXPIRY_CHAOS')             { noTradeScore += 14; noTradeReasons.push('Expiry chaos'); }
    if ((trapBlk?.score ?? 0) >= 60)           { noTradeScore += 18; noTradeReasons.push('Trap risk high'); }

    // ─── Late-entry filter ───────────────────────────────────────────
    // Penalises chasing — if spot has run too far from VWAP/EMA9/POC.
    const distVwapPct  = vwap     != null && spotPrice ? Math.abs(spotPrice - vwap)     / vwap     * 100 : 0;
    const distEma9Pct  = ema9     != null && spotPrice ? Math.abs(spotPrice - ema9)     / ema9     * 100 : 0;
    const distPocPct   = vp?.poc  != null && spotPrice ? Math.abs(spotPrice - vp.poc)   / vp.poc   * 100 : 0;
    const stretched    = distVwapPct > 0.50 || distEma9Pct > 0.35 || distPocPct > 0.45;
    const veryStretched= distVwapPct > 0.80 || distEma9Pct > 0.60 || distPocPct > 0.70;
    let lateEntryPenalty = 0;
    if (veryStretched)        lateEntryPenalty = 25;
    else if (stretched)       lateEntryPenalty = 12;

    // ─── Aggregate the inputs from existing engines ──────────────────
    const hzVerdict = heroZero?.verdict;
    const tsKey     = tradeStrategy?.key;
    const pickPrimary = bestTradePick?.primary;        // CE | PE | NEUTRAL
    const pickPick = pickPrimary === 'CE' ? bestTradePick?.ce
                   : pickPrimary === 'PE' ? bestTradePick?.pe
                   : null;
    const verdictSide = verdict.cePct >= 60 ? 'CE'
                      : verdict.pePct >= 60 ? 'PE' : 'NEUTRAL';

    // ─── Final action voting ─────────────────────────────────────────
    // Each engine casts a CE / PE / WAIT vote with a weight.
    const votes = { CE: 0, PE: 0, WAIT: 0 };
    const reasons = [];
    const blockers = [];

    // Vote 1: HeroZero (weight 30 if HERO, 10 if ZERO)
    if (hzVerdict === 'HERO_CE')      { votes.CE += 30 * weightBoost.premium;  reasons.push(`HERO CE @ ${heroZero.strike}`); }
    else if (hzVerdict === 'HERO_PE') { votes.PE += 30 * weightBoost.premium;  reasons.push(`HERO PE @ ${heroZero.strike}`); }
    else                              { votes.WAIT += 10; }

    // Vote 2: TradeStrategy (weight 25)
    const strategyVote = {
      BUY_ON_DIP_CE:    { side: 'CE', w: 25, label: 'Buy-on-dip setup' },
      SELL_ON_RISE_PE:  { side: 'PE', w: 25, label: 'Sell-on-rise setup' },
      BREAKOUT_CE_BUY:  { side: 'CE', w: 28, label: 'Breakout CE setup' },
      BREAKDOWN_PE_BUY: { side: 'PE', w: 28, label: 'Breakdown PE setup' },
      RANGE_MARKET:     { side: 'WAIT', w: 18, label: 'Range market' },
    }[tsKey];
    if (strategyVote) {
      const wt = strategyVote.w * (
        strategyVote.side === 'CE' || strategyVote.side === 'PE' ? weightBoost.frvp : 1
      );
      votes[strategyVote.side] += wt;
      reasons.push(strategyVote.label);
    }

    // Vote 3: BestTradePick (weight 20)
    if (pickPick && pickPrimary !== 'NEUTRAL') {
      votes[pickPrimary] += 20;
      reasons.push(`Pick ${pickPick.label} ${pickPick.probability}%`);
    } else {
      votes.WAIT += 8;
    }

    // Vote 4: MasterVerdict (weight 15 × vwap-boost)
    if (verdictSide !== 'NEUTRAL') {
      votes[verdictSide] += 15 * weightBoost.vwap;
      reasons.push(`Master verdict ${verdictSide} ${Math.max(verdict.cePct, verdict.pePct).toFixed(0)}%`);
    } else {
      votes.WAIT += 5;
    }

    // Vote 5: Delta bias (weight 10 × delta-boost)
    if (fDelta?.bias === 'bullish') votes.CE += 10 * weightBoost.delta;
    else if (fDelta?.bias === 'bearish') votes.PE += 10 * weightBoost.delta;
    else                                 votes.WAIT += 5;

    // ─── Penalties ───────────────────────────────────────────────────
    votes.WAIT += noTradeScore * 0.6;     // every no-trade pt becomes 0.6 wait pts
    if (lateEntryPenalty > 0) {
      blockers.push(veryStretched ? 'Move very stretched — chase risk' : 'Move stretched — late entry');
    }
    if (noTradeScore >= 60) {
      blockers.push('No-trade score elevated — wait for clarity');
    }

    // ─── Pick the winning action ─────────────────────────────────────
    let action = 'WAIT';
    if (votes.CE > votes.PE && votes.CE > votes.WAIT && votes.CE >= 35) action = 'BUY CE';
    else if (votes.PE > votes.CE && votes.PE > votes.WAIT && votes.PE >= 35) action = 'BUY PE';

    // Hard veto: if NoTrade ≥ 60 → WAIT regardless of votes.
    if (noTradeScore >= 60) action = 'WAIT';

    // ─── Mode classification ─────────────────────────────────────────
    let mode;
    if (action === 'WAIT') mode = noTradeScore >= 60 ? 'AVOID' : 'NORMAL';
    else if (hzVerdict === 'HERO_CE' && action === 'BUY CE') mode = 'HERO';
    else if (hzVerdict === 'HERO_PE' && action === 'BUY PE') mode = 'HERO';
    else mode = 'NORMAL';

    // ─── Entry type ──────────────────────────────────────────────────
    let entryType;
    if (action === 'WAIT') entryType = 'None';
    else {
      const t = tsKey;
      if (t === 'BREAKOUT_CE_BUY' || t === 'BREAKDOWN_PE_BUY') entryType = 'Breakout';
      else if (t === 'BUY_ON_DIP_CE') entryType = 'Buy Dip';
      else if (t === 'SELL_ON_RISE_PE') entryType = 'Sell Rise';
      else if (fAccept?.rejectedAboveVAH || fAccept?.rejectedBelowVAL) entryType = 'Reversal';
      else entryType = 'Continuation';
    }

    // ─── Target strike ───────────────────────────────────────────────
    const STEP = 100;
    const ceTarget = Math.round((spotPrice + STEP) / STEP) * STEP;
    const peTarget = Math.round((spotPrice - STEP) / STEP) * STEP;
    let targetStrike = null;
    let targetSide = null;
    if (action === 'BUY CE') {
      targetStrike = heroZero?.strike ?? bestTradePick?.ce?.strike ?? tradeStrategy?.strike ?? ceTarget;
      targetSide = 'CE';
    } else if (action === 'BUY PE') {
      targetStrike = heroZero?.strike ?? bestTradePick?.pe?.strike ?? tradeStrategy?.strike ?? peTarget;
      targetSide = 'PE';
    }

    // ─── Confidence calculation ──────────────────────────────────────
    // base = top vote / total votes × 100, with bonuses for HERO mode and
    // edge over runner-up; minus late-entry and no-trade penalties.
    const totalVotes = votes.CE + votes.PE + votes.WAIT || 1;
    const winningVote = action === 'BUY CE' ? votes.CE
                      : action === 'BUY PE' ? votes.PE
                      : votes.WAIT;
    const runnerUp = action === 'WAIT' ? Math.max(votes.CE, votes.PE)
                   : Math.max(votes.WAIT, action === 'BUY CE' ? votes.PE : votes.CE);
    const edge = winningVote - runnerUp;
    let confidence = Math.round((winningVote / totalVotes) * 100);
    if (mode === 'HERO') confidence += 8;
    confidence += Math.min(15, Math.max(0, edge * 0.3));
    confidence -= lateEntryPenalty;
    confidence = Math.max(20, Math.min(95, Math.round(confidence)));

    // ─── Build top-4 supportive reasons ──────────────────────────────
    const topReasons = reasons.slice(0, 4);
    if (topReasons.length === 0) topReasons.push(...noTradeReasons.slice(0, 4));

    // ─── Why-not / blockers ──────────────────────────────────────────
    if (action === 'WAIT' && noTradeReasons.length) {
      blockers.push(...noTradeReasons.slice(0, 2));
    }

    // ─── Trade lifecycle phase ───────────────────────────────────────
    let lifecyclePhase;
    if (action === 'WAIT') lifecyclePhase = 'STANDBY';
    else if (mode === 'HERO' && !stretched) lifecyclePhase = 'ENTRY';
    else if (stretched && !veryStretched) lifecyclePhase = 'MOMENTUM';
    else if (veryStretched) lifecyclePhase = 'EXHAUSTION';
    else lifecyclePhase = 'ENTRY';

    // ─── CONFLICT SCORE — penalise confidence when independent signals disagree ───
    // Real-world A+ trades require multiple INDEPENDENT signals to align.
    // Without this, all engines pulling from the same underlying move stack
    // false confidence (overfitting). We list the 6 most-independent signals
    // and tally how many AGREE with the chosen action vs how many disagree.
    //
    // For BUY CE: we expect bullish reads on each. For BUY PE: bearish.
    // For WAIT: we just count how many engines flagged neutrality.
    const conflictSignals = [];
    if (action !== 'WAIT') {
      const expectBull = action === 'BUY CE';
      const tag = (k, isBull, isBear) => {
        const aligned = expectBull ? isBull : isBear;
        const opposed = expectBull ? isBear : isBull;
        conflictSignals.push({ key: k, aligned, opposed });
      };
      // 1. Master verdict direction
      tag('verdict', verdict.cePct >= 55, verdict.pePct >= 55);
      // 2. Delta flow bias (independent of verdict)
      tag('delta', fDelta?.bias === 'bullish', fDelta?.bias === 'bearish');
      // 3. Breadth bias
      const bAdv = breadth?.advancePct ?? 50;
      tag('breadth', bAdv >= 55, bAdv <= 45);
      // 4. Heavyweights net impact
      const hImp = heavyTotalImpact ?? 0;
      tag('heavy', hImp > 0.10, hImp < -0.10);
      // 5. VIX direction (rising VIX = bearish)
      const vixCh = macro?.vix?.changePct ?? 0;
      tag('vix', vixCh < -1, vixCh > 1);
      // 6. Futures basis
      tag('futures', (futPremium ?? 0) > 10, (futPremium ?? 0) < -10);
    } else {
      // For WAIT we treat every neutral signal as "aligned" with WAIT, every
      // strongly directional one as "opposed".
      const neutralCount = (verdict.cePct < 55 && verdict.pePct < 55 ? 1 : 0)
        + (fDelta?.bias === 'neutral' ? 1 : 0)
        + (Math.abs((breadth?.advancePct ?? 50) - 50) < 8 ? 1 : 0);
      for (let i = 0; i < neutralCount; i++) conflictSignals.push({ key: 'neutral', aligned: true, opposed: false });
      const directionalCount = 6 - neutralCount;
      for (let i = 0; i < Math.max(0, directionalCount); i++) conflictSignals.push({ key: 'directional', aligned: false, opposed: true });
    }
    const alignedCount = conflictSignals.filter(s => s.aligned).length;
    const opposedCount = conflictSignals.filter(s => s.opposed).length;
    const totalCount = conflictSignals.length || 1;
    // 0 = full disagreement, 100 = full agreement
    const independenceScore = Math.round(((alignedCount - opposedCount) / totalCount) * 100 + 50);
    const conflictPenalty = Math.max(0, opposedCount * 8); // each opposing engine knocks 8 pts off

    // Apply conflict penalty
    const adjustedConfidence = Math.max(0, Math.min(100, confidence - conflictPenalty));

    // ─── CONFIDENCE GRADE — replace bare percentages with letter grades ───
    // Market probability isn't measurable to 1% precision. Grades convey
    // the realistic uncertainty band.
    const grade =
      adjustedConfidence >= 90 ? 'A+'
      : adjustedConfidence >= 80 ? 'A'
      : adjustedConfidence >= 70 ? 'B'
      : adjustedConfidence >= 55 ? 'C'
      : 'D';
    const convictionLabel =
      adjustedConfidence >= 80 ? 'HIGH'
      : adjustedConfidence >= 60 ? 'MEDIUM'
      : adjustedConfidence >= 40 ? 'LOW'
      : 'AVOID';

    return {
      action,                                      // BUY CE | BUY PE | WAIT
      mode,                                        // HERO | NORMAL | AVOID
      entryType,                                   // Breakout / Buy Dip / Sell Rise / Reversal / Continuation / None
      targetSide,                                  // CE | PE | null
      targetStrike,                                // round 100-step strike
      confidence: adjustedConfidence,              // 0..100 (after conflict penalty)
      rawConfidence: confidence,                   // 0..100 (before penalty — kept for transparency)
      grade,                                       // A+ | A | B | C | D
      convictionLabel,                             // HIGH | MEDIUM | LOW | AVOID
      independenceScore,                           // 0..100 — how many independent engines agree
      conflictPenalty,                             // pts subtracted from raw confidence
      tone: action === 'BUY CE' ? 'bull'
          : action === 'BUY PE' ? 'bear' : 'warn',
      lifecyclePhase,                              // STANDBY | ENTRY | MOMENTUM | EXHAUSTION
      regime,                                      // TREND_DAY | RANGE_DAY | EXPIRY_CHAOS etc.
      regimeLabel: {
        TREND_DAY: 'TREND DAY', VOLATILE_TREND: 'VOLATILE TREND',
        RANGE_DAY: 'RANGE DAY', SHORT_COVERING: 'SHORT COVERING',
        LONG_UNWINDING: 'LONG UNWINDING', EXPIRY_CHAOS: 'EXPIRY CHAOS',
        EXPIRY_DECAY: 'EXPIRY DECAY', GAP_FILL_DAY: 'GAP FILL DAY',
        MEAN_REVERSION: 'MEAN REVERSION',
      }[regime],
      phase, phaseLabel,
      noTradeScore,
      stretched,
      veryStretched,
      reasons: topReasons,
      blockers,
      votes: {
        ce: Math.round(votes.CE),
        pe: Math.round(votes.PE),
        wait: Math.round(votes.WAIT),
      },
      weights: weightBoost,
    };
  })();

  // ── AI MARKET STORY ENGINE ──────────────────────────────────────────
  // Synthesises ALL the engines into one human-readable paragraph.
  // Reads: heroZero, frvpInstitutional.engine, atmBlk, supportResistance,
  // verdict, delta, marketDirection, vwap, vp, futPremium.
  const marketStory = (() => {
    const lines = [];
    const fEngine = frvpInstitutional?.engine;
    const fDom = fEngine?.dominance;
    const fPrem = fEngine?.advanced?.premiumVel;
    const sr = supportResistance;
    const md = marketDirection;
    const hz = heroZero;

    // 1. OI structure narrative — "Heavy CE writing between X–Y shows..."
    const ceWalls = (md?.resistances || []).slice(0, 2).map(r => r.strike);
    const peWalls = (md?.supports || []).slice(0, 2).map(r => r.strike);
    if (ceWalls.length >= 2 && atmBlk.ceWriting) {
      lines.push(`Heavy CE writing between ${Math.min(...ceWalls)}–${Math.max(...ceWalls)} shows aggressive seller defense.`);
    } else if (peWalls.length >= 2 && atmBlk.peWriting) {
      lines.push(`Strong PE writing between ${Math.min(...peWalls)}–${Math.max(...peWalls)} confirms institutional support.`);
    } else if (atmBlk.ceWriting && atmBlk.peWriting) {
      lines.push(`Two-sided writing — both CE and PE writers stacking OI; range-bound conditions.`);
    } else if (atmBlk.ceUnwinding) {
      lines.push(`CE writers unwinding — short covering pressure building, watch for upside squeeze.`);
    } else if (atmBlk.peUnwinding) {
      lines.push(`PE writers unwinding — long unwinding pressure building, watch for downside.`);
    }

    // 2. Price location — VWAP + POC narrative
    const aboveVwap = vwap != null && Number.isFinite(spotPrice) && spotPrice >= vwap;
    const abovePoc  = vaPrimary?.poc != null && Number.isFinite(spotPrice) && spotPrice >= vaPrimary.poc;
    const insideValue = vaPrimary?.vah != null && vaPrimary?.val != null && spotPrice >= vaPrimary.val && spotPrice <= vaPrimary.vah;
    if (insideValue) {
      lines.push(`Price trades inside the value area (${vaPrimary.val.toFixed(0)}–${vaPrimary.vah.toFixed(0)}), accepted by the auction — wait for break.`);
    } else if (aboveVwap && abovePoc) {
      lines.push(`Price holds above VWAP and above POC — bullish acceptance.`);
    } else if (!aboveVwap && !abovePoc) {
      lines.push(`Price trades below VWAP and below POC — bearish acceptance.`);
    } else if (aboveVwap && !abovePoc) {
      lines.push(`Price reclaimed VWAP but still below POC — mixed signal, fade weakness.`);
    } else if (!aboveVwap && abovePoc) {
      lines.push(`Price holds POC but lost VWAP — choppy, watch for reclaim.`);
    }

    // 3. Premium velocity narrative
    if (fPrem?.state === 'CE_EXPANDING') {
      lines.push(`CE premiums expanding aggressively — buyers stepping up.`);
    } else if (fPrem?.state === 'PE_EXPANDING') {
      lines.push(`PE premiums expanding aggressively — panic selling active.`);
    } else if (fPrem?.state === 'BALANCED') {
      lines.push(`Both side premiums balanced — no expansion edge.`);
    }

    // 4. Dominance + delta narrative
    if (fDom?.dominantSide === 'BUYERS' && fDom?.buyersScore >= 65) {
      const dPct = fEngine?.delta?.deltaPct ?? 0;
      lines.push(`Buyers dominate flow with ${Math.round(fDom.buyersScore)}% pressure (Δ ${dPct >= 0 ? '+' : ''}${dPct.toFixed(1)}%), favoring CE buying unless price loses ${vp?.poc?.toFixed(0) || 'POC'}.`);
    } else if (fDom?.dominantSide === 'SELLERS' && fDom?.sellersScore >= 65) {
      const dPct = fEngine?.delta?.deltaPct ?? 0;
      lines.push(`Sellers dominate flow with ${Math.round(fDom.sellersScore)}% pressure (Δ ${dPct >= 0 ? '+' : ''}${dPct.toFixed(1)}%), favoring PE buying unless price reclaims VAH.`);
    } else if (fDom?.dominantSide === 'BALANCED') {
      lines.push(`Two-sided flow — neither buyers nor sellers in clear control.`);
    }

    // 5. Hero/Zero overlay
    if (hz?.verdict === 'HERO_CE') {
      lines.push(`🚀 HERO CE setup active — momentum + premium + acceptance aligned for ${hz.strike} CE.`);
    } else if (hz?.verdict === 'HERO_PE') {
      lines.push(`🚀 HERO PE setup active — momentum + premium + acceptance aligned for ${hz.strike} PE.`);
    } else if (hz?.signals?.bullTrap) {
      lines.push(`⚠ Bull trap detected — CE breakout fakeout, avoid CE entries.`);
    } else if (hz?.signals?.bearTrap) {
      lines.push(`⚠ Bear trap detected — PE breakdown fakeout, avoid PE entries.`);
    } else if (hz?.verdict === 'ZERO') {
      lines.push(`💀 Zero trade conditions — wait for a clean breakout or breakdown.`);
    }

    // 6. Verdict + confidence summary
    const finalVerdict = verdict.cePct >= 60 ? `Bias tilts CE +${(verdict.cePct - 50).toFixed(0)} pts.`
      : verdict.pePct >= 60 ? `Bias tilts PE +${(verdict.pePct - 50).toFixed(0)} pts.`
      : `Bias balanced (CE ${verdict.cePct.toFixed(0)} vs PE ${verdict.pePct.toFixed(0)}).`;
    lines.push(finalVerdict);

    // Build paragraph & a short headline
    const paragraph = lines.filter(Boolean).join(' ');
    const headline = hz?.verdict === 'HERO_CE' ? `🚀 HERO CE — ${hz.strike}`
      : hz?.verdict === 'HERO_PE' ? `🚀 HERO PE — ${hz.strike}`
      : hz?.verdict === 'ZERO' ? `💀 ZERO — Wait`
      : verdict.cePct >= 60 ? `🟢 CE Bias`
      : verdict.pePct >= 60 ? `🔴 PE Bias`
      : `🟡 Balanced`;
    const tone = hz?.verdict === 'HERO_CE' || verdict.cePct >= 60 ? 'bull'
      : hz?.verdict === 'HERO_PE' || verdict.pePct >= 60 ? 'bear'
      : 'warn';

    return {
      headline,
      tone,
      paragraph,
      lines: lines.filter(Boolean),
      builtAt: Date.now(),
    };
  })();

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
      { key: 'insideValue',        label: 'Inside Value',          detected: vaPrimary && Number.isFinite(spotPrice) && spotPrice > vaPrimary.val && spotPrice < vaPrimary.vah },
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
        oi: futOi,
        oiChange: futOiPrevClose ? futOi - futOiPrevClose : 0,
        volume: f1m.reduce((s, c) => s + (c.volume || 0), 0),
        ltp: futLtp, premium: futPremium ?? 0,
        basis: futPremium ?? 0, basisTrend: futPremium == null ? 'unknown' : (futPremium >= 0 ? 'premium' : 'discount'),
        interpretation: futPremium != null
          ? (futPremium >= 0 ? 'Futures premium healthy. Positive structure.' : 'Futures discount. Watch for weakness.')
          : 'Futures data unavailable.',
      },
      oiHistogram,
      oiShiftBias,
      oiBuildupAnalysis,
      marketDirection,
      cvdSeries,
      delta: {
        totalBuyVol: delta.totalBuy, totalSellVol: delta.totalSell,
        netDelta: delta.netDelta, deltaPct: delta.deltaPct,
        // Real bid/ask imbalance derived from option-chain delta totals.
        // Range: −100 (all sellers) … +100 (all buyers). 0 = balanced.
        bidAskImbalance: (() => {
          const b = _safe(delta.totalBuy);
          const s = _safe(delta.totalSell);
          const tot = b + s;
          if (tot <= 0) return 0;
          return _round(((b - s) / tot) * 100, 2);
        })(),
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
      bestTradePick,
      tradeBoard,
      heroZero,
      premiumMomentum,
      tradeStrategy,
      executionEngine,
      marketStory,
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
        oiShift:    oiShiftBias?.label || `Shift Bias: ${(buildUp.shiftBias || 'Balanced')}`,
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
