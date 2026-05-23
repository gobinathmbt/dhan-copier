/**
 * Premium Velocity Gate
 * =====================
 * Measures whether a freshly-opened option scalp is *actually moving*
 * fast enough to capture its target. The premise: if a BUY_CE entry
 * doesn't show the option premium accelerating in our favour within
 * the first 30 seconds, the directional thesis is wrong (or the spot
 * move is too weak to translate to premium given current IV/delta).
 *
 * A "guaranteed 15pt" scalp on a 0.50-delta option needs the spot to
 * move 30pt in our favour within ~5min. That requires ~0.10pt premium/
 * second sustained. Anything below 0.05pt/sec by t=30s is a dead trade —
 * exit immediately rather than ride to time-decay loss.
 *
 * Returned shape mirrors supportScalpExitValidator decisions:
 *   { action: 'EXIT', reasoning, source, factors }
 *   { action: 'HOLD', reasoning, source, factors }
 *
 * Designed to be CALLED from supportScalpExitValidator AFTER the
 * min-hold guard but BEFORE the quick-fail and microstructure checks.
 * It's strictly opt-in via `settings.premiumVelocityGate.enabled`.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

/**
 * @param {object} args
 * @param {object} args.trade           — ScalpingTrade doc
 * @param {number} args.cur             — current premium
 * @param {number} args.elapsedSec      — seconds since trade open
 * @param {object} args.settings        — full settings (looks up premiumVelocityGate)
 * @returns {{ action: 'EXIT'|'HOLD', reasoning, source, factors }}
 */
function evaluate({ trade, cur, elapsedSec, settings = {} } = {}) {
  const cfg = settings?.premiumVelocityGate || {};
  if (cfg.enabled === false) {
    return { action: 'HOLD', source: 'velocity_gate:disabled', factors: {} };
  }

  const checkAtSec   = _safe(cfg.checkAtSec   || 30);   // when to evaluate
  const minVelocity  = _safe(cfg.minVelocityPtsPerSec || 0.05); // pts per second
  const minPnlAt30s  = _safe(cfg.minPnlAt30s || 0.5);   // and absolute pnl floor
  const maxNegativePts = _safe(cfg.maxNegativePts || -2.5); // cap drawdown
  const onlyEvaluateAtCheckSec = cfg.onlyEvaluateAtCheckSec === true;

  const entry = _safe(trade?.entryPrice);
  if (!entry || !cur) {
    return { action: 'HOLD', source: 'velocity_gate:missing_data', factors: {} };
  }
  const pnlPts = cur - entry;

  // Hard floor — if the option is already deeper underwater than the
  // capped quick-fail allowance, exit immediately. Don't wait 30s.
  if (pnlPts <= maxNegativePts && elapsedSec >= 5) {
    return {
      action: 'EXIT',
      reasoning: `[VELOCITY-GATE] Premium drawdown ${pnlPts.toFixed(2)}pts ≤ ${maxNegativePts}pts at ${elapsedSec}s — cap loss, exit`,
      source: 'velocity_gate:max_drawdown',
      factors: { pnlPts, elapsedSec, maxNegativePts },
    };
  }

  // Velocity check — at exactly the check window
  // (or any time after if onlyEvaluateAtCheckSec is false)
  if (onlyEvaluateAtCheckSec && elapsedSec !== checkAtSec) {
    return { action: 'HOLD', source: 'velocity_gate:wait', factors: { elapsedSec, checkAtSec } };
  }
  if (elapsedSec < checkAtSec) {
    return { action: 'HOLD', source: 'velocity_gate:warmup', factors: { elapsedSec, checkAtSec } };
  }

  const velocity = pnlPts / Math.max(1, elapsedSec);

  // The two failure modes:
  //   A) absolute pnl below threshold by check time
  //   B) velocity below threshold (i.e. trade is sluggish)
  const lowPnl      = pnlPts < minPnlAt30s;
  const lowVelocity = velocity < minVelocity;

  if (lowPnl && lowVelocity) {
    return {
      action: 'EXIT',
      reasoning: `[VELOCITY-GATE] Sluggish at ${elapsedSec}s — pnl ${pnlPts.toFixed(2)}pts (need ≥${minPnlAt30s}), ` +
                 `velocity ${velocity.toFixed(3)}pts/s (need ≥${minVelocity}). Spot/premium decoupled, exit.`,
      source: 'velocity_gate:sluggish',
      factors: { pnlPts, velocity: Number(velocity.toFixed(3)), elapsedSec, minPnlAt30s, minVelocity },
    };
  }

  return {
    action: 'HOLD',
    source: 'velocity_gate:passed',
    factors: { pnlPts, velocity: Number(velocity.toFixed(3)), elapsedSec },
  };
}

module.exports = { evaluate };
