/**
 * Multi-Day Context Engine
 * ========================
 * Reads N prior trading-day folders from `backend/live-feed/` and produces
 * a compact, decision-ready context object the rest of the hybrid pipeline
 * uses. Without this, every engine is purely intraday — institutions trade
 * against levels left by the previous days.
 *
 * Outputs (all numbers rounded for stability):
 *   priorDay:           { date, open, high, low, close, vwap, vah, val, poc,
 *                         ibHigh, ibLow, dayType }
 *   priorWeek:          aggregate over last ~5 sessions
 *   compositeProfile:   merged FRVP across last N sessions (POC/VA/HVNs/LVNs)
 *   atrPercentile:      where today's ATR sits in 20-day population
 *   ivPercentile:       where today's ATM IV sits (best-effort, from option-chain history)
 *   oiMigration:        how PE/CE peak strikes have drifted across sessions
 *   sessionMemory:      events recorded for *today* — failed breakdowns,
 *                       repeated sweeps, opening drive direction, etc.
 *   levels:             flat array of high-importance prior levels (PDH, PDL,
 *                       prior close, prior VAH/VAL/POC, weekly H/L)
 *
 * Caching:
 *   - prior-day summaries are cached in memory (they don't change)
 *   - eviction after 24h to avoid stale weekly aggregates on day rollover
 *
 * No DB, no AI. Pure file IO + deterministic math.
 */

const fs = require('fs');
const path = require('path');
const symbolRegistry = require('../../config/symbolRegistry');

const ROOT_DIR = path.resolve(__dirname, '../../../live-feed');
// Active underlying — driven by `settings.tradingSymbols[0]`.
function _underlying() { return symbolRegistry.getActiveSymbol(); }
const PROFILE_BUCKETS = 50;

// In-memory caches
const _priorDayCache = new Map();          // key = "YYYY-MM-DD" → summary
const _sessionMemoryByDate = new Map();    // key = "YYYY-MM-DD" → memory object
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Generic helpers ──────────────────────────────────────────────────────
function _readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

function _readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function _normCandle(c) {
  return {
    o: c.o ?? c.open,
    h: c.h ?? c.high,
    l: c.l ?? c.low,
    c: c.c ?? c.close,
    v: c.v ?? c.volume ?? 0,
    t: c.t,
  };
}

function _vwap(candles) {
  let pv = 0, vv = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * (c.v || 0);
    vv += (c.v || 0);
  }
  return vv ? pv / vv : null;
}

function _trueRanges(candles) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (![c.h, c.l, p.c].every(Number.isFinite)) continue;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  return trs;
}

function _atr(candles, period = 14) {
  const trs = _trueRanges(candles);
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = ((atr * (period - 1)) + trs[i]) / period;
  }
  return atr;
}

function _percentileRank(arr, value) {
  if (!arr || !arr.length || !Number.isFinite(value)) return null;
  const sorted = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  let below = 0;
  for (const v of sorted) {
    if (v <= value) below++;
    else break;
  }
  return Math.round((below / sorted.length) * 100);
}

