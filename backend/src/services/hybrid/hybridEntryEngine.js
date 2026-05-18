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
// Phase 1 institutional upgrades
const multiDayContextEngine    = require('./multiDayContextEngine');
const structuralTargetEngine   = require('./structuralTargetEngine');
const trapDetectionEngine      = require('./trapDetectionEngine');
// Phase 2-5 institutional upgrades
const marketAuctionEngine      = require('./marketAuctionEngine');
const gammaRegimeEngine        = require('./gammaRegimeEngine');
const mtfStructureEngine       = require('./mtfStructureEngine');
const orderflowStateEngine     = require('./orderflowStateEngine');
const trendPhaseEngine         = require('./trendPhaseEngine');
const entryTypeEngine          = require('./entryTypeEngine');
const expiryBehaviorEngine     = require('./expiryBehaviorEngine');
const aggressionModeEngine     = require('./aggressionModeEngine');
const expectancyEngine         = require('./expectancyEngine');
const metaRegimeEngine         = require('./metaRegimeEngine');
const strategyPlaybookEngine   = require('./strategyPlaybookEngine');
const ivVelocityTracker        = require('./ivVelocityTracker');

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
  // The aggregator timestamp represents when the cycle began fetching data.
  // Between then and the score check, the engine runs ~8 algorithms (gamma,
  // OI, multiTimeframe, etc.) which can take 8-20 seconds. The freshness
  // window must accommodate this — otherwise every cycle fails the
  // stale_data gate.
  //
  // CALIBRATED 2026-05-18: was 10s (too strict — blocked 6/8 cycles in live
  // session). Now 90s = one full cycle + buffer. The actual tick-age is
  // checked separately by the live-feed provider; this gate just ensures the
  // payload itself isn't from a previous session.
  const ts = aggregator?.payload?.meta?.timestamp || aggregator?.payload?.timestamp;
  if (!ts) return true;
  const age = Date.now() - new Date(ts).getTime();
  return Number.isFinite(age) && age >= 0 && age <= 90_000;
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
 * @param {number} [args.tradesToday=0]    - calibrated daily-trade cap input
 * @param {number} [args.lossesToday=0]    - daily loss-streak halt input
 */
