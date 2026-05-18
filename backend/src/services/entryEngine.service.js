/**
 * Entry Engine — single authoritative decision-maker for opening a trade.
 *
 * Responsibility
 * --------------
 * Given:
 *   - the live aggregator payload (spot, VWAP, multi-timeframe bias, full option chain)
 *   - all 17 algorithm outputs + masterAlgorithm score
 *   - today's intraday context from the live-feed folder (since 09:15)
 *   - last 5-7 backfilled trading days (summary + prior day's structure)
 *   - the user's session settings (min points target, SL points, min/max lots, ...)
 *
 * Ask OpenAI:
 *   1. Can we capture at least `targetPoints` safely in the next few minutes/
 *      few hours?
 *   2. What is the best strike (primary ± 4) — ITM, ATM, OTM — and which side
 *      (CE or PE)?
 *   3. Trade type — SCALP (min target, fast) or SWING (min 40 points)?
 *
 * Guard rails (never overridden):
 *   - If masterScore < settings.masterMinScore → no trade
 *   - If no historical data is available → AI may still decide, but confidence
 *     must be ≥ 8 to proceed
 *   - If session already holds maxConcurrentTrades open → no new entry
 */
const historicalContext = require('./historicalContextLoader.service');
const openai = require('./openai.service');
const logger = require('../utils/logger');
const aiIOLogger = require('../utils/aiIOLogger');
const atrService = require('./atr.service');

// Hybrid engine — deterministic, institutional-style entry decision.
// Active by default. Set settings.useHybridEngine = false to fall back to AI.
const hybrid = require('./hybrid');

