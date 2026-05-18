/**
 * Global Markets Integration
 * Used by: International funds, Global macro traders, Institutional desks
 * 
 * Analyzes US futures, DXY, crude oil, gold, Asian markets, and global correlations
 * 
 * CRITICAL FOR OVERNIGHT GAP HANDLING AND GLOBAL RISK SENTIMENT
 */
const axios = require('axios');
const logger = require('../../utils/logger');

// Free API endpoints (no key required)
const YAHOO_FINANCE_API = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Global market symbols
const SYMBOLS = {
  SP500_FUTURES: 'ES=F',      // S&P 500 Futures
  NASDAQ_FUTURES: 'NQ=F',     // Nasdaq Futures
  DOW_FUTURES: 'YM=F',        // Dow Futures
  DXY: 'DX-Y.NYB',            // US Dollar Index
  CRUDE_OIL: 'CL=F',          // Crude Oil Futures
  GOLD: 'GC=F',               // Gold Futures
  NIKKEI: '^N225',            // Nikkei 225
  HANG_SENG: '^HSI',          // Hang Seng
  US_10Y: '^TNX'              // US 10-Year Treasury Yield
};

/**
 * Analyze global markets
 * @param {Object} previousGlobalData - Previous cycle data for comparison
 */
async function analyzeGlobalMarkets(previousGlobalData = null) {
  try {
    // 1. Fetch US Futures Data
    const usFutures = await fetchUSFutures();
    
    // 2. Fetch DXY (US Dollar Index)
    const dxyData = await fetchDXY();
    
    // 3. Fetch Crude Oil
    const crudeOil = await fetchCrudeOil();
    
    // 4. Fetch Gold
    const gold = await fetchGold();
    
    // 5. Fetch Asian Markets
    const asianMarkets = await fetchAsianMarkets();
    
    // 6. Fetch US 10-Year Yield
    const us10Y = await fetchUS10Y();
    
    // 7. Calculate Global Risk Sentiment
    const riskSentiment = calculateGlobalRiskSentiment(
      usFutures,
      dxyData,
      crudeOil,
      gold,
      asianMarkets,
      us10Y
    );
    
    // 8. Analyze Correlations
    const correlations = analyzeCorrelations(
      usFutures,
      dxyData,
      crudeOil,
      previousGlobalData
    );
    
    // 9. Calculate Global Markets Score
    const globalScore = calculateGlobalMarketsScore(
      usFutures,
      dxyData,
      crudeOil,
      gold,
      asianMarkets,
      riskSentiment
    );
    
    return {
      us_futures: usFutures,
      dxy: dxyData,
      crude_oil: crudeOil,
      gold: gold,
      asian_markets: asianMarkets,
      us_10y: us10Y,
      risk_sentiment: riskSentiment,
      correlations: correlations,
      global_score: globalScore,
      global_bias: determineGlobalBias(riskSentiment, usFutures),
      trading_implication: getTradingImplication(riskSentiment, usFutures, dxyData, crudeOil)
    };
  } catch (error) {
    logger.error({ error: error.message }, '[globalMarkets] Analysis failed');
    return null;
  }
}

/**
 * Fetch US Futures data
 */
async function fetchUSFutures() {
  try {
    const [sp500, nasdaq, dow] = await Promise.all([
      fetchYahooData(SYMBOLS.SP500_FUTURES),
      fetchYahooData(SYMBOLS.NASDAQ_FUTURES),
      fetchYahooData(SYMBOLS.DOW_FUTURES)
    ]);
    
    return {
      sp500: sp500,
      nasdaq: nasdaq,
      dow: dow,
      avg_change: ((sp500?.changePct || 0) + (nasdaq?.changePct || 0) + (dow?.changePct || 0)) / 3,
      direction: ((sp500?.changePct || 0) + (nasdaq?.changePct || 0) + (dow?.changePct || 0)) > 0 ? 'bullish' : 'bearish',
      strength: Math.abs(((sp500?.changePct || 0) + (nasdaq?.changePct || 0) + (dow?.changePct || 0)) / 3) > 0.5 ? 'strong' : 'weak'
    };
  } catch (error) {
    logger.error({ error: error.message }, '[globalMarkets] US Futures fetch failed');
    return null;
  }
}

/**
 * Fetch DXY (US Dollar Index)
 */
