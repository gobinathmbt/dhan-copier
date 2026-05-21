/**
 * Live Feed Integrity Service
 * ===========================
 * Periodic guardian that:
 *   1. Dedupes candle JSONL files (in-place, by timestamp normalised to seconds)
 *   2. Backfills MISSING candles from the Dhan production API (spot via
 *      dhanProd.getDhanProdData, futures via niftyFuturesProd.getIntradayCandles)
 *      whenever the live WebSocket feed is unavailable or has dropped bars
 *   3. Detects 1m gaps and reports them
 *   4. Synthesises missing 5m/15m/30m candles from 1m as a final safety net
 *      when the aggregator misses a window (server restart, network blip)
 *
 * Runs every 60s while a scalping session is live, and once on session
 * start for the current trading day. Also runs at server boot regardless
 * of whether a session is active so duplicates from previous server runs
 * are cleaned up immediately.
 *
 * Designed to be safe to re-run any number of times — all operations are
 * idempotent (dedupe by timestamp, append-only, atomic write-rename).
 *
 * 2026-05-19: extended with API backfill so missing data is recovered
 * from the Dhan production endpoints when the live feed is offline.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const symbolRegistry = require('../config/symbolRegistry');

const ROOT_DIR = path.resolve(__dirname, '../../live-feed');
// Active underlying — driven by `settings.tradingSymbols[0]`. Falls back
// to NIFTY_50 when no session has been started yet (server boot sweep).
function _underlying() { return symbolRegistry.getActiveSymbol(); }

// Trading session window in IST minutes-since-midnight
const SESSION_OPEN_MIN  = 9 * 60 + 15;   // 09:15
const SESSION_CLOSE_MIN = 15 * 60 + 30;  // 15:30

const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800 };
// Mapping TF → Dhan production API interval string
const TF_API_INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '30m': '30' };

// Resolve spot API params for the ACTIVE symbol — all index spots use IDX_I in Dhan.
function _spotApiParamsForSymbol(symbolKey) {
  const sym = symbolRegistry.getSymbol(symbolKey);
  return {
    securityId: sym?.indexSecurityId || 13,
    exchange: 'IDX',
    segment: 'I',
    instrument: 'IDX',
  };
}

// Throttle backfill — don't hammer the API. Per-key cooldown (per symbol).
// 2026-05-21: Tuned down from 30s → 5s to support the new 5s sweeper
// cadence. The Dhan production API tolerates this for charts/intraday
// (≤5 calls/symbol/sec). For futures we keep a longer cooldown so we
// don't hit the futures-specific rate limits.
const _backfillLastAt = new Map();        // key: `${symbol}-${base}-${tf}` -> ms timestamp
const BACKFILL_COOLDOWN_SPOT_MS    = 5_000;
const BACKFILL_COOLDOWN_FUTURES_MS = 30_000;

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

/** Return { open, close } in unix seconds for the IST session window of `dateStr`. */
function _sessionWindowSec(dateStr) {
  const open = new Date(`${dateStr}T09:15:00+05:30`).getTime();
  const close = new Date(`${dateStr}T15:30:00+05:30`).getTime();
  return { open: Math.floor(open / 1000), close: Math.floor(close / 1000) };
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
  try {
    fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    // Windows: rename fails with EPERM/EBUSY when the target file is open
    // by another process (e.g. feedRecorder's append stream during a live
    // session). Clean up the .tmp and signal a skip — the recorder writes
    // append-only and dedupes on stream open, so an in-session dedup miss
    // is harmless.
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
      return { ok: false, reason: 'file-locked', code: e.code };
    }
    return { ok: false, reason: e.message, code: e.code };
  }
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
  const wr = _writeJsonlAtomic(file, out);
  if (!wr.ok) {
    // File is locked by the live recorder — skip this dedup pass; the
    // recorder dedupes in-memory anyway, so duplicates aren't a live risk.
    return { kept: out.length, dropped: 0, skipped: wr.reason };
  }
  return { kept: out.length, dropped: rows.length - out.length };
}

/**
 * Backfill MISSING candles from the Dhan production API.
 *
 * Strategy:
 *   • Build today's expected session window [open, end-of-now].
 *   • Read existing rows.
 *   • Skip API call if file is already fresh (latest bar within tfSec * 2 of
 *     "now" and we have ≥ 95% of expected bars).
 *   • Fetch the entire window from the API (one call covers all gaps).
 *   • Merge into the existing file, dedupe by timestamp, atomic write.
 *
 * Per-file cooldown of 30s prevents accidental API thrashing.
 *
 * @param {string} folder  full path to the date folder
 * @param {string} base    'candles' (spot) or 'futures'
 * @param {string} tf      '1m'|'5m'|'15m'|'30m'
 * @param {string} dateStr YYYY-MM-DD of the folder
 * @returns {Promise<{fetched:number, error?:string, skipped?:string}>}
 */
