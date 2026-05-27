/**
 * Market Internals Analysis
 * Used by: Institutional traders, Market makers, Professional funds
 * 
 * Analyzes market breadth, advance/decline ratio, sector participation,
 * NIFTY breadth, BankNIFTY participation, FII/DII flows, and market health
 * 
 * CRITICAL FOR UNDERSTANDING MARKET STRENGTH AND INSTITUTIONAL POSITIONING
 */
const logger = require('../../utils/logger');
const dhanBypass = require('../dhanProd.service');
const axios = require('axios');
const securityMaster = require('../securityMaster.service');

// FII/DII Data API endpoint (Sensibull)
const FII_DII_API = 'https://oxide.sensibull.com/v1/compute/cache/fii_dii_daily';

// ============================================================
// OPTIMIZATION 2: FII/DII Data Cache (Save 2-3 seconds)
// FII/DII data updates once per day, not intraday
// Cache for 5 minutes to avoid repeated API calls
// ============================================================
const fiiDiiCache = {
  data: null,
  timestamp: 0,
  ttl: 5 * 60 * 1000 // 5 minutes
};

// NIFTY 50 constituent security IDs (top 10 for quick analysis)
// NOTE: Security IDs are currently NULL - need to be fetched from Dhan API
// Market Internals will work with FII/DII data even without stock data
const NIFTY_TOP_10 = securityMaster.getNiftyTop10();

const BANKNIFTY_SECURITY_ID = securityMaster.getIndexSecurityId('BANKNIFTY');

/**
 * Analyze market internals (with FII/DII institutional flows)
 * @param {string} authKey - Dhan Bypass auth key
 * @param {number} niftySpotPrice - Current NIFTY spot price
 * @param {Object} previousInternals - Previous cycle data
 */
async function analyzeMarketInternals(authKey, niftySpotPrice, previousInternals = null) {
  try {
    // 1. Fetch BankNIFTY data
    const bankNiftyData = await fetchBankNiftyData(authKey);
    
    // 2. Fetch top 10 NIFTY stocks data (OPTIONAL - graceful degradation)
    // If security IDs are not available, skip stock analysis
    const hasValidSecurityIds = NIFTY_TOP_10.some(stock => stock.securityId !== null);
    let topStocksData = [];
    
    if (hasValidSecurityIds) {
      topStocksData = await fetchTopStocksData(authKey);
    } else {
      logger.warn('[marketInternals] Security IDs not configured - skipping stock breadth analysis');
    }
    
    // 3. Fetch FII/DII institutional flow data (PRIMARY FOCUS!)
    const institutionalFlow = await fetchInstitutionalFlowData();
    
    // 4. Calculate Advance/Decline Ratio (if stock data available)
    const advanceDecline = topStocksData.length > 0 
      ? calculateAdvanceDecline(topStocksData)
      : getDefaultAdvanceDecline();
    
    // 5. Calculate Market Breadth (if stock data available)
    const marketBreadth = topStocksData.length > 0
      ? calculateMarketBreadth(topStocksData, niftySpotPrice)
      : getDefaultMarketBreadth();
    
    // 6. Analyze BankNIFTY Participation
    const bankNiftyParticipation = analyzeBankNiftyParticipation(
      bankNiftyData,
      niftySpotPrice,
      previousInternals
    );
    
    // 7. Calculate Sector Strength (if stock data available)
    const sectorStrength = topStocksData.length > 0
      ? calculateSectorStrength(topStocksData)
      : getDefaultSectorStrength();
    
    // 8. Analyze Market Leadership (if stock data available)
    const marketLeadership = topStocksData.length > 0
      ? analyzeMarketLeadership(topStocksData, bankNiftyData)
      : getDefaultMarketLeadership();
    
    // 9. Analyze FII/DII Flows (PRIMARY ANALYSIS!)
    const fiiDiiAnalysis = analyzeInstitutionalFlows(institutionalFlow);
    
    // 10. Calculate Market Health Score (with FII/DII as primary factor)
    const marketHealthScore = calculateMarketHealthScore(
      advanceDecline,
      marketBreadth,
      bankNiftyParticipation,
      sectorStrength,
      fiiDiiAnalysis
    );
    
    return {
      advance_decline: advanceDecline,
      market_breadth: marketBreadth,
      banknifty_participation: bankNiftyParticipation,
      sector_strength: sectorStrength,
      market_leadership: marketLeadership,
      fii_dii_flow: fiiDiiAnalysis, // PRIMARY!
      institutional_flow_raw: institutionalFlow, // For AI validation
      market_internals_score: marketHealthScore,
      market_health: determineMarketHealth(marketHealthScore),
      trading_implication: getTradingImplication(marketHealthScore, advanceDecline, bankNiftyParticipation, fiiDiiAnalysis),
      stock_data_available: topStocksData.length > 0
    };
  } catch (error) {
    logger.error({ error: error.message }, '[marketInternals] Analysis failed');
    return null;
  }
}

