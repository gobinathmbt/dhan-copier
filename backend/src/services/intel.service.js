/**
 * Intel Service — Institutional Intelligence Snapshot
 * ====================================================
 * Read-only composer that calls the existing hybrid engines + tick delta
 * classifier + microstructure engine + futures leadership + derivatives
 * engine and returns ONE flat JSON shape that the institutional terminal
 * UI consumes via `GET /api/intel/snapshot?symbol=...`.
 *
 * No engine state mutation. No order placement. No DB writes. Pure read.
 */

const env = require('../config/env');
const logger = require('../utils/logger');
const symbolRegistry = require('../config/symbolRegistry');
const aggregator = require('./scalpingDataAggregator.service');
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
const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');

// Algorithm services
const liquidityAnalysis = require('./algorithms/liquidityAnalysis.service');
const smartMoneyConcepts = require('./algorithms/smartMoneyConcepts.service');
const marketInternals = require('./algorithms/marketInternals.service');

// Single short-lived cache so multiple UI clients don't hammer the
// aggregator. The aggregator does network + disk reads; cap at 1.5s.
let _cache = new Map(); // key: symbol → { at, payload }
const CACHE_MS = 1500;

function _safe(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

function _activeAuthKey() {
  // Engine pipeline uses the production Dhan token from env. Aggregator
  // accepts the same shape used by the rest of the system.
  return env.dhanAccessToken || process.env.DHAN_ACCESS_TOKEN || null;
}

/**
 * Map directionScore (0..100) into action language the UI can render.
 */
function _bestAction({ directionScore, regime, trapRisk, confidence }) {
  if (regime === 'choppy' || regime === 'unknown') {
    return { action: 'NO_TRADE', reason: 'choppy/unclear regime' };
  }
  if (trapRisk === 'high') {
    return { action: 'WAIT', reason: 'trap risk high — wait for confirmation' };
  }
  if (confidence < 50) {
    return { action: 'WAIT', reason: 'confidence below 50' };
  }
  if (directionScore >= 60) {
    return { action: 'BUY_CE', reason: `bullish bias score ${directionScore}` };
  }
  if (directionScore <= 40) {
    return { action: 'BUY_PE', reason: `bearish bias score ${directionScore}` };
  }
  return { action: 'WAIT', reason: 'neutral bias' };
}

/**
 * Premium Health = composite of velocity + IV expansion + delta efficiency.
 * Returns { state, score 0..100, factors }.
 */
function _premiumHealth(side /* 'CE'|'PE' */, payload, derivResult) {
  const optionsBlock = payload.options || {};
  const atmRow = side === 'CE' ? optionsBlock.atm_call : optionsBlock.atm_put;
  if (!atmRow) {
    return { state: 'unknown', score: 50, ltp: null, factors: { reason: 'no ATM row' } };
  }
  const ltp = _safe(atmRow.ltp, 0);
  const iv = _safe(atmRow.iv, 0);
  const delta = _safe(atmRow.delta, 0);
  const oi = _safe(atmRow.oi, 0);

  // Velocity proxy — last bar candle range divided by previous bar's
  const last1 = payload?.candles_1m?.slice(-3) || [];
  const last1Range = last1.length >= 2 ? Math.abs(last1[last1.length - 1].close - last1[last1.length - 2].close) : 0;
  const lastN = payload?.candles_1m?.slice(-10) || [];
  const avgRange = lastN.length ? lastN.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / lastN.length : 0;
  const velocityRatio = avgRange > 0 ? last1Range / avgRange : 1;

  // Direction projection: CE benefits from bullish move (delta>0 typical),
  // PE from bearish (delta<0 typical). Use a light score that blends them.
  let score = 50;
  const factors = {
    velocity_ratio: Number(velocityRatio.toFixed(2)),
    iv: iv,
    delta_abs: Math.abs(delta),
    oi: oi,
    ltp: ltp,
  };

  if (velocityRatio >= 1.5) score += 15;
  else if (velocityRatio >= 1.0) score += 5;
  else if (velocityRatio < 0.6) score -= 15;

  if (Math.abs(delta) >= 0.45) score += 10;
  else if (Math.abs(delta) <= 0.25) score -= 10;

  // Use derivatives bias: aligns with the side?
  const bias = derivResult?.overallBias || 'neutral';
  if (side === 'CE' && bias === 'bullish') score += 10;
  if (side === 'PE' && bias === 'bearish') score += 10;
  if (side === 'CE' && bias === 'bearish') score -= 10;
  if (side === 'PE' && bias === 'bullish') score -= 10;

  if (iv && iv < 10) score -= 10;
  if (iv && iv > 80) score -= 5; // very high IV = expensive

  score = Math.max(0, Math.min(100, score));
  let state = 'healthy';
  if (score >= 70) state = 'explosive';
  else if (score >= 55) state = 'healthy';
  else if (score >= 40) state = 'weak';
  else state = 'dead';

  return { state, score: Math.round(score), ltp, factors };
}

/**
 * Smart money bias label from microstructure + delta + OI.
 */
function _smartMoneyBias({ microstructure, volumeAnalysis, oi }) {
  const deltaBias = volumeAnalysis?.delta?.bias || 'neutral';
  const deltaStrength = _safe(volumeAnalysis?.delta?.strength, 0);
  const cvdPct = _safe(volumeAnalysis?.delta?.cvdPctLong, 0);
  const peWriting = !!oi?.pe_writing;
  const ceWriting = !!oi?.ce_writing;
  const absorption = microstructure?.signals?.absorption?.detected;

  if (absorption) {
    return {
      label: 'absorption',
      strength: 70,
      detail: microstructure?.signals?.absorption?.side || '',
    };
  }
  if (deltaBias === 'bullish' && deltaStrength >= 60 && peWriting) {
    return { label: 'buyers_aggressive', strength: 85 };
  }
  if (deltaBias === 'bearish' && deltaStrength >= 60 && ceWriting) {
    return { label: 'sellers_aggressive', strength: 85 };
  }
  if (deltaBias === 'bullish' || cvdPct > 8) return { label: 'buyers_aggressive', strength: 60 };
  if (deltaBias === 'bearish' || cvdPct < -8) return { label: 'sellers_aggressive', strength: 60 };
  if (Math.abs(cvdPct) < 2) return { label: 'neutral', strength: 50 };
  return { label: 'neutral', strength: 50 };
}

/**
 * Build a simplified strike ladder for the live ladder widget.
 */
function _strikeLadder(payload) {
  const optionsBlock = payload.options || {};
  const strikes = optionsBlock.strikes || [];
  const atm = optionsBlock.atm_strike;
  if (!atm || !strikes.length) return [];
  // Centre on ATM ± 6
  const idx = strikes.findIndex(s => s.strike === atm);
  if (idx < 0) return [];
  const window = strikes.slice(Math.max(0, idx - 6), idx + 7);
  return window.map(s => {
    const ce = s.call || {};
    const pe = s.put || {};
    return {
      strike: s.strike,
      isAtm: s.strike === atm,
      ce: {
        ltp: _safe(ce.ltp, 0),
        oi: _safe(ce.oi, 0),
        oiChange: _safe(ce.oiChange, 0),
        iv: _safe(ce.iv, 0),
        delta: _safe(ce.greeks?.delta, 0),
        gamma: _safe(ce.greeks?.gamma, 0),
        theta: _safe(ce.greeks?.theta, 0),
        volume: _safe(ce.volume, 0),
      },
      pe: {
        ltp: _safe(pe.ltp, 0),
        oi: _safe(pe.oi, 0),
        oiChange: _safe(pe.oiChange, 0),
        iv: _safe(pe.iv, 0),
        delta: _safe(pe.greeks?.delta, 0),
        gamma: _safe(pe.greeks?.gamma, 0),
        theta: _safe(pe.greeks?.theta, 0),
        volume: _safe(pe.volume, 0),
      },
    };
  });
}

/**
 * Spark: mini OHLC array for the chart widget.
 */
function _spark(candles, n = 60) {
  if (!Array.isArray(candles)) return [];
  return candles.slice(-n).map(c => ({
    t: c.timestamp || c.t,
    o: _safe(c.open ?? c.o),
    h: _safe(c.high ?? c.h),
    l: _safe(c.low ?? c.l),
    c: _safe(c.close ?? c.c),
    v: _safe(c.volume ?? c.v),
  }));
}

/**
 * Public — build snapshot for one symbol.
 */
async function getSnapshot(symbolKey = 'NIFTY_50') {
  const SYMBOL = String(symbolKey).toUpperCase();

  // Cache check
  const cached = _cache.get(SYMBOL);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.payload;
  }

  // Switch active symbol so the aggregator pulls the right candles.
  const previousActive = symbolRegistry.getActiveSymbol();
  try {
    symbolRegistry.setActiveSymbols({ tradingSymbols: [SYMBOL] });
  } catch (_) { /* ignore */ }

  const sym = symbolRegistry.getSymbol(SYMBOL);
  const authKey = _activeAuthKey();

  let payload = null;
  try {
    payload = await aggregator.buildPayload(authKey);
  } catch (e) {
    logger.warn({ err: e.message, sym: SYMBOL }, '[intel] aggregator failed');
    payload = null;
  }

  // Restore active symbol so we don't disturb running sessions.
  try {
    symbolRegistry.setActiveSymbols({ tradingSymbols: [previousActive] });
  } catch (_) {}

  if (!payload) {
    return {
      ok: false,
      symbol: SYMBOL,
      error: 'no payload',
      at: Date.now(),
    };
  }

  // Run hybrid engines on the payload. Each engine is wrapped in try/catch
  // so a single failure can never break the snapshot.
  const candles1m = payload.candles_1m || payload.spotCandles || [];
  const candles5m = payload.candles_5m || [];
  const candles15m = payload.candles_15m || [];
  const candles30m = payload.candles_30m || [];

  const lastCandle = candles1m[candles1m.length - 1] || {};
  const spotPrice = _safe(payload?.spot?.ltp, lastCandle.close);

  function safeRun(label, fn, fallback = null) {
    try { return fn(); }
    catch (e) {
      logger.warn({ err: e.message, label }, '[intel] engine failed');
      return fallback;
    }
  }

  // — Session
  const session = safeRun('session', () => sessionEngine.classifySession());

  // — Volatility regime
  const volatility = safeRun('volatility', () =>
    volatilityRegimeEngine.classify({ candles1m, candles5m })
  );

  // — Market regime
  const marketRegime = safeRun('regime', () =>
    marketRegimeEngine.classify({
      candles1m,
      candles5m,
      candles15m,
      multiTimeframe: payload.mtf_analysis,
      volatility,
    })
  );

  // — Market structure
  const structure = safeRun('structure', () =>
    marketStructureEngine.analyze({
      spotPrice,
      candles5m,
      candles15m,
    })
  );

  // — Tick delta snapshot (used by volume + delta velocity engines)
  const tickDeltaSnap = safeRun('tickDelta', () =>
    tickDelta?.getRollingBuckets?.(sym.indexSegment, sym.indexSecurityId)
  );

  // — Derivatives intelligence (the OI / PCR / futures / gamma fusion)
  const derivatives = safeRun('derivatives', () =>
    derivativesEngine.analyze({
      optionChain: payload.optionChain,
      primaryStrikes: payload.options?.strikes || payload.optionChain?.strikes,
      pcr: payload.options?.pcr_total,
      maxPain: payload.options?.max_pain,
      gammaExposure: payload.gamma_exposure,
      futuresData: payload.futures || payload.futures_analysis,
      spotPrice,
      atmStrike: payload.options?.atm_strike,
    })
  );

  const direction = derivatives?.overallBias || 'neutral';

  // — MTF structure (needs direction)
  const mtfStructure = safeRun('mtfStructure', () =>
    mtfStructureEngine.evaluate({
      candles1m,
      candles5m,
      candles15m,
      direction,
    })
  );

  // — Liquidity
  const liquidityRaw = safeRun('liquidityAnalysis', () =>
    liquidityAnalysis.analyzeLiquidity(payload.optionChain || payload.options, spotPrice)
  );
  const liquidity = safeRun('liquidityEngine', () =>
    liquidityEngine.evaluate(liquidityRaw)
  );

  // — Volume analysis (FRVP / CVD / VSA)
  const volumeAnalysis = safeRun('volume', () =>
    volumeAnalysisEngine.analyze({
      candles5m,
      candles15m,
      spotPrice,
      direction,
      liveTickDelta: tickDeltaSnap,
    })
  );

  // — OI analytics
  const oiAnalytics = safeRun('oiAnalytics', () =>
    oiAnalyticsEngine.analyze({
      sessionId: 'intel',
      primaryStrikes: payload.options?.strikes || payload.optionChain?.strikes,
      atmStrike: payload.options?.atm_strike,
      spotPrice,
      direction,
    })
  );

  // — Smart Money Concepts (BOS / FVG / order blocks)
  const smc = safeRun('smc', () =>
    smartMoneyConcepts.analyzeSMC
      ? smartMoneyConcepts.analyzeSMC(candles1m, payload.optionChain, spotPrice)
      : null
  );

  // — UT Bot
  const utBot = safeRun('utBot', () =>
    utBotEngine.evaluate(payload.mtf_analysis, direction)
  );

  // — Microstructure (live tick-derived)
  const microstructure = safeRun('microstructure', () =>
    microstructureEngine.analyze({
      segment: sym.indexSegment,
      securityId: sym.indexSecurityId,
      direction,
    })
  );

  // — Futures leadership
  const futuresLead = safeRun('futuresLead', () =>
    futuresLeadershipEngine.analyze({
      futuresData: payload.futures || payload.futures_analysis,
      candles1m,
      candles5m,
      futuresCandles1m: payload.futures_candles_1m,
      futuresCandles5m: payload.futures_candles_5m,
      spotPrice,
      direction,
    })
  );

  // — Delta velocity
  const delta = safeRun('delta', () =>
    deltaVelocityEngine.analyze({
      candles5m,
      liveTickDelta: tickDeltaSnap,
      direction,
    })
  ) || {};

  // — Trap detection
  const traps = safeRun('traps', () =>
    trapDetectionEngine.evaluate({
      spotPrice,
      direction,
      volumeAnalysis,
      vwap: payload.vwap,
      multiTimeframe: payload.mtf_analysis,
      todayStats: structure,
      oiAnalytics,
    })
  );

  // — Orderflow state
  const orderflowState = safeRun('orderflowState', () =>
    orderflowStateEngine.classify({
      volumeAnalysis,
      oiAnalytics,
      futuresData: payload.futures || payload.futures_analysis,
      priceMove: spotPrice && structure?.dayLow
        ? spotPrice - _safe(structure.dayLow, spotPrice)
        : 0,
    })
  );

  // — Gamma regime
  const gammaRegime = safeRun('gamma', () =>
    gammaRegimeEngine.analyze({
      strikes: payload.options?.strikes || payload.optionChain?.strikes || [],
      spotPrice,
      atmStrike: payload.options?.atm_strike,
    })
  );

  // — Internals (best-effort, async — skip if it'd block)
  const internals = null;

  // — Confidence (institutional weights)
  const confidenceBull = safeRun('confidenceBull', () =>
    confidenceScoringEngine.score({
      direction: 'bullish',
      oiAnalytics,
      volumeAnalysis,
      vwap: payload.vwap,
      smc,
      liquidity,
      internals,
      derivatives,
      utBot,
      microstructure,
      futuresLead,
      deltaVelocity: delta,
    })
  );
  const confidenceBear = safeRun('confidenceBear', () =>
    confidenceScoringEngine.score({
      direction: 'bearish',
      oiAnalytics,
      volumeAnalysis,
      vwap: payload.vwap,
      smc,
      liquidity,
      internals,
      derivatives,
      utBot,
      microstructure,
      futuresLead,
      deltaVelocity: delta,
    })
  );

  const directionScore = _safe(derivatives?.directionScore, 50);
  const overallBias = direction;
  const winningConf = overallBias === 'bullish' ? confidenceBull : confidenceBear;
  const confidence = _safe(winningConf?.score, 50);

  // — Meta regime fusion
  const meta = safeRun('meta', () =>
    metaRegimeEngine.classify({
      session,
      volatility,
      marketRegime,
      gammaRegime,
      orderflowState,
      derivatives,
      structure,
    })
  );

  // — Aggression mode
  const aggression = safeRun('aggression', () =>
    aggressionModeEngine.evaluate({
      marketRegime,
      volatilityRegime: volatility,
      sessionPhase: session?.phase,
    })
  );

  // — Trap risk label
  const trapScore = _safe(traps?.trapScore, 0);
  let trapRisk = 'low';
  if (trapScore >= 70) trapRisk = 'high';
  else if (trapScore >= 40) trapRisk = 'medium';

  // — Premium Health (CE + PE)
  const ceHealth = _premiumHealth('CE', payload, derivatives);
  const peHealth = _premiumHealth('PE', payload, derivatives);

  // — Smart money bias label
  const smartMoney = _smartMoneyBias({
    microstructure,
    volumeAnalysis,
    oi: payload.options,
  });

  // — Best action
  const action = _bestAction({
    directionScore,
    regime: marketRegime?.regime,
    trapRisk,
    confidence,
  });

  // — OI walls (call wall = highest CE OI; put wall = highest PE OI)
  const oiWalls = {
    callWall: payload.options?.highest_ce_oi_strike || null,
    putWall: payload.options?.highest_pe_oi_strike || null,
    maxPain: payload.options?.max_pain || null,
  };

  // — Strike ladder
  const ladder = _strikeLadder(payload);

  // — Sparks
  const spark1m = _spark(candles1m, 60);
  const spark5m = _spark(candles5m, 60);

  // — Build response (flat-ish for UI consumption)
  const response = {
    ok: true,
    symbol: SYMBOL,
    displayName: sym.displayName,
    at: Date.now(),
    market: {
      isOpen: !!session?.isMarketOpen,
      phase: session?.phase || 'unknown',
      aggressionFactor: _safe(session?.aggressionFactor, 0.7),
      isExpiryWindow: !!session?.isExpiryWindow,
    },
    spot: {
      ltp: spotPrice,
      change: _safe(payload?.spot?.change),
      changePct: _safe(payload?.spot?.changePct),
      dayHigh: _safe(structure?.dayHigh, lastCandle.high),
      dayLow: _safe(structure?.dayLow, lastCandle.low),
      pdh: _safe(structure?.priorDay?.high),
      pdl: _safe(structure?.priorDay?.low),
      openingRangeHigh: _safe(structure?.openingRange?.high),
      openingRangeLow: _safe(structure?.openingRange?.low),
      vwap: _safe(payload.vwap),
      ema9: _safe(payload?.ema?.ema9 ?? payload.ema9),
      ema20: _safe(payload?.ema?.ema20 ?? payload.ema20),
      ema50: _safe(payload?.ema?.ema50 ?? payload.ema50),
    },
    futures: {
      ltp: _safe(payload?.futures?.ltp),
      premium: _safe(payload?.futures?.premium),
      basisState: futuresLead?.basis?.trend || 'unknown',
      basis: _safe(futuresLead?.basis?.basis),
      direction: futuresLead?.futuresDirection || 'neutral',
      leadLagScore: _safe(futuresLead?.leadLagScore, 50),
      score: _safe(futuresLead?.score, 50),
      aggressive: !!futuresLead?.aggressiveCandle?.detected,
      available: futuresLead?.available !== false,
      reasoning: futuresLead?.reasoning || '',
    },
    regime: {
      market: marketRegime?.regime || 'unknown',
      volatility: volatility?.state || 'unknown',
      meta: meta?.label || meta?.regime || 'unknown',
      gamma: gammaRegime?.state || 'neutral',
      orderflow: orderflowState?.state || 'neutral',
      aggressionMode: aggression?.mode || 'balanced',
      mtfStructure: mtfStructure?.permission || mtfStructure?.bias || 'unknown',
    },
    bias: {
      directionScore,
      overallBias,
      allowedDirections: derivatives?.allowedDirections || ['bullish', 'bearish'],
      reasoning: derivatives?.reasoning || '',
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
      reasoning: traps?.reasoning || '',
      breakdown: traps?.breakdown || {},
    },
    flow: {
      delta: {
        cvd: _safe(volumeAnalysis?.delta?.cvdPctLong),
        velocity: _safe(delta?.velocity, 0),
        velocityScore: _safe(delta?.velocityScore, 50),
        velocityState: delta?.velocityState || 'unknown',
        acceleration: _safe(delta?.acceleration, 0),
        flip: !!delta?.flipDetected,
        exhaustion: !!delta?.exhaustionDetected,
        bias: volumeAnalysis?.delta?.bias || 'neutral',
        strength: _safe(volumeAnalysis?.delta?.strength, 0),
        trend: volumeAnalysis?.delta?.trend || 'flat',
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
        spike: volumeAnalysis?.timeVolume?.state === 'spike' || _safe(volumeAnalysis?.timeVolume?.ratio, 1) >= 1.5,
        ratio: _safe(volumeAnalysis?.timeVolume?.ratio, 1),
        state: volumeAnalysis?.timeVolume?.state || 'normal',
        vsa: volumeAnalysis?.vsa?.pattern || 'normal',
        vsaBias: volumeAnalysis?.vsa?.bias || 'neutral',
        poc: _safe(volumeAnalysis?.frvp?.poc),
        vah: _safe(volumeAnalysis?.frvp?.vah),
        val: _safe(volumeAnalysis?.frvp?.val),
        hvns: volumeAnalysis?.frvp?.hvns || volumeAnalysis?.frvp?.hvn || [],
        lvns: volumeAnalysis?.frvp?.lvns || volumeAnalysis?.frvp?.lvn || [],
        acceptance: volumeAnalysis?.acceptance || 'unknown',
        zone: volumeAnalysis?.zone?.zone || 'neutral',
      },
      oi: {
        ceWriting: !!payload.options?.ce_writing,
        peWriting: !!payload.options?.pe_writing,
        ceUnwinding: !!payload.options?.ce_unwinding,
        peUnwinding: !!payload.options?.pe_unwinding,
        pcr: _safe(payload.options?.pcr_total),
        ceTotal: _safe(payload.options?.ce_oi_total),
        peTotal: _safe(payload.options?.pe_oi_total),
        velocity: _safe(oiAnalytics?.velocity, 0),
        acceleration: _safe(oiAnalytics?.acceleration, 0),
        migration: oiAnalytics?.migration || null,
        absorption: !!oiAnalytics?.absorption,
        qualityScore: _safe(oiAnalytics?.qualityScore, 50),
      },
    },
    options: {
      atm: payload.options?.atm_strike,
      maxPain: payload.options?.max_pain,
      atmIv: payload.options?.atm_iv,
      atmCall: payload.options?.atm_call,
      atmPut: payload.options?.atm_put,
      callWall: oiWalls.callWall,
      putWall: oiWalls.putWall,
    },
    smc: {
      bos: smc?.bos || null,
      choch: smc?.choch || null,
      orderBlocks: smc?.orderBlocks || [],
      fvg: smc?.fairValueGaps || [],
    },
    structure: {
      dayHigh: structure?.dayHigh,
      dayLow: structure?.dayLow,
      pdh: structure?.priorDay?.high,
      pdl: structure?.priorDay?.low,
      orh: structure?.openingRange?.high,
      orl: structure?.openingRange?.low,
      swingHighs: structure?.swingHighs5m || [],
      swingLows: structure?.swingLows5m || [],
      distances: structure?.distances || null,
    },
    ladder,
    chart: {
      candles1m: spark1m,
      candles5m: spark5m,
    },
    action,
    debug: {
      payloadKeys: Object.keys(payload),
      candleCounts: {
        '1m': candles1m.length,
        '5m': candles5m.length,
        '15m': candles15m.length,
        '30m': candles30m.length,
      },
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
