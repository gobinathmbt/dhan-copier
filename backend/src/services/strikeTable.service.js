/* ─────────────────────────────────────────────────────────────────────
 * STRIKE TABLE SERVICE
 * ========================================================================
 * Returns the primary (ATM) strike of the day with ± N strikes, each row
 * carrying the current CE/PE LTP, OI, Volume and the FIRST-5-MIN
 * **OPEN / HIGH / LOW** for both legs (the institutional opening-range).
 *
 * OPENING-RANGE SOURCE (priority order):
 *   1. Dhan intraday 5-min candles via `/v2/charts/intraday` for each
 *      option's `securityId` (this is the SAME source the Dhan chart
 *      uses → values match the chart exactly).
 *   2. Recorded option-chain.jsonl (live-feed folder) — fallback when
 *      Dhan candles are unavailable.
 *   3. In-memory poll buffer per (symbol, date) — last-resort fallback.
 *
 * Endpoint: GET /api/strike-table?symbol=NIFTY_50[&date=YYYY-MM-DD][&range=6]
 * ───────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

const intelV2 = require('./intelV2.service');
const dhanProd = require('./dhanProd.service');
const symbolRegistry = require('../config/symbolRegistry');

const LIVE_FEED_DIR = path.join(__dirname, '../../live-feed');

function _safe(n, d = 0) { const x = Number(n); return Number.isFinite(x) ? x : d; }
function _round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
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
  } catch (_) { return []; }
}

/* ─── In-memory snapshot buffer (last-resort fallback) ─────────────── */
const _ocBuffer = new Map();
const OC_BUFFER_MAX = 600;
const OC_BUFFER_TTL_MS = 12 * 3600 * 1000;
function _pushOcBuffer(key, sample) {
  const list = _ocBuffer.get(key) || [];
  list.push(sample);
  const cutoff = Date.now() - OC_BUFFER_TTL_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  while (list.length > OC_BUFFER_MAX) list.shift();
  _ocBuffer.set(key, list);
  return list;
}

/* ─── Per-strike opening-range cache (Dhan candle fetch) ────────────────
 * Key:  ${symbol}|${date}|${strike}|${side}|v2
 * Val:  { open, high, low, fetchedAt }
 * Once we successfully read the 09:15-09:20 candle from Dhan we cache
 * indefinitely for the trading day — the open range never changes after
 * 09:20. We also cache "miss" results for 30s to avoid hammering Dhan.
 * The "v2" suffix invalidates entries cached before the 09:15-bar fix. */
const _orCache = new Map();
const OR_MISS_TTL_MS = 30_000;
const OR_CACHE_VERSION = 'v2';

/* ─── IST 09:15 anchor for a given YYYY-MM-DD ─────────────────────── */
function _sessionOpenMs(yyyyMmDd) {
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d, 3, 45, 0); // 09:15 IST = 03:45 UTC
}

function _normalizeStrikeRow(s) {
  const ce = s.call || s.ce || {};
  const pe = s.put  || s.pe || {};
  return {
    strike: Number(s.strike),
    ceLtp: _safe(ce.ltp),
    peLtp: _safe(pe.ltp),
    ceOi:  _safe(ce.oi),
    peOi:  _safe(pe.oi),
    ceVol: _safe(ce.volume ?? ce.vol),
    peVol: _safe(pe.volume ?? pe.vol),
    ceSecId: ce.securityId || ce.security_id || null,
    peSecId: pe.securityId || pe.security_id || null,
  };
}

/* ─── Dhan intraday rate limiter ─────────────────────────────────────
 * Dhan's intraday endpoint allows ~5 req/s per user. We serialize all
 * candle fetches with a small floor between consecutive calls so 26
 * legs in the window don't all hit at once and trigger 429s. */
let _intradayChain = Promise.resolve();
const INTRADAY_GAP_MS = 220;
function _scheduleIntraday(fn) {
  const next = _intradayChain.then(async () => {
    const r = await fn();
    await new Promise((r) => setTimeout(r, INTRADAY_GAP_MS));
    return r;
  });
  // keep the chain healthy on failure
  _intradayChain = next.catch(() => {});
  return next;
}

