/**
 * Hybrid Entry Engine
 * ===================
 * Deterministic, institutional-style entry decision for NIFTY 50 options.
 * No AI in the execution path — AI only runs as an optional advisory side
 * channel (off by default).
 *
 * Pipeline:
 *   1. Session phase + entry permission
 *   2. Volatility regime
 *   3. Market regime (trending / ranging / choppy / exhaustion)
 *   4. Liquidity gate
 *   5. Derivatives intelligence → direction bias
 *   6. Probability scoring (Tier 1 hard / Tier 2 weighted / Tier 3 light)
 *   7. Risk engine + sizing
 *   8. Strike selection
 *   9. Execution quality
 *  10. Trade quality grade
 *  11. Optional AI advisory
 *
 * Returns the same shape `entryEngine.service.js` already produces, so the
 * caller (scalpingEngine) doesn't need any changes:
 *   { signal, trade_type, strike, option_type, lots_suggested,
 *     sl_points, target_points, max_hold_seconds, expected_points,
 *     min_target_achievable, confidence, risks, reasoning }
 */

const sessionEngine            = require('./sessionEngine');
const volatilityRegimeEngine   = require('./volatilityRegimeEngine');
const marketRegimeEngine       = require('./marketRegimeEngine');
const marketStructureEngine    = require('./marketStructureEngine');
const liquidityEngine          = require('./liquidityEngine');
const derivativesEngine        = require('./derivativesEngine');
const volumeAnalysisEngine     = require('./volumeAnalysisEngine');
const tickDeltaClassifier      = require('./tickDeltaClassifier');
const oiAnalyticsEngine        = require('./oiAnalyticsEngine');
const utBotEngine              = require('./utBotEngine');
const strategySelector         = require('./strategySelector');
const confidenceScoringEngine  = require('./confidenceScoringEngine');
const probabilityScoringEngine = require('./probabilityScoringEngine');
const riskEngine               = require('./riskEngine');
const executionQualityEngine   = require('./executionQualityEngine');
const tradeQualityClassifier   = require('./tradeQualityClassifier');
const strikeSelector           = require('./strikeSelector');
const aiAdvisory               = require('./aiAdvisoryLayer');
const hybridLogger             = require('./hybridLogger');

const atrService               = require('../atr.service');
const historicalContext        = require('../historicalContextLoader.service');
const ScalpingTrade            = require('../../models/ScalpingTrade');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function _focusStrikes(atmStrike, step = 50, halfWidth = 6) {
  if (!Number.isFinite(atmStrike)) return [];
  const out = [];
  for (let i = -halfWidth; i <= halfWidth; i++) out.push(atmStrike + i * step);
  return out;
}

function _buildPrimaryStrikes(aggregator, focusStrikes, atmStrike) {
  const chainStrikes =
       aggregator?.payload?.options_chain?.strikes
    || aggregator?.optionChain?.strikes
    || [];
  if (!chainStrikes.length || !focusStrikes?.length) return [];
  const byStrike = new Map(chainStrikes.map(s => [s.strike, s]));
  return focusStrikes.map(strike => {
    const s = byStrike.get(strike);
    if (!s) return { strike, missing: true };
    return {
      strike,
      moneyness: _moneyness(strike, atmStrike),
      ce: { ltp: s.call?.ltp, oi: s.call?.oi, oiChg: s.call?.oiChange,
            vol: s.call?.volume, iv: s.call?.iv,
            delta: s.call?.greeks?.delta, theta: s.call?.greeks?.theta,
            gamma: s.call?.greeks?.gamma, vega: s.call?.greeks?.vega,
            bid: s.call?.bid, ask: s.call?.ask },
      pe: { ltp: s.put?.ltp,  oi: s.put?.oi,  oiChg: s.put?.oiChange,
            vol: s.put?.volume, iv: s.put?.iv,
            delta: s.put?.greeks?.delta, theta: s.put?.greeks?.theta,
            gamma: s.put?.greeks?.gamma, vega: s.put?.greeks?.vega,
            bid: s.put?.bid, ask: s.put?.ask },
    };
  });
}

function _moneyness(strikeVal, atmStrike) {
  if (!Number.isFinite(strikeVal) || !Number.isFinite(atmStrike)) return 'unknown';
  if (strikeVal === atmStrike) return 'ATM';
  return strikeVal > atmStrike ? 'OTM' : 'ITM';
}

function _getCandlesFromContext(history) {
  return {
    candles1m:  history?.today?.candles?.['1m']  || [],
    candles5m:  history?.today?.candles?.['5m']  || [],
    candles15m: history?.today?.candles?.['15m'] || [],
  };
}