/**
 * Fetch BankNIFTY data
 */
async function fetchBankNiftyData(authKey) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const fiveMinAgo = now - (5 * 60);
    
    const res = await dhanBypass.getDhanBypassData(authKey, {
      securityId: BANKNIFTY_SECURITY_ID,
      exchange: 'IDX',
      segment: 'I',
      instrument: 'IDX',
      startTime: fiveMinAgo,
      endTime: now,
      interval: '1',
    });
    
    if (!res.ok || !res.data.candles || res.data.candles.length === 0) {
      return null;
    }
    
    const candles = res.data.candles;
    const lastCandle = candles[candles.length - 1];
    const firstCandle = candles[0];
    
    return {
      ltp: lastCandle.close,
      open: firstCandle.open,
      high: Math.max(...candles.map(c => c.high)),
      low: Math.min(...candles.map(c => c.low)),
      change: lastCandle.close - firstCandle.open,
      changePct: ((lastCandle.close - firstCandle.open) / firstCandle.open) * 100,
      volume: candles.reduce((sum, c) => sum + (c.volume || 0), 0),
      candles: candles
    };
  } catch (error) {
    logger.error({ error: error.message }, '[marketInternals] BankNIFTY fetch failed');
    return null;
  }
}

/**
 * Fetch top 10 NIFTY stocks data
 */
async function fetchTopStocksData(authKey) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const fiveMinAgo = now - (5 * 60);
    
    // Filter out stocks with null security IDs
    const validStocks = NIFTY_TOP_10.filter(stock => stock.securityId !== null);
    
    if (validStocks.length === 0) {
      logger.warn('[marketInternals] No valid security IDs available for stock analysis');
      return [];
    }
    
    // OPTIMIZATION: Disable stock fetching to prevent rate limits
    // This function makes 10+ API calls per cycle
    logger.debug('[marketInternals] Stock analysis DISABLED (rate limit optimization)');
    return [];
    
    /* ORIGINAL CODE - COMMENTED OUT TO PREVENT RATE LIMITS
    // Fetch data for all valid stocks in parallel
    const promises = validStocks.map(async (stock) => {
      try {
        const res = await dhanBypass.getDhanBypassData(authKey, {
          securityId: stock.securityId,
          exchange: 'NSE',
          segment: 'E',
          instrument: 'EQUITY',
          startTime: fiveMinAgo,
          endTime: now,
          interval: '1',
        });
        
        if (!res.ok || !res.data.candles || res.data.candles.length === 0) {
          return null;
        }
        
        const candles = res.data.candles;
        const lastCandle = candles[candles.length - 1];
        const firstCandle = candles[0];
        
        return {
          name: stock.name,
          symbol: stock.symbol,
          securityId: stock.securityId,
          ltp: lastCandle.close,
          open: firstCandle.open,
          high: Math.max(...candles.map(c => c.high)),
          low: Math.min(...candles.map(c => c.low)),
          change: lastCandle.close - firstCandle.open,
          changePct: ((lastCandle.close - firstCandle.open) / firstCandle.open) * 100,
          volume: candles.reduce((sum, c) => sum + (c.volume || 0), 0),
          sector: stock.sector
        };
      } catch (error) {
        logger.error({ error: error.message, stock: stock.name }, '[marketInternals] Stock fetch failed');
        return null;
      }
    });
    
    const results = await Promise.all(promises);
    return results.filter(r => r !== null);
    */
  } catch (error) {
    logger.error({ error: error.message }, '[marketInternals] Top stocks fetch failed');
    return [];
  }
}

/**
 * Get sector for stock
 */
function getSector(stockName) {
  const stock = NIFTY_TOP_10.find(s => s.name === stockName);
  return stock ? stock.sector : 'Other';
}

/**
 * Calculate Advance/Decline Ratio
 */
function calculateAdvanceDecline(topStocksData) {
  if (!topStocksData || topStocksData.length === 0) {
    return {
      advancing: 0,
      declining: 0,
      unchanged: 0,
      ad_ratio: 1,
      ad_line: 0,
      market_bias: 'neutral'
    };
  }
  
  let advancing = 0;
  let declining = 0;
  let unchanged = 0;
  
  topStocksData.forEach(stock => {
    if (stock.changePct > 0.1) advancing++;
    else if (stock.changePct < -0.1) declining++;
    else unchanged++;
  });
  
  const adRatio = declining > 0 ? advancing / declining : advancing;
  const adLine = advancing - declining;
  
  let marketBias = 'neutral';
  if (adRatio > 2) marketBias = 'strongly_bullish';
  else if (adRatio > 1.5) marketBias = 'bullish';
  else if (adRatio < 0.5) marketBias = 'strongly_bearish';
  else if (adRatio < 0.67) marketBias = 'bearish';
  
  return {
    advancing,
    declining,
    unchanged,
    ad_ratio: Number(adRatio.toFixed(2)),
    ad_line: adLine,
    market_bias: marketBias,
    total_stocks: topStocksData.length
  };
}

