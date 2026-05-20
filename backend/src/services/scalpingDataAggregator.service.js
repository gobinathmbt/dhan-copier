/**
 * Aggregates a structured market intelligence payload for the AI.
 * Reads everything from the existing dhanBypass service.
 */
const dhanBypass = require('./dhanProd.service');
const liveFeedProvider = require('./liveFeedDataProvider.service');
const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');
const { instance: feedRecorder } = require('./feedRecorder.service');
const symbolRegistry = require('../config/symbolRegistry');
const logger = require('../utils/logger');

const LIVE_TICK_FRESHNESS_MS = 5000; // tick is usable if < 5s old

/** Active-symbol helpers — resolved at call time so the aggregator works
 *  for whichever symbol the running session set in symbolRegistry. */
function _activeSymbol() {
  return symbolRegistry.getSymbol(symbolRegistry.getActiveSymbol());
}

/** Read latest spot LTP for the ACTIVE symbol from the live feed if fresh. */
function getLiveSpotLtp() {
  const active = _activeSymbol();
  const t = liveFeedProd.getTick(active.indexSegment, active.indexSecurityId);
  if (!t || typeof t.ltp !== 'number') return null;
  if (!t.updatedAt || Date.now() - t.updatedAt > LIVE_TICK_FRESHNESS_MS) return null;
  return t.ltp;
}

function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function vwapFrom(candles) {
  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * (c.volume || 1);
    v += c.volume || 1;
  }
  return v ? pv / v : null;
}

/**
 * Analyse a single timeframe's candles and return a compact summary.
 * Used to build the multi-timeframe block sent to the AI.
 */
function analyseTimeframe(candles, label) {
  if (!candles || candles.length < 3) {
    return { label, candle_count: 0, trend: 'unknown', strength: 0, regime: 'unknown' };
  }
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);

  const ema9val  = ema(closes.slice(-20), 9);
  const ema20val = ema(closes.slice(-30), 20);
  const vwapVal  = vwapFrom(candles);
  const lastClose = closes[closes.length - 1];

  // Trend: higher-highs/higher-lows vs lower-highs/lower-lows
  const recentHighs = highs.slice(-5);
  const recentLows  = lows.slice(-5);
  const hhhl = recentHighs[4] > recentHighs[2] && recentLows[4] > recentLows[2];
  const lhll = recentHighs[4] < recentHighs[2] && recentLows[4] < recentLows[2];
  const trend = hhhl ? 'bullish' : lhll ? 'bearish' : 'neutral';

  // Strength 0-10
  let upMoves = 0, downMoves = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) upMoves++;
    else if (closes[i] < closes[i-1]) downMoves++;
  }
  const consistency = Math.abs(upMoves - downMoves) / closes.length;
  const strength = Math.round(consistency * 10 * 10) / 10;

  // Regime
  const range = Math.max(...highs) - Math.min(...lows);
  const avgPrice = closes.reduce((a,b) => a+b, 0) / closes.length;
  const volatility = (range / avgPrice) * 100;
  const regime = volatility > 1.5 ? 'volatile' : volatility < 0.3 ? 'quiet' : 'ranging';

  // Recent candles summary (last 5)
  const recentCandles = candles.slice(-5).map(c => ({
    o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0,
    body: Math.abs(c.close - c.open),
    direction: c.close > c.open ? 'bull' : c.close < c.open ? 'bear' : 'doji',
  }));

  return {
    label,
    candle_count: candles.length,
    trend,
    strength,
    regime,
    ema_9:  ema9val  ? Math.round(ema9val  * 100) / 100 : null,
    ema_20: ema20val ? Math.round(ema20val * 100) / 100 : null,
    vwap:   vwapVal  ? Math.round(vwapVal  * 100) / 100 : null,
    price_vs_ema9:  ema9val  ? (lastClose > ema9val  ? 'above' : 'below') : 'unknown',
    price_vs_vwap:  vwapVal  ? (lastClose > vwapVal  ? 'above' : 'below') : 'unknown',
    last_close: lastClose,
    recent_candles: recentCandles,
    up_moves: upMoves,
    down_moves: downMoves,
  };
}

