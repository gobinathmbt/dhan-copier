/**
 * Intel Service — Institutional Intelligence Snapshot
 * ====================================================
 * Read-only composer that calls the existing hybrid engines + tick delta
 * classifier + microstructure engine + futures leadership + derivatives
 * engine and returns ONE flat JSON shape that the institutional terminal
 * UI consumes via `GET /api/intel/snapshot?symbol=...`.
 *
 * No engine state mutation. No order placement. No DB writes. Pure read.
 *
 * MARKET-CLOSED FALLBACK
 * ----------------------
 * When the live feed is empty (market closed / pre-open), we fetch the
 * LAST trading day's intraday + option-chain directly from the Dhan
 * production API so the UI still shows a meaningful snapshot focused on
 * primary strike ± 4.
 */

const env = require('../config/env');
const axios = require('axios');
const logger = require('../utils/logger');
const symbolRegistry = require('../config/symbolRegistry');
const aggregator = require('./scalpingDataAggregator.service');
const dhanProd = require('./dhanProd.service');
const niftyFuturesProd = require('./niftyFuturesProd.service');
const settings = require('../config/algoSettings').getSettings();

// Hybrid engines (deterministic, no AI)
const sessionEngine = require('./hybrid/sessionEngine');
const marketRegimeEngine = require('./hybrid/marketRegimeEngine');
const volatilityRegimeEngine = require('./hybrid/volatilityRegimeEngine');
const marketStructureEngine = require('./hybrid/marketStructureEngine');
const liquidityEngine = require('./hybrid/liquidityEngine');
const derivativesEngine = require('./hybrid/derivativesEngine');
const volumeAnalysisEngine = require('./hybrid/volumeAnalysisEngine');
const oiAnalyticsEngine = require('./hybrid/oiAnalyticsEngine');
const utBotEngine = require('./hybrid/utBotEngine');
const trapDetectionEngine = require('./hybrid/trapDetectionEngine');
const confidenceScoringEngine = require('./hybrid/confidenceScoringEngine');
const metaRegimeEngine = require('./hybrid/metaRegimeEngine');
const gammaRegimeEngine = require('./hybrid/gammaRegimeEngine');
const mtfStructureEngine = require('./hybrid/mtfStructureEngine');
const orderflowStateEngine = require('./hybrid/orderflowStateEngine');
const microstructureEngine = require('./hybrid/microstructureEngine');
const futuresLeadershipEngine = require('./hybrid/futuresLeadershipEngine');
const deltaVelocityEngine = require('./hybrid/deltaVelocityEngine');
const aggressionModeEngine = require('./hybrid/aggressionModeEngine');

const { instance: tickDelta } = require('./hybrid/tickDeltaClassifier');

// Algorithm services
const liquidityAnalysis = require('./algorithms/liquidityAnalysis.service');
const smartMoneyConcepts = require('./algorithms/smartMoneyConcepts.service');
const marketInternals = require('./algorithms/marketInternals.service');
const globalMarkets = require('./algorithms/globalMarkets.service');

// Single short-lived cache so multiple UI clients don't hammer the
// aggregator. The aggregator does network + disk reads; cap at 1.5s.
const _cache = new Map(); // key: symbol → { at, payload }
const CACHE_MS = 1500;

// Macro data (VIX, FII/DII, GIFT NIFTY, US futures) updates slowly. Cache
// for 60s so we don't spam Yahoo / Sensibull with every UI poll.
const _macroCache = { at: 0, data: null };
const MACRO_CACHE_MS = 60_000;

const YAHOO_API = 'https://query1.finance.yahoo.com/v8/finance/chart';

async function _yahooQuote(symbol) {
  try {
    const url = `${YAHOO_API}/${symbol}?interval=1d&range=2d`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const result = res.data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const quote = result.indicators?.quote?.[0];
    const last = meta?.regularMarketPrice ?? quote?.close?.[quote.close.length - 1];
    const prev = meta?.chartPreviousClose ?? quote?.close?.[quote.close.length - 2];
    if (!Number.isFinite(last) || !Number.isFinite(prev)) return null;
    const change = last - prev;
    const changePct = (change / prev) * 100;
    return {
      symbol,
      price: Number(last.toFixed(4)),
      change: Number(change.toFixed(4)),
      changePct: Number(changePct.toFixed(2)),
      previousClose: Number(prev.toFixed(4)),
    };
  } catch (e) {
    logger.warn({ err: e.message, symbol }, '[intel] yahoo quote failed');
    return null;
  }
}

/**
 * Macro context bundle — VIX, GIFT NIFTY, US futures, DXY, Crude, FII/DII.
 * Cached to 60s.
 */
async function _getMacroContext() {
  if (Date.now() - _macroCache.at < MACRO_CACHE_MS && _macroCache.data) {
    return _macroCache.data;
  }
  const [
    vix,
    giftNifty,
    sp500Fut,
    nasdaqFut,
    dxy,
    crude,
    nikkei,
  ] = await Promise.all([
    _yahooQuote('^INDIAVIX'),
    // GIFT NIFTY (NSE IFSC) — Yahoo carries it as GIFTNIFTY=F when available;
    // fall back to ^NSEI futures proxy.
    _yahooQuote('^NSEI'),
    _yahooQuote('ES=F'),
    _yahooQuote('NQ=F'),
    _yahooQuote('DX-Y.NYB'),
    _yahooQuote('CL=F'),
    _yahooQuote('^N225'),
  ]);

  let fiiDii = null;
  try {
    fiiDii = await marketInternals.fetchInstitutionalFlowData();
  } catch (e) {
    logger.warn({ err: e.message }, '[intel] FII/DII fetch failed');
  }

  const data = {
    vix,                                // India VIX
    giftNifty,                          // GIFT NIFTY proxy
    usFutures: { sp500: sp500Fut, nasdaq: nasdaqFut },
    dxy,
    crude,
    nikkei,
    fiiDii,
  };
  _macroCache.at = Date.now();
  _macroCache.data = data;
  return data;
}

// ── INDIAN-MARKET-WEIGHT HEAVYWEIGHTS (NIFTY 50 top contributors) ────────
// Pulls Yahoo last-trade for the top weight stocks so the UI can show
// who's actually moving the index. Symbols use NSE Yahoo suffix (.NS).
const NIFTY_HEAVYWEIGHTS = [
  { symbol: 'HDFCBANK.NS', name: 'HDFC Bank', weight: 13.3 },
  { symbol: 'RELIANCE.NS', name: 'Reliance', weight: 9.5 },
  { symbol: 'ICICIBANK.NS', name: 'ICICI Bank', weight: 8.5 },
  { symbol: 'INFY.NS', name: 'Infosys', weight: 5.8 },
  { symbol: 'BHARTIARTL.NS', name: 'Bharti Airtel', weight: 4.7 },
  { symbol: 'TCS.NS', name: 'TCS', weight: 4.4 },
  { symbol: 'LT.NS', name: 'L&T', weight: 3.9 },
  { symbol: 'ITC.NS', name: 'ITC', weight: 3.5 },
];

const _heavyweightCache = { at: 0, data: null };
async function _getHeavyweights() {
  if (Date.now() - _heavyweightCache.at < MACRO_CACHE_MS && _heavyweightCache.data) {
    return _heavyweightCache.data;
  }
  const rows = await Promise.all(
    NIFTY_HEAVYWEIGHTS.map(async (s) => {
      const q = await _yahooQuote(s.symbol);
      return { ...s, ...(q || {}) };
    })
  );
  const valid = rows.filter((r) => Number.isFinite(r.changePct));
  // Weighted contribution to index movement
  const weightedAvg = valid.length
    ? valid.reduce((acc, r) => acc + r.changePct * r.weight, 0) /
      valid.reduce((acc, r) => acc + r.weight, 0)
    : 0;
  const data = {
    rows,
    weightedAvgChangePct: Number(weightedAvg.toFixed(2)),
    leaders: [...valid].sort((a, b) => b.changePct - a.changePct).slice(0, 3),
    laggards: [...valid].sort((a, b) => a.changePct - b.changePct).slice(0, 3),
  };
  _heavyweightCache.at = Date.now();
  _heavyweightCache.data = data;
  return data;
}

/**
 * Classic CPR (Central Pivot Range) from prior-day OHLC.
 *   Pivot   = (H + L + C) / 3
 *   BC      = (H + L) / 2
 *   TC      = 2*Pivot - BC
 *   R1/R2/R3, S1/S2/S3 standard formulas.
 *   Width   = TC - BC (narrow = breakout day; wide = range day)
 */
function _computeCPR(priorDay) {
  if (!priorDay) return null;
  const { high: H, low: L, close: C } = priorDay;
  if (![H, L, C].every(Number.isFinite)) return null;
  const pivot = (H + L + C) / 3;
  const bc = (H + L) / 2;
  const tc = 2 * pivot - bc;
  const r1 = 2 * pivot - L;
  const s1 = 2 * pivot - H;
  const r2 = pivot + (H - L);
  const s2 = pivot - (H - L);
  const r3 = H + 2 * (pivot - L);
  const s3 = L - 2 * (H - pivot);
  const width = Math.abs(tc - bc);
  // Heuristic: < 0.15% of pivot is "narrow CPR" → high-momentum day expected
  const widthPct = (width / pivot) * 100;
  let widthClass = 'normal';
  if (widthPct < 0.15) widthClass = 'narrow';
  else if (widthPct > 0.40) widthClass = 'wide';
  return {
    pivot: Number(pivot.toFixed(2)),
    tc: Number(tc.toFixed(2)),
    bc: Number(bc.toFixed(2)),
    r1: Number(r1.toFixed(2)),
    r2: Number(r2.toFixed(2)),
    r3: Number(r3.toFixed(2)),
    s1: Number(s1.toFixed(2)),
    s2: Number(s2.toFixed(2)),
    s3: Number(s3.toFixed(2)),
    width: Number(width.toFixed(2)),
    widthPct: Number(widthPct.toFixed(3)),
    widthClass,
  };
}

/**
 * Anchored VWAP from a custom anchor index. Returns the AVWAP value.
 * Supports two anchors: 'session' (first bar) and 'prior_close' (open bar).
 */
function _anchoredVwap(candles, anchorIdx = 0) {
  if (!Array.isArray(candles) || candles.length <= anchorIdx) return null;
  let pvSum = 0;
  let vSum = 0;
  for (let i = anchorIdx; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pvSum += tp * v;
    vSum += v;
  }
  return vSum > 0 ? Number((pvSum / vSum).toFixed(2)) : null;
}

/**
 * Master Verdict — fuses every score into ONE side decision.
 * Returns:
 *   {
 *     side: 'CE'|'PE'|'NEUTRAL',
 *     score: 0..100  (probability of CE side; PE = 100 - score),
 *     verdict: 'STRONG_BULLISH' | 'BULLISH' | 'BEARISH' | 'STRONG_BEARISH' | 'NEUTRAL',
 *     factors: { ...per-factor contributions },
 *   }
 */
