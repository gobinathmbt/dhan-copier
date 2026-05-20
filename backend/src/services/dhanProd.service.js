/**
 * Dhan Production API service - uses the official https://api.dhan.co/v2 endpoints
 * 
 * Exposes the SAME method signatures as dhanBypass.service so that algo files can
 * migrate with a single import change. Response shapes are transformed inside this
 * service to match the bypass response shape (strikes[], candles[], expiries[], etc.).
 * 
 * Endpoints used:
 *   POST /v2/charts/intraday     — intraday OHLC (1,5,15,25,60 min)
 *   POST /v2/charts/historical   — daily OHLC
 *   POST /v2/optionchain         — full option chain with OI, IV, greeks
 *   POST /v2/optionchain/expirylist — list of active expiries
 *   POST /v2/marketfeed/ltp      — last traded price
 *   POST /v2/marketfeed/ohlc     — OHLC snapshot
 *   POST /v2/marketfeed/quote    — market depth + OI + volume
 * 
 * Headers:
 *   access-token: <JWT>
 *   client-id:    <numeric client id>
 */
const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('../utils/logger');
const env = require('../config/env');

const BASE_URL = env.dhanProdBaseUrl || 'https://api.dhan.co';
const DEFAULT_ACCESS_TOKEN = env.dhanAccessToken || '';
const DEFAULT_CLIENT_ID = env.dhanClientId || '';

// Shared HTTP agents (keep-alive for fewer TLS handshakes)
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000 });

