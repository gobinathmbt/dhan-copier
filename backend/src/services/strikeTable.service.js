/* ─────────────────────────────────────────────────────────────────────
 * STRIKE TABLE SERVICE
 * ========================================================================
 * Returns the primary (ATM) strike of the day with ± N strikes, each row
 * carrying the current CE/PE LTP, OI, Volume and the FIRST-5-MIN HIGH/LOW
 * for both legs (the institutional opening-range that buyers watch).
 *
 * DATA SOURCES (in priority order):
 *   1. Recorded option-chain.jsonl (live-feed folder) — best for the
 *      opening 5-min window because the recorder captures every tick.
 *   2. In-memory ring buffer per (symbol, date) — populated by every
 *      poll while the page is open. Guarantees the 5-min window can be
 *      built even on days the recorder is not running, as long as the
 *      first call happens within the opening 5 minutes.
 *   3. V2's `_loadOptionChain` (full option chain via folder OR live Dhan
 *      API) — supplies LTP / OI / Volume for ALL strikes in the requested
 *      window. This is what fixes far-strike rows showing 0.
 *
 * Endpoint: GET /api/strike-table?symbol=NIFTY_50[&date=YYYY-MM-DD][&range=6]
 * ───────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

const intelV2 = require('./intelV2.service');
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

/* ─── In-memory snapshot buffer ─────────────────────────────────────────
 * Keyed by `${symbol}|${date}`. Each entry holds an array of
 * { t, strikes: { strikeN: { ceLtp, peLtp } } } captured every poll.
 * Used to build the first-5-min H/L when the JSONL recorder is not
 * writing for today's session. */
const _ocBuffer = new Map();
const OC_BUFFER_MAX = 600; // ~30 min @ 3s
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

/* Normalize a single strike row from the option-chain feed (handles both
 * ce/pe (recorded) and call/put (Dhan API) shapes). */
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
  };
}

/* ─── IST session-open anchor (09:15:00 IST) for a given YYYY-MM-DD ─── */
function _sessionOpenMs(yyyyMmDd) {
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  if (!y || !m || !d) return null;
  // 09:15 IST = 03:45 UTC.
  return Date.UTC(y, m - 1, d, 3, 45, 0);
}

/**
 * Build the first-5-min H/L map per strike from BOTH:
 *   • recorded option-chain.jsonl (preferred — denser samples)
 *   • the in-memory buffer (covers live days where the recorder isn't running)
 *
 * The 5-min window is anchored on the **IST session open (09:15:00)** for
 * the given date. If we have no samples within that window we fall back to
 * the first available sample time so a user opening the page mid-session
 * still sees something useful from the recorded file.
 */
function _firstFiveMinByStrike(date, symbolKey) {
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

  // Prefer the institutional 09:15 IST anchor; only when we have NO samples
  // in that window do we fall back to the first-sample anchor.
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
      const cur = byStrike.get(n.strike) || { ceOpen: null, peOpen: null, ceHigh: -Infinity, ceLow: Infinity, peHigh: -Infinity, peLow: Infinity, samples: 0 };
      // First non-zero LTP in the window = the strike's "open".
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
      cur.samples += 1;
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
  return {
    byStrike, windowStartMs: t0, windowEndMs: tEnd, snapshotCount,
    sources: { file: fileRows.length, buffer: bufferRows.length },
    anchor,
  };
}