/**
 * Calculate Market Breadth
 */
function calculateMarketBreadth(topStocksData, niftySpotPrice) {
  if (!topStocksData || topStocksData.length === 0) {
    return {
      pct_above_open: 0,
      pct_green: 0,
      pct_strong_green: 0,
      breadth_score: 50,
      breadth_quality: 'neutral'
    };
  }
  
  let aboveOpen = 0;
  let green = 0;
  let strongGreen = 0; // >1% gain
  
  topStocksData.forEach(stock => {
    if (stock.ltp > stock.open) aboveOpen++;
    if (stock.changePct > 0) green++;
    if (stock.changePct > 1) strongGreen++;
  });
  
  const total = topStocksData.length;
  const pctAboveOpen = (aboveOpen / total) * 100;
  const pctGreen = (green / total) * 100;
  const pctStrongGreen = (strongGreen / total) * 100;
  
  // Breadth score (0-100)
  const breadthScore = (pctGreen * 0.5) + (pctAboveOpen * 0.3) + (pctStrongGreen * 0.2);
  
  let breadthQuality = 'neutral';
  if (breadthScore > 75) breadthQuality = 'excellent';
  else if (breadthScore > 60) breadthQuality = 'good';
  else if (breadthScore < 25) breadthQuality = 'poor';
  else if (breadthScore < 40) breadthQuality = 'weak';
  
  return {
    pct_above_open: Number(pctAboveOpen.toFixed(1)),
    pct_green: Number(pctGreen.toFixed(1)),
    pct_strong_green: Number(pctStrongGreen.toFixed(1)),
    breadth_score: Math.round(breadthScore),
    breadth_quality: breadthQuality
  };
}

/**
 * Analyze BankNIFTY Participation
 */
function analyzeBankNiftyParticipation(bankNiftyData, niftySpotPrice, previousInternals) {
  if (!bankNiftyData) {
    return {
      participating: false,
      correlation: 0,
      relative_strength: 0,
      leadership: 'none',
      participation_quality: 'unknown'
    };
  }
  
  // Calculate if BankNIFTY is participating
  const bankNiftyChangePct = bankNiftyData.changePct;
  const participating = Math.abs(bankNiftyChangePct) > 0.1;
  
  // Estimate NIFTY change (we don't have previous NIFTY data, so use approximation)
  // In real implementation, you'd track NIFTY change from previous cycle
  const niftyChangePct = previousInternals?.nifty_change_pct || 0;
  
  // Correlation (simplified - same direction?)
  const sameDirection = (bankNiftyChangePct > 0 && niftyChangePct > 0) ||
                        (bankNiftyChangePct < 0 && niftyChangePct < 0);
  const correlation = sameDirection ? 0.8 : -0.3;
  
  // Relative strength (BankNIFTY vs NIFTY)
  const relativeStrength = bankNiftyChangePct - niftyChangePct;
  
  // Leadership
  let leadership = 'none';
  if (Math.abs(bankNiftyChangePct) > Math.abs(niftyChangePct) * 1.2) {
    leadership = bankNiftyChangePct > 0 ? 'bullish_leader' : 'bearish_leader';
  } else if (Math.abs(bankNiftyChangePct) < Math.abs(niftyChangePct) * 0.8) {
    leadership = 'lagging';
  } else {
    leadership = 'in_sync';
  }
  
  // Participation quality
  let participationQuality = 'weak';
  if (participating && Math.abs(correlation) > 0.7) {
    participationQuality = 'strong';
  } else if (participating) {
    participationQuality = 'moderate';
  }
  
  return {
    participating,
    banknifty_change_pct: Number(bankNiftyChangePct.toFixed(2)),
    correlation: Number(correlation.toFixed(2)),
    relative_strength: Number(relativeStrength.toFixed(2)),
    leadership,
    participation_quality: participationQuality
  };
}

/**
 * Calculate Sector Strength
 */
