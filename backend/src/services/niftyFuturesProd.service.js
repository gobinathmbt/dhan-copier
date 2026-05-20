/**
 * NIFTY Futures — production edition
 * =================================
 * Resolves the current-month (near) NIFTY index futures contract from Dhan's
 * scrip master CSV and exposes:
 *   - getSecurityId()        → cached integer security id
 *   - getIntradayCandles()   → OHLC via /v2/charts/intraday
 *   - getMarketQuote()       → live LTP + OI via /v2/marketfeed/quote
 *   - subscribeLiveFeed()    → hook into dhanLiveFeedProd WebSocket
 *
 * The scrip master CSV is ~20MB so we fetch ONCE per process (cached) and
 * filter for SEM_TRADING_SYMBOL starting with 'NIFTY' + INSTRUMENT='FUTIDX' +
 * earliest future expiry date.
 *
 * All functions are production-ready — no bypass endpoints.
 */
const axios = require('axios');
const logger = require('../utils/logger');
const dhanProd = require('./dhanProd.service');
const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');

const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
const FUTURES_CACHE_TTL = 12 * 60 * 60 * 1000; // 12h — scrip master updates overnight

let cached = {
  expiresAt: 0,
  nearFut: null,    // { securityId, tradingSymbol, expiryDate, lotSize }
  nextFut: null,
};

// ---------------------------------------------------------------------------
// Parse the Dhan detailed scrip master CSV to find FUTIDX rows for the
// requested exchange + underlying. Tightly scoped because the CSV is huge.
// ---------------------------------------------------------------------------
function parseScripMasterCsvFor(text, exchFilter = 'NSE', underlyingFilter = 'NIFTY', defaultLot = 75) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(',');
  const idx = (name) => header.indexOf(name);

  const iExch = idx('EXCH_ID');
  const iSeg = idx('SEGMENT');
  const iSid = idx('SECURITY_ID')              >= 0 ? idx('SECURITY_ID')            : idx('SEM_SMST_SECURITY_ID');
  const iInst = idx('INSTRUMENT');
  const iSymbol = idx('UNDERLYING_SYMBOL');
  const iDisplay = idx('DISPLAY_NAME')         >= 0 ? idx('DISPLAY_NAME')           : idx('SEM_CUSTOM_SYMBOL');
  const iExpiry = idx('SM_EXPIRY_DATE')        >= 0 ? idx('SM_EXPIRY_DATE')         : idx('SEM_EXPIRY_DATE');
  const iLot = idx('LOT_SIZE')                 >= 0 ? idx('LOT_SIZE')               : idx('SEM_LOT_UNITS');

  const out = [];
  const exchTarget = String(exchFilter).toUpperCase();
  const undTarget = String(underlyingFilter).toUpperCase();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols[iExch] !== exchTarget) continue;
    if (cols[iInst] !== 'FUTIDX') continue;
    const sym = cols[iSymbol] || '';
    if (sym.toUpperCase() !== undTarget) continue;
    const secId = parseInt(cols[iSid], 10);
    if (!Number.isFinite(secId)) continue;
    out.push({
      securityId: secId,
      tradingSymbol: cols[iDisplay] || '',
      expiryDate: cols[iExpiry] || '',
      lotSize: parseInt(cols[iLot], 10) || defaultLot,
    });
  }
  return out;
}

// Backwards-compat: legacy NIFTY-only parser kept for the test export below.
function parseScripMasterCsv(text) {
  return parseScripMasterCsvFor(text, 'NSE', 'NIFTY', 75);
}

function byExpiryAsc(a, b) {
  return String(a.expiryDate).localeCompare(String(b.expiryDate));
}