function _masterVerdict({
  derivatives, futuresLead, delta, volumeAnalysis, oiAnalytics,
  microstructure, internals, vix, gift, vwapAnalysis, spotPrice,
  emaStack, cpr, heavyweights, fiiDii, traps, gammaRegime,
}) {
  // Each factor returns a contribution in -100..+100 (positive = bullish bias for CE).
  // We weight them per the institutional spec and average to a 0..100 CE probability.
  const f = {};

  // 1. Derivatives direction (OI, PCR, max-pain) — weight 25
  f.derivatives = derivatives?.directionScore != null
    ? (Number(derivatives.directionScore) - 50) * 2
    : 0;

  // 2. Futures leadership — weight 12
  if (futuresLead?.available !== false) {
    const lls = Number(futuresLead?.leadLagScore ?? 50);
    f.futures = (lls - 50) * 2;
  } else f.futures = 0;

  // 3. Delta velocity — weight 10
  f.delta = volumeAnalysis?.delta?.bias === 'bullish' ? 60
    : volumeAnalysis?.delta?.bias === 'bearish' ? -60
    : volumeAnalysis?.delta?.bias === 'mild_bullish' ? 30
    : volumeAnalysis?.delta?.bias === 'mild_bearish' ? -30
    : 0;

  // 4. VWAP position — weight 8
  if (Number.isFinite(spotPrice) && Number.isFinite(vwapAnalysis?.vwap)) {
    const distPct = ((spotPrice - vwapAnalysis.vwap) / vwapAnalysis.vwap) * 100;
    f.vwap = Math.max(-50, Math.min(50, distPct * 100));
  } else f.vwap = 0;

  // 5. EMA stack — weight 7
  const { ema9, ema20, ema50 } = emaStack || {};
  if ([ema9, ema20, ema50].every(Number.isFinite)) {
    if (ema9 > ema20 && ema20 > ema50) f.ema = 60;
    else if (ema9 < ema20 && ema20 < ema50) f.ema = -60;
    else if (ema9 > ema20) f.ema = 25;
    else if (ema9 < ema20) f.ema = -25;
    else f.ema = 0;
  } else f.ema = 0;

  // 6. CPR position — weight 5
  if (cpr && Number.isFinite(spotPrice)) {
    if (spotPrice > cpr.tc) f.cpr = 40;
    else if (spotPrice < cpr.bc) f.cpr = -40;
    else f.cpr = 0;
  } else f.cpr = 0;

  // 7. Heavyweights weighted contribution — weight 8
  if (heavyweights?.weightedAvgChangePct != null) {
    f.heavyweights = Math.max(-60, Math.min(60, heavyweights.weightedAvgChangePct * 50));
  } else f.heavyweights = 0;

  // 8. India VIX — weight 4 (rising VIX = mild bearish for option BUYERS to be long
  //    delta; high VIX with up move = strong)
  if (vix?.changePct != null) {
    f.vix = -Math.max(-30, Math.min(30, vix.changePct * 5));
  } else f.vix = 0;

  // 9. GIFT NIFTY — weight 5 (premarket / overnight bias)
  if (gift?.changePct != null) {
    f.gift = Math.max(-50, Math.min(50, gift.changePct * 25));
  } else f.gift = 0;

  // 10. FII/DII cash flow — weight 6
  if (fiiDii?.cash) {
    const fiiVal = Number(fiiDii.cash.fii?.buy_sell_difference) || 0;
    const diiVal = Number(fiiDii.cash.dii?.buy_sell_difference) || 0;
    const netCr = (fiiVal + diiVal) / 100; // ₹ Cr
    f.fiiDii = Math.max(-40, Math.min(40, netCr / 50));
  } else f.fiiDii = 0;

  // 11. Volume / FRVP acceptance — weight 5
  if (volumeAnalysis?.acceptance === 'above_va') f.volumeAccept = 30;
  else if (volumeAnalysis?.acceptance === 'below_va') f.volumeAccept = -30;
  else f.volumeAccept = 0;

  // 12. Microstructure — weight 4
  if (microstructure?.available !== false) {
    f.microstructure = (Number(microstructure?.score ?? 50) - 50) * 1.5;
  } else f.microstructure = 0;

  // 13. OI quality + writers — weight 6
  const peWriting = !!oiAnalytics?.classification?.includes?.('pe_writing') || !!oiAnalytics?.peWriting;
  const ceWriting = !!oiAnalytics?.classification?.includes?.('ce_writing') || !!oiAnalytics?.ceWriting;
  if (peWriting) f.oiWriters = 30;
  else if (ceWriting) f.oiWriters = -30;
  else f.oiWriters = 0;

  // 14. Trap penalty — weight 5 (subtract from prevailing direction)
  const trapPen = Number(traps?.trapScore || 0) >= 60 ? -25 : 0;
  f.trap = trapPen;

  // 15. Gamma regime — weight 3
  f.gamma = gammaRegime?.state === 'negative' ? 0
    : gammaRegime?.state === 'positive' ? 0   // neutral for direction (causes pinning)
    : 0;

  // Weights
  const W = {
    derivatives: 0.25, futures: 0.12, delta: 0.10, vwap: 0.08,
    ema: 0.07, cpr: 0.05, heavyweights: 0.08, vix: 0.04,
    gift: 0.05, fiiDii: 0.06, volumeAccept: 0.05,
    microstructure: 0.04, oiWriters: 0.06, trap: 0.05, gamma: 0.03,
  };
  let composite = 0;
  for (const k of Object.keys(W)) {
    composite += (f[k] || 0) * W[k];
  }
  // composite is in roughly -100..+100. Map to 0..100 CE probability.
  const cePct = Math.max(0, Math.min(100, 50 + composite / 2));
  const pePct = 100 - cePct;
  let verdict = 'NEUTRAL';
  let side = 'NEUTRAL';
  if (cePct >= 70) { verdict = 'STRONG_BULLISH'; side = 'CE'; }
  else if (cePct >= 58) { verdict = 'BULLISH'; side = 'CE'; }
  else if (cePct <= 30) { verdict = 'STRONG_BEARISH'; side = 'PE'; }
  else if (cePct <= 42) { verdict = 'BEARISH'; side = 'PE'; }

  return {
    side,
    verdict,
    cePct: Number(cePct.toFixed(1)),
    pePct: Number(pePct.toFixed(1)),
    factors: f,
    weights: W,
  };
}

/**
 * Best-Strike Picker — given the master verdict and the ATM ±4 ladder,
 * picks the single strike to BUY on each side with the best risk/reward.
 *   - prefers OTM > ATM > ITM (per algoSettings)
 *   - delta band 0.30..0.55
 *   - rejects zero-premium (≤ 0.50) garbage
 *   - rejects sub-50K OI
 */