// ─── Volume profile (TPO-light, by volume) over a candle stream ───────────
function _volumeProfile(candles, buckets = PROFILE_BUCKETS) {
  const norm = candles.filter(c => Number.isFinite(c.h) && Number.isFinite(c.l));
  if (norm.length < 5) return null;

  const minP = Math.min(...norm.map(c => c.l));
  const maxP = Math.max(...norm.map(c => c.h));
  if (maxP <= minP) return null;
  const bucketSize = (maxP - minP) / buckets;

  const bins = new Array(buckets).fill(0);
  for (const c of norm) {
    const range = c.h - c.l;
    if (range <= 0) {
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor((c.l - minP) / bucketSize)));
      bins[idx] += c.v;
    } else {
      const start = Math.max(0, Math.floor((c.l - minP) / bucketSize));
      const end   = Math.min(buckets - 1, Math.floor((c.h - minP) / bucketSize));
      const span  = Math.max(1, end - start + 1);
      const per   = c.v / span;
      for (let i = start; i <= end; i++) bins[i] += per;
    }
  }

  const totalVol = bins.reduce((a, b) => a + b, 0);
  if (totalVol <= 0) return null;

  // POC
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[pocIdx]) pocIdx = i;
  const pocPrice = minP + pocIdx * bucketSize + bucketSize / 2;

  // Value Area (70%)
  const target = totalVol * 0.7;
  let vol = bins[pocIdx], lo = pocIdx, hi = pocIdx;
  while (vol < target && (lo > 0 || hi < bins.length - 1)) {
    const lv = lo > 0 ? bins[lo - 1] : -1;
    const hv = hi < bins.length - 1 ? bins[hi + 1] : -1;
    if (lv >= hv) { lo--; vol += Math.max(0, lv); }
    else          { hi++; vol += Math.max(0, hv); }
  }
  const vah = minP + (hi + 1) * bucketSize;
  const val = minP + lo * bucketSize;

  // HVNs / LVNs (top by volume)
  const avg = totalVol / buckets;
  const hvn = [], lvn = [];
  for (let i = 0; i < bins.length; i++) {
    const price = minP + i * bucketSize + bucketSize / 2;
    if (bins[i] >= avg * 1.5) hvn.push({ price: Number(price.toFixed(2)), volume: Math.round(bins[i]) });
    else if (bins[i] > 0 && bins[i] <= avg * 0.5) lvn.push({ price: Number(price.toFixed(2)), volume: Math.round(bins[i]) });
  }
  hvn.sort((a, b) => b.volume - a.volume);
  lvn.sort((a, b) => a.volume - b.volume);

  return {
    poc:       Number(pocPrice.toFixed(2)),
    vah:       Number(vah.toFixed(2)),
    val:       Number(val.toFixed(2)),
    rangeHigh: Number(maxP.toFixed(2)),
    rangeLow:  Number(minP.toFixed(2)),
    hvn:       hvn.slice(0, 6),
    lvn:       lvn.slice(0, 4),
    bucketSize: Number(bucketSize.toFixed(2)),
    totalVolume: Math.round(totalVol),
  };
}

// ─── Initial Balance (first 60 minutes) + day-type classification ────────
function _initialBalance(candles1m) {
  if (!candles1m?.length) return null;
  // First 60 1m bars
  const ib = candles1m.slice(0, 60);
  if (ib.length < 30) return null;
  const ibHigh = Math.max(...ib.map(c => c.h));
  const ibLow  = Math.min(...ib.map(c => c.l));
  return { high: Number(ibHigh.toFixed(2)), low: Number(ibLow.toFixed(2)),
           range: Number((ibHigh - ibLow).toFixed(2)) };
}

function _classifyDayType({ candles1m, dayHigh, dayLow, ib, vwap, open, close }) {
  if (!candles1m || !ib) return 'unknown';
  const range = dayHigh - dayLow;
  if (range <= 0) return 'unknown';

  // Trend day: close in top/bottom 25% of range AND IB extension > 1.5×
  const closeFrac = (close - dayLow) / range;
  const ibRange = ib.range;
  const ibExt = range / Math.max(1, ibRange);
  if (closeFrac > 0.75 && ibExt > 1.5) return 'trend_up';
  if (closeFrac < 0.25 && ibExt > 1.5) return 'trend_down';

  // Double distribution: bimodal — long bar gap in middle
  // (cheap proxy: candles cluster in two distinct halves)
  const mid = (dayHigh + dayLow) / 2;
  const above = candles1m.filter(c => c.c > mid).length;
  const below = candles1m.filter(c => c.c < mid).length;
  const total = candles1m.length;
  if (Math.min(above, below) / total > 0.3 && ibExt < 1.5) return 'double_distribution';

  // Neutral / balanced — wide range but reverts to value
  if (ibExt > 1.3 && Math.abs(closeFrac - 0.5) < 0.2) return 'neutral';

  // Short covering: open < IB low → close > IB high
  if (open < ib.low * 1.001 && close > ib.high * 0.999) return 'short_covering';
  // Long liquidation: open > IB high → close < IB low
  if (open > ib.high * 0.999 && close < ib.low * 1.001) return 'long_liquidation';

  return 'balanced';
}

// ─── Folder enumeration ──────────────────────────────────────────────────
function _listFolders(rootDir = ROOT_DIR) {
  if (!fs.existsSync(rootDir)) return [];
  const underlying = _underlying();
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.endsWith(`_${underlying}`))
    .map(e => e.name)
    .sort();
}

function _foldersBefore(dateStr, n, rootDir = ROOT_DIR) {
  const all = _listFolders(rootDir);
  const target = `${dateStr}_${_underlying()}`;
  const idx = all.findIndex(f => f >= target);
  // collect up to n entries strictly before idx
  const before = idx === -1 ? all.slice(-n) : all.slice(Math.max(0, idx - n), idx);
  return before;
}

