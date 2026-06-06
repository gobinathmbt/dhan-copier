/* ─────────────────────────────────────────────────────────────────────
 * CPR + CAMARILLA POWER ENGINE
 * ========================================================================
 * Standalone "side view" decision engine that fuses Floor-Pivot CPR
 * (TC / Pivot / BC) with the Camarilla extension levels (S3/S4 buy-zone,
 * R3/R4 sell/breakout zone, S5/S6 + R5/R6 trend-explosion levels) and
 * outputs an actionable BUY CE / BUY PE / WAIT call with confidence,
 * targets, invalidation, and a strength meter — all derived from spot
 * location relative to those levels.
 *
 * Camarilla formulas (prior-day H,L,C):
 *   range = H - L
 *   R3 = C + range × 1.1 / 4
 *   R4 = C + range × 1.1 / 2
 *   R5 = (H / L) × C
 *   R6 = (H × C) / L
 *   S3 = C - range × 1.1 / 4
 *   S4 = C - range × 1.1 / 2
 *   S5 = 2 × C - R5
 *   S6 = 2 × C - R6
 *
 * Endpoint: GET /api/cpr-cam?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelV2 = require('./intelV2.service');
const dhanProd = require('./dhanProd.service');
const symbolRegistry = require('../config/symbolRegistry');

function _safe(n, d = 0) { const x = Number(n); return Number.isFinite(x) ? x : d; }
function _round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function _clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* ─── Per-symbol rolling history (for "near level" hold/reject detection) ─ */
const _levelHistory = new Map(); // symbol → [{ t, spot, ts }]
const HISTORY_MAX = 80;
const HISTORY_TTL_MS = 30 * 60_000;

/* ─── Candle loader — Dhan intraday API first, folder fallback ────────
 * Dhan's intraday endpoint returns the full 09:15 → now session, which
 * matches what TradingView shows. The folder-only path under-fills the
 * chart in the morning before the recorder has accumulated bars. */
async function _loadIntradayCandles({ authKey, sym, date, isToday, interval = '5' }) {
  const I = intelV2.__internals || {};
  // 1. Try Dhan API first when we have an auth key — this gives us the full
  //    session for any date in the past ~90 days.
  if (authKey && typeof I._sessionUtcRange === 'function') {
    try {
      const { start, end } = I._sessionUtcRange(date);
      // Subtract 5 min to defeat Dhan's occasional 09:15-bar drop (same
      // workaround V2 uses for the option chain).
      const safeStart = start - 5 * 60;
      const res = await dhanProd.getDhanProdData(authKey, {
        securityId: sym.indexSecurityId,
        exchange: 'IDX', segment: 'I', instrument: 'IDX',
        startTime: safeStart,
        endTime: end,
        interval,
      });
      if (res?.ok && Array.isArray(res.data?.candles) && res.data.candles.length) {
        const out = res.data.candles
          .map((c) => ({
            timestamp: Number(c.timestamp ?? c.time ?? c.t),
            open: _safe(c.open), high: _safe(c.high),
            low:  _safe(c.low),  close: _safe(c.close),
            volume: _safe(c.volume),
          }))
          .filter((c) => Number.isFinite(c.timestamp) && c.timestamp >= start);
        if (out.length) return { candles: out, source: 'dhan-api' };
      }
    } catch (_) { /* fall through to folder */ }
  }
  // 2. Fall back to whatever the live-feed folder has recorded so far.
  if (typeof I._readCandlesFile === 'function') {
    const folder = I._readCandlesFile(date, sym.key, 'candles', interval === '5' ? '5m' : `${interval}m`) || [];
    if (folder.length) return { candles: folder, source: 'live-feed-folder' };
  }
  // 3. As a last resort try Dhan API even without an auth key (some envs
  //    allow public intraday calls). Same path as (1) without authKey.
  if (typeof I._sessionUtcRange === 'function') {
    try {
      const { start, end } = I._sessionUtcRange(date);
      const res = await dhanProd.getDhanProdData(null, {
        securityId: sym.indexSecurityId,
        exchange: 'IDX', segment: 'I', instrument: 'IDX',
        startTime: start - 5 * 60, endTime: end, interval,
      });
      if (res?.ok && Array.isArray(res.data?.candles) && res.data.candles.length) {
        return {
          candles: res.data.candles.map((c) => ({
            timestamp: Number(c.timestamp ?? c.time ?? c.t),
            open: _safe(c.open), high: _safe(c.high),
            low:  _safe(c.low),  close: _safe(c.close),
            volume: _safe(c.volume),
          })),
          source: 'dhan-api-anon',
        };
      }
    } catch (_) { /* noop */ }
  }
  void isToday;
  return { candles: [], source: 'none' };
}

/* ─── Camarilla from prior-day OHLC ───────────────────────────────────── */
function _camarillaFromOHLC(ohlc) {
  if (!ohlc) return null;
  const { high: H, low: L, close: C } = ohlc;
  if (![H, L, C].every(Number.isFinite)) return null;
  const range = H - L;
  const r3 = C + (range * 1.1) / 4;
  const r4 = C + (range * 1.1) / 2;
  const s3 = C - (range * 1.1) / 4;
  const s4 = C - (range * 1.1) / 2;
  const r5 = L > 0 ? (H / L) * C : C + range;
  const r6 = L > 0 ? (H * C) / L : r5 + range;
  const s5 = 2 * C - r5;
  const s6 = 2 * C - r6;
  return {
    r3: _round(r3, 2), r4: _round(r4, 2),
    r5: _round(r5, 2), r6: _round(r6, 2),
    s3: _round(s3, 2), s4: _round(s4, 2),
    s5: _round(s5, 2), s6: _round(s6, 2),
    h: _round(H, 2), l: _round(L, 2), c: _round(C, 2),
    range: _round(range, 2),
  };
}