async function fetchDXY() {
  try {
    const data = await fetchYahooData(SYMBOLS.DXY);
    if (!data) return null;  // fetchYahooData returned null (API failed)
    return {
      ...data,
      impact_on_india: data.changePct > 0 ? 'negative' : 'positive', // Strong dollar = negative for India
      strength: Math.abs(data.changePct) > 0.3 ? 'strong' : 'weak'
    };
  } catch (error) {
    logger.error({ error: error.message }, '[globalMarkets] DXY fetch failed');
    return null;
  }
}

/**
 * Fetch Crude Oil
 */
async function fetchCrudeOil() {
  try {
    const data = await fetchYahooData(SYMBOLS.CRUDE_OIL);
    if (!data) return null;  // fetchYahooData returned null (API failed)
    return {
      ...data,
      impact_on_india: data.changePct > 0 ? 'negative' : 'positive', // Higher crude = negative for India (imports 85%)
      severity: Math.abs(data.changePct) > 2 ? 'critical' : Math.abs(data.changePct) > 1 ? 'high' : 'moderate'
    };
  } catch (error) {
    logger.error({ error: error.message }, '[globalMarkets] Crude Oil fetch failed');
    return null;
  }
}

/**
 * Fetch Gold
 */
async function fetchGold() {
  try {
    const data = await fetchYahooData(SYMBOLS.GOLD);
    if (!data) return null;  // fetchYahooData returned null (API failed)
    return {
      ...data,
      risk_sentiment: data.changePct > 0 ? 'risk_off' : 'risk_on', // Gold up = risk-off
      strength: Math.abs(data.changePct) > 1 ? 'strong' : 'weak'
    };
  } catch (error) {
    logger.error({ error: error.message }, '[globalMarkets] Gold fetch failed');
    return null;
  }
}

/**
 * Fetch Asian Markets
 */
async function fetchAsianMarkets() {
  try {
    const [nikkei, hangSeng] = await Promise.all([
      fetchYahooData(SYMBOLS.NIKKEI),
      fetchYahooData(SYMBOLS.HANG_SENG)
    ]);
    
    return {
      nikkei: nikkei,
      hang_seng: hangSeng,
      avg_change: ((nikkei?.changePct || 0) + (hangSeng?.changePct || 0)) / 2,
      direction: ((nikkei?.changePct || 0) + (hangSeng?.changePct || 0)) > 0 ? 'bullish' : 'bearish',
      correlation_with_india: 'moderate' // Asian markets have moderate correlation with India
    };
  } catch (error) {
    logger.error({ error: error.message }, '[globalMarkets] Asian Markets fetch failed');
    return null;
  }
}

/**
 * Fetch US 10-Year Treasury Yield
 */
async function fetchUS10Y() {
  try {
    const data = await fetchYahooData(SYMBOLS.US_10Y);
    
    return {
      ...data,
      impact_on_india: data.changePct > 0 ? 'negative' : 'positive', // Higher yields = FII outflow from India
      severity: Math.abs(data.changePct) > 5 ? 'critical' : Math.abs(data.changePct) > 3 ? 'high' : 'moderate'
    };
  } catch (error) {
    logger.error({ error: error.message }, '[globalMarkets] US 10Y fetch failed');
    return null;
  }
}

/**
 * Fetch data from Yahoo Finance API
 */
async function fetchYahooData(symbol) {
  try {
    const url = `${YAHOO_FINANCE_API}/${symbol}?interval=1d&range=2d`;
    
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    if (!response.data || !response.data.chart || !response.data.chart.result) {
      return null;
    }
    
    const result = response.data.chart.result[0];
    const quote = result.indicators.quote[0];
    const timestamps = result.timestamp;
    
    if (!quote || !timestamps || timestamps.length < 2) {
      return null;
    }
    
    // Get last two data points
    const lastIdx = timestamps.length - 1;
    const prevIdx = lastIdx - 1;
    
    // Use regularMarketPrice if available (most current), otherwise use close array
    const currentPrice = result.meta?.regularMarketPrice || quote.close[lastIdx];
    const previousPrice = quote.close[prevIdx];
    
    if (!currentPrice || !previousPrice) {
      return null;
    }
    
    const change = currentPrice - previousPrice;
    const changePct = (change / previousPrice) * 100;
    
    // Use higher precision for yields (4 decimals), standard for others (2 decimals)
    const isYield = symbol.includes('TNX');
    const priceDecimals = isYield ? 4 : 2;
    
    return {
      symbol: symbol,
      price: Number(currentPrice.toFixed(priceDecimals)),
      change: Number(change.toFixed(priceDecimals)),
      changePct: Number(changePct.toFixed(2)),
      high: quote.high[lastIdx] || null,
      low: quote.low[lastIdx] || null,
      volume: quote.volume[lastIdx] || 0
    };
  } catch (error) {
    logger.error({ error: error.message, symbol }, '[globalMarkets] Yahoo Finance fetch failed');
    return null;
  }
}

