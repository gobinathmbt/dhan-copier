/**
 * Master Scalping Entry Engine
 * ============================
 * Routes every cycle to one of three independent engines based on
 * settings flags:
 *
 *   ultraScalpingEngine  (priority 1) → ultraScalpEngine + ultraScalpStrikeSelector
 *   supportScalpEngine   (priority 2) → supportScalpEngine + supportScalpStrikeSelector
 *   coreEngine           (priority 3) → hybridEntryEngine (full institutional pipeline)
 *
 * If multiple are enabled, takes the FIRST valid signal in priority order.
 * If none enabled or none fire, returns NO_TRADE.
 *
 * The trade record is stamped with engineType so the monitor can route
 * exits to the matching engine, and the UI can show which engine produced it.
 */

const ultraScalpEngine        = require('./ultraScalpEngine');
const ultraScalpStrikeSelector = require('./ultraScalpStrikeSelector');
const supportScalpEngine      = require('./supportScalpEngine');
const supportScalpStrikeSelector = require('./supportScalpStrikeSelector');
const symbolRegistry          = require('../../config/symbolRegistry');
// Core engine — the full institutional hybrid pipeline. Lazy-required so
// when coreEngine=false we don't pull in the heavy graph.
let _coreEngine = null;
function _getCore() {
  if (!_coreEngine) _coreEngine = require('./hybridEntryEngine');
  return _coreEngine;
}

const hybridLogger = require('./hybridLogger');

/**
 * @param {object} params — same shape that the core hybrid entry receives:
 *   { aggregator, algorithmOutputs, masterDecision, settings, session,
 *     openTradesCount, futuresData, tradesToday, lossesToday }
 *
 * Internally extracts candles / VWAP / volumeAnalysis from aggregator
 * and routes to ultra/support/core sub-engines.
 *
 * @returns {Promise<object>} decision payload (same shape as institutional
 *   AI decision — adds `engineType`, `market` for downstream stamping).
 */
