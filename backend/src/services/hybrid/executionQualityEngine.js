/**
 * Execution Quality Engine
 * ------------------------
 * Right before we send the order, we score the execution venue.
 *
 * Inputs:
 *   - bid / ask / ltp on the chosen option
 *   - depth quality (from liquidity engine)
 *   - last tick age (ms) on that option's WS feed
 *   - historical slippage estimate (optional)
 *
 * Output: 0..100. Anything below the configured floor → block the entry.
 * This prevents bad fills which destroy expectancy, especially on scalps.
 */

function _spreadScore(bid, ask, ltp) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(ltp) || ltp <= 0) {
    return { score: 50, spreadPct: null, reason: 'no quote' };
  }
  if (ask <= bid) return { score: 30, spreadPct: null, reason: 'crossed quote' };
  const spread = ask - bid;
  const spreadPct = (spread / ltp) * 100;
  // For NIFTY options:
  //   < 0.3% spread → excellent
  //   0.3-0.7%      → good
  //   0.7-1.5%      → fair
  //   > 1.5%        → poor
  let score = 50, reason = 'normal';
  if (spreadPct < 0.3)      { score = 95; reason = 'tight spread'; }
  else if (spreadPct < 0.7) { score = 80; reason = 'good spread'; }
  else if (spreadPct < 1.5) { score = 55; reason = 'fair spread'; }
  else                      { score = 25; reason = 'wide spread'; }
  return { score, spreadPct: Number(spreadPct.toFixed(3)), reason };
}

function _depthScore(depthQuality) {
  return ({
    excellent: 95,
    good: 80,
    fair: 60,
    poor: 35,
    critical: 10,
    unknown: 50,
  })[depthQuality] ?? 50;
}

function _latencyScore(tickAgeMs) {
  if (!Number.isFinite(tickAgeMs)) return 50;
  if (tickAgeMs < 500)   return 95;
  if (tickAgeMs < 1500)  return 85;
  if (tickAgeMs < 3000)  return 70;
  if (tickAgeMs < 5000)  return 50;
  return 25;
}

/**
 * Score the execution opportunity.
 *
 * Weights: spread 50%, depth 30%, latency 20%
 *
 * @param {Object} opts
 * @param {number} opts.bid
 * @param {number} opts.ask
 * @param {number} opts.ltp
 * @param {string} [opts.depthQuality]  - from liquidityEngine.evaluate
 * @param {number} [opts.tickAgeMs]
 * @param {number} [opts.minThreshold=55]
 */
function evaluate({
  bid = null,
  ask = null,
  ltp = null,
  depthQuality = 'unknown',
  tickAgeMs = null,
  minThreshold = 55,
} = {}) {
  const spread = _spreadScore(bid, ask, ltp);
  const depth = _depthScore(depthQuality);
  const latency = _latencyScore(tickAgeMs);

  const score = Math.round(
    spread.score * 0.5 +
    depth        * 0.3 +
    latency      * 0.2
  );

  const passed = score >= minThreshold;
  return {
    score,
    passed,
    breakdown: {
      spread: spread.score, spreadPct: spread.spreadPct, spreadReason: spread.reason,
      depth, latency,
    },
    reasoning: passed
      ? `execution OK (score ${score}, spread ${spread.reason})`
      : `execution blocked (score ${score} < ${minThreshold}, spread ${spread.reason})`,
  };
}

module.exports = { evaluate };
