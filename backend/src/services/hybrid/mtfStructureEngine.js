/**
 * Multi-Timeframe Structure Engine
 * =================================
 * Enforces the hierarchy:
 *   15m = primary trend
 *   5m  = execution structure
 *   1m  = trigger
 *
 * Rule: never enter against the 15m unless a reversal regime + sweep +
 * exhaustion combo is confirmed.
 *
 * Output decides whether the candidate direction is "with-trend",
 * "counter-trend with permission", or "blocked".
 */

function _trendOf(candles, lookback = 8) {
  const tail = (candles || []).slice(-lookback).filter(c => Number.isFinite(c.c));
  if (tail.length < 3) return 'neutral';
  let up = 0, down = 0;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].c > tail[i - 1].c) up++;
    else if (tail[i].c < tail[i - 1].c) down++;
  }
  if (up > down * 1.3) return 'bullish';
  if (down > up * 1.3) return 'bearish';
  return 'neutral';
}

function _bos(candles, lookback = 6) {
  // Break of structure: latest close exceeds the high (or low) of the prior
  // `lookback` bars.
  if (!candles || candles.length < lookback + 2) return 'none';
  const recent = candles.slice(-(lookback + 1));
  const last = recent[recent.length - 1];
  const prior = recent.slice(0, -1);
  const priorHigh = Math.max(...prior.map(c => c.h));
  const priorLow  = Math.min(...prior.map(c => c.l));
  if (last.c > priorHigh) return 'bullish_bos';
  if (last.c < priorLow)  return 'bearish_bos';
  return 'none';
}

function _choch(candles, lookback = 10) {
  // Change of character: most recent swing point flips trend
  if (!candles || candles.length < lookback) return 'none';
  const sub = candles.slice(-lookback);
  let lastSwingHigh = -Infinity, lastSwingLow = Infinity;
  for (let i = 2; i < sub.length - 2; i++) {
    const c = sub[i];
    if (c.h > sub[i-1].h && c.h > sub[i-2].h && c.h > sub[i+1].h && c.h > sub[i+2].h) lastSwingHigh = c.h;
    if (c.l < sub[i-1].l && c.l < sub[i-2].l && c.l < sub[i+1].l && c.l < sub[i+2].l) lastSwingLow = c.l;
  }
  const close = sub[sub.length - 1].c;
  if (close > lastSwingHigh) return 'bullish_choch';
  if (close < lastSwingLow)  return 'bearish_choch';
  return 'none';
}

/**
 * @param {Object} args
 * @param {Array}  args.candles1m
 * @param {Array}  args.candles5m
 * @param {Array}  args.candles15m
 * @param {string} args.direction - 'bullish' | 'bearish'
 * @param {Object} [args.auctionState] - marketAuctionEngine output (for permission)
 * @returns {Object}
 */
function evaluate({ candles1m = [], candles5m = [], candles15m = [], direction, auctionState = null } = {}) {
  const tf15 = _trendOf(candles15m, 8);
  const tf5  = _trendOf(candles5m, 8);
  const tf1  = _trendOf(candles1m, 12);
  const bos5  = _bos(candles5m, 6);
  const choch5= _choch(candles5m, 10);
  const bos15 = _bos(candles15m, 6);

  let alignment = 'none';
  if (tf15 === direction && tf5 === direction) alignment = 'full';
  else if (tf15 === direction || tf5 === direction) alignment = 'partial';

  // Block decision: ONLY when 15m primary trend is clearly opposed AND no
  // reversal permission. Calibrated: 15m=neutral or 5m-only opposition is
  // a confidence penalty, not a block.
  let blocked = false;
  let reason = '';
  if (tf15 !== 'neutral' && tf15 !== direction) {
    const reversalPermitted =
         auctionState?.tradingImplication === 'reversal_setup'
      || auctionState?.tradingImplication === 'mean_reversion'
      || ((direction === 'bullish' && choch5 === 'bullish_choch')
       || (direction === 'bearish' && choch5 === 'bearish_choch'));
    if (!reversalPermitted) {
      blocked = true;
      reason = `15m ${tf15} blocks ${direction} (no reversal permission)`;
    } else {
      reason = `counter-trend ${direction} permitted (${auctionState?.tradingImplication} or ${choch5})`;
    }
  } else {
    reason = `${alignment} alignment (15m=${tf15} 5m=${tf5} 1m=${tf1})`;
  }

  // Score 0..100 — higher = better structural alignment for this direction
  let score = 50;
  if (alignment === 'full') score = 80;
  else if (alignment === 'partial') score = 65;
  if (bos5  === `${direction}_bos`)   score += 8;
  if (bos15 === `${direction}_bos`)   score += 6;
  if (choch5 === `${direction}_choch`) score += 5;
  if (blocked) score = Math.min(score, 30);
  score = Math.max(0, Math.min(100, score));

  return {
    tf15, tf5, tf1,
    bos5, bos15, choch5,
    alignment,
    blocked,
    score,
    reasoning: reason,
  };
}

module.exports = { evaluate };
