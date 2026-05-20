/**
 * Professional Trader Service - 20 Years Experience Logic
 * 
 * Core Philosophy:
 * 1. Market opening strike is the anchor
 * 2. Only trade ±2 strikes from opening
 * 3. Understand market structure before entry
 * 4. Risk management is paramount
 * 5. Exit strategy defined before entry
 */
const dhanBypass = require('./dhanProd.service');
const logger = require('../utils/logger');
const aiIOLogger = require('../utils/aiIOLogger');
const axios = require('axios');
const symbolRegistry = require('../config/symbolRegistry');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Active-symbol metadata helper. */
function _active() {
  return symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
}
/** Active symbol's index API triplet — all index spots use IDX_I in Dhan. */
function _activeApiTriplet() {
  return { exchange: 'IDX', segment: 'I', instrument: 'IDX' };
}

// Store market opening data
const marketSession = {
  openingStrike: null,
  openingPrice: null,
  openingTime: null,
  dayHigh: null,
  dayLow: null,
  marketCharacter: null, // 'trending', 'ranging', 'volatile', 'quiet'
  dominantDirection: null, // 'bullish', 'bearish', 'neutral'
  keyLevels: {
    resistance: [],
    support: [],
  },
};

const PROFESSIONAL_ANALYSIS_PROMPT = `You are a 20-year veteran NIFTY options trader with institutional experience.

CORE TRADING PRINCIPLES:
1. Market opening strike is your anchor - respect it
2. Only trade ±2 strikes from opening (prevents overtrading)
3. Understand the day's character before trading
4. Risk management is paramount - never risk more than defined
5. Exit strategy must be clear before entry
6. Quality over quantity - wait for high-probability setups

MARKET CHARACTER ANALYSIS:
- TRENDING: Clear direction, follow the trend
- RANGING: Oscillating between levels, fade extremes
- VOLATILE: Wide swings, reduce size, wider stops
- QUIET: Low volume, avoid or very selective

ENTRY CRITERIA (ALL must be met):
1. Strike within ±2 of opening strike
2. Clear market structure (support/resistance)
3. Volume confirmation
4. Risk-reward minimum 1:2
5. Defined stop-loss level
6. Clear exit target

EXIT STRATEGY:
1. Target hit (take profit)
2. Stop-loss hit (cut loss)
3. Market character change (exit immediately)
4. Time-based (scalping: 1-3 min max)
5. Reversal pattern (exit before loss)

Return ONLY valid JSON:
{
  "market_character": "trending" | "ranging" | "volatile" | "quiet",
  "dominant_direction": "bullish" | "bearish" | "neutral",
  "trade_decision": "ENTER_LONG" | "ENTER_SHORT" | "WAIT" | "EXIT",
  "selected_strike": number (must be opening ±2 strikes),
  "option_type": "CE" | "PE",
  "entry_rationale": "why this trade (max 200 chars)",
  "stop_loss_level": number (price level, not percentage),
  "target_level": number (price level),
  "risk_reward_ratio": number,
  "confidence": 0-10,
  "max_hold_time_seconds": number (60-180 for scalping),
  "key_risks": "main risks (max 150 chars)",
  "exit_conditions": ["condition1", "condition2", "condition3"]
}`;

/**
 * Initialize market session at market open
 */
async function initializeMarketSession(authKey) {
  try {
    logger.info('[professionalTrader] Initializing market session');
    
    // Fetch opening candle (first 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    const marketOpenTime = getMarketOpenTime(); // 9:15 AM
    
    const active = _active();
    const triplet = _activeApiTriplet();
    const res = await dhanBypass.getDhanBypassData(authKey, {
      securityId: active.indexSecurityId,
      exchange: triplet.exchange,
      segment: triplet.segment,
      instrument: triplet.instrument,
      startTime: marketOpenTime,
      endTime: marketOpenTime + 300, // First 5 minutes
      interval: '1',
    });
    
    if (!res.ok || !res.data.candles || res.data.candles.length === 0) {
      throw new Error('Failed to fetch opening candle');
    }
    
    const openingCandle = res.data.candles[0];
    const openingPrice = openingCandle.open;
    
    // Calculate opening strike (rounded to the symbol's strike step:
    // NIFTY=50, SENSEX=100).
    const stepOpen = active.strikeStep || 50;
    const openingStrike = Math.round(openingPrice / stepOpen) * stepOpen;
    
    marketSession.openingStrike = openingStrike;
    marketSession.openingPrice = openingPrice;
    marketSession.openingTime = new Date(marketOpenTime * 1000);
    marketSession.dayHigh = openingCandle.high;
    marketSession.dayLow = openingCandle.low;
    
    logger.info({
      openingStrike,
      openingPrice,
      openingTime: marketSession.openingTime,
    }, '[professionalTrader] Market session initialized');
    
    // Analyze initial market character
    await analyzeMarketCharacter(authKey);
    
    return marketSession;
  } catch (error) {
    logger.error({ error: error.message }, '[professionalTrader] Failed to initialize market session');
    throw error;
  }
}