function calculateSectorStrength(topStocksData) {
  if (!topStocksData || topStocksData.length === 0) {
    return {
      sectors: [],
      strongest_sector: null,
      weakest_sector: null,
      sector_rotation: 'none'
    };
  }
  
  // Group by sector
  const sectorMap = {};
  topStocksData.forEach(stock => {
    if (!sectorMap[stock.sector]) {
      sectorMap[stock.sector] = {
        sector: stock.sector,
        stocks: [],
        avg_change: 0,
        advancing: 0,
        declining: 0
      };
    }
    sectorMap[stock.sector].stocks.push(stock);
    if (stock.changePct > 0) sectorMap[stock.sector].advancing++;
    else if (stock.changePct < 0) sectorMap[stock.sector].declining++;
  });
  
  // Calculate sector averages
  const sectors = Object.values(sectorMap).map(sector => {
    const avgChange = sector.stocks.reduce((sum, s) => sum + s.changePct, 0) / sector.stocks.length;
    return {
      sector: sector.sector,
      avg_change: Number(avgChange.toFixed(2)),
      stock_count: sector.stocks.length,
      advancing: sector.advancing,
      declining: sector.declining,
      strength: avgChange > 0.5 ? 'strong' : avgChange > 0 ? 'moderate' : avgChange > -0.5 ? 'weak' : 'very_weak'
    };
  });
  
  // Sort by strength
  sectors.sort((a, b) => b.avg_change - a.avg_change);
  
  const strongestSector = sectors[0] || null;
  const weakestSector = sectors[sectors.length - 1] || null;
  
  // Detect sector rotation
  let sectorRotation = 'none';
  if (strongestSector && strongestSector.sector === 'Banking') {
    sectorRotation = 'banking_leadership';
  } else if (strongestSector && strongestSector.sector === 'IT') {
    sectorRotation = 'it_leadership';
  } else if (weakestSector && weakestSector.sector === 'Banking') {
    sectorRotation = 'defensive_rotation';
  }
  
  return {
    sectors,
    strongest_sector: strongestSector,
    weakest_sector: weakestSector,
    sector_rotation: sectorRotation
  };
}

/**
 * Analyze Market Leadership
 */
function analyzeMarketLeadership(topStocksData, bankNiftyData) {
  if (!topStocksData || topStocksData.length === 0) {
    return {
      leaders: [],
      laggards: [],
      leadership_quality: 'weak'
    };
  }
  
  // Sort by change %
  const sorted = [...topStocksData].sort((a, b) => b.changePct - a.changePct);
  
  const leaders = sorted.slice(0, 3).map(s => ({
    name: s.name,
    change_pct: s.changePct,
    sector: s.sector
  }));
  
  const laggards = sorted.slice(-3).map(s => ({
    name: s.name,
    change_pct: s.changePct,
    sector: s.sector
  }));
  
  // Leadership quality
  const topChange = leaders[0]?.change_pct || 0;
  const bottomChange = laggards[0]?.change_pct || 0;
  const spread = topChange - bottomChange;
  
  let leadershipQuality = 'weak';
  if (spread > 2) leadershipQuality = 'strong';
  else if (spread > 1) leadershipQuality = 'moderate';
  
  return {
    leaders,
    laggards,
    leadership_quality: leadershipQuality,
    spread: Number(spread.toFixed(2))
  };
}

/**
 * Fetch FII/DII institutional flow data from Sensibull API (WITH CACHING)
 * OPTIMIZATION 2: Cache for 5 minutes (FII/DII data updates once per day)
 */