/**
 * Fetch the actual first-5-min OHLC for a single option leg from Dhan's
 * intraday API. Throttled, cached.
 */
async function _fetchOpenRangeFromDhan({
  authKey, secId, exchange, date, cacheKey,
}) {
  if (!secId || !authKey) return null;

  const cached = _orCache.get(cacheKey);
  if (cached && cached.open != null) return cached;
  if (cached && Date.now() - cached.fetchedAt < OR_MISS_TTL_MS) return null;

  return _scheduleIntraday(async () => {
    try {
      const I = intelV2.__internals || {};
      const { start, end } = I._sessionUtcRange(date);
      // Dhan's /v2/charts/intraday occasionally drops the 09:15-09:20 bar
      // when fromDate is exactly 09:15:00 — it returns the 09:20 bar as the
      // first one (the same bug worked around in historicalBackfill). Start
      // ~5 min earlier and pick the first candle at/after 09:15 IST so the
      // ORB row (open=237, high=237, low=160.35 in the chart) shows
      // correctly instead of the truncated 09:20 bar.
      const safeStart = start - 5 * 60;
      const res = await dhanProd.getDhanProdData(authKey, {
        securityId: secId,
        exchange,
        segment: 'D',
        instrument: 'OPTIDX',
        startTime: safeStart,
        endTime: end,
        interval: '5',
      });
      if (!res?.ok || !Array.isArray(res.data?.candles) || !res.data.candles.length) {
        _orCache.set(cacheKey, { open: null, high: null, low: null, fetchedAt: Date.now() });
        return null;
      }
      // Pick the first candle whose timestamp lands inside the 09:15-09:20
      // session-open window. Falls back to the first candle returned if
      // Dhan's clock drifts a few seconds.
      const sessionOpenSec = start;          // 09:15:00 IST in unix seconds
      const sessionWindowEnd = start + 5*60; // 09:20:00 IST (exclusive)
      const candles = res.data.candles;
      const orb =
        candles.find((c) => {
          const t = _safe(c.time ?? c.timestamp);
          return t >= sessionOpenSec && t < sessionWindowEnd;
        }) ||
        candles.find((c) => _safe(c.time ?? c.timestamp) >= sessionOpenSec) ||
        candles[0];
      const out = {
        open: _round(_safe(orb.open), 2),
        high: _round(_safe(orb.high), 2),
        low:  _round(_safe(orb.low),  2),
        close: _round(_safe(orb.close), 2),
        timestamp: _safe(orb.time ?? orb.timestamp),
        fetchedAt: Date.now(),
      };
      _orCache.set(cacheKey, out);
      return out;
    } catch (_) {
      _orCache.set(cacheKey, { open: null, high: null, low: null, fetchedAt: Date.now() });
      return null;
    }
  });
}

