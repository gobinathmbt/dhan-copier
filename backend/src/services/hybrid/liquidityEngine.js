/**
 * Liquidity Engine
 * ----------------
 * Translates the existing `liquidityAnalysis.service.js` output into a
 * hard hybrid permission. We don't recompute anything — we just decide:
 *   - is the venue tradeable right now (Tier 1 gate)?
 *   - how much should we de-risk if it's "fair"?
 *   - is there an active sweep / stop-hunt risk?
 *
 * Returns one stable shape regardless of input quality so downstream code
 * can treat it as always-defined.
 */

function evaluate(liquidityAnalysis) {
  // Default conservative payload when no data is available.
  if (!liquidityAnalysis) {
    return {
      health: 'unknown',
      score: 0,
      sweepRisk: 'unknown',
      sweepDetected: false,
      spreadStatus: 'unknown',
      depthQuality: 'unknown',
      allowEntries: false,
      sizingFactor: 0,
      reasoning: 'Liquidity analysis unavailable — blocking entries',
    };
  }

  const health        = liquidityAnalysis.liquidity_health || 'unknown';
  const score         = Number(liquidityAnalysis.liquidity_score) || 0;
  const sweepRisk     = liquidityAnalysis.liquidity_sweeps?.sweep_risk || 'unknown';
  const sweepDetected = !!liquidityAnalysis.liquidity_sweeps?.sweep_detected;
  const spreadStatus  = liquidityAnalysis.spread_analysis?.spread_status || 'unknown';
  const depthQuality  = liquidityAnalysis.dom_depth?.depth_quality || 'unknown';
  const reasons = [];

  let allowEntries = true;
  let sizingFactor = 1.0;

  // Hard block: critical liquidity
  if (health === 'critical') {
    allowEntries = false;
    sizingFactor = 0;
    reasons.push('liquidity health critical');
  }
  // Hard block: active sweep / high sweep risk
  else if (sweepDetected || sweepRisk === 'high') {
    allowEntries = false;
    sizingFactor = 0;
    reasons.push('active liquidity sweep / stop-hunt risk');
  }
  // Hard block: spread blown out
  else if (spreadStatus === 'wide' || spreadStatus === 'extreme') {
    allowEntries = false;
    sizingFactor = 0;
    reasons.push(`spread ${spreadStatus}`);
  }
  // Soft de-risk: poor liquidity
  else if (health === 'poor') {
    sizingFactor = 0.5;
    reasons.push('poor liquidity — half size');
  }
  // Soft de-risk: fair liquidity
  else if (health === 'fair') {
    sizingFactor = 0.75;
    reasons.push('fair liquidity — 75% size');
  }
  // good / excellent: full size
  else {
    reasons.push(`liquidity ${health}`);
  }

  return {
    health,
    score,
    sweepRisk,
    sweepDetected,
    spreadStatus,
    depthQuality,
    allowEntries,
    sizingFactor,
    reasoning: reasons.join(' | '),
  };
}

module.exports = { evaluate };
