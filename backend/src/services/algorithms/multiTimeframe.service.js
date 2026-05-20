/**
 * Multi-Timeframe Confluence Algorithm
 * Used by: Larry Williams, Mark Minervini, Professional day traders
 * 
 * Analyzes 1-min, 5-min, 15-min alignment, higher timeframe bias,
 * fractal analysis, trend strength, and support/resistance confluence
 * 
 * ENHANCED with UT Bot ATR Trailing Stop trend detection
 */
const logger = require('../../utils/logger');
const dhanBypass = require('../dhanProd.service');
const symbolRegistry = require('../../config/symbolRegistry');

function _active() {
  return symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
}
function _activeApiTriplet() {
  const s = _active();
  return s.indexSegment === 'BSE_I'
    ? { exchange: 'BSE', segment: 'BSE_I', instrument: 'INDEX' }
    : { exchange: 'IDX', segment: 'I',     instrument: 'IDX' };
}

// UT Bot Configuration
const UT_BOT_CONFIG = {
  keyValue: 1,      // Sensitivity (lower = more sensitive)
  atrPeriod: 10,    // ATR period for trailing stop
};

/**
 * Analyze multi-timeframe confluence
 * @param {string} authKey - Dhan Bypass auth key
 * @param {number} spotPrice - Current spot price
 */
async function analyzeMultiTimeframe(authKey, spotPrice) {
  try {
    const now = Math.floor(Date.now() / 1000);
    
    // Fetch more data for better trend detection (FIXED: increased lookback)
    const timeframes = {
      '1m': await fetchTimeframeData(authKey, now, 60, '1'),   // Last 60 minutes (was 15)
      '5m': await fetchTimeframeData(authKey, now, 180, '5'),  // Last 3 hours (was 60 min)
      '15m': await fetchTimeframeData(authKey, now, 450, '15'), // Last 7.5 hours (was 3 hours)
      '30m': await fetchTimeframeData(authKey, now, 600, '30'), // Last 10 hours (NEW)
    };
    
    // Analyze each timeframe with enhanced detection
    const analysis = {
      '1m': analyzeTimeframe(timeframes['1m'], spotPrice, '1m'),
      '5m': analyzeTimeframe(timeframes['5m'], spotPrice, '5m'),
      '15m': analyzeTimeframe(timeframes['15m'], spotPrice, '15m'),
      '30m': analyzeTimeframe(timeframes['30m'], spotPrice, '30m'),
    };
    
    // Calculate alignment score
    const alignmentScore = calculateAlignmentScore(analysis);
    
    // Determine higher timeframe bias
    const higherTFBias = determineHigherTFBias(analysis);
    
    // Find confluence zones (support/resistance across timeframes)
    const confluenceZones = findConfluenceZones(timeframes, spotPrice);
    
    // Detect fractal patterns
    const fractalPattern = detectFractalPattern(timeframes['1m'], timeframes['5m']);
    
    return {
      timeframes: analysis,
      alignment_score: alignmentScore,
      higher_tf_bias: higherTFBias,
      confluence_zones: confluenceZones,
      fractal_pattern: fractalPattern,
      all_timeframes_aligned: alignmentScore >= 80,
      trading_implication: getTradingImplication(alignmentScore, higherTFBias)
    };
  } catch (error) {
    logger.error({ error: error.message }, '[multiTimeframe] Analysis failed');
    return null;
  }
}

/**
 * Fetch timeframe data from Dhan Bypass
 */
async function fetchTimeframeData(authKey, currentTime, minutesBack, interval) {
  const startTime = currentTime - (minutesBack * 60);
  const active = _active();
  const triplet = _activeApiTriplet();

  const res = await dhanBypass.getDhanBypassData(authKey, {
    securityId: active.indexSecurityId,
    exchange: triplet.exchange,
    segment: triplet.segment,
    instrument: triplet.instrument,
    startTime,
    endTime: currentTime,
    interval,
  });
  
  if (!res.ok || !res.data.candles) {
    return [];
  }
  
  return res.data.candles;
}

/**
 * Analyze single timeframe with ENHANCED trend detection
 * Uses: UT Bot ATR Trailing Stop, EMA, Swing Points, Multiple Signal Confirmation
 */