/* ─── Compare spot vs levels — produce zone classification ────────────── */
function _classifyZone(spot, lvl, cprTc, cprBc) {
  if (!Number.isFinite(spot) || !lvl) return 'UNKNOWN';
  if (spot > lvl.r4) return 'ABOVE R4';            // breakout zone
  if (spot > lvl.r3) return 'ABOVE R3';            // R3 break / momentum
  if (Number.isFinite(cprTc) && spot > cprTc) return 'ABOVE TC';
  if (Number.isFinite(cprBc) && spot >= cprBc) return 'INSIDE CPR';
  if (spot > lvl.s3) return 'BELOW BC';
  if (spot > lvl.s4) return 'BELOW S3';            // breakdown zone
  return 'BELOW S4';                                // capitulation zone
}

/* ─── Logic-card evaluators (S3 hold / R3 reject / R3 break / S3 break) ── */
function _s3SupportLogic({ spot, lvl, cprBc, cprTc, recentLow, lastClose, lastOpen }) {
  // Price near S3, S3 holding (recent low ≥ S3 by a hair), bull candle.
  const nearS3   = Math.abs(spot - lvl.s3) <= Math.max(8, lvl.range * 0.005);
  const holding  = recentLow >= lvl.s3 - Math.max(4, lvl.range * 0.002);
  const bullBar  = lastClose > lastOpen;
  const aboveBc  = Number.isFinite(cprBc) && spot >= cprBc;
  const points = (nearS3 ? 1 : 0) + (holding ? 1 : 0) + (bullBar ? 1 : 0);
  const fired = nearS3 && holding && bullBar;
  return {
    title: 'S3 SUPPORT LOGIC',
    items: [
      { label: 'Price near S3',  ok: nearS3 },
      { label: 'S3 Support Holding', ok: holding },
      { label: 'Bull Candle Formed', ok: bullBar },
      { label: 'Move Towards Pivot/TC', ok: aboveBc || fired },
    ],
    action: fired ? 'BUY CE' : 'WAIT',
    actionTone: fired ? 'bull' : 'neutral',
    score: points * 25,
    fired,
  };
}

function _r3RejectionLogic({ spot, lvl, cprTc, recentHigh, lastClose, lastOpen }) {
  const nearR3   = Math.abs(spot - lvl.r3) <= Math.max(8, lvl.range * 0.005);
  const rejected = recentHigh >= lvl.r3 && lastClose < lvl.r3;
  const bearBar  = lastClose < lastOpen;
  const belowTc  = Number.isFinite(cprTc) && spot < cprTc;
  const points = (nearR3 ? 1 : 0) + (rejected ? 1 : 0) + (bearBar ? 1 : 0);
  const fired = nearR3 && rejected && bearBar;
  return {
    title: 'R3 REJECTION LOGIC',
    items: [
      { label: 'Price near R3',  ok: nearR3 },
      { label: 'R3 Rejected', ok: rejected },
      { label: 'Bear Candle Formed', ok: bearBar },
      { label: 'Move Towards Pivot/S3', ok: belowTc || fired },
    ],
    action: fired ? 'BUY PE' : 'WAIT',
    actionTone: fired ? 'bear' : 'neutral',
    score: points * 25,
    fired,
  };
}

function _r3BreakLogic({ spot, lvl, recentHigh, recentLow, lastClose }) {
  // Break: price closes above R3 → retest: price comes back near R3 → hold.
  const broken    = recentHigh > lvl.r3;
  const retested  = recentLow <= lvl.r3 + Math.max(8, lvl.range * 0.005) && recentLow >= lvl.r3 - Math.max(4, lvl.range * 0.002);
  const holding   = lastClose > lvl.r3;
  const points = (broken ? 1 : 0) + (retested ? 1 : 0) + (holding ? 1 : 0);
  const fired = broken && holding;
  return {
    title: 'R3 BREAK LOGIC',
    items: [
      { label: 'R3 Broken', ok: broken },
      { label: 'R3 Retest Done', ok: retested },
      { label: 'R3 Holding Strong', ok: holding },
      { label: 'Move Towards R4', ok: lastClose > lvl.r3 + lvl.range * 0.003 },
    ],
    action: fired ? 'BUY CE' : 'WAIT',
    actionTone: fired ? 'bull' : 'neutral',
    score: points * 25,
    fired,
  };
}

function _s3BreakLogic({ spot, lvl, recentHigh, recentLow, lastClose }) {
  const broken    = recentLow < lvl.s3;
  const retested  = recentHigh >= lvl.s3 - Math.max(8, lvl.range * 0.005) && recentHigh <= lvl.s3 + Math.max(4, lvl.range * 0.002);
  const rejected  = lastClose < lvl.s3;
  const points = (broken ? 1 : 0) + (retested ? 1 : 0) + (rejected ? 1 : 0);
  const fired = broken && rejected;
  return {
    title: 'S3 BREAK LOGIC',
    items: [
      { label: 'S3 Broken', ok: broken },
      { label: 'S3 Retest Done', ok: retested },
      { label: 'S3 Rejected', ok: rejected },
      { label: 'Move Towards S4', ok: lastClose < lvl.s3 - lvl.range * 0.003 },
    ],
    action: fired ? 'BUY PE' : 'WAIT',
    actionTone: fired ? 'bear' : 'neutral',
    score: points * 25,
    fired,
  };
}

/* ─── Strong prior-day OHLC loader (Dhan API first, folder fallback) ─
 * V2's `_loadPriorDayOHLC` trusts the live-feed folder if it has even one
 * 5-min candle — which gives wrong High / Low (and therefore wrong R3/R4
 * /S3/S4) when the recorder only captured part of the prior session.
 * For Camarilla we need the FULL prior-day session, so call the Dhan
 * intraday endpoint directly with the prior trading day's session window.
 * Falls back to the folder helper if the API is unreachable. */
