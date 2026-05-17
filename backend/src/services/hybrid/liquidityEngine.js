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
  // Default conservative payload when no data is available — but DON'T block.
  // NIFTY options trade through normal-fair liquidity all day; blocking on
  // unknown liquidity kills 30% of valid setups.
  if (!liquidityAnalysis) {
    return {
      health: 'unknown',
      score: 0,
      sweepRisk: 'unknown',
      sweepDetected: false,
      spreadStatus: 'unknown',
      depthQuality: 'unknown',
      allowEntries: true,        // calibration: don't block on missing liquidity data
      sizingFactor: 0.7,         // size down instead
      reasoning: 'liquidity data unavailable — sizing down 30%',
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

  // ONLY hard block: critical liquidity (catastrophic — exchange-level issues)
  if (health === 'critical') {
    allowEntries = false;
    sizingFactor = 0;
    reasons.push('liquidity health critical');
  }
  // Sweep risk → DO NOT block. Just size down and tighten. Real institutions
  // trade INTO sweeps for reversal entries.
  else if (sweepDetected || sweepRisk === 'high') {
    sizingFactor = 0.6;
    reasons.push('active sweep — size down 40%');
  }
  // Wide spread → size down, don't block
  else if (spreadStatus === 'extreme') {
    sizingFactor = 0.5;
    reasons.push('extreme spread — size down 50%');
  }
  else if (spreadStatus === 'wide') {
    sizingFactor = 0.75;
    reasons.push('wide spread — size down 25%');
  }
  // Calibrated health-based sizing
  else if (health === 'poor') {
    sizingFactor = 0.6;             // 0.5 → 0.6
    reasons.push('poor liquidity — 60% size');
  }
  else if (health === 'fair') {
    sizingFactor = 0.85;            // 0.75 → 0.85
    reasons.push('fair liquidity — 85% size');
  }
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