function analyzeTimeframe(candles, spotPrice, timeframe) {
  if (!candles || candles.length < 10) {
    return {
      trend: 'unknown',
      strength: 0,
      regime: 'unknown',
      ema_slope: 0,
      price_vs_ema: 'unknown',
      ut_bot_signal: 'unknown',
      swing_structure: 'unknown',
      confidence: 0
    };
  }
  
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);
  
  // 1. UT Bot ATR Trailing Stop (PRIMARY TREND INDICATOR)
  const utBotResult = calculateUTBot(candles);
  
  // 2. Calculate EMA (20-period for trend)
  const ema20 = calculateEMA(closes, 20);
  const currentEMA = ema20[ema20.length - 1];
  const prevEMA = ema20[ema20.length - 2];
  const emaSlope = currentEMA - prevEMA;
  
  // 3. Swing Point Analysis (Higher Highs/Higher Lows)
  const swingStructure = detectSwingStructure(candles);
  
  // 4. Combine signals with voting system
  const trendSignals = {
    utBot: utBotResult.trend,
    ema: spotPrice > currentEMA ? 'bullish' : 'bearish',
    emaSlope: emaSlope > 0 ? 'bullish' : 'bearish',
    swingStructure: swingStructure.trend
  };
  
  // Count votes
  const bullishVotes = Object.values(trendSignals).filter(s => s === 'bullish').length;
  const bearishVotes = Object.values(trendSignals).filter(s => s === 'bearish').length;
  
  // Determine final trend (need 3 out of 4 for strong conviction)
  let finalTrend = 'neutral';
  let confidence = 0;
  
  if (bullishVotes >= 3) {
    finalTrend = 'bullish';
    confidence = bullishVotes === 4 ? 100 : 75;
  } else if (bearishVotes >= 3) {
    finalTrend = 'bearish';
    confidence = bearishVotes === 4 ? 100 : 75;
  } else if (bullishVotes === 2 && bearishVotes === 2) {
    // Tie-breaker: Use UT Bot as primary
    finalTrend = utBotResult.trend;
    confidence = 50;
  }
  
  // Calculate trend strength (0-10)
  const strength = calculateTrendStrength(closes, highs, lows, volumes);
  
  // Determine regime (trending, ranging, volatile)
  const regime = determineRegime(closes, highs, lows);
  
  // Price position vs EMA
  const priceVsEMA = spotPrice > currentEMA ? 'above' : spotPrice < currentEMA ? 'below' : 'at';
  
  return {
    trend: finalTrend,
    strength,
    regime,
    ema: Math.round(currentEMA * 100) / 100,
    ema_slope: Math.round(emaSlope * 100) / 100,
    price_vs_ema: priceVsEMA,
    ut_bot_signal: utBotResult.signal,
    ut_bot_trailing_stop: utBotResult.trailingStop,
    swing_structure: swingStructure.pattern,
    confidence,
    signals: trendSignals,
    candle_count: candles.length
  };
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  
  return ema;
}

/**
 * Calculate ATR (Average True Range)
 */
function calculateATR(candles, period) {
  const trueRanges = [];
  
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    
    trueRanges.push(tr);
  }
  
  // Calculate ATR using EMA
  return calculateEMA(trueRanges, period);
}

/**
 * UT Bot ATR Trailing Stop Calculation
 * Based on TradingView's UT Bot Alerts indicator
 */
function calculateUTBot(candles, config = UT_BOT_CONFIG) {
  if (candles.length < config.atrPeriod + 5) {
    return { trend: 'neutral', signal: 'none', trailingStop: 0 };
  }
  
  const closes = candles.map(c => c.close);
  const atr = calculateATR(candles, config.atrPeriod);
  
  // Calculate trailing stop
  const xATRTrailingStop = [];
  const pos = [];
  
  for (let i = 0; i < closes.length; i++) {
    const nLoss = config.keyValue * (atr[i] || atr[atr.length - 1] || 0);
    const src = closes[i];
    
    let stop = 0;
    
    if (i === 0) {
      stop = src - nLoss;
    } else {
      const prevStop = xATRTrailingStop[i - 1];
      
      if (src > prevStop && closes[i - 1] > prevStop) {
        stop = Math.max(prevStop, src - nLoss);
      } else if (src < prevStop && closes[i - 1] < prevStop) {
        stop = Math.min(prevStop, src + nLoss);
      } else if (src > prevStop) {
        stop = src - nLoss;
      } else {
        stop = src + nLoss;
      }
    }
    
    xATRTrailingStop.push(stop);
    
    // Determine position
    let position = 0;
    if (i > 0) {
      if (closes[i - 1] < xATRTrailingStop[i - 1] && src > xATRTrailingStop[i - 1]) {
        position = 1; // Buy signal
      } else if (closes[i - 1] > xATRTrailingStop[i - 1] && src < xATRTrailingStop[i - 1]) {
        position = -1; // Sell signal
      } else {
        position = pos[i - 1] || 0;
      }
    }
    
    pos.push(position);
  }
  
  // Current position
  const currentPos = pos[pos.length - 1];
  const currentStop = xATRTrailingStop[xATRTrailingStop.length - 1];
  const currentPrice = closes[closes.length - 1];
  
  // Determine trend and signal
  let trend = 'neutral';
  let signal = 'none';
  
  if (currentPrice > currentStop) {
    trend = 'bullish';
    if (currentPos === 1) signal = 'buy';
  } else if (currentPrice < currentStop) {
    trend = 'bearish';
    if (currentPos === -1) signal = 'sell';
  }
  
  return {
    trend,
    signal,
    trailingStop: Math.round(currentStop * 100) / 100,
    position: currentPos
  };
}