async function _loadPriorDayOhlcStrong({ authKey, sym, date }) {
  const I = intelV2.__internals || {};
  const prevDate = typeof I._previousTradingDay === 'function' ? I._previousTradingDay(date) : null;
  if (!prevDate) return null;
  // 1. Dhan API — authoritative, full prior-day session.
  if (typeof I._sessionUtcRange === 'function') {
    try {
      const { start, end } = I._sessionUtcRange(prevDate);
      const res = await dhanProd.getDhanProdData(authKey, {
        securityId: sym.indexSecurityId,
        exchange: 'IDX', segment: 'I', instrument: 'IDX',
        startTime: start, endTime: end, interval: '5',
      });
      if (res?.ok && Array.isArray(res.data?.candles) && res.data.candles.length) {
        const cs = res.data.candles;
        const high = Math.max(...cs.map((c) => _safe(c.high)));
        const low  = Math.min(...cs.map((c) => _safe(c.low)));
        const open = _safe(cs[0].open);
        const close = _safe(cs[cs.length - 1].close);
        if ([high, low, close].every(Number.isFinite) && high > 0 && low > 0 && close > 0) {
          return { open, high, low, close, date: prevDate, source: 'dhan-api', samples: cs.length };
        }
      }
    } catch (_) { /* fall through */ }
  }
  // 2. Folder via the V2 helper (uses folder first, then API anonymously).
  if (typeof I._loadPriorDayOHLC === 'function') {
    try {
      const v2res = await I._loadPriorDayOHLC(authKey, sym, date);
      if (v2res) return { ...v2res, source: v2res.source || 'v2-helper' };
    } catch (_) { /* noop */ }
  }
  return null;
}

/* ═════════════════════════════════════════════════════════════════════
 *  GET /api/cpr-cam
 * ═════════════════════════════════════════════════════════════════════ */