// ─── Per-day summary builder (cached) ────────────────────────────────────
function _buildDaySummary(folderName, rootDir = ROOT_DIR) {
  if (_priorDayCache.has(folderName)) {
    const cached = _priorDayCache.get(folderName);
    if (Date.now() - cached._cachedAt < CACHE_TTL_MS) return cached;
  }
  const folder = path.join(rootDir, folderName);
  const meta = _readJson(path.join(folder, 'metadata.json'));
  const c1m  = _readJsonl(path.join(folder, 'candles-1m.jsonl')).map(_normCandle);
  const c5m  = _readJsonl(path.join(folder, 'candles-5m.jsonl')).map(_normCandle);
  const c15m = _readJsonl(path.join(folder, 'candles-15m.jsonl')).map(_normCandle);
  if (!c5m.length) return null;

  const dayHigh = Math.max(...c5m.map(c => c.h));
  const dayLow  = Math.min(...c5m.map(c => c.l));
  const open    = c5m[0].o;
  const close   = c5m[c5m.length - 1].c;
  const vwap    = _vwap(c5m);
  const profile = _volumeProfile(c5m);
  const ib      = _initialBalance(c1m);
  const dayType = _classifyDayType({ candles1m: c1m, dayHigh, dayLow, ib, vwap, open, close });
  const atr5m   = _atr(c5m, 14);
  const atr15m  = _atr(c15m, 14);

  // Latest option-chain snapshot of the day (for OI peak strike)
  const oc = _readJsonl(path.join(folder, 'option-chain.jsonl'));
  const lastOc = oc.length ? oc[oc.length - 1] : null;
  let cePeakStrike = null, pePeakStrike = null;
  if (lastOc?.strikes?.length) {
    let bestCe = -Infinity, bestPe = -Infinity;
    for (const s of lastOc.strikes) {
      if ((s.ce?.oi || 0) > bestCe) { bestCe = s.ce.oi; cePeakStrike = s.strike; }
      if ((s.pe?.oi || 0) > bestPe) { bestPe = s.pe.oi; pePeakStrike = s.strike; }
    }
  }

  const summary = {
    date:    folderName.split('_')[0],
    open:    Number(open.toFixed(2)),
    high:    Number(dayHigh.toFixed(2)),
    low:     Number(dayLow.toFixed(2)),
    close:   Number(close.toFixed(2)),
    range:   Number((dayHigh - dayLow).toFixed(2)),
    vwap:    vwap ? Number(vwap.toFixed(2)) : null,
    poc:     profile?.poc ?? null,
    vah:     profile?.vah ?? null,
    val:     profile?.val ?? null,
    hvn:     profile?.hvn ?? [],
    lvn:     profile?.lvn ?? [],
    ibHigh:  ib?.high ?? null,
    ibLow:   ib?.low  ?? null,
    ibRange: ib?.range ?? null,
    dayType,
    atr5m:   atr5m ? Number(atr5m.toFixed(2)) : null,
    atr15m:  atr15m ? Number(atr15m.toFixed(2)) : null,
    cePeakStrike,
    pePeakStrike,
    candleCount: c5m.length,
    profile,
    _cachedAt: Date.now(),
  };
  _priorDayCache.set(folderName, summary);
  return summary;
}