/**
 * Detect swing structure (Higher Highs/Higher Lows or Lower Highs/Lower Lows)
 */
function detectSwingStructure(candles) {
  if (candles.length < 10) {
    return { trend: 'neutral', pattern: 'insufficient_data' };
  }
  
  const swingHighs = [];
  const swingLows = [];
  
  // Find swing highs and lows
  for (let i = 2; i < candles.length - 2; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    
    // Swing high: higher than 2 candles before and after
    if (high > candles[i - 1].high && high > candles[i - 2].high &&
        high > candles[i + 1].high && high > candles[i + 2].high) {
      swingHighs.push({ index: i, value: high });
    }
    
    // Swing low: lower than 2 candles before and after
    if (low < candles[i - 1].low && low < candles[i - 2].low &&
        low < candles[i + 1].low && low < candles[i + 2].low) {
      swingLows.push({ index: i, value: low });
    }
  }
  
  // Need at least 2 swing points to determine structure
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { trend: 'neutral', pattern: 'insufficient_swings' };
  }
  
  // Check for higher highs and higher lows (uptrend)
  const lastHigh = swingHighs[swingHighs.length - 1].value;
  const prevHigh = swingHighs[swingHighs.length - 2].value;
  const lastLow = swingLows[swingLows.length - 1].value;
  const prevLow = swingLows[swingLows.length - 2].value;
  
  const higherHighs = lastHigh > prevHigh;
  const higherLows = lastLow > prevLow;
  const lowerHighs = lastHigh < prevHigh;
  const lowerLows = lastLow < prevLow;
  
  if (higherHighs && higherLows) {
    return { trend: 'bullish', pattern: 'higher_highs_higher_lows' };
  }
  
  if (lowerHighs && lowerLows) {
    return { trend: 'bearish', pattern: 'lower_highs_lower_lows' };
  }
  
  if (higherHighs && lowerLows) {
    return { trend: 'neutral', pattern: 'expanding_range' };
  }
  
  if (lowerHighs && higherLows) {
    return { trend: 'neutral', pattern: 'contracting_range' };
  }
  
  return { trend: 'neutral', pattern: 'mixed_structure' };
}

/**
 * Calculate trend strength (0-10)
 */
function calculateTrendStrength(closes, highs, lows, volumes) {
  // 1. Directional consistency
  let upMoves = 0;
  let downMoves = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) upMoves++;
    else if (closes[i] < closes[i - 1]) downMoves++;
  }
  const consistency = Math.abs(upMoves - downMoves) / closes.length;
  
  // 2. Range expansion
  const avgRange = (Math.max(...highs) - Math.min(...lows)) / closes[0];
  const rangeScore = Math.min(1, avgRange * 100);
  
  // 3. Volume confirmation
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const recentVolume = volumes[volumes.length - 1];
  const volumeScore = Math.min(1, recentVolume / avgVolume);
  
  // Combine scores (0-10)
  const strength = (consistency * 4 + rangeScore * 3 + volumeScore * 3);
  return Math.round(strength * 10) / 10;
}

/**
 * Determine market regime
 */
function determineRegime(closes, highs, lows) {
  const priceRange = Math.max(...highs) - Math.min(...lows);
  const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
  const volatility = (priceRange / avgPrice) * 100;
  
  // Calculate if price is oscillating (ranging)
  const oscillations = closes.filter((c, i) => {
    if (i < 2) return false;
    return (c > closes[i - 1] && closes[i - 1] < closes[i - 2]) ||
           (c < closes[i - 1] && closes[i - 1] > closes[i - 2]);
  }).length;
  
  const oscillationRatio = oscillations / closes.length;
  
  if (volatility > 1.5) return 'volatile';
  if (oscillationRatio > 0.6) return 'ranging';
  return 'trending';
}