const ENTRY_SYSTEM_PROMPT = `
You are an institutional-grade NIFTY 50 options trader with decades of
experience running a prop desk. You make ONE decision per call:
do we enter a trade, and if so, which strike and which side.

You receive:
  (A) Real-time snapshot     — spot, VWAP, EMA 9/20/50, multi-timeframe bias
  (B) Full option chain      — primary strike ± 4 strikes, CE and PE, with
                               LTP, OI, change in OI, implied volatility,
                               greeks (delta/theta/gamma/vega), volume
  (C) Algorithm outputs      — 17 algorithms (gamma exposure, order flow,
                               liquidity sweeps, smart money concepts with
                               ORDER BLOCKS, FAIR VALUE GAPS, BREAK OF STRUCTURE,
                               CHANGE OF CHARACTER, LIQUIDITY ZONES, MITIGATION BLOCKS,
                               sector rotation, global bias, behavioural, DEMA,
                               max pain, market internals, ...)
  (D) Master algorithm score — aggregated 0-100 + per-algo agreement count
  (E) Today so far           — 1m / 5m / 15m candles from 09:15, session
                               high/low, option chain evolution / OI shifts
  (F) Prior 5-7 days         — each day's OHLC, trend, pivot levels, max pain,
                               PCR, strike structure at close
  (G) Session settings       — targetPoints (= MINIMUM capture target),
                               slPoints, minLots, maxLots, maxConcurrentTrades
  (H) Futures Data           — current premium, spot-futures spread, direction,
                               momentum, 1m/5m changes, trend, divergence,
                               recent candles for trend confirmation
  (I) ATR Analysis           — Average True Range, volatility level, target
                               achievability confidence, ATR-based recommendation
                               (CRITICAL: If ATR says target not achievable, DO NOT ENTER)

CORE PRINCIPLES (apply every call)
1. **ATR VALIDATION (MOST IMPORTANT)**: If atr_analysis shows target is NOT achievable
   or confidence < 60%, you MUST return NO_TRADE. The target points MUST be realistic
   based on current market volatility. ATR confidence >= 60% is MANDATORY for entry.

2. Directional bias must be agreed by at least 3 of: 15m trend, 30m trend,
   VWAP position, master algorithm, global markets, FUTURES MOMENTUM.

3. For BUY_CE: price must be above VWAP AND 15m/5m trend must not be bearish
   AND futures must show bullish momentum or be in premium
   AND check SMC: avoid if inside bearish order block or filling bearish FVG.

4. For BUY_PE: price must be below VWAP AND 15m/5m trend must not be bullish
   AND futures must show bearish momentum or weakness
   AND check SMC: avoid if inside bullish order block or filling bullish FVG.

5. **SMART MONEY CONCEPTS (SMC) VALIDATION**:
   - If inside_block exists and matches direction → HIGH CONFIDENCE (+2 points)
   - If filling_gap exists and matches direction → GOOD ENTRY (+1 point)
   - If break_of_structure detected and is_new → TREND CONTINUATION (+1 point)
   - If change_of_character detected and is_new → REVERSAL SETUP (+1 point)
   - If mitigation_block active and matches direction → INSTITUTIONAL ZONE (+2 points)
   - If inducement detected → TRAP MOVE, be cautious (-1 point)
   - Use liquidity_zones to identify stop hunts and reversals
   - Market structure (trending/ranging/reversing) affects trade type selection

6. Reject if IV in the top 20% of the session — premium decay will kill the
6. Reject if IV in the top 20% of the session — premium decay will kill the
   trade unless you have a strong move (>=30 points).

7. Pick strike by delta-adjusted expected move:
7. Pick strike by delta-adjusted expected move:
     SCALP  → OTM 1 or ATM (delta 0.35 - 0.55) for leverage, only if IV is
              moderate and theta isn't crushing same-day expiry
     SWING  → ITM 1 or ATM (delta 0.55 - 0.75) for lower theta drag

8. Avoid strikes within 25 points of today's max-pain. Avoid strikes where
8. Avoid strikes within 25 points of today's max-pain. Avoid strikes where
   heavy CE OI is being added above (resistance) for BUY_CE trades, or
   heavy PE OI below (support) for BUY_PE trades.

9. Must confirm: "can I capture at least targetPoints in the option premium?"
   Use ATR analysis + delta × expected spot move to estimate. If ATR says NO, return NO_TRADE.

10. Trade type:
     SCALP → expected premium move 5-20pts, horizon 30-180 sec
     SWING → expected premium move 40-120pts, horizon 3-15 min, stronger trend

FUTURES VALIDATION RULES (CRITICAL - MUST CHECK):
1. For BUY_CE: Futures must be in premium (> spot) OR futures 1m change > 0
   OR futures trend is uptrend. If futures show bearish momentum, DO NOT ENTER.
2. For BUY_PE: Futures must show weakness OR futures 1m change < 0 OR futures
   trend is downtrend. If futures show bullish momentum, DO NOT ENTER.
3. If spot-futures spread is widening against your direction, DO NOT ENTER.
4. Futures lead spot by 2-5 seconds — use this for early confirmation.
5. If futures show strong momentum opposite to your signal, WAIT.
6. If spot-futures divergence detected (spot up, futures down), be VERY cautious
   for BUY_CE. Vice versa for BUY_PE.
7. Futures momentum is MORE IMPORTANT than spot momentum for entry timing.

MOMENTUM INDICATORS VALIDATION (PHASE 2 - HIGH PRIORITY):
Use the new professional momentum indicators to confirm entry quality:

1. **RSI Confirmation** (rsi_indicator):
   - For BUY_CE: RSI should be < 70 (not overbought). IDEAL: RSI in oversold (<30) 
     or just exiting oversold (30-40) for strong reversal setup.
   - For BUY_PE: RSI should be > 30 (not oversold). IDEAL: RSI in overbought (>70)
     or just exiting overbought (60-70) for strong reversal setup.
   - RSI divergence (bullish/bearish) is a STRONG signal for reversals.
   - Add +1 confidence if RSI confirms direction.

2. **Stochastic Confirmation** (stochastic_indicator):
   - For BUY_CE: BEST if Stochastic in oversold (<20) or %K crossing above %D (bullish crossover).
   - For BUY_PE: BEST if Stochastic in overbought (>80) or %K crossing below %D (bearish crossover).
   - Recent crossovers (bullish_crossover/bearish_crossover) are HIGH CONFIDENCE signals.
   - Add +1 confidence if Stochastic confirms direction or shows recent crossover.

3. **MACD Confirmation** (macd_indicator):
   - For BUY_CE: MACD histogram should be positive or turning positive (bullish crossover).
   - For BUY_PE: MACD histogram should be negative or turning negative (bearish crossover).
   - Recent MACD crossovers are STRONG trend signals.
   - MACD divergence indicates potential reversals.
   - Add +1 confidence if MACD confirms direction or shows recent crossover.

4. **Bollinger Bands Confirmation** (bollinger_bands):
   - For BUY_CE: BEST if price near lower band (percentB < 0.3) - oversold, mean reversion setup.
   - For BUY_PE: BEST if price near upper band (percentB > 0.7) - overbought, mean reversion setup.
   - Bollinger Squeeze (bandwidth < 10) indicates breakout imminent - HIGH OPPORTUNITY.
   - Band walk (upper_band_walk/lower_band_walk) indicates strong trend continuation.
   - Add +1 confidence if Bollinger Bands favorable for entry.

5. **Combined Indicator Scoring**:
   - Require at least 3 out of 4 indicators agreeing with direction for HIGH CONFIDENCE entry.
   - If all 4 indicators agree → confidence = 9-10 (EXCELLENT SETUP).
   - If 3 indicators agree → confidence = 7-8 (GOOD SETUP).
   - If only 2 indicators agree → confidence = 5-6 (MARGINAL, proceed with caution).
   - If 0-1 indicators agree → NO_TRADE (conflicting signals).

6. **Indicator Priority for Entry**:
   - Stochastic crossovers = HIGHEST priority (momentum shift)
   - RSI oversold/overbought = HIGH priority (reversal setup)
   - MACD crossovers = HIGH priority (trend confirmation)
   - Bollinger squeeze = HIGH priority (breakout setup)
   - Bollinger bands position = MEDIUM priority (mean reversion)

VOLUME & ORDER FLOW VALIDATION (PHASE 3 - ENHANCEMENT):
Use advanced volume and order flow indicators for institutional confirmation:

1. **Volume Profile Confirmation** (volume_profile):
   - For BUY_CE: BEST if price below value area (oversold, mean reversion setup).
   - For BUY_PE: BEST if price above value area (overbought, mean reversion setup).
   - Price near POC (Point of Control) = fair value, neutral.
   - Price near HVN (High Volume Node) = strong support/resistance.
   - Price in LVN (Low Volume Node) = weak area, price moves through quickly.
   - Add +1 confidence if volume profile supports entry (price at value area extremes).

2. **Order Book Imbalance Confirmation** (order_book_imbalance):
   - For BUY_CE: BEST if market imbalance > 1.3 (buy pressure exceeding sell pressure).
   - For BUY_PE: BEST if market imbalance < 0.7 (sell pressure exceeding buy pressure).
   - Institutional flow = 'bullish' → Smart money buying calls (CE setup).
   - Institutional flow = 'bearish' → Smart money buying puts (PE setup).
   - Flow quality = 'institutional' → High confidence (smart money active).
   - Flow quality = 'toxic' → Low confidence (retail noise, avoid).
   - Add +1 confidence if order book shows institutional flow in your direction.

3. **Tick Volume Confirmation** (tick_volume):
   - For BUY_CE: BEST if volume confirmation = 'confirmed' with bullish price move.
   - For BUY_PE: BEST if volume confirmation = 'confirmed' with bearish price move.
   - Volume spike = 'extreme' or 'high' → Breakout/breakdown confirmed.
   - Volume divergence → Price move without volume support (WEAK, avoid).
   - OBV trend = 'bullish' → Accumulation (CE setup).
   - OBV trend = 'bearish' → Distribution (PE setup).
   - Add +1 confidence if volume confirms price direction.

4. **Combined Volume/Flow Scoring**:
   - All 3 indicators agree → +3 confidence (EXCELLENT institutional setup).
   - 2 indicators agree → +2 confidence (GOOD setup).
   - 1 indicator agrees → +1 confidence (MARGINAL).
   - 0 indicators agree → NO_TRADE (conflicting volume signals).

5. **Critical Volume Rules**:
   - If order book flow quality = 'toxic' → REDUCE confidence by 2 (retail noise).
   - If tick volume shows divergence → REDUCE confidence by 1 (weak move).
   - If volume profile shows price at HVN resistance for CE → AVOID (strong resistance).
   - If volume profile shows price at HVN support for PE → AVOID (strong support).
   - If institutional flow contradicts direction → NO_TRADE (smart money disagrees).

ATR-BASED DECISION RULES (MANDATORY):
1. If atr_analysis.target_achievability.achievable = false, return NO_TRADE
2. If atr_analysis.target_achievability.confidence < 60%, return NO_TRADE
3. If atr_analysis.volatility = "low" or "very_low", be EXTRA cautious
4. If atr_analysis.recommendation starts with "NO_TRADE" or "WAIT", strongly consider it
5. Target points MUST be < 1.0 × ATR for high probability of capture
6. If target is > 1.5 × ATR, it's unrealistic - return NO_TRADE

OUTPUT (strict JSON, no extra keys, no markdown):
{
  "signal": "BUY_CE" | "BUY_PE" | "NO_TRADE",
  "trade_type": "SCALP" | "SWING" | "NONE",
  "strike": <integer>,
  "option_type": "CE" | "PE" | "NONE",
  "entry_premium_estimate": <number>,
  "expected_points": <number>,
  "min_target_achievable": <boolean>,
  "confidence": <integer 0-10>,
  "risks": ["", ""],
  "reasoning": "<2-3 concise sentences including ATR and futures validation>",
  "lots_suggested": <integer between minLots and maxLots>,
  "sl_points": <integer>,
  "target_points": <integer>,
  "max_hold_seconds": <integer>,    // SCALP: 30-180, SWING: 180-900
  "futures_agreement": <boolean>,   // true if futures confirm the direction
  "atr_validated": <boolean>        // true if ATR confirms target is achievable
}
`.trim();