async function getCprCam({ symbol = 'NIFTY_50', date = null, interval = '5' } = {}) {
  const SYMBOL = String(symbol).toUpperCase();
  const sym = symbolRegistry.getSymbol(SYMBOL);
  if (!sym) return { ok: false, error: `Unsupported symbol: ${SYMBOL}` };
  const VALID_INTERVALS = new Set(['1', '3', '5', '15', '30', '60']);
  const intv = VALID_INTERVALS.has(String(interval)) ? String(interval) : '5';

  const v2 = await intelV2.getSnapshot({ symbol: SYMBOL, date });
  if (!v2 || !v2.ok) return { ok: false, error: 'V2 snapshot unavailable' };

  const usedDate = v2.date;
  const isToday = !!v2.isToday;
  const spot = _safe(v2.spot?.ltp);
  const spotChange = _safe(v2.spot?.change);
  const spotChangePct = _safe(v2.spot?.changePct);
  const dayHigh = _safe(v2.spot?.dayHigh);
  const dayLow  = _safe(v2.spot?.dayLow);
  const priorClose = _safe(v2.spot?.priorClose);

  const cpr = v2.cpr || null;
  if (!cpr) return { ok: false, error: 'CPR unavailable for the requested date' };

  // Camarilla — uses prior-day OHLC fetched directly from Dhan first
  // (folder data can be incomplete and would distort R3/R4/S3/S4).
  const I = intelV2.__internals || {};
  const authKey = I._activeAuthKey ? I._activeAuthKey() : null;
  const priorOHLC = await _loadPriorDayOhlcStrong({ authKey, sym, date: usedDate });
  const cam = _camarillaFromOHLC(priorOHLC);
  if (!cam) return { ok: false, error: 'Prior-day OHLC unavailable for Camarilla' };

  // Re-derive CPR from the SAME prior-day OHLC so TC / Pivot / BC are
  // consistent with the Camarilla band. V2's CPR can drift if its folder
  // had partial prior-day data; using a single source keeps everything
  // aligned with TradingView's prior-day pivots.
  if (priorOHLC && typeof I._cprFromOHLC === 'function') {
    const freshCpr = I._cprFromOHLC(priorOHLC);
    if (freshCpr && Number.isFinite(freshCpr.tc) && Number.isFinite(freshCpr.bc)) {
      cpr.tc = freshCpr.tc;
      cpr.bc = freshCpr.bc;
      cpr.pivot = freshCpr.pivot;
      cpr.r1 = freshCpr.r1; cpr.r2 = freshCpr.r2; cpr.r3 = freshCpr.r3;
      cpr.s1 = freshCpr.s1; cpr.s2 = freshCpr.s2; cpr.s3 = freshCpr.s3;
      cpr.width = freshCpr.width;
      cpr.widthPct = freshCpr.widthPct;
      cpr.widthClass = freshCpr.widthClass;
    }
  }
  // Pine swap — guarantees TC is always the UPPER central line and BC the
  // LOWER. V2's raw `tc` formula is `2*pivot - bc`, which goes BELOW bc when
  // yesterday's close is under the (H+L) midpoint (typical on bearish days).
  // Pine handles this with `tc_final = max(tc,bc), bc_final = min(tc,bc)`.
  // We mirror that here so every downstream consumer (signal panel, scenario
  // guide, level chart lines) sees a correctly oriented CPR.
  if (Number.isFinite(cpr.tc) && Number.isFinite(cpr.bc) && cpr.tc < cpr.bc) {
    const _t = cpr.tc; cpr.tc = cpr.bc; cpr.bc = _t;
  }

  // Yesterday vs today CPR — for the "TODAY vs YESTERDAY" badge.
  let yCpr = null;
  try {
    const prevPrev = I._loadPriorDayOHLC ? null : null; void prevPrev;
    const _readCandles = I._readCandlesFile;
    const _prev = I._previousTradingDay;
    if (_readCandles && _prev) {
      const day1 = _prev(usedDate);            // prior trading day → today's CPR
      const day2 = _prev(day1);                // prior-prior → yesterday's CPR
      const c5 = _readCandles(day2, sym.key, 'candles', '5m');
      if (Array.isArray(c5) && c5.length) {
        const high = Math.max(...c5.map((c) => c.high));
        const low  = Math.min(...c5.map((c) => c.low));
        const close = c5[c5.length - 1].close;
        const ohlc = { high, low, close, open: c5[0].open };
        if (typeof I._cprFromOHLC === 'function') yCpr = I._cprFromOHLC(ohlc);
        // Same TC/BC swap as today's CPR.
        if (yCpr && Number.isFinite(yCpr.tc) && Number.isFinite(yCpr.bc) && yCpr.tc < yCpr.bc) {
          const _t = yCpr.tc; yCpr.tc = yCpr.bc; yCpr.bc = _t;
        }
      }
    }
  } catch (_) { /* noop */ }

  // 5m candles for the chart and recent-bar logic.
  // Prefer Dhan intraday API (full session for any date) → falls back to
  // the recorded live-feed folder when the API is unavailable.
  const candleLoad = await _loadIntradayCandles({ authKey, sym, date: usedDate, isToday, interval: intv });
  const candles5m = candleLoad.candles;
  const candleSource = candleLoad.source;

  // Total intraday volume (lakhs) for the VOLUME (L) header card.
  const intradayVolume = candles5m.reduce((s, c) => s + _safe(c.volume), 0);
  const volumeLakhs = intradayVolume / 100_000;

  // Net OI change % (across the ATM±N ladder) for the OI CHANGE card.
  const ladderRows = Array.isArray(v2.ladder) ? v2.ladder : [];
  let totalLadderOi = 0;
  let totalLadderOiChange = 0;
  for (const r of ladderRows) {
    totalLadderOi       += _safe(r.ce?.oi) + _safe(r.pe?.oi);
    totalLadderOiChange += _safe(r.ce?.oiChange) + _safe(r.pe?.oiChange);
  }
  const oiChangePct = totalLadderOi > 0 ? (totalLadderOiChange / totalLadderOi) * 100 : 0;
  const marketOpen = !!v2.market?.isOpen;
  const lastBar = candles5m.length ? candles5m[candles5m.length - 1] : null;
  const lastClose = _safe(lastBar?.close, spot);
  const lastOpen  = _safe(lastBar?.open,  spot);
  const recent20 = candles5m.slice(-20);
  const recentHigh = recent20.length ? Math.max(...recent20.map((c) => c.high)) : dayHigh || spot;
  const recentLow  = recent20.length ? Math.min(...recent20.map((c) => c.low))  : dayLow  || spot;

  /* ═══ HEADER STRIP ════════════════════════════════════════════════ */
  // Market bias: location vs CPR + EMA stack proxy via change%.
  const bias = (() => {
    if (Number.isFinite(cpr.tc) && spot > cpr.tc) return 'BULLISH';
    if (Number.isFinite(cpr.bc) && spot < cpr.bc) return 'BEARISH';
    return 'NEUTRAL';
  })();
  const widthClass = cpr.widthClass || 'normal';
  const cprWidthLabel = widthClass === 'narrow' ? 'NARROW'
    : widthClass === 'wide' ? 'WIDE' : 'MEDIUM';

  // Day type — narrow CPR + meaningful change → trend day; wide → range; otherwise normal.
  const absChg = Math.abs(spotChangePct);
  const dayType = (() => {
    if (widthClass === 'narrow' && absChg >= 0.5) return 'TREND DAY';
    if (widthClass === 'wide')                     return 'RANGE DAY';
    if (absChg >= 1.0)                             return 'EXPANSION DAY';
    return 'NORMAL DAY';
  })();

  /* ═══ CPR INFO + CAMARILLA LEVELS ═════════════════════════════════ */
  const cprInfo = {
    tc: _round(cpr.tc, 2),
    pivot: _round(cpr.pivot, 2),
    bc: _round(cpr.bc, 2),
    bias,
    position: spot > cpr.tc ? 'PRICE ABOVE TC'
      : spot < cpr.bc ? 'PRICE BELOW BC' : 'INSIDE CPR',
    width: cprWidthLabel,
    todayVsYesterday: yCpr ? (cpr.tc > yCpr.tc && cpr.bc > yCpr.bc ? 'HIGHER'
      : cpr.tc < yCpr.tc && cpr.bc < yCpr.bc ? 'LOWER' : 'OVERLAPPING') : '—',
  };
  const camLevels = {
    r4: { value: cam.r4, label: 'BREAKOUT' },
    r3: { value: cam.r3, label: 'SELL ZONE' },
    pivot: { value: _round(cpr.pivot, 2), label: 'CENTER' },
    s3: { value: cam.s3, label: 'BUY ZONE' },
    s4: { value: cam.s4, label: 'BREAKDOWN' },
  };

  /* ═══ ZONE + STATUS ═══════════════════════════════════════════════ */
  const zone = _classifyZone(spot, cam, cpr.tc, cpr.bc);
  let status, statusTone, strengthLabel;
  if (zone === 'ABOVE R4')        { status = 'R4 BREAKOUT';        statusTone = 'strongbull'; strengthLabel = 'EXPLOSIVE STRENGTH'; }
  else if (zone === 'ABOVE R3')   { status = 'R3 SUPPORT';          statusTone = 'bull';       strengthLabel = 'BULLISH STRENGTH'; }
  else if (zone === 'ABOVE TC')   { status = 'PRICE ABOVE TC';      statusTone = 'bull';       strengthLabel = 'BULLISH BIAS'; }
  else if (zone === 'INSIDE CPR') { status = 'INSIDE CPR';          statusTone = 'neutral';    strengthLabel = 'WAIT FOR DIRECTION'; }
  else if (zone === 'BELOW BC')   { status = 'PRICE BELOW BC';      statusTone = 'bear';       strengthLabel = 'BEARISH BIAS'; }
  else if (zone === 'BELOW S3')   { status = 'S3 BREAKDOWN';        statusTone = 'bear';       strengthLabel = 'BEARISH STRENGTH'; }
  else                            { status = 'S4 BREAKDOWN';        statusTone = 'strongbear'; strengthLabel = 'EXPLOSIVE BREAKDOWN'; }

  /* ═══ LOGIC CARDS ═════════════════════════════════════════════════ */
  const args = { spot, lvl: cam, cprTc: cpr.tc, cprBc: cpr.bc, recentHigh, recentLow, lastClose, lastOpen };
  const s3Logic = _s3SupportLogic(args);
  const r3Logic = _r3RejectionLogic(args);
  const r3BrkLogic = _r3BreakLogic(args);
  const s3BrkLogic = _s3BreakLogic(args);

  /* ═══ FINAL DECISION ══════════════════════════════════════════════ */
  // Stack signals — bullish votes vs bearish votes weighted by zone.
  let bullPts = 0, bearPts = 0;
  if (zone === 'ABOVE R4')   bullPts += 35;
  if (zone === 'ABOVE R3')   bullPts += 25;
  if (zone === 'ABOVE TC')   bullPts += 15;
  if (zone === 'BELOW S4')   bearPts += 35;
  if (zone === 'BELOW S3')   bearPts += 25;
  if (zone === 'BELOW BC')   bearPts += 15;
  if (s3Logic.fired)       bullPts += 25;
  if (r3BrkLogic.fired)    bullPts += 25;
  if (r3Logic.fired)       bearPts += 25;
  if (s3BrkLogic.fired)    bearPts += 25;
  if (cprInfo.todayVsYesterday === 'HIGHER') bullPts += 8;
  if (cprInfo.todayVsYesterday === 'LOWER')  bearPts += 8;
  if (widthClass === 'narrow') {
    if (bias === 'BULLISH') bullPts += 8;
    else if (bias === 'BEARISH') bearPts += 8;
  }
  if (lastClose > lastOpen) bullPts += 4;
  else if (lastClose < lastOpen) bearPts += 4;

  let signal, signalTone, confidence, setupLabel, trend, suggestion, invalidation, targets, riskReward;
  const rawScore = bullPts - bearPts;
  if (bullPts >= 30 && bullPts > bearPts) {
    signal = 'BUY CE'; signalTone = 'bull';
    confidence = _clamp(50 + bullPts, 50, 95);
    setupLabel = zone === 'ABOVE R4' ? 'R4 BREAKOUT'
      : r3BrkLogic.fired ? 'R3 BREAK & HOLD'
      : zone === 'ABOVE R3' ? 'R3 SUPPORT FLIP'
      : s3Logic.fired ? 'S3 SUPPORT BOUNCE'
      : 'BULLISH CONTINUATION';
    trend = 'UPTREND';
    suggestion = zone === 'ABOVE R4' ? 'BUY ON ANY DIP' : 'BUY ON PULLBACK';
    invalidation = `BELOW ${zone === 'ABOVE R4' ? `R3 (${cam.r3})` : zone === 'ABOVE R3' ? `R3 (${cam.r3})` : `S3 (${cam.s3})`}`;
    targets = zone === 'ABOVE R4'
      ? [{ name: 'R5', value: cam.r5 }, { name: 'R6', value: cam.r6 }, { name: 'PRIOR HIGH', value: cam.h * 1.005 }]
      : zone === 'ABOVE R3'
      ? [{ name: 'R4', value: cam.r4 }, { name: 'R5', value: cam.r5 }, { name: 'R6', value: cam.r6 }]
      : zone === 'ABOVE TC'
      ? [{ name: 'R3', value: cam.r3 }, { name: 'R4', value: cam.r4 }, { name: 'R5', value: cam.r5 }]
      : [{ name: 'PIVOT', value: cpr.pivot }, { name: 'TC', value: cpr.tc }, { name: 'R3', value: cam.r3 }];
    const stop = zone === 'ABOVE R4' ? cam.r3 : zone === 'ABOVE R3' ? cam.r3 : zone === 'ABOVE TC' ? cpr.bc : cam.s3;
    const tgt1 = targets[0].value;
    riskReward = stop && tgt1 && spot ? _round((tgt1 - spot) / Math.max(0.01, spot - stop), 2) : 0;
  } else if (bearPts >= 30 && bearPts > bullPts) {
    signal = 'BUY PE'; signalTone = 'bear';
    confidence = _clamp(50 + bearPts, 50, 95);
    setupLabel = zone === 'BELOW S4' ? 'S4 BREAKDOWN'
      : s3BrkLogic.fired ? 'S3 BREAK & HOLD'
      : zone === 'BELOW S3' ? 'S3 RESISTANCE FLIP'
      : r3Logic.fired ? 'R3 REJECTION'
      : 'BEARISH CONTINUATION';
    trend = 'DOWNTREND';
    suggestion = zone === 'BELOW S4' ? 'SELL ON ANY RALLY' : 'SELL ON PULLBACK';
    invalidation = `ABOVE ${zone === 'BELOW S4' ? `S3 (${cam.s3})` : zone === 'BELOW S3' ? `S3 (${cam.s3})` : `R3 (${cam.r3})`}`;
    targets = zone === 'BELOW S4'
      ? [{ name: 'S5', value: cam.s5 }, { name: 'S6', value: cam.s6 }, { name: 'PRIOR LOW', value: cam.l * 0.995 }]
      : zone === 'BELOW S3'
      ? [{ name: 'S4', value: cam.s4 }, { name: 'S5', value: cam.s5 }, { name: 'S6', value: cam.s6 }]
      : zone === 'BELOW BC'
      ? [{ name: 'S3', value: cam.s3 }, { name: 'S4', value: cam.s4 }, { name: 'S5', value: cam.s5 }]
      : [{ name: 'PIVOT', value: cpr.pivot }, { name: 'BC', value: cpr.bc }, { name: 'S3', value: cam.s3 }];
    const stop = zone === 'BELOW S4' ? cam.s3 : zone === 'BELOW S3' ? cam.s3 : zone === 'BELOW BC' ? cpr.tc : cam.r3;
    const tgt1 = targets[0].value;
    riskReward = stop && tgt1 && spot ? _round((spot - tgt1) / Math.max(0.01, stop - spot), 2) : 0;
  } else {
    signal = 'WAIT'; signalTone = 'neutral';
    confidence = _clamp(30 + Math.abs(rawScore), 30, 60);
    setupLabel = 'INSIDE CPR · WAIT';
    trend = 'RANGE';
    suggestion = 'WAIT FOR S3/R3 EVENT';
    invalidation = `Break ${cam.s3} OR ${cam.r3}`;
    targets = [
      { name: 'TC',    value: cpr.tc },
      { name: 'BC',    value: cpr.bc },
      { name: 'PIVOT', value: cpr.pivot },
    ];
    riskReward = 0;
  }

  /* ═══ MARKET STRENGTH METER ═══════════════════════════════════════ */
  // Express bull vs bear pts as 0..100 buyer / seller share.
  const totalPts = bullPts + bearPts || 1;
  const buyersPct  = Math.round((bullPts / totalPts) * 100);
  const sellersPct = 100 - buyersPct;
  const marketControl = buyersPct >= 60 ? 'BUYERS'
    : sellersPct >= 60 ? 'SELLERS'
    : 'BALANCED';

  /* ═══ TREND CONTEXT ROWS ══════════════════════════════════════════ */
  const tcCmp = (label, lvl, allowAbove = true) => {
    const above = spot > lvl;
    return {
      label,
      value: lvl,
      relation: above ? 'ABOVE' : 'BELOW',
      tone: above === allowAbove ? 'bull' : 'bear',
    };
  };
  const trendContext = [
    tcCmp('Price vs CPR (TC)', cpr.tc),
    tcCmp('Price vs Pivot',     cpr.pivot),
    tcCmp('Price vs BC',        cpr.bc),
    tcCmp('Price vs S3',        cam.s3),
    tcCmp('Price vs R3',        cam.r3),
    tcCmp('Price vs R4',        cam.r4),
    tcCmp('Price vs S4',        cam.s4, false),
  ];

  /* ═══ PRICE FLOW MAP — institutional ladder of the active flow ════ */
  const flowMap = (() => {
    if (signal === 'BUY CE') {
      if (zone === 'ABOVE R4') {
        return ['R3', 'R4', 'R5', 'R6'].map((k) => ({ name: k, value: cam[k.toLowerCase()] }));
      }
      if (zone === 'ABOVE R3') {
        return [
          { name: 'PIVOT', value: cpr.pivot }, { name: 'TC', value: cpr.tc },
          { name: 'R3', value: cam.r3 }, { name: 'R4', value: cam.r4 },
        ];
      }
      return [
        { name: 'S3 (SUPPORT)', value: cam.s3 },
        { name: 'PIVOT',        value: cpr.pivot },
        { name: 'TC',           value: cpr.tc },
        { name: 'R3 (RESISTANCE)', value: cam.r3 },
        { name: 'R4 (BREAKOUT)', value: cam.r4 },
      ];
    }
    if (signal === 'BUY PE') {
      if (zone === 'BELOW S4') {
        return ['S3', 'S4', 'S5', 'S6'].map((k) => ({ name: k, value: cam[k.toLowerCase()] }));
      }
      if (zone === 'BELOW S3') {
        return [
          { name: 'PIVOT', value: cpr.pivot }, { name: 'BC', value: cpr.bc },
          { name: 'S3', value: cam.s3 }, { name: 'S4', value: cam.s4 },
        ];
      }
      return [
        { name: 'R3 (RESISTANCE)', value: cam.r3 },
        { name: 'PIVOT',           value: cpr.pivot },
        { name: 'BC',              value: cpr.bc },
        { name: 'S3 (SUPPORT)',    value: cam.s3 },
        { name: 'S4 (BREAKDOWN)',  value: cam.s4 },
      ];
    }
    return [
      { name: 'BC',     value: cpr.bc },
      { name: 'PIVOT',  value: cpr.pivot },
      { name: 'TC',     value: cpr.tc },
      { name: 'R3',     value: cam.r3 },
      { name: 'S3',     value: cam.s3 },
    ];
  })();
  const flowIdeal = signal === 'BUY CE' ? 'S3 → PIVOT → TC → R3 → R4'
    : signal === 'BUY PE' ? 'R3 → PIVOT → BC → S3 → S4'
    : 'BC → PIVOT → TC';

  /* ═══ QUICK SUMMARY (right footer of the reference image) ═════════ */
  const quickSummary = [
    { ok: bias === 'BULLISH',                                             label: 'CPR BIAS BULLISH' },
    { ok: bias === 'BEARISH',                                             label: 'CPR BIAS BEARISH' },
    { ok: spot > cpr.tc && spot > cam.r3,                                  label: 'PRICE ABOVE TC AND R3' },
    { ok: spot < cpr.bc && spot < cam.s3,                                  label: 'PRICE BELOW BC AND S3' },
    { ok: r3BrkLogic.fired,                                                label: 'R3 BROKEN AND HOLDING' },
    { ok: s3BrkLogic.fired,                                                label: 'S3 BROKEN AND HOLDING' },
    { ok: signal === 'BUY CE',                                             label: 'TREND CONTINUATION LIKELY (BULL)' },
    { ok: signal === 'BUY PE',                                             label: 'TREND CONTINUATION LIKELY (BEAR)' },
  ].filter((s) => s.ok);
  // If empty (waiting), surface neutral notes.
  if (!quickSummary.length) {
    quickSummary.push({ ok: true, label: 'INSIDE CPR — NO ACTIVE BIAS' });
    quickSummary.push({ ok: true, label: `WAIT FOR ${cam.r3} OR ${cam.s3} EVENT` });
  }

  /* ═══ Recent 5m candles for the chart ═════════════════════════════ */
  const chartCandles = candles5m.slice(-300).map((c) => ({
    time: _safe(c.timestamp),
    open: _round(c.open, 2),
    high: _round(c.high, 2),
    low:  _round(c.low,  2),
    close: _round(c.close, 2),
    volume: _safe(c.volume),
  }));

  /* ═══ Push history (for future "near level" hold detection) ──────── */
  const trail = _levelHistory.get(SYMBOL) || [];
  trail.push({ t: Date.now(), spot });
  while (trail.length && (Date.now() - trail[0].t) > HISTORY_TTL_MS) trail.shift();
  while (trail.length > HISTORY_MAX) trail.shift();
  _levelHistory.set(SYMBOL, trail);

  /* ═══ MARKET STATS HEADER (LTP / HIGH / LOW / CHANGE / VOL / OI / VWAP) ═ */
  const vwap = _safe(v2.spot?.vwap);
  const marketStats = {
    ltp:        _round(spot, 2),
    ltpChange:  _round(spotChange, 2),
    ltpChangePct: _round(spotChangePct, 2),
    dayHigh:    _round(dayHigh, 2),
    dayLow:     _round(dayLow, 2),
    change:     _round(spotChange, 2),
    changePct:  _round(spotChangePct, 2),
    volumeLakhs: _round(volumeLakhs, 2),
    oiChangePct: _round(oiChangePct, 2),
    vwap:       _round(vwap, 2),
    marketOpen,
    marketLabel: marketOpen ? 'MARKET OPEN' : 'MARKET CLOSED',
  };

  /* ═══ DAY TYPE GUIDE (small reference table from the image) ═══════ */
  const dayTypeGuide = [
    { key: 'NARROW CPR', tone: 'bull', headline: 'Trend / Expansion', desc: 'Focus on R4 / S4 breaks',
      active: widthClass === 'narrow' },
    { key: 'WIDE CPR',   tone: 'bear', headline: 'Range / Rotation', desc: 'Focus on R3 / S3 rejections',
      active: widthClass === 'wide' },
  ];

  /* ═══ KEY LEVELS SUMMARY (CPR levels + Camarilla on the same card) ══ */
  const keyLevelsSummary = {
    cpr: [
      { name: 'TC (Top Central)',     value: _round(cpr.tc, 2),    tone: 'bull' },
      { name: 'PIVOT',                value: _round(cpr.pivot, 2), tone: 'neutral' },
      { name: 'BC (Bottom Central)',  value: _round(cpr.bc, 2),    tone: 'bear' },
    ],
    cam: [
      { name: 'R3', value: cam.r3, tone: 'bear' },
      { name: 'R4', value: cam.r4, tone: 'bear' },
      { name: 'S3', value: cam.s3, tone: 'bull' },
      { name: 'S4', value: cam.s4, tone: 'bull' },
    ],
  };

  /* ═══ SCENARIO GUIDE (6 lookup rows from the image) ═══════════════ */
  const aboveR3 = spot > cam.r3;
  const aboveR4 = spot > cam.r4;
  const belowS3 = spot < cam.s3;
  const belowS4 = spot < cam.s4;
  const aboveTc = Number.isFinite(cpr.tc) && spot > cpr.tc;
  const belowBc = Number.isFinite(cpr.bc) && spot < cpr.bc;
  const scenarioGuide = [
    { id: 1, icon: '⬈', cond: 'Above TC & Above R3',  result: 'Bullish Continuation', action: 'CE BUY',     tone: 'bull',
      active: aboveTc && aboveR3 && !aboveR4 },
    { id: 2, icon: '⬈', cond: 'Above TC & Above R4',  result: 'Trend Acceleration',   action: 'CE HOLD',    tone: 'bull',
      active: aboveTc && aboveR4 },
    { id: 3, icon: '⬊', cond: 'Below BC & Below S3',  result: 'Bearish Continuation', action: 'PE BUY',     tone: 'bear',
      active: belowBc && belowS3 && !belowS4 },
    { id: 4, icon: '⬊', cond: 'Below BC & Below S4',  result: 'Trend Acceleration',   action: 'PE HOLD',    tone: 'bear',
      active: belowBc && belowS4 },
    { id: 5, icon: '↻', cond: 'S3 → R3 Reversal',      result: 'Reversal Up',          action: 'CE SCALP',   tone: 'bull',
      active: !aboveR3 && !belowS3 && lastClose > lastOpen },
    { id: 6, icon: '↻', cond: 'R3 → S3 Reversal',      result: 'Reversal Down',        action: 'PE SCALP',   tone: 'bear',
      active: !aboveR3 && !belowS3 && lastClose < lastOpen },
  ];

  /* ═══ TRADE SETUP (Buyer Logic) ═══════════════════════════════════ */
  const tradeSetup = (() => {
    if (signal === 'BUY CE') {
      return {
        setup: aboveR4 ? 'ABOVE TC + ABOVE R4'
          : aboveR3 ? 'ABOVE TC + ABOVE R3'
          : 'ABOVE TC',
        action: setupLabel.includes('R4') ? 'CE HOLD' : 'CE BUY',
        target: aboveR4 ? 'R5 / R6' : 'R4 / R5',
        stoploss: aboveR4 ? 'BELOW R4' : aboveR3 ? 'BELOW R3' : 'BELOW TC',
        tone: 'bull',
      };
    }
    if (signal === 'BUY PE') {
      return {
        setup: belowS4 ? 'BELOW BC + BELOW S4'
          : belowS3 ? 'BELOW BC + BELOW S3'
          : 'BELOW BC',
        action: setupLabel.includes('S4') ? 'PE HOLD' : 'PE BUY',
        target: belowS4 ? 'S5 / S6' : 'S4 / S5',
        stoploss: belowS4 ? 'ABOVE S4' : belowS3 ? 'ABOVE S3' : 'ABOVE BC',
        tone: 'bear',
      };
    }
    return {
      setup: 'INSIDE CPR · NO EDGE',
      action: 'WAIT',
      target: 'TC / BC',
      stoploss: 'BREAK PIVOT',
      tone: 'neutral',
    };
  })();

  /* ═══ CONFLUENCE CHECK (5-point checklist + score) ═════════════════ */
  const confluenceItems = [
    {
      label: signal === 'BUY PE' ? 'PRICE BELOW BC' : 'PRICE ABOVE TC',
      ok: signal === 'BUY PE' ? belowBc : aboveTc,
    },
    {
      label: signal === 'BUY PE' ? 'PRICE BELOW S3' : 'PRICE ABOVE R3',
      ok: signal === 'BUY PE' ? belowS3 : aboveR3,
    },
    {
      label: signal === 'BUY PE' ? 'OI BUILD-UP (SHORT)' : 'OI BUILD-UP (LONG)',
      ok: oiChangePct >= 1,
    },
    {
      label: signal === 'BUY PE' ? 'VWAP BELOW PRICE' : 'VWAP ABOVE PRICE',
      ok: signal === 'BUY PE' ? vwap > spot : vwap > 0 && spot > vwap,
    },
    {
      label: signal === 'BUY PE' ? 'FRVP REJECTION ABOVE' : 'FRVP ACCEPTANCE ABOVE',
      ok: bullPts >= 30 || bearPts >= 30,
    },
  ];
  const confluenceScore = confluenceItems.filter((i) => i.ok).length;
  const confluenceTotal = confluenceItems.length;
  const confluenceLabel = confluenceScore >= 5 ? 'STRONG SETUP'
    : confluenceScore >= 4 ? 'GOOD SETUP'
    : confluenceScore >= 3 ? 'MODERATE SETUP'
    : 'WEAK / NO TRADE';
  const confluenceCheck = {
    items: confluenceItems,
    score: confluenceScore,
    total: confluenceTotal,
    label: confluenceLabel,
    tone: confluenceScore >= 4 ? 'bull' : confluenceScore >= 3 ? 'neutral' : 'bear',
  };

  return {
    ok: true,
    version: 'cpr-cam-v1',
    symbol: SYMBOL,
    displayName: sym.displayName,
    date: usedDate,
    isToday,
    at: Date.now(),
    source: isToday ? 'live' : 'folder',
    candleSource,
    interval: intv,

    spot: _round(spot, 2),
    spotChange: _round(spotChange, 2),
    spotChangePct: _round(spotChangePct, 2),
    dayHigh: _round(dayHigh, 2),
    dayLow:  _round(dayLow, 2),
    priorClose: _round(priorClose, 2),

    header: {
      bias,
      dayType,
      cprWidth: cprWidthLabel,
      signal,
      signalTone,
    },

    cprInfo,
    camLevels,
    cam,
    cpr: {
      tc: _round(cpr.tc, 2),
      bc: _round(cpr.bc, 2),
      pivot: _round(cpr.pivot, 2),
      r1: _round(cpr.r1, 2), r2: _round(cpr.r2, 2),
      s1: _round(cpr.s1, 2), s2: _round(cpr.s2, 2),
      width: _round(cpr.width, 2),
      widthPct: _round(cpr.widthPct, 3),
      widthClass: cpr.widthClass,
    },
    yesterday: yCpr ? {
      tc: _round(yCpr.tc, 2),
      bc: _round(yCpr.bc, 2),
      pivot: _round(yCpr.pivot, 2),
    } : null,

    zone,
    status,
    statusTone,
    strengthLabel,

    signalPanel: {
      signal,
      signalTone,
      setupLabel,
      trend,
      confidence,
      suggestion,
      invalidation,
      targets,
      riskReward,
    },

    marketStrength: {
      buyersPct,
      sellersPct,
      marketControl,
    },

    logicCards: [s3Logic, r3Logic, r3BrkLogic, s3BrkLogic],

    flowMap,
    flowIdeal,
    trendContext,
    quickSummary,
    chartCandles,

    marketStats,
    dayTypeGuide,
    keyLevelsSummary,
    scenarioGuide,
    tradeSetup,
    confluenceCheck,

    desc: signal === 'BUY CE' ? 'Bulls in control — ride the trend.'
      : signal === 'BUY PE' ? 'Bears in control — ride the breakdown.'
      : 'Inside CPR — wait for an S3 hold or R3 event.',
  };
}

module.exports = { getCprCam, _camarillaFromOHLC };