function classifyBuildUp(prevPrice, price, prevOI, oi) {
  // Handle edge cases
  if (!prevPrice || !price || prevPrice === 0) return 'unknown';
  
  const priceUp = price > prevPrice;
  const oiUp = oi > prevOI;
  
  if (priceUp && oiUp) return 'long_buildup';
  if (!priceUp && oiUp) return 'short_buildup';
  if (priceUp && !oiUp) return 'short_covering';
  if (!priceUp && !oiUp) return 'long_unwinding';
  
  return 'unknown';
}

async function buildPayload(authKey) {
  const active = _activeSymbol();
  const meta = {
    timestamp: new Date().toISOString(),
    market: active.key,         // e.g. 'NIFTY_50' or 'SENSEX'
    displayName: active.displayName,
    indexSegment: active.indexSegment,
    indexSecurityId: active.indexSecurityId,
    strikeStep: active.strikeStep,
  };

  const now = Math.floor(Date.now() / 1000);

  // ── MULTI-TIMEFRAME CANDLE FETCH ─────────────────────────────────────────
  // Fetch 1m (last 30min), 5m (last 2h), 15m (last 4h), 30m (last 8h)
  // These give the AI a complete picture of market structure across timeframes
  let spotCandles = [];      // 1m
  let candles5m   = [];      // 5m
  let candles15m  = [];      // 15m
  let candles30m  = [];      // 30m

  // All Dhan index spots (NIFTY 50, BANKNIFTY, SENSEX) live on the IDX_I
  // segment with instrument INDEX. Per-symbol identity is the securityId.
  const candleExchange   = 'IDX';
  const candleSegment    = 'I';
  const candleInstrument = 'IDX';

  const fetchCandles = async (interval, minutesBack) => {
    try {
      // Use liveFeedProvider for optimized data access (live-feed folder → API fallback)
      const res = await liveFeedProvider.getCandles(authKey, {
        securityId: active.indexSecurityId,
        exchange: candleExchange, segment: candleSegment, instrument: candleInstrument,
        startTime: now - minutesBack * 60,
        endTime: now,
        interval,
      });
      return res.ok ? (res.data.candles || []) : [];
    } catch (e) {
      logger.warn({ err: e.message, interval }, '[aggregator] candle fetch failed');
      return [];
    }
  };

  // Fetch all timeframes in parallel
  [spotCandles, candles5m, candles15m, candles30m] = await Promise.all([
    fetchCandles('1',  30),   // 1m — last 30 minutes
    fetchCandles('5',  120),  // 5m — last 2 hours
    fetchCandles('15', 240),  // 15m — last 4 hours
    fetchCandles('30', 480),  // 30m — last 8 hours
  ]);

  logger.info({
    '1m': spotCandles.length,
    '5m': candles5m.length,
    '15m': candles15m.length,
    '30m': candles30m.length,
  }, '[aggregator] Multi-timeframe candles fetched');

  // Persist candles for later replay / backtesting (market-hours gated inside recorder).
  // Pass the ACTIVE symbol key explicitly so multi-symbol sessions write to
  // the right per-symbol folder regardless of which symbol the registry has
  // active at the moment the write happens.
  try {
    feedRecorder.recordCandles({
      '1':  spotCandles,
      '5':  candles5m,
      '15': candles15m,
    }, active.key);
  } catch (_) {}

  // Persist futures candles (aggregate from ticks since API returns 401)
  try {
    const futuresCandleAggregator = require('./futuresCandleAggregator.service');
    // Aggregate ticks into candles and write to files
    await futuresCandleAggregator.updateTodaysCandles();
  } catch (err) {
    logger.warn({ err: err.message }, '[aggregator] Failed to aggregate futures candles from ticks');
  }

  const last = spotCandles[spotCandles.length - 1] || {};
  const prev = spotCandles[spotCandles.length - 2] || {};
  
  const closes = spotCandles.map((c) => c.close);
  const ema9 = ema(closes.slice(-30), 9);
  const ema20 = ema(closes.slice(-50), 20);
  const ema50 = ema(closes.slice(-100), 50);
  const vwap = vwapFrom(spotCandles.slice(-200));

  const dayHigh = Math.max(...spotCandles.map((c) => c.high || 0), 0);
  const dayLow = Math.min(...spotCandles.map((c) => c.low || Infinity).filter(Number.isFinite), last.low || 0);
  const recentVolumes = spotCandles.slice(-20).map((c) => c.volume || 0);
  const avgVol = recentVolumes.length ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length : 0;
  const lastVol = last.volume || 0;
  const volSpike = avgVol > 0 ? lastVol > avgVol * 1.5 : false;

  // 2. Expiry list — use unified provider (API → folder fallback)
  let expiries = [];
  try {
    const res = await liveFeedProvider.getExpiryList(authKey, {
      securityId: active.indexSecurityId,
      underlyingSeg: active.indexSegment,
    });
    if (res.ok) expiries = res.data.expiries || [];
    if (res.data?.meta?.source === 'live-feed-folder') {
      logger.info({ source: 'live-feed-folder' }, '[aggregator] Expiry list served from folder fallback');
    }
  } catch (e) {
    logger.warn({ err: e.message }, '[aggregator] expiry fetch failed (provider error)');
  }
  const nearestExpiry = expiries[0];

  // 3. Option chain — use unified provider (API → folder fallback)
  let optionChain = null;
  let oiAnalysis = null;
  let oiChange = null;

  try {
    if (nearestExpiry) {
      const res = await liveFeedProvider.getOptionChain(authKey, {
        segment: 0,
        expiry: nearestExpiry.exp,
        securityId: active.indexSecurityId,
        underlyingSeg: active.indexSegment,
      });
      if (res.ok) {
        optionChain = res.data;
        // If served fresh from API, persist a snapshot for tomorrow's
        // fallback. If already from folder, skip the re-write.
        if (res.data?.meta?.source !== 'live-feed-folder') {
          try {
            feedRecorder.recordOptionChain({
              spotLtp: getLiveSpotLtp() ?? last.close,
              strikes: optionChain.strikes,
              expiry: nearestExpiry?._raw || nearestExpiry?.expiryDate,
              symbolKey: active.key,
            });
          } catch (_) {}
        } else {
          logger.info({
            source: 'live-feed-folder',
            strikeCount: optionChain.strikes.length,
          }, '[aggregator] Option chain served from folder fallback');
        }
      } else {
        logger.warn({ error: res.error }, '[aggregator] Option chain unavailable from both API and folder');
      }
      
      // Fetch OI Analysis
      const now = Math.floor(Date.now() / 1000);
      
      logger.info({
        expiryUsed: nearestExpiry.exp,
        expiryDate: nearestExpiry.expiryDate,
        currentTime: now,
        currentTimeISO: new Date(now * 1000).toISOString(),
      }, '[aggregator] Fetching OI data with expiry');
      
      const oiRes = await dhanBypass.getOIAnalysis(authKey, {
        segment: 0,
        securityId: active.indexSecurityId,
        underlyingSeg: active.indexSegment,
        expiry: nearestExpiry.exp,
        timeframe: '1m',
        strikes: 30,
        startTime: now,
        requiredData: ['oi', 'vol', 'pcr_oi', 'pcr_vol'],
      });
      if (oiRes.ok) {
        oiAnalysis = oiRes.data;
        logger.info({ oiAnalysisKeys: Object.keys(oiAnalysis) }, '[aggregator] OI Analysis fetched successfully');
      } else {
        logger.warn({ error: oiRes.error }, '[aggregator] OI Analysis fetch failed');
      }
      
      // Fetch OI Change (last 15 minutes)
      const oiChangeRes = await dhanBypass.getOIChange(authKey, {
        segment: 0,
        securityId: active.indexSecurityId,
        underlyingSeg: active.indexSegment,
        expiry: nearestExpiry.exp,
        timeframe: '1m',
        strikes: 30,
        startTime: now - 900, // 15 minutes ago
        endTime: now,
      });
      if (oiChangeRes.ok) {
        oiChange = oiChangeRes.data;
        logger.info({ oiChangeKeys: Object.keys(oiChange) }, '[aggregator] OI Change fetched successfully');
      } else {
        logger.warn({ error: oiChangeRes.error }, '[aggregator] OI Change fetch failed');
      }
    }
  } catch (e) {
    logger.warn({ err: e.message, stack: e.stack }, '[aggregator] option chain fetch failed');
  }

  let optionsBlock = null;
  let atmStrike = null;
  if (optionChain && optionChain.strikes?.length) {
    const ltp = last.close || 0;
    atmStrike =
      optionChain.strikes.reduce((best, s) =>
        Math.abs(s.strike - ltp) < Math.abs(best.strike - ltp) ? s : best
      ).strike;

    const atmIdx = optionChain.strikes.findIndex((s) => s.strike === atmStrike);
    const window = optionChain.strikes.slice(Math.max(0, atmIdx - 10), atmIdx + 11);

    let totCe = 0,
      totPe = 0,
      ceWriteCnt = 0,
      peWriteCnt = 0,
      ceUnwindCnt = 0,
      peUnwindCnt = 0;
    let highestCeOi = { strike: 0, oi: 0 };
    let highestPeOi = { strike: 0, oi: 0 };

    for (const s of window) {
      totCe += s.call.oi || 0;
      totPe += s.put.oi || 0;
      if (s.call.oi > highestCeOi.oi) highestCeOi = { strike: s.strike, oi: s.call.oi };
      if (s.put.oi > highestPeOi.oi) highestPeOi = { strike: s.strike, oi: s.put.oi };
      const ceUp = (s.call.oiChange || 0) > 0;
      const peUp = (s.put.oiChange || 0) > 0;
      const ceDown = (s.call.oiChange || 0) < 0;
      const peDown = (s.put.oiChange || 0) < 0;
      if (ceUp) ceWriteCnt++;
      if (peUp) peWriteCnt++;
      if (ceDown) ceUnwindCnt++;
      if (peDown) peUnwindCnt++;
    }

    const pcr = totCe ? totPe / totCe : 0;
    const atmRow = optionChain.strikes.find((s) => s.strike === atmStrike);

    // simple max pain: strike with highest combined OI
    const maxPain = window.reduce(
      (best, s) => {
        const combined = (s.call.oi || 0) + (s.put.oi || 0);
        return combined > best.combined ? { strike: s.strike, combined } : best;
      },
      { strike: atmStrike, combined: 0 }
    ).strike;

    optionsBlock = {
      atm_strike: atmStrike,
      max_pain: maxPain,
      pcr_total: Number(pcr.toFixed(2)),
      ce_oi_total: totCe,
      pe_oi_total: totPe,
      highest_ce_oi_strike: highestCeOi.strike,
      highest_pe_oi_strike: highestPeOi.strike,
      ce_writing: ceWriteCnt > peWriteCnt,
      pe_writing: peWriteCnt > ceWriteCnt,
      ce_unwinding: ceUnwindCnt > peUnwindCnt,
      pe_unwinding: peUnwindCnt > ceUnwindCnt,
      atm_iv: atmRow?.call?.iv || atmRow?.put?.iv || null,
      // Full strikes array — needed by hybrid strike selectors. Without
      // this they see an empty array and emit "no chain or atm" warnings,
      // blocking trade entry. Pass the whole option chain through so the
      // selectors can apply their delta-band / liquidity / max-pain logic.
      strikes: optionChain.strikes || [],
      atm_call: atmRow
        ? {
            symbol: atmRow.call.displaySymbol,
            ltp: atmRow.call.ltp,
            oi: atmRow.call.oi,
            iv: atmRow.call.iv,
            delta: atmRow.call.greeks?.delta,
          }
        : null,
      atm_put: atmRow
        ? {
            symbol: atmRow.put.displaySymbol,
            ltp: atmRow.put.ltp,
            oi: atmRow.put.oi,
            iv: atmRow.put.iv,
            delta: atmRow.put.greeks?.delta,
          }
        : null,
    };
    
    logger.info({
      atmStrike,
      atmCallLtp: atmRow?.call?.ltp,
      atmPutLtp: atmRow?.put?.ltp,
      atmCallSymbol: atmRow?.call?.displaySymbol,
      atmPutSymbol: atmRow?.put?.displaySymbol,
      hasAtmRow: !!atmRow,
    }, '[aggregator] ATM options data extracted');
  }

  // ── MULTI-TIMEFRAME ANALYSIS ─────────────────────────────────────────────
  const mtfAnalysis = {
    '1m':  analyseTimeframe(spotCandles, '1m'),
    '5m':  analyseTimeframe(candles5m,   '5m'),
    '15m': analyseTimeframe(candles15m,  '15m'),
    '30m': analyseTimeframe(candles30m,  '30m'),
  };

  // Alignment: how many timeframes agree on direction
  const trends = Object.values(mtfAnalysis).map(t => t.trend);
  const bullCount = trends.filter(t => t === 'bullish').length;
  const bearCount = trends.filter(t => t === 'bearish').length;
  const mtfAlignment = bullCount >= 3 ? 'strongly_bullish'
    : bullCount === 2 ? 'bullish'
    : bearCount >= 3 ? 'strongly_bearish'
    : bearCount === 2 ? 'bearish'
    : 'neutral';

  const mtfBlock = {
    timeframes: mtfAnalysis,
    alignment: mtfAlignment,
    bull_count: bullCount,
    bear_count: bearCount,
    all_aligned: bullCount === 4 || bearCount === 4,
    higher_tf_bias: mtfAnalysis['15m'].trend !== 'neutral' ? mtfAnalysis['15m'].trend
      : mtfAnalysis['30m'].trend !== 'neutral' ? mtfAnalysis['30m'].trend
      : 'neutral',
    note: 'Use 15m and 30m for direction bias, 5m for entry timing, 1m for precise entry',
  };

  // ── ACTUAL ATM STRIKE (from real spot price) ──────────────────────────────
  // Use the actual last close price to compute ATM — not the option chain's guess.
  // Strike step depends on the active symbol (NIFTY=50, SENSEX=100, BANKNIFTY=100).
  const actualSpot = last.close || 0;
  const strikeStep = active.strikeStep || 50;
  const computedAtmStrike = actualSpot > 0
    ? Math.round(actualSpot / strikeStep) * strikeStep
    : null;

  // Market structure (very simple)
  const recent = spotCandles.slice(-20);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const trendStructure =
    highs[highs.length - 1] > Math.max(...highs.slice(0, -1)) ? 'HH_HL' :
    lows[lows.length - 1] < Math.min(...lows.slice(0, -1)) ? 'LH_LL' :
    'range';

  // LIVE FEED: if WS snapshot has a fresh NIFTY tick, use it as the current spot.
  // Falls back to the last 1m candle close when feed is stale/disconnected.
  const liveLtp = getLiveSpotLtp();
  const effectiveLtp = liveLtp != null ? liveLtp : last.close;
  if (liveLtp != null) {
    logger.debug({ liveLtp, candleClose: last.close }, '[aggregator] using live feed spot');
  }

  const payload = {
    meta,
    spot_data: {
      ltp: effectiveLtp,
      live_ltp: liveLtp,
      candle_close: last.close,
      source: liveLtp != null ? 'live_feed' : 'candle',
      open: spotCandles[0]?.open,
      high: dayHigh,
      low: dayLow,
      close: last.close,
      previous_close: prev.close,
      day_range: dayHigh - dayLow,
      returns_1m: prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0,
      candle_count: spotCandles.length,
    },
    // Candles keyed by timeframe — used by RSI/MACD/Bollinger/Stochastic/VolumeProfile indicators
    candles: {
      '1m':  spotCandles,
      '5m':  candles5m,
      '15m': candles15m,
      '30m': candles30m,
    },
    // Actual ATM strike computed from real spot price
    actual_atm_strike: computedAtmStrike,
    actual_spot_price: actualSpot,
    market_structure: {
      trend_structure: trendStructure,
      market_regime: trendStructure === 'range' ? 'range_day' : 'trend_day',
    },
    // MULTI-TIMEFRAME ANALYSIS — 1m, 5m, 15m, 30m
    // Use this to determine direction bias and entry timing
    multi_timeframe: mtfBlock,
    vwap_analysis: {
      vwap,
      price_vs_vwap: vwap && last.close ? (last.close > vwap ? 'above' : 'below') : 'unknown',
      // 'position' is the canonical field name used by the hybrid engine playbooks
      position: vwap && last.close ? (last.close > vwap ? 'above' : 'below') : 'unknown',
      distance_from_vwap: vwap && last.close ? Number((last.close - vwap).toFixed(2)) : null,
      distance_pct: vwap && last.close ? Number(((last.close - vwap) / vwap * 100).toFixed(3)) : null,
    },
    moving_averages: {
      ema_9: ema9,
      ema_20: ema20,
      ema_50: ema50,
      ema_alignment: ema9 && ema20 && ema50 ? (ema9 > ema20 && ema20 > ema50 ? 'bullish' : ema9 < ema20 && ema20 < ema50 ? 'bearish' : 'mixed') : 'unknown',
    },
    volume_orderflow: {
      volume: lastVol,
      avg_volume_20: Math.round(avgVol),
      volume_spike: volSpike,
    },
    options_chain: optionsBlock,
    oi_analysis: oiAnalysis ? {
      pcr_oi: oiAnalysis.pcr_oi,
      pcr_vol: oiAnalysis.pcr_vol,
      total_ce_oi: oiAnalysis.oi?.ce,
      total_pe_oi: oiAnalysis.oi?.pe,
      total_ce_vol: oiAnalysis.vol?.ce,
      total_pe_vol: oiAnalysis.vol?.pe,
    } : null,
    oi_change: oiChange ? {
      ce_oi_change: oiChange.oi_change?.ce,
      pe_oi_change: oiChange.oi_change?.pe,
      net_oi_change: oiChange.oi_change?.net,
    } : null,
    futures_data: {
      build_up_type:
        prev.close && last.close && prev.volume && last.volume
          ? classifyBuildUp(prev.close, last.close, prev.volume, last.volume)
          : 'unknown',
      prev_close: prev.close,
      current_close: last.close,
      prev_volume: prev.volume,
      current_volume: last.volume,
    },
    expiry_context: nearestExpiry
      ? {
          expiry: nearestExpiry.expiryDate,
          days_to_expiry: nearestExpiry.daysToExpiry,
          expiry_type: nearestExpiry.expiryType,
        }
      : null,
  };

  return { payload, atmStrike: computedAtmStrike || atmStrike, atmCallLtp: optionsBlock?.atm_call?.ltp, atmPutLtp: optionsBlock?.atm_put?.ltp, atmCallSymbol: optionsBlock?.atm_call?.symbol, atmPutSymbol: optionsBlock?.atm_put?.symbol, expiry: nearestExpiry?.exp };
}

module.exports = { buildPayload };