/* ═════════════════════════════════════════════════════════════════════ */
async function getStrikeTable({ symbol = 'NIFTY_50', date = null, range = 6 } = {}) {
  const SYMBOL = String(symbol).toUpperCase();
  const sym = symbolRegistry.getSymbol(SYMBOL);
  if (!sym) return { ok: false, error: `Unsupported symbol: ${SYMBOL}` };

  // V2 snapshot — gives us spot, ATM, isToday, and the resolved date that
  // accounts for weekend → previous-trading-day fallback.
  const v2 = await intelV2.getSnapshot({ symbol: SYMBOL, date });
  if (!v2 || !v2.ok) return { ok: false, error: 'V2 snapshot unavailable' };

  const usedDate = v2.date;
  const isToday = !!v2.isToday;
  const spot = _safe(v2.spot?.ltp);
  const step = sym.strikeStep || 50;
  const ladder = Array.isArray(v2.ladder) ? v2.ladder : [];

  // ── Pull the FULL option chain via V2's internal loader (covers ALL
  //    strikes — folder for historical, live Dhan API for today). This is
  //    what supplies LTP/OI/Volume for far strikes outside V2's ATM±4
  //    ladder.
  const I = intelV2.__internals || {};
  const authKey = I._activeAuthKey ? I._activeAuthKey() : null;
  let fullChain = null;
  try {
    if (typeof I._loadOptionChain === 'function') {
      fullChain = await I._loadOptionChain(authKey, sym, usedDate, isToday);
    }
  } catch (_) { /* swallow — we'll fall back to ladder only */ }

  // ATM — prefer the V2 / Dhan-provided ATM, fall back to step math.
  const anchor = _safe(v2.options?.atm, _safe(fullChain?.atm, Math.round(spot / step) * step));

  // Build a strike→row map from the richest source available.
  const strikeMap = new Map();
  if (fullChain && Array.isArray(fullChain.strikes)) {
    for (const s of fullChain.strikes) strikeMap.set(Number(s.strike), s);
  }
  // Ladder (from V2) has fresher LTP via the live tick path — overlay it.
  for (const r of ladder) {
    const k = Number(r.strike);
    const existing = strikeMap.get(k) || { strike: k };
    strikeMap.set(k, {
      strike: k,
      // Prefer ladder LTPs (fresher); preserve OI/volume from full chain.
      ce: { ...(existing.call || existing.ce || {}), ltp: _safe(r.ce?.ltp), oi: _safe(r.ce?.oi, _safe((existing.call || existing.ce)?.oi)), volume: _safe(r.ce?.volume, _safe((existing.call || existing.ce)?.volume ?? (existing.call || existing.ce)?.vol)) },
      pe: { ...(existing.put  || existing.pe || {}), ltp: _safe(r.pe?.ltp), oi: _safe(r.pe?.oi, _safe((existing.put  || existing.pe)?.oi)), volume: _safe(r.pe?.volume, _safe((existing.put  || existing.pe)?.volume ?? (existing.put || existing.pe)?.vol)) },
    });
  }

  // ── Buffer this snapshot so the in-memory 5-min window can build even
  //    when the recorder is not writing JSONL today.
  if (isToday && strikeMap.size && spot > 0) {
    const bufStrikes = [...strikeMap.values()].map((s) => ({
      strike: Number(s.strike),
      ce: { ltp: _safe((s.ce || s.call)?.ltp), oi: _safe((s.ce || s.call)?.oi), volume: _safe((s.ce || s.call)?.volume) },
      pe: { ltp: _safe((s.pe || s.put)?.ltp), oi: _safe((s.pe || s.put)?.oi), volume: _safe((s.pe || s.put)?.volume) },
    }));
    _pushOcBuffer(`${SYMBOL}|${usedDate}`, { t: Date.now(), strikes: bufStrikes });
  }

  // ── First-5-min H/L map — uses file + buffer.
  const fiveMin = _firstFiveMinByStrike(usedDate, SYMBOL);

  const rangeN = Math.max(1, Math.min(20, Math.round(_safe(range, 6))));
  const rows = [];
  for (let i = -rangeN; i <= rangeN; i++) {
    const strike = anchor + i * step;
    const s = strikeMap.get(strike);
    const ceLeg = s ? (s.ce || s.call || {}) : {};
    const peLeg = s ? (s.pe || s.put  || {}) : {};
    const fm = fiveMin.byStrike.get(strike) || null;

    rows.push({
      strike,
      offset: i,
      isAtm: strike === anchor,
      ce: {
        ltp: _round(_safe(ceLeg.ltp), 2),
        oi: _safe(ceLeg.oi),
        volume: _safe(ceLeg.volume ?? ceLeg.vol),
        firstFiveOpen: fm?.ceOpen != null ? _round(fm.ceOpen, 2) : null,
        firstFiveHigh: fm?.ceHigh != null ? _round(fm.ceHigh, 2) : null,
        firstFiveLow:  fm?.ceLow  != null ? _round(fm.ceLow,  2) : null,
      },
      pe: {
        ltp: _round(_safe(peLeg.ltp), 2),
        oi: _safe(peLeg.oi),
        volume: _safe(peLeg.volume ?? peLeg.vol),
        firstFiveOpen: fm?.peOpen != null ? _round(fm.peOpen, 2) : null,
        firstFiveHigh: fm?.peHigh != null ? _round(fm.peHigh, 2) : null,
        firstFiveLow:  fm?.peLow  != null ? _round(fm.peLow,  2) : null,
      },
    });
  }

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
      windowStartMs: fiveMin.windowStartMs,
      windowEndMs: fiveMin.windowEndMs,
      snapshotCount: fiveMin.snapshotCount,
      ready: fiveMin.snapshotCount > 0,
      anchor: fiveMin.anchor,                    // 'session-open' | 'first-sample' | 'none'
      sources: fiveMin.sources,                  // { file, buffer }
    },
    rows,
  };
}

module.exports = { getStrikeTable };