async function decide({
  aggregator,
  algorithmOutputs,
  masterDecision,
  settings,
  session,
  openTradesCount = 0,
  futuresData,
  tradesToday = 0,
  lossesToday = 0,
}) {
  const sessionId = session?._id;

  // Concurrency check first — cheap.
  const maxConcurrent = Number(settings?.maxConcurrentTrades) || 1;
  if (openTradesCount >= maxConcurrent) {
    return _noTrade(`At max concurrent trades (${openTradesCount}/${maxConcurrent})`);
  }

  // ── Daily trade cap (institutional spec: 5-8 elite trades/day) ──────
  // Backtest evidence (59 days, 413 trades):
  //   3-9 trades/day:  60% WR, +₹158k net
  //   15+ trades/day:  43% WR, -₹41k net  ← capital destruction
  // Cap default = 8. Override via settings.maxTradesPerDay.
  const maxTradesPerDay = Number(settings?.maxTradesPerDay) || 8;
  if (tradesToday >= maxTradesPerDay) {
    return _noTrade(`Daily trade cap reached (${tradesToday}/${maxTradesPerDay})`);
  }
  // ── Daily loss-streak halt (preserves capital after bad start) ──────
  // Stop entries the moment 2 losses have printed today (was 3).
  // Calibration: 2026-02-17 had 3 losses in a row before halt fired.
  // Tighter cap prevents same-day cascade.
  const maxLossesPerDay = Number(settings?.maxLossesPerDay) || 2;
  if (lossesToday >= maxLossesPerDay) {
    return _noTrade(`Daily loss-streak halt (${lossesToday}/${maxLossesPerDay})`);
  }
  // CALIBRATED cycle 25: After 1 loss today, raise the bar significantly.
  // Cycle 22 evidence: 03-18 and 03-19 each had 2 losses in a row from
  // VWAP_BOUNCE_SCALP. After-loss caution prevents the second loss.
  const postLossPenalty = Math.max(0, Number(lossesToday) || 0);
  // (note: applied later via aggression.minScore boost)

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

  // ── IV velocity tracking (per-session intraday history) ──────────────
  // Average of ATM CE+PE IV is recorded each cycle. Used by IV_CRUSH_FADE
  // playbook to detect rapid IV decay.
  try {
    const atmRow = primaryStrikes.find(s => s.strike === atmStrike);
    const ceIv = Number(atmRow?.ce?.iv);
    const peIv = Number(atmRow?.pe?.iv);
    let atmIv = null;
    if (Number.isFinite(ceIv) && Number.isFinite(peIv)) atmIv = (ceIv + peIv) / 2;
    else if (Number.isFinite(ceIv)) atmIv = ceIv;
    else if (Number.isFinite(peIv)) atmIv = peIv;
    if (Number.isFinite(atmIv) && atmIv > 0) {
      ivVelocityTracker.record({
        sessionId,
        date: settings?.referenceDate || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
        atmIv,
        ts: Math.floor(Date.now() / 1000),
      });
    }
  } catch (_) { /* best-effort */ }

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

  // ── Multi-day institutional context ──────────────────────────────────
  // Reads N prior trading-day folders directly from `live-feed/` and gives
  // us PDH/PDL/PVAH/PVAL/POC, weekly H/L, composite HVNs, OI migration,
  // ATR/IV percentiles, and per-day session memory.
  // We pass the spot-derived ATR for percentile calculation. IV is best-effort
  // pulled from option-chain (we'll skip if not available).
  let multiDayContext = null;
  try {
    // Use reference date from settings (backtest) or current IST date (live).
    const refDate = settings?.referenceDate
      || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    multiDayContext = multiDayContextEngine.buildContext({
      date: refDate,
      priorDays: 5,
      currentAtr: null,        // will be filled after volatilityRegime computes
      currentIv:  null,
    });
  } catch (e) {
    hybridLogger.warn({ sessionId, event: 'multi_day_context_failed', message: e.message, data: { err: e.message } });
  }
  if (multiDayContext) {
    hybridLogger.info({
      sessionId, event: 'multi_day_context',
      message: `priorDay=${multiDayContext.priorDay?.dayType || 'n/a'} ` +
               `levels=${(multiDayContext.levels || []).length} ` +
               `oiMig=ce${multiDayContext.oiMigration?.ce}/pe${multiDayContext.oiMigration?.pe}`,
      data: {
        priorDay: multiDayContext.priorDay,
        priorWeek: multiDayContext.priorWeek,
        compositePoc: multiDayContext.compositeProfile?.poc,
        oiMigration: multiDayContext.oiMigration,
        atrPercentile: multiDayContext.atrPercentile,
        ivPercentile: multiDayContext.ivPercentile,
        sessionMemory: multiDayContext.sessionMemory,
        levelCount: (multiDayContext.levels || []).length,
      },
    });
  }

  // ── Pipeline step 1: Session ─────────────────────────────────────────
  const sessionPhase = sessionEngine.classifySession(new Date(), {
    restrictToHighQualityPhases: settings?.restrictToHighQualityPhases === true,
  });
  hybridLogger.info({
    sessionId,
    event: 'session_phase',
    message: `phase=${sessionPhase.phase} agg=${sessionPhase.aggressionFactor} expiry=${sessionPhase.isExpiryWindow}${sessionPhase.restrictedByPhaseFilter ? ' [HQ-filter blocked]' : ''}`,
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

  // ── Pipeline step 3b: Market auction (IB / day type / acceptance) ────
  const auctionState = marketAuctionEngine.analyze({
    candles1m, candles5m,
    priorDay: multiDayContext?.priorDay,
    currentSpot: spotPrice,
  });
  if (auctionState) {
    hybridLogger.info({
      sessionId, event: 'market_auction',
      message: `${auctionState.dayType} | ${auctionState.openType} | acceptance=${auctionState.acceptance} → ${auctionState.tradingImplication}`,
      data: auctionState,
    });
  }

  // ── Pipeline step 3c: Multi-timeframe structure hierarchy ────────────
  // We'll re-evaluate this with `direction` inside the scoring block.
  const mtfStructureBoth = {
    bullish: mtfStructureEngine.evaluate({ candles1m, candles5m, candles15m, direction: 'bullish', auctionState }),
    bearish: mtfStructureEngine.evaluate({ candles1m, candles5m, candles15m, direction: 'bearish', auctionState }),
  };

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

  // ── Pipeline step 7a: Gamma regime ────────────────────────────────────
  // Estimates dealer GEX from the chain. Negative gamma = momentum, positive
  // gamma = mean reversion. Used by entry-type evaluator + monitor.
  const gammaRegime = gammaRegimeEngine.analyze({
    strikes: primaryStrikes, spotPrice, atmStrike,
  });
  hybridLogger.info({
    sessionId, event: 'gamma_regime',
    message: `${gammaRegime.regime} netGEX=${gammaRegime.netGex} pin=${gammaRegime.pinningLevel} flip=${gammaRegime.gammaFlip}`,
    data: gammaRegime,
  });
  const oiAnalytics0 = oiAnalyticsEngine.analyze({
    primaryStrikes, atmStrike, spotPrice, sessionId,
  });
  // ── Pipeline step 7a-bis: META-REGIME (institutional behaviour state) ─
  // The brain that fuses every sub-state into ONE label and drives entry
  // family permission + sizing + hold time. Centralised — no other engine
  // applies penalties for these states from here on.
  const metaRegime = metaRegimeEngine.classify({
    marketRegime, volatilityRegime, auctionState, gammaRegime,
    oiAnalytics: oiAnalytics0,    // first OI snapshot (we re-derive with direction later)
    sessionPhase,
  });
  hybridLogger.info({
    sessionId, event: 'meta_regime',
    message: `${metaRegime.state} | allowed=[${metaRegime.allowedFamilies.join(',')}] | ${metaRegime.reasoning}`,
    data: metaRegime,
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
  // If both neutral, use 5m + VWAP fallback so we don't reject every cycle
  // in the common "balanced derivatives" market state.
  let direction = derivatives.overallBias;
  let directionSource = 'derivatives';
  if (direction === 'neutral' && marketRegime.bias !== 'neutral') {
    direction = marketRegime.bias;
    directionSource = 'marketRegime';
  }
  if (direction === 'neutral') {
    const tf5 = algorithmOutputs?.multiTimeframe?.timeframes?.['5m']?.trend;
    const vwapPos = payload?.vwap_analysis?.position || payload?.vwap_analysis?.price_vs_vwap;
    if (tf5 === 'bullish' && vwapPos === 'above') { direction = 'bullish'; directionSource = '5m+vwap'; }
    else if (tf5 === 'bearish' && vwapPos === 'below') { direction = 'bearish'; directionSource = '5m+vwap'; }
  }
  // CALIBRATED 2026-05-18 cycle 12: 309 zero-trade-day cycles failed at this
  // gate. Add 4 additional fallback paths to reduce neutrality stranding:
  //
  //   (a) OI velocity — strong CE writing or PE unwinding = bearish flow.
  //       Strong PE writing or CE unwinding = bullish flow.
  //   (b) Futures direction — when futures lead spot.
  //   (c) Volume-analysis delta + acceptance — when delta cleanly trends
  //       and price is on the right side of value.
  //   (d) MTF full alignment — if 15m+5m+1m all agree, that IS the bias.
  if (direction === 'neutral') {
    const ceVel = oiAnalytics0?.diff?.ceVelocity || 0;
    const peVel = oiAnalytics0?.diff?.peVelocity || 0;
    // PE writing (peVel > 0 large) + CE unwinding (ceVel < 0) = bullish
    // CE writing (ceVel > 0 large) + PE unwinding (peVel < 0) = bearish
    if (peVel > 200_000 && ceVel < 0)       { direction = 'bullish'; directionSource = 'oi_pe_writing'; }
    else if (ceVel > 200_000 && peVel < 0)  { direction = 'bearish'; directionSource = 'oi_ce_writing'; }
    else if (oiAnalytics0?.regime === 'violent_short_covering')   { direction = 'bullish'; directionSource = 'oi_short_covering'; }
    else if (oiAnalytics0?.regime === 'long_unwinding_collapse')  { direction = 'bearish'; directionSource = 'oi_long_liq'; }
  }
  if (direction === 'neutral') {
    const futDir = futuresData?.direction;
    if (futDir === 'bullish' || futDir === 'up') { direction = 'bullish'; directionSource = 'futures'; }
    else if (futDir === 'bearish' || futDir === 'down') { direction = 'bearish'; directionSource = 'futures'; }
  }
  if (direction === 'neutral' && volumeAnalysis?.delta && volumeAnalysis?.acceptance) {
    const dBias = volumeAnalysis.delta.bias;
    const dStr = Number(volumeAnalysis.delta.strength) || 0;
    if (dStr >= 40) {
      if ((dBias === 'bullish' || dBias === 'mild_bullish') && volumeAnalysis.acceptance === 'above_va') {
        direction = 'bullish'; directionSource = 'delta+acceptance';
      } else if ((dBias === 'bearish' || dBias === 'mild_bearish') && volumeAnalysis.acceptance === 'below_va') {
        direction = 'bearish'; directionSource = 'delta+acceptance';
      }
    }
  }
  if (direction === 'neutral' && mtfStructureBoth) {
    // If MTF full alignment exists for one direction, pick that
    if (mtfStructureBoth.bullish?.alignment === 'full' && mtfStructureBoth.bearish?.alignment !== 'full') {
      direction = 'bullish'; directionSource = 'mtf_full';
    } else if (mtfStructureBoth.bearish?.alignment === 'full' && mtfStructureBoth.bullish?.alignment !== 'full') {
      direction = 'bearish'; directionSource = 'mtf_full';
    }
  }
  if (direction === 'neutral') {
    return _noTrade('No clear directional bias from derivatives, regime, 5m+VWAP, OI, futures, delta, or MTF', {
      session: sessionPhase, volatilityRegime, marketRegime, liquidity, derivatives, risk,
    });
  }
  hybridLogger.info({
    sessionId, event: 'direction_resolved',
    message: `direction=${direction} via ${directionSource}`,
    data: { direction, source: directionSource },
  });

  // ── PE-side enhanced filter (calibration: BUY_PE win rate was 38.3%) ──
  // Bearish trades fail more in NIFTY because of bullish drift bias and
  // gamma suppression. CALIBRATED 2026-05-18 cycle 12-14: 470+ zero-trade-day
  // blocks came from this filter.
  //
  // SKIP this filter when direction was resolved via OI/futures/delta —
  // those signals already validate the bearish bias and the filter was
  // designed for cases where derivatives are neutral.
  // APPLY the filter when direction came from derivatives or marketRegime.
  const directionViaTfFilter = directionSource === 'derivatives'
    || directionSource === 'marketRegime' || directionSource === '5m+vwap';
  if (direction === 'bearish' && directionViaTfFilter) {
    const tf5  = algorithmOutputs?.multiTimeframe?.timeframes?.['5m']?.trend;
    const tf15 = algorithmOutputs?.multiTimeframe?.timeframes?.['15m']?.trend;
    const vwapPos = payload?.vwap_analysis?.position || payload?.vwap_analysis?.price_vs_vwap;
    const eitherBearish = tf5 === 'bearish' || tf15 === 'bearish';
    const notBullish = tf5 !== 'bullish' && tf15 !== 'bullish';

    // Bearish-side evidence (any one suffices)
    const ceVelocity = oiAnalytics0?.diff?.ceVelocity || 0;
    const peVelocity = oiAnalytics0?.diff?.peVelocity || 0;
    const downsideAccel = ceVelocity > 200_000 || peVelocity < -200_000;
    const oiBearish = oiAnalytics0?.regime === 'long_unwinding_collapse'
                  || oiAnalytics0?.regime === 'aggressive_short_buildup';
    const futBearish = futuresData?.direction === 'bearish' || futuresData?.direction === 'down';
    const gammaFlipBelow = gammaRegime?.gammaFlip && spotPrice && spotPrice < gammaRegime.gammaFlip;
    const bearEvidence = downsideAccel || oiBearish || futBearish || gammaFlipBelow;

    // Gamma must NOT actively suppress downside without acceleration
    const gammaSuppresses = gammaRegime?.regime === 'positive'
      && gammaRegime.pinningLevel
      && Math.abs(spotPrice - gammaRegime.pinningLevel) < 25
      && !downsideAccel;

    if (!eitherBearish && notBullish === false) {
      return _noTrade(`PE filter: need 5m or 15m bearish (got tf5=${tf5}, tf15=${tf15})`);
    }
    if (vwapPos !== 'below') {
      return _noTrade(`PE filter: need below VWAP (got vwap=${vwapPos})`);
    }
    if (!bearEvidence) {
      return _noTrade(`PE filter: need bearish OI/futures/gamma evidence`);
    }
    if (gammaSuppresses) {
      return _noTrade(`PE filter: positive gamma pin at ${gammaRegime.pinningLevel} suppresses downside (no acceleration)`);
    }
  }

  // Sanity: HTF strongly contradicts direction → block
  const htfBias = algorithmOutputs?.multiTimeframe?.higher_tf_bias;
  if (htfBias === 'strongly_bullish' && direction === 'bearish') {
    return _noTrade(`HTF strongly_bullish vs direction bearish — block`);
  }
  if (htfBias === 'strongly_bearish' && direction === 'bullish') {
    return _noTrade(`HTF strongly_bearish vs direction bullish — block`);
  }

  // ── Pipeline step 8b: Multi-timeframe structure hierarchy ─────────────
  // Enforces 15m primary trend > 5m execution > 1m trigger. The hard block
  // only fires when 15m trend is *strongly* against direction AND no
  // reversal permission. Otherwise we just penalise the score.
  const mtfStructure = mtfStructureBoth[direction];
  if (mtfStructure?.blocked && mtfStructure.tf15 && mtfStructure.tf15 !== 'neutral'
      && mtfStructure.tf15 !== direction) {
    // CALIBRATED 2026-05-18 cycle 12: 41 zero-trade-day blocks here.
    // Soften: only hard-block when 15m AND 5m both oppose direction.
    // If only 15m opposes (5m agrees with direction), allow with penalty.
    if (mtfStructure.tf5 && mtfStructure.tf5 !== 'neutral' && mtfStructure.tf5 !== direction) {
      // Truly opposing 15m + 5m trend with no reversal permission — block.
      return _noTrade(`MTF blocked: ${mtfStructure.reasoning}`, { mtfStructure });
    }
    // Otherwise just flag for the confidence engine via softBlock
    if (mtfStructure) mtfStructure.softBlock = true;
  }
  hybridLogger.info({
    sessionId, event: 'mtf_structure',
    message: `${mtfStructure?.alignment || 'n/a'} score=${mtfStructure?.score} ${mtfStructure?.reasoning || ''}`,
    data: mtfStructure,
  });

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

  // Calibrated: probability scoring uses 55 floor (was 60), aggression layer
  // tightens it via strategy.minScore.
  const minScore = Number(settings?.hybridMinScore ?? 55);
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

  // ── Pipeline step 9c-bis: Orderflow state + Trend phase ──────────────
  // Joint state of price + delta + OI + futures, mapped to one of seven
  // institutional orderflow states (initiative buying, exhaustion, ...).
  const priceMove = (() => {
    const last = candles5m[candles5m.length - 1];
    const prev = candles5m[candles5m.length - 6];
    if (!last || !prev) return { ptsChange: 0, direction: 'flat' };
    const d = last.c - prev.c;
    return { ptsChange: d, direction: d > 1 ? 'up' : d < -1 ? 'down' : 'flat' };
  })();
  const orderflowState = orderflowStateEngine.classify({
    volumeAnalysis, oiAnalytics, futuresData, priceMove,
  });
  hybridLogger.info({
    sessionId, event: 'orderflow_state',
    message: `${orderflowState.state} (${orderflowState.bias}, str=${orderflowState.strength}) ${orderflowState.reasoning}`,
    data: orderflowState,
  });

  const trendPhase = trendPhaseEngine.classify({
    candles5m, candles15m, currentPrice: spotPrice,
    volumeAnalysis, oiAnalytics, multiDayContext,
  });
  hybridLogger.info({
    sessionId, event: 'trend_phase',
    message: `${trendPhase.phase} bias=${trendPhase.bias} ${trendPhase.reasoning}`,
    data: trendPhase,
  });
  if (!trendPhaseEngine.permits(trendPhase, direction)) {
    // Soft penalty rather than hard block — phase mismatch is information,
    // but not a hard veto (the confidence engine will downgrade us anyway).
    hybridLogger.info({
      sessionId, event: 'trend_phase_soft_block',
      message: `phase ${trendPhase.phase} disfavours ${direction} — applying penalty`,
      data: { trendPhase: trendPhase.phase },
    });
    // Apply the penalty by raising minScore needed
    if (trendPhase) trendPhase.softBlock = true;
  }

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

  // ── Pipeline step 9d-bis: Aggression mode ────────────────────────────
  const aggression = aggressionModeEngine.evaluate({
    requestedMode: settings?.aggressionMode || 'institutional',
    marketRegime, volatilityRegime, risk,
    sessionPhase,
  });
  hybridLogger.info({
    sessionId, event: 'aggression',
    message: `mode=${aggression.mode} minScore=${aggression.minScore} sizingF=${aggression.sizingFactor}`,
    data: aggression,
  });
  // Apply aggression overrides on top of strategy minScore (max of the two)
  strategy.minScore = Math.max(strategy.minScore, aggression.minScore);
  // Apply trend-phase soft-block penalty
  if (trendPhase?.softBlock) strategy.minScore = Math.min(95, strategy.minScore + 8);
  // CALIBRATED cycle 25-27: post-loss caution. After 1 loss today, raise bar
  // by +3. Cycle 26 +5 was too aggressive (cost ₹60k). +3 is the sweet spot.
  if (postLossPenalty >= 1) {
    strategy.minScore = Math.min(95, strategy.minScore + 3 * postLossPenalty);
  }

  // ── Pipeline step 9d-ter: Expiry behavior overrides ──────────────────
  const expiry = expiryBehaviorEngine.evaluate({
    sessionPhase, spotPrice, atmStrike, gammaRegime, oiAnalytics, volatilityRegime,
  });
  if (expiry.active) {
    hybridLogger.info({
      sessionId, event: 'expiry_behavior',
      message: `${expiry.behavior} | ${expiry.reasoning}`,
      data: expiry,
    });
    if (expiry.overrides?.allowEntries === false) {
      return _noTrade(`Expiry cutoff: ${expiry.reasoning}`, { expiry });
    }
    if (Number.isFinite(expiry.overrides?.maxHoldSec)) {
      strategy.maxHoldSec = Math.min(strategy.maxHoldSec, expiry.overrides.maxHoldSec);
    }
  }

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

  // ── Pipeline step 9d-bis: Trap detection ─────────────────────────────
  // Catches the institutional setups where retail tends to get trapped.
  // Composite score ≥ blockThreshold blocks the trade outright; score in
  // the mid-range downgrades confidence by a fixed amount.
  const trap = trapDetectionEngine.evaluate({
    spotPrice,
    direction,
    volumeAnalysis,
    multiDayContext,
    multiTimeframe: algorithmOutputs?.multiTimeframe,
    vwap: payload?.vwap_analysis,
    todayStats: {
      dayHigh: history?.today?.sessionStats?.high,
      dayLow:  history?.today?.sessionStats?.low,
      ibHigh:  multiDayContext?.priorDay?.ibHigh,   // reusing the helper; we'll add live IB later
      ibLow:   multiDayContext?.priorDay?.ibLow,
    },
    sessionMemory: multiDayContext?.sessionMemory,
    oiAnalytics,
  }, { blockThreshold: Number(settings?.trapBlockThreshold ?? 80) });   // calibrated 90→80
  hybridLogger.info({
    sessionId, event: 'trap_detection',
    message: `trapScore=${trap.trapScore} ${trap.blocked ? '(BLOCKED)' : ''} ${trap.reasoning}`,
    data: { trapScore: trap.trapScore, blocked: trap.blocked, hardBlock: trap.hardBlock, breakdown: trap.breakdown },
  });
  if (trap.blocked) {
    return _noTrade(`Trap detection blocked: ${trap.reasoning}`, { trap, strategy });
  }

  // ── Pipeline step 9d-quad: Entry type evaluation ─────────────────────
  // Run all six institutional setup evaluators (Momentum / Reversal / Mean
  // Reversion / Breakout Expansion / Pullback / Exhaustion Fade) and pick
  // the highest-scoring valid one. Its hold profile overrides strategy.
  const entryType = entryTypeEngine.evaluate({
    direction,
    spotPrice,
    mtfStructure,
    gammaRegime,
    volumeAnalysis,
    oiAnalytics,
    auctionState,
    orderflowState,
    trendPhase,
    vwap: payload?.vwap_analysis,
    sessionMemory: multiDayContext?.sessionMemory,
    sessionPhase,
    multiDayContext,
    volatilityRegime,
    futuresData,
    candles1m,
    candles5m,
    metaRegime,        // calibrated: pre-filter blocked families
  });
  hybridLogger.info({
    sessionId, event: 'entry_type',
    message: `best=${entryType.bestType || 'none'} score=${entryType.bestScore} ${entryType.bestReasoning}`,
    data: { bestType: entryType.bestType, bestScore: entryType.bestScore,
            allEvals: entryType.allEvaluations.map(e => ({ type: e.type, valid: e.valid, score: e.score })) },
  });
  // CALIBRATED 2026-05-18 cycle 14: Don't early-return here when
  // entryType.bestType is null. The playbook engine (run next) is the
  // primary entry router and may match even when the legacy entry-type
  // evaluator finds nothing. We check after the playbook layer.
  // Apply entry-type's hold profile (overrides strategy's tradeType / maxHold)
  if (entryType.bestProfile) {
    strategy.tradeType   = entryType.bestProfile.tradeType   || strategy.tradeType;
    strategy.maxHoldSec  = Math.min(strategy.maxHoldSec, entryType.bestProfile.maxHoldSec || strategy.maxHoldSec);
  }

  // ── Pipeline step 9d-quint: STRATEGY PLAYBOOK ENGINE (institutional) ──
  // The auction-event router. Picks ONE specific institutional playbook
  // for the current meta-regime. If a playbook matches with at least
  // "standard" conviction, it OVERRIDES the entry type and provides its
  // own hold/risk profile. This is what turns the engine from "generic
  // bullish entry" into "initiative breakout after LVN acceptance".
  const playbookCtx = {
    direction, spotPrice,
    metaRegime, marketRegime, volatilityRegime, gammaRegime,
    auctionState, orderflowState, trendPhase, mtfStructure,
    volumeAnalysis, oiAnalytics, vwap: payload?.vwap_analysis,
    futuresData, sessionPhase, candles1m, candles5m, candles15m,
    sessionMemory: multiDayContext?.sessionMemory,
    multiDayContext,
    marketInternals: algorithmOutputs?.marketInternals,
    trap,
    // UT Bot per-timeframe trends (1m/5m/15m/30m + trailing stops) — used
    // by UT_BOT_FAST_SCALP playbook for ATR-trail-stop entry triggers.
    utBot,
    // Calibrated 2026-05-18: pass IV velocity stats (intraday tracker) for
    // IV_CRUSH_FADE playbook
    ivStats: ivVelocityTracker.getStats({
      sessionId,
      date: settings?.referenceDate || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
    }),
    ivPercentile: multiDayContext?.ivPercentile,
  };
  const playbook = strategyPlaybookEngine.evaluate(playbookCtx);
  hybridLogger.info({
    sessionId, event: 'playbook',
    message: `${playbook.bestName || 'none'} (${playbook.bestConviction || '-'}) score=${playbook.bestScore}`,
    data: {
      bestName: playbook.bestName,
      bestFamily: playbook.bestFamily,
      bestConviction: playbook.bestConviction,
      bestScore: playbook.bestScore,
      bestReasoning: playbook.bestReasoning,
      eligibleNames: playbook.eligibleNames,
      regimeAllowed: playbook.regimeAllowed,
      allPlaybooks: playbook.allPlaybooks,
    },
  });

  // If a playbook matched, override:
  //   - entry type → the playbook's name (so confidence engine sees it)
  //   - hold profile → playbook's holdProfile
  //   - risk profile → playbook's riskProfile (slPct, sizingFactor)
  if (playbook.bestPlaybook) {
    entryType.bestType        = playbook.bestName;
    entryType.bestProfile     = playbook.bestProfile;
    entryType.bestExitStyle   = playbook.bestPlaybook.riskProfile ? 'playbook_managed' : entryType.bestExitStyle;
    entryType.bestScore       = playbook.bestScore;
    entryType.bestReasoning   = `[playbook ${playbook.bestName}/${playbook.bestConviction}] ${playbook.bestReasoning}`;
    if (playbook.bestProfile) {
      strategy.tradeType  = playbook.bestProfile.tradeType  || strategy.tradeType;
      strategy.maxHoldSec = playbook.bestProfile.maxHoldSec || strategy.maxHoldSec;
    }
    // CALIBRATED 2026-05-18 cycle 31: institutional fallback playbooks
    // (LIGHT_TREND_DRIFT_SCALP) can lower the strategy minScore via
    // playbook.minScoreOverride. Used to rescue zero-trade days where elite
    // setups don't qualify but a lighter, well-confirmed drift scalp can
    // still produce edge. Cap at the lower of strategy.minScore and override
    // so we never *increase* threshold accidentally.
    if (Number.isFinite(playbook.bestPlaybook.minScoreOverride)) {
      strategy.minScore = Math.min(strategy.minScore, playbook.bestPlaybook.minScoreOverride);
    }
  } else if (!entryType.bestType || entryType.bestType === 'GENERIC_SCALP') {
    // CALIBRATED: no playbook AND no legacy entry-type → don't trade.
    // (Generic scalp fallback was the lowest-edge bucket in the backtest.)
    return _noTrade(
      `No playbook or entry type for ${metaRegime.state} ` +
      `(${playbook.allPlaybooks.filter(p => p.valid).length} playbooks valid, ` +
      `${entryType.allEvaluations.filter(e => e.valid).length} entry-types valid)`,
      { metaRegime, playbook, entryType }
    );
  }
  // else: no playbook matched but legacy entry-type did — proceed with that
  // Stash playbook on entryType so downstream snapshot carries it
  entryType.playbook = playbook.bestPlaybook ? {
    name: playbook.bestName,
    family: playbook.bestFamily,
    conviction: playbook.bestConviction,
    score: playbook.bestScore,
    risk: playbook.bestPlaybook.riskProfile,
    confirmations: playbook.bestPlaybook.confirmations,
    preconditions: playbook.bestPlaybook.preconditions,
  } : null;

  // ── Pipeline step 9d-pen: META-REGIME FAMILY HARD-BLOCK ──────────────
  // Calibrated: meta-regime now actively blocks entry families it deems
  // structurally incompatible (gamma_pin → no breakouts, balanced_auction
  // → no momentum, slow_grind → no expansion). This is the single biggest
  // change for win-rate improvement (was a soft penalty only).
  if (metaRegimeEngine.isFamilyBlocked && metaRegimeEngine.isFamilyBlocked(metaRegime, entryType.bestType)) {
    return _noTrade(
      `Meta-regime ${metaRegime.state} blocks family for ${entryType.bestType} (${metaRegime.reasoning})`,
      { metaRegime, entryType: entryType.bestType, strategy }
    );
  }

  // ── Pipeline step 9d-pen-bis: NO-TRADE ZONES (institutional spec) ────
  // A handful of states are guaranteed to bleed theta with no edge. Block
  // them outright unless this is a clear reversal/exhaustion fade setup.
  const noTradeReasons = [];
  // (a) Inside-VA acceptance with neutral delta and no zone bias = pure chop
  if (volumeAnalysis?.acceptance === 'inside_va'
      && volumeAnalysis?.delta?.bias === 'neutral'
      && (volumeAnalysis?.zone?.zone === 'neutral' || !volumeAnalysis?.zone?.zone)
      && entryType.bestType !== 'REVERSAL'
      && entryType.bestType !== 'EXHAUSTION_FADE') {
    noTradeReasons.push('inside_va + neutral delta + neutral zone — rotational chop');
  }
  // (b) POC distance < 10pts with no expansion volatility = pin zone
  const pocDist = (() => {
    const poc = volumeAnalysis?.frvp?.pocPrice;
    if (!Number.isFinite(poc) || !Number.isFinite(spotPrice)) return Infinity;
    return Math.abs(spotPrice - poc);
  })();
  if (pocDist < 10 && volatilityRegime?.state !== 'expansion'
      && entryType.bestType !== 'MEAN_REVERSION'
      && entryType.bestType !== 'VWAP_RECLAIM'
      && entryType.bestType !== 'LIGHT_TREND_DRIFT_SCALP') {
    noTradeReasons.push(`POC distance ${pocDist.toFixed(1)}pts (<10) with no expansion`);
  }
  // (c) Gamma-pin within 8pts of pinning level + no expansion → pure pin zone
  if (gammaRegime?.regime === 'positive'
      && Math.abs(gammaRegime.spotVsPin || 999) < 8
      && volatilityRegime?.state !== 'expansion'
      && (entryType.bestType === 'MOMENTUM_CONTINUATION'
        || entryType.bestType === 'BREAKOUT_EXPANSION'
        || entryType.bestType === 'PULLBACK')) {
    noTradeReasons.push(`positive gamma pin within 8pts (${gammaRegime.spotVsPin}pts) — dealer suppression`);
  }
  // (d) OI velocity weak (both CE & PE velocity < 50k abs) + dead vol = no flow
  const ceVel = Math.abs(oiAnalytics0?.diff?.ceVelocity || 0);
  const peVel = Math.abs(oiAnalytics0?.diff?.peVelocity || 0);
  if (ceVel < 50_000 && peVel < 50_000 && volatilityRegime?.state === 'dead'
      && entryType.bestType !== 'MEAN_REVERSION') {
    noTradeReasons.push(`OI velocity weak (ce ${ceVel.toFixed(0)} pe ${peVel.toFixed(0)}) + dead vol`);
  }
  // (e) Dead volatility + gamma_pin = pure dealer chop. 47% WR in backtest.
  //     Only allow REVERSAL or VWAP_RECLAIM (which catch the rare break of pin).
  if (volatilityRegime?.state === 'dead' && metaRegime?.state === 'gamma_pin'
      && entryType.bestType !== 'REVERSAL' && entryType.bestType !== 'VWAP_RECLAIM') {
    noTradeReasons.push(`dead vol + gamma_pin: only reversal/vwap_reclaim (got ${entryType.bestType})`);
  }
  // (f) Dealer-hedging (negative gamma) but ATR percentile < 30 = stall zone
  //     before the next big move. Skip until volatility expands.
  //     EXCEPT: LIGHT_TREND_DRIFT_SCALP is institutionally designed for
  //     this exact dead-vol drift profile (calibrated 2026-05-18 cycle 31).
  if (metaRegime?.state === 'dealer_hedging'
      && Number.isFinite(volatilityRegime?.atrPercentile)
      && volatilityRegime.atrPercentile < 30
      && entryType.bestType !== 'MEAN_REVERSION'
      && entryType.bestType !== 'VWAP_RECLAIM'
      && entryType.bestType !== 'LIGHT_TREND_DRIFT_SCALP') {
    noTradeReasons.push(`dealer_hedging + ATR pct ${volatilityRegime.atrPercentile} (<30) — stall zone`);
  }
  // (g) Momentum/breakout types REQUIRE active volatility. Dead-vol momentum
  //     was the worst category (47% WR, 32 trades, large SL hits).
  if ((entryType.bestType === 'MOMENTUM_CONTINUATION'
        || entryType.bestType === 'BREAKOUT_EXPANSION'
        || entryType.bestType === 'PULLBACK')
      && volatilityRegime?.state === 'dead') {
    noTradeReasons.push(`${entryType.bestType} requires active vol, got dead`);
  }
  // (h) MOMENTUM_CONTINUATION with delta against direction: 8 of 14 losses
  //     in this category had delta neutral or against direction at entry.
  if (entryType.bestType === 'MOMENTUM_CONTINUATION') {
    const deltaPct = Number(volumeAnalysis?.delta?.cvdPctLong || 0);
    if (direction === 'bullish' && deltaPct < 8) {
      noTradeReasons.push(`momentum bullish but delta only ${deltaPct.toFixed(1)}% (<8)`);
    }
    if (direction === 'bearish' && deltaPct > -8) {
      noTradeReasons.push(`momentum bearish but delta only ${deltaPct.toFixed(1)}% (>-8)`);
    }
  }
  // (i) Mean-reversion conflict check (cycle 9 calibration):
  //     When meta=gamma_pin but auction=momentum_continuation, the regime
  //     disagrees with itself. Only allow mean-reversion trade if direction
  //     is OPPOSITE to the auction trend. Same-direction = trend trade
  //     dressed up as a fade — high failure rate.
  //     Backtest evidence: 2026-02-17 had 3 BUY_CE entries on bullish
  //     trend pretending to be gamma fades — all hit SL within 60-120s.
  const meanRevertTypes = new Set([
    'MEAN_REVERSION', 'GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION',
    'COMPOSITE_PROFILE_EDGE_REJECTION', 'IV_CRUSH_FADE',
  ]);
  if (meanRevertTypes.has(entryType.bestType)
      && metaRegime?.state === 'gamma_pin'
      && auctionState?.tradingImplication === 'momentum_continuation') {
    const trendDir = (auctionState.dayType === 'trend_up') ? 'bullish'
                    : (auctionState.dayType === 'trend_down') ? 'bearish' : null;
    if (trendDir && trendDir === direction) {
      noTradeReasons.push(`mean-revert ${direction} same direction as auction ${trendDir} trend — failed fade risk`);
    }
  }
  if (noTradeReasons.length) {
    return _noTrade(`No-trade zone: ${noTradeReasons.join(' | ')}`, {
      metaRegime, entryType: entryType.bestType, gammaRegime: gammaRegime?.regime, volumeAnalysis: {
        acceptance: volumeAnalysis?.acceptance, delta: volumeAnalysis?.delta?.bias, zone: volumeAnalysis?.zone?.zone,
      },
    });
  }

  // ── Pipeline step 9e: Confidence scoring (centralised) ────────────────
  // ALL penalties (trap, MTF, trend phase, gamma family fit, expectancy)
  // are applied here in ONE place. No duplicate adjustments after this.
  const expAdj = expectancyEngine.getAdjustment({
    entryType: entryType.bestType,
    regime: marketRegime?.regime,
    phase: sessionPhase?.phase,
    expiry: !!sessionPhase?.isExpiryDay,
  });
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
    // Centralised inputs — all soft signals routed through here
    metaRegime,
    trap,
    trendPhase,
    mtfStructure,
    entryType: entryType.bestType,
    expectancyAdj: expAdj,
  });
  hybridLogger.info({
    sessionId, event: 'confidence',
    message: confidence.reasoning,
    data: {
      direction, total: confidence.score, tier: confidence.tier, allowed: confidence.allowed,
      raw: confidence.rawScore, adjustments: confidence.adjustmentBreakdown,
      perPillar: Object.fromEntries(Object.entries(confidence.parts || {}).map(([k, v]) => [k, v.score])),
    },
  });

  if (!confidence.allowed) {
    return _noTrade(`Confidence ${confidence.score} < ${strategy.minScore} (${strategy.strategy}/${entryType.bestType})`, {
      confidence, strategy, scoreResult,
    });
  }

  // Tier guard removed — INTRADAY_MOMENTUM had 75% WR in backtest but tier
  // requirement filtered most setups away. The strategy's minScore now does
  // the gating directly.

  // ── Pipeline step 10: Hard requirement — risk engine OK ──────────────
  if (!risk.allowEntries) {
    return _noTrade(`Risk engine blocks: ${risk.reasoning}`);
  }
  if (!sessionPhase.allowEntries) {
    if (sessionPhase.restrictedByPhaseFilter) {
      return _noTrade(`Session phase ${sessionPhase.phase} blocked by restrictToHighQualityPhases (only morning/power_hour allowed)`);
    }
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
    ivPercentile: multiDayContext?.ivPercentile,
    expiryOverrides: expiry?.overrides || null,
    hhmm: sessionPhase?.hhmm,
    preferOTM: settings?.preferOTMStrikes === true,
  });
  if (!strikeRes.ok) {
    return _noTrade(`Strike selection failed: ${strikeRes.reason}`);
  }
  // CALIBRATED 2026-05-18 cycle 6: For mean-reversion / vwap-reclaim style
  // playbooks, block deep-OTM fades (entry premium < 60 + delta < 0.30).
  // These are statistically the worst — premium is too far from price for
  // a small mean-reversion move to recover the gap.
  // Backtest evidence: 2026-02-17 had 3 losses on strike 25700 CE with spot
  // ~25530 (170pts OTM, premium ~60). All hit SL within 60-120s.
  const meanRevertPlaybooks = new Set([
    'GAMMA_PIN_MEAN_REVERSION', 'MEAN_REVERSION', 'HVN_REJECTION_ROTATION',
    'COMPOSITE_PROFILE_EDGE_REJECTION', 'IV_CRUSH_FADE',
  ]);
  if (meanRevertPlaybooks.has(entryType.bestType)
      && Number(strikeRes.ltp) < 60
      && Number(strikeRes.delta) < 0.32) {
    return _noTrade(
      `Deep-OTM mean-revert block: ltp=${strikeRes.ltp} delta=${strikeRes.delta} on ${entryType.bestType}`,
      { strike: strikeRes.strike, ltp: strikeRes.ltp, delta: strikeRes.delta }
    );
  }
  hybridLogger.info({
    sessionId, event: 'strike',
    message: `strike=${strikeRes.strike} ${strikeRes.optionType} (${strikeRes.moneyness}) ` +
             `delta=${strikeRes.delta?.toFixed(2)} ltp=${strikeRes.ltp} ` +
             `anchor=${strikeRes.window?.anchor} dist=${strikeRes.distFromAnchor}pts`,
    data: strikeRes,
  });

  // ── Pipeline step 11b: Structural targeting ──────────────────────────
  // Replace static target/SL with dynamic structural levels (HVN, IB ext,
  // PDH/PDL, composite VAH/VAL). Falls back to strategy's static numbers if
  // no clean structural levels exist.
  const structural = structuralTargetEngine.resolve({
    spotPrice,
    direction,
    tradeType: strategy.tradeType,
    volumeAnalysis,
    multiDayContext,
    todayStats: {
      dayHigh: history?.today?.sessionStats?.high,
      dayLow:  history?.today?.sessionStats?.low,
      ibHigh:  multiDayContext?.priorDay?.ibHigh,
      ibLow:   multiDayContext?.priorDay?.ibLow,
    },
    atr: volatilityRegime?.atr5m,
    entryPrice: strikeRes.ltp,
    optionDelta: strikeRes.delta,
    settings,
  });
  hybridLogger.info({
    sessionId, event: 'structural_target',
    message: structural.reasoning,
    data: structural,
  });

  // ── Pipeline step 12: ATR target sanity ──────────────────────────────
  // Use the structural-target's option points if available, otherwise fall
  // back to the strategy's static target. ATR confirms the target is
  // physically achievable given current volatility.
  const targetPoints = structural?.optionTargetPts || strategy.targetPoints;
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
  // Apply aggression mode sizing factor + trap size-cut + meta-regime factor
  let aggressedLots = Math.max(1, Math.round(sizing.lots * (aggression.sizingFactor || 1)));
  if (trap?.sizeReduce && trap.sizeReduce < 1.0) {
    aggressedLots = Math.max(1, Math.round(aggressedLots * trap.sizeReduce));
  }
  if (metaRegime?.sizingFactor && metaRegime.sizingFactor < 1.0) {
    aggressedLots = Math.max(1, Math.round(aggressedLots * metaRegime.sizingFactor));
  }
  // Playbook sizing factor — institutional risk profile per setup family
  if (entryType.playbook?.risk?.sizingFactor && entryType.playbook.risk.sizingFactor < 1.0) {
    aggressedLots = Math.max(1, Math.round(aggressedLots * entryType.playbook.risk.sizingFactor));
  }
  // CALIBRATED 2026-05-18: Premium-aware sizing. High-premium options have
  // bigger absolute rupee impact on every adverse move. Halve the lots
  // when entry premium > ₹200 (typical deep ATM of NIFTY/expensive index).
  // Backtest evidence: largest losses were 5-lot trades at ₹300+ entry premium.
  const _entryPrem = Number(strikeRes.ltp) || 0;
  if (_entryPrem >= 250) {
    aggressedLots = Math.max(1, Math.round(aggressedLots * 0.5));
  } else if (_entryPrem >= 150) {
    aggressedLots = Math.max(1, Math.round(aggressedLots * 0.7));
  }
  sizing.lots = Math.min(Number(settings?.maxLots) || 3, aggressedLots);
  hybridLogger.info({
    sessionId, event: 'sizing',
    message: `lots=${sizing.lots} factors=${sizing.factors.join('×')} aggression=${aggression.mode}(${aggression.sizingFactor}) product=${sizing.product}`,
    data: { ...sizing, aggressionMode: aggression.mode, aggressionSizing: aggression.sizingFactor },
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

  // Build the decision ───────────────────────────────────────────────────
  // Use the structural target/SL when available. Strategy-static numbers are
  // the floor.
  let slPoints  = structural?.optionSlPts     || strategy.slPoints;
  let targetOut = structural?.optionTargetPts || strategy.targetPoints;

  // CALIBRATED (institutional spec, 2026-05-18): Cap option-premium SL at a
  // fixed percentage of the entry premium. Backtest evidence:
  //   6 SL hits = -₹51,499 net, with single -₹15,075 trade on -46pt premium SL.
  //   The structural engine's `floorSl = max(slPoints, atr*0.5)` allows wide
  //   stops that don't translate well to option-premium %.
  //
  // Cap rules (per-strategy/entry-type/playbook, balanced for runners vs losses):
  //   GAMMA_PIN_MEAN_REVERSION   : SL ≤ 8%  (tight — pin range is small)
  //   FAILED_AUCTION_REVERSAL    : SL ≤ 10%
  //   VWAP_RECLAIM_CLEAN         : SL ≤ 9%
  //   PULLBACK_CONTINUATION      : SL ≤ 11%
  //   INITIATIVE_MOMENTUM_EXP.   : SL ≤ 13% (room for trend run)
  //   BREAKOUT_EXPANSION         : SL ≤ 16%
  //   Generic SWING              : SL ≤ 14%
  //   Generic SCALP              : SL ≤ 10%
  // Then apply absolute floor of 6pts.
  //
  // The playbook's riskProfile.slPct OVERRIDES these defaults if available.
  const entryPremium = Number(strikeRes.ltp) || 0;
  if (entryPremium > 0) {
    let slPct;
    if (entryType.playbook?.risk?.slPct) {
      slPct = entryType.playbook.risk.slPct;            // playbook-driven
    } else if (entryType.bestType === 'BREAKOUT_EXPANSION') {
      slPct = 0.16;
    } else if (strategy.tradeType === 'SWING') {
      slPct = 0.14;
    } else {
      slPct = 0.10;
    }
    const cappedSl = Math.max(6, Math.round(entryPremium * slPct));
    if (cappedSl < slPoints) {
      hybridLogger.info({
        sessionId, event: 'sl_capped',
        message: `SL capped: ${slPoints}pts → ${cappedSl}pts (${(slPct*100).toFixed(0)}% of ₹${entryPremium})`,
        data: { originalSl: slPoints, cappedSl, entryPremium, slPct,
                playbook: entryType.playbook?.name },
      });
      slPoints = cappedSl;
      // Maintain RR — also cap target proportionally if structural was huge
      const rrTarget = entryType.playbook?.holdProfile?.rrTarget || (strategy.tradeType === 'SWING' ? 4 : 1.6);
      const maxTarget = cappedSl * rrTarget;
      if (targetOut > maxTarget) targetOut = maxTarget;
    }
  }
  const expectedPoints = strategy.tradeType === 'SWING'
    ? Math.max(targetOut, 30)
    : targetOut;
  // Meta-regime stretches/compresses hold time per institutional state
  const baseHold = strategy.maxHoldSec;
  const maxHoldSeconds = Math.max(60, Math.round(baseHold * (metaRegime?.holdMultiplier || 1)));

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
    // Phase 2-5 institutional context
    auctionState:    auctionState ? {
      dayType: auctionState.dayType, openType: auctionState.openType,
      acceptance: auctionState.acceptance, valueMigration: auctionState.valueMigration,
      tradingImplication: auctionState.tradingImplication,
    } : null,
    gammaRegime: gammaRegime ? {
      regime: gammaRegime.regime, netGex: gammaRegime.netGex,
      callWall: gammaRegime.callWall, putWall: gammaRegime.putWall,
      gammaFlip: gammaRegime.gammaFlip, pinningLevel: gammaRegime.pinningLevel,
    } : null,
    mtfStructure: mtfStructure ? {
      tf15: mtfStructure.tf15, tf5: mtfStructure.tf5, tf1: mtfStructure.tf1,
      alignment: mtfStructure.alignment, score: mtfStructure.score,
    } : null,
    orderflowState: orderflowState ? {
      state: orderflowState.state, bias: orderflowState.bias, holdLonger: orderflowState.holdLonger,
    } : null,
    trendPhase: trendPhase ? { phase: trendPhase.phase, bias: trendPhase.bias } : null,
    entryType: entryType ? {
      type: entryType.bestType, score: entryType.bestScore,
      exitStyle: entryType.bestExitStyle, holdProfile: entryType.bestProfile,
      playbook: entryType.playbook || null,
    } : null,
    aggression: aggression ? { mode: aggression.mode, sizingFactor: aggression.sizingFactor } : null,
    expiry: expiry?.active ? { behavior: expiry.behavior, overrides: expiry.overrides } : null,
    metaRegime: metaRegime ? {
      state: metaRegime.state, allowedFamilies: metaRegime.allowedFamilies,
      sizingFactor: metaRegime.sizingFactor, holdMultiplier: metaRegime.holdMultiplier,
    } : null,
    structural: structural ? {
      spotTargetPrice: structural.spotTargetPrice, spotStopPrice: structural.spotStopPrice,
      targetSource: structural.targetSource, stopSource: structural.stopSource,
      rrSpot: structural.rrSpot,
    } : null,
  };

  const reasoning = [
    `[hybrid:${grade.grade}/${strategy.strategy}/${tradeType}/${entryType.bestType}]`,
    `meta=${metaRegime?.state}`,
    `regime=${marketRegime.regime}`,
    `vol=${volatilityRegime.state}`,
    `gamma=${gammaRegime?.regime}`,
    `auction=${auctionState?.dayType}/${auctionState?.tradingImplication}`,
    `phase=${trendPhase?.phase}`,
    `flow=${orderflowState?.state}`,
    `mtf=${mtfStructure?.alignment}(${mtfStructure?.score})`,
    `liq=${liquidity.health}`,
    `der=${derivatives.overallBias}(${derivatives.directionScore})`,
    volumeAnalysis ? `vp=${volumeAnalysis.acceptance}/${volumeAnalysis.vsa?.pattern || 'na'}` : null,
    volumeAnalysis?.delta ? `delta=${volumeAnalysis.delta.bias}(${volumeAnalysis.delta.cvdPctLong}%)` : null,
    oiAnalytics ? `oi=${oiAnalytics.regime}/q${oiAnalytics.qualityScore ?? '-'}` : null,
    utBot ? `ut=${utBot.score}` : null,
    `agg=${aggression.mode}`,
    expiry?.active ? `expiry=${expiry.behavior}` : null,
    `confidence=${confidence.score}(${confidence.tier}|raw${confidence.rawScore})`,
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
      multiDayContext, structural, trap,
      auctionState, gammaRegime, mtfStructure, orderflowState, trendPhase,
      entryType, aggression, expiry, metaRegime,
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
