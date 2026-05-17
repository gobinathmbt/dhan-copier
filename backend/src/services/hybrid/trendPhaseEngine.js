/**
 * Trend Phase Engine
 * ==================
 * Classifies the current Wyckoff/Schabacker style trend phase:
 *
 *   accumulation    sideways at low → smart money buying              (long bias building)
 *   markup          breakout up + strong buying                       (full long)
 *   distribution    sideways at high → smart money selling            (short bias building)
 *   markdown        breakout down + strong selling                    (full short)
 *   transition      between phases                                    (wait)
 *
 * Inputs:
 *   - 5m and 15m candles (for trend & range checks)
 *   - delta bias / strength (smart money confirmation)
 *   - oiAnalytics (regime + migration over multi-day)
 *   - vix / atr percentile (volatility context)
 *
 * Pure deterministic.
 */

function _ranged(candles, lookback = 20, threshold = 0.4) {
  if (!candles || candles.length < lookback) return null;
  const sub = candles.slice(-lookback);
  const high = Math.max(...sub.map(c => c.h));
  const low  = Math.min(...sub.map(c => c.l));
  const range = high - low;
  // Ranged if last 5 bars span < threshold of full lookback range
  const last5 = sub.slice(-5);
  const recentRange = Math.max(...last5.map(c => c.h)) - Math.min(...last5.map(c => c.l));
  return {
    high, low, range,
    isRanged: range > 0 && (recentRange / range) < threshold,
    rangeRatio: range > 0 ? recentRange / range : 1,
  };
}

function _trendStrength(candles, lookback = 10) {
  if (!candles || candles.length < lookback) return 0;
  const sub = candles.slice(-lookback);
  let up = 0, down = 0;
  for (let i = 1; i < sub.length; i++) {
    if (sub[i].c > sub[i-1].c) up++;
    else if (sub[i].c < sub[i-1].c) down++;
  }
  return (up - down) / Math.max(1, sub.length - 1);     // -1..+1
}

function _atRangeExtreme(candles15m, currentPrice) {
  if (!candles15m?.length) return 'middle';
  const high = Math.max(...candles15m.map(c => c.h));
  const low  = Math.min(...candles15m.map(c => c.l));
  const range = high - low;
  if (range <= 0) return 'middle';
  const pos = (currentPrice - low) / range;
  if (pos > 0.8) return 'high';
  if (pos < 0.2) return 'low';
  return 'middle';
}

/**
 * @param {Object} args
 * @param {Array}  args.candles5m
 * @param {Array}  args.candles15m
 * @param {number} args.currentPrice
 * @param {Object} args.volumeAnalysis  - for delta bias
 * @param {Object} args.oiAnalytics     - for OI regime
 * @param {Object} args.multiDayContext - for OI migration history
 */
function classify({ candles5m = [], candles15m = [], currentPrice = null, volumeAnalysis = null, oiAnalytics = null, multiDayContext = null } = {}) {
  const range5  = _ranged(candles5m, 20, 0.45);
  const trend5  = _trendStrength(candles5m, 10);
  const trend15 = _trendStrength(candles15m, 8);
  const positionInRange = _atRangeExtreme(candles15m, currentPrice);

  const delta = volumeAnalysis?.delta;
  const deltaBias = delta?.bias || 'neutral';
  const deltaPct = Number(delta?.cvdPctLong) || 0;

  const oiMigCe = multiDayContext?.oiMigration?.ce;
  const oiMigPe = multiDayContext?.oiMigration?.pe;

  // MARKUP: 15m + 5m up trend, delta positive, OI migration up
  if (trend15 > 0.3 && trend5 > 0.2 && deltaPct > 5 &&
      (oiMigCe === 'up' || oiMigPe === 'up' || oiAnalytics?.regime === 'aggressive_long_buildup')) {
    return { phase: 'markup', bias: 'bullish', strength: 85,
             reasoning: `15m+5m uptrend + delta +${deltaPct}% + OI migrating up` };
  }

  // MARKDOWN: 15m + 5m down trend, delta negative, OI migration down
  if (trend15 < -0.3 && trend5 < -0.2 && deltaPct < -5 &&
      (oiMigCe === 'down' || oiMigPe === 'down' || oiAnalytics?.regime === 'aggressive_short_buildup')) {
    return { phase: 'markdown', bias: 'bearish', strength: 85,
             reasoning: `15m+5m downtrend + delta ${deltaPct}% + OI migrating down` };
  }

  // ACCUMULATION: ranged at the low of the 15m range, delta turning positive
  if (range5?.isRanged && positionInRange === 'low' && deltaBias !== 'bearish' && deltaBias !== 'mild_bearish') {
    return { phase: 'accumulation', bias: 'bullish', strength: 60,
             reasoning: `ranged at low + delta ${deltaBias}` };
  }

  // DISTRIBUTION: ranged at the high of the 15m range, delta turning negative
  if (range5?.isRanged && positionInRange === 'high' && deltaBias !== 'bullish' && deltaBias !== 'mild_bullish') {
    return { phase: 'distribution', bias: 'bearish', strength: 60,
             reasoning: `ranged at high + delta ${deltaBias}` };
  }

  // Otherwise transition / chop
  return {
    phase: 'transition',
    bias: 'neutral',
    strength: 30,
    reasoning: `trend15=${trend15.toFixed(2)} trend5=${trend5.toFixed(2)} pos=${positionInRange}`,
  };
}

/**
 * Direction-aware permission. Some phases simply forbid certain trade types.
 */
function permits(phase, direction) {
  if (!phase) return true;
  if (phase.phase === 'markup'      && direction === 'bearish') return false;     // don't fight markup
  if (phase.phase === 'markdown'    && direction === 'bullish') return false;     // don't fight markdown
  if (phase.phase === 'distribution'&& direction === 'bullish') return false;     // distribution = avoid longs
  if (phase.phase === 'accumulation'&& direction === 'bearish') return false;     // accumulation = avoid shorts
  return true;
}

module.exports = { classify, permits };