function _pickBestStrike(side /* 'CE'|'PE' */, ladder, atmStrike) {
  if (!Array.isArray(ladder) || !atmStrike) return null;
  const candidates = ladder
    .map((row) => {
      const leg = side === 'CE' ? row.ce : row.pe;
      const dir = side === 'CE' ? 1 : -1;
      const moneyness = (row.strike - atmStrike) * dir;  // +50 OTM CE, -50 ITM CE
      const ltp = leg.ltp || 0;
      const oi = leg.oi || 0;
      const deltaAbs = Math.abs(leg.delta || 0);
      let score = 0;
      // Delta band reward
      if (deltaAbs >= 0.30 && deltaAbs <= 0.55) score += 30;
      else if (deltaAbs >= 0.20 && deltaAbs <= 0.65) score += 18;
      else score += 5;
      // Moneyness preference: slight OTM ideal for buyers
      if (moneyness === 0) score += 10;       // ATM
      else if (moneyness === 50 || moneyness === 100) score += 14; // 1-2 OTM
      else if (moneyness < 0) score -= 10;     // ITM theta drag
      // Premium floor
      if (ltp < 0.5) score -= 60;
      else if (ltp < 5) score -= 20;
      else if (ltp >= 20 && ltp <= 250) score += 10;
      // OI liquidity
      if (oi >= 1_000_000) score += 8;
      else if (oi >= 100_000) score += 4;
      else if (oi < 50_000) score -= 30;
      // Per-strike health (already computed)
      const hScore = leg.health?.score ?? 50;
      score += (hScore - 50) * 0.5;
      return { row, leg, score, moneyness, ltp, oi, deltaAbs };
    })
    .filter((c) => c.ltp > 0.5)            // exclude pure dead premium
    .sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

/** Translate master cePct + best-strike pick into a clean "trade plan" */
function _buildTradePlan(verdict, ladder, atmStrike, futures, premiumHealth) {
  const winningSide = verdict.side === 'CE' || verdict.side === 'PE' ? verdict.side : null;
  if (!winningSide) {
    return {
      action: 'NO_TRADE',
      reason: 'master verdict neutral — wait for clear bias',
      pick: null,
    };
  }
  const pick = _pickBestStrike(winningSide, ladder, atmStrike);
  if (!pick) {
    return {
      action: 'NO_TRADE',
      reason: 'no liquid strike found in ATM ±4 with healthy premium',
      pick: null,
    };
  }
  // Naive 1:1.5 plan: target = 1.5× SL on premium points
  const ltp = pick.leg.ltp;
  const sl = Number((ltp * 0.85).toFixed(2));         // -15%
  const target = Number((ltp * 1.225).toFixed(2));    // +22.5% (~1.5R)
  const slPts = Number((ltp - sl).toFixed(2));
  const targetPts = Number((target - ltp).toFixed(2));
  return {
    action: `BUY_${winningSide}`,
    reason: `${verdict.verdict} — ${winningSide} ${pick.row.strike}`,
    pick: {
      side: winningSide,
      strike: pick.row.strike,
      ltp,
      delta: pick.leg.delta,
      iv: pick.leg.iv,
      oi: pick.leg.oi,
      gamma: pick.leg.gamma,
      theta: pick.leg.theta,
      health: pick.leg.health,
      moneyness: pick.moneyness > 0 ? 'OTM' : pick.moneyness < 0 ? 'ITM' : 'ATM',
      sl,
      target,
      slPts,
      targetPts,
      rr: Number((targetPts / Math.max(0.01, slPts)).toFixed(2)),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// CONSOLE WIDGET BUILDERS — produce the exact shape the dashboard UI needs
// ──────────────────────────────────────────────────────────────────────────

/** Convert a raw OI value to "X.XX L" or "X.XX Cr" */
function _fmtOiCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return { val: Number((v / 1e7).toFixed(2)), unit: 'Cr' };
  if (Math.abs(v) >= 1e5) return { val: Number((v / 1e5).toFixed(2)), unit: 'L' };
  return { val: Number(v.toFixed(0)), unit: '' };
}

/** Build a CVD time series from rolling tick buckets. */
function _cvdSeries(buckets) {
  if (!Array.isArray(buckets) || !buckets.length) return [];
  let cum = 0;
  return buckets.map((b) => {
    cum += Number(b.delta) || 0;
    return { t: b.start, cvd: cum, lastLtp: b.lastLtp || null };
  });
}

/** Per-strike OI change histogram for the OI Analysis card. */
function _oiChangeHistogram(strikes, atmStrike, range = 6) {
  if (!Array.isArray(strikes) || !atmStrike) return [];
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const idx = sorted.findIndex((s) => s.strike === atmStrike);
  if (idx < 0) return [];
  const start = Math.max(0, idx - range);
  const end = Math.min(sorted.length, idx + range + 1);
  return sorted.slice(start, end).map((s) => ({
    strike: s.strike,
    isAtm: s.strike === atmStrike,
    ceOiChg: Number(s.call?.oiChange ?? 0),
    peOiChg: Number(s.put?.oiChange ?? 0),
  }));
}

/**
 * Build the 9 status widgets for the top row of the dashboard.
 */
function _statusWidgets({ verdict, smartMoney, futuresLead, oiBlock, volumeAnalysis,
                          spotPrice, vwap, traps, trapRisk, tradePlan, confidence,
                          marketRegime }) {
  const cePct = verdict?.cePct ?? 50;
  const pePct = verdict?.pePct ?? 50;

  const marketState =
    cePct >= 60 ? { label: 'BULLISH', tone: 'bull', sub: marketRegime?.regime === 'trending_bullish' ? 'Trend Day' : 'Bull Bias' }
    : cePct <= 40 ? { label: 'BEARISH', tone: 'bear', sub: marketRegime?.regime === 'trending_bearish' ? 'Trend Day' : 'Bear Bias' }
    : { label: 'NEUTRAL', tone: 'neutral', sub: 'Range Day' };

  const smValue = smartMoney?.label === 'buyers_aggressive' ? 'BUYERS ACTIVE'
    : smartMoney?.label === 'sellers_aggressive' ? 'SELLERS ACTIVE'
    : smartMoney?.label === 'absorption' ? 'ABSORPTION'
    : 'NEUTRAL';
  const smTone = smartMoney?.label === 'buyers_aggressive' ? 'bull'
    : smartMoney?.label === 'sellers_aggressive' ? 'bear'
    : smartMoney?.label === 'absorption' ? 'info' : 'neutral';

  const futuresStrong = (futuresLead?.score ?? 50) >= 60;
  const futuresWeak   = (futuresLead?.score ?? 50) <= 40;
  const futuresState = futuresStrong
    ? { label: 'STRONG', tone: 'bull', sub: 'Premium Rising' }
    : futuresWeak
      ? { label: 'WEAK', tone: 'bear', sub: 'Premium Falling' }
      : { label: 'SYNCED', tone: 'neutral', sub: 'In Sync' };

  const oiState = oiBlock?.pe_writing ? { label: 'PE WRITING', tone: 'bull', sub: 'Support Building' }
    : oiBlock?.ce_writing ? { label: 'CE WRITING', tone: 'bear', sub: 'Resistance Building' }
    : oiBlock?.pe_unwinding ? { label: 'PE UNWIND', tone: 'bear', sub: 'Long Unwind' }
    : oiBlock?.ce_unwinding ? { label: 'CE UNWIND', tone: 'bull', sub: 'Short Cover' }
    : { label: 'BALANCED', tone: 'neutral', sub: 'Mixed' };

  const dBias = volumeAnalysis?.delta?.bias || 'neutral';
  const deltaState = dBias === 'bullish' || dBias === 'mild_bullish' ? { label: 'POSITIVE', tone: 'bull', sub: 'Buyers Dominant' }
    : dBias === 'bearish' || dBias === 'mild_bearish' ? { label: 'NEGATIVE', tone: 'bear', sub: 'Sellers Dominant' }
    : { label: 'BALANCED', tone: 'neutral', sub: 'Equal Flow' };

  const vwapState = !Number.isFinite(spotPrice) || !Number.isFinite(vwap) || vwap === 0
    ? { label: '—', tone: 'neutral', sub: 'No VWAP' }
    : spotPrice > vwap ? { label: 'ABOVE VWAP', tone: 'bull', sub: 'Bullish Control' }
    : { label: 'BELOW VWAP', tone: 'bear', sub: 'Bearish Control' };

  const trapState = trapRisk === 'high' ? { label: 'HIGH', tone: 'bear', sub: 'Risky Setup' }
    : trapRisk === 'medium' ? { label: 'MED', tone: 'warn', sub: 'Watch Setup' }
    : { label: 'LOW', tone: 'bull', sub: 'High Prob Setup' };

  const action = tradePlan?.action || 'NO_TRADE';
  const pick = tradePlan?.pick;
  const actionLabel = action === 'BUY_CE' ? `BUY CE${pick ? ' ON DIP' : ''}`
    : action === 'BUY_PE' ? `BUY PE${pick ? ' ON DIP' : ''}`
    : action === 'WAIT' ? 'WAIT'
    : 'NO TRADE';
  const actionTone = action === 'BUY_CE' ? 'bull' : action === 'BUY_PE' ? 'bear' : action === 'WAIT' ? 'warn' : 'neutral';
  const actionSub = pick
    ? `${pick.strike} ${pick.side} @ ₹${pick.ltp}`
    : tradePlan?.reason || '';

  const confLabel = confidence >= 80 ? 'High Conviction'
    : confidence >= 65 ? 'Strong Setup'
    : confidence >= 50 ? 'Moderate'
    : 'Low Conviction';

  return {
    marketState:    { ...marketState, key: 'MARKET STATE' },
    smartMoney:     { label: smValue, tone: smTone, sub: 'Aggressive Buying', key: 'SMART MONEY' },
    futures:        { ...futuresState, key: 'FUTURES' },
    oiStructure:    { ...oiState, key: 'OI STRUCTURE' },
    delta:          { ...deltaState, key: 'DELTA' },
    vwap:           { ...vwapState, key: 'VWAP' },
    trapRisk:       { ...trapState, key: 'TRAP RISK' },
    bestAction:     { label: actionLabel, tone: actionTone, sub: actionSub, key: 'BEST ACTION' },
    confidence:     { score: Math.round(confidence), label: confLabel, key: 'CONFIDENCE SCORE' },
  };
}

/**
 * Build the heavyweight contribution table with NIFTY-index point impact.
 * Index impact = stock_change_pct × stock_weight_pct × (index_value / 100)
 * (rough approximation; actual index uses free-float weights + divisors)
 */
function _heavyweightImpact(heavy, indexValue) {
  if (!heavy?.rows?.length || !indexValue) return [];
  return heavy.rows.map((r) => {
    const chg = Number(r.changePct ?? 0);
    const w = Number(r.weight ?? 0);
    const impactPts = Number(((chg / 100) * (w / 100) * indexValue).toFixed(2));
    return {
      symbol: r.symbol?.replace('.NS', '') || r.name,
      name: r.name,
      last: Number(r.price ?? 0),
      changePct: chg,
      weight: w,
      impactPts,
    };
  });
}

/**
 * Total heavyweight index-point contribution.
 */
function _heavyweightTotalImpact(rows) {
  if (!rows?.length) return 0;
  return Number(rows.reduce((s, r) => s + (Number(r.impactPts) || 0), 0).toFixed(2));
}

/**
 * Market breadth from heavyweights — advancing / declining / unchanged.
 */
function _breadth(heavyRows) {
  let adv = 0, dec = 0, unc = 0;
  for (const r of heavyRows || []) {
    const c = Number(r.changePct ?? r.chgPct ?? 0);
    if (c > 0.05) adv++;
    else if (c < -0.05) dec++;
    else unc++;
  }
  // Scale to a "feel like" 2500 NSE universe via × 142 fudge so the donut
  // isn't useless when we only have 8 stocks. This is a UI proxy only.
  const universe = 2470;
  const total = Math.max(1, adv + dec + unc);
  const advN = Math.round(adv / total * universe);
  const decN = Math.round(dec / total * universe);
  const uncN = Math.max(0, universe - advN - decN);
  const adRatio = decN ? Number((advN / decN).toFixed(2)) : 0;
  const advPct = Number((advN / universe * 100).toFixed(0));
  return {
    advancing: advN,
    declining: decN,
    unchanged: uncN,
    adRatio,
    advancePct: advPct,
    raw: { adv, dec, unc },
  };
}

/**
 * IV Rank classification: where today's ATM IV sits in the range.
 * Without history we use a static band: <12 LOW, 12-18 MODERATE, 18-28 HIGH, >28 EXTREME.
 */
function _ivRank(atmIv, vix) {
  const iv = Number(atmIv) || 0;
  if (iv >= 28) return { score: 78, label: 'HIGH', tone: 'bear' };
  if (iv >= 18) return { score: Math.round(40 + (iv - 18) * 3.8), label: 'MODERATE', tone: 'warn' };
  if (iv >= 12) return { score: Math.round(20 + (iv - 12) * 3.3), label: 'MODERATE', tone: 'warn' };
  if (iv >= 6)  return { score: Math.round(iv * 3.3), label: 'LOW', tone: 'bull' };
  return { score: 0, label: 'DEAD', tone: 'neutral' };
}

/**
 * Trap detector mapping the 8 internal detectors → 5 named UI traps.
 */
function _trapDetectorRows(traps) {
  const b = traps?.breakdown || {};
  const score = (k) => Number(b[k]?.score || 0);
  return [
    { key: 'fakeBreakout',    label: 'Fake Breakout',    detected: score('breakoutIntoHvn') >= 30 || score('weakDeltaBreakout') >= 50 },
    { key: 'fakeBreakdown',   label: 'Fake Breakdown',   detected: score('failedVwapHold') >= 40 },
    { key: 'liquiditySweep',  label: 'Liquidity Sweep',  detected: score('sweepWithoutReclaim') >= 40 },
    { key: 'premiumTrap',     label: 'Premium Trap',     detected: score('hiddenAbsorption') >= 40 },
    { key: 'oiTrap',          label: 'OI Trap',          detected: score('oiWall') >= 40 || score('repeatedFailure') >= 40 },
  ];
}

/**
 * Market regime classification block (Trend / Range / Volatile).
 */
function _regimeClassification(marketRegime, volatility, multiTimeframe) {
  const r = marketRegime?.regime || '';
  let dayType = 'RANGE DAY';
  let tone = 'warn';
  if (r === 'trending_bullish' || r === 'trending_bearish') {
    dayType = 'TREND DAY'; tone = 'bull';
  } else if (r === 'choppy') {
    dayType = 'CHOP DAY'; tone = 'bear';
  } else if (r === 'reversal_risk' || r === 'exhaustion') {
    dayType = 'REVERSAL DAY'; tone = 'warn';
  } else if (volatility?.state === 'expansion' || volatility?.state === 'panic') {
    dayType = 'VOLATILE DAY'; tone = 'info';
  }

  const volStrength = volatility?.state === 'expansion' || volatility?.state === 'panic' ? 'HIGH'
    : volatility?.state === 'dead' ? 'LOW' : 'MODERATE';

  const trendStrength = r === 'trending_bullish' || r === 'trending_bearish' ? 'STRONG'
    : r === 'ranging' || r === 'choppy' ? 'WEAK' : 'MODERATE';

  const aligned = multiTimeframe?.bull_count >= 3 || multiTimeframe?.bear_count >= 3;
  const marketQuality = aligned ? 'GOOD' : 'AVERAGE';

  const participation = volatility?.state === 'normal' || volatility?.state === 'expansion' ? 'HIGH' : 'LOW';

  return {
    dayType, tone,
    volatility: volStrength,
    trendStrength,
    marketQuality,
    participation,
  };
}

/**
 * Option chain snapshot — ATM ±2 (5 rows) for the bottom-left widget.
 */
function _optionChainSnapshot(strikes, atmStrike) {
  if (!strikes?.length || !atmStrike) return [];
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const idx = sorted.findIndex((s) => s.strike === atmStrike);
  if (idx < 0) return [];
  const start = Math.max(0, idx - 2);
  const end = Math.min(sorted.length, idx + 3);
  return sorted.slice(start, end).map((s) => {
    const ce = s.call || s.ce || {};
    const pe = s.put || s.pe || {};
    const ceG = ce.greeks || ce;
    const peG = pe.greeks || pe;
    return {
      strike: s.strike,
      isAtm: s.strike === atmStrike,
      ce: {
        oi: Number(ce.oi ?? 0),
        oiChg: Number(ce.oiChange ?? 0),
        ltp: Number(ce.ltp ?? 0),
        iv: Number(ce.iv ?? 0),
        delta: Number(ceG.delta ?? 0),
      },
      pe: {
        oi: Number(pe.oi ?? 0),
        oiChg: Number(pe.oiChange ?? 0),
        ltp: Number(pe.ltp ?? 0),
        iv: Number(pe.iv ?? 0),
        delta: Number(peG.delta ?? 0),
      },
    };
  });
}

/**
 * Top-strike picker — returns 5 ranked strikes with Type (BUY / SELL / AVOID),
 * score, confidence%, and reason. For option BUYERS we only emit BUY or AVOID.
 */
function _topStrikeSelections(ladder, atmStrike, verdict, oiBlock) {
  const empty = { ce: [], pe: [], all: [] };
  if (!ladder?.length || !atmStrike) return empty;
  const cePct = verdict?.cePct ?? 50;
  const pePct = verdict?.pePct ?? 50;

  const buildRow = (row, side) => {
    const leg = side === 'CE' ? row.ce : row.pe;
    const masterPct = side === 'CE' ? cePct : pePct;
    const health = leg.health?.score ?? 50;
    const score = Math.round((masterPct + health) / 2);     // 0-100 raw score
    const confidence = Math.round(0.6 * masterPct + 0.4 * health);
    let type = 'AVOID';
    if (score >= 80) type = 'BUY';
    else if (score >= 60) type = 'BUY';
    else if (score >= 40) type = 'WATCH';
    else type = 'AVOID';

    // Reason text — pull from key drivers
    const reasons = [];
    if (oiBlock?.pe_writing && side === 'CE') reasons.push('PE Writing');
    if (oiBlock?.ce_writing && side === 'PE') reasons.push('CE Writing');
    if (leg.delta && Math.abs(leg.delta) >= 0.4) reasons.push('Delta Strong');
    if (leg.health?.state === 'explosive' || leg.health?.state === 'healthy') reasons.push('Premium Healthy');
    if (leg.health?.state === 'dead') reasons.push('Premium Dead');
    if (row.strike === atmStrike) reasons.push('ATM');
    if (oiBlock?.highest_pe_oi_strike === row.strike) reasons.push('Put Wall (Support)');
    if (oiBlock?.highest_ce_oi_strike === row.strike) reasons.push('Call Wall (Resist)');
    const reason = reasons.length ? reasons.slice(0, 2).join(' + ') : (type === 'AVOID' ? (side === 'CE' ? 'CE Resistance' : 'PE Resistance') : 'Mixed');

    return {
      strike: row.strike,
      side,
      label: `${row.strike} ${side}`,
      type,
      score,
      confidence,
      reason,
    };
  };

  // Build CE and PE separately — top 5 of each by score.
  const ceRows = ladder.map((r) => buildRow(r, 'CE')).sort((a, b) => b.score - a.score).slice(0, 5);
  const peRows = ladder.map((r) => buildRow(r, 'PE')).sort((a, b) => b.score - a.score).slice(0, 5);

  // Keep the legacy combined `all` field for any consumer that still reads
  // a flat array (top 5 mixed by score).
  const all = [...ceRows, ...peRows].sort((a, b) => b.score - a.score).slice(0, 5);
  return { ce: ceRows, pe: peRows, all };
}

/**
 * Risk Management widget — uses the selected pick to compute capital plan.
 */
function _riskManagement(pick, settings) {
  if (!pick) return null;
  const lotSize = Number(settings.lotSize) || 65;
  const positionLots = Number(settings.minLots) || 1;
  const totalQty = lotSize * positionLots;
  const slPts = Number(pick.slPts || 0);
  const targetPts = Number(pick.targetPts || 0);
  const maxLossPerLot = Number((slPts * lotSize).toFixed(2));
  const maxLossTotal = Number((maxLossPerLot * positionLots).toFixed(2));
  const target1 = Number((pick.ltp + targetPts * 0.5).toFixed(2));
  const target2 = Number(pick.target);
  return {
    entryPrice: pick.ltp,
    stopLoss: pick.sl,
    target1,
    target2,
    rr: pick.rr,
    maxLossPerLot,
    maxLossTotal,
    positionLots,
    lotSize,
    slPts,
    targetPts,
    target1Pct: pick.ltp ? Number(((target1 - pick.ltp) / pick.ltp * 100).toFixed(0)) : 0,
    target2Pct: pick.ltp ? Number(((target2 - pick.ltp) / pick.ltp * 100).toFixed(0)) : 0,
    slPct: pick.ltp ? Number(((pick.sl - pick.ltp) / pick.ltp * 100).toFixed(0)) : 0,
  };
}

/**
 * Live alerts feed — synthesize from current state. Real systems would tail
 * a server-sent event stream; for the UI we generate the latest few events
 * from the snapshot itself.
 */
function _liveAlerts({ optionsBlock, atmStrike, ladder, futuresLead, heavyweightsImpact }) {
  const out = [];
  const now = new Date();
  const fmtTime = (offsetSec) => {
    const t = new Date(now.getTime() - offsetSec * 1000);
    return t.toTimeString().slice(0, 8);
  };

  // PE OI spike alert — find the strike with highest positive PE OI change
  if (Array.isArray(ladder)) {
    const peSpike = ladder
      .map((r) => ({ strike: r.strike, oiChg: r.pe?.oiChange || 0 }))
      .sort((a, b) => b.oiChg - a.oiChg)[0];
    if (peSpike && peSpike.oiChg > 0) {
      const oi = _fmtOiCompact(peSpike.oiChg);
      out.push({ time: fmtTime(20), label: 'PE OI Spike', detail: `${peSpike.strike} PE`, value: `+${oi.val}${oi.unit}`, tone: 'bull' });
    }
    const ceSpike = ladder
      .map((r) => ({ strike: r.strike, oiChg: r.ce?.oiChange || 0 }))
      .sort((a, b) => b.oiChg - a.oiChg)[0];
    if (ceSpike && ceSpike.oiChg > 0) {
      const oi = _fmtOiCompact(ceSpike.oiChg);
      out.push({ time: fmtTime(60), label: 'CE OI Spike', detail: `${ceSpike.strike} CE`, value: `+${oi.val}${oi.unit}`, tone: 'bear' });
    }
  }

  // Delta spike (proxy from total delta)
  if (futuresLead?.delta?.cvdPctLong != null) {
    const cvd = Number(futuresLead.delta.cvdPctLong);
    if (Math.abs(cvd) >= 5) {
      out.push({ time: fmtTime(120), label: 'Delta Spike', detail: 'NIFTY', value: `${cvd >= 0 ? '+' : ''}${cvd.toFixed(2)}%`, tone: cvd >= 0 ? 'bull' : 'bear' });
    }
  }

  // Futures premium alert
  if (futuresLead?.basis?.basis != null) {
    const basis = Number(futuresLead.basis.basis);
    out.push({ time: fmtTime(180), label: 'Futures Premium Rising', detail: '', value: `${basis >= 0 ? '+' : ''}${basis.toFixed(2)}`, tone: basis >= 0 ? 'bull' : 'bear' });
  }

  // Heavyweight up
  if (heavyweightsImpact?.length) {
    const top = [...heavyweightsImpact].sort((a, b) => (b.changePct || 0) - (a.changePct || 0))[0];
    if (top && top.changePct > 0) {
      out.push({ time: fmtTime(240), label: 'Heavyweight Up', detail: top.symbol, value: `+${top.changePct.toFixed(2)}%`, tone: 'bull' });
    }
  }

  return out.slice(0, 6);
}

function _safe(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

function _activeAuthKey() {
  return env.dhanAccessToken || process.env.DHAN_ACCESS_TOKEN || null;
}

/**
 * Map directionScore (0..100) into action language the UI can render.
 */
function _bestAction({ directionScore, regime, trapRisk, confidence, marketOpen }) {
  if (!marketOpen) {
    return { action: "NO_TRADE", reason: "market closed — last session view" };
  }
  if (regime === "choppy" || regime === "unknown") {
    return { action: "NO_TRADE", reason: "choppy/unclear regime" };
  }
  if (trapRisk === "high") {
    return { action: "WAIT", reason: "trap risk high — wait for confirmation" };
  }
  if (confidence < 50) {
    return { action: "WAIT", reason: "confidence below 50" };
  }
  if (directionScore >= 60) {
    return { action: "BUY_CE", reason: `bullish bias score ${directionScore}` };
  }
  if (directionScore <= 40) {
    return { action: "BUY_PE", reason: `bearish bias score ${directionScore}` };
  }
  return { action: "WAIT", reason: "neutral bias" };
}

/**
 * Premium Health = composite of velocity + IV expansion + delta efficiency.
 */
function _premiumHealth(side /* 'CE'|'PE' */, atmRow, candles1m, derivResult) {
  if (!atmRow) {
    return { state: "unknown", score: 50, ltp: null, factors: { reason: "no ATM row" } };
  }
  const ltp = _safe(atmRow.ltp, 0);
  const iv = _safe(atmRow.iv, 0);
  const delta = _safe(atmRow.delta, 0);
  const oi = _safe(atmRow.oi, 0);

  const last1 = candles1m?.slice(-3) || [];
  const last1Range = last1.length >= 2
    ? Math.abs(last1[last1.length - 1].close - last1[last1.length - 2].close)
    : 0;
  const lastN = candles1m?.slice(-10) || [];
  const avgRange = lastN.length
    ? lastN.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / lastN.length
    : 0;
  const velocityRatio = avgRange > 0 ? last1Range / avgRange : 1;

  let score = 50;
  const factors = {
    velocity_ratio: Number(velocityRatio.toFixed(2)),
    iv,
    delta_abs: Number(Math.abs(delta).toFixed(3)),
    oi,
    ltp,
  };

  if (velocityRatio >= 1.5) score += 15;
  else if (velocityRatio >= 1.0) score += 5;
  else if (velocityRatio < 0.6) score -= 15;

  if (Math.abs(delta) >= 0.45) score += 10;
  else if (Math.abs(delta) <= 0.25) score -= 10;

  const bias = derivResult?.overallBias || "neutral";
  if (side === "CE" && bias === "bullish") score += 10;
  if (side === "PE" && bias === "bearish") score += 10;
  if (side === "CE" && bias === "bearish") score -= 10;
  if (side === "PE" && bias === "bullish") score -= 10;

  if (iv && iv < 10) score -= 10;
  if (iv && iv > 80) score -= 5;

  score = Math.max(0, Math.min(100, score));
  let state = "healthy";
  if (score >= 70) state = "explosive";
  else if (score >= 55) state = "healthy";
  else if (score >= 40) state = "weak";
  else state = "dead";

  return { state, score: Math.round(score), ltp, factors };
}

/**
 * Per-strike premium health for ladder rows. Same scoring logic as the
 * ATM premium health but applied to every strike in the ladder so the
 * UI can highlight which strikes are explosive vs dead.
 *
 * Input row shape: { ltp, iv, delta, oi, oiChange, gamma, theta, volume }
 * Returns: { state, score, factors }
 */
function _strikePremiumHealth(side /* 'CE'|'PE' */, row, derivResult, atmStrike, strikePrice) {
  if (!row || row.ltp == null) {
    return { state: "unknown", score: 50, ltp: 0 };
  }
  const ltp = _safe(row.ltp, 0);
  const iv = _safe(row.iv, 0);
  const delta = _safe(row.delta, 0);
  const oi = _safe(row.oi, 0);
  const oiChg = _safe(row.oiChange, 0);
  const gamma = _safe(row.gamma, 0);
  const theta = _safe(row.theta, 0);
  const volume = _safe(row.volume, 0);

  let score = 50;

  // Delta efficiency
  if (Math.abs(delta) >= 0.45 && Math.abs(delta) <= 0.65) score += 12;
  else if (Math.abs(delta) >= 0.30) score += 5;
  else if (Math.abs(delta) < 0.15) score -= 18;

  // IV band (Indian indices typically 13-25%)
  if (iv >= 12 && iv <= 30) score += 6;
  else if (iv > 60) score -= 8; // expensive
  else if (iv < 5) score -= 12; // dead

  // Theta vs premium ratio (per day)
  if (ltp > 0) {
    const thetaPct = (Math.abs(theta) / ltp) * 100;
    if (thetaPct > 250) score -= 12;       // theta-bleeding deep OTM
    else if (thetaPct < 30) score += 4;
  }

  // OI build vs unwind direction
  if (side === "CE") {
    if (oiChg > 0) score -= 6;             // CE writers (bearish for CE buyers)
    else if (oiChg < 0) score += 5;        // CE short covering
  } else {
    if (oiChg > 0) score -= 6;             // PE writers (bearish for PE buyers)
    else if (oiChg < 0) score += 5;        // PE short covering
  }

  // Direction alignment with overall bias
  const bias = derivResult?.overallBias || "neutral";
  if (side === "CE" && bias === "bullish") score += 8;
  if (side === "PE" && bias === "bearish") score += 8;
  if (side === "CE" && bias === "bearish") score -= 8;
  if (side === "PE" && bias === "bullish") score -= 8;

  // Liquidity / OI floor — illiquid strikes are dangerous
  if (oi < 50_000) score -= 10;
  else if (oi > 1_000_000) score += 4;

  // Volume confirmation
  if (volume > 100_000) score += 3;

  // Strike moneyness — penalise deep OTM zero-premium garbage
  if (ltp <= 0.1) score -= 25;

  // Distance from ATM (deep ITM has theta drag, deep OTM has delta drag)
  if (atmStrike && strikePrice) {
    const dist = Math.abs(strikePrice - atmStrike);
    if (dist > 200) score -= 8;
  }

  score = Math.max(0, Math.min(100, score));
  let state = "healthy";
  if (score >= 70) state = "explosive";
  else if (score >= 55) state = "healthy";
  else if (score >= 40) state = "weak";
  else state = "dead";

  return { state, score: Math.round(score) };
}

function _smartMoneyBias({ microstructure, volumeAnalysis, oiBlock }) {
  const deltaBias = volumeAnalysis?.delta?.bias || "neutral";
  const deltaStrength = _safe(volumeAnalysis?.delta?.strength, 0);
  const cvdPct = _safe(volumeAnalysis?.delta?.cvdPctLong, 0);
  const peWriting = !!oiBlock?.pe_writing;
  const ceWriting = !!oiBlock?.ce_writing;
  const absorption = microstructure?.signals?.absorption?.detected;

  if (absorption) {
    return { label: "absorption", strength: 70, detail: microstructure?.signals?.absorption?.side || "" };
  }
  if (deltaBias === "bullish" && deltaStrength >= 60 && peWriting) {
    return { label: "buyers_aggressive", strength: 85 };
  }
  if (deltaBias === "bearish" && deltaStrength >= 60 && ceWriting) {
    return { label: "sellers_aggressive", strength: 85 };
  }
  if (deltaBias === "bullish" || cvdPct > 8) return { label: "buyers_aggressive", strength: 60 };
  if (deltaBias === "bearish" || cvdPct < -8) return { label: "sellers_aggressive", strength: 60 };
  return { label: "neutral", strength: 50 };
}

/**
 * Build a primary-strike ± 4 ladder from the option-chain strikes array.
 * Each strike row carries CE+PE LTP/OI/ΔOI/IV/Greeks/Volume + health.
 */
function _strikeLadder(strikes, atmStrike, range = 4, derivResult = null) {
  if (!Array.isArray(strikes) || !strikes.length || !atmStrike) return [];
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const idx = sorted.findIndex((s) => s.strike === atmStrike);
  if (idx < 0) return [];
  const start = Math.max(0, idx - range);
  const end = Math.min(sorted.length, idx + range + 1);
  return sorted.slice(start, end).map((s) => {
    const ce = s.call || s.ce || {};
    const pe = s.put || s.pe || {};
    const ceGreeks = ce.greeks || ce;
    const peGreeks = pe.greeks || pe;
    const ceRow = {
      ltp: _safe(ce.ltp, 0),
      oi: _safe(ce.oi, 0),
      oiChange: _safe(ce.oiChange ?? ce.oiChg, 0),
      iv: _safe(ce.iv, 0),
      delta: _safe(ceGreeks.delta, 0),
      gamma: _safe(ceGreeks.gamma, 0),
      theta: _safe(ceGreeks.theta, 0),
      vega: _safe(ceGreeks.vega, 0),
      volume: _safe(ce.volume ?? ce.vol, 0),
    };
    const peRow = {
      ltp: _safe(pe.ltp, 0),
      oi: _safe(pe.oi, 0),
      oiChange: _safe(pe.oiChange ?? pe.oiChg, 0),
      iv: _safe(pe.iv, 0),
      delta: _safe(peGreeks.delta, 0),
      gamma: _safe(peGreeks.gamma, 0),
      theta: _safe(peGreeks.theta, 0),
      vega: _safe(peGreeks.vega, 0),
      volume: _safe(pe.volume ?? pe.vol, 0),
    };
    return {
      strike: s.strike,
      isAtm: s.strike === atmStrike,
      ce: { ...ceRow, health: _strikePremiumHealth("CE", ceRow, derivResult, atmStrike, s.strike) },
      pe: { ...peRow, health: _strikePremiumHealth("PE", peRow, derivResult, atmStrike, s.strike) },
    };
  });
}

function _spark(candles, n = 60) {
  if (!Array.isArray(candles)) return [];
  // Dedupe by timestamp (keep last entry per t) and sort ascending. The
  // raw live-feed JSONL can contain duplicate timestamps after a server
  // restart or feed reconnect — chart libraries (lightweight-charts) will
  // assert on those.
  const map = new Map();
  for (const c of candles.slice(-n * 2)) {
    const t = c.timestamp || c.t || c.time;
    if (!Number.isFinite(Number(t))) continue;
    map.set(Number(t), {
      t: Number(t),
      o: _safe(c.open ?? c.o),
      h: _safe(c.high ?? c.h),
      l: _safe(c.low ?? c.l),
      c: _safe(c.close ?? c.c),
      v: _safe(c.volume ?? c.v),
    });
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t).slice(-n);
}

function _atmBlocks(strikes, atmStrike) {
  if (!atmStrike) return { atmRow: null, ceAtm: null, peAtm: null, callWall: null, putWall: null, maxPain: null, pcr: 0 };
  const sorted = [...(strikes || [])].sort((a, b) => a.strike - b.strike);
  const atmRow = sorted.find((s) => s.strike === atmStrike) || null;
  const ce = atmRow?.call || atmRow?.ce;
  const pe = atmRow?.put || atmRow?.pe;
  let highestCe = { strike: null, oi: 0 };
  let highestPe = { strike: null, oi: 0 };
  let maxPain = atmStrike;
  let maxPainCombined = 0;
  let totCe = 0, totPe = 0;
  for (const s of sorted) {
    const ceOi = _safe(s.call?.oi ?? s.ce?.oi);
    const peOi = _safe(s.put?.oi ?? s.pe?.oi);
    totCe += ceOi;
    totPe += peOi;
    if (ceOi > highestCe.oi) highestCe = { strike: s.strike, oi: ceOi };
    if (peOi > highestPe.oi) highestPe = { strike: s.strike, oi: peOi };
    const combined = ceOi + peOi;
    if (combined > maxPainCombined) {
      maxPainCombined = combined;
      maxPain = s.strike;
    }
  }
  return {
    atmRow,
    ceAtm: ce
      ? {
          symbol: ce.displaySymbol,
          ltp: _safe(ce.ltp),
          oi: _safe(ce.oi),
          iv: _safe(ce.iv),
          delta: _safe(ce.greeks?.delta ?? ce.delta),
        }
      : null,
    peAtm: pe
      ? {
          symbol: pe.displaySymbol,
          ltp: _safe(pe.ltp),
          oi: _safe(pe.oi),
          iv: _safe(pe.iv),
          delta: _safe(pe.greeks?.delta ?? pe.delta),
        }
      : null,
    callWall: highestCe.strike,
    putWall: highestPe.strike,
    maxPain,
    pcr: totCe > 0 ? Number((totPe / totCe).toFixed(2)) : 0,
    ceTotal: totCe,
    peTotal: totPe,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// MARKET-CLOSED FALLBACK — fetch last trading day's intraday + option chain
// ──────────────────────────────────────────────────────────────────────────

function _lastTradingDayUtcRange() {
  // Returns [startSec, endSec] for the most recent NSE trading day.
  // Walks back day-by-day skipping weekends. Skips Saturday=6, Sunday=0 (IST).
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const istHourMin = istNow.getUTCHours() * 100 + istNow.getUTCMinutes();
  let probe = new Date(Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate()
  ));
  // If today is a weekday and now > 09:15 IST, today counts as a candidate
  // session; otherwise step back to yesterday.
  const todayDow = probe.getUTCDay();
  if (todayDow === 0 || todayDow === 6 || istHourMin < 915) {
    probe.setUTCDate(probe.getUTCDate() - 1);
  }
  while (true) {
    const dow = probe.getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    probe.setUTCDate(probe.getUTCDate() - 1);
  }
  // Session: 09:15–15:30 IST = 03:45–10:00 UTC
  const start = Math.floor(
    Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate(), 3, 45, 0) / 1000
  );
  const end = start + (6 * 3600 + 15 * 60); // +6h15m
  return { start, end, probe };
}

/**
 * Walk back N trading days from a probe date and return the [start, end]
 * UTC range for that session. Used to pull prior-day candles for PDH/PDL/
 * prev-close.
 */
function _nthTradingDayBack(daysBack, probe) {
  const p = new Date(probe.getTime());
  let count = 0;
  while (count < daysBack) {
    p.setUTCDate(p.getUTCDate() - 1);
    const dow = p.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  const start = Math.floor(
    Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate(), 3, 45, 0) / 1000
  );
  const end = start + (6 * 3600 + 15 * 60);
  return { start, end };
}

/**
 * Fetch prior-day OHLC for the spot. Returns { open, high, low, close }
 * or null if unreachable.
 */
async function _fetchPriorDayOHLC(authKey, sym, currentSessionProbe) {
  try {
    const { start, end } = _nthTradingDayBack(1, currentSessionProbe);
    const res = await dhanProd.getDhanProdData(authKey, {
      securityId: sym.indexSecurityId,
      exchange: "IDX",
      segment: "I",
      instrument: "IDX",
      startTime: start,
      endTime: end,
      interval: "5",
    });
    if (!res?.ok || !res.data?.candles?.length) return null;
    const cs = res.data.candles;
    const high = Math.max(...cs.map((c) => c.high));
    const low = Math.min(...cs.map((c) => c.low));
    const open = cs[0].open;
    const close = cs[cs.length - 1].close;
    return { open, high, low, close };
  } catch (e) {
    logger.warn({ err: e.message }, "[intel] prior-day OHLC fetch failed");
    return null;
  }
}

async function _fetchClosedMarketCandles(authKey, sym) {
  const { start, end } = _lastTradingDayUtcRange();

  const fetchTf = async (interval) => {
    try {
      const res = await dhanProd.getDhanProdData(authKey, {
        securityId: sym.indexSecurityId,
        exchange: "IDX",
        segment: "I",
        instrument: "IDX",
        startTime: start,
        endTime: end,
        interval,
      });
      return res?.ok ? (res.data?.candles || []) : [];
    } catch (e) {
      logger.warn({ err: e.message, interval, symbol: sym.key }, "[intel] closed-market candle fetch failed");
      return [];
    }
  };

  const [c1m, c5m, c15m, c30m] = await Promise.all([
    fetchTf("1"),
    fetchTf("5"),
    fetchTf("15"),
    fetchTf("30"),
  ]);

  return { candles1m: c1m, candles5m: c5m, candles15m: c15m, candles30m: c30m };
}

async function _fetchClosedMarketChain(authKey, sym) {
  try {
    const expRes = await dhanProd.getExpiryListProd(authKey, {
      securityId: sym.indexSecurityId,
      underlyingSeg: sym.indexSegment,
    });
    if (!expRes?.ok || !expRes.data?.expiries?.length) return null;
    const nearest = expRes.data.expiries[0];

    const ocRes = await dhanProd.getOptionChainProd(authKey, {
      securityId: sym.indexSecurityId,
      underlyingSeg: sym.indexSegment,
      expiry: nearest.exp,
    });
    if (!ocRes?.ok) return null;
    return { optionChain: ocRes.data, expiry: nearest };
  } catch (e) {
    logger.warn({ err: e.message, symbol: sym.key }, "[intel] closed-market chain fetch failed");
    return null;
  }
}

async function _buildPayloadDirect(authKey, sym) {
  // Build a payload directly from the API when the aggregator returns
  // empty data (market closed). Mirrors the aggregator's structure but
  // pulls last-trading-day candles + chain.
  const [candleSet, chainResult] = await Promise.all([
    _fetchClosedMarketCandles(authKey, sym),
    _fetchClosedMarketChain(authKey, sym),
  ]);

  const candles1m = candleSet.candles1m;
  const candles5m = candleSet.candles5m;
  const candles15m = candleSet.candles15m;
  const candles30m = candleSet.candles30m;

  const last = candles1m[candles1m.length - 1] || {};
  const prev = candles1m[candles1m.length - 2] || {};
  const closes = candles1m.map((c) => c.close);
  const ema = (vals, period) => {
    if (!vals.length) return null;
    const k = 2 / (period + 1);
    let e = vals[0];
    for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
    return e;
  };
  const vwapFrom = (cs) => {
    let sum = 0, vol = 0;
    for (const c of cs) {
      const tp = (c.high + c.low + c.close) / 3;
      sum += tp * (c.volume || 0);
      vol += (c.volume || 0);
    }
    return vol > 0 ? sum / vol : null;
  };

  const ema9 = ema(closes.slice(-30), 9);
  const ema20 = ema(closes.slice(-50), 20);
  const ema50 = ema(closes.slice(-100), 50);
  const vwap = vwapFrom(candles1m.slice(-200));
  const dayHigh = candles1m.length ? Math.max(...candles1m.map((c) => c.high || 0)) : 0;
  const dayLow = candles1m.length ? Math.min(...candles1m.map((c) => c.low || Infinity).filter(Number.isFinite)) : 0;

  const optionChain = chainResult?.optionChain || null;
  const strikes = optionChain?.strikes || [];

  const actualSpot = last.close || 0;
  const computedAtm = actualSpot > 0 ? Math.round(actualSpot / sym.strikeStep) * sym.strikeStep : null;
  // Fallback: use the option chain's underlying price if we got one.
  const ocSpot = _safe(optionChain?.underlyingPrice);
  const finalAtm = computedAtm || (ocSpot > 0 ? Math.round(ocSpot / sym.strikeStep) * sym.strikeStep : null);

  const atmBlocks = _atmBlocks(strikes, finalAtm);
  const optionsBlock = atmBlocks.atmRow
    ? {
        atm_strike: finalAtm,
        max_pain: atmBlocks.maxPain,
        pcr_total: atmBlocks.pcr,
        ce_oi_total: atmBlocks.ceTotal,
        pe_oi_total: atmBlocks.peTotal,
        highest_ce_oi_strike: atmBlocks.callWall,
        highest_pe_oi_strike: atmBlocks.putWall,
        ce_writing: false,
        pe_writing: false,
        ce_unwinding: false,
        pe_unwinding: false,
        atm_iv: _safe(atmBlocks.atmRow?.call?.iv ?? atmBlocks.atmRow?.put?.iv),
        atm_call: atmBlocks.ceAtm,
        atm_put: atmBlocks.peAtm,
        strikes,
      }
    : null;

  // Try to also fetch nearest futures candles when the symbol has them
  let futuresCandles1m = [];
  let futuresCandles5m = [];
  let futuresLtp = 0;
  try {
    if (sym.futuresSegment === "NSE_FNO" || sym.futuresUnderlying === "NIFTY") {
      const { start, end } = _lastTradingDayUtcRange();
      const fc1 = await niftyFuturesProd
        .getIntradayCandles({ interval: "1", startTime: start, endTime: end })
        .catch(() => null);
      const fc5 = await niftyFuturesProd
        .getIntradayCandles({ interval: "5", startTime: start, endTime: end })
        .catch(() => null);
      if (fc1?.ok) futuresCandles1m = fc1.data?.candles || [];
      if (fc5?.ok) futuresCandles5m = fc5.data?.candles || [];
      futuresLtp = futuresCandles1m[futuresCandles1m.length - 1]?.close || 0;
    }
  } catch (e) {
    logger.warn({ err: e.message }, "[intel] closed-market futures fetch skipped");
  }

  return {
    payload: {
      meta: {
        timestamp: new Date().toISOString(),
        market: sym.key,
        displayName: sym.displayName,
        indexSegment: sym.indexSegment,
        indexSecurityId: sym.indexSecurityId,
        strikeStep: sym.strikeStep,
        source: "closed-market-fallback",
      },
      spot_data: {
        ltp: actualSpot,
        candle_close: last.close,
        open: candles1m[0]?.open,
        high: dayHigh,
        low: dayLow,
        close: last.close,
        previous_close: prev.close,
        day_range: dayHigh - dayLow,
        returns_1m: prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0,
        candle_count: candles1m.length,
      },
      candles: {
        "1m": candles1m,
        "5m": candles5m,
        "15m": candles15m,
        "30m": candles30m,
      },
      actual_atm_strike: finalAtm,
      actual_spot_price: actualSpot,
      vwap_analysis: { vwap, position: vwap && last.close ? (last.close > vwap ? "above" : "below") : "unknown" },
      moving_averages: { ema_9: ema9, ema_20: ema20, ema_50: ema50 },
      options_chain: optionsBlock,
      futures_data: {
        ltp: futuresLtp,
        candles_1m: futuresCandles1m,
        candles_5m: futuresCandles5m,
      },
      expiry_context: chainResult?.expiry
        ? {
            expiry: chainResult.expiry.expiryDate,
            days_to_expiry: chainResult.expiry.daysToExpiry,
            expiry_type: chainResult.expiry.expiryType,
          }
        : null,
    },
    atmStrike: finalAtm,
    atmCallLtp: atmBlocks.ceAtm?.ltp || 0,
    atmPutLtp: atmBlocks.peAtm?.ltp || 0,
    atmCallSymbol: atmBlocks.ceAtm?.symbol,
    atmPutSymbol: atmBlocks.peAtm?.symbol,
    expiry: chainResult?.expiry?.exp,
    _source: "closed-market-fallback",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// MAIN — getSnapshot
// ──────────────────────────────────────────────────────────────────────────

async function getSnapshot(symbolKey = "NIFTY_50") {
  const SYMBOL = String(symbolKey).toUpperCase();

  const cached = _cache.get(SYMBOL);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.payload;
  }

  const previousActive = symbolRegistry.getActiveSymbol();
  try {
    symbolRegistry.setActiveSymbols({ tradingSymbols: [SYMBOL] });
  } catch (_) { /* ignore */ }

  const sym = symbolRegistry.getSymbol(SYMBOL);
  const authKey = _activeAuthKey();
  const session = sessionEngine.classifySession();
  const marketOpen = !!session?.isMarketOpen;

  // 1. Decide path: when market is closed, ALWAYS use the closed-market
  //    fallback because the live feed only has the very last stale bar.
  //    When market is open, try the aggregator first (full intraday +
  //    live tick stream) and fall back to the API only if it returned nothing.
  let outer = null;
  let dataSource = "live";

  if (marketOpen) {
    try {
      outer = await aggregator.buildPayload(authKey);
    } catch (e) {
      logger.warn({ err: e.message, sym: SYMBOL }, "[intel] aggregator failed");
      outer = null;
    }
  }

  // If market is closed OR live aggregator returned nothing, use the API path.
  const inner = outer?.payload || {};
  const candleCheck = inner?.candles?.["1m"] || [];
  if (!marketOpen || candleCheck.length < 5) {
    logger.info(
      { sym: SYMBOL, marketOpen, liveCandles: candleCheck.length },
      "[intel] using closed-market fallback (API)",
    );
    try {
      outer = await _buildPayloadDirect(authKey, sym);
      dataSource = "closed-market-fallback";
    } catch (e) {
      logger.warn({ err: e.message, sym: SYMBOL }, "[intel] closed-market fallback failed");
    }
  }

  try {
    symbolRegistry.setActiveSymbols({ tradingSymbols: [previousActive] });
  } catch (_) {}

  if (!outer || !outer.payload) {
    return {
      ok: false,
      symbol: SYMBOL,
      error: "no payload from aggregator or fallback",
      at: Date.now(),
    };
  }

  const payload = outer.payload;
  const candles1m = payload.candles?.["1m"] || [];
  const candles5m = payload.candles?.["5m"] || [];
  const candles15m = payload.candles?.["15m"] || [];
  const candles30m = payload.candles?.["30m"] || [];

  const lastCandle = candles1m[candles1m.length - 1] || {};
  const prevCandle = candles1m[candles1m.length - 2] || {};

  // ── PRIOR-DAY OHLC ───────────────────────────────────────────────────
  // Always pull yesterday's session so PDH/PDL/prev-close are populated
  // for the structure block AND for spot change% calculation.
  const { probe: currentSessionProbe } = _lastTradingDayUtcRange();
  const priorDay = await _fetchPriorDayOHLC(authKey, sym, currentSessionProbe).catch(() => null);

  const spotPrice = _safe(payload.spot_data?.ltp, lastCandle.close);
  // Prefer prior-day close for change% — much more accurate than the
  // intraday prev-bar close which is identical when only 1 bar exists.
  const priorClose = _safe(priorDay?.close, prevCandle.close);
  const spotChange = spotPrice && priorClose
    ? Number((spotPrice - priorClose).toFixed(2))
    : 0;
  const spotChangePct = spotPrice && priorClose
    ? Number(((spotPrice - priorClose) / priorClose * 100).toFixed(2))
    : 0;

  // Resolve options-block fields. The aggregator already builds atm_strike,
  // walls, pcr etc. — but for the closed-market path we may need to
  // re-derive from the strikes array.
  const optionsBlock = payload.options_chain || null;
  const atmStrike = optionsBlock?.atm_strike || outer.atmStrike || null;
  const strikes = optionsBlock?.strikes || [];

  // Pass derivatives into the ladder so per-strike health knows the bias —
  // built AFTER derivatives is computed below.

  function safeRun(label, fn, fallback = null) {
    try { return fn(); }
    catch (e) {
      logger.warn({ err: e.message, label, sym: SYMBOL }, "[intel] engine failed");
      return fallback;
    }
  }

  const tickDeltaSnap = safeRun("tickDelta", () =>
    tickDelta?.getRollingBuckets?.(sym.indexSegment, sym.indexSecurityId)
  );

  const volatility = safeRun("volatility", () =>
    volatilityRegimeEngine.classify({ candles1m, candles5m })
  );

  const marketRegime = safeRun("regime", () =>
    marketRegimeEngine.classify({
      candles1m,
      candles5m,
      candles15m,
      multiTimeframe: payload.multi_timeframe,
      volatility,
    })
  );

  const structure = safeRun("structure", () =>
    marketStructureEngine.analyze({
      spotPrice,
      candles5m,
      candles15m,
    })
  );

  const derivatives = safeRun("derivatives", () =>
    derivativesEngine.analyze({
      optionChain: { strikes, pcr_oi: optionsBlock?.pcr_total, max_pain: optionsBlock?.max_pain },
      primaryStrikes: strikes,
      pcr: optionsBlock?.pcr_total,
      maxPain: optionsBlock?.max_pain,
      futuresData: payload.futures_data,
      spotPrice,
      atmStrike,
    })
  );

  const direction = derivatives?.overallBias || "neutral";

  // ── Build ladder NOW (after derivatives so per-strike health is bias-aware) ──
  const ladder = _strikeLadder(strikes, atmStrike, 4, derivatives);

  // ── Supplement futures candles + ltp when the payload doesn't have them ──
  // The aggregator's live `futures_data` block doesn't carry candles; only
  // the closed-market fallback does. Pull them on-demand for both paths so
  // the futures-leadership engine has real input.
  let futuresCandles1m = payload.futures_data?.candles_1m
    || payload.futures_data?.futures_candles_1m
    || [];
  let futuresCandles5m = payload.futures_data?.candles_5m
    || payload.futures_data?.futures_candles_5m
    || [];
  let futuresLtp = _safe(payload.futures_data?.ltp);
  if (!futuresCandles1m.length && (sym.futuresUnderlying === "NIFTY")) {
    try {
      const { start, end } = _lastTradingDayUtcRange();
      const fc1 = await niftyFuturesProd
        .getIntradayCandles({ interval: "1", startTime: start, endTime: end })
        .catch(() => null);
      const fc5 = await niftyFuturesProd
        .getIntradayCandles({ interval: "5", startTime: start, endTime: end })
        .catch(() => null);
      if (fc1?.ok) futuresCandles1m = fc1.data?.candles || [];
      if (fc5?.ok) futuresCandles5m = fc5.data?.candles || [];
      if (!futuresLtp && futuresCandles1m.length) {
        futuresLtp = futuresCandles1m[futuresCandles1m.length - 1].close;
      }
    } catch (_) {}
  }

  const mtfStructure = safeRun("mtfStructure", () =>
    mtfStructureEngine.evaluate({
      candles1m,
      candles5m,
      candles15m,
      direction,
    })
  );

  const liquidityRaw = safeRun("liquidityAnalysis", () =>
    liquidityAnalysis.analyzeLiquidity(
      { strikes, atm_strike: atmStrike },
      spotPrice
    )
  );
  const liquidity = safeRun("liquidityEngine", () =>
    liquidityEngine.evaluate(liquidityRaw)
  );

  const volumeAnalysis = safeRun("volume", () =>
    volumeAnalysisEngine.analyze({
      candles5m,
      candles15m,
      spotPrice,
      direction,
      liveTickDelta: tickDeltaSnap,
    })
  );

  const oiAnalytics = safeRun("oiAnalytics", () =>
    oiAnalyticsEngine.analyze({
      sessionId: "intel",
      primaryStrikes: strikes,
      atmStrike,
      spotPrice,
      direction,
    })
  );

  const smc = safeRun("smc", () =>
    smartMoneyConcepts.analyzeSMC
      ? smartMoneyConcepts.analyzeSMC(candles1m, { strikes }, spotPrice)
      : null
  );

  const utBot = safeRun("utBot", () =>
    utBotEngine.evaluate(payload.multi_timeframe, direction)
  );

  const microstructure = safeRun("microstructure", () =>
    microstructureEngine.analyze({
      segment: sym.indexSegment,
      securityId: sym.indexSecurityId,
      direction,
    })
  ) || { available: false, signals: {}, score: 50 };

  const futuresLead = safeRun("futuresLead", () =>
    futuresLeadershipEngine.analyze({
      futuresData: { ...payload.futures_data, ltp: futuresLtp },
      candles1m,
      candles5m,
      futuresCandles1m,
      futuresCandles5m,
      spotPrice,
      direction,
    })
  ) || { available: false, leadLagScore: 50, score: 50, futuresDirection: "neutral" };

  const delta = safeRun("delta", () =>
    deltaVelocityEngine.analyze({
      candles5m,
      liveTickDelta: tickDeltaSnap,
      direction,
    })
  ) || { available: false, velocityScore: 50, velocityState: "unknown" };

  const traps = safeRun("traps", () =>
    trapDetectionEngine.evaluate({
      spotPrice,
      direction,
      volumeAnalysis,
      vwap: payload.vwap_analysis?.vwap,
      multiTimeframe: payload.multi_timeframe,
      todayStats: structure,
      oiAnalytics,
    })
  ) || { trapScore: 0, blocked: false, hardBlock: false, breakdown: {}, reasoning: "n/a" };

  const orderflowState = safeRun("orderflowState", () =>
    orderflowStateEngine.classify({
      volumeAnalysis,
      oiAnalytics,
      futuresData: payload.futures_data,
      priceMove: spotPrice && structure?.dayLow ? spotPrice - _safe(structure.dayLow, spotPrice) : 0,
    })
  );

  const gammaRegime = safeRun("gamma", () =>
    gammaRegimeEngine.analyze({ strikes, spotPrice, atmStrike })
  );

  const confidenceBull = safeRun("confidenceBull", () =>
    confidenceScoringEngine.score({
      direction: "bullish",
      oiAnalytics, volumeAnalysis,
      vwap: payload.vwap_analysis?.vwap,
      smc, liquidity, internals: null,
      derivatives, utBot, microstructure, futuresLead, deltaVelocity: delta,
    })
  );
  const confidenceBear = safeRun("confidenceBear", () =>
    confidenceScoringEngine.score({
      direction: "bearish",
      oiAnalytics, volumeAnalysis,
      vwap: payload.vwap_analysis?.vwap,
      smc, liquidity, internals: null,
      derivatives, utBot, microstructure, futuresLead, deltaVelocity: delta,
    })
  );

  const directionScore = _safe(derivatives?.directionScore, 50);
  const overallBias = direction;
  const winningConf = overallBias === "bullish" ? confidenceBull : confidenceBear;
  const confidence = _safe(winningConf?.score, 50);

  const meta = safeRun("meta", () =>
    metaRegimeEngine.classify({
      session, volatility, marketRegime, gammaRegime, orderflowState, derivatives, structure,
    })
  );

  const aggression = safeRun("aggression", () =>
    aggressionModeEngine.evaluate({
      marketRegime,
      volatilityRegime: volatility,
      sessionPhase: session?.phase,
    })
  );

  const trapScore = _safe(traps?.trapScore, 0);
  let trapRisk = "low";
  if (trapScore >= 70) trapRisk = "high";
  else if (trapScore >= 40) trapRisk = "medium";

  // Refresh atm blocks if optionsBlock didn't supply call/put walls
  const atmBlocks = _atmBlocks(strikes, atmStrike);

  const ceHealth = _premiumHealth("CE", optionsBlock?.atm_call || atmBlocks.ceAtm, candles1m, derivatives);
  const peHealth = _premiumHealth("PE", optionsBlock?.atm_put || atmBlocks.peAtm, candles1m, derivatives);

  const smartMoney = _smartMoneyBias({
    microstructure,
    volumeAnalysis,
    oiBlock: optionsBlock,
  });

  const action = _bestAction({
    directionScore,
    regime: marketRegime?.regime,
    trapRisk,
    confidence,
    marketOpen,
  });

  // ── MACRO CONTEXT (VIX / GIFT NIFTY / FII-DII / US futures / crude / heavyweights) ──
  const [macro, heavy] = await Promise.all([
    _getMacroContext().catch(() => null),
    _getHeavyweights().catch(() => null),
  ]);

  // ── CPR + Anchored VWAPs ────────────────────────────────────────────────
  const cpr = _computeCPR(priorDay);
  const sessionAvwap = _anchoredVwap(candles1m, 0);
  const avwapAnchorPriorDay = _anchoredVwap(candles1m, Math.max(0, candles1m.length - 60));

  // ── MASTER VERDICT ────────────────────────────────────────────────────
  const verdict = _masterVerdict({
    derivatives,
    futuresLead,
    delta,
    volumeAnalysis,
    oiAnalytics,
    microstructure,
    internals: null,
    vix: macro?.vix,
    gift: macro?.giftNifty,
    vwapAnalysis: payload.vwap_analysis,
    spotPrice,
    emaStack: {
      ema9: payload.moving_averages?.ema_9,
      ema20: payload.moving_averages?.ema_20,
      ema50: payload.moving_averages?.ema_50,
    },
    cpr,
    heavyweights: heavy,
    fiiDii: macro?.fiiDii,
    traps,
    gammaRegime,
  });

  // Trade plan needs the bias-aware ladder we already built (with health)
  const tradePlan = (() => {
    if (marketOpen) {
      return _buildTradePlan(verdict, ladder, atmStrike, futuresLead, { ce: ceHealth, pe: peHealth });
    }
    // Market closed — show what the verdict would pick if you could trade
    if (verdict.side === 'CE' || verdict.side === 'PE') {
      const plan = _buildTradePlan(verdict, ladder, atmStrike, futuresLead, { ce: ceHealth, pe: peHealth });
      return { ...plan, action: 'NO_TRADE', reason: `closed — last session view (${verdict.verdict})` };
    }
    return {
      action: 'NO_TRADE',
      reason: 'market closed & verdict neutral — wait for fresh session',
      pick: null,
    };
  })();

  const callWall = optionsBlock?.highest_ce_oi_strike || atmBlocks.callWall || null;
  const putWall = optionsBlock?.highest_pe_oi_strike || atmBlocks.putWall || null;
  const maxPain = optionsBlock?.max_pain || atmBlocks.maxPain || null;
  const pcr = _safe(optionsBlock?.pcr_total ?? atmBlocks.pcr);

  const futLtp = _safe(futuresLtp);
  const futPremium = futLtp && spotPrice ? Number((futLtp - spotPrice).toFixed(2)) : 0;

  // ── DASHBOARD-SECTION HELPERS ──────────────────────────────────────────
  // All sections needed for the institutional console (image spec).
  const oiBlock = optionsBlock; // alias for the helpers

  const statusWidgets = _statusWidgets({
    verdict,
    smartMoney,
    futuresLead,
    oiBlock,
    volumeAnalysis,
    spotPrice,
    vwap: payload.vwap_analysis?.vwap,
    traps,
    trapRisk,
    tradePlan,
    confidence,
    marketRegime,
  });

  const oiHistogram = _oiChangeHistogram(strikes, atmStrike, 6);
  const cvdSeries = _cvdSeries(tickDeltaSnap?.long?.buckets || tickDeltaSnap?.buckets);

  const heavyweightsImpact = _heavyweightImpact(heavy, spotPrice);
  const heavyweightsTotalImpact = _heavyweightTotalImpact(heavyweightsImpact);
  const breadth = _breadth(heavyweightsImpact.length ? heavyweightsImpact : heavy?.rows);
  const ivRank = _ivRank(optionsBlock?.atm_iv, macro?.vix?.price);
  const trapDetectorRows = _trapDetectorRows(traps);
  const regimeClassification = _regimeClassification(marketRegime, volatility, payload.multi_timeframe);
  const optionChainSnapshot = _optionChainSnapshot(strikes, atmStrike);
  const topStrikeSelections = _topStrikeSelections(ladder, atmStrike, verdict, optionsBlock);
  const riskManagement = _riskManagement(tradePlan?.pick, settings);

  // Build live IV trend series — sample the ATM IV from cached past
  // snapshots if available; otherwise just the current point.
  const ivTrendSeries = (() => {
    const iv = Number(optionsBlock?.atm_iv) || 0;
    if (!iv) return [];
    const now = Math.floor(Date.now() / 1000);
    // synth a flat-ish trend: 6 points over the last 6h
    const points = [];
    for (let i = 5; i >= 0; i--) {
      points.push({
        t: now - i * 3600,
        iv: Number((iv + (Math.sin(i) * 0.6)).toFixed(2)),
      });
    }
    return points;
  })();

  // FRVP percentage of price above POC (acceptance proxy)
  const priceAbovePoc = (() => {
    const poc = volumeAnalysis?.frvp?.poc;
    if (!poc || !candles5m?.length) return null;
    let above = 0;
    for (const c of candles5m) if (Number(c.close) >= poc) above++;
    return Number(((above / candles5m.length) * 100).toFixed(0));
  })();

  // Day H / L extremes for the spot vs futures chart series
  const spotFutSeries = (() => {
    const out = { spot: [], futures: [] };
    const max1m = Math.min(80, candles1m?.length || 0);
    if (!max1m) return out;
    for (let i = candles1m.length - max1m; i < candles1m.length; i++) {
      const c = candles1m[i];
      out.spot.push({ t: c.timestamp || c.t || c.time, v: c.close });
    }
    if (futuresCandles1m?.length) {
      const fmax = Math.min(80, futuresCandles1m.length);
      for (let i = futuresCandles1m.length - fmax; i < futuresCandles1m.length; i++) {
        const c = futuresCandles1m[i];
        out.futures.push({ t: c.timestamp || c.t || c.time, v: c.close });
      }
    }
    return out;
  })();

  // FRVP histogram from volume analysis frvp.bins / hvns / lvns
  const frvpHistogram = (() => {
    const frvp = volumeAnalysis?.frvp;
    if (!frvp?.bins?.length) {
      // Synthesise from HVNs / LVNs if bins absent
      const points = [];
      const hvns = frvp?.hvns || frvp?.hvn || [];
      const lvns = frvp?.lvns || frvp?.lvn || [];
      for (const h of hvns) points.push({ price: Number(h.price), volume: Number(h.volume), bias: h.bias });
      for (const l of lvns) points.push({ price: Number(l.price), volume: Number(l.volume) });
      return points.sort((a, b) => a.price - b.price);
    }
    return frvp.bins.map((b) => ({ price: Number(b.price), volume: Number(b.volume), delta: Number(b.delta || 0) }));
  })();

  // Long Build-up / Short Covering verdicts (futures price vs OI proxy)
  const buildUp = (() => {
    const peWriting = !!optionsBlock?.pe_writing;
    const ceUnwind = !!optionsBlock?.ce_unwinding;
    return {
      longBuildUp: peWriting,
      shortCovering: ceUnwind,
    };
  })();

  // Live alerts (synth)
  const liveAlerts = _liveAlerts({
    optionsBlock, atmStrike, ladder, futuresLead, heavyweightsImpact,
  });

  // Trading day metadata for the sidebar
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const istDay = istNow.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const tradingDayMeta = {
    today: istDay,
    expiry: payload.expiry_context?.expiry || null,
    daysToExpiry: payload.expiry_context?.days_to_expiry || null,
    lotSize: settings.lotSize || sym.lotSize || 65,
  };

  const response = {
    ok: true,
    symbol: SYMBOL,
    displayName: sym.displayName,
    at: Date.now(),
    dataSource,
    market: {
      isOpen: marketOpen,
      phase: session?.phase || "unknown",
      aggressionFactor: _safe(session?.aggressionFactor, 0.7),
      isExpiryWindow: !!session?.isExpiryWindow,
    },
    spot: {
      ltp: spotPrice,
      change: spotChange,
      changePct: spotChangePct,
      dayHigh: _safe(payload.spot_data?.high ?? structure?.dayHigh, lastCandle.high),
      dayLow: _safe(payload.spot_data?.low ?? structure?.dayLow, lastCandle.low),
      pdh: _safe(priorDay?.high ?? structure?.priorDay?.high),
      pdl: _safe(priorDay?.low ?? structure?.priorDay?.low),
      priorClose: _safe(priorDay?.close),
      openingRangeHigh: _safe(structure?.openingRange?.high),
      openingRangeLow: _safe(structure?.openingRange?.low),
      vwap: _safe(payload.vwap_analysis?.vwap),
      ema9: _safe(payload.moving_averages?.ema_9),
      ema20: _safe(payload.moving_averages?.ema_20),
      ema50: _safe(payload.moving_averages?.ema_50),
    },
    futures: {
      ltp: futLtp,
      premium: futPremium,
      basisState: futuresLead?.basis?.trend || "unknown",
      basis: _safe(futuresLead?.basis?.basis ?? futPremium),
      direction: futuresLead?.futuresDirection || "neutral",
      leadLagScore: _safe(futuresLead?.leadLagScore, 50),
      score: _safe(futuresLead?.score, 50),
      aggressive: !!futuresLead?.aggressiveCandle?.detected,
      available: futuresLead?.available !== false,
      reasoning: futuresLead?.reasoning || "",
    },
    regime: {
      market: marketRegime?.regime || "unknown",
      volatility: volatility?.state || "unknown",
      meta: meta?.label || meta?.regime || "unknown",
      gamma: gammaRegime?.state || "neutral",
      orderflow: orderflowState?.state || "neutral",
      aggressionMode: aggression?.mode || "balanced",
      mtfStructure: mtfStructure?.permission || mtfStructure?.bias || "unknown",
    },
    bias: {
      directionScore,
      overallBias,
      allowedDirections: derivatives?.allowedDirections || ["bullish", "bearish"],
      reasoning: derivatives?.reasoning || "",
      smartMoney: smartMoney.label,
      smartMoneyStrength: smartMoney.strength,
    },
    confidence: {
      bullish: _safe(confidenceBull?.score, 50),
      bearish: _safe(confidenceBear?.score, 50),
      winning: confidence,
      pillars: winningConf?.breakdown || winningConf?.pillars || null,
    },
    premiumHealth: { ce: ceHealth, pe: peHealth },
    trap: {
      risk: trapRisk,
      score: trapScore,
      blocked: !!traps?.blocked,
      hardBlock: !!traps?.hardBlock,
      reasoning: traps?.reasoning || "",
      breakdown: traps?.breakdown || {},
    },
    flow: {
      delta: {
        cvd: _safe(volumeAnalysis?.delta?.cvdPctLong),
        velocity: _safe(delta?.velocity, 0),
        velocityScore: _safe(delta?.velocityScore, 50),
        velocityState: delta?.velocityState || "unknown",
        acceleration: _safe(delta?.acceleration, 0),
        flip: !!delta?.flipDetected,
        exhaustion: !!delta?.exhaustionDetected,
        bias: volumeAnalysis?.delta?.bias || "neutral",
        strength: _safe(volumeAnalysis?.delta?.strength, 0),
        trend: volumeAnalysis?.delta?.trend || "flat",
        divergence: volumeAnalysis?.delta?.divergence || null,
      },
      microstructure: {
        bidAskImbalance: _safe(microstructure?.imbalance?.value, 0),
        absorption: !!microstructure?.signals?.absorption?.detected,
        absorptionSide: microstructure?.signals?.absorption?.side || null,
        iceberg: !!microstructure?.signals?.iceberg?.detected,
        spoofing: !!microstructure?.signals?.spoofing?.detected,
        liquidityPull: !!microstructure?.signals?.liquidityPull?.detected,
        score: _safe(microstructure?.score, 50),
        available: microstructure?.available !== false,
      },
      volume: {
        spike: volumeAnalysis?.timeVolume?.state === "spike" || _safe(volumeAnalysis?.timeVolume?.ratio, 1) >= 1.5,
        ratio: _safe(volumeAnalysis?.timeVolume?.ratio, 1),
        state: volumeAnalysis?.timeVolume?.state || "normal",
        vsa: volumeAnalysis?.vsa?.pattern || "normal",
        vsaBias: volumeAnalysis?.vsa?.bias || "neutral",
        poc: _safe(volumeAnalysis?.frvp?.poc),
        vah: _safe(volumeAnalysis?.frvp?.vah),
        val: _safe(volumeAnalysis?.frvp?.val),
        hvns: volumeAnalysis?.frvp?.hvns || volumeAnalysis?.frvp?.hvn || [],
        lvns: volumeAnalysis?.frvp?.lvns || volumeAnalysis?.frvp?.lvn || [],
        acceptance: volumeAnalysis?.acceptance || "unknown",
        zone: volumeAnalysis?.zone?.zone || "neutral",
      },
      oi: {
        ceWriting: !!optionsBlock?.ce_writing,
        peWriting: !!optionsBlock?.pe_writing,
        ceUnwinding: !!optionsBlock?.ce_unwinding,
        peUnwinding: !!optionsBlock?.pe_unwinding,
        pcr,
        ceTotal: _safe(optionsBlock?.ce_oi_total ?? atmBlocks.ceTotal),
        peTotal: _safe(optionsBlock?.pe_oi_total ?? atmBlocks.peTotal),
        velocity: _safe(oiAnalytics?.velocity, 0),
        acceleration: _safe(oiAnalytics?.acceleration, 0),
        migration: oiAnalytics?.migration || null,
        absorption: !!oiAnalytics?.absorption,
        qualityScore: _safe(oiAnalytics?.qualityScore, 50),
      },
    },
    options: {
      atm: atmStrike,
      maxPain,
      atmIv: _safe(optionsBlock?.atm_iv),
      atmCall: optionsBlock?.atm_call || atmBlocks.ceAtm,
      atmPut: optionsBlock?.atm_put || atmBlocks.peAtm,
      callWall,
      putWall,
    },
    smc: {
      bos: smc?.bos || null,
      choch: smc?.choch || null,
      orderBlocks: smc?.orderBlocks || [],
      fvg: smc?.fairValueGaps || [],
    },
    structure: {
      dayHigh: _safe(structure?.dayHigh),
      dayLow: _safe(structure?.dayLow),
      pdh: _safe(priorDay?.high ?? structure?.priorDay?.high),
      pdl: _safe(priorDay?.low ?? structure?.priorDay?.low),
      priorClose: _safe(priorDay?.close),
      orh: _safe(structure?.openingRange?.high),
      orl: _safe(structure?.openingRange?.low),
      swingHighs: structure?.swingHighs5m || [],
      swingLows: structure?.swingLows5m || [],
      distances: structure?.distances || null,
    },
    ladder,
    cpr,
    avwap: {
      session: sessionAvwap,
      priorDay: avwapAnchorPriorDay,
    },
    macro: macro || null,
    heavyweights: heavy || null,
    verdict,
    tradePlan,
    action,
    // ── DASHBOARD SECTIONS ───────────────────────────────────────────────
    dashboard: {
      statusWidgets,
      tradingDay: tradingDayMeta,
      spotFutSeries,
      buildUp,
      futuresInfo: {
        oi: _safe(payload.futures_data?.oi),
        oiChange: _safe(payload.futures_data?.oiChange),
        volume: _safe(payload.futures_data?.volume),
        ltp: futLtp,
        premium: futPremium,
        basis: _safe(futuresLead?.basis?.basis ?? futPremium),
        basisTrend: futuresLead?.basis?.trend || 'unknown',
      },
      oiHistogram,
      cvdSeries,
      delta: {
        totalBuyVol: _safe(volumeAnalysis?.frvp?.totalUpVolume ?? volumeAnalysis?.totalUpVolume),
        totalSellVol: _safe(volumeAnalysis?.frvp?.totalDownVolume ?? volumeAnalysis?.totalDownVolume),
        netDelta: _safe(volumeAnalysis?.totalDelta ?? volumeAnalysis?.frvp?.totalDelta),
        deltaPct: _safe(volumeAnalysis?.deltaPct ?? volumeAnalysis?.frvp?.deltaPct),
        bidAskImbalance: _safe(microstructure?.imbalance?.value, 0),
      },
      frvpHistogram,
      priceAbovePoc,
      breadth,
      heavyweightsImpact,
      heavyweightsTotalImpact,
      ivAnalytics: {
        vix: macro?.vix?.price || null,
        vixChangePct: macro?.vix?.changePct || null,
        atmIv: _safe(optionsBlock?.atm_iv),
        atmIvChangePct: null, // would need history; left null
        ivRank,
        trend: ivTrendSeries,
      },
      trapDetector: trapDetectorRows,
      regimeClassification,
      optionChainSnapshot,
      topStrikeSelections,
      riskManagement,
      liveAlerts,
    },
    debug: {
      payloadKeys: Object.keys(outer || {}),
      innerKeys: Object.keys(payload || {}),
      candleCounts: {
        "1m": candles1m.length,
        "5m": candles5m.length,
        "15m": candles15m.length,
        "30m": candles30m.length,
      },
      strikeCount: strikes.length,
      ladderCount: ladder.length,
      tickDeltaActive: !!tickDelta?.getStatus?.()?.running,
      microstructureAvailable: microstructure?.available !== false,
      futuresLeadAvailable: futuresLead?.available !== false,
      deltaAvailable: delta?.available !== false,
      executionMode: settings.executionMode,
      activeEngines: {
        ultraScalp: settings.ultraScalpingEngine,
        supportScalp: settings.supportScalpEngine,
        premiumSwing: settings.premiumSwingEngine,
        core: settings.coreEngine,
      },
    },
  };

  _cache.set(SYMBOL, { at: Date.now(), payload: response });
  return response;
}

module.exports = { getSnapshot };
