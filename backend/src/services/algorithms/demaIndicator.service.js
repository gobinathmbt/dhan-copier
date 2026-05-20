/**
 * DEMA (Double Exponential Moving Average) Indicator
 * Used by: Professional traders, Momentum traders, Trend followers
 * 
 * DEMA is faster and more responsive than traditional EMA
 * Formula: DEMA = 2 * EMA - EMA(EMA)
 * 
 * Settings: 15-minute candles, 20-period DEMA
 * 
 * CRITICAL FOR MOMENTUM AND TREND CONFIRMATION
 */
const logger = require('../../utils/logger');
const dhanBypass = require('../dhanProd.service');
const symbolRegistry = require('../../config/symbolRegistry');

function _active() {
  return symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
}
function _activeApiTriplet() {
  return { exchange: 'IDX', segment: 'I', instrument: 'IDX' };
}

const DEMA_PERIOD = 20; // 20 periods
const CANDLE_INTERVAL = '15'; // 15-minute candles

/**
 * Calculate EMA (Exponential Moving Average)
 * @param {Array} values - Array of prices
 * @param {number} period - EMA period
 * @returns {Array} Array of EMA values
 */
function calculateEMA(values, period) {
  if (values.length < period) return [];
  
  const k = 2 / (period + 1); // Smoothing factor
  const emaArray = [];
  
  // First EMA is SMA
  let ema = values.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  emaArray.push(ema);
  
  // Calculate remaining EMAs
  for (let i = period; i < values.length; i++) {
    ema = (values[i] * k) + (ema * (1 - k));
    emaArray.push(ema);
  }
  
  return emaArray;
}

/**
 * Calculate DEMA (Double Exponential Moving Average)
 * Formula: DEMA = 2 * EMA - EMA(EMA)
 * @param {Array} values - Array of prices
 * @param {number} period - DEMA period
 * @returns {number} Current DEMA value
 */
function calculateDEMA(values, period) {
  if (values.length < period * 2) {
    logger.warn({ 
      valuesLength: values.length, 
      required: period * 2 
    }, '[demaIndicator] Insufficient data for DEMA calculation');
    return null;
  }
  
  // Step 1: Calculate EMA
  const ema = calculateEMA(values, period);
  
  if (ema.length < period) {
    logger.warn('[demaIndicator] Insufficient EMA data');
    return null;
  }
  
  // Step 2: Calculate EMA of EMA
  const emaOfEma = calculateEMA(ema, period);
  
  if (emaOfEma.length === 0) {
    logger.warn('[demaIndicator] Failed to calculate EMA of EMA');
    return null;
  }
  
  // Step 3: DEMA = 2 * EMA - EMA(EMA)
  const currentEMA = ema[ema.length - 1];
  const currentEMAofEMA = emaOfEma[emaOfEma.length - 1];
  const dema = (2 * currentEMA) - currentEMAofEMA;
  
  return dema;
}

/**
 * Analyze DEMA indicator with 15-minute candles
 * @param {string} authKey - Dhan Bypass auth key
 * @param {number} spotPrice - Current NIFTY spot price
 * @param {Object} previousDEMAData - Previous cycle DEMA data
 * @returns {Object} DEMA analysis
 */
