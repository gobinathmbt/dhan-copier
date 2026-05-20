/**
 * Historical Context Loader
 * =========================
 * Reads today's live-feed folder + the last N backfilled days and produces a
 * compact JSON-safe payload that the AI can use alongside the real-time feed.
 *
 * The loader is READ-ONLY. It never mutates the disk. Everything is tail-read
 * so a session started at 12:00 sees all the data from 09:15 onwards without
 * needing the live feed to have been parsed by the algo engine.
 *
 * Folder layout it expects (built by feedRecorder + historicalBackfill):
 *   live-feed/<YYYY-MM-DD>_NIFTY_50/
 *     metadata.json          — { openPrice, openingAtm, latestAtm, ... }
 *     spot.jsonl             — per-minute/per-tick spot snapshots
 *     candles-1m.jsonl       — NIFTY 1-min OHLC
 *     candles-5m.jsonl
 *     candles-15m.jsonl
 *     option-chain.jsonl     — per-minute snapshots of ATM ± 6 strikes
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const logger = require('../utils/logger');
const symbolRegistry = require('../config/symbolRegistry');

const ROOT_DIR = path.resolve(__dirname, '../../live-feed');
// Active underlying — driven by `settings.tradingSymbols[0]`.
function _underlying() { return symbolRegistry.getActiveSymbol(); }
const MAX_BACKFILL_DAYS = 7;
const STRIKE_WINDOW = 4; // user wants ±4 strikes for the algo

// In-memory cache for prior-day summaries — they don't change so we load once.
// Key = folder name (e.g. "2026-05-12_NIFTY_50"). Value = summary object.
const priorDayCache = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function istNowYYYYMMDD() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function readJsonlTail(file, maxLines) {
  return new Promise((resolve) => {
    if (!fs.existsSync(file)) return resolve([]);
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    const all = [];
    rl.on('line', (line) => {
      if (!line) return;
      try { all.push(JSON.parse(line)); } catch (_) {}
    });
    rl.on('close', () => resolve(maxLines > 0 ? all.slice(-maxLines) : all));
  });
}

function readJsonSafe(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
  catch (_) { return null; }
}

function listRecordedFolders() {
  if (!fs.existsSync(ROOT_DIR)) return [];
  const underlying = _underlying();
  return fs.readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.endsWith(`_${underlying}`))
    .map(e => e.name)
    .sort()
    .reverse(); // newest first
}

// ---------------------------------------------------------------------------
// Prior-day summary — cached. Produces:
//   { date, open, high, low, close, rangePct, openingAtm, closingAtm,
//     pivots: { r1, s1, vwap, pivot }, trend: 'bullish'|'bearish'|'neutral',
//     strikesOpen, strikesClose, finalCallPain, finalPutPain, maxPainStrike }
// ---------------------------------------------------------------------------
async function loadPriorDaySummary(folderName) {
  if (priorDayCache.has(folderName)) return priorDayCache.get(folderName);

  const folder = path.join(ROOT_DIR, folderName);
  const meta = readJsonSafe(path.join(folder, 'metadata.json'));
  const candles15m = await readJsonlTail(path.join(folder, 'candles-15m.jsonl'), 0);
  const futures15m = await readJsonlTail(path.join(folder, 'futures-15m.jsonl'), 0);
  if (!candles15m.length) {
    const summary = { date: folderName.split('_')[0], source: 'empty' };
    priorDayCache.set(folderName, summary);
    return summary;
  }

  const highs = candles15m.map(c => c.h);
  const lows = candles15m.map(c => c.l);
  const closes = candles15m.map(c => c.c);
  const vols = candles15m.map(c => c.v || 0);

  const open = candles15m[0].o;
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const close = closes[closes.length - 1];
  const rangePct = ((high - low) / open) * 100;
  const pivot = (high + low + close) / 3;
  const r1 = 2 * pivot - low;
  const s1 = 2 * pivot - high;
  let pv = 0, v = 0;
  for (const c of candles15m) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * (c.v || 1); v += c.v || 1;
  }
  const vwap = v ? pv / v : close;
  const trend = close > open * 1.003 ? 'bullish' : close < open * 0.997 ? 'bearish' : 'neutral';

  // Final option chain snapshot — find max pain strike
  const lastChain = await readLastChainSnapshot(folder);
  let maxPainStrike = null, finalCallOI = 0, finalPutOI = 0;
  if (lastChain?.strikes) {
    for (const s of lastChain.strikes) {
      finalCallOI += s.ce?.oi || 0;
      finalPutOI += s.pe?.oi || 0;
    }
    // Max pain = strike where (sum of ITM CE OI × (strike-K)) + (sum of ITM PE OI × (K-strike)) is minimized
    let minLoss = Infinity;
    for (const row of lastChain.strikes) {
      const K = row.strike;
      let loss = 0;
      for (const s of lastChain.strikes) {
        if (s.strike > K) loss += (s.strike - K) * (s.ce?.oi || 0); // CE writer loss
        if (s.strike < K) loss += (K - s.strike) * (s.pe?.oi || 0); // PE writer loss
      }
      if (loss < minLoss) { minLoss = loss; maxPainStrike = K; }
    }
  }

  const summary = {
    date: meta?.date || folderName.split('_')[0],
    source: 'prior_day',
    open, high, low, close,
    rangePct: Number(rangePct.toFixed(2)),
    openingAtm: meta?.openingAtm || null,
    closingAtm: meta?.latestAtm || null,
    pivots: {
      pivot: Number(pivot.toFixed(2)),
      r1: Number(r1.toFixed(2)),
      s1: Number(s1.toFixed(2)),
      vwap: Number(vwap.toFixed(2)),
    },
    trend,
    maxPainStrike,
    totalCallOI: finalCallOI,
    totalPutOI: finalPutOI,
    pcr: finalCallOI ? Number((finalPutOI / finalCallOI).toFixed(2)) : null,
    futures: (futures15m.length && meta?.futuresContract) ? {
      contract: meta.futuresContract,
      open: futures15m[0].o,
      close: futures15m[futures15m.length - 1].c,
      openPremium: meta.futuresOpenPremium,
      closePremium: meta.futuresClosePremium,
    } : null,
  };
  priorDayCache.set(folderName, summary);
  return summary;
}

async function readLastChainSnapshot(folder) {
  const file = path.join(folder, 'option-chain.jsonl');
  if (!fs.existsSync(file)) return null;
  // Stream the file and keep only the last line (avoid loading 2MB)
  return new Promise((resolve) => {
    let last = null;
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => { if (line) last = line; });
    rl.on('close', () => {
      if (!last) return resolve(null);
      try { resolve(JSON.parse(last)); } catch (_) { resolve(null); }
    });
  });
}

// ---------------------------------------------------------------------------
// Today's intraday context — NOT cached (grows minute by minute).
// Returns everything from 09:15 up to "now" from the recorder:
//   - candles 1m (keep last 120), 5m (last 48), 15m (last 16)
//   - futures candles (same cadence) when present
//   - per-strike evolution: for the selected strike list, last N chain snapshots
//   - key stats: opening price, opening ATM, running high/low, cumulative volume
// ---------------------------------------------------------------------------
async function loadTodayContext({ maxChainSnapshots = 30, focusStrikes = null } = {}) {
  const dateStr = istNowYYYYMMDD();
  const folder = path.join(ROOT_DIR, `${dateStr}_${UNDERLYING}`);
  if (!fs.existsSync(folder)) {
    return { date: dateStr, source: 'no_data', empty: true };
  }

  const meta = readJsonSafe(path.join(folder, 'metadata.json'));
  const [c1, c5, c15, f1, f5, f15] = await Promise.all([
    readJsonlTail(path.join(folder, 'candles-1m.jsonl'), 120),
    readJsonlTail(path.join(folder, 'candles-5m.jsonl'), 48),
    readJsonlTail(path.join(folder, 'candles-15m.jsonl'), 16),
    readJsonlTail(path.join(folder, 'futures-1m.jsonl'), 120),
    readJsonlTail(path.join(folder, 'futures-5m.jsonl'), 48),
    readJsonlTail(path.join(folder, 'futures-15m.jsonl'), 16),
  ]);
  const chainRows = await readJsonlTail(path.join(folder, 'option-chain.jsonl'), maxChainSnapshots);

  // Running session stats from 1m candles
  let sessionHigh = -Infinity, sessionLow = Infinity, sessionVolume = 0;
  for (const c of c1) {
    if (c.h > sessionHigh) sessionHigh = c.h;
    if (c.l < sessionLow) sessionLow = c.l;
    sessionVolume += c.v || 0;
  }

  // Futures premium right now — last futures close vs last spot close
  let futuresPremium = null;
  let futuresTrend = null;
  if (f1.length && c1.length) {
    const lastFut = f1[f1.length - 1].c;
    const lastSpot = c1[c1.length - 1].c;
    futuresPremium = Number((lastFut - lastSpot).toFixed(2));
    const firstFut = f1[0].c;
    const delta = ((lastFut - firstFut) / firstFut) * 100;
    futuresTrend = delta > 0.15 ? 'bullish' : delta < -0.15 ? 'bearish' : 'neutral';
  }

  // Condense chain: keep only ATM ± STRIKE_WINDOW (4) strikes if focusStrikes not specified
  const condensedChain = chainRows.map((snap) => {
    let rows = snap.strikes || [];
    if (focusStrikes && focusStrikes.length) {
      rows = rows.filter(s => focusStrikes.includes(s.strike));
    } else {
      const atmIdx = rows.findIndex(s => s.strike === snap.atm);
      const i = atmIdx >= 0 ? atmIdx : Math.floor(rows.length / 2);
      rows = rows.slice(Math.max(0, i - STRIKE_WINDOW), Math.min(rows.length, i + STRIKE_WINDOW + 1));
    }
    return {
      t: snap.t,
      spot: snap.spot,
      atm: snap.atm,
      strikes: rows.map(s => ({
        strike: s.strike,
        ce: { ltp: s.ce.ltp, oi: s.ce.oi, oiChg: s.ce.oiChg, vol: s.ce.vol, iv: s.ce.iv },
        pe: { ltp: s.pe.ltp, oi: s.pe.oi, oiChg: s.pe.oiChg, vol: s.pe.vol, iv: s.pe.iv },
      })),
    };
  });

  // OI evolution — for each strike, track how OI changed across the captured snapshots
  const oiEvolution = computeOiEvolution(condensedChain);

  return {
    date: dateStr,
    source: 'intraday',
    metadata: meta,
    sessionStats: {
      sessionHigh: sessionHigh === -Infinity ? null : sessionHigh,
      sessionLow: sessionLow === Infinity ? null : sessionLow,
      sessionVolume,
      candleCounts: { '1m': c1.length, '5m': c5.length, '15m': c15.length },
      futuresCandleCounts: { '1m': f1.length, '5m': f5.length, '15m': f15.length },
    },
    candles: {
      '1m':  c1.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })),
      '5m':  c5.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })),
      '15m': c15.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })),
    },
    futures: {
      contract: meta?.futuresContract || null,
      premiumNow: futuresPremium,
      trendToday: futuresTrend,
      candles: {
        '1m':  f1.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })),
        '5m':  f5.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })),
        '15m': f15.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })),
      },
    },
    chainSnapshots: condensedChain,
    oiEvolution,
  };
}

function computeOiEvolution(snapshots) {
  if (snapshots.length < 2) return null;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const byStrike = {};
  for (const s of first.strikes) byStrike[s.strike] = { firstCe: s.ce.oi, firstPe: s.pe.oi };
  for (const s of last.strikes) {
    if (!byStrike[s.strike]) byStrike[s.strike] = {};
    byStrike[s.strike].lastCe = s.ce.oi;
    byStrike[s.strike].lastPe = s.pe.oi;
  }
  const rows = Object.entries(byStrike).map(([strike, v]) => ({
    strike: Number(strike),
    ceOiChg: (v.lastCe || 0) - (v.firstCe || 0),
    peOiChg: (v.lastPe || 0) - (v.firstPe || 0),
  }));
  rows.sort((a, b) => a.strike - b.strike);

  // Heaviest CE additions = resistance; heaviest PE additions = support
  const heaviestCe = [...rows].sort((a, b) => b.ceOiChg - a.ceOiChg)[0];
  const heaviestPe = [...rows].sort((a, b) => b.peOiChg - a.peOiChg)[0];

  return {
    snapshotCount: snapshots.length,
    rows,
    implied: {
      resistance: heaviestCe?.ceOiChg > 0 ? heaviestCe.strike : null,
      support:    heaviestPe?.peOiChg > 0 ? heaviestPe.strike : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level API — build the "full historical context" bundle for the AI.
// Accepts { focusStrikes } so callers who already know the target strike can
// request a denser slice for it.
// ---------------------------------------------------------------------------
async function buildHistoricalContext({ maxBackfillDays = 5, focusStrikes = null, includeRawToday = true } = {}) {
  const folders = listRecordedFolders();
  const today = istNowYYYYMMDD();
  const todayFolder = `${today}_${UNDERLYING}`;

  const priorFolders = folders
    .filter(f => f !== todayFolder)
    .slice(0, Math.min(maxBackfillDays, MAX_BACKFILL_DAYS));

  const priorDays = [];
  for (const f of priorFolders) {
    try {
      priorDays.push(await loadPriorDaySummary(f));
    } catch (e) {
      logger.warn({ folder: f, err: e.message }, '[historicalContext] prior day load failed');
    }
  }

  let todayContext = null;
  if (includeRawToday) {
    try {
      todayContext = await loadTodayContext({ maxChainSnapshots: 30, focusStrikes });
    } catch (e) {
      logger.warn({ err: e.message }, '[historicalContext] today load failed');
    }
  }

  // Aggregate insights across prior days
  const priorTrendVote = priorDays.reduce((acc, d) => {
    if (d.trend === 'bullish') acc.bull++;
    else if (d.trend === 'bearish') acc.bear++;
    else acc.neutral++;
    return acc;
  }, { bull: 0, bear: 0, neutral: 0 });

  const avgPcr = priorDays.filter(d => d.pcr != null).map(d => d.pcr);
  const meanPcr = avgPcr.length ? avgPcr.reduce((a, b) => a + b, 0) / avgPcr.length : null;

  const priorSupportZones = priorDays.map(d => d.pivots?.s1).filter(Boolean);
  const priorResistanceZones = priorDays.map(d => d.pivots?.r1).filter(Boolean);

  return {
    generatedAt: Date.now(),
    priorDays,
    today: todayContext,
    rollup: {
      priorTrendVote,
      meanPcr: meanPcr != null ? Number(meanPcr.toFixed(2)) : null,
      priorSupportZones,
      priorResistanceZones,
    },
  };
}

module.exports = {
  buildHistoricalContext,
  loadTodayContext,
  loadPriorDaySummary,
  listRecordedFolders,
  istNowYYYYMMDD,
  STRIKE_WINDOW,
};