/* ─── Folder/buffer fallback for the open range (when Dhan is unavailable) */
function _firstFiveMinFromHistory(date, symbolKey) {
  const file = path.join(LIVE_FEED_DIR, `${date}_${symbolKey}`, 'option-chain.jsonl');
  const fileRows = _readJsonl(file);
  const bufferRows = _ocBuffer.get(`${symbolKey}|${date}`) || [];
  const samples = [];
  for (const r of fileRows) {
    if (!r?.t || !Array.isArray(r.strikes)) continue;
    samples.push({ t: _safe(r.t), strikes: r.strikes });
  }
  for (const b of bufferRows) {
    samples.push({ t: _safe(b.t), strikes: b.strikes });
  }
  if (!samples.length) {
    return { byStrike: new Map(), windowStartMs: null, windowEndMs: null, snapshotCount: 0, sources: { file: 0, buffer: 0 }, anchor: 'none' };
  }
  samples.sort((a, b) => a.t - b.t);

  const sessionStart = _sessionOpenMs(date);
  const sessionWindowEnd = sessionStart != null ? sessionStart + 5 * 60_000 : null;
  const haveSessionSamples = sessionStart != null && samples.some((s) => s.t >= sessionStart && s.t <= sessionWindowEnd);
  const t0 = haveSessionSamples ? sessionStart : samples[0].t;
  const tEnd = t0 + 5 * 60_000;
  const anchor = haveSessionSamples ? 'session-open' : 'first-sample';

  const byStrike = new Map();
  let snapshotCount = 0;
  const seenT = new Set();
  for (const row of samples) {
    if (row.t < t0) continue;
    if (row.t > tEnd) break;
    if (seenT.has(row.t)) continue;
    seenT.add(row.t);
    snapshotCount++;
    for (const s of row.strikes) {
      const n = _normalizeStrikeRow(s);
      if (!Number.isFinite(n.strike)) continue;
      const cur = byStrike.get(n.strike) || { ceOpen: null, peOpen: null, ceHigh: -Infinity, ceLow: Infinity, peHigh: -Infinity, peLow: Infinity };
      if (cur.ceOpen == null && n.ceLtp > 0) cur.ceOpen = n.ceLtp;
      if (cur.peOpen == null && n.peLtp > 0) cur.peOpen = n.peLtp;
      if (n.ceLtp > 0) {
        if (n.ceLtp > cur.ceHigh) cur.ceHigh = n.ceLtp;
        if (n.ceLtp < cur.ceLow)  cur.ceLow  = n.ceLtp;
      }
      if (n.peLtp > 0) {
        if (n.peLtp > cur.peHigh) cur.peHigh = n.peLtp;
        if (n.peLtp < cur.peLow)  cur.peLow  = n.peLtp;
      }
      byStrike.set(n.strike, cur);
    }
  }
  for (const [k, v] of byStrike) {
    if (!Number.isFinite(v.ceHigh)) v.ceHigh = null;
    if (!Number.isFinite(v.ceLow))  v.ceLow  = null;
    if (!Number.isFinite(v.peHigh)) v.peHigh = null;
    if (!Number.isFinite(v.peLow))  v.peLow  = null;
    byStrike.set(k, v);
  }
  return { byStrike, windowStartMs: t0, windowEndMs: tEnd, snapshotCount, sources: { file: fileRows.length, buffer: bufferRows.length }, anchor };
}

