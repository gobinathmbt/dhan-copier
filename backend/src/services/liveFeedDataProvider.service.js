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
  
  // Fall back to API (will likely fail with 401, but try anyway)
  logger.debug({
    source: 'api-fallback',
    interval: intervalStr,
  }, '[liveFeedDataProvider] No futures candles in live-feed, falling back to API');
  
  const niftyFutures = require('./niftyFuturesProd.service');
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - (minutesBack * 60);
  
  return await niftyFutures.getIntradayCandles({
    interval,
    startTime,
    endTime: now,
  });
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
 * Get current NIFTY futures price from WebSocket
 * @returns {object|null} Futures tick or null
 */
function getCurrentFuturesPrice() {
  // Futures are on NSE_FNO segment
  // Security ID varies by expiry - we'd need to track the current month contract
  // For now, return null and let caller use API
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
  getCurrentSpotPrice,
  getCurrentFuturesPrice,
  getStats,
  readCandlesFromFile,
  getTodayIST,
};
