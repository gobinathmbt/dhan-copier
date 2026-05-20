/**
 * Futures Candle Aggregator Service
 * ==================================
 * Aggregates futures ticks into 1m, 5m, 15m candles
 * since the Dhan API is returning 401 for futures historical data.
 * 
 * This service reads the futures-ticks.jsonl file and builds candles
 * from the raw tick data.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const symbolRegistry = require('../config/symbolRegistry');

const LIVE_FEED_DIR = path.join(__dirname, '../../live-feed');
function _activeFolderSuffix() { return symbolRegistry.getActiveSymbol(); }

/**
 * Aggregate ticks into candles for a specific interval.
 *
 * IMPORTANT: futures-ticks.jsonl stores `tick.t` in MILLISECONDS (Date.now()),
 * but the rest of the system (spot candles, hybrid engine, candle synthesizer)
 * uses SECONDS. This function bucketises by ms internally for precision but
 * emits candle `time` values in SECONDS to stay compatible with the spot
 * pipeline. CALIBRATED 2026-05-18 — was emitting ms which made the candle
 * synthesizer treat them as year ~56347.
 *
 * @param {Array} ticks - tick objects { t (ms), ltp, volume, oi, premium }
 * @param {number} intervalMinutes - 1, 5, or 15
 * @returns {Array} candle objects with { time (sec), open, high, low, close, volume, oi, premium }
 */
function aggregateTicks(ticks, intervalMinutes) {
  if (!ticks || ticks.length === 0) return [];

  const intervalMs = intervalMinutes * 60 * 1000;
  const candles = new Map(); // key: candle start time (ms), value: candle object

  for (const tick of ticks) {
    if (!tick || typeof tick.ltp !== 'number') continue;

    // tick.t is in milliseconds — round down to interval start (also ms)
    const candleStartMs = Math.floor(tick.t / intervalMs) * intervalMs;

    if (!candles.has(candleStartMs)) {
      candles.set(candleStartMs, {
        time: Math.floor(candleStartMs / 1000), // emit in SECONDS
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        volume: tick.volume || 0,
        oi: tick.oi || 0,
        premium: tick.premium || 0,
        tickCount: 1,
      });
    } else {
      const candle = candles.get(candleStartMs);
      candle.high = Math.max(candle.high, tick.ltp);
      candle.low = Math.min(candle.low, tick.ltp);
      candle.close = tick.ltp;
      candle.volume = tick.volume || candle.volume;
      candle.oi = tick.oi || candle.oi;
      candle.premium = tick.premium || candle.premium;
      candle.tickCount++;
    }
  }

  // Convert map to sorted array
  return Array.from(candles.values()).sort((a, b) => a.time - b.time);
}

/**
 * Read futures ticks from today's file and aggregate into candles
 * @param {string} date - YYYY-MM-DD
 * @returns {Object} { '1': candles[], '5': candles[], '15': candles[] }
 */
async function aggregateFuturesCandles(date) {
  try {
    const ticksFile = path.join(LIVE_FEED_DIR, `${date}_${_activeFolderSuffix()}`, 'futures-ticks.jsonl');
    
    if (!fs.existsSync(ticksFile)) {
      logger.warn({ date, file: ticksFile }, '[futuresCandleAggregator] Ticks file not found');
      return { '1': [], '5': [], '15': [], '30': [] };
    }

    // Read all ticks
    const content = fs.readFileSync(ticksFile, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    const ticks = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    }).filter(t => t !== null);

    if (ticks.length === 0) {
      logger.warn({ date }, '[futuresCandleAggregator] No valid ticks found');
      return { '1': [], '5': [], '15': [], '30': [] };
    }

    // Aggregate into different timeframes
    const candles1m = aggregateTicks(ticks, 1);
    const candles5m = aggregateTicks(ticks, 5);
    const candles15m = aggregateTicks(ticks, 15);
    const candles30m = aggregateTicks(ticks, 30);

    logger.info({
      date,
      tickCount: ticks.length,
      candles1m: candles1m.length,
      candles5m: candles5m.length,
      candles15m: candles15m.length,
      candles30m: candles30m.length,
    }, '[futuresCandleAggregator] Aggregated futures candles from ticks');

    return {
      '1': candles1m,
      '5': candles5m,
      '15': candles15m,
      '30': candles30m,
    };

  } catch (err) {
    logger.error({ err: err.message, date }, '[futuresCandleAggregator] Failed to aggregate candles');
    return { '1': [], '5': [], '15': [], '30': [] };
  }
}

/**
 * Write aggregated candles to the timeframe files.
 *
 * DEFENSIVE: This function converts ms→sec timestamps before writing,
 * so even if the in-memory aggregateTicks function is the OLD cached
 * version (which emitted ms), the on-disk format stays consistent
 * (seconds, matching spot candles).
 *
 * @param {string} date - YYYY-MM-DD
 * @param {Object} candles - { '1': candles[], '5': candles[], '15': candles[] }
 */
async function writeCandlesToFiles(date, candles) {
  try {
    const folder = path.join(LIVE_FEED_DIR, `${date}_${_activeFolderSuffix()}`);
    
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }

    // Write each timeframe
    for (const [interval, candleArray] of Object.entries(candles)) {
      const file = path.join(folder, `futures-${interval}m.jsonl`);
      
      // Read existing candles to avoid duplicates (already in seconds on disk)
      const existing = new Set();
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf8');
        content.trim().split('\n').forEach(line => {
          if (!line) return;
          try {
            const c = JSON.parse(line);
            if (c.t) existing.add(c.t);
          } catch (e) {}
        });
      }

      // Append only new candles
      const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
      let written = 0;
      
      for (const candle of candleArray) {
        // Defensive: normalize candle.time to SECONDS regardless of input unit.
        // 13+ digits = milliseconds (Date.now()), 10 digits = seconds.
        let timeSec = candle.time;
        if (String(timeSec).length >= 13) {
          timeSec = Math.floor(timeSec / 1000);
        }
        if (existing.has(timeSec)) continue;
        
        stream.write(JSON.stringify({
          t: timeSec,
          o: candle.open,
          h: candle.high,
          l: candle.low,
          c: candle.close,
          v: candle.volume || 0,
          oi: candle.oi || 0,
          premium: candle.premium || 0,
        }) + '\n');
        existing.add(timeSec);
        written++;
      }
      
      stream.end();
      
      logger.info({
        interval: `${interval}m`,
        total: candleArray.length,
        written,
        skipped: candleArray.length - written,
      }, '[futuresCandleAggregator] Wrote futures candles to file');
    }

  } catch (err) {
    logger.error({ err: err.message, date }, '[futuresCandleAggregator] Failed to write candles');
  }
}

/**
 * Main function - aggregate and write candles for today
 * Call this periodically (e.g., every minute) to keep candles up-to-date
 */
async function updateTodaysCandles() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const candles = await aggregateFuturesCandles(today);
  await writeCandlesToFiles(today, candles);
  return candles;
}

module.exports = {
  aggregateFuturesCandles,
  writeCandlesToFiles,
  updateTodaysCandles,
  aggregateTicks, // for testing
};