/* ═════════════════════════════════════════════════════════════════════ */
async function getStrikeTable({ symbol = 'NIFTY_50', date = null, range = 6 } = {}) {
  const SYMBOL = String(symbol).toUpperCase();
  const sym = symbolRegistry.getSymbol(SYMBOL);
  if (!sym) return { ok: false, error: `Unsupported symbol: ${SYMBOL}` };

  const v2 = await intelV2.getSnapshot({ symbol: SYMBOL, date });
  if (!v2 || !v2.ok) return { ok: false, error: 'V2 snapshot unavailable' };

  const usedDate = v2.date;
  const isToday = !!v2.isToday;
  const spot = _safe(v2.spot?.ltp);
  const step = sym.strikeStep || 50;
  const ladder = Array.isArray(v2.ladder) ? v2.ladder : [];

  // ── Pull the FULL option chain (gives us security IDs + full range) ──
  const I = intelV2.__internals || {};
  const authKey = I._activeAuthKey ? I._activeAuthKey() : null;
  let fullChain = null;
  try {
    if (typeof I._loadOptionChain === 'function') {
      fullChain = await I._loadOptionChain(authKey, sym, usedDate, isToday);
    }
  } catch (_) { /* fall through */ }

  const anchor = _safe(v2.options?.atm, _safe(fullChain?.atm, Math.round(spot / step) * step));

  // Build the strike map keyed by strike, merging ladder (fresh LTP) with
  // full chain (security IDs + far strikes).
  const strikeMap = new Map();
  if (fullChain && Array.isArray(fullChain.strikes)) {
    for (const s of fullChain.strikes) strikeMap.set(Number(s.strike), s);
  }
  for (const r of ladder) {
    const k = Number(r.strike);
    const ex = strikeMap.get(k) || { strike: k };
    const exCe = ex.call || ex.ce || {};
    const exPe = ex.put  || ex.pe || {};
    strikeMap.set(k, {
      strike: k,
      ce: {
        ...exCe,
        ltp: _safe(r.ce?.ltp, _safe(exCe.ltp)),
        oi:  _safe(r.ce?.oi,  _safe(exCe.oi)),
        volume: _safe(r.ce?.volume, _safe(exCe.volume ?? exCe.vol)),
      },
      pe: {
        ...exPe,
        ltp: _safe(r.pe?.ltp, _safe(exPe.ltp)),
        oi:  _safe(r.pe?.oi,  _safe(exPe.oi)),
        volume: _safe(r.pe?.volume, _safe(exPe.volume ?? exPe.vol)),
      },
    });
  }

  // Buffer this snapshot for the fallback path.
  if (isToday && strikeMap.size && spot > 0) {
    const bufStrikes = [...strikeMap.values()].map((s) => ({
      strike: Number(s.strike),
      ce: { ltp: _safe((s.ce || s.call)?.ltp) },
      pe: { ltp: _safe((s.pe || s.put)?.ltp) },
    }));
    _pushOcBuffer(`${SYMBOL}|${usedDate}`, { t: Date.now(), strikes: bufStrikes });
  }

  // History-based fallback — only used if Dhan returns no auth/no data
  // for ANY leg in the window (auth key missing, etc.). This prevents
  // showing wrong/stale history values when Dhan is just rate-limited
  // (those legs will fill on the next poll once the cache warms up).
  const fallbackOR = _firstFiveMinFromHistory(usedDate, SYMBOL);

  // Build the visible window strikes.
  const rangeN = Math.max(1, Math.min(20, Math.round(_safe(range, 6))));
  const exchange = sym.exchange || (SYMBOL === 'SENSEX' ? 'BSE' : 'NSE');

  // ── Schedule Dhan 5-min open candle fetches for every leg in the
  //    window (throttled). Returns the cached value immediately when
  //    available, else queues a fetch.
  const fetchTasks = [];
  for (let i = -rangeN; i <= rangeN; i++) {
    const strike = anchor + i * step;
    const s = strikeMap.get(strike);
    if (!s) continue;
    const ce = s.ce || s.call || {};
    const pe = s.pe || s.put  || {};
    const ceSecId = ce.securityId || ce.security_id || null;
    const peSecId = pe.securityId || pe.security_id || null;
    if (ceSecId) {
      fetchTasks.push((async () => {
        const r = await _fetchOpenRangeFromDhan({
          authKey, secId: ceSecId, exchange, date: usedDate,
          cacheKey: `${SYMBOL}|${usedDate}|${strike}|CE|${OR_CACHE_VERSION}`,
        });
        return { strike, side: 'CE', r };
      })());
    }
    if (peSecId) {
      fetchTasks.push((async () => {
        const r = await _fetchOpenRangeFromDhan({
          authKey, secId: peSecId, exchange, date: usedDate,
          cacheKey: `${SYMBOL}|${usedDate}|${strike}|PE|${OR_CACHE_VERSION}`,
        });
        return { strike, side: 'PE', r };
      })());
    }
  }
  const dhanResults = await Promise.all(fetchTasks);
  const dhanByStrike = new Map();
  for (const { strike, side, r } of dhanResults) {
    if (!r) continue;
    const cur = dhanByStrike.get(strike) || {};
    cur[side] = r;
    dhanByStrike.set(strike, cur);
  }

  let dhanHits = 0;
  for (const v of dhanByStrike.values()) {
    if (v.CE?.open != null) dhanHits++;
    if (v.PE?.open != null) dhanHits++;
  }
  // Use history fallback ONLY when Dhan returned literally nothing
  // (e.g. no auth key on a historical replay where the chain's secIds
  // are stale). Otherwise we trust Dhan and accept "—" for cells that
  // are still in the throttled queue — they fill on the next poll.
  const useHistoryFallback = dhanHits === 0;

  const rows = [];
  for (let i = -rangeN; i <= rangeN; i++) {
    const strike = anchor + i * step;
    const s = strikeMap.get(strike);
    const ceLeg = s ? (s.ce || s.call || {}) : {};
    const peLeg = s ? (s.pe || s.put  || {}) : {};
    const dhan = dhanByStrike.get(strike) || {};
    const fb = useHistoryFallback ? (fallbackOR.byStrike.get(strike) || null) : null;

    const ceDhan = dhan.CE?.open != null ? dhan.CE : null;
    const peDhan = dhan.PE?.open != null ? dhan.PE : null;

    rows.push({
      strike,
      offset: i,
      isAtm: strike === anchor,
      ce: {
        ltp: _round(_safe(ceLeg.ltp), 2),
        oi: _safe(ceLeg.oi),
        volume: _safe(ceLeg.volume ?? ceLeg.vol),
        firstFiveOpen: ceDhan ? ceDhan.open : (fb?.ceOpen != null ? _round(fb.ceOpen, 2) : null),
        firstFiveHigh: ceDhan ? ceDhan.high : (fb?.ceHigh != null ? _round(fb.ceHigh, 2) : null),
        firstFiveLow:  ceDhan ? ceDhan.low  : (fb?.ceLow  != null ? _round(fb.ceLow,  2) : null),
        openRangeSource: ceDhan ? 'dhan-candle' : (fb?.ceOpen != null ? 'history' : 'pending'),
      },
      pe: {
        ltp: _round(_safe(peLeg.ltp), 2),
        oi: _safe(peLeg.oi),
        volume: _safe(peLeg.volume ?? peLeg.vol),
        firstFiveOpen: peDhan ? peDhan.open : (fb?.peOpen != null ? _round(fb.peOpen, 2) : null),
        firstFiveHigh: peDhan ? peDhan.high : (fb?.peHigh != null ? _round(fb.peHigh, 2) : null),
        firstFiveLow:  peDhan ? peDhan.low  : (fb?.peLow  != null ? _round(fb.peLow,  2) : null),
        openRangeSource: peDhan ? 'dhan-candle' : (fb?.peOpen != null ? 'history' : 'pending'),
      },
    });
  }

  const sessionStartMs = _sessionOpenMs(usedDate);
  const usingDhan = dhanHits > 0;
  const usingHistory = useHistoryFallback && fallbackOR.snapshotCount > 0;

  return {
    ok: true,
    version: 'strike-table-v1',
    symbol: v2.symbol,
    displayName: v2.displayName || sym.displayName,
    date: usedDate,
    isToday,
    at: Date.now(),
    spot: _round(spot, 2),
    spotChange: _round(_safe(v2.spot?.change), 2),
    spotChangePct: _round(_safe(v2.spot?.changePct), 2),
    atm: anchor,
    step,
    range: rangeN,
    rowCount: rows.length,
    source: isToday ? 'live' : 'folder',
    chainSource: fullChain?.source || (isToday ? 'live-api' : 'folder'),
    fiveMin: {
      windowStartMs: usingDhan ? sessionStartMs : (usingHistory ? fallbackOR.windowStartMs : sessionStartMs),
      windowEndMs:   usingDhan ? (sessionStartMs + 5 * 60_000) : (usingHistory ? fallbackOR.windowEndMs : (sessionStartMs ? sessionStartMs + 5 * 60_000 : null)),
      snapshotCount: fallbackOR.snapshotCount,
      ready: usingDhan || usingHistory,
      anchor: usingDhan ? 'session-open' : (usingHistory ? fallbackOR.anchor : 'session-open'),
      sources: { ...fallbackOR.sources, dhan: dhanHits },
      primary: usingDhan ? 'dhan-candle' : (usingHistory ? 'history' : 'pending'),
    },
    rows,
  };
}

module.exports = { getStrikeTable };