async function fetchInstitutionalFlowData() {
  try {
    // Check cache first (OPTIMIZATION 2)
    const now = Date.now();
    if (fiiDiiCache.data && (now - fiiDiiCache.timestamp) < fiiDiiCache.ttl) {
      logger.debug('[marketInternals] Using cached FII/DII data (saves 2-3s)');
      return fiiDiiCache.data;
    }
    
    logger.info('[marketInternals] Fetching fresh FII/DII data from Sensibull API');
    
    const response = await axios.get(FII_DII_API, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      }
    });
    
    if (!response.data) {
      logger.warn('[marketInternals] FII/DII data unavailable from Sensibull');
      return null;
    }

    // Sensibull payload schema (current):
    //   { year_month: '2026-May', key_list: [...], data: { 'YYYY-MM-DD': { cash, future, option, ... } } }
    // Older / alt schema (kept for backwards compat):
    //   { 'YYYY-MM-DD': { ... } }
    const buckets = (response.data && typeof response.data === 'object' && response.data.data && typeof response.data.data === 'object')
      ? response.data.data
      : response.data;

    // Filter to only valid YYYY-MM-DD keys (defensive — protects against
    // wrapper keys like 'year_month' / 'key_list' leaking through).
    const dates = Object.keys(buckets || {})
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort()
      .reverse();

    if (dates.length === 0) {
      logger.warn({ topKeys: Object.keys(response.data || {}).slice(0, 6) },
        '[marketInternals] No FII/DII dates available (schema unrecognised)');
      return null;
    }

    const todayDate = dates[0]; // Most recent date
    const todayData = buckets[todayDate];
    
    if (!todayData) {
      logger.warn('[marketInternals] No FII/DII data for today');
      return null;
    }
    
    logger.info({ 
      date: todayDate,
      nifty: todayData.nifty,
      fiiCashAction: todayData.cash?.fii?.net_action,
      diiCashAction: todayData.cash?.dii?.net_action,
      cached: true
    }, '[marketInternals] FII/DII data fetched and cached');
    
    // Return structured data
    const structuredData = {
      date: todayData.date || todayDate,
      nifty: todayData.nifty,
      nifty_change_percent: todayData.nifty_change_percent || 0,
      banknifty: todayData.banknifty,
      banknifty_change_percent: todayData.banknifty_change_percent || 0,
      cash: {
        fii: {
          buy_sell_difference: todayData.cash?.fii?.buy_sell_difference || 0,
          buy: todayData.cash?.fii?.buy || 0,
          sell: todayData.cash?.fii?.sell || 0,
          net_action: todayData.cash?.fii?.net_action || 'unknown',
          net_view: todayData.cash?.fii?.net_view || 'unknown',
          net_view_strength: todayData.cash?.fii?.net_view_strength || 'unknown'
        },
        dii: {
          buy_sell_difference: todayData.cash?.dii?.buy_sell_difference || 0,
          buy: todayData.cash?.dii?.buy || 0,
          sell: todayData.cash?.dii?.sell || 0,
          net_action: todayData.cash?.dii?.net_action || 'unknown',
          net_view: todayData.cash?.dii?.net_view || 'unknown',
          net_view_strength: todayData.cash?.dii?.net_view_strength || 'unknown'
        }
      },
      future: {
        fii: todayData.future?.fii || {},
        dii: todayData.future?.dii || {},
        pro: todayData.future?.pro || {},
        client: todayData.future?.client || {}
      },
      option: {
        fii: todayData.option?.fii || {},
        dii: todayData.option?.dii || {},
        pro: todayData.option?.pro || {},
        client: todayData.option?.client || {}
      },
      next_market_open: todayData.next_market_open
    };
    
    // Update cache (OPTIMIZATION 2)
    fiiDiiCache.data = structuredData;
    fiiDiiCache.timestamp = now;
    
    return structuredData;
  } catch (error) {
    logger.error({ 
      error: error.message,
      url: FII_DII_API,
      stack: error.stack 
    }, '[marketInternals] FII/DII fetch failed from Sensibull');
    
    // Return null on error - system will continue without FII/DII data
    return null;
  }
}

/**
 * Analyze FII/DII institutional flows (hardened — Sensibull schema changes often)
 */
