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

function _focusStrikes(atmStrike, step = 50, halfWidth = 4) {
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
  const volumeAnalysis = volumeAnalysisEngine.analyze({
    candles5m, candles15m, spotPrice,
  });
  if (volumeAnalysis) {
    hybridLogger.info({
      sessionId, event: 'volume_analysis',
      message:
        `acceptance=${volumeAnalysis.acceptance} ` +
        `poc=${volumeAnalysis.frvp?.pocPrice} ` +
        `vsa=${volumeAnalysis.vsa?.pattern || 'n/a'} ` +
        `vol=${volumeAnalysis.timeVolume?.state || 'n/a'} (${volumeAnalysis.timeVolume?.ratio || '-'}x)`,
      data: {
        acceptance: volumeAnalysis.acceptance,
        poc: volumeAnalysis.frvp?.pocPrice,
        vaHigh: volumeAnalysis.frvp?.vaHigh,
        vaLow: volumeAnalysis.frvp?.vaLow,
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

  // ── Pipeline step 10: Hard requirement — risk engine OK ──────────────
  if (!risk.allowEntries) {
    return _noTrade(`Risk engine blocks: ${risk.reasoning}`);
  }
  if (!sessionPhase.allowEntries) {
    return _noTrade(`Session phase ${sessionPhase.phase} disallows entries`);
  }

  // ── Pipeline step 11: Strike selection ───────────────────────────────
  const tradeType = _decideTradeType({ marketRegime, volatilityRegime, settings, sessionPhase });
  const strikeRes = strikeSelector.select({
    direction,
    tradeType,
    atmStrike,
    primaryStrikes,
    maxPain: payload?.options_chain?.max_pain ?? payload?.options_chain?.max_pain_strike,
    minPremium: Number(settings?.minEntryPremium) || 30,
  });
  if (!strikeRes.ok) {
    return _noTrade(`Strike selection failed: ${strikeRes.reason}`);
  }
  hybridLogger.info({
    sessionId, event: 'strike',
    message: `strike=${strikeRes.strike} ${strikeRes.optionType} (${strikeRes.moneyness}) delta=${strikeRes.delta?.toFixed(2)} ltp=${strikeRes.ltp}`,
    data: strikeRes,
  });

  // ── Pipeline step 12: ATR target sanity ──────────────────────────────
  const targetPoints = Number(settings?.targetPoints) || 10;
  const atrAnalysis = atrService.getATRAnalysis(candles1m, candles5m, targetPoints, strikeRes.ltp);
  const atrConfirms = atrService.atrConfirmsEntry(atrAnalysis);
  hybridLogger.info({
    sessionId, event: 'atr',
    message: `atr=${atrAnalysis.primary_atr} confirms=${atrConfirms}`,
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

  let confidence = _scoreToConfidence(scoreResult.score);
  let lots = sizing.lots;
  if (advisory) {
    if (advisory.advise === 'BLOCK') {
      return _noTrade(`AI advisory blocked: ${advisory.reasoning}`, { hybridScore: scoreResult, advisory });
    }
    if (advisory.advise === 'REDUCE_SIZE') {
      lots = Math.max(1, Math.floor(lots * (advisory.size_factor || 0.75)));
    }
    confidence = Math.max(1, Math.min(10, confidence + (advisory.confidence_adjustment || 0)));
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
  const slPoints = Number(settings?.slPoints) || 10;
  const targetOut = Number(settings?.targetPoints) || 10;
  const expectedPoints = tradeType === 'SWING'
    ? Math.max(targetOut * 3, 30)
    : targetOut;
  const maxHoldSeconds = tradeType === 'SWING'
    ? (Number(settings?.swingMaxHoldMinutes) || 15) * 60
    : (Number(settings?.maxHoldTimeSeconds) || 180);

  // Snapshot — saved on the trade for monitor's decay engine
  const hybridSnapshot = {
    score: scoreResult.score,
    grade: grade.grade,
    tradeType,
    derivativesScore: derivatives.directionScore,
    marketRegime: marketRegime.regime,
    volatilityState: volatilityRegime.state,
    sessionPhase: sessionPhase.phase,
    direction,
    capitalMode: risk.capitalMode,
    sizingFactors: sizing.factors,
    capturedAt: new Date().toISOString(),
    // Volume context — used by decay analysis to detect FRVP flips
    volume: volumeAnalysis ? {
      acceptance: volumeAnalysis.acceptance,
      poc:    volumeAnalysis.frvp?.pocPrice,
      vaHigh: volumeAnalysis.frvp?.vaHigh,
      vaLow:  volumeAnalysis.frvp?.vaLow,
      vsaPattern: volumeAnalysis.vsa?.pattern,
      vsaBias:    volumeAnalysis.vsa?.bias,
      volState:   volumeAnalysis.timeVolume?.state,
    } : null,
  };

  const reasoning = [
    `[hybrid:${grade.grade}/${tradeType}]`,
    `regime=${marketRegime.regime}`,
    `vol=${volatilityRegime.state}`,
    `liq=${liquidity.health}`,
    `der=${derivatives.overallBias}(${derivatives.directionScore})`,
    volumeAnalysis ? `vp=${volumeAnalysis.acceptance}/${volumeAnalysis.vsa?.pattern || 'na'}` : null,
    `score=${scoreResult.score}`,
    advisory ? `advisory=${advisory.advise}` : null,
  ].filter(Boolean).join(' | ');

  const out = {
    signal: direction === 'bullish' ? 'BUY_CE' : 'BUY_PE',
    trade_type: tradeType,
    strike: strikeRes.strike,
    option_type: strikeRes.optionType,                  // 'CE' or 'PE' (not ATM/ITM/OTM — caller maps)
    moneyness: strikeRes.moneyness,                     // 'ATM' / 'ITM' / 'OTM'
    entry_premium_estimate: Number(strikeRes.ltp.toFixed(2)),
    expected_points: expectedPoints,
    min_target_achievable: !!atrConfirms,
    confidence,
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
      liquidity, derivatives, volumeAnalysis, scoreResult, risk, sizing, grade, exec, atrAnalysis,
      strike: strikeRes, advisory,
    },
  };

  hybridLogger.info({
    sessionId, event: 'decision',
    message: `${out.signal} ${out.strike}${out.option_type} lots=${out.lots_suggested} grade=${grade.grade} score=${scoreResult.score}`,
    data: { signal: out.signal, strike: out.strike, type: out.option_type, lots: out.lots_suggested, score: scoreResult.score, grade: grade.grade, reasoning },
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

module.exports = { decide };
