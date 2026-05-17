/**
 * UT Bot Engine
 * -------------
 * Reads UT Bot ATR-trailing-stop signals from the existing
 * `multiTimeframe.service.js` output and turns them into structured,
 * direction-aware confirmation data:
 *
 *   - perTimeframe: { '1m','5m','15m','30m' } → { signal, trend, trailingStop, agrees }
 *   - aligned     : true if 5m + 15m agree with the candidate direction
 *   - flippedTo   : 'bullish' | 'bearish' | null  — used by monitor for fast exits
 *   - score       : 0..100 directional score (50 = neutral)
 *   - reasoning   : human-readable summary
 *
 * UT Bot is treated as the SPEC says — execution timing / continuation only.
 * It never gates entries on its own; it's a confirmation pillar with weight 5
 * inside the confidence scorer.
 */

function _tfBlock(mtf, tf) {
  return mtf?.timeframes?.[tf] || null;
}

function _tfSignal(mtf, tf) {
  const block = _tfBlock(mtf, tf);
  if (!block) return { signal: 'none', trend: 'neutral', trailingStop: null };
  return {
    signal: block.ut_bot_signal || 'none',                  // 'buy' | 'sell' | 'none' | 'unknown'
    trend:  block.ut_bot_signal === 'buy' ? 'bullish'
          : block.ut_bot_signal === 'sell' ? 'bearish'
          : 'neutral',
    trailingStop: Number.isFinite(block.ut_bot_trailing_stop) ? block.ut_bot_trailing_stop : null,
  };
}

/**
 * @param {Object} mtf - multiTimeframe.service.js output
 * @param {string} [direction] - 'bullish' | 'bearish' to score against
 */
function evaluate(mtf, direction = null) {
  if (!mtf) {
    return {
      perTimeframe: {},
      aligned: false,
      flippedTo: null,
      score: 50,
      reasoning: 'no multi-timeframe data',
    };
  }

  const perTimeframe = {
    '1m':  _tfSignal(mtf, '1m'),
    '5m':  _tfSignal(mtf, '5m'),
    '15m': _tfSignal(mtf, '15m'),
    '30m': _tfSignal(mtf, '30m'),
  };

  // Direction-aware scoring
  let score = 50;
  const reasons = [];
  let aligned = false;
  let flippedTo = null;

  if (direction === 'bullish' || direction === 'bearish') {
    const want = direction;
    const tf5  = perTimeframe['5m'].trend;
    const tf15 = perTimeframe['15m'].trend;
    const tf1  = perTimeframe['1m'].trend;
    const tf30 = perTimeframe['30m'].trend;

    aligned = (tf5 === want) && (tf15 === want);

    if (perTimeframe['5m'].signal === 'buy' && want === 'bullish')   { score += 12; reasons.push('UT Bot 5m BUY'); }
    if (perTimeframe['5m'].signal === 'sell'&& want === 'bearish')   { score += 12; reasons.push('UT Bot 5m SELL'); }
    if (tf15 === want)                                               { score += 10; reasons.push(`UT Bot 15m ${tf15}`); }
    if (tf30 === want)                                               { score += 6;  reasons.push(`UT Bot 30m ${tf30}`); }
    if (tf1 === want)                                                { score += 4;  reasons.push(`UT Bot 1m ${tf1}`); }

    // Penalties when timeframes disagree
    if (tf5  !== want && tf5  !== 'neutral')  { score -= 12; reasons.push(`UT Bot 5m ${tf5} (against)`); }
    if (tf15 !== want && tf15 !== 'neutral')  { score -= 10; reasons.push(`UT Bot 15m ${tf15} (against)`); }

    // "Flipped to" — primary tf (5m) opposed to direction
    if (tf5 !== 'neutral' && tf5 !== want) flippedTo = tf5;
  }

  return {
    perTimeframe,
    aligned,
    flippedTo,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasoning: reasons.length ? reasons.join(' | ') : 'ut bot neutral',
  };
}

/**
 * Detect a UT Bot reversal between an entry-time snapshot and the latest read.
 * Used by the monitor for fast exits.
 */
function reversalAgainst(direction, currentEvalResult, entrySnapshot) {
  if (!currentEvalResult?.perTimeframe?.['5m']) return false;
  const wantTrend = direction === 'bullish' ? 'bearish' : 'bullish';
  const cur5 = currentEvalResult.perTimeframe['5m'].trend;
  const entry5 = entrySnapshot?.utBot5mTrend;
  // A reversal is when the 5m UT Bot trend now opposes the trade and was
  // either with the trade or neutral at entry time.
  return cur5 === wantTrend && entry5 !== wantTrend;
}

module.exports = { evaluate, reversalAgainst };