/**
 * Calculate Global Risk Sentiment
 */
function calculateGlobalRiskSentiment(usFutures, dxyData, crudeOil, gold, asianMarkets, us10Y) {
  let riskScore = 50; // Start neutral (0-100 scale)
  
  // 1. US Futures (30 points)
  if (usFutures) {
    if (usFutures.direction === 'bullish' && usFutures.strength === 'strong') {
      riskScore += 30; // Risk-on
    } else if (usFutures.direction === 'bearish' && usFutures.strength === 'strong') {
      riskScore -= 30; // Risk-off
    } else if (usFutures.direction === 'bullish') {
      riskScore += 15;
    } else if (usFutures.direction === 'bearish') {
      riskScore -= 15;
    }
  }
  
  // 2. Gold (20 points) - Inverse indicator
  if (gold) {
    if (gold.risk_sentiment === 'risk_off' && gold.strength === 'strong') {
      riskScore -= 20; // Gold up strongly = risk-off
    } else if (gold.risk_sentiment === 'risk_on' && gold.strength === 'strong') {
      riskScore += 20; // Gold down strongly = risk-on
    }
  }
  
  // 3. DXY (15 points) - Strong dollar = risk-off for EM
  if (dxyData) {
    if (dxyData.changePct > 0.3) {
      riskScore -= 15; // Strong dollar = risk-off for India
    } else if (dxyData.changePct < -0.3) {
      riskScore += 15; // Weak dollar = risk-on for India
    }
  }
  
  // 4. Crude Oil (15 points) - Higher crude = negative for India
  if (crudeOil) {
    if (crudeOil.changePct > 2) {
      riskScore -= 15; // Crude spike = negative
    } else if (crudeOil.changePct < -2) {
      riskScore += 15; // Crude drop = positive
    }
  }
  
  // 5. Asian Markets (10 points)
  if (asianMarkets) {
    if (asianMarkets.direction === 'bullish') {
      riskScore += 10;
    } else if (asianMarkets.direction === 'bearish') {
      riskScore -= 10;
    }
  }
  
  // 6. US 10Y Yield (10 points)
  if (us10Y) {
    if (us10Y.changePct > 3) {
      riskScore -= 10; // Yields spike = FII outflow
    } else if (us10Y.changePct < -3) {
      riskScore += 10; // Yields drop = FII inflow
    }
  }
  
  riskScore = Math.max(0, Math.min(100, riskScore));
  
  let sentiment = 'neutral';
  if (riskScore >= 75) sentiment = 'strong_risk_on';
  else if (riskScore >= 60) sentiment = 'risk_on';
  else if (riskScore <= 25) sentiment = 'strong_risk_off';
  else if (riskScore <= 40) sentiment = 'risk_off';
  
  return {
    risk_score: Math.round(riskScore),
    sentiment: sentiment,
    confidence: calculateConfidence(usFutures, dxyData, crudeOil, gold)
  };
}

/**
 * Calculate confidence in risk sentiment
 */
function calculateConfidence(usFutures, dxyData, crudeOil, gold) {
  let dataPoints = 0;
  if (usFutures) dataPoints++;
  if (dxyData) dataPoints++;
  if (crudeOil) dataPoints++;
  if (gold) dataPoints++;
  
  // Confidence based on data availability
  if (dataPoints >= 4) return 'high';
  if (dataPoints >= 3) return 'medium';
  return 'low';
}

/**
 * Analyze correlations
 */
function analyzeCorrelations(usFutures, dxyData, crudeOil, previousGlobalData) {
  const correlations = {
    us_india: 'moderate', // US markets have moderate correlation with India
    dxy_india: 'negative', // Strong dollar = negative for India
    crude_india: 'negative', // Higher crude = negative for India
    consistency: 'unknown'
  };
  
  // Check if all factors point in same direction
  if (usFutures && dxyData && crudeOil) {
    const usBullish = usFutures.direction === 'bullish';
    const dxyWeak = dxyData.changePct < 0;
    const crudeLow = crudeOil.changePct < 0;
    
    // All positive for India?
    if (usBullish && dxyWeak && crudeLow) {
      correlations.consistency = 'all_positive';
    }
    // All negative for India?
    else if (!usBullish && !dxyWeak && !crudeLow) {
      correlations.consistency = 'all_negative';
    }
    // Mixed signals
    else {
      correlations.consistency = 'mixed';
    }
  }
  
  return correlations;
}