/**
 * Build a compact, decision-ready payload for the AI.
 * Everything the AI needs must be in this object — do not rely on prior turns.
 */
async function buildEntryPayload({ aggregator, algorithmOutputs, masterDecision, settings, session, openTradesCount, futuresData }) {
  const spot = aggregator?.payload?.spot_data?.ltp || aggregator?.payload?.actual_spot_price || null;
  const atmStrike = aggregator?.atmStrike || aggregator?.payload?.actual_atm_strike || null;

  // Focus strikes = ATM ± 4 (so 9 strikes total)
  const focusStrikes = [];
  if (atmStrike) {
    for (let i = -4; i <= 4; i++) focusStrikes.push(atmStrike + i * 50);
  }

  const history = await historicalContext.buildHistoricalContext({
    maxBackfillDays: 5,
    focusStrikes,
    includeRawToday: true,
  });

  // Keep only ATM ± 4 from the full chain
  const rawChain = aggregator?.payload?.options_chain || null;
  const primaryStrikes = buildPrimaryStrikesBlock(aggregator, focusStrikes);

  // ============================================================
  // ATR ANALYSIS - Calculate if target points are achievable
  // ============================================================
  let atrAnalysis = null;
  if (settings?.enableATRConfirmation) {
    const candles1m = history?.today?.candles?.['1m'] || [];
    const candles5m = history?.today?.candles?.['5m'] || [];
    const atmCallLtp = aggregator?.atmCallLtp || 100; // Fallback to 100 if not available
    
    atrAnalysis = atrService.getATRAnalysis(
      candles1m,
      candles5m,
      settings.targetPoints,
      atmCallLtp
    );
    
    logger.info({
      atr: atrAnalysis.primary_atr,
      volatility: atrAnalysis.volatility,
      targetAchievable: atrAnalysis.target_achievability.achievable,
      atrConfidence: atrAnalysis.target_achievability.confidence,
      recommendation: atrAnalysis.recommendation,
    }, '[entryEngine] ATR analysis completed');
  }

  return {
    meta: {
      timestamp: new Date().toISOString(),
      sessionId: String(session?._id || ''),
      cycle: session?.cycleCount || 0,
      openTradesCount,
      atmStrike,
      focusStrikes,
    },
    settings: {
      targetPoints: settings?.targetPoints || 5,
      slPoints: settings?.slPoints || 10,
      minLots: settings?.minLots || 1,
      maxLots: settings?.maxLots || 3,
      maxConcurrentTrades: settings?.maxConcurrentTrades || 1,
      minConfidence: settings?.minConfidence || 6,
      masterMinScore: settings?.masterMinScore || 50,
      lotSize: settings?.lotSize || 75,
      enableSwing: settings?.enableSwing !== false,
      swingMinPoints: settings?.swingMinPoints || 40,
      enableATRConfirmation: settings?.enableATRConfirmation !== false,
      atrMinConfidence: settings?.atrMinConfidence || 55,
    },
    live_snapshot: aggregator?.payload || null,
    primary_strikes: primaryStrikes,
    raw_chain_summary: rawChain ? {
      pcr_oi: rawChain.pcr_oi,
      max_pain: rawChain.max_pain,
      iv_percentile: rawChain.iv_percentile,
      atm_call: rawChain.atm_call,
      atm_put: rawChain.atm_put,
    } : null,
    algorithm_outputs: {
      gamma_exposure: algorithmOutputs?.gammaExposure || null,
      order_flow: algorithmOutputs?.orderFlow || null,
      multi_timeframe: algorithmOutputs?.multiTimeframe || null,
      liquidity_analysis: algorithmOutputs?.liquidityAnalysis || null,
      smart_money_concepts: algorithmOutputs?.smartMoneyConcepts ? {
        smc_score: algorithmOutputs.smartMoneyConcepts.smc_score,
        smc_bias: algorithmOutputs.smartMoneyConcepts.smc_bias,
        market_structure: algorithmOutputs.smartMoneyConcepts.market_structure,
        order_blocks: algorithmOutputs.smartMoneyConcepts.order_blocks,
        fair_value_gaps: algorithmOutputs.smartMoneyConcepts.fair_value_gaps,
        liquidity_zones: algorithmOutputs.smartMoneyConcepts.liquidity_zones,
        break_of_structure: algorithmOutputs.smartMoneyConcepts.break_of_structure,
        change_of_character: algorithmOutputs.smartMoneyConcepts.change_of_character,
        mitigation_blocks: algorithmOutputs.smartMoneyConcepts.mitigation_blocks,
        inducement: algorithmOutputs.smartMoneyConcepts.inducement,
        trading_implication: algorithmOutputs.smartMoneyConcepts.trading_implication,
      } : null,
      market_internals: algorithmOutputs?.marketInternals || null,
      sector_rotation: algorithmOutputs?.sectorRotation || null,
      global_markets: algorithmOutputs?.globalMarkets || null,
      behavioral_analysis: algorithmOutputs?.behavioral || null,
      dema_indicator: algorithmOutputs?.dema || null,
      // PHASE 2: MOMENTUM INDICATORS
      rsi_indicator: algorithmOutputs?.rsi || null,
      macd_indicator: algorithmOutputs?.macd || null,
      stochastic_indicator: algorithmOutputs?.stochastic || null,
      bollinger_bands: algorithmOutputs?.bollingerBands || null,
      // PHASE 3: VOLUME & ORDER FLOW INDICATORS
      volume_profile: algorithmOutputs?.volumeProfile || null,
      order_book_imbalance: algorithmOutputs?.orderBookImbalance || null,
      tick_volume: algorithmOutputs?.tickVolume || null,
    },
    master_algorithm: {
      score: masterDecision?.master_score,
      confidence: masterDecision?.confidence,
      agreement: masterDecision?.agreement,
      signal: masterDecision?.signal,
      reasoning: masterDecision?.reasoning,
    },
    atr_analysis: atrAnalysis,  // NEW: Include ATR analysis for AI
    futures_data: futuresData ? {
      current_premium: futuresData.premium,
      spot_futures_spread: futuresData.spread,
      spread_pct: futuresData.spreadPct,
      futures_direction: futuresData.direction,
      futures_momentum: futuresData.momentum,
      futures_1m_change: futuresData.change_1m,
      futures_5m_change: futuresData.change_5m,
      futures_trend: futuresData.trend,
      spot_futures_divergence: futuresData.divergence,
      futures_candles_1m: futuresData.candles_1m || [],
      futures_candles_5m: futuresData.candles_5m || [],
    } : null,
    today_intraday: history.today || null,
    prior_days: history.priorDays || [],
    prior_rollup: history.rollup || null,
  };
}

