/**
 * Strike Selector Service - AI-powered strike selection
 * Analyzes multiple strikes and uses AI to select the optimal one
 */
const dhanBypass = require('./dhanProd.service');
const logger = require('../utils/logger');
const axios = require('axios');
const symbolRegistry = require('../config/symbolRegistry');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Active-symbol metadata helper. */
function _active() {
  return symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
}
function _activeApiTriplet() {
  return { exchange: 'IDX', segment: 'I', instrument: 'IDX' };
}

const STRIKE_SELECTION_PROMPT = `You are an expert options trader specializing in NIFTY 50 intraday scalping.

Your task is to analyze multiple strike prices and select the BEST strike for entry based on:
1. Premium value (not too cheap, not too expensive)
2. Liquidity (volume and open interest)
3. Implied Volatility (optimal IV levels)
4. Greeks (Delta, Theta, Vega)
5. Risk-reward ratio
6. Market conditions and trend
7. Historical performance patterns

CRITICAL RULES:
1. For BULLISH signals → Select best CALL strike
2. For BEARISH signals → Select best PUT strike
3. Prefer strikes with:
   - Good liquidity (high OI and volume)
   - Reasonable premium (₹50-150 for scalping)
   - Delta between 0.3-0.7 for directional trades
   - Lower Theta decay for short-term holds
4. Avoid strikes with:
   - Very low OI (< 10,000)
   - Extremely high or low IV
   - Premium < ₹30 (too risky) or > ₹200 (too expensive)

Return ONLY valid JSON:
{
  "selected_strike": number,
  "option_type": "CE" | "PE",
  "confidence": 0-10,
  "expected_premium": number,
  "rationale": "detailed explanation (max 300 chars)",
  "risk_factors": "key risks (max 200 chars)",
  "alternative_strike": number (backup option),
  "hold_duration_estimate": "15-30sec" | "30-60sec" | "1-2min" | "2-5min"
}`;

/**
 * Fetch comprehensive strike data including historical performance
 * @param {string} authKey - Dhan bypass auth key
 * @param {number} spotPrice - Current NIFTY spot price
 * @param {number} atmStrike - ATM strike
 * @param {string} expiry - Expiry identifier
 * @param {string} direction - "bullish" or "bearish"
 */
async function fetchMultiStrikeData(authKey, spotPrice, atmStrike, expiry, direction) {
  try {
    // Generate strikes: ATM ± 3 strikes — step depends on active symbol
    const active = _active();
    const step = active.strikeStep || 50;
    const strikes = [];
    for (let i = -3; i <= 3; i++) {
      strikes.push(atmStrike + (i * step));
    }

    logger.info({ 
      atmStrike, 
      strikes, 
      direction,
      spotPrice 
    }, '[strikeSelector] Fetching multi-strike data');

    // Fetch option chain for all strikes
    const optionChainRes = await dhanBypass.getOptionChainBypass(authKey, {
      segment: 0,
      expiry: expiry,
      securityId: active.indexSecurityId,
      underlyingSeg: active.indexSegment,
    });

    if (!optionChainRes.ok) {
      throw new Error('Failed to fetch option chain');
    }

    const optionChain = optionChainRes.data;
    
    // Extract data for our target strikes
    const strikeData = strikes.map(strike => {
      const strikeRow = optionChain.strikes?.find(s => s.strike === strike);
      if (!strikeRow) return null;

      const optionData = direction === 'bullish' ? strikeRow.call : strikeRow.put;
      const optionType = direction === 'bullish' ? 'CE' : 'PE';

      return {
        strike,
        option_type: optionType,
        symbol: optionData.displaySymbol,
        ltp: optionData.ltp,
        open_interest: optionData.oi,
        oi_change: optionData.oiChange || 0,
        volume: optionData.volume || 0,
        iv: optionData.iv,
        greeks: {
          delta: optionData.greeks?.delta,
          gamma: optionData.greeks?.gamma,
          theta: optionData.greeks?.theta,
          vega: optionData.greeks?.vega,
        },
        bid: optionData.bid,
        ask: optionData.ask,
        spread: optionData.ask && optionData.bid ? optionData.ask - optionData.bid : null,
        distance_from_spot: strike - spotPrice,
        moneyness: strike === atmStrike ? 'ATM' : 
                   (direction === 'bullish' ? 
                     (strike < spotPrice ? 'ITM' : 'OTM') : 
                     (strike > spotPrice ? 'ITM' : 'OTM')),
      };
    }).filter(Boolean);

    // Fetch 1-week historical data for pattern analysis
    const now = Math.floor(Date.now() / 1000);
    const oneWeekAgo = now - (7 * 24 * 60 * 60);
    const triplet = _activeApiTriplet();

    const historicalRes = await dhanBypass.getDhanBypassData(authKey, {
      securityId: active.indexSecurityId,
      exchange: triplet.exchange,
      segment: triplet.segment,
      instrument: triplet.instrument,
      startTime: oneWeekAgo,
      endTime: now,
      interval: '5', // 5-minute candles for 1 week
    });

    let historicalAnalysis = null;
    if (historicalRes.ok && historicalRes.data.candles) {
      const candles = historicalRes.data.candles;
      const closes = candles.map(c => c.close);
      const volumes = candles.map(c => c.volume || 0);
      
      // Calculate volatility
      const returns = [];
      for (let i = 1; i < closes.length; i++) {
        returns.push((closes[i] - closes[i-1]) / closes[i-1]);
      }
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
      const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100; // Annualized

      historicalAnalysis = {
        period: '1_week',
        candle_count: candles.length,
        week_high: Math.max(...candles.map(c => c.high)),
        week_low: Math.min(...candles.map(c => c.low)),
        week_range: Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low)),
        avg_volume: volumes.reduce((a, b) => a + b, 0) / volumes.length,
        volatility_pct: Number(volatility.toFixed(2)),
        trend: closes[closes.length - 1] > closes[0] ? 'bullish' : 'bearish',
        price_change_pct: ((closes[closes.length - 1] - closes[0]) / closes[0] * 100).toFixed(2),
      };
    }

    logger.info({ 
      strikeDataCount: strikeData.length,
      hasHistorical: !!historicalAnalysis 
    }, '[strikeSelector] Multi-strike data fetched successfully');

    return {
      strikes: strikeData,
      historical: historicalAnalysis,
      spot_price: spotPrice,
      atm_strike: atmStrike,
      direction,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error({ 
      error: error.message, 
      stack: error.stack 
    }, '[strikeSelector] Failed to fetch multi-strike data');
    throw error;
  }
}