function analyzeInstitutionalFlows(flowData) {
  const unknownResult = {
    fii_cash_action: 'unknown',
    dii_cash_action: 'unknown',
    fii_futures_action: 'unknown',
    dii_futures_action: 'unknown',
    fii_options_action: 'unknown',
    dii_options_action: 'unknown',
    institutional_consensus: 'unknown',
    flow_strength: 'unknown',
    divergence_detected: false,
    trading_implication: 'No institutional flow data available'
  };

  if (!flowData) return unknownResult;

  try {
    // 1. Cash Market Actions (nullsafe all the way down)
    const fiiCash = flowData?.cash?.fii || {};
    const diiCash = flowData?.cash?.dii || {};
    const fiiCashAction = fiiCash.net_action || 'unknown';
    const diiCashAction = diiCash.net_action || 'unknown';
    const fiiCashAmount = Number(fiiCash.buy_sell_difference) || 0;
    const diiCashAmount = Number(diiCash.buy_sell_difference) || 0;

    // 2. Futures Actions — Sensibull uses 'quantity-wise' key (with hyphen)
    //    but some responses omit it. Check both common shapes.
    const fiiFut = flowData?.future?.fii || {};
    const diiFut = flowData?.future?.dii || {};
    const fiiFutQty = fiiFut['quantity-wise'] || fiiFut.quantity_wise || fiiFut || {};
    const diiFutQty = diiFut['quantity-wise'] || diiFut.quantity_wise || diiFut || {};
    const fiiFuturesAction = fiiFutQty.net_action || 'unknown';
    const diiFuturesAction = diiFutQty.net_action || 'unknown';
    const fiiFuturesNetOI = Number(fiiFutQty.net_oi) || 0;
    const diiFuturesNetOI = Number(diiFutQty.net_oi) || 0;

    // 3. Options Actions — schema uses overall_net_oi_change_action on option.fii/dii
    const fiiOpt = flowData?.option?.fii || {};
    const diiOpt = flowData?.option?.dii || {};
    const fiiOptionsAction = fiiOpt.overall_net_oi_change_action || 'unknown';
    const diiOptionsAction = diiOpt.overall_net_oi_change_action || 'unknown';
    const fiiOptionsNetOI = Number(fiiOpt.overall_net_oi_change) || 0;
    const diiOptionsNetOI = Number(diiOpt.overall_net_oi_change) || 0;

    // 4. Calculate Institutional Consensus
    const institutionalConsensus = calculateInstitutionalConsensus(
      fiiCashAction,
      diiCashAction,
      fiiFuturesAction,
      diiFuturesAction
    );

    // 5. Calculate Flow Strength
    const flowStrength = calculateFlowStrength(
      fiiCashAmount,
      diiCashAmount,
      fiiFuturesNetOI,
      diiFuturesNetOI
    );

    // 6. Detect Divergence (FII selling + DII buying = support)
    const divergenceDetected = detectDivergence(
      fiiCashAction,
      diiCashAction,
      fiiFuturesAction,
      diiFuturesAction
    );

    // 7. Get Trading Implication
    const tradingImplication = getInstitutionalTradingImplication(
      institutionalConsensus,
      flowStrength,
      divergenceDetected,
      fiiCashAction,
      diiCashAction
    );

    return {
      fii_cash_action: fiiCashAction,
      fii_cash_amount: Number(fiiCashAmount.toFixed(2)),
      dii_cash_action: diiCashAction,
      dii_cash_amount: Number(diiCashAmount.toFixed(2)),
      fii_futures_action: fiiFuturesAction,
      fii_futures_net_oi: fiiFuturesNetOI,
      dii_futures_action: diiFuturesAction,
      dii_futures_net_oi: diiFuturesNetOI,
      fii_options_action: fiiOptionsAction,
      fii_options_net_oi: fiiOptionsNetOI,
      dii_options_action: diiOptionsAction,
      dii_options_net_oi: diiOptionsNetOI,
      institutional_consensus: institutionalConsensus,
      flow_strength: flowStrength,
      divergence_detected: divergenceDetected,
      divergence_type: divergenceDetected ? getDivergenceType(fiiCashAction, diiCashAction) : 'none',
      trading_implication: tradingImplication
    };
  } catch (err) {
    logger.warn({ err: err.message }, '[marketInternals] analyzeInstitutionalFlows fell back to unknown (schema drift)');
    return unknownResult;
  }
}

/**
 * Calculate institutional consensus
 */
function calculateInstitutionalConsensus(fiiCash, diiCash, fiiFutures, diiFutures) {
  const actions = [fiiCash, diiCash, fiiFutures, diiFutures].filter(a => a === 'BUY' || a === 'SELL');
  
  if (actions.length === 0) return 'unknown';
  
  const buyCount = actions.filter(a => a === 'BUY').length;
  const sellCount = actions.filter(a => a === 'SELL').length;
  
  if (buyCount >= 3) return 'strong_bullish';
  if (buyCount === 2 && sellCount === 2) return 'neutral';
  if (sellCount >= 3) return 'strong_bearish';
  if (buyCount > sellCount) return 'bullish';
  if (sellCount > buyCount) return 'bearish';
  
  return 'neutral';
}

/**
 * Calculate flow strength
 */
function calculateFlowStrength(fiiCashAmt, diiCashAmt, fiiFuturesOI, diiFuturesOI) {
  // Calculate total flow magnitude
  const totalCashFlow = Math.abs(fiiCashAmt) + Math.abs(diiCashAmt);
  const totalFuturesFlow = Math.abs(fiiFuturesOI) + Math.abs(diiFuturesOI);
  
  // Thresholds (in crores for cash, contracts for futures)
  const strongCashThreshold = 3000; // 3000 crores
  const strongFuturesThreshold = 10000; // 10000 contracts
  
  if (totalCashFlow > strongCashThreshold || totalFuturesFlow > strongFuturesThreshold) {
    return 'strong';
  } else if (totalCashFlow > strongCashThreshold * 0.5 || totalFuturesFlow > strongFuturesThreshold * 0.5) {
    return 'moderate';
  }
  
  return 'weak';
}

/**
 * Detect divergence between FII and DII
 */
function detectDivergence(fiiCash, diiCash, fiiFutures, diiFutures) {
  // Divergence = FII and DII taking opposite positions
  const cashDivergence = (fiiCash === 'BUY' && diiCash === 'SELL') || (fiiCash === 'SELL' && diiCash === 'BUY');
  const futuresDivergence = (fiiFutures === 'BUY' && diiFutures === 'SELL') || (fiiFutures === 'SELL' && diiFutures === 'BUY');
  
  return cashDivergence || futuresDivergence;
}

/**
 * Get divergence type
 */