// ----------------------------------------------------------------------------
// Retry with backoff
// ----------------------------------------------------------------------------
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Never retry auth failures
      if (error.response?.status === 401 || error.response?.status === 403) throw error;
      const is429 = error.response?.status === 429;
      const retryable =
        is429 ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        (error.response?.status >= 500 && error.response?.status < 600);
      if (!retryable || attempt === maxRetries - 1) throw error;
      // 429 rate-limit: wait longer (3s, 6s, 12s) to respect Dhan's rate limit
      const delay = is429
        ? 3000 * Math.pow(2, attempt)
        : initialDelay * Math.pow(2, attempt);
      logger.warn({ attempt: attempt + 1, delay, status: error.response?.status, err: error.message }, '[dhanProd] retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ----------------------------------------------------------------------------
// Option-chain rate limit — Dhan allows 1 request / 3 seconds per expiry/underlying
// ----------------------------------------------------------------------------
let lastOptionChainAt = 0;
const OPTION_CHAIN_COOLDOWN_MS = 3100;
async function throttleOptionChain() {
  const now = Date.now();
  const wait = OPTION_CHAIN_COOLDOWN_MS - (now - lastOptionChainAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastOptionChainAt = Date.now();
}

// In-memory expiry-list cache (default 10 min)
const EXPIRY_CACHE_TTL = 10 * 60 * 1000;
const expiryCache = new Map(); // key: `${scrip}_${seg}` -> { at, data }

// In-memory option-chain cache (3 seconds — matches Dhan rate limit)
const OC_CACHE_TTL = 3000;
const ocCache = new Map(); // key: `${scrip}_${seg}_${expiryISO}` -> { at, data }

// ----------------------------------------------------------------------------
// Exchange segment mapping — legacy (bypass) fields → Dhan production enums
// ----------------------------------------------------------------------------
// Bypass uses the { exchange, segment, instrument } triplet e.g. { IDX, I, IDX }.
// Dhan production uses a single `exchangeSegment` enum (see Annexure.md).
function mapExchangeSegment({ exchange, segment, instrument }) {
  const ex = String(exchange || '').toUpperCase();
  const sg = String(segment || '').toUpperCase();
  const inst = String(instrument || '').toUpperCase();

  // Index -> IDX_I — the Dhan Annexure only defines IDX_I (segment enum 0)
  // for ALL index spots (NIFTY 50, BANKNIFTY, SENSEX, etc.). There is NO
  // BSE_I segment in Dhan's API; SENSEX spot lives on IDX_I:51.
  if (ex === 'IDX' || inst === 'IDX' || inst === 'INDEX' || sg === 'IDX_I' || sg === 'BSE_I') {
    return { exchangeSegment: 'IDX_I', instrument: 'INDEX' };
  }
  // NSE Equity
  if (ex === 'NSE' && (sg === 'E' || inst === 'EQUITY')) {
    return { exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' };
  }
  // NSE F&O
  if (ex === 'NSE' && (sg === 'D' || inst === 'FUTIDX' || inst === 'OPTIDX' || inst === 'FUTSTK' || inst === 'OPTSTK')) {
    return { exchangeSegment: 'NSE_FNO', instrument: inst === 'IDX' ? 'FUTIDX' : inst };
  }
  // BSE Equity
  if (ex === 'BSE' && (sg === 'E' || inst === 'EQUITY')) {
    return { exchangeSegment: 'BSE_EQ', instrument: 'EQUITY' };
  }
  // BSE F&O (SENSEX / BANKEX options + futures)
  if (ex === 'BSE' && (sg === 'D' || inst === 'FUTIDX' || inst === 'OPTIDX')) {
    return { exchangeSegment: 'BSE_FNO', instrument: inst === 'IDX' ? 'FUTIDX' : inst };
  }
  // Default — treat as index
  return { exchangeSegment: 'IDX_I', instrument: 'INDEX' };
}

// Dhan production supports only 1, 5, 15, 25, 60 for intraday.
// Bypass callers pass '30' so we map it to '25'.
function mapInterval(raw) {
  const v = String(raw || '1');
  if (v === '30') return '25';
  if (['1', '5', '15', '25', '60'].includes(v)) return v;
  return '1';
}

// Unix timestamp (seconds) -> "YYYY-MM-DD HH:MM:SS" local time
function toDateTimeString(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Unix timestamp (seconds) -> "YYYY-MM-DD"
function toDateString(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Clamp fromDate to ensure Dhan accepts it (max 90 days for intraday, skip weekends)
function clampFromDate(startTs, endTs) {
  const maxSpan = 90 * 86400;
  let s = startTs;
  if (endTs - s > maxSpan) s = endTs - maxSpan;
  // Push off weekend
  const d = new Date(s * 1000);
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() + 1);
  else if (day === 6) d.setDate(d.getDate() + 2);
  return Math.floor(d.getTime() / 1000);
}

function getHeaders(authKey) {
  // The production API uses the env-level DHAN_ACCESS_TOKEN (JWT).
  // Callers from legacy bypass code pass a different auth key — ignore it unless
  // it looks like a JWT (starts with "ey" — base64 header). Otherwise fallback to env.
  const isLikelyJwt = typeof authKey === 'string' && authKey.startsWith('ey') && authKey.split('.').length === 3;
  const token = isLikelyJwt ? authKey : DEFAULT_ACCESS_TOKEN;
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'access-token': token,
    'client-id': String(DEFAULT_CLIENT_ID),
  };
}

// ============================================================================
// 1. HISTORICAL / INTRADAY OHLC — replacement for getDhanBypassData()
// ============================================================================
/**
 * Fetch OHLC candles from Dhan production API.
 * Signature-compatible with dhanBypass.getDhanBypassData() so algo files can
 * migrate with only the import path changing.
 *
 * @param {string} authKey - optional override (defaults to env.DHAN_ACCESS_TOKEN)
 * @param {object} params  - { securityId, exchange, segment, instrument, startTime, endTime, interval }
 */
async function getDhanProdData(authKey, params) {
  const {
    securityId = 13,
    exchange = 'IDX',
    segment = 'I',
    instrument = 'IDX',
    startTime,
    endTime,
    interval = '1',
  } = params || {};

  try {
    const { exchangeSegment, instrument: mappedInstrument } = mapExchangeSegment({ exchange, segment, instrument });
    const mappedInterval = mapInterval(interval);

    // If caller didn't provide a time range, default to the current trading day
    const nowSec = Math.floor(Date.now() / 1000);
    const end = endTime || nowSec;
    const start = clampFromDate(startTime || end - 86400, end);

    const fromDate = toDateTimeString(start);
    const toDate = toDateTimeString(end);

    const payload = {
      securityId: String(securityId),
      exchangeSegment,
      instrument: mappedInstrument,
      interval: mappedInterval,
      oi: false,
      fromDate,
      toDate,
    };

    logger.info({
      payload,
      url: `${BASE_URL}/v2/charts/intraday`,
    }, '[dhanProd] Fetching intraday OHLC');

    const response = await retryWithBackoff(async () => {
      return axios.post(`${BASE_URL}/v2/charts/intraday`, payload, {
        headers: getHeaders(authKey),
        timeout: 30000,
        httpAgent,
        httpsAgent,
      });
    }, 3, 1500);

    const data = response.data || {};

    if (!data.timestamp || !Array.isArray(data.timestamp) || data.timestamp.length === 0) {
      logger.warn({
        securityId,
        exchangeSegment,
        hasTimestamp: !!data.timestamp,
        dataKeys: Object.keys(data),
      }, '[dhanProd] No candles returned');
      return {
        ok: true,
        data: {
          candles: [],
          nextTime: null,
          meta: { source: 'dhan-prod', securityId, exchangeSegment, instrument: mappedInstrument, interval: mappedInterval },
        },
      };
    }

    const candles = [];
    const length = data.timestamp.length;
    for (let i = 0; i < length; i++) {
      const t = data.timestamp[i];
      const timestamp = typeof t === 'number' ? t : Math.floor(new Date(t).getTime() / 1000);
      const o = data.open?.[i];
      const h = data.high?.[i];
      const l = data.low?.[i];
      const c = data.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({
        time: timestamp,
        open: parseFloat(o),
        high: parseFloat(h),
        low: parseFloat(l),
        close: parseFloat(c),
        volume: data.volume ? parseFloat(data.volume[i]) || 0 : 0,
      });
    }

    logger.info({
      securityId,
      exchangeSegment,
      candleCount: candles.length,
      firstTime: candles[0]?.time,
      lastTime: candles[candles.length - 1]?.time,
    }, '[dhanProd] Transformed candles');

    return {
      ok: true,
      data: {
        candles,
        nextTime: null,
        meta: { source: 'dhan-prod', securityId, exchangeSegment, instrument: mappedInstrument, interval: mappedInterval },
      },
    };
  } catch (error) {
    logger.error({
      err: error.message,
      status: error.response?.status,
      response: error.response?.data,
      securityId,
    }, '[dhanProd] Failed to fetch candles');
    return {
      ok: false,
      error: error.response?.data?.errorMessage || error.response?.data?.message || error.message,
      errorCode: error.response?.data?.errorCode,
    };
  }
}

// ============================================================================
// 2. EXPIRY LIST — replacement for getExpiryListBypass()
// ============================================================================
/**
 * @param {string} authKey
 * @param {object} params - { segment = 0, securityId = 13, underlyingSeg }
 *   underlyingSeg defaults from securityId via symbolRegistry; pass to override.
 */
async function getExpiryListProd(authKey, params) {
  const { securityId = 13 } = params || {};
  // Resolve segment: explicit param wins; else look up from symbolRegistry
  // by matching securityId; else fall back to NSE indices (IDX_I).
  let underlyingSeg = params?.underlyingSeg;
  if (!underlyingSeg) {
    try {
      const symbolRegistry = require('../config/symbolRegistry');
      const match = Object.values(symbolRegistry.SYMBOLS).find(
        s => s.indexSecurityId === Number(securityId)
      );
      underlyingSeg = match?.indexSegment || 'IDX_I';
    } catch (_) {
      underlyingSeg = 'IDX_I';
    }
  }
  const cacheKey = `${securityId}_${underlyingSeg}`;
  const cached = expiryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EXPIRY_CACHE_TTL) {
    return { ok: true, data: cached.data };
  }

  try {
    const payload = {
      UnderlyingScrip: parseInt(securityId),
      UnderlyingSeg: underlyingSeg,
    };

    logger.info({ payload, url: `${BASE_URL}/v2/optionchain/expirylist` }, '[dhanProd] Fetching expiry list');

    const response = await retryWithBackoff(async () => {
      return axios.post(`${BASE_URL}/v2/optionchain/expirylist`, payload, {
        headers: getHeaders(authKey),
        timeout: 30000,
        httpAgent,
        httpsAgent,
      });
    }, 3, 2000);

    const dates = response.data?.data || [];
    if (!Array.isArray(dates) || dates.length === 0) {
      logger.warn({ response: response.data }, '[dhanProd] Empty expiry list');
      return { ok: false, error: 'Empty expiry list' };
    }

    // Get current date in IST timezone for proper comparison
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const todayIST = new Date(nowIST.getFullYear(), nowIST.getMonth(), nowIST.getDate());

    const expiries = dates
      .map((dateStr) => {
        // dateStr is "YYYY-MM-DD"
        const expiryDate = new Date(`${dateStr}T15:30:00+05:30`); // market close IST
        const exp = Math.floor(expiryDate.getTime() / 1000);
        const msPerDay = 86400 * 1000;
        const daysToExpiry = Math.round((expiryDate.getTime() - todayIST.getTime()) / msPerDay);
        return {
          exp,
          expiry: exp,
          expiryDate: expiryDate.toISOString(),
          expiryType: 'W', // production API does not expose weekly/monthly — default weekly; first-of-month detection below
          daysToExpiry,
          atmIV: null,
          pcr: null,
          displayName: `${dateStr} (${daysToExpiry}d)`,
          _raw: dateStr,
        };
      })
      .filter((e) => e.daysToExpiry >= 0)
      .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

    const result = {
      expiries,
      meta: { source: 'dhan-prod', securityId, segment: underlyingSeg },
    };
    expiryCache.set(cacheKey, { at: Date.now(), data: result });

    logger.info({
      expiryCount: expiries.length,
      firstExpiry: expiries[0]?.displayName,
      firstExp: expiries[0]?.exp,
    }, '[dhanProd] Fetched expiry list');

    return { ok: true, data: result };
  } catch (error) {
    logger.error({
      err: error.message,
      status: error.response?.status,
      response: error.response?.data,
    }, '[dhanProd] Failed to fetch expiry list');
    return {
      ok: false,
      error: error.response?.data?.errorMessage || error.response?.data?.message || error.message,
      errorCode: error.response?.data?.errorCode,
    };
  }
}

// ============================================================================
// 3. OPTION CHAIN — replacement for getOptionChainBypass()
// ============================================================================
/**
 * @param {string} authKey
 * @param {object} params - { segment = 0, expiry: <unix-ts>, securityId = 13, underlyingSeg }
 */
async function getOptionChainProd(authKey, params) {
  const { expiry, securityId = 13 } = params || {};

  try {
    // Resolve expiry — caller passes a Unix timestamp; Dhan production wants "YYYY-MM-DD"
    let expiryDateStr;
    if (expiry) {
      expiryDateStr = toDateString(expiry);
    } else {
      // Pull nearest expiry automatically
      const listRes = await getExpiryListProd(authKey, { securityId, underlyingSeg: params?.underlyingSeg });
      if (!listRes.ok || !listRes.data.expiries?.length) {
        return { ok: false, error: 'Unable to resolve nearest expiry' };
      }
      const nearest = listRes.data.expiries[0];
      expiryDateStr = nearest._raw || toDateString(nearest.exp);
    }

    // Resolve segment the same way as getExpiryListProd.
    let underlyingSeg = params?.underlyingSeg;
    let displayPrefix = 'NIFTY';
    try {
      const symbolRegistry = require('../config/symbolRegistry');
      const match = Object.values(symbolRegistry.SYMBOLS).find(
        s => s.indexSecurityId === Number(securityId)
      );
      if (match) {
        underlyingSeg = underlyingSeg || match.indexSegment;
        displayPrefix = match.futuresUnderlying || match.key.split('_')[0];
      }
    } catch (_) {}
    if (!underlyingSeg) underlyingSeg = 'IDX_I';
    const cacheKey = `${securityId}_${underlyingSeg}_${expiryDateStr}`;
    const cached = ocCache.get(cacheKey);
    if (cached && Date.now() - cached.at < OC_CACHE_TTL) {
      return { ok: true, data: cached.data };
    }

    await throttleOptionChain();

    const payload = {
      UnderlyingScrip: parseInt(securityId),
      UnderlyingSeg: underlyingSeg,
      Expiry: expiryDateStr,
    };

    logger.info({ payload, url: `${BASE_URL}/v2/optionchain` }, '[dhanProd] Fetching option chain');

    const response = await retryWithBackoff(async () => {
      return axios.post(`${BASE_URL}/v2/optionchain`, payload, {
        headers: getHeaders(authKey),
        timeout: 30000,
        httpAgent,
        httpsAgent,
      });
    }, 3, 2000);

    const body = response.data || {};
    const ocMap = body?.data?.oc || {};
    const spotLtp = body?.data?.last_price || 0;

    if (Object.keys(ocMap).length === 0) {
      logger.warn({ expiryDateStr, status: body?.status }, '[dhanProd] Empty option chain');
      return { ok: false, error: 'Empty option chain' };
    }

    // Transform strike-keyed map -> array of { strike, call, put, pcr }
    // Strike step (50 for NIFTY, 100 for SENSEX) — used for ATM threshold.
    let strikeStep = 50;
    try {
      const symbolRegistry = require('../config/symbolRegistry');
      const match = Object.values(symbolRegistry.SYMBOLS).find(
        s => s.indexSecurityId === Number(securityId)
      );
      if (match?.strikeStep) strikeStep = match.strikeStep;
    } catch (_) {}
    const atmHalfWindow = strikeStep / 2;
    const strikes = [];
    for (const [strikeStr, strikeData] of Object.entries(ocMap)) {
      const strike = parseFloat(strikeStr);
      if (!Number.isFinite(strike)) continue;
      const ce = strikeData.ce || {};
      const pe = strikeData.pe || {};

      const ceOi = ce.oi || 0;
      const cePrevOi = ce.previous_oi || 0;
      const peOi = pe.oi || 0;
      const pePrevOi = pe.previous_oi || 0;

      const ceOiChange = ceOi - cePrevOi;
      const peOiChange = peOi - pePrevOi;
      const ceOiChangePct = cePrevOi ? (ceOiChange / cePrevOi) * 100 : 0;
      const peOiChangePct = pePrevOi ? (peOiChange / pePrevOi) * 100 : 0;

      // Built-up classification (same convention bypass used)
      const classify = (priceChg, oiChg) => {
        if (oiChg > 0 && priceChg > 0) return { btyp: 1, BuiltupName: 'Long Buildup' };
        if (oiChg > 0 && priceChg < 0) return { btyp: 2, BuiltupName: 'Short Buildup' };
        if (oiChg < 0 && priceChg > 0) return { btyp: 3, BuiltupName: 'Short Covering' };
        if (oiChg < 0 && priceChg < 0) return { btyp: 4, BuiltupName: 'Long Unwinding' };
        return { btyp: 0, BuiltupName: 'Neutral' };
      };
      const cePriceChg = (ce.last_price || 0) - (ce.previous_close_price || ce.last_price || 0);
      const pePriceChg = (pe.last_price || 0) - (pe.previous_close_price || pe.last_price || 0);
      const ceBt = classify(cePriceChg, ceOiChange);
      const peBt = classify(pePriceChg, peOiChange);

      // Moneyness vs spot
      const moneyness = (() => {
        if (!spotLtp) return 'NA';
        if (Math.abs(strike - spotLtp) < atmHalfWindow) return 'ATM';
        return strike > spotLtp ? 'OTM' : 'ITM';
      })();

      // Construct display symbols (e.g. NIFTY 15MAY26 23600 CE/PE,
      // SENSEX 15MAY26 80000 CE/PE) — prefix derives from symbolRegistry.
      const expiryFormatted = expiryDateStr ? new Date(expiryDateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '').toUpperCase() : '';
      const ceDisplaySymbol = ce.trading_symbol || ce.tradingsymbol || `${displayPrefix} ${expiryFormatted} ${strike} CE`;
      const peDisplaySymbol = pe.trading_symbol || pe.tradingsymbol || `${displayPrefix} ${expiryFormatted} ${strike} PE`;

      strikes.push({
        strike,
        expiry: expiryDateStr,
        call: {
          securityId: ce.security_id,
          symbol: ceDisplaySymbol,
          displaySymbol: ceDisplaySymbol,
          ltp: ce.last_price || 0,
          change: cePriceChg,
          changePercent: ce.previous_close_price ? (cePriceChg / ce.previous_close_price) * 100 : 0,
          volume: ce.volume || 0,
          oi: ceOi,
          oiChange: ceOiChange,
          oiChangePercent: ceOiChangePct,
          iv: ce.implied_volatility || 0,
          bid: ce.top_bid_price || 0,
          ask: ce.top_ask_price || 0,
          bidQty: ce.top_bid_quantity || 0,
          askQty: ce.top_ask_quantity || 0,
          greeks: {
            delta: ce.greeks?.delta || 0,
            theta: ce.greeks?.theta || 0,
            gamma: ce.greeks?.gamma || 0,
            vega: ce.greeks?.vega || 0,
            rho: ce.greeks?.rho || 0,
          },
          moneyness,
          builtupType: ceBt.btyp,
          builtupName: ceBt.BuiltupName,
          avgPrice: ce.average_price || 0,
          previousClose: ce.previous_close_price || 0,
          previousOi: cePrevOi,
        },
        put: {
          securityId: pe.security_id,
          symbol: peDisplaySymbol,
          displaySymbol: peDisplaySymbol,
          ltp: pe.last_price || 0,
          change: pePriceChg,
          changePercent: pe.previous_close_price ? (pePriceChg / pe.previous_close_price) * 100 : 0,
          volume: pe.volume || 0,
          oi: peOi,
          oiChange: peOiChange,
          oiChangePercent: peOiChangePct,
          iv: pe.implied_volatility || 0,
          bid: pe.top_bid_price || 0,
          ask: pe.top_ask_price || 0,
          bidQty: pe.top_bid_quantity || 0,
          askQty: pe.top_ask_quantity || 0,
          greeks: {
            delta: pe.greeks?.delta || 0,
            theta: pe.greeks?.theta || 0,
            gamma: pe.greeks?.gamma || 0,
            vega: pe.greeks?.vega || 0,
            rho: pe.greeks?.rho || 0,
          },
          moneyness: moneyness === 'ATM' ? 'ATM' : moneyness === 'OTM' ? 'ITM' : 'OTM',
          builtupType: peBt.btyp,
          builtupName: peBt.BuiltupName,
          avgPrice: pe.average_price || 0,
          previousClose: pe.previous_close_price || 0,
          previousOi: pePrevOi,
        },
        pcr: {
          oi: ceOi ? peOi / ceOi : 0,
          volume: (ce.volume || 0) ? (pe.volume || 0) / (ce.volume || 0) : 0,
        },
        maxPainLoss: 0, // not provided by prod API — compute downstream if needed
      });
    }

    strikes.sort((a, b) => a.strike - b.strike);

    const result = {
      strikes,
      spotLtp,
      meta: {
        source: 'dhan-prod',
        securityId,
        expiry: expiryDateStr,
        strikeCount: strikes.length,
      },
    };

    ocCache.set(cacheKey, { at: Date.now(), data: result });

    logger.info({
      strikeCount: strikes.length,
      firstStrike: strikes[0]?.strike,
      lastStrike: strikes[strikes.length - 1]?.strike,
      spotLtp,
    }, '[dhanProd] Transformed option chain');

    return { ok: true, data: result };
  } catch (error) {
    logger.error({
      err: error.message,
      status: error.response?.status,
      response: error.response?.data,
    }, '[dhanProd] Failed to fetch option chain');
    return {
      ok: false,
      error: error.response?.data?.errorMessage || error.response?.data?.message || error.message,
      errorCode: error.response?.data?.errorCode,
    };
  }
}

// ============================================================================
// 4. OI ANALYSIS — derived from option chain (production API has no direct endpoint)
// ============================================================================
/**
 * Returns aggregate OI / Volume / PCR numbers computed across all strikes of
 * the requested expiry. Shape matches what the aggregator expects:
 *   { pcr_oi, pcr_vol, oi:{ce,pe}, vol:{ce,pe} }
 */
async function getOIAnalysis(authKey, params) {
  const { securityId = 13, expiry, underlyingSeg } = params || {};
  try {
    const ocRes = await getOptionChainProd(authKey, { securityId, expiry, underlyingSeg });
    if (!ocRes.ok) return ocRes;
    const strikes = ocRes.data.strikes || [];

    let ceOi = 0, peOi = 0, ceVol = 0, peVol = 0;
    for (const s of strikes) {
      ceOi += s.call.oi || 0;
      peOi += s.put.oi || 0;
      ceVol += s.call.volume || 0;
      peVol += s.put.volume || 0;
    }

    return {
      ok: true,
      data: {
        pcr_oi: ceOi ? peOi / ceOi : 0,
        pcr_vol: ceVol ? peVol / ceVol : 0,
        oi: { ce: ceOi, pe: peOi },
        vol: { ce: ceVol, pe: peVol },
      },
    };
  } catch (error) {
    logger.error({ err: error.message }, '[dhanProd] OI analysis failed');
    return { ok: false, error: error.message };
  }
}

// ============================================================================
// 5. OI CHANGE — derived from option chain (oi - previous_oi per strike)
// ============================================================================
async function getOIChange(authKey, params) {
  const { securityId = 13, expiry, underlyingSeg } = params || {};
  try {
    const ocRes = await getOptionChainProd(authKey, { securityId, expiry, underlyingSeg });
    if (!ocRes.ok) return ocRes;
    const strikes = ocRes.data.strikes || [];

    let ceChg = 0, peChg = 0;
    for (const s of strikes) {
      ceChg += s.call.oiChange || 0;
      peChg += s.put.oiChange || 0;
    }

    return {
      ok: true,
      data: {
        oi_change: {
          ce: ceChg,
          pe: peChg,
          net: peChg - ceChg,
        },
      },
    };
  } catch (error) {
    logger.error({ err: error.message }, '[dhanProd] OI change failed');
    return { ok: false, error: error.message };
  }
}

// ============================================================================
// 6. MARKET QUOTE — LTP / OHLC / Depth
// ============================================================================
/**
 * @param {string} authKey
 * @param {object} instrumentMap - { NSE_EQ:[11536], NSE_FNO:[49081,49082], IDX_I:[13] }
 */
async function getLTP(authKey, instrumentMap) {
  try {
    const response = await retryWithBackoff(async () => {
      return axios.post(`${BASE_URL}/v2/marketfeed/ltp`, instrumentMap, {
        headers: getHeaders(authKey),
        timeout: 15000,
        httpAgent,
        httpsAgent,
      });
    }, 3, 1000);
    return { ok: true, data: response.data?.data || {} };
  } catch (error) {
    logger.error({ err: error.message, response: error.response?.data }, '[dhanProd] LTP failed');
    return { ok: false, error: error.message };
  }
}

async function getOHLC(authKey, instrumentMap) {
  try {
    const response = await retryWithBackoff(async () => {
      return axios.post(`${BASE_URL}/v2/marketfeed/ohlc`, instrumentMap, {
        headers: getHeaders(authKey),
        timeout: 15000,
        httpAgent,
        httpsAgent,
      });
    }, 3, 1000);
    return { ok: true, data: response.data?.data || {} };
  } catch (error) {
    logger.error({ err: error.message, response: error.response?.data }, '[dhanProd] OHLC failed');
    return { ok: false, error: error.message };
  }
}

async function getQuote(authKey, instrumentMap) {
  try {
    const response = await retryWithBackoff(async () => {
      return axios.post(`${BASE_URL}/v2/marketfeed/quote`, instrumentMap, {
        headers: getHeaders(authKey),
        timeout: 15000,
        httpAgent,
        httpsAgent,
      });
    }, 3, 1000);
    return { ok: true, data: response.data?.data || {} };
  } catch (error) {
    logger.error({ err: error.message, response: error.response?.data }, '[dhanProd] Quote failed');
    return { ok: false, error: error.message };
  }
}

// ============================================================================
// 7. Helpers — time range / legacy compatibility
// ============================================================================
function calculateProdTimeRange(range, endTime = null) {
  // Reuse the bypass helper semantics so algo files do not need to change.
  const now = endTime ? new Date(endTime * 1000) : new Date();
  let day = now.getDay();
  if (day === 0) now.setDate(now.getDate() - 2);
  else if (day === 6) now.setDate(now.getDate() - 1);
  const endTimestamp = Math.floor(now.getTime() / 1000);
  const rangeToSec = {
    '1d': 86400,
    '5d': 432000,
    '1w': 604800,
    '1mo': 2592000,
    '3mo': 7776000,
    '6mo': 15552000,
    '1y': 31536000,
    '2y': 63072000,
    '5y': 157680000,
  };
  const rangeSec = rangeToSec[range] || 604800;
  let start = new Date((endTimestamp - rangeSec) * 1000);
  const sd = start.getDay();
  if (sd === 0) start.setDate(start.getDate() + 1);
  else if (sd === 6) start.setDate(start.getDate() + 2);
  return {
    startTime: Math.floor(start.getTime() / 1000),
    endTime: endTimestamp,
  };
}

// Aliases for drop-in replacement of bypass imports
module.exports = {
  // Drop-in replacements (same signatures as bypass)
  getDhanBypassData: getDhanProdData,
  getOptionChainBypass: getOptionChainProd,
  getExpiryListBypass: getExpiryListProd,
  getOIAnalysis,
  getOIChange,
  calculateBypassTimeRange: calculateProdTimeRange,

  // Native production names
  getDhanProdData,
  getOptionChainProd,
  getExpiryListProd,
  calculateProdTimeRange,
  getLTP,
  getOHLC,
  getQuote,

  // Exposed mappers for tests / controllers
  mapExchangeSegment,
  mapInterval,
};
