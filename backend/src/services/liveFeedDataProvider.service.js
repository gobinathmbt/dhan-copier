/**
 * Live Feed Data Provider Service
 * ================================
 * Provides candle data from live-feed folder instead of making Dhan API calls.
 * This eliminates rate limit errors (429) and improves performance.
 * 
 * Data Sources (in priority order):
 * 1. Live WebSocket feed (real-time ticks via dhanLiveFeedProd)
 * 2. Live-feed folder (recorded candles from today's session)
 * 3. Dhan API (fallback for historical data or when live feed unavailable)
 * 
 * Benefits:
 * - No rate limit errors
 * - Faster data access (local file reads vs API calls)
 * - Consistent data (same source for all algorithms)
 * - Reduced API costs
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { instance: liveFeed } = require('./dhanLiveFeedProd.service');
const dhanProd = require('./dhanProd.service');

const LIVE_FEED_DIR = path.join(__dirname, '../../live-feed');
const NIFTY_SECURITY_ID = 13;
const NIFTY_SEGMENT = 'IDX_I';

/**
 * Get today's date in YYYY-MM-DD format (IST timezone)
 */
function getTodayIST() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Read candles from live-feed folder
 * @param {string} date - YYYY-MM-DD
 * @param {string} interval - '1m', '5m', '15m'
 * @param {string} type - 'candles' or 'futures'
 * @returns {Array} Array of candle objects
 */
function readCandlesFromFile(date, interval, type = 'candles') {
  try {
    const folder = path.join(LIVE_FEED_DIR, `${date}_NIFTY_50`);
    const file = path.join(folder, `${type}-${interval}.jsonl`);
    
    if (!fs.existsSync(file)) {
      return [];
    }
    
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    
    const candles = lines.map(line => {
      try {
        const c = JSON.parse(line);
        return {
          time: c.t,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v || 0,
          oi: c.oi || 0,
        };
      } catch (e) {
        return null;
      }
    }).filter(c => c !== null);
    
    return candles;
  } catch (err) {
    logger.warn({ err: err.message, date, interval, type }, '[liveFeedDataProvider] Failed to read candles from file');
    return [];
  }
}

/**
 * Get candles with smart fallback:
 * 1. Try live-feed folder (today's data)
 * 2. Fall back to Dhan API (historical or if file not available)
 * 
 * @param {string} authKey - Dhan auth key
 * @param {object} params - { securityId, exchange, segment, instrument, interval, startTime, endTime }
 * @returns {Promise<{ok: boolean, data: {candles: Array}}>}
 */
async function getCandles(authKey, params) {
  const {
    securityId,
    exchange,
    segment,
    instrument,
    interval,
    startTime,
    endTime,
  } = params;
  
  // Only optimize for NIFTY 50 spot data (most frequently accessed)
  const isNiftySpot = securityId === NIFTY_SECURITY_ID || securityId === '13';
  const today = getTodayIST();
  
  // Check if request is for today's data
  const startDate = new Date(startTime * 1000);
  const endDate = new Date(endTime * 1000);
  const todayDate = new Date();
  const isToday = startDate.toDateString() === todayDate.toDateString();
  
  // Strategy 1: Use live-feed folder for today's NIFTY data
  if (isNiftySpot && isToday) {
    // Map Dhan API interval string → live-feed folder filename suffix.
    // Both '25' and '30' map to '30m' (different parts of the codebase use
    // different conventions; we accept both).
    const intervalMap = { '1': '1m', '5': '5m', '15': '15m', '25': '30m', '30': '30m' };
    const intervalStr = intervalMap[interval] || `${interval}m`;
    
    const candles = readCandlesFromFile(today, intervalStr, 'candles');
    
    if (candles.length > 0) {
      // Filter by time range
      const filtered = candles.filter(c => 
        c.time >= startTime && c.time <= endTime
      );
      
      if (filtered.length > 0) {
        logger.debug({
          source: 'live-feed-folder',
          interval: intervalStr,
          candleCount: filtered.length,
          startTime,
          endTime,
        }, '[liveFeedDataProvider] Served candles from live-feed folder');
        
        return {
          ok: true,
          data: {
            candles: filtered,
            source: 'live-feed-folder',
          },
        };
      }
    }
  }
  
  // Strategy 2: Use WebSocket snapshot for very recent data (last tick)
  if (isNiftySpot && isToday) {
    const tick = liveFeed.getTick(NIFTY_SEGMENT, NIFTY_SECURITY_ID);
    if (tick && tick.ltp) {
      // If we have a recent tick (within last 5 seconds), we can construct a partial candle
      const tickAge = Date.now() - (tick.updatedAt || 0);
      if (tickAge < 5000) {
        logger.debug({
          source: 'websocket-tick',
          ltp: tick.ltp,
          tickAge,
        }, '[liveFeedDataProvider] Using WebSocket tick for latest data');
        
        // Note: This is a partial candle, algorithms should handle it appropriately
        // We'll still fall through to API for complete candles
      }
    }
  }
  
  // Strategy 3: Fall back to Dhan API
  logger.debug({
    source: 'dhan-api-fallback',
    securityId,
    interval,
    reason: isNiftySpot ? 'no-local-data' : 'not-nifty-spot',
  }, '[liveFeedDataProvider] Falling back to Dhan API');
  
  return await dhanProd.getDhanBypassData(authKey, params);
}