// ─── Composite profile across N days ─────────────────────────────────────
function _compositeProfile(summaries) {
  // Merge candle data isn't held (we only have summaries cached). We fall
  // back to combining HVNs / VA references from each day, weighted by recency.
  if (!summaries || !summaries.length) return null;
  const recencyW = (i, n) => 1 - (i / Math.max(1, n)); // newest = 1, oldest → 0
  const hvnMap = new Map();   // price-bucket → cumulative weighted volume
  const lvnMap = new Map();
  const bucketSize = 25;      // 25-pt buckets for cross-day merge
  const _key = (price) => Math.round(price / bucketSize) * bucketSize;

  let pocSum = 0, pocW = 0;
  let vahSum = 0, valSum = 0, vaW = 0;
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[summaries.length - 1 - i]; // most recent first
    const w = recencyW(i, summaries.length);
    if (s.poc) { pocSum += s.poc * w; pocW += w; }
    if (s.vah) { vahSum += s.vah * w; valSum += s.val * w; vaW += w; }
    for (const node of (s.hvn || [])) {
      const k = _key(node.price);
      hvnMap.set(k, (hvnMap.get(k) || 0) + node.volume * w);
    }
    for (const node of (s.lvn || [])) {
      const k = _key(node.price);
      lvnMap.set(k, (lvnMap.get(k) || 0) + node.volume * w);
    }
  }

  const hvn = [...hvnMap.entries()].map(([price, weighted]) => ({ price, weighted: Math.round(weighted) }))
    .sort((a, b) => b.weighted - a.weighted).slice(0, 8);
  const lvn = [...lvnMap.entries()].map(([price, weighted]) => ({ price, weighted: Math.round(weighted) }))
    .sort((a, b) => a.weighted - b.weighted).slice(0, 6);

  return {
    poc: pocW > 0 ? Number((pocSum / pocW).toFixed(2)) : null,
    vah: vaW  > 0 ? Number((vahSum / vaW).toFixed(2)) : null,
    val: vaW  > 0 ? Number((valSum / vaW).toFixed(2)) : null,
    hvn, lvn,
    sessionsUsed: summaries.length,
  };
}

// ─── OI migration across days ───────────────────────────────────────────
function _oiMigration(summaries) {
  if (!summaries || summaries.length < 2) return { ce: 'flat', pe: 'flat' };
  const first = summaries[0];
  const last  = summaries[summaries.length - 1];
  const move = (a, b) => (a == null || b == null) ? 'flat'
    : b > a ? 'up' : b < a ? 'down' : 'flat';
  return {
    ce: move(first.cePeakStrike, last.cePeakStrike),
    pe: move(first.pePeakStrike, last.pePeakStrike),
    cePeakStart: first.cePeakStrike, cePeakEnd: last.cePeakStrike,
    pePeakStart: first.pePeakStrike, pePeakEnd: last.pePeakStrike,
    sessionsTracked: summaries.length,
  };
}

// ─── Session memory (per-day, accumulates as we run intraday cycles) ─────
function _emptyMemory() {
  return {
    failedBreakdowns: 0,
    failedBreakouts: 0,
    sweepsAboveHigh: 0,
    sweepsBelowLow:  0,
    vwapReclaims:    0,
    openingDriveDir: null,         // 'up' | 'down' | null
    cycleCount:      0,
    lastTouchedAt:   Date.now(),
  };
}

function _sessionMemory(date) {
  if (!_sessionMemoryByDate.has(date)) _sessionMemoryByDate.set(date, _emptyMemory());
  const m = _sessionMemoryByDate.get(date);
  m.lastTouchedAt = Date.now();
  return m;
}

function recordEvent(date, event) {
  const m = _sessionMemory(date);
  m.cycleCount++;
  if (event === 'failed_breakdown') m.failedBreakdowns++;
  else if (event === 'failed_breakout') m.failedBreakouts++;
  else if (event === 'sweep_above_high') m.sweepsAboveHigh++;
  else if (event === 'sweep_below_low')  m.sweepsBelowLow++;
  else if (event === 'vwap_reclaim')     m.vwapReclaims++;
  else if (event && event.startsWith('opening_drive:')) m.openingDriveDir = event.split(':')[1];
}

function getSessionMemory(date) {
  return _sessionMemoryByDate.has(date) ? _sessionMemoryByDate.get(date) : _emptyMemory();
}

function resetSessionMemory(date) {
  if (date) _sessionMemoryByDate.delete(date);
  else _sessionMemoryByDate.clear();
}

// ─── ATR / IV percentiles ───────────────────────────────────────────────
function _atrPercentile(currentAtr, summaries) {
  if (!Number.isFinite(currentAtr) || !summaries?.length) return null;
  const population = summaries.map(s => s.atr5m).filter(Number.isFinite);
  if (population.length < 5) return null;
  return _percentileRank(population, currentAtr);
}

// IV percentile is best-effort — if the day's option-chain has ATM IV
// recorded (which it does, via the `iv` field), we approximate per-day mean.
function _ivSeries(folders, rootDir = ROOT_DIR) {
  const out = [];
  for (const f of folders) {
    const oc = _readJsonl(path.join(rootDir, f, 'option-chain.jsonl'));
    if (!oc.length) continue;
    // Take a few samples through the day, average IV at ATM
    const samples = oc.filter((_, i) => i % Math.max(1, Math.floor(oc.length / 10)) === 0);
    let s = 0, n = 0;
    for (const snap of samples) {
      const atm = snap.atm;
      const row = (snap.strikes || []).find(x => x.strike === atm);
      const iv = row?.ce?.iv;
      if (Number.isFinite(iv) && iv > 0) { s += iv; n++; }
    }
    if (n) out.push(s / n);
  }
  return out;
}