/**
 * Calculate Global Markets Score (0-100)
 */
function calculateGlobalMarketsScore(usFutures, dxyData, crudeOil, gold, asianMarkets, riskSentiment) {
  let score = riskSentiment.risk_score; // Start with risk score
  
  // Adjust based on India-specific factors
  
  // 1. Crude Oil impact (critical for India)
  if (crudeOil) {
    if (crudeOil.severity === 'critical' && crudeOil.changePct > 0) {
      score -= 20; // Crude spike = very negative
    } else if (crudeOil.severity === 'critical' && crudeOil.changePct < 0) {
      score += 20; // Crude drop = very positive
    }
  }
  
  // 2. DXY impact (FII flows)
  if (dxyData) {
    if (dxyData.strength === 'strong' && dxyData.changePct > 0) {
      score -= 15; // Strong dollar = FII outflow
    } else if (dxyData.strength === 'strong' && dxyData.changePct < 0) {
      score += 15; // Weak dollar = FII inflow
    }
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determine global bias
 */
function determineGlobalBias(riskSentiment, usFutures) {
  if (riskSentiment.sentiment === 'strong_risk_on') return 'strongly_bullish';
  if (riskSentiment.sentiment === 'risk_on') return 'bullish';
  if (riskSentiment.sentiment === 'strong_risk_off') return 'strongly_bearish';
  if (riskSentiment.sentiment === 'risk_off') return 'bearish';
  return 'neutral';
}

/**
 * Get trading implications
 */
function getTradingImplication(riskSentiment, usFutures, dxyData, crudeOil) {
  if (riskSentiment.sentiment === 'strong_risk_on') {
    return 'Strong global risk-on - US futures up, dollar weak, crude stable - favor longs';
  }
  
  if (riskSentiment.sentiment === 'strong_risk_off') {
    return 'Strong global risk-off - US futures down, dollar strong, safe haven bid - avoid longs';
  }
  
  if (crudeOil && crudeOil.severity === 'critical' && crudeOil.changePct > 2) {
    return 'Crude oil spiking - negative for India (85% import) - bearish bias';
  }
  
  if (dxyData && dxyData.strength === 'strong' && dxyData.changePct > 0.5) {
    return 'Dollar strengthening - FII outflow risk - reduce exposure';
  }
  
  if (usFutures && usFutures.direction === 'bullish' && usFutures.strength === 'strong') {
    return 'US futures strong - positive global sentiment - favor longs';
  }
  
  return 'Mixed global signals - trade with caution';
}

/**
 * Calculate global markets score for master algorithm (0-100)
 */
function calculateGlobalMarketsScoreForMaster(globalData, direction) {
  if (!globalData) return 50; // Neutral
  
  let score = globalData.global_score; // Start with base score
  
  // 1. Risk sentiment alignment (30 points)
  if (direction === 'bullish') {
    if (globalData.risk_sentiment.sentiment === 'strong_risk_on') {
      score += 30;
    } else if (globalData.risk_sentiment.sentiment === 'risk_on') {
      score += 20;
    } else if (globalData.risk_sentiment.sentiment.includes('risk_off')) {
      score -= 20;
    }
  } else if (direction === 'bearish') {
    if (globalData.risk_sentiment.sentiment === 'strong_risk_off') {
      score += 30;
    } else if (globalData.risk_sentiment.sentiment === 'risk_off') {
      score += 20;
    } else if (globalData.risk_sentiment.sentiment.includes('risk_on')) {
      score -= 20;
    }
  }
  
  // 2. US Futures alignment (20 points)
  if (globalData.us_futures) {
    if (direction === 'bullish' && globalData.us_futures.direction === 'bullish') {
      score += 20;
    } else if (direction === 'bearish' && globalData.us_futures.direction === 'bearish') {
      score += 20;
    } else if (direction === 'bullish' && globalData.us_futures.direction === 'bearish') {
      score -= 15;
    } else if (direction === 'bearish' && globalData.us_futures.direction === 'bullish') {
      score -= 15;
    }
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  analyzeGlobalMarkets,
  calculateGlobalMarketsScoreForMaster
};