async function analyzeDEMA(authKey, spotPrice, previousDEMAData = null) {
  try {
    logger.info('[demaIndicator] Analyzing DEMA (15min, 20-period)');
    
    // Fetch 15-minute candles (need at least 40 candles for DEMA calculation)
    const now = Math.floor(Date.now() / 1000);
    const hoursAgo = now - (10 * 60 * 60); // 10 hours of data (40 x 15min candles)
    
    const active = _active();
    const triplet = _activeApiTriplet();
    const res = await dhanBypass.getDhanBypassData(authKey, {
      securityId: active.indexSecurityId,
      exchange: triplet.exchange,
      segment: triplet.segment,
      instrument: triplet.instrument,
      startTime: hoursAgo,
      endTime: now,
      interval: CANDLE_INTERVAL, // 15-minute candles
    });
    
    if (!res.ok || !res.data.candles || res.data.candles.length < DEMA_PERIOD) {
      logger.warn({ 
        candlesReceived: res.data?.candles?.length || 0,
        required: DEMA_PERIOD
      }, '[demaIndicator] Insufficient candle data');
      return null;
    }
    
    const candles = res.data.candles;
    const closes = candles.map(c => c.close);
    
    // Calculate DEMA
    const demaValue = calculateDEMA(closes, DEMA_PERIOD);
    
    if (!demaValue) {
      logger.error('[demaIndicator] DEMA calculation failed');
      return null;
    }
    
    // Calculate full DEMA array for trend analysis
    const ema = calculateEMA(closes, DEMA_PERIOD);
    const emaOfEma = calculateEMA(ema, DEMA_PERIOD);
    const demaArray = [];
    
    for (let i = 0; i < emaOfEma.length; i++) {
      const dema = (2 * ema[DEMA_PERIOD - 1 + i]) - emaOfEma[i];
      demaArray.push(dema);
    }
    
    // Current price vs DEMA
    const priceVsDEMA = spotPrice > demaValue ? 'above' : spotPrice < demaValue ? 'below' : 'at';
    const distanceFromDEMA = spotPrice - demaValue;
    const distanceFromDEMAPct = (distanceFromDEMA / demaValue) * 100;
    
    // DEMA slope (trend direction)
    const demaSlope = calculateDEMASlope(demaArray);
    const demaTrend = demaSlope > 0.05 ? 'strong_uptrend' :
                      demaSlope > 0.01 ? 'uptrend' :
                      demaSlope < -0.05 ? 'strong_downtrend' :
                      demaSlope < -0.01 ? 'downtrend' : 'sideways';
    
    // DEMA crossover detection
    const crossover = detectDEMACrossover(closes, demaArray, previousDEMAData);
    
    // Price momentum relative to DEMA
    const momentum = analyzeMomentum(closes, demaArray);
    
    // DEMA support/resistance
    const supportResistance = analyzeDEMASupportResistance(spotPrice, demaValue, demaArray);
    
    // Calculate DEMA score (0-100)
    const demaScore = calculateDEMAScore(
      priceVsDEMA,
      distanceFromDEMAPct,
      demaTrend,
      crossover,
      momentum,
      supportResistance
    );
    
    // Determine DEMA bias
    const demaBias = determineDEMABias(
      priceVsDEMA,
      demaTrend,
      crossover,
      momentum
    );
    
    // Trading implication
    const tradingImplication = getDEMATradingImplication(
      demaBias,
      demaScore,
      crossover,
      supportResistance
    );
    
    logger.info({
      demaValue: demaValue.toFixed(2),
      spotPrice: spotPrice.toFixed(2),
      priceVsDEMA,
      distancePct: distanceFromDEMAPct.toFixed(2),
      demaTrend,
      demaBias,
      demaScore
    }, '[demaIndicator] DEMA analysis completed');
    
    return {
      dema_value: Number(demaValue.toFixed(2)),
      spot_price: spotPrice,
      price_vs_dema: priceVsDEMA,
      distance_from_dema: Number(distanceFromDEMA.toFixed(2)),
      distance_from_dema_pct: Number(distanceFromDEMAPct.toFixed(2)),
      dema_trend: demaTrend,
      dema_slope: Number(demaSlope.toFixed(4)),
      crossover: crossover,
      momentum: momentum,
      support_resistance: supportResistance,
      dema_score: demaScore,
      dema_bias: demaBias,
      trading_implication: tradingImplication,
      candles_used: candles.length,
      period: DEMA_PERIOD,
      interval: CANDLE_INTERVAL + 'min'
    };
  } catch (error) {
    logger.error({ error: error.message }, '[demaIndicator] Analysis failed');
    return null;
  }
}

/**
 * Calculate DEMA slope (rate of change)
 */
function calculateDEMASlope(demaArray) {
  if (demaArray.length < 3) return 0;
  
  // Calculate slope over last 3 periods
  const recent = demaArray.slice(-3);
  const slope = (recent[2] - recent[0]) / recent[0] * 100;
  
  return slope;
}

/**
 * Detect DEMA crossover
 */