/**
 * Get NIFTY futures candles from live-feed folder
 * @param {string} authKey - Dhan auth key
 * @param {string} interval - '1', '5', '15'
 * @param {number} minutesBack - How many minutes of data to fetch
 * @returns {Promise<{ok: boolean, data: {candles: Array}}>}
 */
async function getFuturesCandles(authKey, interval, minutesBack = 60) {
  const today = getTodayIST();
  const intervalMap = { '1': '1m', '5': '5m', '15': '15m', '25': '30m', '30': '30m' };
  const intervalStr = intervalMap[interval] || `${interval}m`;
  
  const candles = readCandlesFromFile(today, intervalStr, 'futures');
  
  if (candles.length > 0) {
    // Filter to last N minutes
    const cutoffTime = Math.floor(Date.now() / 1000) - (minutesBack * 60);
    const filtered = candles.filter(c => c.time >= cutoffTime);
    
    if (filtered.length > 0) {
      logger.debug({
        source: 'live-feed-folder',
        interval: intervalStr,
        candleCount: filtered.length,
        minutesBack,
      }, '[liveFeedDataProvider] Served futures candles from live-feed folder');
      
      return {
        ok: true,
        data: {
          candles: filtered,
          source: 'live-feed-folder',
        },
      };
    }
  }
  
  // Fall back to API (will likely fail with 401, but try anyway).
  // Best-effort — return ok:false so callers can continue gracefully.
  logger.debug({
    source: 'api-fallback',
    interval: intervalStr,
  }, '[liveFeedDataProvider] No futures candles in live-feed, falling back to API');

  try {
    const niftyFutures = require('./niftyFuturesProd.service');
    const now = Math.floor(Date.now() / 1000);
    const startTime = now - (minutesBack * 60);
    return await niftyFutures.getIntradayCandles({
      interval,
      startTime,
      endTime: now,
    });
  } catch (e) {
    logger.warn({ err: e.message, interval },
      '[liveFeedDataProvider] Futures API fallback failed');
    return { ok: false, error: e.message, data: { candles: [] } };
  }
}

// ────────────────────────────────────────────────────────────────────────
// OPTION CHAIN — folder fallback
// ────────────────────────────────────────────────────────────────────────
//
// The feedRecorder writes one option-chain snapshot per minute to
//   live-feed/<date>_NIFTY_50/option-chain.jsonl
// Each line is JSON: { t, spot, atm, expiry, strikes: [{strike,ce,pe},...] }
//
// The compact `ce` / `pe` shape used in the file is:
//   { ltp, oi, oiChg, vol, iv, delta, theta, gamma, vega, bid, ask, buildup }
//
// The aggregator / hybrid engine expect the API shape:
//   { call: { ltp, oi, oiChange, volume, iv, bid, ask, greeks: {delta,...} },
//     put:  { ltp, oi, oiChange, volume, iv, bid, ask, greeks: {delta,...} } }
//
// `_apiShapeFromRecorded` rehydrates the API-style row from a recorder row.

function _apiShapeFromRecorded(row) {
  const c = row.ce || {};
  const p = row.pe || {};
  return {
    strike: row.strike,
    call: {
      ltp:        c.ltp || 0,
      oi:         c.oi || 0,
      oiChange:   c.oiChg || 0,
      volume:     c.vol || 0,
      iv:         c.iv || 0,
      bid:        c.bid || 0,
      ask:        c.ask || 0,
      bidQty:     c.bidQty || 0,
      askQty:     c.askQty || 0,
      greeks: {
        delta: c.delta || 0,
        theta: c.theta || 0,
        gamma: c.gamma || 0,
        vega:  c.vega || 0,
        rho:   c.rho  || 0,
      },
      builtupName: c.buildup || 'Neutral',
    },
    put: {
      ltp:        p.ltp || 0,
      oi:         p.oi || 0,
      oiChange:   p.oiChg || 0,
      volume:     p.vol || 0,
      iv:         p.iv || 0,
      bid:        p.bid || 0,
      ask:        p.ask || 0,
      bidQty:     p.bidQty || 0,
      askQty:     p.askQty || 0,
      greeks: {
        delta: p.delta || 0,
        theta: p.theta || 0,
        gamma: p.gamma || 0,
        vega:  p.vega || 0,
        rho:   p.rho  || 0,
      },
      builtupName: p.buildup || 'Neutral',
    },
    pcr: {
      oi:    (c.oi || 0) > 0 ? (p.oi || 0) / (c.oi || 1) : 0,
      volume:(c.vol || 0) > 0 ? (p.vol || 0) / (c.vol || 1) : 0,
    },
  };
}