/**
 * Get market open time (9:15 AM IST)
 */
function getMarketOpenTime() {
  const now = new Date();
  const marketOpen = new Date(now);
  marketOpen.setHours(9, 15, 0, 0);
  return Math.floor(marketOpen.getTime() / 1000);
}

/**
 * Analyze market character and structure
 */
async function analyzeMarketCharacter(authKey) {
  try {
    // Fetch last 30 minutes of data
    const now = Math.floor(Date.now() / 1000);
    const thirtyMinAgo = now - 1800;
    
    const triplet = _activeApiTriplet();
    const active = _active();
    const res = await dhanBypass.getDhanBypassData(authKey, {
      securityId: active.indexSecurityId,
      exchange: triplet.exchange,
      segment: triplet.segment,
      instrument: triplet.instrument,
      startTime: thirtyMinAgo,
      endTime: now,
      interval: '1',
    });
    
    if (!res.ok || !res.data.candles) {
      return;
    }
    
    const candles = res.data.candles;
    if (candles.length < 10) return;
    
    // Calculate key metrics
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume || 0);
    
    const currentPrice = closes[closes.length - 1];
    const priceRange = Math.max(...highs) - Math.min(...lows);
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const recentVolume = volumes[volumes.length - 1];
    
    // Update day high/low
    marketSession.dayHigh = Math.max(marketSession.dayHigh, ...highs);
    marketSession.dayLow = Math.min(marketSession.dayLow, ...lows);
    
    // Determine market character
    const volatility = priceRange / currentPrice * 100;
    const volumeRatio = recentVolume / avgVolume;
    
    // Trending: consistent direction
    const upMoves = closes.filter((c, i) => i > 0 && c > closes[i - 1]).length;
    const downMoves = closes.filter((c, i) => i > 0 && c < closes[i - 1]).length;
    const trendStrength = Math.abs(upMoves - downMoves) / closes.length;
    
    if (trendStrength > 0.6 && volumeRatio > 1.2) {
      marketSession.marketCharacter = 'trending';
      marketSession.dominantDirection = upMoves > downMoves ? 'bullish' : 'bearish';
    } else if (volatility > 1.5 && volumeRatio > 1.5) {
      marketSession.marketCharacter = 'volatile';
      marketSession.dominantDirection = 'neutral';
    } else if (volatility < 0.5 && volumeRatio < 0.8) {
      marketSession.marketCharacter = 'quiet';
      marketSession.dominantDirection = 'neutral';
    } else {
      marketSession.marketCharacter = 'ranging';
      marketSession.dominantDirection = currentPrice > marketSession.openingPrice ? 'bullish' : 'bearish';
    }
    
    // Identify key levels (support/resistance)
    const pivotPoints = identifyPivotPoints(candles);
    marketSession.keyLevels.resistance = pivotPoints.resistance;
    marketSession.keyLevels.support = pivotPoints.support;
    
    logger.info({
      marketCharacter: marketSession.marketCharacter,
      dominantDirection: marketSession.dominantDirection,
      volatility: volatility.toFixed(2),
      trendStrength: trendStrength.toFixed(2),
      support: marketSession.keyLevels.support,
      resistance: marketSession.keyLevels.resistance,
    }, '[professionalTrader] Market character analyzed');
    
  } catch (error) {
    logger.error({ error: error.message }, '[professionalTrader] Failed to analyze market character');
  }
}

/**
 * Identify pivot points (support/resistance) — strikes rounded to the
 * active symbol's strike step (NIFTY=50, SENSEX=100).
 */
function identifyPivotPoints(candles) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const step = _active().strikeStep || 50;
  
  const resistance = [];
  const support = [];
  
  // Find local highs (resistance)
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      resistance.push(Math.round(highs[i] / step) * step); // Round to nearest strike step
    }
  }
  
  // Find local lows (support)
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      support.push(Math.round(lows[i] / step) * step); // Round to nearest strike step
    }
  }
  
  // Remove duplicates and sort
  return {
    resistance: [...new Set(resistance)].sort((a, b) => b - a).slice(0, 3),
    support: [...new Set(support)].sort((a, b) => a - b).slice(0, 3),
  };
}

/**
 * Get valid strikes (opening ±2 strikes only) — step depends on active
 * symbol (NIFTY=50, SENSEX=100).
 */