function getDivergenceType(fiiCash, diiCash) {
  if (fiiCash === 'SELL' && diiCash === 'BUY') {
    return 'fii_selling_dii_buying'; // DII providing support
  } else if (fiiCash === 'BUY' && diiCash === 'SELL') {
    return 'fii_buying_dii_selling'; // FII leading, DII booking profits
  }
  return 'none';
}

/**
 * Get institutional trading implication
 */
function getInstitutionalTradingImplication(consensus, strength, divergence, fiiCash, diiCash) {
  if (consensus === 'strong_bullish' && strength === 'strong') {
    return 'Strong institutional buying - bullish setup';
  }
  
  if (consensus === 'strong_bearish' && strength === 'strong') {
    return 'Strong institutional selling - bearish setup';
  }
  
  if (divergence && fiiCash === 'SELL' && diiCash === 'BUY') {
    return 'FII selling but DII buying - domestic support present';
  }
  
  if (divergence && fiiCash === 'BUY' && diiCash === 'SELL') {
    return 'FII buying but DII selling - foreign interest strong';
  }
  
  if (consensus === 'neutral') {
    return 'Mixed institutional flows - no clear direction';
  }
  
  return 'Moderate institutional activity - trade with caution';
}

/**
 * Calculate Market Health Score (with FII/DII)
 */