/**
 * Calculate alignment score (0-100)
 * Higher score = all timeframes agree on direction
 * ENHANCED: Now includes 30m timeframe and confidence weighting
 */
function calculateAlignmentScore(analysis) {
  const timeframes = ['1m', '5m', '15m', '30m'];
  let score = 0;
  
  // Check trend alignment with confidence weighting
  const trends = timeframes.map(tf => ({
    trend: analysis[tf].trend,
    confidence: analysis[tf].confidence || 50
  }));
  
  const bullishCount = trends.filter(t => t.trend === 'bullish').length;
  const bearishCount = trends.filter(t => t.trend === 'bearish').length;
  
  // Perfect alignment (all 4 timeframes agree)
  if (bullishCount === 4) score += 60;
  else if (bearishCount === 4) score += 60;
  // Strong alignment (3 out of 4)
  else if (bullishCount === 3) score += 45;
  else if (bearishCount === 3) score += 45;
  // Moderate alignment (2 out of 4, but higher timeframes agree)
  else if (bullishCount === 2 && analysis['15m'].trend === 'bullish' && analysis['30m'].trend === 'bullish') score += 30;
  else if (bearishCount === 2 && analysis['15m'].trend === 'bearish' && analysis['30m'].trend === 'bearish') score += 30;
  else score += 10; // Mixed signals
  
  // Confidence bonus (average confidence across timeframes)
  const avgConfidence = trends.reduce((sum, t) => sum + t.confidence, 0) / timeframes.length;
  score += (avgConfidence / 100) * 20; // Up to 20 points for high confidence
  
  // Check strength alignment
  const avgStrength = timeframes.reduce((sum, tf) => sum + analysis[tf].strength, 0) / timeframes.length;
  score += (avgStrength / 10) * 15; // Up to 15 points for strength
  
  // Check regime alignment (trending is good)
  const regimes = timeframes.map(tf => analysis[tf].regime);
  const trendingCount = regimes.filter(r => r === 'trending').length;
  if (trendingCount >= 3) score += 5;
  
  return Math.round(Math.min(100, score));
}

/**
 * Determine higher timeframe bias
 * ENHANCED: 30m has highest weight, then 15m, then 5m, then 1m
 */
function determineHigherTFBias(analysis) {
  const tf30m = analysis['30m'];
  const tf15m = analysis['15m'];
  const tf5m = analysis['5m'];
  const tf1m = analysis['1m'];
  
  // 30-min trend is the primary bias (highest timeframe)
  if (tf30m.trend === 'bullish' && tf30m.strength >= 5 && tf30m.confidence >= 75) {
    return 'strongly_bullish';
  }
  if (tf30m.trend === 'bearish' && tf30m.strength >= 5 && tf30m.confidence >= 75) {
    return 'strongly_bearish';
  }
  
  // If 30-min is neutral or weak, check 15-min
  if (tf15m.trend === 'bullish' && tf15m.strength >= 5 && tf15m.confidence >= 75) {
    return 'bullish';
  }
  if (tf15m.trend === 'bearish' && tf15m.strength >= 5 && tf15m.confidence >= 75) {
    return 'bearish';
  }
  
  // If both higher TFs are neutral, check 5-min
  if (tf5m.trend === 'bullish' && tf5m.strength >= 5) {
    return 'short_term_bullish';
  }
  if (tf5m.trend === 'bearish' && tf5m.strength >= 5) {
    return 'short_term_bearish';
  }
  
  // Last resort: check 1-min
  if (tf1m.trend === 'bullish') return 'very_short_term_bullish';
  if (tf1m.trend === 'bearish') return 'very_short_term_bearish';
  
  return 'neutral';
}

/**
 * Find confluence zones (support/resistance across timeframes)
 */