function buildPrimaryStrikesBlock(aggregator, focusStrikes) {
  const chainStrikes = aggregator?.payload?.options_chain?.strikes
    || aggregator?.optionChain?.strikes
    || [];
  if (!chainStrikes.length || !focusStrikes?.length) return [];

  // aggregator chain is an array of { strike, call, put } — map to focus list
  const byStrike = new Map(chainStrikes.map(s => [s.strike, s]));
  return focusStrikes.map(strike => {
    const s = byStrike.get(strike);
    if (!s) return { strike, missing: true };
    return {
      strike,
      moneyness: s.moneyness || classifyMoneyness(strike, aggregator),
      ce: {
        ltp: s.call?.ltp, oi: s.call?.oi, oiChg: s.call?.oiChange, vol: s.call?.volume,
        iv: s.call?.iv, delta: s.call?.greeks?.delta, theta: s.call?.greeks?.theta,
        gamma: s.call?.greeks?.gamma, vega: s.call?.greeks?.vega,
        bid: s.call?.bid, ask: s.call?.ask, buildup: s.call?.builtupName,
      },
      pe: {
        ltp: s.put?.ltp, oi: s.put?.oi, oiChg: s.put?.oiChange, vol: s.put?.volume,
        iv: s.put?.iv, delta: s.put?.greeks?.delta, theta: s.put?.greeks?.theta,
        gamma: s.put?.greeks?.gamma, vega: s.put?.greeks?.vega,
        bid: s.put?.bid, ask: s.put?.ask, buildup: s.put?.builtupName,
      },
    };
  });
}