/**
 * Use AI to select the best strike from multiple options
 * @param {Object} multiStrikeData - Comprehensive strike data
 * @param {Object} marketContext - Current market conditions
 * @param {string} aiModel - OpenAI model to use
 */
async function selectBestStrike(multiStrikeData, marketContext, aiModel = 'gpt-4o-mini') {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    logger.warn('[strikeSelector] No OpenAI API key, using ATM strike as fallback');
    const atmStrikeData = multiStrikeData.strikes.find(s => s.moneyness === 'ATM');
    return {
      selected_strike: atmStrikeData.strike,
      option_type: atmStrikeData.option_type,
      confidence: 5,
      expected_premium: atmStrikeData.ltp,
      rationale: 'Fallback to ATM strike (no AI available)',
      risk_factors: 'No AI analysis performed',
      alternative_strike: atmStrikeData.strike,
      hold_duration_estimate: '1-2min',
    };
  }

  const userPrompt = `Analyze these ${multiStrikeData.strikes.length} strike options and select the BEST one for a ${multiStrikeData.direction.toUpperCase()} scalping trade.

MARKET CONTEXT:
${JSON.stringify(marketContext, null, 2)}

AVAILABLE STRIKES:
${JSON.stringify(multiStrikeData.strikes, null, 2)}

HISTORICAL ANALYSIS (1 Week):
${JSON.stringify(multiStrikeData.historical, null, 2)}

CURRENT CONDITIONS:
- Spot Price: ${multiStrikeData.spot_price}
- ATM Strike: ${multiStrikeData.atm_strike}
- Direction: ${multiStrikeData.direction}
- Timestamp: ${multiStrikeData.timestamp}

Select the strike that offers:
1. Best risk-reward for scalping (15-60 second holds)
2. Sufficient liquidity for quick entry/exit
3. Optimal premium range (₹50-150)
4. Good Greeks profile for the direction

Consider the 1-week historical data to understand typical volatility and price movements.`;

  console.log('\n' + '='.repeat(80));
  console.log('🎯 STRIKE SELECTION - SENDING TO AI');
  console.log('='.repeat(80));
  console.log('Direction:', multiStrikeData.direction);
  console.log('Spot Price:', multiStrikeData.spot_price);
  console.log('ATM Strike:', multiStrikeData.atm_strike);
  console.log('Strikes Analyzed:', multiStrikeData.strikes.length);
  console.log('\nSTRIKE OPTIONS:');
  multiStrikeData.strikes.forEach(s => {
    console.log(`  ${s.strike} ${s.option_type}: LTP=₹${s.ltp}, OI=${s.open_interest}, IV=${s.iv}%, Delta=${s.greeks.delta}, ${s.moneyness}`);
  });
  console.log('\nHISTORICAL (1 Week):');
  if (multiStrikeData.historical) {
    console.log(`  Range: ${multiStrikeData.historical.week_low} - ${multiStrikeData.historical.week_high}`);
    console.log(`  Volatility: ${multiStrikeData.historical.volatility_pct}%`);
    console.log(`  Trend: ${multiStrikeData.historical.trend}`);
  }
  console.log('='.repeat(80) + '\n');

  try {
    const { data } = await axios.post(
      OPENAI_URL,
      {
        model: aiModel,
        messages: [
          { role: 'system', content: STRIKE_SELECTION_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty AI response');
    const decision = JSON.parse(text);

    console.log('\n' + '='.repeat(80));
    console.log('✅ STRIKE SELECTED BY AI');
    console.log('='.repeat(80));
    console.log('Selected Strike:', decision.selected_strike, decision.option_type);
    console.log('Confidence:', decision.confidence);
    console.log('Expected Premium: ₹', decision.expected_premium);
    console.log('Hold Duration:', decision.hold_duration_estimate);
    console.log('Rationale:', decision.rationale);
    console.log('Risk Factors:', decision.risk_factors);
    console.log('Alternative:', decision.alternative_strike);
    console.log('='.repeat(80) + '\n');

    return decision;
  } catch (error) {
    logger.error({ 
      error: error.message, 
      response: error.response?.data 
    }, '[strikeSelector] AI strike selection failed');
    
    // Fallback to ATM
    const atmStrikeData = multiStrikeData.strikes.find(s => s.moneyness === 'ATM');
    return {
      selected_strike: atmStrikeData.strike,
      option_type: atmStrikeData.option_type,
      confidence: 5,
      expected_premium: atmStrikeData.ltp,
      rationale: 'AI failed, using ATM strike',
      risk_factors: error.message,
      alternative_strike: atmStrikeData.strike,
      hold_duration_estimate: '1-2min',
    };
  }
}

module.exports = {
  fetchMultiStrikeData,
  selectBestStrike,
};