async function loadFromScripMaster() {
  // Resolve which futures we're looking for based on the active symbol.
  // Default: NIFTY on NSE_FNO. SENSEX is on BSE_FNO with UNDERLYING_SYMBOL='SENSEX'.
  let exchFilter = 'NSE';
  let underlyingFilter = 'NIFTY';
  let defaultLot = 75;
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    const active = symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
    if (active?.futuresUnderlying) {
      underlyingFilter = active.futuresUnderlying.toUpperCase();
      // BSE_FNO segment → BSE exchange in scrip master
      if (active.futuresSegment === 'BSE_FNO') exchFilter = 'BSE';
      defaultLot = active.lotSize || defaultLot;
    }
  } catch (_) {}

  logger.info({ url: SCRIP_MASTER_URL, exchFilter, underlyingFilter }, '[niftyFuturesProd] Fetching Dhan scrip master CSV');
  const { data } = await axios.get(SCRIP_MASTER_URL, {
    timeout: 60000,
    responseType: 'text',
  });
  const all = parseScripMasterCsvFor(data, exchFilter, underlyingFilter, defaultLot);
  if (!all.length) {
    logger.warn({ exchFilter, underlyingFilter }, '[niftyFuturesProd] No FUTIDX rows found in scrip master');
    // Don't throw — degrade gracefully so SENSEX sessions can still trade
    // off spot. Caller checks getNearContract() result for null.
    cached = { expiresAt: Date.now() + FUTURES_CACHE_TTL, nearFut: null, nextFut: null };
    return cached;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcoming = all
    .filter(r => {
      const d = new Date(r.expiryDate);
      return !Number.isNaN(d.getTime()) && d >= today;
    })
    .sort(byExpiryAsc);

  if (!upcoming.length) {
    logger.warn({ exchFilter, underlyingFilter }, '[niftyFuturesProd] No upcoming futures found');
    cached = { expiresAt: Date.now() + FUTURES_CACHE_TTL, nearFut: null, nextFut: null };
    return cached;
  }

  const nearFut = upcoming[0];
  const nextFut = upcoming[1] || null;

  cached = {
    expiresAt: Date.now() + FUTURES_CACHE_TTL,
    nearFut,
    nextFut,
  };

  logger.info({
    near: { sid: nearFut.securityId, expiry: nearFut.expiryDate, symbol: nearFut.tradingSymbol, lot: nearFut.lotSize },
    next: nextFut ? { sid: nextFut.securityId, expiry: nextFut.expiryDate } : null,
  }, '[niftyFuturesProd] Resolved futures contracts');

  return cached;
}

async function ensureResolved() {
  if (cached.nearFut && Date.now() < cached.expiresAt) return cached;
  return loadFromScripMaster();
}

/**
 * Reset cached futures contracts. Call this when the active trading symbol
 * changes so the next ensureResolved() reparses the scrip master for the
 * new underlying (e.g. NIFTY → SENSEX).
 */
function resetCache() {
  cached = { expiresAt: 0, nearFut: null, nextFut: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function getNearContract() {
  const r = await ensureResolved();
  return r.nearFut;
}

async function getNextContract() {
  const r = await ensureResolved();
  return r.nextFut;
}

async function getSecurityId() {
  const c = await getNearContract();
  return c?.securityId;
}

/**
 * Fetch intraday OHLC candles for NIFTY Futures near contract.
 * @param {object} opts - { interval: '1'|'5'|'15', startTime, endTime }
 * @returns {Promise<{ok, data:{candles, meta}}>}
 */
async function getIntradayCandles({ interval = '1', startTime, endTime } = {}) {
  const c = await getNearContract();
  if (!c) return { ok: false, error: 'Could not resolve futures contract for active symbol', data: { candles: [] } };

  // Use the active symbol's exchange (NSE for NIFTY, BSE for SENSEX)
  let exchange = 'NSE';
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    const active = symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
    if (active?.futuresSegment === 'BSE_FNO') exchange = 'BSE';
  } catch (_) {}

  const nowSec = Math.floor(Date.now() / 1000);
  const end = endTime || nowSec;
  const start = startTime || end - 30 * 60;

  return dhanProd.getDhanProdData(null, {
    securityId: c.securityId,
    exchange,
    segment: 'D',
    instrument: 'FUTIDX',
    startTime: start,
    endTime: end,
    interval,
  });
}

/**
 * Live market quote for NIFTY Futures — LTP, OI, depth.
 */
async function getMarketQuote() {
  const c = await getNearContract();
  if (!c) return { ok: false, error: 'Could not resolve futures contract for active symbol' };

  // Use the right segment for the active symbol's futures.
  let segKey = 'NSE_FNO';
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    const active = symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
    if (active?.futuresSegment) segKey = active.futuresSegment;
  } catch (_) {}

  const res = await dhanProd.getQuote(null, { [segKey]: [c.securityId] });
  if (!res.ok) return res;

  const row = res.data?.[segKey]?.[String(c.securityId)];
  return {
    ok: true,
    data: {
      securityId: c.securityId,
      tradingSymbol: c.tradingSymbol,
      expiryDate: c.expiryDate,
      lotSize: c.lotSize,
      ltp: row?.last_price || 0,
      oi: row?.oi || 0,
      oiDayHigh: row?.oi_day_high || 0,
      oiDayLow: row?.oi_day_low || 0,
      volume: row?.volume || 0,
      open: row?.ohlc?.open || 0,
      high: row?.ohlc?.high || 0,
      low: row?.ohlc?.low || 0,
      close: row?.ohlc?.close || 0,
      buyQty: row?.buy_quantity || 0,
      sellQty: row?.sell_quantity || 0,
      avgPrice: row?.average_price || 0,
      upperCircuit: row?.upper_circuit_limit || 0,
      lowerCircuit: row?.lower_circuit_limit || 0,
    },
  };
}