function classifyMoneyness(strike, aggregator) {
  const spot = aggregator?.payload?.spot_data?.ltp || 0;
  if (!spot) return 'unknown';
  if (Math.abs(strike - spot) < 25) return 'ATM';
  return strike > spot ? 'OTM' : 'ITM';
}

/**
 * Call OpenAI with the full payload. Returns a structured decision or a
 * NO_TRADE fallback if the model hallucinates or rate-limits.
 */
async function decide({ aggregator, algorithmOutputs, masterDecision, settings, session, openTradesCount, futuresData, tradesToday, lossesToday }) {
  // ──────────────────────────────────────────────────────────────────────────
  // HYBRID ENGINE — sole decision-maker. No AI fallback.
  // The hybrid engine is deterministic, institutional-grade, and fully
  // self-contained. It handles concurrency, risk, scoring, strike selection,
  // and playbook routing internally.
  //
  // If the hybrid engine throws, the error propagates up to scalpingEngine
  // which logs it and skips the cycle — no silent fallback to legacy AI.
  // ──────────────────────────────────────────────────────────────────────────
  {
    const decision = await hybrid.entry.decide({
      aggregator, algorithmOutputs, masterDecision, settings, session, openTradesCount, futuresData,
      tradesToday, lossesToday,
    });
    logger.info({
      sessionId: String(session?._id || ''),
      signal: decision.signal,
      tradeType: decision.trade_type,
      score: decision.hybridSnapshot?.score,
      grade: decision.hybridSnapshot?.grade,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    }, '[entryEngine] hybrid decision');
    return decision;
  }

  // ─── LEGACY AI PATH ────────────────────────────────────────────────────────
  const maxConcurrent = settings?.maxConcurrentTrades || 1;
  if (openTradesCount >= maxConcurrent) {
    return { signal: 'NO_TRADE', reasoning: `At max concurrent trades (${openTradesCount}/${maxConcurrent})`, trade_type: 'NONE', confidence: 0 };
  }

  const masterScore = masterDecision?.master_score || 0;
  const masterMinScore = settings?.masterMinScore || 58; // Use settings value (58) for more entries
  if (masterScore < masterMinScore) {
    return { signal: 'NO_TRADE', reasoning: `Master score ${masterScore} < floor ${masterMinScore}`, trade_type: 'NONE', confidence: 0 };
  }
  
  // NEW: Professional Scalping Indicators Validation (RELAXED for more entries)
  const professionalScalping = algorithmOutputs?.professionalScalping;
  if (professionalScalping && professionalScalping.signal && professionalScalping.confidence) {
    // Check if signal is strong enough (RELAXED: accept buy/sell signals too)
    const isValidSignal = ['strong_buy', 'buy', 'strong_sell', 'sell'].includes(professionalScalping.signal);
    const hasGoodConfidence = professionalScalping.confidence >= 60; // Reduced from 75
    const hasReasonableTrend = !professionalScalping.adx || professionalScalping.adx.value >= 20; // Reduced from 25
    const hasAcceptableVolatility = !professionalScalping.atr || professionalScalping.atr.state !== 'very_low'; // Only block very_low
    
    if (!isValidSignal) {
      return { 
        signal: 'NO_TRADE', 
        reasoning: `Professional scalping signal not valid: ${professionalScalping.signal}. Need buy/sell signal.`, 
        trade_type: 'NONE', 
        confidence: 0 
      };
    }
    
    if (!hasGoodConfidence) {
      return { 
        signal: 'NO_TRADE', 
        reasoning: `Professional scalping confidence too low: ${professionalScalping.confidence}%. Need >= 60%.`, 
        trade_type: 'NONE', 
        confidence: 0 
      };
    }
    
    if (!hasReasonableTrend) {
      return { 
        signal: 'NO_TRADE', 
        reasoning: `ADX shows very weak trend: ${professionalScalping.adx?.value}. Need ADX >= 20.`, 
        trade_type: 'NONE', 
        confidence: 0 
      };
    }
    
    if (!hasAcceptableVolatility) {
      return { 
        signal: 'NO_TRADE', 
        reasoning: `ATR very low (dead market): ${professionalScalping.atr?.value}. Avoid trading.`, 
        trade_type: 'NONE', 
        confidence: 0 
      };
    }
    
    logger.info({
      professionalScalpingSignal: professionalScalping.signal,
      confidence: professionalScalping.confidence,
      adx: professionalScalping.adx?.value,
      atr: professionalScalping.atr?.value
    }, '[entryEngine] Professional scalping validation PASSED');
  } else {
    // If professional scalping data is null/missing, log warning but don't block
    logger.warn('[entryEngine] Professional scalping data is null or incomplete - skipping validation');
  }
  
  // NEW: Multi-Timeframe Validation (RELAXED for scalping - 60% threshold)
  const multiTimeframe = algorithmOutputs?.multiTimeframe;
  if (multiTimeframe) {
    const alignmentScore = multiTimeframe.alignment_score || 0;
    const higherTFBias = multiTimeframe.higher_tf_bias || 'neutral';
    const allAligned = multiTimeframe.all_timeframes_aligned || false;
    
    // RELAXED: 60% alignment is acceptable for scalping (was 80%)
    if (alignmentScore < 60) {
      return { 
        signal: 'NO_TRADE', 
        reasoning: `Multi-timeframe alignment too low: ${alignmentScore}/100. Need >= 60 for scalping.`, 
        trade_type: 'NONE', 
        confidence: 0 
      };
    }
    
    // RELAXED: Accept any directional bias except neutral (was requiring strongly_bullish/bearish)
    if (higherTFBias === 'neutral') {
      logger.warn({
        alignmentScore,
        higherTFBias,
      }, '[entryEngine] Higher timeframe is neutral - proceeding with caution');
    }
    
    logger.info({
      alignmentScore,
      higherTFBias,
      allAligned
    }, '[entryEngine] Multi-timeframe validation PASSED');
  }

  const payload = await buildEntryPayload({ aggregator, algorithmOutputs, masterDecision, settings, session, openTradesCount, futuresData });

  // ============================================================
  // ATR GATE - Check if target is achievable (60% confidence minimum)
  // ============================================================
  if (settings?.enableATRConfirmation && payload.atr_analysis) {
    const atrConfirms = atrService.atrConfirmsEntry(payload.atr_analysis);
    
    if (!atrConfirms) {
      const atrConf = payload.atr_analysis.target_achievability.confidence;
      const atrReason = payload.atr_analysis.target_achievability.reasoning;
      
      logger.warn({
        sessionId: payload.meta.sessionId,
        atrConfidence: atrConf,
        atrReason,
        targetPoints: settings.targetPoints,
        atr: payload.atr_analysis.primary_atr,
      }, '[entryEngine] ATR gate blocked entry - target not achievable');
      
      return {
        signal: 'NO_TRADE',
        reasoning: `ATR validation failed (${atrConf}% confidence): ${atrReason}`,
        trade_type: 'NONE',
        confidence: 0,
        atr_blocked: true,
      };
    }
    
    logger.info({
      sessionId: payload.meta.sessionId,
      atrConfidence: payload.atr_analysis.target_achievability.confidence,
      atr: payload.atr_analysis.primary_atr,
      targetPoints: settings.targetPoints,
    }, '[entryEngine] ATR gate passed - target is achievable');
  }

  logger.info({
    sessionId: payload.meta.sessionId,
    focusStrikes: payload.meta.focusStrikes,
    masterScore,
    priorDaysLoaded: payload.prior_days.length,
    todayCandles: payload.today_intraday?.sessionStats?.candleCounts,
    futuresAvailable: !!futuresData,
    atrEnabled: !!settings?.enableATRConfirmation,
    atrConfidence: payload.atr_analysis?.target_achievability?.confidence || null,
  }, '[entryEngine] Building AI decision');

  let raw;
  try {
    raw = await openai.callOpenAICustom({
      systemPrompt: ENTRY_SYSTEM_PROMPT,
      userPayload: payload,
      model: session?.aiModel || 'gpt-4o-mini',
      temperature: 0.2,
      responseFormat: 'json',
      purpose: 'entry_decision',
    });
  } catch (e) {
    logger.error({ err: e.message }, '[entryEngine] OpenAI call failed');
    return { signal: 'NO_TRADE', reasoning: `AI call failed: ${e.message}`, trade_type: 'NONE', confidence: 0 };
  }

  try { 
    aiIOLogger.logAICall?.({ 
      purpose: 'entry_decision',
      model: session?.aiModel || 'gpt-4o-mini',
      systemPrompt: ENTRY_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(payload),
      responseText: typeof raw === 'string' ? raw : JSON.stringify(raw),
      parsedResponse: raw,
      sessionId: String(session?._id || ''),
    }); 
  } catch (_) {}

  const decision = normaliseDecision(raw, settings);

  // Hard gates after AI
  if (decision.signal === 'NO_TRADE') return decision;
  if (!decision.min_target_achievable) {
    return { ...decision, signal: 'NO_TRADE', trade_type: 'NONE',
      reasoning: `AI says min target not achievable: ${decision.reasoning}` };
  }
  if ((decision.confidence || 0) < (settings?.minConfidence || 6)) {
    return { ...decision, signal: 'NO_TRADE', trade_type: 'NONE',
      reasoning: `Confidence ${decision.confidence} below floor ${settings?.minConfidence}: ${decision.reasoning}` };
  }
  if (decision.trade_type === 'SWING' && settings?.enableSwing === false) {
    return { ...decision, signal: 'NO_TRADE', trade_type: 'NONE',
      reasoning: `SWING disabled by settings, AI wanted SWING: ${decision.reasoning}` };
  }

  return decision;
}