async function _consecutiveLosses(sessionId) {
  if (!sessionId) return 0;
  try {
    const recent = await ScalpingTrade.find({ sessionId, status: 'closed' })
      .sort({ closedAt: -1 })
      .limit(5)
      .select('result')
      .lean();
    let n = 0;
    for (const r of recent) {
      if (r.result === 'LOSS') n++;
      else break;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

function _noTrade(reason, extras = {}) {
  return {
    signal: 'NO_TRADE',
    trade_type: 'NONE',
    strike: 0,
    option_type: 'NONE',
    entry_premium_estimate: 0,
    expected_points: 0,
    min_target_achievable: false,
    confidence: 0,
    risks: [],
    reasoning: String(reason || 'no trade').slice(0, 500),
    lots_suggested: 0,
    sl_points: 0,
    target_points: 0,
    max_hold_seconds: 0,
    futures_agreement: false,
    atr_validated: false,
    _hybrid: true,
    ...extras,
  };
}

function _computeFreshness(aggregator) {
  // We don't strictly know the tick age here, so reuse aggregator timestamp.
  // If the aggregator has a `meta.timestamp` we treat any age <= 10s as fresh.
  const ts = aggregator?.payload?.meta?.timestamp || aggregator?.payload?.timestamp;
  if (!ts) return true;
  const age = Date.now() - new Date(ts).getTime();
  return Number.isFinite(age) && age >= 0 && age <= 10_000;
}

// ────────────────────────────────────────────────────────────────────────────
// Public: decide
// ────────────────────────────────────────────────────────────────────────────

/**
 * Main entry decision. Mirrors the surface of entryEngine.decide so the
 * scalpingEngine can call it transparently.
 *
 * @param {Object} args
 * @param {Object} args.aggregator
 * @param {Object} args.algorithmOutputs
 * @param {Object} args.masterDecision
 * @param {Object} args.settings
 * @param {Object} args.session
 * @param {number} args.openTradesCount
 * @param {Object} [args.futuresData]
 */
async function decide({
  aggregator,
  algorithmOutputs,
  masterDecision,
  settings,
  session,
  openTradesCount = 0,
  futuresData,
}) {
  const sessionId = session?._id;

  // Concurrency check first — cheap.
  const maxConcurrent = Number(settings?.maxConcurrentTrades) || 1;
  if (openTradesCount >= maxConcurrent) {
    return _noTrade(`At max concurrent trades (${openTradesCount}/${maxConcurrent})`);
  }

  // ── Inputs ───────────────────────────────────────────────────────────
  const payload = aggregator?.payload || {};
  const spotPrice =
       payload.spot_data?.ltp
    || payload.actual_spot_price
    || aggregator?.spotPrice
    || null;
  const atmStrike =
       aggregator?.atmStrike
    || payload.actual_atm_strike
    || payload.options_chain?.atm_strike
    || (Number.isFinite(spotPrice) ? Math.round(spotPrice / 50) * 50 : null);

  const focus = _focusStrikes(atmStrike);
  const primaryStrikes = _buildPrimaryStrikes(aggregator, focus, atmStrike);

  // Historical context (today + prior days)
  let history = { today: null, priorDays: [], rollup: null };
  try {
    history = await historicalContext.buildHistoricalContext({
      maxBackfillDays: 5,
      focusStrikes: focus,
      includeRawToday: true,
    });
  } catch (e) {
    hybridLogger.warn({ sessionId, event: 'historical_context_failed', message: e.message, data: { err: e.message } });
  }

  const { candles1m, candles5m, candles15m } = _getCandlesFromContext(history);

  // ── Pipeline step 1: Session ─────────────────────────────────────────
  const sessionPhase = sessionEngine.classifySession();
  hybridLogger.info({
    sessionId,
    event: 'session_phase',
    message: `phase=${sessionPhase.phase} agg=${sessionPhase.aggressionFactor} expiry=${sessionPhase.isExpiryWindow}`,
    data: sessionPhase,
  });

  // ── Pipeline step 2: Volatility regime ───────────────────────────────
  const vix = payload?.market_internals?.vix
           ?? algorithmOutputs?.globalMarkets?.vix?.value
           ?? null;
  const volatilityRegime = volatilityRegimeEngine.classify({
    candles1m, candles5m, vix,
  });
  hybridLogger.info({
    sessionId, event: 'volatility_regime',
    message: `state=${volatilityRegime.state} atr5m=${volatilityRegime.atr5m} pct=${volatilityRegime.atrPct5m} percentile=${volatilityRegime.atrPercentile}`,
    data: volatilityRegime,
  });

  // ── Pipeline step 3: Market regime ───────────────────────────────────
  const marketRegime = marketRegimeEngine.classify({
    candles5m, candles15m,
    volatilityRegime,
    multiTimeframe: algorithmOutputs?.multiTimeframe,
    vwap: payload?.vwap_analysis,
    adx: algorithmOutputs?.professionalScalping?.adx,
  });
  hybridLogger.info({
    sessionId, event: 'market_regime',
    message: `regime=${marketRegime.regime} bias=${marketRegime.bias} allow=${marketRegime.allowEntries}`,
    data: marketRegime,
  });

  // ── Pipeline step 4: Liquidity ───────────────────────────────────────
  const liquidity = liquidityEngine.evaluate(algorithmOutputs?.liquidityAnalysis);
  hybridLogger.info({
    sessionId, event: 'liquidity',
    message: `health=${liquidity.health} score=${liquidity.score} sweep=${liquidity.sweepRisk}`,
    data: liquidity,
  });

  // ── Pipeline step 5: Market structure (informational) ────────────────
  const marketStructure = marketStructureEngine.analyze({
    spotPrice,
    candles5m,
    candles15m,
    priorDay: history?.priorDays?.[0] || null,
    todayStats: history?.today?.sessionStats || null,
  });

  // ── Pipeline step 6: Risk engine ─────────────────────────────────────
  const consecutiveLosses = await _consecutiveLosses(sessionId);
  const openTradesInLossPts = 0; // caller already filtered such cycles, kept for completeness
  const risk = riskEngine.evaluate({
    session,
    consecutiveLosses,
    openTradesCount,
    openTradesInLossPts,
    killSwitch: !!settings?.killSwitch,
  });
  hybridLogger.info({
    sessionId, event: 'risk',
    message: risk.reasoning,
    data: risk,
  });

  // ── Pipeline step 7: Derivatives intelligence ────────────────────────
  const derivatives = derivativesEngine.analyze({
    optionChain: aggregator?.optionChain,
    primaryStrikes,
    pcr: payload?.options_chain?.pcr_total ?? payload?.options_chain?.pcr_oi,
    maxPain: payload?.options_chain?.max_pain ?? payload?.options_chain?.max_pain_strike,
    gammaExposure: algorithmOutputs?.gammaExposure,
    futuresData,
    spotPrice,
    atmStrike,
  });
  hybridLogger.info({
    sessionId, event: 'derivatives',
    message: `bias=${derivatives.overallBias} score=${derivatives.directionScore}`,
    data: derivatives,
  });

  // ── Pipeline step 7b: Volume analysis (FRVP + VSA + time-volume) ─────
  // Volume tells the truth behind the candle. FRVP reveals the price levels
  // institutions defend; VSA shows whether the latest candle has effort
  // matching its result; time-volume confirms recency of activity.
  //
  // For the delta read we prefer TRUE bid/ask classification from the live
  // tick stream when a meaningful sample exists; otherwise we fall back to
  // the wick-weighted candle proxy.
  const liveTickDelta = _readLiveTickDelta(13); // NIFTY 50 spot
  const volumeAnalysis = volumeAnalysisEngine.analyze({
    candles5m, candles15m, spotPrice,
    liveTickDelta,
  });
  if (volumeAnalysis) {
    hybridLogger.info({
      sessionId, event: 'volume_analysis',
      message:
        `acceptance=${volumeAnalysis.acceptance} ` +
        `zone=${volumeAnalysis.zone?.zone} ` +
        `delta=${volumeAnalysis.delta?.bias || 'n/a'} ${volumeAnalysis.delta?.cvdPctLong ?? '-'}% ` +
        `[${volumeAnalysis.deltaSource}] ` +
        `poc=${volumeAnalysis.frvp?.pocPrice} ` +
        `vsa=${volumeAnalysis.vsa?.pattern || 'n/a'} ` +
        `vol=${volumeAnalysis.timeVolume?.state || 'n/a'} (${volumeAnalysis.timeVolume?.ratio || '-'}x)`,
      data: {
        acceptance: volumeAnalysis.acceptance,
        zone: volumeAnalysis.zone,
        delta: volumeAnalysis.delta,
        deltaSource: volumeAnalysis.deltaSource,
        poc: volumeAnalysis.frvp?.pocPrice,
        pocDelta: volumeAnalysis.frvp?.pocDelta,
        vaHigh: volumeAnalysis.frvp?.vaHigh,
        vaLow: volumeAnalysis.frvp?.vaLow,
        upAreas: volumeAnalysis.frvp?.upAreas,
        downAreas: volumeAnalysis.frvp?.downAreas,
        nearestSupport: volumeAnalysis.nearestSupport?.price,
        nearestResistance: volumeAnalysis.nearestResistance?.price,
        timeVolume: volumeAnalysis.timeVolume,
        vsa: volumeAnalysis.vsa,
      },
    });
  } else {
    hybridLogger.info({
      sessionId, event: 'volume_analysis',
      message: 'no_volume_profile (insufficient candles)',
      data: {},
    });
  }

  // ── Pipeline step 7c: OI analytics (velocity, accel, migration, absorption) ──
  // Stateful — keeps the previous N snapshots per session so the next call
  // computes Δ velocity & acceleration. Direction is decided below; we run
  // analyze() once without direction here so the snapshot history is recorded
  // even when we later abort the cycle. We re-run with direction inside the
  // confidence scorer block.
  const oiAnalytics0 = oiAnalyticsEngine.analyze({
    primaryStrikes, atmStrike, spotPrice, sessionId,
  });
  if (oiAnalytics0) {
    hybridLogger.info({
      sessionId, event: 'oi_analytics',
      message: `regime=${oiAnalytics0.regime} ` +
               `peVel=${oiAnalytics0.diff?.peVelocity?.toFixed(0) ?? '-'} ` +
               `ceVel=${oiAnalytics0.diff?.ceVelocity?.toFixed(0) ?? '-'} ` +
               `migrPe=${oiAnalytics0.migration?.pe} migrCe=${oiAnalytics0.migration?.ce} ` +
               `absorption=${oiAnalytics0.absorption?.detected ? oiAnalytics0.absorption.side : 'no'}`,
      data: {
        snapshotsHeld: oiAnalytics0.snapshotsHeld,
        regime: oiAnalytics0.regime,
        diff: oiAnalytics0.diff && {
          ceAdd: oiAnalytics0.diff.ceAdd, ceCut: oiAnalytics0.diff.ceCut,
          peAdd: oiAnalytics0.diff.peAdd, peCut: oiAnalytics0.diff.peCut,
          ceVelocity: oiAnalytics0.diff.ceVelocity, peVelocity: oiAnalytics0.diff.peVelocity,
        },
        accel: oiAnalytics0.accel,
        migration: oiAnalytics0.migration,
        concentration: oiAnalytics0.concentration,
        absorption: oiAnalytics0.absorption,
      },
    });
  }

  // ── Pipeline step 8: Decide direction ────────────────────────────────
  // Prefer derivatives bias if strong; fall back to market regime bias.
  let direction = derivatives.overallBias;
  if (direction === 'neutral' && marketRegime.bias !== 'neutral') {
    direction = marketRegime.bias;
  }
  if (direction === 'neutral') {
    return _noTrade('No clear directional bias from derivatives or regime', {
      session: sessionPhase, volatilityRegime, marketRegime, liquidity, derivatives, risk,
    });
  }

  // Sanity: HTF strongly contradicts direction → block
  const htfBias = algorithmOutputs?.multiTimeframe?.higher_tf_bias;
  if (htfBias === 'strongly_bullish' && direction === 'bearish') {
    return _noTrade(`HTF strongly_bullish vs direction bearish — block`);
  }
  if (htfBias === 'strongly_bearish' && direction === 'bullish') {
    return _noTrade(`HTF strongly_bearish vs direction bullish — block`);
  }

  // ── Pipeline step 9: Probability scoring ─────────────────────────────
  const ctx = {
    session: sessionPhase,
    marketRegime,
    volatilityRegime,
    liquidity,
    dataFresh: _computeFreshness(aggregator),
    killSwitch: risk.killSwitch,
    riskBlock: !risk.allowEntries,
    // Tier 2 inputs
    derivatives,
    vwap: payload?.vwap_analysis,
    volumeOI: payload?.volume_orderflow,
    volumeAnalysis,                                     // FRVP + VSA + time-volume
    orderFlow: algorithmOutputs?.orderFlow,
    ivPercentile: payload?.options_chain?.iv_percentile,
    vix,
    marketInternals: algorithmOutputs?.marketInternals,
    pcr: payload?.options_chain?.pcr_total ?? payload?.options_chain?.pcr_oi,
    // Tier 3 inputs
    professionalScalping: algorithmOutputs?.professionalScalping,
    multiTimeframe: algorithmOutputs?.multiTimeframe,
  };

  const minScore = Number(settings?.hybridMinScore ?? 65);
  const scoreResult = probabilityScoringEngine.score(ctx, direction, { minScore });
  hybridLogger.info({
    sessionId, event: 'score',
    message: scoreResult.reasoning,
    data: { direction, score: scoreResult.score, weighted: scoreResult.weightedScore, light: scoreResult.lightBonus, hardGates: scoreResult.hardGates },
  });

  if (!scoreResult.allowed) {
    return _noTrade(`Hybrid score below threshold: ${scoreResult.reasoning}`, {
      hybridScore: scoreResult,
    });
  }

  // ── Pipeline step 9b: UT Bot evaluation (per-TF) ─────────────────────
  // Treated as execution-timing confirmation only — never the primary signal.
  const utBot = utBotEngine.evaluate(algorithmOutputs?.multiTimeframe, direction);
  hybridLogger.info({
    sessionId, event: 'ut_bot',
    message: `score=${utBot.score} aligned=${utBot.aligned} ${utBot.reasoning}`,
    data: utBot,
  });

  // ── Pipeline step 9c: OI analytics with direction (qualityScore) ─────
  // Re-analyze with direction so we get the directional qualityScore for
  // the confidence engine. The internal snapshot history is already in place.
  const oiAnalytics = oiAnalyticsEngine.analyze({
    primaryStrikes, atmStrike, spotPrice, sessionId, direction,
  }) || oiAnalytics0;

  // ── Pipeline step 9d: Strategy selection ─────────────────────────────
  // Picks SCALPING / INTRADAY_MOMENTUM / MEAN_REVERSION based on regime,
  // volatility and session phase. Returns target / SL / max-hold / minScore.
  const strategy = strategySelector.select({
    marketRegime, volatilityRegime, session: sessionPhase, settings, derivatives,
  });
  hybridLogger.info({
    sessionId, event: 'strategy',
    message: `${strategy.strategy} → tgt=${strategy.targetPoints}pts sl=${strategy.slPoints}pts hold=${strategy.maxHoldSec}s minScore=${strategy.minScore}`,
    data: strategy,
  });

  // Strategy may force-block if regime isn't compatible. But we already let
  // marketRegime gate earlier; this is the secondary check.
  if (Array.isArray(strategy.allowedRegimes) && marketRegime?.regime
      && !strategy.allowedRegimes.includes(marketRegime.regime)) {
    return _noTrade(`Strategy ${strategy.strategy} disallows regime ${marketRegime.regime}`);
  }

  // UT Bot requirement — strategies can demand it.
  if (strategy.utBotRequired && !utBot.aligned) {
    return _noTrade(`Strategy ${strategy.strategy} needs UT Bot alignment but 5m/15m disagree (utScore ${utBot.score})`);
  }

  // ── Pipeline step 9e: Confidence scoring (institutional weights) ─────
  // Uses the spec weights: OI 25 / Orderflow 20 / VWAP 15 / Structure 10
  // / Volume 10 / Liquidity 5 / Breadth 5 / Futures 5 / UT Bot 5.
  const confidence = confidenceScoringEngine.score({
    direction,
    oiAnalytics,
    volumeAnalysis,
    vwap: payload?.vwap_analysis,
    smc: algorithmOutputs?.smartMoneyConcepts,
    liquidity,
    marketInternals: algorithmOutputs?.marketInternals,
    derivatives,
    utBot,
    minScore: strategy.minScore,
  });
  hybridLogger.info({
    sessionId, event: 'confidence',
    message: confidence.reasoning,
    data: {
      direction, total: confidence.score, tier: confidence.tier, allowed: confidence.allowed,
      perPillar: Object.fromEntries(Object.entries(confidence.parts || {}).map(([k, v]) => [k, v.score])),
    },
  });

  if (!confidence.allowed) {
    return _noTrade(`Confidence ${confidence.score} below ${strategy.strategy} threshold ${strategy.minScore}`, {
      hybridScore: scoreResult, confidence, strategy,
    });
  }

  // Tier guard: SCALPING is only allowed in 'scalp_only' tier or above. Higher-
  // RR strategies need 'standard' (75+) or 'aggressive' (85+).
  if (strategy.strategy === 'INTRADAY_MOMENTUM' && confidence.tier === 'scalp_only') {
    return _noTrade(`INTRADAY_MOMENTUM requires standard tier (≥75); got ${confidence.score} (${confidence.tier})`);
  }

  // ── Pipeline step 10: Hard requirement — risk engine OK ──────────────
  if (!risk.allowEntries) {
    return _noTrade(`Risk engine blocks: ${risk.reasoning}`);
  }
  if (!sessionPhase.allowEntries) {
    return _noTrade(`Session phase ${sessionPhase.phase} disallows entries`);
  }

  // ── Pipeline step 11: Strike selection ───────────────────────────────
  // Trade type comes from the strategy; opening strike (if known) anchors the
  // selection within ±6 strikes of the day's institutional reference.
  const tradeType = strategy.tradeType;
  let openingStrike = null;
  try {
    const profSession = require('../professionalTrader.service').getMarketSession();
    openingStrike = Number(profSession?.openingStrike) || null;
  } catch (_) {}
  const strikeRes = strikeSelector.select({
    direction,
    tradeType,
    atmStrike,
    primaryStrikes,
    openingStrike,
    maxPain: payload?.options_chain?.max_pain ?? payload?.options_chain?.max_pain_strike,
    minPremium: Number(settings?.minEntryPremium) || 30,
    windowHalf: 6,
  });
  if (!strikeRes.ok) {
    return _noTrade(`Strike selection failed: ${strikeRes.reason}`);
  }
  hybridLogger.info({
    sessionId, event: 'strike',
    message: `strike=${strikeRes.strike} ${strikeRes.optionType} (${strikeRes.moneyness}) ` +
             `delta=${strikeRes.delta?.toFixed(2)} ltp=${strikeRes.ltp} ` +
             `anchor=${strikeRes.window?.anchor} dist=${strikeRes.distFromAnchor}pts`,
    data: strikeRes,
  });

  // ── Pipeline step 12: ATR target sanity ──────────────────────────────
  // Use the STRATEGY's target — not the global setting — so a momentum trade
  // doesn't get rejected for a tight scalp ATR window.
  const targetPoints = strategy.targetPoints;
  const atrAnalysis = atrService.getATRAnalysis(candles1m, candles5m, targetPoints, strikeRes.ltp);
  const atrConfirms = atrService.atrConfirmsEntry(atrAnalysis);
  hybridLogger.info({
    sessionId, event: 'atr',
    message: `atr=${atrAnalysis.primary_atr} confirms=${atrConfirms} target=${targetPoints}pts`,
    data: atrAnalysis,
  });
  if (!atrConfirms && settings?.enableATRConfirmation !== false) {
    return _noTrade(`ATR rejects target: ${atrAnalysis.target_achievability?.reasoning}`);
  }

  // ── Pipeline step 13: Execution quality ──────────────────────────────
  const focusStrike = primaryStrikes.find(s => s.strike === strikeRes.strike) || {};
  const isCe = strikeRes.optionType === 'CE';
  const exec = executionQualityEngine.evaluate({
    bid: isCe ? focusStrike.ce?.bid : focusStrike.pe?.bid,
    ask: isCe ? focusStrike.ce?.ask : focusStrike.pe?.ask,
    ltp: strikeRes.ltp,
    depthQuality: liquidity.depthQuality,
    tickAgeMs: 0,
    minThreshold: Number(settings?.executionMinScore ?? 50),
  });
  hybridLogger.info({
    sessionId, event: 'execution_quality',
    message: exec.reasoning,
    data: exec,
  });
  if (!exec.passed) {
    return _noTrade(`Execution quality blocked: ${exec.reasoning}`);
  }

  // ── Pipeline step 14: Sizing ─────────────────────────────────────────
  const sizing = riskEngine.computeLots({
    settings, session: sessionPhase,
    volatility: volatilityRegime,
    marketRegime,
    liquidity,
    risk,
  });
  hybridLogger.info({
    sessionId, event: 'sizing',
    message: `lots=${sizing.lots} factors=${sizing.factors.join('×')} product=${sizing.product}`,
    data: sizing,
  });

  // ── Pipeline step 15: Trade quality grade ────────────────────────────
  const grade = tradeQualityClassifier.classify({
    score: scoreResult.score,
    derivatives,
    liquidity,
    marketRegime,
    riskMode: risk.capitalMode,
  });
  hybridLogger.info({
    sessionId, event: 'grade',
    message: `grade=${grade.grade} adj=${grade.adjustedScore}`,
    data: grade,
  });

  // Reject low grades when settings demand selectivity
  const minGrade = settings?.hybridMinGrade || 'C';
  const gradeOrder = { 'A+': 5, 'A': 4, 'B': 3, 'C': 2, 'D': 1 };
  if ((gradeOrder[grade.grade] || 0) < (gradeOrder[minGrade] || 0)) {
    return _noTrade(`Grade ${grade.grade} below minimum ${minGrade}`);
  }

  // ── Pipeline step 16: Optional AI advisory ───────────────────────────
  const intent = {
    direction,
    strike: strikeRes.strike,
    optionType: strikeRes.optionType,
    score: scoreResult.score,
    grade: grade.grade,
    tradeType,
  };
  const advisory = await aiAdvisory.consult({
    deterministicDecision: intent,
    context: { session: sessionPhase, marketRegime, volatilityRegime, liquidity, derivatives },
    session,
    enabled: settings?.enableHybridAIAdvisory === true,
  });

  let confidenceNum = _scoreToConfidence(confidence.score);
  let lots = sizing.lots;
  if (advisory) {
    if (advisory.advise === 'BLOCK') {
      return _noTrade(`AI advisory blocked: ${advisory.reasoning}`, { hybridScore: scoreResult, advisory });
    }
    if (advisory.advise === 'REDUCE_SIZE') {
      lots = Math.max(1, Math.floor(lots * (advisory.size_factor || 0.75)));
    }
    confidenceNum = Math.max(1, Math.min(10, confidenceNum + (advisory.confidence_adjustment || 0)));
    hybridLogger.info({
      sessionId, event: 'ai_advisory',
      message: `${advisory.advise} (${advisory.trigger}) — conf±${advisory.confidence_adjustment} sizeF=${advisory.size_factor}`,
      data: advisory,
    });
  }

  // Risk floor: never above maxLots
  const maxLots = Number(settings?.maxLots) || 3;
  lots = Math.max(1, Math.min(maxLots, lots));

  // ── Build the decision ───────────────────────────────────────────────
  // Use the STRATEGY's target / SL / max-hold rather than raw settings —
  // those apply to scalp-only setups.
  const slPoints = strategy.slPoints;
  const targetOut = strategy.targetPoints;
  const expectedPoints = strategy.tradeType === 'SWING'
    ? Math.max(targetOut, 30)
    : targetOut;
  const maxHoldSeconds = strategy.maxHoldSec;

  // Snapshot — saved on the trade for monitor's decay engine
  const hybridSnapshot = {
    score: scoreResult.score,
    confidenceScore: confidence.score,
    confidenceTier: confidence.tier,
    grade: grade.grade,
    tradeType,
    strategy: strategy.strategy,
    derivativesScore: derivatives.directionScore,
    marketRegime: marketRegime.regime,
    volatilityState: volatilityRegime.state,
    sessionPhase: sessionPhase.phase,
    direction,
    capitalMode: risk.capitalMode,
    sizingFactors: sizing.factors,
    capturedAt: new Date().toISOString(),
    // Volume context — used by decay analysis to detect FRVP / delta / zone flips
    volume: volumeAnalysis ? {
      acceptance: volumeAnalysis.acceptance,
      poc:    volumeAnalysis.frvp?.pocPrice,
      vaHigh: volumeAnalysis.frvp?.vaHigh,
      vaLow:  volumeAnalysis.frvp?.vaLow,
      vsaPattern: volumeAnalysis.vsa?.pattern,
      vsaBias:    volumeAnalysis.vsa?.bias,
      volState:   volumeAnalysis.timeVolume?.state,
      deltaBias:    volumeAnalysis.delta?.bias,
      deltaPctLong: volumeAnalysis.delta?.cvdPctLong,
      deltaTrend:   volumeAnalysis.delta?.trend,
      deltaSource:  volumeAnalysis.deltaSource,
      zone:         volumeAnalysis.zone?.zone,
    } : null,
    // OI context — velocities, regime, migration at entry time
    oi: oiAnalytics ? {
      regime:       oiAnalytics.regime,
      qualityScore: oiAnalytics.qualityScore,
      ceVelocity:   oiAnalytics.diff?.ceVelocity,
      peVelocity:   oiAnalytics.diff?.peVelocity,
      migrationCe:  oiAnalytics.migration?.ce,
      migrationPe:  oiAnalytics.migration?.pe,
      cePeakStrike: oiAnalytics.migration?.cePeakStrikeNow,
      pePeakStrike: oiAnalytics.migration?.pePeakStrikeNow,
      absorption:   oiAnalytics.absorption?.detected ? oiAnalytics.absorption.side : null,
    } : null,
    // UT Bot snapshot — used to detect mid-trade reversal
    utBot: utBot ? {
      score:         utBot.score,
      aligned:       utBot.aligned,
      utBot1mTrend:  utBot.perTimeframe?.['1m']?.trend,
      utBot5mTrend:  utBot.perTimeframe?.['5m']?.trend,
      utBot15mTrend: utBot.perTimeframe?.['15m']?.trend,
      utBot30mTrend: utBot.perTimeframe?.['30m']?.trend,
    } : null,
  };

  const reasoning = [
    `[hybrid:${grade.grade}/${strategy.strategy}/${tradeType}]`,
    `regime=${marketRegime.regime}`,
    `vol=${volatilityRegime.state}`,
    `liq=${liquidity.health}`,
    `der=${derivatives.overallBias}(${derivatives.directionScore})`,
    volumeAnalysis ? `vp=${volumeAnalysis.acceptance}/${volumeAnalysis.vsa?.pattern || 'na'}` : null,
    volumeAnalysis?.delta ? `delta=${volumeAnalysis.delta.bias}(${volumeAnalysis.delta.cvdPctLong}%)` : null,
    volumeAnalysis?.zone?.zone && volumeAnalysis.zone.zone !== 'neutral' ? `zone=${volumeAnalysis.zone.zone}` : null,
    oiAnalytics ? `oi=${oiAnalytics.regime}/q${oiAnalytics.qualityScore ?? '-'}` : null,
    utBot ? `ut=${utBot.score}` : null,
    `confidence=${confidence.score}(${confidence.tier})`,
    advisory ? `advisory=${advisory.advise}` : null,
  ].filter(Boolean).join(' | ');

  const out = {
    signal: direction === 'bullish' ? 'BUY_CE' : 'BUY_PE',
    trade_type: tradeType,
    strategy: strategy.strategy,
    strike: strikeRes.strike,
    option_type: strikeRes.optionType,                  // 'CE' or 'PE' (not ATM/ITM/OTM — caller maps)
    moneyness: strikeRes.moneyness,                     // 'ATM' / 'ITM' / 'OTM'
    entry_premium_estimate: Number(strikeRes.ltp.toFixed(2)),
    expected_points: expectedPoints,
    min_target_achievable: !!atrConfirms,
    confidence: confidenceNum,
    confidenceScore: confidence.score,
    confidenceTier: confidence.tier,
    risks: advisory?.warnings || [],
    reasoning,
    lots_suggested: lots,
    sl_points: slPoints,
    target_points: targetOut,
    max_hold_seconds: maxHoldSeconds,
    futures_agreement: !!(derivatives?.futures?.bias && derivatives.futures.bias === direction),
    atr_validated: !!atrConfirms,
    // hybrid extras
    _hybrid: true,
    hybridSnapshot,
    hybridDetails: {
      sessionPhase, volatilityRegime, marketRegime, marketStructure,
      liquidity, derivatives, volumeAnalysis, oiAnalytics, utBot, strategy,
      scoreResult, confidence, risk, sizing, grade, exec, atrAnalysis,
      strike: strikeRes, advisory,
    },
  };

  hybridLogger.info({
    sessionId, event: 'decision',
    message: `${out.signal} ${out.strike}${out.option_type} lots=${out.lots_suggested} ` +
             `${strategy.strategy} grade=${grade.grade} confidence=${confidence.score}(${confidence.tier})`,
    data: {
      signal: out.signal, strike: out.strike, type: out.option_type, lots: out.lots_suggested,
      strategy: strategy.strategy, grade: grade.grade,
      confidenceScore: confidence.score, tier: confidence.tier,
      tradeType, reasoning,
    },
  });

  return out;
}

function _decideTradeType({ marketRegime, volatilityRegime, settings, sessionPhase }) {
  const swingEnabled = settings?.enableSwing !== false;
  if (!swingEnabled) return 'SCALP';

  // SWING is allowed when:
  //   - regime is clearly trending
  //   - volatility is normal/expansion (not dead/panic)
  //   - we're not in opening_drive or closing
  if (
    (marketRegime?.regime === 'trending_bullish' || marketRegime?.regime === 'trending_bearish') &&
    (volatilityRegime?.state === 'normal' || volatilityRegime?.state === 'expansion') &&
    sessionPhase?.phase !== 'opening_drive' &&
    sessionPhase?.phase !== 'closing'
  ) {
    return 'SWING';
  }
  return 'SCALP';
}

function _scoreToConfidence(score) {
  // Map 50..100 to 5..10 linearly, clamp.
  const x = Math.max(50, Math.min(100, Number(score) || 50));
  return Math.round(((x - 50) / 50) * 5 + 5);
}

/**
 * Pull the current bid/ask-classified delta for a given security from the
 * tick classifier. Returns both a long (3-min) and short (60-sec) read so the
 * volume engine can derive trend.
 *
 *   - segment defaults to IDX_I (NIFTY spot). Pass 'NSE_FNO' + futures id for
 *     futures delta, or option securityId for option-level delta.
 *   - Returns null when classifier hasn't started or sample is too small.
 */
function _readLiveTickDelta(securityId, segment = 'IDX_I') {
  try {
    const cls = tickDeltaClassifier.instance;
    if (!cls || !cls.started) return null;
    const long  = cls.getDelta(segment, securityId, { windowMs: 180_000 }); // 3 min
    const short = cls.getDelta(segment, securityId, { windowMs: 60_000 });  // 1 min
    if (!long || (long.sampleSize || 0) < 30) return null;
    return { long, short, segment, securityId };
  } catch (_) {
    return null;
  }
}

module.exports = { decide };