/**
 * Read the most recent option-chain snapshot for a given date from the
 * recorded JSONL. Returns the API-shape `{ ok, data: { strikes, spotLtp,
 * meta: { source, expiry, strikeCount, atm } } }`.
 *
 * Falls back to all snapshots when `latest=false`.
 */
function readOptionChainFromFile(date, { latest = true } = {}) {
  try {
    const folder = path.join(LIVE_FEED_DIR, `${date}_NIFTY_50`);
    const file = path.join(folder, 'option-chain.jsonl');
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    if (!lines.length) return null;
    if (latest) {
      // Walk from the end and pick the first parseable line
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const snap = JSON.parse(lines[i]);
          if (snap && Array.isArray(snap.strikes) && snap.strikes.length) return snap;
        } catch (_) {}
      }
      return null;
    }
    return lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (err) {
    logger.warn({ err: err.message, date }, '[liveFeedDataProvider] Failed to read option-chain file');
    return null;
  }
}

/**
 * Get the latest option chain with the standard API response shape.
 *
 * Strategy:
 *   1. Try the production API first (gives full strikes + max-pain + PCR).
 *   2. If API fails OR returns empty, fall back to the recorded
 *      `option-chain.jsonl` snapshot (ATM ± 6 strikes).
 *
 * Both paths return the same response shape consumed by the aggregator
 * and the hybrid engine. Source is recorded in `meta.source` for logging.
 *
 * @param {string} authKey
 * @param {Object} params - { securityId = 13, expiry, segment }
 */
async function getOptionChain(authKey, params = {}) {
  // Try production API first
  let apiResult = null;
  try {
    const dhanProd = require('./dhanProd.service');
    apiResult = await dhanProd.getOptionChainProd(authKey, params);
    if (apiResult?.ok && apiResult.data?.strikes?.length) {
      return apiResult;
    }
  } catch (e) {
    apiResult = { ok: false, error: e.message };
  }

  // Fallback to recorded JSONL
  const today = getTodayIST();
  const snap = readOptionChainFromFile(today, { latest: true });
  if (snap && Array.isArray(snap.strikes) && snap.strikes.length) {
    const strikes = snap.strikes.map(_apiShapeFromRecorded);
    logger.info({
      source: 'live-feed-folder',
      strikeCount: strikes.length,
      atm: snap.atm,
      apiError: apiResult?.error || 'no api result',
    }, '[liveFeedDataProvider] Option chain served from live-feed folder fallback');
    return {
      ok: true,
      data: {
        strikes,
        spotLtp: snap.spot,
        meta: {
          source: 'live-feed-folder',
          expiry: snap.expiry,
          strikeCount: strikes.length,
          atm: snap.atm,
          ts: snap.t,
          apiError: apiResult?.error || null,
        },
      },
    };
  }

  // Both failed
  logger.warn({
    apiError: apiResult?.error || 'unknown',
    folder: today,
  }, '[liveFeedDataProvider] Option chain UNAVAILABLE — both API and folder failed');
  return apiResult || { ok: false, error: 'option chain unavailable' };
}

/**
 * Get the expiry list. Falls back to the latest recorded snapshot's expiry
 * when the API is unavailable.
 */