/**
 * Subscribe the near-month contract to the live WebSocket feed.
 * Returns the security id that was subscribed so callers can fetch ticks later.
 */
async function subscribeLiveFeed(mode = 'FULL') {
  const c = await getNearContract();
  if (!c) return null;
  let segKey = 'NSE_FNO';
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    const active = symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
    if (active?.futuresSegment) segKey = active.futuresSegment;
  } catch (_) {}
  liveFeedProd.subscribe(
    [{ exchangeSegment: segKey, securityId: c.securityId }],
    mode
  );
  logger.info({ sid: c.securityId, segKey, mode }, '[niftyFuturesProd] Subscribed futures to live feed');
  return c.securityId;
}

/**
 * Read the latest tick from the live WebSocket snapshot.
 * Returns null if no tick available or if the tick is older than 5 seconds.
 */
async function getLiveTick() {
  const c = await getNearContract();
  if (!c) return null;
  let segKey = 'NSE_FNO';
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    const active = symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
    if (active?.futuresSegment) segKey = active.futuresSegment;
  } catch (_) {}
  const tick = liveFeedProd.getTick(segKey, c.securityId);
  if (!tick || typeof tick.ltp !== 'number') return null;
  if (!tick.updatedAt || Date.now() - tick.updatedAt > 5000) return null;
  return {
    ...tick,
    expiryDate: c.expiryDate,
    lotSize: c.lotSize,
  };
}

/**
 * Compute a few lightweight analytics from candles — premium over spot,
 * trend direction, and momentum — so the entry/monitor engines get a
 * concise summary instead of every candle.
 */
function analyzeCandles(candles, spotLtp) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return { trend: 'unknown', momentum: 0, premium: 0, lastClose: null };
  }
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const first = closes[0];
  const pctChange = ((last - first) / first) * 100;

  let trend = 'neutral';
  if (pctChange > 0.15) trend = 'bullish';
  else if (pctChange < -0.15) trend = 'bearish';

  // Very short-term momentum — last 5 closes up or down
  let up = 0, down = 0;
  for (let i = Math.max(1, closes.length - 5); i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) up++;
    else if (closes[i] < closes[i - 1]) down++;
  }
  const momentum = up - down; // -5..+5

  const premium = spotLtp ? last - spotLtp : 0;

  return {
    trend,
    momentum,
    premium: Number(premium.toFixed(2)),
    lastClose: last,
    sessionHigh: Math.max(...candles.map(c => c.high)),
    sessionLow: Math.min(...candles.map(c => c.low)),
    candleCount: candles.length,
  };
}

module.exports = {
  getSecurityId,
  getNearContract,
  getNextContract,
  getIntradayCandles,
  getMarketQuote,
  subscribeLiveFeed,
  getLiveTick,
  analyzeCandles,
  resetCache,
  // exposed for tests
  _parseScripMasterCsv: parseScripMasterCsv,
  _parseScripMasterCsvFor: parseScripMasterCsvFor,
};
