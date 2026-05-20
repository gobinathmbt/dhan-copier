/**
 * Feed Recorder Service — persists live market data to disk for backtesting & replay.
 *
 * Folder layout (one per symbol per day):
 *   backend/live-feed/
 *     snapshot.json                      (existing — current tick snapshot)
 *     2026-05-13_NIFTY_50/
 *       metadata.json                    (session info: open price, atm, expiry)
 *       spot.jsonl                       (one line per spot tick)
 *       option-chain.jsonl               (one line per minute snapshot of ATM ± 6 strikes)
 *       futures-ticks.jsonl              (per-tick futures data)
 *       candles-1m.jsonl, candles-5m.jsonl, candles-15m.jsonl
 *       futures-1m.jsonl, futures-5m.jsonl, futures-15m.jsonl
 *     2026-05-13_SENSEX/
 *       (same file layout — populated when SENSEX is in tradingSymbols)
 *
 * MULTI-SYMBOL: every method accepts an optional symbolKey argument and
 * routes the write to that symbol's per-day folder. When omitted, falls
 * back to symbolRegistry.getActiveSymbol() for backwards compatibility.
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
const symbolRegistry = require('../config/symbolRegistry');

const ROOT_DIR = path.resolve(__dirname, '../../live-feed');
const NIFTY_SECURITY_ID = 13;
const OPTION_STRIKE_WINDOW = 6;         // ± 6 strikes around ATM
const OPTION_CHAIN_FLUSH_MS = 60 * 1000; // 1-min OI cadence (matches Dhan refresh)
const SPOT_THROTTLE_MS = 250;            // drop duplicate-price ticks faster than this
const RETENTION_DAYS = 365;
const CANDLE_INTERVALS = ['1', '5', '15']; // 1min, 5min, 15min

// Market hours in IST
const MKT_OPEN_MIN = 9 * 60 + 15;   // 09:15
const MKT_CLOSE_MIN = 15 * 60 + 30; // 15:30

function _activeKey() { return symbolRegistry.getActiveSymbol(); }

class FeedRecorder {
  constructor() {
    /** Per-symbol state — keyed by symbol key (e.g. 'NIFTY_50', 'SENSEX').
     *  Each entry holds its own currentDay/dayFolder/streams/throttles/metadata
     *  so multiple symbols can record concurrently to separate folders. */
    this.bySymbol = new Map();
    this.dayGuardTimer = null;
  }

  // ---- public API --------------------------------------------------------
  /**
   * Called once at boot. Schedules periodic rollover checks and prunes old data.
   */
  init() {
    try { fs.mkdirSync(ROOT_DIR, { recursive: true }); } catch (_) {}
    this._pruneOldFolders();
    // Every 30 sec check rollover (market-hours window / day-change) for ALL symbols
    if (!this.dayGuardTimer) {
      this.dayGuardTimer = setInterval(() => this._checkRolloverAll(), 30 * 1000);
    }
    // Run initial rollover for the active symbol so the folder exists.
    this._checkRolloverFor(_activeKey());
    logger.info({ root: ROOT_DIR, underlying: _activeKey(), retentionDays: RETENTION_DAYS }, '[feedRecorder] initialised');
  }

  /** Called by the live feed service for every spot tick. symbolKey routes to the right folder. */
  recordSpotTick(tick, symbolKey = null) {
    if (!tick || typeof tick.ltp !== 'number') return;
    if (!this._isMarketHours()) return;
    const key = symbolKey || _activeKey();
    const sym = this._ensureSymbolState(key);

    const now = Date.now();
    if (sym.lastSpotLtp === tick.ltp && now - sym.lastSpotAt < SPOT_THROTTLE_MS) return;
    sym.lastSpotLtp = tick.ltp;
    sym.lastSpotAt = now;

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
      sym.spotStream.write(line);

      if (sym.metadata && !sym.metadata.firstTickAt) {
        sym.metadata.firstTickAt = now;
        sym.metadata.openPrice = tick.ltp;
        sym.metadata.openCandle = { open: tick.open, high: tick.high, low: tick.low, close: tick.close };
        this._saveMetadata(sym);
      }
    } catch (e) {
      logger.warn({ err: e.message, key }, '[feedRecorder] spot write failed');
    }
  }

  /** Called by the live feed service for every futures tick. */
  recordFuturesTick(tick, symbolKey = null) {
    if (!tick || typeof tick.ltp !== 'number') return;
    if (!this._isMarketHours()) return;
    const key = symbolKey || _activeKey();
    const sym = this._ensureSymbolState(key);

    const now = Date.now();
    if (sym.lastFutLtp === tick.ltp && now - sym.lastFutAt < SPOT_THROTTLE_MS) return;
    sym.lastFutLtp = tick.ltp;
    sym.lastFutAt = now;

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
        premium: sym.lastSpotLtp != null ? Number((tick.ltp - sym.lastSpotLtp).toFixed(2)) : null,
      }) + '\n';
      sym.futStream.write(line);
    } catch (e) {
      logger.warn({ err: e.message, key }, '[feedRecorder] futures tick write failed');
    }
  }

  /**
   * Persist futures candles the same way we do spot candles.
   * @param {object} byInterval - { '1': candles[], '5': candles[], '15': candles[] }
   */
  recordFuturesCandles(byInterval, symbolKey = null) {
    if (!byInterval) return;
    if (!this._isMarketHours()) return;
    const key = symbolKey || _activeKey();
    const sym = this._ensureSymbolState(key);

    for (const interval of CANDLE_INTERVALS) {
      const candles = byInterval[interval];
      if (!Array.isArray(candles) || candles.length === 0) continue;
      const stream = sym.futCandleStreams[interval];
      if (!stream) continue;

      const known = sym.knownFutCandleTimes[interval];
      for (const c of candles) {
        if (!c || !c.time) continue;
        let timeSec = Number(c.time);
        if (!Number.isFinite(timeSec)) continue;
        if (timeSec >= 1e12) timeSec = Math.floor(timeSec / 1000);
        if (known.has(timeSec)) continue;
        try {
          stream.write(JSON.stringify({
            t: timeSec,
            o: c.open, h: c.high, l: c.low, c: c.close,
            v: c.volume || 0,
          }) + '\n');
          known.add(timeSec);
        } catch (e) {
          logger.warn({ err: e.message, interval, key }, '[feedRecorder] futures candle write failed');
        }
      }
    }
  }

  /**
   * Called by the engine each cycle with the full option chain.
   * Filters to ATM ± N strikes and snapshots at most once per minute.
   */
  recordOptionChain({ spotLtp, strikes, expiry, symbolKey = null }) {
    if (!strikes || strikes.length === 0) return;
    if (!this._isMarketHours()) return;
    const key = symbolKey || _activeKey();
    const sym = this._ensureSymbolState(key);

    const now = Date.now();
    if (now - sym.lastChainFlushAt < OPTION_CHAIN_FLUSH_MS) return;
    sym.lastChainFlushAt = now;

    // Strike step (50 NIFTY, 100 SENSEX) drives ATM rounding.
    const symbolMeta = symbolRegistry.getSymbol(key);
    const step = symbolMeta?.strikeStep || 50;
    const spot = typeof spotLtp === 'number' ? spotLtp : sym.lastSpotLtp || 0;
    const atm = Math.round(spot / step) * step;

    // Take ATM ± OPTION_STRIKE_WINDOW strikes.
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    const atmIdx = sorted.findIndex(s => s.strike === atm);
    let windowRows;
    if (atmIdx >= 0) {
      windowRows = sorted.slice(
        Math.max(0, atmIdx - OPTION_STRIKE_WINDOW),
        Math.min(sorted.length, atmIdx + OPTION_STRIKE_WINDOW + 1)
      );
    } else {
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
        ltp: s.call?.ltp || 0, oi: s.call?.oi || 0, oiChg: s.call?.oiChange || 0,
        vol: s.call?.volume || 0, iv: s.call?.iv || 0,
        delta: s.call?.greeks?.delta || 0, theta: s.call?.greeks?.theta || 0,
        gamma: s.call?.greeks?.gamma || 0, vega: s.call?.greeks?.vega || 0,
        bid: s.call?.bid || 0, ask: s.call?.ask || 0,
        bidQty: s.call?.bidQty || 0, askQty: s.call?.askQty || 0,
        buildup: s.call?.builtupName || 'Neutral',
      },
      pe: {
        ltp: s.put?.ltp || 0, oi: s.put?.oi || 0, oiChg: s.put?.oiChange || 0,
        vol: s.put?.volume || 0, iv: s.put?.iv || 0,
        delta: s.put?.greeks?.delta || 0, theta: s.put?.greeks?.theta || 0,
        gamma: s.put?.greeks?.gamma || 0, vega: s.put?.greeks?.vega || 0,
        bid: s.put?.bid || 0, ask: s.put?.ask || 0,
        bidQty: s.put?.bidQty || 0, askQty: s.put?.askQty || 0,
        buildup: s.put?.builtupName || 'Neutral',
      },
    }));

    try {
      const strikeList = compact.map(s => s.strike);
      const line = JSON.stringify({
        t: now, spot, atm, expiry, strikes: compact,
      }) + '\n';
      sym.chainStream.write(line);

      if (sym.metadata) {
        if (!sym.metadata.openingAtm) {
          sym.metadata.openingAtm = atm;
          sym.metadata.openingStrikes = strikeList;
        }
        sym.metadata.latestAtm = atm;
        sym.metadata.latestStrikes = strikeList;
        sym.metadata.latestExpiry = expiry;
        this._saveMetadata(sym);
      }
    } catch (e) {
      logger.warn({ err: e.message, key }, '[feedRecorder] chain write failed');
    }
  }

  /**
   * Called each cycle with the arrays of spot candles for each timeframe.
   * Dedups by timestamp so only newly-closed bars get appended.
   */
  recordCandles(byInterval, symbolKey = null) {
    if (!byInterval) return;
    if (!this._isMarketHours()) return;
    const key = symbolKey || _activeKey();
    const sym = this._ensureSymbolState(key);

    for (const interval of CANDLE_INTERVALS) {
      const candles = byInterval[interval];
      if (!Array.isArray(candles) || candles.length === 0) continue;
      const stream = sym.candleStreams[interval];
      if (!stream) continue;

      const known = sym.knownCandleTimes[interval];
      for (const c of candles) {
        if (!c || !c.time) continue;
        let timeSec = Number(c.time);
        if (!Number.isFinite(timeSec)) continue;
        if (timeSec >= 1e12) timeSec = Math.floor(timeSec / 1000);
        if (known.has(timeSec)) continue;
        try {
          stream.write(JSON.stringify({
            t: timeSec,
            o: c.open, h: c.high, l: c.low, c: c.close,
            v: c.volume || 0,
          }) + '\n');
          known.add(timeSec);
        } catch (e) {
          logger.warn({ err: e.message, interval, key }, '[feedRecorder] candle write failed');
        }
      }
    }
  }

  /** Return per-symbol status. */
  getStatus() {
    const symbols = {};
    for (const [key, sym] of this.bySymbol.entries()) {
      symbols[key] = {
        dayFolder: sym.dayFolder,
        currentDay: sym.currentDay,
        lastSpotLtp: sym.lastSpotLtp,
        lastSpotAt: sym.lastSpotAt ? new Date(sym.lastSpotAt).toISOString() : null,
        lastChainFlushAt: sym.lastChainFlushAt ? new Date(sym.lastChainFlushAt).toISOString() : null,
      };
    }
    return {
      activeSymbol: _activeKey(),
      isMarketHours: this._isMarketHours(),
      rootDir: ROOT_DIR,
      strikeWindow: OPTION_STRIKE_WINDOW,
      retentionDays: RETENTION_DAYS,
      symbols,
    };
  }

  /** Manually close all per-symbol streams — called on shutdown */
  shutdown() {
    if (this.dayGuardTimer) {
      clearInterval(this.dayGuardTimer);
      this.dayGuardTimer = null;
    }
    for (const sym of this.bySymbol.values()) {
      this._closeStreamsFor(sym);
    }
  }

  // ---- internals ---------------------------------------------------------
  _isMarketHours() {
    const now = this._istNow();
    const dow = now.weekday;
    if (dow === 0 || dow === 6) return false;
    const minutes = now.hours * 60 + now.minutes;
    return minutes >= MKT_OPEN_MIN && minutes < MKT_CLOSE_MIN;
  }

  _istNow() {
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

  /** Build a fresh per-symbol state bag. */
  _newSymbolState(key) {
    return {
      key,
      currentDay: null,
      dayFolder: null,
      metadataPath: null,
      metadata: null,
      spotStream: null,
      chainStream: null,
      futStream: null,
      candleStreams: {},
      knownCandleTimes: {},
      futCandleStreams: {},
      knownFutCandleTimes: {},
      lastSpotLtp: null,
      lastSpotAt: 0,
      lastFutLtp: null,
      lastFutAt: 0,
      lastChainFlushAt: 0,
    };
  }

  /** Lazy-create per-symbol state and open streams for today's folder. */
  _ensureSymbolState(key) {
    let sym = this.bySymbol.get(key);
    if (!sym) {
      sym = this._newSymbolState(key);
      this.bySymbol.set(key, sym);
    }
    this._checkRolloverFor(key);
    if (!sym.spotStream) this._openStreamsFor(sym);
    return sym;
  }

  /** Rollover check for a single symbol. */
  _checkRolloverFor(key) {
    let sym = this.bySymbol.get(key);
    if (!sym) {
      sym = this._newSymbolState(key);
      this.bySymbol.set(key, sym);
    }
    const { dateStr } = this._istNow();
    const wantedFolder = path.join(ROOT_DIR, `${dateStr}_${key}`);
    if (sym.currentDay && (sym.currentDay !== dateStr || sym.dayFolder !== wantedFolder)) {
      logger.info({ key, from: sym.currentDay, to: dateStr }, '[feedRecorder] day rollover');
      this._closeStreamsFor(sym);
    }
    if (sym.currentDay !== dateStr || sym.dayFolder !== wantedFolder) {
      sym.currentDay = dateStr;
      sym.dayFolder = wantedFolder;
      try { fs.mkdirSync(sym.dayFolder, { recursive: true }); } catch (_) {}
      sym.metadataPath = path.join(sym.dayFolder, 'metadata.json');
      this._loadMetadata(sym, dateStr);
    }
  }

  /** Rollover for ALL symbols currently tracked. Also creates a folder
   *  for the active symbol if it has no entry yet. */
  _checkRolloverAll() {
    // Make sure the active symbol is being tracked even if no tick has
    // arrived yet (so the folder shows up in the file listing).
    if (!this.bySymbol.has(_activeKey())) {
      this._ensureSymbolState(_activeKey());
    }
    for (const key of this.bySymbol.keys()) {
      this._checkRolloverFor(key);
    }
    this._pruneOldFolders();
  }

  _openStreamsFor(sym) {
    if (!sym.dayFolder) this._checkRolloverFor(sym.key);
    try {
      if (!sym.spotStream) {
        sym.spotStream = fs.createWriteStream(
          path.join(sym.dayFolder, 'spot.jsonl'),
          { flags: 'a', encoding: 'utf8' }
        );
      }
      if (!sym.chainStream) {
        sym.chainStream = fs.createWriteStream(
          path.join(sym.dayFolder, 'option-chain.jsonl'),
          { flags: 'a', encoding: 'utf8' }
        );
      }
      if (!sym.futStream) {
        sym.futStream = fs.createWriteStream(
          path.join(sym.dayFolder, 'futures-ticks.jsonl'),
          { flags: 'a', encoding: 'utf8' }
        );
      }
      for (const interval of CANDLE_INTERVALS) {
        if (!sym.candleStreams[interval]) {
          const file = path.join(sym.dayFolder, `candles-${interval}m.jsonl`);
          sym.knownCandleTimes[interval] = this._loadExistingCandleTimes(file);
          sym.candleStreams[interval] = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
        }
        if (!sym.futCandleStreams[interval]) {
          const file = path.join(sym.dayFolder, `futures-${interval}m.jsonl`);
          sym.knownFutCandleTimes[interval] = this._loadExistingCandleTimes(file);
          sym.futCandleStreams[interval] = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
        }
      }
      logger.info({ key: sym.key, folder: sym.dayFolder }, '[feedRecorder] streams open');
    } catch (e) {
      logger.error({ err: e.message, key: sym.key, folder: sym.dayFolder }, '[feedRecorder] open streams failed');
    }
  }

  _closeStreamsFor(sym) {
    if (!sym) return;
    if (sym.spotStream)  { try { sym.spotStream.end(); } catch (_) {} sym.spotStream = null; }
    if (sym.chainStream) { try { sym.chainStream.end(); } catch (_) {} sym.chainStream = null; }
    if (sym.futStream)   { try { sym.futStream.end(); } catch (_) {} sym.futStream = null; }
    for (const interval of CANDLE_INTERVALS) {
      if (sym.candleStreams[interval])    { try { sym.candleStreams[interval].end(); } catch (_) {} sym.candleStreams[interval] = null; }
      if (sym.futCandleStreams[interval]) { try { sym.futCandleStreams[interval].end(); } catch (_) {} sym.futCandleStreams[interval] = null; }
      sym.knownCandleTimes[interval] = new Set();
      sym.knownFutCandleTimes[interval] = new Set();
    }
  }

  _loadExistingCandleTimes(file) {
    const set = new Set();
    try {
      if (!fs.existsSync(file)) return set;
      const raw = fs.readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        if (!line) return;
        try {
          const row = JSON.parse(line);
          if (!row.t) return;
          let t = Number(row.t);
          if (!Number.isFinite(t)) return;
          if (t >= 1e12) t = Math.floor(t / 1000);
          set.add(t);
        } catch (_) {}
      });
    } catch (_) {}
    return set;
  }

  _loadMetadata(sym, dateStr) {
    try {
      if (fs.existsSync(sym.metadataPath)) {
        sym.metadata = JSON.parse(fs.readFileSync(sym.metadataPath, 'utf8'));
      } else {
        const symMeta = symbolRegistry.getSymbol(sym.key);
        sym.metadata = {
          date: dateStr,
          underlying: sym.key,
          securityId: symMeta?.indexSecurityId || NIFTY_SECURITY_ID,
          createdAt: Date.now(),
          firstTickAt: null,
          openPrice: null,
          openingAtm: null,
          latestAtm: null,
          latestExpiry: null,
          openCandle: null,
        };
        this._saveMetadata(sym);
      }
    } catch (e) {
      logger.warn({ err: e.message, key: sym.key }, '[feedRecorder] metadata load failed');
      sym.metadata = { date: dateStr, underlying: sym.key, createdAt: Date.now() };
    }
  }

  _saveMetadata(sym) {
    try {
      fs.writeFileSync(sym.metadataPath, JSON.stringify(sym.metadata, null, 2));
    } catch (_) {}
  }

  _pruneOldFolders() {
    try {
      const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true });
      const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
      for (const e of entries) {
        if (!e.isDirectory()) continue;
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

// Backwards-compat:
//   UNDERLYING — kept as a literal default ('NIFTY_50'). Callers that
//                destructured it at module load get the safe default.
//   getUnderlying() — returns the currently active symbol key at request
//                     time, used by the controller to scan the right folder.
module.exports = {
  instance,
  ROOT_DIR,
  UNDERLYING: 'NIFTY_50',
  getUnderlying: _activeKey,
  NIFTY_SECURITY_ID,
  OPTION_STRIKE_WINDOW,
};
