/**
 * Market Regime Engine
 * --------------------
 * Determines whether the market is in a regime where institutional momentum
 * trading is even possible:
 *
 *   trending_bullish | trending_bearish |
 *   ranging           | choppy           | reversal_risk |
 *   exhaustion        | unknown
 *
 * Based on:
 *   - ADX value & slope (trend strength)
 *   - VWAP distance & slope
 *   - HTF (15m / 30m) trend alignment from existing multiTimeframe analysis
 *   - Range compression / expansion from volatility regime
 *   - Last-N candle structure (HH/HL vs LH/LL)
 *
 * Output decides whether to:
 *   - allow trend trades
 *   - allow mean-reversion only
 *   - skip the cycle entirely (choppy / exhaustion)
 */

function _last(arr, n = 1) {
  if (!arr || !arr.length) return null;
  return arr[arr.length - n];
}

function _structure(candles, lookback = 6) {
  const norm = (candles || []).map(c => ({
    h: c.h ?? c.high, l: c.l ?? c.low, c: c.c ?? c.close,
  })).filter(x => Number.isFinite(x.h) && Number.isFinite(x.l) && Number.isFinite(x.c));

  if (norm.length < lookback + 2) return { pattern: 'unknown', score: 0 };

  const recent = norm.slice(-lookback);
  let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].h > recent[i-1].h) higherHighs++;
    else if (recent[i].h < recent[i-1].h) lowerHighs++;
    if (recent[i].l > recent[i-1].l) higherLows++;
    else if (recent[i].l < recent[i-1].l) lowerLows++;
  }

  const total = recent.length - 1;
  if (higherHighs >= total * 0.6 && higherLows >= total * 0.6) {
    return { pattern: 'uptrend', score: 0.9 };
  }
  if (lowerHighs >= total * 0.6 && lowerLows >= total * 0.6) {
    return { pattern: 'downtrend', score: 0.9 };
  }
  if (higherHighs > 0 && lowerLows > 0 && Math.abs(higherHighs - lowerLows) <= 1) {
    return { pattern: 'choppy', score: 0.4 };
  }
  return { pattern: 'mixed', score: 0.5 };
}

/**
 * @param {Object} params
 * @param {Array}  params.candles5m
 * @param {Array}  params.candles15m
 * @param {Object} params.volatilityRegime - output of volatilityRegimeEngine.classify
 * @param {Object} params.multiTimeframe   - existing multiTimeframe service output
 * @param {Object} params.vwap             - { vwap, distance, position: 'above' | 'below' }
 * @param {Object} params.adx              - { value, slope, strength: 'strong'|'moderate'|'weak' }
 * @returns {Object}
 */
function classify({
  candles5m = [],
  candles15m = [],
  volatilityRegime = null,
  multiTimeframe = null,
  vwap = null,
  adx = null,
} = {}) {
  const reasons = [];

  // ── Structure check ─────────────────────────────────────────────────────
  const struct5  = _structure(candles5m, 6);
  const struct15 = _structure(candles15m, 6);

  // ── HTF alignment ───────────────────────────────────────────────────────
  // Reuses the existing multiTimeframe analyzer if provided.
  const tf5    = multiTimeframe?.timeframes?.['5m']?.trend  || 'neutral';
  const tf15   = multiTimeframe?.timeframes?.['15m']?.trend || 'neutral';
  const tf30   = multiTimeframe?.timeframes?.['30m']?.trend || 'neutral';
  const htfBias = multiTimeframe?.higher_tf_bias            || 'neutral';

  // ── VWAP read ───────────────────────────────────────────────────────────
  const vwapPos = vwap?.position || 'unknown';

  // ── ADX read ────────────────────────────────────────────────────────────
  const adxValue = Number(adx?.value) || 0;
  const adxStrength = adx?.strength || (adxValue >= 25 ? 'strong' : adxValue >= 18 ? 'moderate' : 'weak');

  // ── Decision tree ───────────────────────────────────────────────────────
  let regime = 'unknown';

  // exhaustion: extreme expansion + range no longer expanding
  if (volatilityRegime?.state === 'panic' && volatilityRegime?.expansionScore < 1.2) {
    regime = 'exhaustion';
    reasons.push('panic regime with falling expansion');
  }
  // trending bullish: HTF bullish AND structure 5m/15m up AND ADX moderate+ AND VWAP above
  else if (
    (htfBias === 'bullish' || tf15 === 'bullish' || tf30 === 'bullish') &&
    struct5.pattern === 'uptrend' &&
    adxStrength !== 'weak' &&
    vwapPos !== 'below'
  ) {
    regime = 'trending_bullish';
    reasons.push('HTF up + 5m up + ADX healthy + VWAP supportive');
  }
  // trending bearish (mirror)
  else if (
    (htfBias === 'bearish' || tf15 === 'bearish' || tf30 === 'bearish') &&
    struct5.pattern === 'downtrend' &&
    adxStrength !== 'weak' &&
    vwapPos !== 'above'
  ) {
    regime = 'trending_bearish';
    reasons.push('HTF down + 5m down + ADX healthy + VWAP supportive');
  }
  // reversal risk — 5m and 15m disagree strongly
  else if (
    (tf5 === 'bullish' && tf15 === 'bearish') ||
    (tf5 === 'bearish' && tf15 === 'bullish')
  ) {
    regime = 'reversal_risk';
    reasons.push('5m and 15m disagree');
  }
  // choppy: weak ADX or compressed range
  else if (
    adxStrength === 'weak' ||
    (volatilityRegime?.rangeCompression != null && volatilityRegime.rangeCompression < 0.6) ||
    struct5.pattern === 'choppy'
  ) {
    regime = 'choppy';
    reasons.push('weak ADX / range compression / choppy 5m');
  }
  // ranging: structure mixed, ADX moderate
  else {
    regime = 'ranging';
    reasons.push('mixed structure with no clear trend');
  }

  // ── Permissions per regime ──────────────────────────────────────────────
  // Calibrated: choppy / reversal_risk allow SOFT entries (reduced sizing,
  // forced scalp). Only `exhaustion` hard-blocks because the move is over.
  const policy = {
    trending_bullish:  { allowEntries: true,  bias: 'bullish',  sizingFactor: 1.0 },
    trending_bearish:  { allowEntries: true,  bias: 'bearish',  sizingFactor: 1.0 },
    ranging:           { allowEntries: true,  bias: 'neutral',  sizingFactor: 0.6 },
    choppy:            { allowEntries: true,  bias: 'neutral',  sizingFactor: 0.4 },  // soft
    reversal_risk:     { allowEntries: true,  bias: 'neutral',  sizingFactor: 0.5 },
    exhaustion:        { allowEntries: false, bias: 'neutral',  sizingFactor: 0   },
    unknown:           { allowEntries: false, bias: 'neutral',  sizingFactor: 0   },
  }[regime];

  return {
    regime,
    bias: policy.bias,
    allowEntries: policy.allowEntries,
    sizingFactor: policy.sizingFactor,
    inputs: {
      tf5, tf15, tf30, htfBias, vwapPos, adxValue, adxStrength,
      struct5: struct5.pattern, struct15: struct15.pattern,
      volatility: volatilityRegime?.state,
    },
    reasoning: reasons.join(' | '),
  };
}

module.exports = { classify };