async function backfillFromApi(folder, base, tf, dateStr, symbolKey) {
  const tfSec = TF_SECONDS[tf];
  const interval = TF_API_INTERVAL[tf];
  if (!tfSec || !interval) return { fetched: 0, skipped: 'unsupported-tf' };
  if (!symbolKey) symbolKey = _underlying();

  const cooldownKey = `${symbolKey}-${base}-${tf}`;
  const last = _backfillLastAt.get(cooldownKey) || 0;
  const cooldownMs = base === 'futures' ? BACKFILL_COOLDOWN_FUTURES_MS : BACKFILL_COOLDOWN_SPOT_MS;
  if (Date.now() - last < cooldownMs) {
    return { fetched: 0, skipped: 'cooldown' };
  }

  const file = path.join(folder, `${base}-${tf}.jsonl`);
  const existing = _readJsonl(file);
  const have = new Set(existing.map(r => _toSec(r.t)).filter(t => t !== null));

  const { open, close } = _sessionWindowSec(dateStr);
  const nowSec = Math.floor(Date.now() / 1000);
  // Avoid fetching the still-forming current bar — back off by one tfSec.
  const endSec = Math.min(nowSec - tfSec, close);
  if (endSec <= open) return { fetched: 0, skipped: 'before-open' };

  // Skip API if file is already fresh and reasonably complete.
  const expectedCount = Math.max(1, Math.floor((endSec - open) / tfSec));
  const latestHave = existing.length
    ? Math.max(...existing.map(r => _toSec(r.t) || 0))
    : 0;
  const fresh = latestHave > 0 && latestHave >= endSec - tfSec;
  if (existing.length >= expectedCount * 0.97 && fresh) {
    return { fetched: 0, skipped: 'fresh' };
  }

  // Lazy-load API clients to avoid circular requires at boot.
  let res = null;
  try {
    if (base === 'candles') {
      const dhanProd = require('./dhanProd.service');
      res = await dhanProd.getDhanProdData(null, {
        ..._spotApiParamsForSymbol(symbolKey),
        interval,
        startTime: open,
        endTime: endSec,
      });
    } else if (base === 'futures') {
      // Futures intraday only resolves for symbols with a registered
      // futures contract (currently NIFTY only on NSE_FNO). For SENSEX
      // this returns ok:false and we skip.
      const niftyFuturesProd = require('./niftyFuturesProd.service');
      res = await niftyFuturesProd.getIntradayCandles({
        interval,
        startTime: open,
        endTime: endSec,
      });
    } else {
      return { fetched: 0, skipped: 'unknown-base' };
    }
  } catch (e) {
    _backfillLastAt.set(cooldownKey, Date.now());
    return { fetched: 0, error: e.message };
  }
  _backfillLastAt.set(cooldownKey, Date.now());

  if (!res || !res.ok) {
    return { fetched: 0, error: res?.error || 'api-failed' };
  }
  const apiCandles = res.data?.candles || [];
  if (!apiCandles.length) {
    return { fetched: 0, skipped: 'api-empty' };
  }

  const newRows = [];
  for (const c of apiCandles) {
    const t = _toSec(c.time);
    if (t === null) continue;
    if (have.has(t)) continue;
    if (t < open || t > endSec) continue;
    newRows.push({
      t,
      o: Number(c.open),
      h: Number(c.high),
      l: Number(c.low),
      c: Number(c.close),
      v: Number(c.volume || 0),
    });
    have.add(t);
  }
  if (!newRows.length) return { fetched: 0, skipped: 'all-have' };

  // Merge + dedupe by t, sorted ascending
  const merged = [...existing, ...newRows]
    .map(r => ({ ...r, t: _toSec(r.t) }))
    .filter(r => r.t !== null);
  merged.sort((a, b) => a.t - b.t);
  const seen = new Set();
  const dedup = [];
  for (const r of merged) {
    if (seen.has(r.t)) continue;
    seen.add(r.t);
    dedup.push(r);
  }
  const wr = _writeJsonlAtomic(file, dedup);
  if (!wr.ok) {
    // File locked by the live recorder — skip backfill write this cycle.
    // Will retry in 30s after the cooldown.
    return { fetched: 0, skipped: wr.reason };
  }
  return { fetched: newRows.length, total: dedup.length };
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
      // Append-only — avoids the rename collision with feedRecorder's
      // open append stream on Windows. The recorder also reads its own
      // dedup set on stream open and skips already-written timestamps,
      // so a future recorder write at the same bucket will dedup, not
      // duplicate. _toSec normalisation is applied so on-disk format
      // stays consistent (seconds, no ms).
      try {
        const lines = newRows
          .map(r => ({ ...r, t: _toSec(r.t) }))
          .filter(r => r.t !== null)
          .map(r => JSON.stringify({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v || 0 }))
          .join('\n') + '\n';
        fs.appendFileSync(fileTf, lines, 'utf8');
        synthesised[tf] = newRows.length;
      } catch (e) {
        synthesised[`${tf}_skipped`] = e.code || e.message;
      }
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
 * Run a single integrity sweep for today's folder, for ALL enabled symbols.
 * Each enabled symbol gets its own folder swept independently. The active
 * symbol in symbolRegistry is briefly switched per iteration so any
 * downstream services that read it (e.g. niftyFuturesProd for futures
 * scrip-master resolution) align with the symbol being swept.
 */
async function sweepToday() {
  const dateStr = _todayIstYYYYMMDD();
  const symbols = (() => {
    try {
      const list = symbolRegistry.getActiveSymbols();
      return list && list.length ? list : [_underlying()];
    } catch (_) {
      return [_underlying()];
    }
  })();

  const result = { dateStr, perSymbol: {} };
  // Save original active so we can restore it after iterating.
  const original = _underlying();

  for (const symKey of symbols) {
    const folder = path.join(ROOT_DIR, `${dateStr}_${symKey}`);
    if (!fs.existsSync(folder)) {
      result.perSymbol[symKey] = { skipped: true, reason: 'folder missing' };
      continue;
    }
    const symResult = { folder, dedupe: {}, backfill: {}, synth: {}, gaps: {} };

    // 1) Dedupe all candle / futures files
    for (const base of ['candles', 'futures']) {
      for (const tf of ['1m', '5m', '15m', '30m']) {
        const f = path.join(folder, `${base}-${tf}.jsonl`);
        if (!fs.existsSync(f)) continue;
        const r = dedupeFile(f);
        if (r.dropped > 0) symResult.dedupe[`${base}-${tf}`] = r;
      }
    }

    // 2) API backfill — point the registry at this symbol so getIntradayCandles
    //    resolves the right index/futures contract for the API call.
    if (_istMinutesNow() >= SESSION_OPEN_MIN) {
      try { symbolRegistry.setActiveSymbols({ tradingSymbols: [symKey] }); } catch (_) {}
      for (const base of ['candles', 'futures']) {
        // SENSEX has no NSE futures contract — skip futures backfill for now
        if (base === 'futures' && symKey !== 'NIFTY_50') continue;
        for (const tf of ['1m', '5m', '15m', '30m']) {
          try {
            const r = await backfillFromApi(folder, base, tf, dateStr, symKey);
            if (r.fetched > 0) symResult.backfill[`${base}-${tf}`] = r;
          } catch (e) {
            logger.debug({ err: e.message, base, tf, symKey }, '[liveFeedIntegrity] backfill threw');
          }
        }
      }
    }

    // 3) Synth missing higher-TF candles from 1m (final safety net)
    for (const base of ['candles', 'futures']) {
      const r = synthesizeFromOneMinute(folder, base);
      if (Object.keys(r.synthesised).length) symResult.synth[base] = r.synthesised;
    }

    // 4) Detect 1m gaps (informational)
    for (const base of ['candles', 'futures']) {
      const r = detectGaps(folder, base);
      if (r.gaps > 0) symResult.gaps[base] = r;
    }

    result.perSymbol[symKey] = symResult;
  }

  // Restore original active symbol so the next prediction cycle finds it.
  try { symbolRegistry.setActiveSymbols({ tradingSymbols: [original] }); } catch (_) {}

  return result;
}

let _timer = null;
let _running = false;

async function _runOnce(label) {
  if (_running) return;
  _running = true;
  try {
    const r = await sweepToday();
    if (r.skipped) {
      logger.info({ r }, `[liveFeedIntegrity] ${label} sweep skipped`);
      return;
    }
    // Log a summary that surfaces which symbols had work
    const summary = {};
    for (const [sym, sr] of Object.entries(r.perSymbol || {})) {
      const work = (Object.keys(sr.dedupe || {}).length)
        || (Object.keys(sr.backfill || {}).length)
        || (Object.keys(sr.synth || {}).length)
        || (Object.keys(sr.gaps || {}).length);
      if (work || label === 'initial') {
        summary[sym] = {
          dedupe: sr.dedupe, backfill: sr.backfill, synth: sr.synth, gaps: sr.gaps,
        };
      }
    }
    if (Object.keys(summary).length) {
      logger.info(summary, `[liveFeedIntegrity] ${label} sweep`);
    }
  } catch (e) {
    logger.warn({ err: e.message }, `[liveFeedIntegrity] ${label} sweep failed`);
  } finally {
    _running = false;
  }
}

function start({ intervalMs = 5_000 } = {}) {
  if (_timer) return;
  // Run once immediately (don't block the caller — fire-and-forget)
  _runOnce('initial').catch(() => {});
  // Periodic — every 5s during market hours so missing candles are
  // filled within seconds, not a minute. The per-file cooldown
  // (BACKFILL_COOLDOWN_MS) prevents API hammering even at 5s cadence.
  _timer = setInterval(() => {
    if (!_isMarketHours()) return;     // only run during market hours
    _runOnce('periodic').catch(() => {});
  }, intervalMs);
  _timer.unref?.();
  logger.info({ intervalMs }, '[liveFeedIntegrity] started');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start, stop, sweepToday,
  // exposed for tests / scripts / manual one-shot use
  dedupeFile, synthesizeFromOneMinute, detectGaps, backfillFromApi,
};