function calculateMarketHealthScore(advanceDecline, marketBreadth, bankNiftyParticipation, sectorStrength, fiiDiiAnalysis) {
  let score = 50; // Start neutral
  
  // 1. Advance/Decline (25 points)
  if (advanceDecline.market_bias === 'strongly_bullish') score += 25;
  else if (advanceDecline.market_bias === 'bullish') score += 15;
  else if (advanceDecline.market_bias === 'strongly_bearish') score -= 25;
  else if (advanceDecline.market_bias === 'bearish') score -= 15;
  
  // 2. Market Breadth (25 points)
  if (marketBreadth.breadth_quality === 'excellent') score += 25;
  else if (marketBreadth.breadth_quality === 'good') score += 15;
  else if (marketBreadth.breadth_quality === 'poor') score -= 25;
  else if (marketBreadth.breadth_quality === 'weak') score -= 15;
  
  // 3. BankNIFTY Participation (20 points)
  if (bankNiftyParticipation.participation_quality === 'strong') score += 20;
  else if (bankNiftyParticipation.participation_quality === 'moderate') score += 10;
  else if (bankNiftyParticipation.participation_quality === 'weak') score -= 10;
  
  // 4. Sector Strength (10 points)
  if (sectorStrength.strongest_sector && sectorStrength.strongest_sector.avg_change > 1) {
    score += 10;
  } else if (sectorStrength.weakest_sector && sectorStrength.weakest_sector.avg_change < -1) {
    score -= 10;
  }
  
  // 5. FII/DII Institutional Flows (20 points) - NEW!
  if (fiiDiiAnalysis) {
    if (fiiDiiAnalysis.institutional_consensus === 'strong_bullish' && fiiDiiAnalysis.flow_strength === 'strong') {
      score += 20;
    } else if (fiiDiiAnalysis.institutional_consensus === 'bullish') {
      score += 10;
    } else if (fiiDiiAnalysis.institutional_consensus === 'strong_bearish' && fiiDiiAnalysis.flow_strength === 'strong') {
      score -= 20;
    } else if (fiiDiiAnalysis.institutional_consensus === 'bearish') {
      score -= 10;
    }
    
    // Bonus: DII support during FII selling
    if (fiiDiiAnalysis.divergence_detected && fiiDiiAnalysis.divergence_type === 'fii_selling_dii_buying') {
      score += 5; // Domestic support is positive
    }
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determine market health
 */
function determineMarketHealth(marketHealthScore) {
  if (marketHealthScore >= 80) return 'excellent';
  if (marketHealthScore >= 65) return 'good';
  if (marketHealthScore >= 50) return 'fair';
  if (marketHealthScore >= 35) return 'poor';
  return 'critical';
}

/**
 * Get trading implications (with FII/DII)
 */
function getTradingImplication(marketHealthScore, advanceDecline, bankNiftyParticipation, fiiDiiAnalysis) {
  // Priority 1: FII/DII institutional flows
  if (fiiDiiAnalysis && fiiDiiAnalysis.institutional_consensus === 'strong_bullish' && fiiDiiAnalysis.flow_strength === 'strong') {
    return 'Strong institutional buying across cash/futures - high conviction bullish setup';
  }
  
  if (fiiDiiAnalysis && fiiDiiAnalysis.institutional_consensus === 'strong_bearish' && fiiDiiAnalysis.flow_strength === 'strong') {
    return 'Strong institutional selling across cash/futures - high conviction bearish setup';
  }
  
  if (fiiDiiAnalysis && fiiDiiAnalysis.divergence_detected && fiiDiiAnalysis.divergence_type === 'fii_selling_dii_buying') {
    return 'FII selling but DII providing support - domestic institutions absorbing supply';
  }
  
  // Priority 2: Market health
  if (marketHealthScore >= 80) {
    return 'Excellent market health with strong breadth and institutional support';
  }
  
  if (marketHealthScore >= 65) {
    return 'Good market health - favorable conditions for trading';
  }
  
  // Priority 3: Specific patterns
  if (advanceDecline.market_bias === 'strongly_bearish' && bankNiftyParticipation.leadership === 'bearish_leader') {
    return 'Broad market weakness with banking leading down - favor shorts';
  }
  
  if (advanceDecline.market_bias === 'strongly_bullish' && bankNiftyParticipation.leadership === 'bullish_leader') {
    return 'Broad market strength with banking leading up - favor longs';
  }
  
  if (marketHealthScore < 35) {
    return 'Poor market health - reduce size or avoid trading';
  }
  
  return 'Mixed market internals - trade with caution';
}

/**
 * Calculate market internals score for master algorithm (0-100) with FII/DII
 */
function calculateMarketInternalsScoreForMaster(internalsData, direction) {
  if (!internalsData) return 50; // Neutral
  
  let score = internalsData.market_internals_score; // Start with base score
  
  // 1. Advance/Decline alignment (20 points)
  if (direction === 'bullish') {
    if (internalsData.advance_decline.market_bias === 'strongly_bullish') score += 20;
    else if (internalsData.advance_decline.market_bias === 'bullish') score += 10;
    else if (internalsData.advance_decline.market_bias.includes('bearish')) score -= 15;
  } else if (direction === 'bearish') {
    if (internalsData.advance_decline.market_bias === 'strongly_bearish') score += 20;
    else if (internalsData.advance_decline.market_bias === 'bearish') score += 10;
    else if (internalsData.advance_decline.market_bias.includes('bullish')) score -= 15;
  }
  
  // 2. BankNIFTY participation alignment (10 points)
  if (internalsData.banknifty_participation.participating) {
    if (direction === 'bullish' && internalsData.banknifty_participation.leadership === 'bullish_leader') {
      score += 10;
    } else if (direction === 'bearish' && internalsData.banknifty_participation.leadership === 'bearish_leader') {
      score += 10;
    }
  }
  
  // 3. Market breadth quality (10 points)
  if (internalsData.market_breadth.breadth_quality === 'excellent') {
    score += 10;
  } else if (internalsData.market_breadth.breadth_quality === 'poor') {
    score -= 10;
  }
  
  // 4. FII/DII institutional flow alignment (10 points) - NEW!
  if (internalsData.fii_dii_flow) {
    const consensus = internalsData.fii_dii_flow.institutional_consensus;
    
    if (direction === 'bullish') {
      if (consensus === 'strong_bullish') score += 10;
      else if (consensus === 'bullish') score += 5;
      else if (consensus.includes('bearish')) score -= 10;
    } else if (direction === 'bearish') {
      if (consensus === 'strong_bearish') score += 10;
      else if (consensus === 'bearish') score += 5;
      else if (consensus.includes('bullish')) score -= 10;
    }
    
    // Bonus: Strong institutional flow
    if (internalsData.fii_dii_flow.flow_strength === 'strong') {
      score += 5;
    }
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Default Advance/Decline (when stock data unavailable)
 */
function getDefaultAdvanceDecline() {
  return {
    advancing: 0,
    declining: 0,
    unchanged: 0,
    ad_ratio: 1,
    ad_line: 0,
    market_bias: 'neutral',
    total_stocks: 0,
    note: 'Stock data unavailable - using neutral values'
  };
}

/**
 * Default Market Breadth (when stock data unavailable)
 */
function getDefaultMarketBreadth() {
  return {
    pct_above_open: 50,
    pct_green: 50,
    pct_strong_green: 0,
    breadth_score: 50,
    breadth_quality: 'neutral',
    note: 'Stock data unavailable - using neutral values'
  };
}

/**
 * Default Sector Strength (when stock data unavailable)
 */
function getDefaultSectorStrength() {
  return {
    sectors: [],
    strongest_sector: null,
    weakest_sector: null,
    sector_rotation: 'none',
    note: 'Stock data unavailable'
  };
}

/**
 * Default Market Leadership (when stock data unavailable)
 */
function getDefaultMarketLeadership() {
  return {
    leaders: [],
    laggards: [],
    leadership_quality: 'unknown',
    spread: 0,
    note: 'Stock data unavailable'
  };
}

module.exports = {
  analyzeMarketInternals,
  calculateMarketInternalsScoreForMaster,
  fetchInstitutionalFlowData,
};