function getValidStrikes() {
  if (!marketSession.openingStrike) {
    throw new Error('Market session not initialized');
  }
  
  const step = _active().strikeStep || 50;
  const strikes = [];
  for (let i = -2; i <= 2; i++) {
    strikes.push(marketSession.openingStrike + (i * step));
  }
  
  return strikes;
}

/**
 * Professional trade analysis with AI
 */
async function analyzeTrade(authKey, currentMarketData, aiModel = 'gpt-4o-mini') {
  const apiKey = process.env.OPENAI_API_KEY;
  
  try {
    // Ensure market session is initialized
    if (!marketSession.openingStrike) {
      await initializeMarketSession(authKey);
    }
    
    // Update market character
    await analyzeMarketCharacter(authKey);
    
    // Get valid strikes (opening ±2 only)
    const validStrikes = getValidStrikes();
    
    // Fetch option chain for valid strikes only
    const expiries = await getExpiries(authKey);
    const nearestExpiry = expiries[0];
    
    const active = _active();
    const optionChainRes = await dhanBypass.getOptionChainBypass(authKey, {
      segment: 0,
      expiry: nearestExpiry.exp,
      securityId: active.indexSecurityId,
      underlyingSeg: active.indexSegment,
    });
    
    if (!optionChainRes.ok) {
      throw new Error('Failed to fetch option chain');
    }
    
    const optionChain = optionChainRes.data;
    
    // Filter only valid strikes
    const validStrikeData = validStrikes.map(strike => {
      const strikeRow = optionChain.strikes?.find(s => s.strike === strike);
      if (!strikeRow) return null;
      
      return {
        strike,
        call: {
          ltp: strikeRow.call.ltp,
          oi: strikeRow.call.oi,
          volume: strikeRow.call.volume || 0,
          iv: strikeRow.call.iv,
          delta: strikeRow.call.greeks?.delta,
        },
        put: {
          ltp: strikeRow.put.ltp,
          oi: strikeRow.put.oi,
          volume: strikeRow.put.volume || 0,
          iv: strikeRow.put.iv,
          delta: strikeRow.put.greeks?.delta,
        },
      };
    }).filter(Boolean);
    
    // Build comprehensive analysis payload
    const analysisPayload = {
      market_session: {
        opening_strike: marketSession.openingStrike,
        opening_price: marketSession.openingPrice,
        opening_time: marketSession.openingTime,
        current_price: currentMarketData.spot_data?.ltp,
        day_high: marketSession.dayHigh,
        day_low: marketSession.dayLow,
        market_character: marketSession.marketCharacter,
        dominant_direction: marketSession.dominantDirection,
        key_levels: marketSession.keyLevels,
      },
      valid_strikes: validStrikeData,
      current_market: {
        vwap: currentMarketData.vwap_analysis?.vwap,
        vwap_position: currentMarketData.vwap_analysis?.price_vs_vwap,
        ema_alignment: currentMarketData.moving_averages?.ema_alignment,
        volume_spike: currentMarketData.volume_orderflow?.volume_spike,
        build_up_type: currentMarketData.futures_data?.build_up_type,
        pcr: currentMarketData.options_chain?.pcr_total,
      },
      risk_parameters: {
        max_risk_per_trade: 1, // 1% of capital
        min_risk_reward: 2, // Minimum 1:2
        max_hold_time: 180, // 3 minutes max for scalping
      },
    };
    
    if (!apiKey) {
      logger.warn('[professionalTrader] No OpenAI API key, using rule-based analysis');
      return ruleBasedAnalysis(analysisPayload);
    }
    
    const userPrompt = `As a 20-year veteran trader, analyze this setup and make a decision.

MARKET SESSION:
${JSON.stringify(analysisPayload.market_session, null, 2)}

VALID STRIKES (Opening ±2 ONLY):
${JSON.stringify(analysisPayload.valid_strikes, null, 2)}

CURRENT MARKET CONDITIONS:
${JSON.stringify(analysisPayload.current_market, null, 2)}

RISK PARAMETERS:
${JSON.stringify(analysisPayload.risk_parameters, null, 2)}

CRITICAL QUESTIONS:
1. What is the market character today? (trending/ranging/volatile/quiet)
2. Is there a clear directional bias?
3. Which strike (from opening ±2) offers best risk-reward?
4. Where is the stop-loss level (price, not %)?
5. Where is the target level?
6. What is the risk-reward ratio?
7. What are the exit conditions?
8. Should we enter or wait?

Remember: Quality over quantity. Only trade high-probability setups.`;

    console.log('\n' + '='.repeat(80));
    console.log('🎯 PROFESSIONAL TRADE ANALYSIS');
    console.log('='.repeat(80));
    console.log('Opening Strike:', marketSession.openingStrike);
    console.log('Valid Strikes:', validStrikes.join(', '));
    console.log('Market Character:', marketSession.marketCharacter);
    console.log('Direction:', marketSession.dominantDirection);
    console.log('Current Price:', currentMarketData.spot_data?.ltp);
    console.log('Support:', marketSession.keyLevels.support.join(', '));
    console.log('Resistance:', marketSession.keyLevels.resistance.join(', '));
    console.log('='.repeat(80) + '\n');
    
    const started = Date.now();
    const { data } = await axios.post(
      OPENAI_URL,
      {
        model: aiModel,
        messages: [
          { role: 'system', content: PROFESSIONAL_ANALYSIS_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    const latencyMs = Date.now() - started;
    
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      aiIOLogger.logAICall({
        purpose: 'professional_trader_analysis',
        model: aiModel,
        systemPrompt: PROFESSIONAL_ANALYSIS_PROMPT,
        userPrompt,
        responseText: null,
        parsedResponse: null,
        usage: data?.usage || null,
        latencyMs,
        error: 'Empty AI response',
      });
      throw new Error('Empty AI response');
    }
    const decision = JSON.parse(text);

    aiIOLogger.logAICall({
      purpose: 'professional_trader_analysis',
      model: aiModel,
      systemPrompt: PROFESSIONAL_ANALYSIS_PROMPT,
      userPrompt,
      responseText: text,
      parsedResponse: decision,
      usage: data?.usage || null,
      latencyMs,
    });
    
    // Validate strike is within opening ±2
    if (!validStrikes.includes(decision.selected_strike)) {
      logger.warn({ 
        selectedStrike: decision.selected_strike, 
        validStrikes 
      }, '[professionalTrader] AI selected invalid strike, forcing to opening strike');
      decision.selected_strike = marketSession.openingStrike;
    }

    // Ensure option_type is not null (default to CE if missing)
    if (!decision.option_type) {
      decision.option_type = decision.dominant_direction === 'bearish' ? 'PE' : 'CE';
    }
    
    logger.info({
      marketCharacter: decision.market_character,
      direction: decision.dominant_direction,
      tradeDecision: decision.trade_decision,
      strike: decision.selected_strike,
      optionType: decision.option_type,
      stopLoss: decision.stop_loss_level,
      target: decision.target_level,
      riskReward: decision.risk_reward_ratio,
      maxHold: decision.max_hold_time_seconds,
      confidence: decision.confidence,
    }, '[professionalTrader] Professional decision made');
    
    return decision;
  } catch (error) {
    logger.error({ 
      error: error.message, 
      response: error.response?.data 
    }, '[professionalTrader] Analysis failed');
    throw error;
  }
}

/**
 * Rule-based analysis fallback
 */
function ruleBasedAnalysis(payload) {
  const { market_session, valid_strikes, current_market } = payload;
  
  // Simple rules
  let trade_decision = 'WAIT';
  let selected_strike = market_session.opening_strike;
  let option_type = 'CE';
  
  if (market_session.market_character === 'trending' && 
      market_session.dominant_direction === 'bullish') {
    trade_decision = 'ENTER_LONG';
    option_type = 'CE';
    selected_strike = market_session.opening_strike; // Use opening strike
  } else if (market_session.market_character === 'trending' && 
             market_session.dominant_direction === 'bearish') {
    trade_decision = 'ENTER_SHORT';
    option_type = 'PE';
    selected_strike = market_session.opening_strike;
  }
  
  return {
    market_character: market_session.market_character,
    dominant_direction: market_session.dominant_direction,
    trade_decision,
    selected_strike,
    option_type,
    entry_rationale: 'Rule-based decision (no AI)',
    stop_loss_level: selected_strike - 50, // Simple SL
    target_level: selected_strike + 100, // Simple target
    risk_reward_ratio: 2,
    confidence: 5,
    max_hold_time_seconds: 120,
    key_risks: 'Rule-based logic, no AI analysis',
    exit_conditions: ['SL hit', 'Target hit', 'Time-based'],
  };
}

/**
 * Get expiries
 */
async function getExpiries(authKey) {
  const res = await dhanBypass.getExpiryListBypass(authKey, {});
  if (res.ok) return res.data.expiries || [];
  return [];
}

/**
 * Get market session info
 */
function getMarketSession() {
  return marketSession;
}

module.exports = {
  initializeMarketSession,
  analyzeMarketCharacter,
  analyzeTrade,
  getValidStrikes,
  getMarketSession,
};