function _ivPercentile(currentIv, ivSeries) {
  if (!Number.isFinite(currentIv) || !ivSeries?.length) return null;
  return _percentileRank(ivSeries, currentIv);
}

// ─── Public: build context for a given date ──────────────────────────────
/**
 * @param {Object} args
 * @param {string} args.date          - 'YYYY-MM-DD' for today
 * @param {number} [args.priorDays=5] - how many sessions to load
 * @param {number} [args.currentAtr]  - current 5m ATR for percentile
 * @param {number} [args.currentIv]   - current ATM IV for percentile
 * @param {string} [args.rootDir]     - override live-feed root (testing)
 * @returns {Object} compact context
 */
function buildContext({ date, priorDays = 5, currentAtr = null, currentIv = null, rootDir = ROOT_DIR } = {}) {
  if (!date) return null;

  const folders = _foldersBefore(date, priorDays, rootDir);
  const summaries = folders.map(f => _buildDaySummary(f, rootDir)).filter(Boolean);

  const priorDay = summaries.length ? summaries[summaries.length - 1] : null;

  // Weekly aggregate (last 5 sessions or all available)
  let priorWeek = null;
  if (summaries.length >= 2) {
    const week = summaries.slice(-5);
    priorWeek = {
      sessions: week.length,
      high:  Number(Math.max(...week.map(s => s.high)).toFixed(2)),
      low:   Number(Math.min(...week.map(s => s.low)).toFixed(2)),
      avgRange: Number((week.reduce((a, s) => a + s.range, 0) / week.length).toFixed(2)),
      avgAtr5m: Number((week.reduce((a, s) => a + (s.atr5m || 0), 0) / week.length).toFixed(2)),
      dayTypes: week.map(s => s.dayType),
    };
  }

  const compositeProfile = _compositeProfile(summaries);
  const oiMig            = _oiMigration(summaries);
  const atrPct           = _atrPercentile(currentAtr, summaries);
  const ivSeries         = _ivSeries(folders, rootDir);
  const ivPct            = _ivPercentile(currentIv, ivSeries);

  // Build a flat list of high-importance levels
  const levels = [];
  if (priorDay) {
    levels.push({ name: 'PDH',  price: priorDay.high,  source: 'prior_day' });
    levels.push({ name: 'PDL',  price: priorDay.low,   source: 'prior_day' });
    levels.push({ name: 'PrevClose', price: priorDay.close, source: 'prior_day' });
    if (priorDay.vah) levels.push({ name: 'PVAH', price: priorDay.vah, source: 'prior_day' });
    if (priorDay.val) levels.push({ name: 'PVAL', price: priorDay.val, source: 'prior_day' });
    if (priorDay.poc) levels.push({ name: 'PPOC', price: priorDay.poc, source: 'prior_day' });
  }
  if (priorWeek) {
    levels.push({ name: 'WkHigh', price: priorWeek.high, source: 'prior_week' });
    levels.push({ name: 'WkLow',  price: priorWeek.low,  source: 'prior_week' });
  }
  if (compositeProfile) {
    if (compositeProfile.poc) levels.push({ name: 'CompPOC', price: compositeProfile.poc, source: 'composite' });
    if (compositeProfile.vah) levels.push({ name: 'CompVAH', price: compositeProfile.vah, source: 'composite' });
    if (compositeProfile.val) levels.push({ name: 'CompVAL', price: compositeProfile.val, source: 'composite' });
  }

  return {
    date,
    priorDay,
    priorWeek,
    priorDays: summaries,           // full per-day summaries (for AI / analytics)
    compositeProfile,
    oiMigration: oiMig,
    atrPercentile: atrPct,
    ivPercentile:  ivPct,
    sessionMemory: getSessionMemory(date),
    levels,
  };
}

module.exports = {
  buildContext,
  recordEvent,
  getSessionMemory,
  resetSessionMemory,
  // exposed for tests / advanced wiring
  _buildDaySummary,
  _volumeProfile,
  _classifyDayType,
};