function detectDEMACrossover(closes, demaArray, previousDEMAData) {
  if (closes.length < 2 || demaArray.length < 2) {
    return {
      crossover_detected: false,
      crossover_type: 'none',
      bars_ago: 0
    };
  }
  
  const currentPrice = closes[closes.length - 1];
  const previousPrice = closes[closes.length - 2];
  const currentDEMA = demaArray[demaArray.length - 1];
  const previousDEMA = demaArray[demaArray.length - 2];
  
  // Bullish crossover: price crosses above DEMA
  if (previousPrice <= previousDEMA && currentPrice > currentDEMA) {
    return {
      crossover_detected: true,
      crossover_type: 'bullish',
      bars_ago: 0,
      strength: Math.abs(currentPrice - currentDEMA) / currentDEMA * 100
    };
  }
  
  // Bearish crossover: price crosses below DEMA
  if (previousPrice >= previousDEMA && currentPrice < currentDEMA) {
    return {
      crossover_detected: true,
      crossover_type: 'bearish',
      bars_ago: 0,
      strength: Math.abs(currentPrice - currentDEMA) / currentDEMA * 100
    };
  }
  
  // Check if crossover happened in last 3 bars
  for (let i = 1; i <= Math.min(3, demaArray.length - 1); i++) {
    const price1 = closes[closes.length - 1 - i];
    const price2 = closes[closes.length - i];
    const dema1 = demaArray[demaArray.length - 1 - i];
    const dema2 = demaArray[demaArray.length - i];
    
    if (price1 <= dema1 && price2 > dema2) {
      return {
        crossover_detected: true,
        crossover_type: 'bullish',
        bars_ago: i,
        strength: Math.abs(price2 - dema2) / dema2 * 100
      };
    }
    
    if (price1 >= dema1 && price2 < dema2) {
      return {
        crossover_detected: true,
        crossover_type: 'bearish',
        bars_ago: i,
        strength: Math.abs(price2 - dema2) / dema2 * 100
      };
    }
  }
  
  return {
    crossover_detected: false,
    crossover_type: 'none',
    bars_ago: 0
  };
}

/**
 * Analyze momentum relative to DEMA
 */
function analyzeMomentum(closes, demaArray) {
  if (closes.length < 5 || demaArray.length < 5) {
    return {
      momentum_strength: 'unknown',
      momentum_direction: 'neutral',
      bars_above_dema: 0,
      bars_below_dema: 0
    };
  }
  
  // Count bars above/below DEMA in last 5 periods
  let barsAbove = 0;
  let barsBelow = 0;
  
  for (let i = 0; i < 5; i++) {
    const price = closes[closes.length - 1 - i];
    const dema = demaArray[demaArray.length - 1 - i];
    
    if (price > dema) barsAbove++;
    else if (price < dema) barsBelow++;
  }
  
  // Momentum strength
  let momentumStrength = 'weak';
  if (barsAbove >= 4 || barsBelow >= 4) momentumStrength = 'strong';
  else if (barsAbove >= 3 || barsBelow >= 3) momentumStrength = 'moderate';
  
  // Momentum direction
  let momentumDirection = 'neutral';
  if (barsAbove > barsBelow) momentumDirection = 'bullish';
  else if (barsBelow > barsAbove) momentumDirection = 'bearish';
  
  return {
    momentum_strength: momentumStrength,
    momentum_direction: momentumDirection,
    bars_above_dema: barsAbove,
    bars_below_dema: barsBelow
  };
}

/**
 * Analyze DEMA as support/resistance
 */
function analyzeDEMASupportResistance(spotPrice, demaValue, demaArray) {
  const distance = Math.abs(spotPrice - demaValue);
  const distancePct = (distance / demaValue) * 100;
  
  // DEMA acts as support when price is above
  // DEMA acts as resistance when price is below
  const role = spotPrice > demaValue ? 'support' : 'resistance';
  
  // Strength based on distance
  let strength = 'weak';
  if (distancePct < 0.1) strength = 'very_strong'; // Very close to DEMA
  else if (distancePct < 0.3) strength = 'strong';
  else if (distancePct < 0.5) strength = 'moderate';
  
  // Test likelihood (will price bounce or break?)
  let testLikelihood = 'low';
  if (distancePct < 0.2) testLikelihood = 'high'; // Very close, likely to test
  else if (distancePct < 0.5) testLikelihood = 'moderate';
  
  return {
    role: role,
    strength: strength,
    distance_pct: Number(distancePct.toFixed(2)),
    test_likelihood: testLikelihood
  };
}

/**
 * Calculate DEMA score (0-100)
 */
