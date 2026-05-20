/**
 * Dhan Production Live Feed (WebSocket)
 *
 * Connects to the OFFICIAL Dhan v2 feed endpoint using the subscribed Data API
 * JWT from the env. Replaces the reverse-engineered bundle-based feed.
 *
 *   wss://api-feed.dhan.co?version=2&token=<JWT>&clientId=<id>&authType=2
 *
 * Binary packet spec is documented in `Dhan Live API/Live Market Feed.md`.
 * Data is little-endian. Header is always 8 bytes.
 *
 * Feed response codes (Annexure.md):
 *   1 = Index packet (no spec in doc — we treat as tick)
 *   2 = Ticker packet         (LTP + LTT)
 *   4 = Quote packet          (LTP, OHLC, volume, buy/sell qty, ATP)
 *   5 = OI packet             (OI only)
 *   6 = Prev Close packet     (prev close + prev OI)
 *   7 = Market status packet
 *   8 = Full packet           (quote + OI + 5-level market depth)
 *   50 = Feed disconnect
 *
 * Subscription codes:
 *   15/16 = Ticker (sub/unsub)
 *   17/18 = Quote
 *   21/22 = Full
 *   23/24 = Full Market Depth
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const env = require('../config/env');
const { instance: feedRecorder } = require('./feedRecorder.service');

const WS_BASE = 'wss://api-feed.dhan.co';
const SNAPSHOT_DIR = path.resolve(__dirname, '../../live-feed');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'snapshot.json');
const SNAPSHOT_FLUSH_MS = 1000; // flush at most once per second
const HEARTBEAT_TIMEOUT_MS = 45 * 1000; // server pings every 10s; kill if silent 45s

// Exchange Segment enum map (Annexure.md: byte 4 of response header)
const SEGMENT_CODE_TO_NAME = {
  0: 'IDX_I',
  1: 'NSE_EQ',
  2: 'NSE_FNO',
  3: 'NSE_CURRENCY',
  4: 'BSE_EQ',
  5: 'MCX_COMM',
  7: 'BSE_CURRENCY',
  8: 'BSE_FNO',
};
const SEGMENT_NAME_TO_CODE = Object.fromEntries(
  Object.entries(SEGMENT_CODE_TO_NAME).map(([k, v]) => [v, Number(k)])
);

class DhanLiveFeedProd extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // multiple consumers (hybrid, recorder, etc.)
    this.ws = null;
    this.isConnected = false;

    /**
     * Latest tick per (exchangeSegment,securityId) key.
     * key = `${segment}:${securityId}` e.g. "IDX_I:13"
     */
    this.snapshot = new Map();

    /**
     * Pending subscriptions — replayed on reconnect.
     * Stored as array of { exchangeSegment, securityId, mode }.
     * mode = 'TICKER' | 'QUOTE' | 'FULL'
     */
    this.subscriptions = new Map(); // key -> subscription object

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.flushTimer = null;
    this.heartbeatTimer = null;
    this.lastMessageAt = 0;

    this._pendingSendQueue = []; // send after connect
    this._ensureSnapshotDir();
  }

  _ensureSnapshotDir() {
    try {
      if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    } catch (e) {
      logger.warn({ err: e.message }, '[liveFeedProd] could not create snapshot dir');
    }
  }

  /** Public API - connect once at server start. Returns a promise that resolves on open. */
  connect() {
    if (this.isConnected) return Promise.resolve();

    const token = env.dhanAccessToken;
    const clientId = env.dhanClientId;
    if (!token || !clientId) {
      return Promise.reject(new Error('DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID missing in env'));
    }

    const url = `${WS_BASE}?version=2&token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}&authType=2`;

    return new Promise((resolve, reject) => {
      logger.info({ url: url.replace(token, '***') }, '[liveFeedProd] Connecting to Dhan v2 WebSocket');
      this.ws = new WebSocket(url);

      // IMPORTANT: binary frames come as Buffers (ws default). Do not change.

      this.ws.on('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.lastMessageAt = Date.now();
        logger.info('[liveFeedProd] WebSocket open');

        // Flush any queued sends
        this._pendingSendQueue.forEach((m) => this._sendJson(m));
        this._pendingSendQueue = [];

        // Resubscribe to everything tracked
        if (this.subscriptions.size > 0) {
          this._replaySubscriptions();
        }

        this._startFlush();
        this._startHeartbeatCheck();
        resolve();
      });

      this.ws.on('message', (data, isBinary) => {
        this.lastMessageAt = Date.now();
        if (isBinary || Buffer.isBuffer(data)) {
          this._handleBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
        } else {
          try {
            const txt = data.toString();
            logger.info({ txt }, '[liveFeedProd] text message');
          } catch (_) {}
        }
      });

      this.ws.on('error', (err) => {
        logger.error({ err: err.message }, '[liveFeedProd] WS error');
        if (!this.isConnected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason?.toString() }, '[liveFeedProd] WS closed');
        this.isConnected = false;
        this._stopFlush();
        this._stopHeartbeatCheck();
        this._scheduleReconnect();
      });
    });
  }

  disconnect() {
    this._stopFlush();
    this._stopHeartbeatCheck();
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
    this.isConnected = false;
  }

  /**
   * Subscribe to one or more instruments.
   * @param {Array<{exchangeSegment:string, securityId:string|number}>} instruments
   * @param {'TICKER'|'QUOTE'|'FULL'} mode
   */
  subscribe(instruments, mode = 'FULL') {
    if (!Array.isArray(instruments) || instruments.length === 0) return;

    const requestCode = mode === 'TICKER' ? 15 : mode === 'QUOTE' ? 17 : 21; // FULL default
    // Dhan caps 100 instruments per message
    for (let i = 0; i < instruments.length; i += 100) {
      const slice = instruments.slice(i, i + 100);
      const msg = {
        RequestCode: requestCode,
        InstrumentCount: slice.length,
        InstrumentList: slice.map((it) => ({
          ExchangeSegment: it.exchangeSegment,
          SecurityId: String(it.securityId),
        })),
      };
      this._sendJson(msg);

      // Track locally so we can resub on reconnect
      for (const it of slice) {
        const key = this._key(it.exchangeSegment, it.securityId);
        this.subscriptions.set(key, { ...it, mode });
      }
    }
    logger.info({ count: instruments.length, mode }, '[liveFeedProd] subscribe sent');
  }

  /** Unsubscribe */
  unsubscribe(instruments, mode = 'FULL') {
    if (!Array.isArray(instruments) || instruments.length === 0) return;
    const requestCode = mode === 'TICKER' ? 16 : mode === 'QUOTE' ? 18 : 22;
    for (let i = 0; i < instruments.length; i += 100) {
      const slice = instruments.slice(i, i + 100);
      this._sendJson({
        RequestCode: requestCode,
        InstrumentCount: slice.length,
        InstrumentList: slice.map((it) => ({
          ExchangeSegment: it.exchangeSegment,
          SecurityId: String(it.securityId),
        })),
      });
      for (const it of slice) {
        this.subscriptions.delete(this._key(it.exchangeSegment, it.securityId));
      }
    }
  }

  /** Get latest tick for a single instrument */
  getTick(exchangeSegment, securityId) {
    return this.snapshot.get(this._key(exchangeSegment, securityId)) || null;
  }

  /** Return the full snapshot as plain object (for JSON persistence/consumption) */
  getSnapshot() {
    const out = {};
    for (const [k, v] of this.snapshot.entries()) out[k] = v;
    return out;
  }

  /** Return connection + subscription status */
  getStatus() {
    return {
      connected: this.isConnected,
      subscriptions: this.subscriptions.size,
      tickedSymbols: this.snapshot.size,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      snapshotFile: SNAPSHOT_FILE,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------
  _key(seg, id) {
    return `${seg}:${id}`;
  }

  _sendJson(msg) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this._pendingSendQueue.push(msg);
      return;
    }
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      logger.error({ err: e.message }, '[liveFeedProd] send failed');
    }
  }

  _replaySubscriptions() {
    const byMode = { TICKER: [], QUOTE: [], FULL: [] };
    for (const sub of this.subscriptions.values()) {
      (byMode[sub.mode] || byMode.FULL).push({
        exchangeSegment: sub.exchangeSegment,
        securityId: sub.securityId,
      });
    }
    Object.entries(byMode).forEach(([mode, list]) => {
      if (list.length) {
        logger.info({ mode, count: list.length }, '[liveFeedProd] resubscribing');
        this.subscribe(list, mode);
      }
    });
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[liveFeedProd] max reconnect attempts reached');
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts));
    setTimeout(() => {
      this.connect().catch((e) =>
        logger.error({ err: e.message, attempt: this.reconnectAttempts }, '[liveFeedProd] reconnect failed')
      );
    }, delay);
  }

  _startFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this._flushSnapshot(), SNAPSHOT_FLUSH_MS);
  }

  _stopFlush() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  _flushSnapshot() {
    try {
      const payload = {
        capturedAt: new Date().toISOString(),
        connected: this.isConnected,
        subscriptions: this.subscriptions.size,
        count: this.snapshot.size,
        ticks: this.getSnapshot(),
      };
      // Atomic write — write to .tmp then rename
      const tmp = SNAPSHOT_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(payload), (err) => {
        if (err) return logger.warn({ err: err.message }, '[liveFeedProd] snapshot tmp write failed');
        fs.rename(tmp, SNAPSHOT_FILE, (e2) => {
          if (e2) logger.warn({ err: e2.message }, '[liveFeedProd] snapshot rename failed');
        });
      });
    } catch (e) {
      logger.warn({ err: e.message }, '[liveFeedProd] flush snapshot failed');
    }
  }

  _startHeartbeatCheck() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const silentMs = Date.now() - this.lastMessageAt;
      if (silentMs > HEARTBEAT_TIMEOUT_MS) {
        logger.warn({ silentMs }, '[liveFeedProd] no messages — forcing reconnect');
        try { this.ws && this.ws.terminate(); } catch (_) {}
      }
    }, 15000);
  }

  _stopHeartbeatCheck() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Binary packet handling
  // ---------------------------------------------------------------------------
  _handleBinary(buf) {
    if (buf.length < 8) return;
    // Header: [0]=code, [1-2]=len, [3]=segmentCode, [4-7]=securityId
    // NOTE: doc says "Bytes 2-3 int16" for length and "Bytes 5-8 int32" for SID.
    //       Using offsets 0..7 for the 8-byte header. We'll match the byte layout
    //       exactly as documented.
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const code = buf.readUInt8(offset + 0);
      const msgLen = buf.readInt16LE(offset + 1);
      const segCode = buf.readUInt8(offset + 3);
      const securityId = buf.readInt32LE(offset + 4);

      // Guard against malformed length
      const packetLen = msgLen && msgLen >= 8 ? msgLen : buf.length - offset;
      if (offset + packetLen > buf.length) break; // truncated — wait for next frame

      const packet = buf.slice(offset, offset + packetLen);
      const segmentName = SEGMENT_CODE_TO_NAME[segCode] || `SEG_${segCode}`;

      try {
        this._parsePacket(code, segmentName, securityId, packet);
      } catch (e) {
        logger.warn({ err: e.message, code, len: packet.length }, '[liveFeedProd] parse error');
      }

      offset += packetLen;
    }
  }

  _parsePacket(code, segmentName, securityId, buf) {
    switch (code) {
      case 2: return this._parseTicker(segmentName, securityId, buf);
      case 4: return this._parseQuote(segmentName, securityId, buf);
      case 5: return this._parseOI(segmentName, securityId, buf);
      case 6: return this._parsePrevClose(segmentName, securityId, buf);
      case 7: return this._parseMarketStatus(segmentName, securityId, buf);
      case 8: return this._parseFull(segmentName, securityId, buf);
      case 50: return this._parseDisconnect(segmentName, securityId, buf);
      default:
        // Index packet (1) falls through — treat as ticker best-effort
        if (code === 1) return this._parseTicker(segmentName, securityId, buf);
        logger.debug({ code, segmentName, securityId, len: buf.length }, '[liveFeedProd] unknown packet');
    }
  }

  _updateSnapshot(segmentName, securityId, patch) {
    const key = this._key(segmentName, securityId);
    const prev = this.snapshot.get(key) || { exchangeSegment: segmentName, securityId };
    const next = { ...prev, ...patch, updatedAt: Date.now() };
    this.snapshot.set(key, next);

    // Emit tick event so external consumers (e.g. hybrid tick delta classifier)
    // can react. Listeners receive both the previous snapshot and the new one
    // so they can detect what actually changed (LTP, LTQ, depth, etc.) without
    // needing to re-parse the binary buffer.
    try {
      this.emit('tick', {
        key,
        segment: segmentName,
        securityId,
        prev,
        next,
        patch,
      });
    } catch (e) {
      // Listeners must not block the feed — swallow & log
      logger.warn({ err: e.message }, '[liveFeedProd] tick listener threw');
    }

    // Record spot ticks to the symbol-specific folder. Match (segment, sid)
    // against EVERY registered symbol so NIFTY ticks land in
    // live-feed/<date>_NIFTY_50/ and SENSEX ticks land in
    // live-feed/<date>_SENSEX/ — independent of which symbol is "active".
    try {
      const symbolRegistry = require('../config/symbolRegistry');
      const matched = Object.values(symbolRegistry.SYMBOLS).find(
        s => s.indexSegment === segmentName && Number(s.indexSecurityId) === Number(securityId)
      );
      if (matched) {
        feedRecorder.recordSpotTick(next, matched.key);
      }
    } catch (_) {}
    // Record futures ticks (NSE_FNO for NIFTY/BANKNIFTY, BSE_FNO for SENSEX/BANKEX).
    // We can't reverse-resolve futures securityId → symbol here without the
    // scrip-master cache, so route by exchange segment to the active symbol
    // whose futures segment matches. SENSEX uses BSE_FNO, NIFTY uses NSE_FNO.
    if (segmentName === 'NSE_FNO' || segmentName === 'BSE_FNO') {
      try {
        const symbolRegistry = require('../config/symbolRegistry');
        const matched = Object.values(symbolRegistry.SYMBOLS).find(
          s => s.futuresSegment === segmentName
        );
        if (matched) feedRecorder.recordFuturesTick(next, matched.key);
      } catch (_) {}
    }
  }

  _parseTicker(seg, sid, buf) {
    // bytes 8: LTP float32, bytes 12: LTT int32
    if (buf.length < 16) return;
    const ltp = buf.readFloatLE(8);
    const ltt = buf.readInt32LE(12);
    this._updateSnapshot(seg, sid, { ltp, ltt });
  }

  _parseQuote(seg, sid, buf) {
    // 0-7 header; 8-11 ltp, 12-13 ltq, 14-17 ltt, 18-21 atp, 22-25 vol,
    // 26-29 totSell, 30-33 totBuy, 34-37 open, 38-41 close, 42-45 high, 46-49 low
    if (buf.length < 50) return;
    this._updateSnapshot(seg, sid, {
      ltp: buf.readFloatLE(8),
      ltq: buf.readInt16LE(12),
      ltt: buf.readInt32LE(14),
      atp: buf.readFloatLE(18),
      volume: buf.readInt32LE(22),
      totalSellQty: buf.readInt32LE(26),
      totalBuyQty: buf.readInt32LE(30),
      open: buf.readFloatLE(34),
      close: buf.readFloatLE(38),
      high: buf.readFloatLE(42),
      low: buf.readFloatLE(46),
    });
  }

  _parseOI(seg, sid, buf) {
    if (buf.length < 12) return;
    const oi = buf.readInt32LE(8);
    this._updateSnapshot(seg, sid, { oi });
  }

  _parsePrevClose(seg, sid, buf) {
    if (buf.length < 16) return;
    this._updateSnapshot(seg, sid, {
      prevClose: buf.readFloatLE(8),
      prevOi: buf.readInt32LE(12),
    });
  }

  _parseMarketStatus(seg, sid, buf) {
    this._updateSnapshot(seg, sid, { marketStatus: buf.slice(8).toString() });
  }

  _parseFull(seg, sid, buf) {
    // 0-7 header;
    // 8-11 ltp, 12-13 ltq, 14-17 ltt, 18-21 atp, 22-25 vol,
    // 26-29 totSell, 30-33 totBuy, 34-37 oi, 38-41 oi_day_high,
    // 42-45 oi_day_low, 46-49 open, 50-53 close, 54-57 high, 58-61 low,
    // 62-161 depth (5 x 20 bytes)
    if (buf.length < 62) return;
    const depth = [];
    const depthStart = 62;
    if (buf.length >= depthStart + 100) {
      for (let i = 0; i < 5; i++) {
        const o = depthStart + i * 20;
        depth.push({
          bidQty: buf.readInt32LE(o),
          askQty: buf.readInt32LE(o + 4),
          bidOrders: buf.readInt16LE(o + 8),
          askOrders: buf.readInt16LE(o + 10),
          bidPrice: buf.readFloatLE(o + 12),
          askPrice: buf.readFloatLE(o + 16),
        });
      }
    }
    this._updateSnapshot(seg, sid, {
      ltp: buf.readFloatLE(8),
      ltq: buf.readInt16LE(12),
      ltt: buf.readInt32LE(14),
      atp: buf.readFloatLE(18),
      volume: buf.readInt32LE(22),
      totalSellQty: buf.readInt32LE(26),
      totalBuyQty: buf.readInt32LE(30),
      oi: buf.readInt32LE(34),
      oiDayHigh: buf.readInt32LE(38),
      oiDayLow: buf.readInt32LE(42),
      open: buf.readFloatLE(46),
      close: buf.readFloatLE(50),
      high: buf.readFloatLE(54),
      low: buf.readFloatLE(58),
      depth: depth.length ? depth : undefined,
    });
  }

  _parseDisconnect(seg, sid, buf) {
    const reason = buf.length >= 10 ? buf.readInt16LE(8) : null;
    logger.warn({ reason, seg, sid }, '[liveFeedProd] feed disconnect packet');
  }
}

// Singleton
const instance = new DhanLiveFeedProd();

module.exports = {
  instance,
  SEGMENT_NAME_TO_CODE,
  SEGMENT_CODE_TO_NAME,
  SNAPSHOT_FILE,
};