function findConfluenceZones(timeframes, spotPrice) {
  const zones = [];
  
  // Extract key levels from each timeframe
  Object.keys(timeframes).forEach(tf => {
    const candles = timeframes[tf];
    if (!candles || candles.length < 5) return;
    
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    
    // Find local highs (resistance)
    for (let i = 2; i < highs.length - 2; i++) {
      if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
          highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
        zones.push({
          level: Math.round(highs[i] / 10) * 10, // Round to nearest 10
          type: 'resistance',
          timeframe: tf
        });
      }
    }
    
    // Find local lows (support)
    for (let i = 2; i < lows.length - 2; i++) {
      if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
          lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
        zones.push({
          level: Math.round(lows[i] / 10) * 10,
          type: 'support',
          timeframe: tf
        });
      }
    }
  });
  
  // Find confluence (same level across multiple timeframes)
  const confluenceMap = {};
  zones.forEach(z => {
    if (!confluenceMap[z.level]) {
      confluenceMap[z.level] = { level: z.level, type: z.type, count: 0, timeframes: [] };
    }
    confluenceMap[z.level].count++;
    confluenceMap[z.level].timeframes.push(z.timeframe);
  });
  
  // Return only strong confluence zones (2+ timeframes)
  return Object.values(confluenceMap)
    .filter(z => z.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

/**
 * Detect fractal patterns
 * Fractal = self-similar patterns across timeframes
 */
function detectFractalPattern(candles1m, candles5m) {
  if (!candles1m || candles1m.length < 5 || !candles5m || candles5m.length < 5) {
    return 'insufficient_data';
  }
  
  // Check if both timeframes show similar pattern
  const pattern1m = identifyPattern(candles1m.slice(-5));
  const pattern5m = identifyPattern(candles5m.slice(-5));
  
  if (pattern1m === pattern5m && pattern1m !== 'none') {
    return `${pattern1m}_fractal`; // e.g., "bullish_fractal"
  }
  
  return 'no_fractal';
}

/**
 * Identify simple candlestick pattern
 */
function identifyPattern(candles) {
  if (candles.length < 3) return 'none';
  
  const closes = candles.map(c => c.close);
  
  // Higher highs and higher lows = bullish
  const isHigherHighs = closes[closes.length - 1] > closes[closes.length - 2] &&
                        closes[closes.length - 2] > closes[closes.length - 3];
  
  // Lower highs and lower lows = bearish
  const isLowerLows = closes[closes.length - 1] < closes[closes.length - 2] &&
                      closes[closes.length - 2] < closes[closes.length - 3];
  
  if (isHigherHighs) return 'bullish';
  if (isLowerLows) return 'bearish';
  return 'none';
}

/**
 * Get trading implications
 */
function getTradingImplication(alignmentScore, higherTFBias) {
  if (alignmentScore >= 80) {
    if (higherTFBias.includes('bullish')) {
      return 'Strong multi-timeframe bullish alignment - high probability long setups';
    }
    if (higherTFBias.includes('bearish')) {
      return 'Strong multi-timeframe bearish alignment - high probability short setups';
    }
  }
  
  if (alignmentScore >= 60) {
    return 'Moderate timeframe alignment - trade with caution, use tight stops';
  }
  
  return 'Poor timeframe alignment - avoid trading, wait for clarity';
}

/**
 * Calculate multi-timeframe score for master algorithm (0-100)
 */
function calculateMultiTimeframeScore(mtfData, direction) {
  if (!mtfData) return 50; // Neutral
  
  let score = 50; // Start neutral
  
  // 1. Alignment score (40 points)
  const alignmentBonus = (mtfData.alignment_score / 100) * 40;
  score += alignmentBonus;
  
  // 2. Higher timeframe bias alignment (30 points)
  if (direction === 'bullish') {
    if (mtfData.higher_tf_bias === 'strongly_bullish') score += 30;
    else if (mtfData.higher_tf_bias === 'bullish') score += 20;
    else if (mtfData.higher_tf_bias.includes('bearish')) score -= 20;
  } else if (direction === 'bearish') {
    if (mtfData.higher_tf_bias === 'strongly_bearish') score += 30;
    else if (mtfData.higher_tf_bias === 'bearish') score += 20;
    else if (mtfData.higher_tf_bias.includes('bullish')) score -= 20;
  }
  
  // 3. Fractal pattern confirmation (15 points)
  if (mtfData.fractal_pattern && mtfData.fractal_pattern.includes('fractal')) {
    if (direction === 'bullish' && mtfData.fractal_pattern.includes('bullish')) score += 15;
    else if (direction === 'bearish' && mtfData.fractal_pattern.includes('bearish')) score += 15;
  }
  
  // 4. Confluence zones (15 points)
  if (mtfData.confluence_zones && mtfData.confluence_zones.length > 0) {
    score += 15;
  }
  
  return Math.max(0, Math.min(100, score));
}

module.exports = {
  analyzeMultiTimeframe,
  calculateMultiTimeframeScore,
  // CALIBRATED 2026-05-19: expose calculator + config so the dedicated
  // ultra-scalp engine can run UT Bot with TradingView-matching params
  // (keyValue=2, atrPeriod=1) on raw 1m/3m/5m candles.
  calculateUTBot,
  UT_BOT_CONFIG,
};