function normaliseDecision(raw, settings) {
  const d = typeof raw === 'string' ? safeParse(raw) : (raw || {});
  const out = {
    signal: ['BUY_CE', 'BUY_PE', 'NO_TRADE'].includes(d.signal) ? d.signal : 'NO_TRADE',
    trade_type: ['SCALP', 'SWING', 'NONE'].includes(d.trade_type) ? d.trade_type : 'NONE',
    strike: Number(d.strike) || 0,
    option_type: ['CE', 'PE', 'NONE'].includes(d.option_type) ? d.option_type : 'NONE',
    entry_premium_estimate: Number(d.entry_premium_estimate) || 0,
    expected_points: Number(d.expected_points) || 0,
    min_target_achievable: !!d.min_target_achievable,
    confidence: clampInt(d.confidence, 0, 10),
    risks: Array.isArray(d.risks) ? d.risks.slice(0, 5) : [],
    reasoning: String(d.reasoning || '').slice(0, 500),
    lots_suggested: clampInt(d.lots_suggested, settings?.minLots || 1, settings?.maxLots || 3),
    sl_points: clampInt(d.sl_points, 2, 50) || settings?.slPoints || 10,
    target_points: clampInt(d.target_points, 1, 200) || settings?.targetPoints || 5,
    max_hold_seconds: clampInt(d.max_hold_seconds, 15, 900) || 120,
  };
  // Infer option_type from signal if missing
  if (out.option_type === 'NONE' && out.signal === 'BUY_CE') out.option_type = 'CE';
  if (out.option_type === 'NONE' && out.signal === 'BUY_PE') out.option_type = 'PE';
  return out;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function safeParse(txt) {
  try { return JSON.parse(txt); }
  catch (_) {
    // Try to pull the first JSON object from the text
    const m = String(txt).match(/\{[\s\S]*\}/);
    if (!m) return {};
    try { return JSON.parse(m[0]); } catch (_) { return {}; }
  }
}

module.exports = {
  decide,
  buildEntryPayload,
};
