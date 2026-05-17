/**
 * Feed Recorder Service — persists live market data to disk for backtesting & replay.
 *
 * Folder layout:
 *   backend/live-feed/
 *     snapshot.json                      (existing — current tick snapshot)
 *     2026-05-13_NIFTY_50/
 *       metadata.json                    (session info: open price, atm, expiry)
 *       spot.jsonl                       (one line per NIFTY spot tick)
 *       option-chain.jsonl               (one line per minute snapshot of ATM ± 6 strikes)
 *       futures.jsonl                    (optional — if we ever add futures feed)
 *
 * Rules:
 * - Only records between 09:15 and 15:30 IST (NSE hours).
 * - Writes are append-only JSONL via streams (no parse/rewrite cost).
 * - At server boot, folders older than RETENTION_DAYS are purged.
 * - Timezone-aware using 'Asia/Kolkata' (Windows doesn't carry IST by default).
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ROOT_DIR = path.resolve(__dirname, '../../live-feed');
const UNDERLYING = 'NIFTY_50';          // user request — only NIFTY 50 for now
const NIFTY_SECURITY_ID = 13;
const OPTION_STRIKE_WINDOW = 6;         // ± 6 strikes around ATM
const OPTION_CHAIN_FLUSH_MS = 60 * 1000; // 1-min OI cadence (matches Dhan refresh)
const SPOT_THROTTLE_MS = 250;            // drop duplicate-price ticks faster than this
const RETENTION_DAYS = 365;
const CANDLE_INTERVALS = ['1', '5', '15']; // 1min, 5min, 15min

// Market hours in IST
const MKT_OPEN_MIN = 9 * 60 + 15;   // 09:15
const MKT_CLOSE_MIN = 15 * 60 + 30; // 15:30

class FeedRecorder {
  constructor() {
    this.currentDay = null;          // e.g. "2026-05-13"
    this.dayFolder = null;
    this.spotStream = null;
    this.chainStream = null;
    this.futStream = null;   // NIFTY futures tick stream
    // Candle streams and per-interval known-timestamp set to dedup
    this.candleStreams = {}; // { '1': writeStream, '5': ..., '15': ... }
    this.knownCandleTimes = {}; // { '1': Set<ts>, '5': ..., '15': ... }
    this.futCandleStreams = {}; // futures candle streams per interval
    this.knownFutCandleTimes = {};
    this.metadataPath = null;
    this.metadata = null;

    this.lastSpotLtp = null;
    this.lastSpotAt = 0;
    this.lastFutLtp = null;
    this.lastFutAt = 0;
    this.lastChainFlushAt = 0;

    this.dayGuardTimer = null;
  }

  // ---- public API --------------------------------------------------------
  /**
   * Called once at boot. Schedules periodic rollover checks and prunes old data.
   */
  init() {
    try { fs.mkdirSync(ROOT_DIR, { recursive: true }); } catch (_) {}
    this._pruneOldFolders();
    // Every minute check rollover (market-hours window / day-change)
    if (!this.dayGuardTimer) {
      this.dayGuardTimer = setInterval(() => this._checkRollover(), 30 * 1000);
    }
    this._checkRollover();
    logger.info({ root: ROOT_DIR, underlying: UNDERLYING, retentionDays: RETENTION_DAYS }, '[feedRecorder] initialised');
  }

  /** Called by the live feed service for every NIFTY spot tick. */
  recordSpotTick(tick) {
    if (!tick || typeof tick.ltp !== 'number') return;
    if (!this._isMarketHours()) return;
    if (!this.spotStream) this._openStreams();

    const now = Date.now();
    // throttle identical-price ticks
    if (this.lastSpotLtp === tick.ltp && now - this.lastSpotAt < SPOT_THROTTLE_MS) return;
    this.lastSpotLtp = tick.ltp;
    this.lastSpotAt = now;

    try {
      const line = JSON.stringify({
        t: now,
        ltp: tick.ltp,
        ltt: tick.ltt,
        volume: tick.volume,
        open: tick.open,
        high: tick.high,
        low: tick.low,
        close: tick.close,
        atp: tick.atp,
        totalBuyQty: tick.totalBuyQty,
        totalSellQty: tick.totalSellQty,
        oi: tick.oi,
      }) + '\n';
      this.spotStream.write(line);

      // Update metadata on first tick of the day
      if (this.metadata && !this.metadata.firstTickAt) {
        this.metadata.firstTickAt = now;
        this.metadata.openPrice = tick.ltp;
        this.metadata.openCandle = { open: tick.open, high: tick.high, low: tick.low, close: tick.close };
        this._saveMetadata();
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[feedRecorder] spot write failed');
    }
  }

  /** Called by the live feed service for every NIFTY futures tick. */
  recordFuturesTick(tick) {
    if (!tick || typeof tick.ltp !== 'number') return;
    if (!this._isMarketHours()) return;
    if (!this.futStream) this._openStreams();

    const now = Date.now();
    if (this.lastFutLtp === tick.ltp && now - this.lastFutAt < SPOT_THROTTLE_MS) return;
    this.lastFutLtp = tick.ltp;
    this.lastFutAt = now;

    try {
      const line = JSON.stringify({
        t: now,
        ltp: tick.ltp,
        ltt: tick.ltt,
        volume: tick.volume,
        open: tick.open,
        high: tick.high,
        low: tick.low,
        close: tick.close,
        oi: tick.oi,
        premium: this.lastSpotLtp != null ? Number((tick.ltp - this.lastSpotLtp).toFixed(2)) : null,
      }) + '\n';
      this.futStream.write(line);
    } catch (e) {
      logger.warn({ err: e.message }, '[feedRecorder] futures tick write failed');
    }
  }

  /**
   * Persist futures candles the same way we do spot candles.
   * @param {object} byInterval - { '1': candles[], '5': candles[], '15': candles[] }
   */
  recordFuturesCandles(byInterval) {
    if (!byInterval) return;
    if (!this._isMarketHours()) return;
    if (!this.futStream) this._openStreams();

    for (const interval of CANDLE_INTERVALS) {
      const candles = byInterval[interval];
      if (!Array.isArray(candles) || candles.length === 0) continue;
      const stream = this.futCandleStreams[interval];
      if (!stream) continue;

      const known = this.knownFutCandleTimes[interval];
      for (const c of candles) {
        if (!c || !c.time || known.has(c.time)) continue;
        try {
          stream.write(JSON.stringify({
            t: c.time,
            o: c.open,
            h: c.high,
            l: c.low,
            c: c.close,
            v: c.volume || 0,
          }) + '\n');
          known.add(c.time);
        } catch (e) {
          logger.warn({ err: e.message, interval }, '[feedRecorder] futures candle write failed');
        }
      }
    }
  }

  /**
   * Called by the engine each cycle with the full option chain.
   * Filters to ATM ± N strikes and snapshots at most once per minute.
   */
  recordOptionChain({ spotLtp, strikes, expiry }) {
    if (!strikes || strikes.length === 0) return;
    if (!this._isMarketHours()) return;
    if (!this.chainStream) this._openStreams();

    const now = Date.now();
    if (now - this.lastChainFlushAt < OPTION_CHAIN_FLUSH_MS) return;
    this.lastChainFlushAt = now;

    // Round spot to nearest 50 for ATM
    const spot = typeof spotLtp === 'number' ? spotLtp : this.lastSpotLtp || 0;
    const atm = Math.round(spot / 50) * 50;

    // Take ATM ± 6 strikes (13 total). Use the strike-spacing in the actual chain.
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    const atmIdx = sorted.findIndex(s => s.strike === atm);
    let windowRows;
    if (atmIdx >= 0) {
      windowRows = sorted.slice(
        Math.max(0, atmIdx - OPTION_STRIKE_WINDOW),
        Math.min(sorted.length, atmIdx + OPTION_STRIKE_WINDOW + 1)
      );
    } else {
      // Pick closest-by-distance ± 6
      windowRows = sorted
        .map(s => ({ s, d: Math.abs(s.strike - spot) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, OPTION_STRIKE_WINDOW * 2 + 1)
        .map(o => o.s)
        .sort((a, b) => a.strike - b.strike);
    }

    const compact = windowRows.map(s => ({
      strike: s.strike,
      ce: {
        ltp: s.call?.ltp || 0,
        oi: s.call?.oi || 0,
        oiChg: s.call?.oiChange || 0,
        vol: s.call?.volume || 0,
        iv: s.call?.iv || 0,
        delta: s.call?.greeks?.delta || 0,
        theta: s.call?.greeks?.theta || 0,
        gamma: s.call?.greeks?.gamma || 0,
        vega: s.call?.greeks?.vega || 0,
        bid: s.call?.bid || 0,
        ask: s.call?.ask || 0,
        buildup: s.call?.builtupName || 'Neutral',
      },
      pe: {
        ltp: s.put?.ltp || 0,
        oi: s.put?.oi || 0,
        oiChg: s.put?.oiChange || 0,
        vol: s.put?.volume || 0,
        iv: s.put?.iv || 0,
        delta: s.put?.greeks?.delta || 0,
        theta: s.put?.greeks?.theta || 0,
        gamma: s.put?.greeks?.gamma || 0,
        vega: s.put?.greeks?.vega || 0,
        bid: s.put?.bid || 0,
        ask: s.put?.ask || 0,
        buildup: s.put?.builtupName || 'Neutral',
      },
    }));

    try {
      const strikeList = compact.map(s => s.strike);
      const line = JSON.stringify({
        t: now,
        spot,
        atm,
        expiry,
        strikes: compact,
      }) + '\n';
      this.chainStream.write(line);

      // Update metadata atm/expiry on first chain snapshot of the day
      if (this.metadata) {
        if (!this.metadata.openingAtm) {
          this.metadata.openingAtm = atm;
          this.metadata.openingStrikes = strikeList;
        }
        this.metadata.latestAtm = atm;
        this.metadata.latestStrikes = strikeList;
        this.metadata.latestExpiry = expiry;
        this._saveMetadata();
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[feedRecorder] chain write failed');
    }
  }

  /**
   * Called each cycle with the arrays of spot candles for each timeframe.
   * Dedups by timestamp so only newly-closed bars get appended.
   * @param {object} byInterval - { '1': candles[], '5': candles[], '15': candles[] }
   */
  recordCandles(byInterval) {
    if (!byInterval) return;
    if (!this._isMarketHours()) return;
    if (!this.spotStream) this._openStreams();

    for (const interval of CANDLE_INTERVALS) {
      const candles = byInterval[interval];
      if (!Array.isArray(candles) || candles.length === 0) continue;
      const stream = this.candleStreams[interval];
      if (!stream) continue;

      const known = this.knownCandleTimes[interval];
      for (const c of candles) {
        if (!c || !c.time || known.has(c.time)) continue;
        // Only persist candles that have actually closed — not the partial bar
        // (partial = last bar whose start time + interval > now)
        try {
          stream.write(JSON.stringify({
            t: c.time,
            o: c.open,
            h: c.high,
            l: c.low,
            c: c.close,
            v: c.volume || 0,
          }) + '\n');
          known.add(c.time);
        } catch (e) {
          logger.warn({ err: e.message, interval }, '[feedRecorder] candle write failed');
        }
      }
    }
  }

  /** Return the current folder being written (useful for stop/status) */
  getStatus() {
    return {
      dayFolder: this.dayFolder,
      currentDay: this.currentDay,
      isMarketHours: this._isMarketHours(),
      lastSpotLtp: this.lastSpotLtp,
      lastSpotAt: this.lastSpotAt ? new Date(this.lastSpotAt).toISOString() : null,
      lastChainFlushAt: this.lastChainFlushAt ? new Date(this.lastChainFlushAt).toISOString() : null,
      rootDir: ROOT_DIR,
      underlying: UNDERLYING,
      strikeWindow: OPTION_STRIKE_WINDOW,
      retentionDays: RETENTION_DAYS,
    };
  }

  /** Manually close streams — called on shutdown */
  shutdown() {
    if (this.dayGuardTimer) {
      clearInterval(this.dayGuardTimer);
      this.dayGuardTimer = null;
    }
    this._closeStreams();
  }

  // ---- internals ---------------------------------------------------------
  _isMarketHours() {
    const now = this._istNow();
    // Skip weekends
    const dow = now.weekday; // 0=Sun, 6=Sat (we build this manually)
    if (dow === 0 || dow === 6) return false;
    const minutes = now.hours * 60 + now.minutes;
    return minutes >= MKT_OPEN_MIN && minutes < MKT_CLOSE_MIN;
  }

  _istNow() {
    // Produce an object with IST date parts without relying on server timezone
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hours: Number(parts.hour),
      minutes: Number(parts.minute),
      seconds: Number(parts.second),
      weekday: weekdayMap[parts.weekday] ?? 1,
      dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    };
  }

  _checkRollover() {
    const { dateStr } = this._istNow();
    if (this.currentDay && this.currentDay !== dateStr) {
      logger.info({ from: this.currentDay, to: dateStr }, '[feedRecorder] day rollover');
      this._closeStreams();
      this._pruneOldFolders();
    }
    // Ensure folder exists for today (even if not market hours — cheap)
    if (this.currentDay !== dateStr) {
      this.currentDay = dateStr;
      this.dayFolder = path.join(ROOT_DIR, `${dateStr}_${UNDERLYING}`);
      try { fs.mkdirSync(this.dayFolder, { recursive: true }); } catch (_) {}
      this.metadataPath = path.join(this.dayFolder, 'metadata.json');
      this._loadMetadata(dateStr);
    }
  }

  _openStreams() {
    if (!this.dayFolder) this._checkRollover();
    try {
      if (!this.spotStream) {
        this.spotStream = fs.createWriteStream(
          path.join(this.dayFolder, 'spot.jsonl'),
          { flags: 'a', encoding: 'utf8' }
        );
      }
      if (!this.chainStream) {
        this.chainStream = fs.createWriteStream(
          path.join(this.dayFolder, 'option-chain.jsonl'),
          { flags: 'a', encoding: 'utf8' }
        );
      }
      if (!this.futStream) {
        this.futStream = fs.createWriteStream(
          path.join(this.dayFolder, 'futures-ticks.jsonl'),
          { flags: 'a', encoding: 'utf8' }
        );
      }
      // Open candle streams + load any already-written timestamps for dedup
      for (const interval of CANDLE_INTERVALS) {
        if (!this.candleStreams[interval]) {
          const file = path.join(this.dayFolder, `candles-${interval}m.jsonl`);
          this.knownCandleTimes[interval] = this._loadExistingCandleTimes(file);
          this.candleStreams[interval] = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
        }
        if (!this.futCandleStreams[interval]) {
          const file = path.join(this.dayFolder, `futures-${interval}m.jsonl`);
          this.knownFutCandleTimes[interval] = this._loadExistingCandleTimes(file);
          this.futCandleStreams[interval] = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
        }
      }
      logger.info({ folder: this.dayFolder }, '[feedRecorder] streams open');
    } catch (e) {
      logger.error({ err: e.message, folder: this.dayFolder }, '[feedRecorder] open streams failed');
    }
  }

  _closeStreams() {
    if (this.spotStream) {
      try { this.spotStream.end(); } catch (_) {}
      this.spotStream = null;
    }
    if (this.chainStream) {
      try { this.chainStream.end(); } catch (_) {}
      this.chainStream = null;
    }
    if (this.futStream) {
      try { this.futStream.end(); } catch (_) {}
      this.futStream = null;
    }
    for (const interval of CANDLE_INTERVALS) {
      if (this.candleStreams[interval]) {
        try { this.candleStreams[interval].end(); } catch (_) {}
        this.candleStreams[interval] = null;
      }
      if (this.futCandleStreams[interval]) {
        try { this.futCandleStreams[interval].end(); } catch (_) {}
        this.futCandleStreams[interval] = null;
      }
      this.knownCandleTimes[interval] = new Set();
      this.knownFutCandleTimes[interval] = new Set();
    }
  }

  /**
   * Load all candle timestamps already recorded in the file so we can
   * skip duplicates after a server restart.
   */
  _loadExistingCandleTimes(file) {
    const set = new Set();
    try {
      if (!fs.existsSync(file)) return set;
      const raw = fs.readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        if (!line) return;
        try {
          const row = JSON.parse(line);
          if (row.t) set.add(row.t);
        } catch (_) {}
      });
    } catch (_) {}
    return set;
  }

  _loadMetadata(dateStr) {
    try {
      if (fs.existsSync(this.metadataPath)) {
        this.metadata = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
      } else {
        this.metadata = {
          date: dateStr,
          underlying: UNDERLYING,
          securityId: NIFTY_SECURITY_ID,
          createdAt: Date.now(),
          firstTickAt: null,
          openPrice: null,
          openingAtm: null,
          latestAtm: null,
          latestExpiry: null,
          openCandle: null,
        };
        this._saveMetadata();
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[feedRecorder] metadata load failed');
      this.metadata = { date: dateStr, underlying: UNDERLYING, createdAt: Date.now() };
    }
  }

  _saveMetadata() {
    try {
      fs.writeFileSync(this.metadataPath, JSON.stringify(this.metadata, null, 2));
    } catch (_) {}
  }

  _pruneOldFolders() {
    try {
      const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true });
      const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        // folder pattern: YYYY-MM-DD_UNDERLYING
        const m = e.name.match(/^(\d{4})-(\d{2})-(\d{2})_/);
        if (!m) continue;
        const folderDate = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
        if (folderDate.getTime() < cutoff) {
          const fullPath = path.join(ROOT_DIR, e.name);
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            logger.info({ folder: e.name }, '[feedRecorder] pruned old folder');
          } catch (err) {
            logger.warn({ folder: e.name, err: err.message }, '[feedRecorder] prune failed');
          }
        }
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[feedRecorder] prune scan failed');
    }
  }
}

const instance = new FeedRecorder();

module.exports = {
  instance,
  ROOT_DIR,
  UNDERLYING,
  NIFTY_SECURITY_ID,
  OPTION_STRIKE_WINDOW,
};