async function getExpiryList(authKey, params = {}) {
  let apiResult = null;
  try {
    const dhanProd = require('./dhanProd.service');
    apiResult = await dhanProd.getExpiryListProd
      ? await dhanProd.getExpiryListProd(authKey, params)
      : await dhanProd.getExpiryListBypass(authKey, params);
    if (apiResult?.ok && Array.isArray(apiResult.data?.expiries) && apiResult.data.expiries.length) {
      return apiResult;
    }
  } catch (e) {
    apiResult = { ok: false, error: e.message };
  }

  // Fallback — use the recorded chain's expiry
  const today = getTodayIST();
  const snap = readOptionChainFromFile(today, { latest: true });
  if (snap?.expiry) {
    // The expiry on the recorded file may be a unix-ts (number) OR a
    // YYYY-MM-DD string. Normalise to the API shape `{ exp, expiryDate }`.
    let exp = snap.expiry;
    let expiryDate = null;
    if (typeof exp === 'string' && /^\d{4}-\d{2}-\d{2}/.test(exp)) {
      expiryDate = exp;
      exp = Math.floor(new Date(`${exp}T15:30:00+05:30`).getTime() / 1000);
    } else if (typeof exp === 'number') {
      const d = new Date(exp * 1000);
      expiryDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    logger.info({ source: 'live-feed-folder', exp, expiryDate },
      '[liveFeedDataProvider] Expiry list served from live-feed folder fallback');
    return {
      ok: true,
      data: {
        expiries: [{ exp, expiryDate, _raw: expiryDate }],
        meta: { source: 'live-feed-folder', apiError: apiResult?.error || null },
      },
    };
  }
  return apiResult || { ok: false, error: 'expiry list unavailable' };
}

/**
 * Get current NIFTY spot price from WebSocket (fastest)
 * @returns {number|null} Current LTP or null if not available
 */
function getCurrentSpotPrice() {
  const tick = liveFeed.getTick(NIFTY_SEGMENT, NIFTY_SECURITY_ID);
  return tick?.ltp || null;
}

/**
 * Get current NIFTY futures price from WebSocket.
 * Resolves the near-month futures security id (cached by
 * niftyFuturesProd.service) and reads the most recent tick from the live
 * feed snapshot map. If the tick is too old we fall back to the latest
 * close from the recorded futures candles file.
 *
 * @returns {object|null} { ltp, oi, securityId, source, ts } or null
 */
function getCurrentFuturesPrice() {
  try {
    const niftyFutures = require('./niftyFuturesProd.service');
    // getSecurityId is sync-ish — it consults the cached scrip master.
    // If not cached yet, returns null. We don't await here to keep this
    // function non-async (callers expect synchronous behaviour).
    const sid = (typeof niftyFutures.getSecurityId === 'function')
      ? (niftyFutures.getSecurityId.length === 0 ? niftyFutures.getSecurityId() : null)
      : null;
    let secIdResolved = null;
    if (sid && typeof sid.then === 'function') {
      // It's a promise (cold cache). Skip.
      secIdResolved = null;
    } else if (Number.isFinite(sid)) {
      secIdResolved = sid;
    }
    // Try the live feed if we have a security id
    if (Number.isFinite(secIdResolved)) {
      const t = liveFeed.getTick('NSE_FNO', secIdResolved);
      if (t?.ltp && t.updatedAt && Date.now() - t.updatedAt < LIVE_TICK_FRESHNESS_MS * 6) {
        return {
          ltp: Number(t.ltp),
          oi: Number(t.oi || 0),
          securityId: secIdResolved,
          source: 'websocket',
          ts: t.updatedAt,
        };
      }
    }
    // Fall back to the most recent recorded futures-1m candle
    const today = getTodayIST();
    const candles = readCandlesFromFile(today, '1m', 'futures');
    if (candles.length) {
      const last = candles[candles.length - 1];
      return {
        ltp: Number(last.close),
        oi: Number(last.oi || 0),
        securityId: secIdResolved || null,
        source: 'live-feed-folder',
        ts: (last.time || 0) * 1000,
      };
    }
  } catch (_) {}
  return null;
}

/**
 * Get statistics about live feed usage
 * @returns {object} Stats object
 */
function getStats() {
  const today = getTodayIST();
  const folder = path.join(LIVE_FEED_DIR, `${today}_NIFTY_50`);
  
  const stats = {
    today,
    folder,
    folderExists: fs.existsSync(folder),
    websocketConnected: liveFeed.isConnected,
    files: {},
  };
  
  if (stats.folderExists) {
    const intervals = ['1m', '5m', '15m'];
    for (const interval of intervals) {
      const candleFile = path.join(folder, `candles-${interval}.jsonl`);
      const futuresFile = path.join(folder, `futures-${interval}.jsonl`);
      
      stats.files[`candles-${interval}`] = {
        exists: fs.existsSync(candleFile),
        lines: fs.existsSync(candleFile) 
          ? fs.readFileSync(candleFile, 'utf8').split('\n').filter(l => l.length > 0).length 
          : 0,
      };
      
      stats.files[`futures-${interval}`] = {
        exists: fs.existsSync(futuresFile),
        lines: fs.existsSync(futuresFile)
          ? fs.readFileSync(futuresFile, 'utf8').split('\n').filter(l => l.length > 0).length
          : 0,
      };
    }
  }
  
  return stats;
}

module.exports = {
  getCandles,
  getFuturesCandles,
  getOptionChain,                    // API + folder fallback (NEW 2026-05-18)
  getExpiryList,                     // API + folder fallback (NEW 2026-05-18)
  getCurrentSpotPrice,
  getCurrentFuturesPrice,
  getStats,
  readCandlesFromFile,
  readOptionChainFromFile,           // raw access for analytics
  getTodayIST,
};