async function decide(params) {
  const settings = params.settings || {};
  const sessionId = params.session?._id || params.sessionId;
  // Resolve the market from the params first, then settings.tradingSymbols,
  // then fall back to the registry's active symbol (set by scalpingEngine.start()).
  const market    = params.market
    || (settings.tradingSymbols?.[0])
    || symbolRegistry.getActiveSymbol()
    || 'NIFTY_50';

  const ultraOn   = settings.ultraScalpingEngine !== false;
  const supportOn = settings.supportScalpEngine === true;
  const coreOn    = settings.coreEngine === true;

  if (!ultraOn && !supportOn && !coreOn) {
    return _noTrade('all engines disabled', { engineType: 'NONE', market });
  }

  // ── Extract candles / context from aggregator ─────────────────────────
  // Core engine expects { aggregator, algorithmOutputs, ... } directly.
  // Ultra & support engines expect raw candle arrays — we pull them from
  // the aggregator payload and historical context.
  const payload = params.aggregator?.payload || {};
  const histCtx = await _getHistoricalCandles(params);
  const candles1m  = histCtx?.['1m']  || [];
  const candles3m  = _build3m(candles1m);
  const candles5m  = histCtx?.['5m']  || [];
  const candles15m = histCtx?.['15m'] || [];
  const spotPrice  = payload?.spot_data?.ltp || params.aggregator?.spotPrice;
  const atmStrike  = params.aggregator?.atmStrike || payload?.actual_atm_strike;
  const primaryStrikes = payload?.options_chain?.strikes || params.aggregator?.optionChain?.strikes || [];
  const vwap       = payload?.vwap_analysis ? {
    vwap: payload.vwap_analysis.vwap,
    position: payload.vwap_analysis.position || payload.vwap_analysis.price_vs_vwap,
  } : null;
  const volumeAnalysis = payload?.volume_orderflow || null;
  const volatilityRegime = params.volatilityRegime
    || { state: payload?.market_regime?.volatility || 'normal', atr5m: payload?.atr5m };
  const marketRegime = params.marketRegime
    || { regime: payload?.market_regime?.current_regime, bias: 'neutral' };
  const sessionPhase = params.sessionPhase || null;

  const futuresData = params.futuresData || null;
  const openingStrike = (() => {
    try {
      const profSession = require('../professionalTrader.service').getMarketSession();
      return Number(profSession?.openingStrike) || atmStrike;
    } catch (_) { return atmStrike; }
  })();

  // ── 1. ULTRA SCALP ENGINE (priority 1) ─────────────────────────────
  if (ultraOn) {
    try {
      const ultra = ultraScalpEngine.decide({
        candles1m, candles3m, candles5m, candles15m,
        vwap, volumeAnalysis, volatilityRegime, marketRegime,
        spotPrice, atr: { atr_5m: volatilityRegime?.atr5m },
        settings,
      });
      hybridLogger.info({
        sessionId, event: 'master_ultra_scalp',
        message: ultra.fired
          ? `[ULTRA] ${ultra.signal} ${ultra.direction} ${ultra.timeframe} conf=${ultra.confidence}`
          : `ultra not fired: ${(ultra.reasoning || '').slice(0, 200)}`,
        data: { fired: ultra.fired, market, reasoning: ultra.reasoning },
      });
      if (ultra.fired) {
        const tier = ultra.confluenceTier || 'standard';
        const strikeRes = ultraScalpStrikeSelector.select({
          direction:      ultra.direction,
          atmStrike,
          primaryStrikes,
          tier,
          openingStrike,
          maxPain:        payload?.options_chain?.max_pain,
          windowHalf:     4,
          hhmm:           sessionPhase?.hhmm,
        });
        if (strikeRes.ok) {
          return _wrapDecision(ultra, strikeRes, 'ULTRA_SCALP', market);
        }
        hybridLogger.warn({ sessionId, event: 'master_ultra_strike_failed',
          message: strikeRes.reason, data: { strikeRes } });
      }
    } catch (e) {
      hybridLogger.warn({ sessionId, event: 'master_ultra_error',
        message: e.message, data: { err: e.message, stack: e.stack?.slice(0, 500) } });
    }
  }

  // ── 2. SUPPORT SCALP ENGINE (priority 2) ────────────────────────────
  if (supportOn) {
    try {
      const sup = supportScalpEngine.decide({
        candles1m, candles3m, candles5m, candles15m,
        vwap, spotPrice, atr: { atr_5m: volatilityRegime?.atr5m },
        settings,
      });
      hybridLogger.info({
        sessionId, event: 'master_support_scalp',
        message: sup.fired
          ? `[SUPPORT] ${sup.signal} ${sup.direction} ${sup.timeframe} conf=${sup.confidence}`
          : `support not fired: ${(sup.reasoning || '').slice(0, 200)}`,
        data: { fired: sup.fired, market, reasoning: sup.reasoning },
      });
      if (sup.fired) {
        const strikeRes = supportScalpStrikeSelector.select({
          direction:      sup.direction,
          atmStrike,
          primaryStrikes,
          openingStrike,
          maxPain:        payload?.options_chain?.max_pain,
          windowHalf:     5,
          hhmm:           sessionPhase?.hhmm,
        });
        if (strikeRes.ok) {
          return _wrapDecision(sup, strikeRes, 'SUPPORT_SCALP', market);
        }
        hybridLogger.warn({ sessionId, event: 'master_support_strike_failed',
          message: strikeRes.reason, data: { strikeRes } });
      }
    } catch (e) {
      hybridLogger.warn({ sessionId, event: 'master_support_error',
        message: e.message, data: { err: e.message, stack: e.stack?.slice(0, 500) } });
    }
  }

  // ── 3. CORE ENGINE (priority 3) — full institutional pipeline ───────
  if (coreOn) {
    try {
      const core = _getCore();
      const decision = await core.decide(params);
      if (decision && decision.signal && decision.signal !== 'NO_TRADE') {
        decision.engineType = 'CORE';
        decision.market = market;
        return decision;
      }
    } catch (e) {
      hybridLogger.warn({ sessionId, event: 'master_core_error',
        message: e.message, data: { err: e.message, stack: e.stack?.slice(0, 500) } });
    }
  }

  return _noTrade('no engine produced a signal this cycle',
    { engineType: ultraOn ? 'ULTRA_SCALP' : (supportOn ? 'SUPPORT_SCALP' : 'CORE'), market });
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────
async function _getHistoricalCandles(params) {
  // Reuse the historicalContextLoader the core engine uses, so we get the
  // same data the institutional pipeline sees.
  try {
    const histLoader = require('../historicalContextLoader.service');
    const ctx = await histLoader.buildHistoricalContext({
      maxBackfillDays: 1,
      includeRawToday: true,
    });
    return ctx?.today?.candles || {};
  } catch (_) {
    return {};
  }
}

function _build3m(c1m) {
  if (!Array.isArray(c1m) || c1m.length < 3) return [];
  const out = [];
  for (let i = 0; i < c1m.length; i += 3) {
    const slice = c1m.slice(i, i + 3);
    if (!slice.length) continue;
    const o = slice[0].o ?? slice[0].open;
    const c = slice[slice.length - 1].c ?? slice[slice.length - 1].close;
    let h = -Infinity, l = Infinity, v = 0;
    for (const b of slice) {
      const bh = b.h ?? b.high; const bl = b.l ?? b.low; const bv = b.v ?? b.volume ?? 0;
      if (Number.isFinite(bh) && bh > h) h = bh;
      if (Number.isFinite(bl) && bl < l) l = bl;
      v += bv;
    }
    out.push({ o, h, l, c, v, t: slice[0].t });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────
function _wrapDecision(engineRes, strikeRes, engineType, market) {
  return {
    should_enter: true,
    signal:     engineRes.direction === 'bullish' ? 'BUY_CE' : 'BUY_PE',
    direction:  engineRes.direction,
    strike:     strikeRes.strike,
    option_type: strikeRes.optionType,
    moneyness:  strikeRes.moneyness,
    entry_premium_estimate: strikeRes.ltp,
    sl_points:  engineRes.sl_pts,
    target_points: engineRes.target_pts,
    suggested_max_hold_seconds: engineRes.maxHoldSec,
    max_hold_seconds: engineRes.maxHoldSec,
    expected_points: engineRes.target_pts,
    confidence: engineRes.confidence / 10,           // legacy scale 0-10
    confidenceScore: engineRes.confidence,
    confidenceTier: engineRes.confluenceTier || 'standard',
    trade_type: 'SCALP',
    strategy:   engineType === 'ULTRA_SCALP' ? 'ULTRA_SCALP' : 'SUPPORT_SCALP_CONFLUENCE',
    reasoning:  engineRes.reasoning,
    risks: [],
    futures_agreement: false,
    atr_validated: true,
    lots_suggested: 1,
    min_target_achievable: true,
    breakout_probability: 0.65,
    // Engine routing metadata
    engineType, market,
    // Hybrid snapshot — the monitor uses these for smart-trail / decay
    hybridSnapshot: {
      grade: 'B',
      score: engineRes.consensusScore || 80,
      tradeType: 'SCALP',
      strategy: engineType,
      direction: engineRes.direction,
      timeframe: engineRes.timeframe,
      capturedAt: new Date().toISOString(),
      entryType: {
        type: engineRes.name,
        score: engineRes.confidence,
        exitStyle: 'ultra_scalp_managed',
        holdProfile: engineRes.holdProfile,
        playbook: {
          name: engineRes.name,
          family: engineRes.family,
          conviction: engineRes.confluenceTier || 'standard',
          score: engineRes.confidence,
          risk: engineRes.riskProfile,
          smartTrail: engineRes.smartTrail || null,
          ultra: engineType === 'ULTRA_SCALP',
          supportScalp: engineType === 'SUPPORT_SCALP',
        },
      },
    },
    _hybrid: true,
    _engine: engineType,
  };
}

function _noTrade(reason, extras = {}) {
  return {
    signal: 'NO_TRADE', trade_type: 'NONE',
    strike: 0, option_type: 'NONE', entry_premium_estimate: 0,
    expected_points: 0, min_target_achievable: false, confidence: 0,
    risks: [], reasoning: String(reason || 'no trade'),
    lots_suggested: 0, sl_points: 0, target_points: 0, max_hold_seconds: 0,
    futures_agreement: false, atr_validated: false,
    _hybrid: true, ...extras,
  };
}

module.exports = { decide };