function calculateDEMAScore(priceVsDEMA, distancePct, demaTrend, crossover, momentum, supportResistance) {
  let score = 50; // Start neutral
  
  // 1. Price position vs DEMA (20 points)
  if (priceVsDEMA === 'above' && demaTrend.includes('uptrend')) {
    score += 20; // Bullish alignment
  } else if (priceVsDEMA === 'below' && demaTrend.includes('downtrend')) {
    score += 20; // Bearish alignment
  } else if (priceVsDEMA === 'above' && demaTrend.includes('downtrend')) {
    score -= 10; // Conflicting signals
  } else if (priceVsDEMA === 'below' && demaTrend.includes('uptrend')) {
    score -= 10; // Conflicting signals
  }
  
  // 2. Distance from DEMA (15 points)
  if (Math.abs(distancePct) < 0.2) {
    score += 15; // Close to DEMA = good for entry
  } else if (Math.abs(distancePct) > 1.0) {
    score -= 10; // Too far from DEMA = overextended
  }
  
  // 3. DEMA trend (20 points)
  if (demaTrend === 'strong_uptrend') score += 20;
  else if (demaTrend === 'uptrend') score += 10;
  else if (demaTrend === 'strong_downtrend') score -= 20;
  else if (demaTrend === 'downtrend') score -= 10;
  
  // 4. Crossover (25 points)
  if (crossover.crossover_detected) {
    if (crossover.crossover_type === 'bullish' && crossover.bars_ago <= 1) {
      score += 25; // Fresh bullish crossover
    } else if (crossover.crossover_type === 'bearish' && crossover.bars_ago <= 1) {
      score -= 25; // Fresh bearish crossover
    } else if (crossover.bars_ago <= 3) {
      score += 10; // Recent crossover
    }
  }
  
  // 5. Momentum (20 points)
  if (momentum.momentum_strength === 'strong') {
    if (momentum.momentum_direction === 'bullish') score += 20;
    else if (momentum.momentum_direction === 'bearish') score -= 20;
  } else if (momentum.momentum_strength === 'moderate') {
    if (momentum.momentum_direction === 'bullish') score += 10;
    else if (momentum.momentum_direction === 'bearish') score -= 10;
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determine DEMA bias
 */
function determineDEMABias(priceVsDEMA, demaTrend, crossover, momentum) {
  // Strong bullish: price above DEMA + uptrend + bullish momentum
  if (priceVsDEMA === 'above' && 
      demaTrend.includes('uptrend') && 
      momentum.momentum_direction === 'bullish') {
    return 'strong_bullish';
  }
  
  // Strong bearish: price below DEMA + downtrend + bearish momentum
  if (priceVsDEMA === 'below' && 
      demaTrend.includes('downtrend') && 
      momentum.momentum_direction === 'bearish') {
    return 'strong_bearish';
  }
  
  // Bullish: price above DEMA or bullish crossover
  if (priceVsDEMA === 'above' || crossover.crossover_type === 'bullish') {
    return 'bullish';
  }
  
  // Bearish: price below DEMA or bearish crossover
  if (priceVsDEMA === 'below' || crossover.crossover_type === 'bearish') {
    return 'bearish';
  }
  
  return 'neutral';
}

/**
 * Get DEMA trading implication
 */
function getDEMATradingImplication(demaBias, demaScore, crossover, supportResistance) {
  if (demaBias === 'strong_bullish' && demaScore >= 80) {
    return 'Strong bullish momentum - price above DEMA with uptrend';
  }
  
  if (demaBias === 'strong_bearish' && demaScore <= 20) {
    return 'Strong bearish momentum - price below DEMA with downtrend';
  }
  
  if (crossover.crossover_detected && crossover.bars_ago === 0) {
    return `Fresh ${crossover.crossover_type} crossover - high probability setup`;
  }
  
  if (supportResistance.test_likelihood === 'high') {
    return `Price near DEMA ${supportResistance.role} - watch for bounce or break`;
  }
  
  if (demaScore >= 70) {
    return 'DEMA confirms bullish bias - favor long setups';
  }
  
  if (demaScore <= 30) {
    return 'DEMA confirms bearish bias - favor short setups';
  }
  
  return 'DEMA neutral - wait for clearer signal';
}

/**
 * Calculate DEMA score for master algorithm (0-100)
 */
function calculateDEMAScoreForMaster(demaData, direction) {
  if (!demaData) return 50; // Neutral
  
  let score = demaData.dema_score; // Start with base score
  
  // Adjust based on direction alignment
  if (direction === 'bullish') {
    if (demaData.dema_bias === 'strong_bullish') score += 20;
    else if (demaData.dema_bias === 'bullish') score += 10;
    else if (demaData.dema_bias.includes('bearish')) score -= 20;
    
    // Bonus for bullish crossover
    if (demaData.crossover.crossover_detected && 
        demaData.crossover.crossover_type === 'bullish' && 
        demaData.crossover.bars_ago <= 1) {
      score += 15;
    }
  } else if (direction === 'bearish') {
    if (demaData.dema_bias === 'strong_bearish') score += 20;
    else if (demaData.dema_bias === 'bearish') score += 10;
    else if (demaData.dema_bias.includes('bullish')) score -= 20;
    
    // Bonus for bearish crossover
    if (demaData.crossover.crossover_detected && 
        demaData.crossover.crossover_type === 'bearish' && 
        demaData.crossover.bars_ago <= 1) {
      score += 15;
    }
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  analyzeDEMA,
  calculateDEMAScoreForMaster
};
