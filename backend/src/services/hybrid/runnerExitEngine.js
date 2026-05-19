/**
 * Runner Exit Engine
 * ==================
 * Adaptive multi-phase exit logic for ultra-scalp / momentum trades.
 *
 * Modes (set by entry engine on the decision):
 *   - 'fixed'    : standard target/SL/max-hold (legacy behaviour)
 *   - 'hybrid'   : fixed target + smart-trail + volatility-adaptive giveback
 *   - 'runner'   : NO fixed target — ride momentum until it fades
 *
 * Phases (within hybrid/runner mode):
 *   PHASE 1  pre-lock   — entry → peak < lockTriggerPct of target
 *                         only hard SL exits here
 *   PHASE 2  locked     — peak crossed lockTriggerPct of target
 *                         exit if price ≤ entry + lockTriggerPct*target
 *                         exit if peak giveback ≥ adaptiveGiveback(ATR state)
 *   PHASE 3  runner     — peak ≥ target AND mode='runner'/'hybrid_runner_continuation'
 *                         exit only when momentum dies (UT flip / slope collapse / ATR contract)
 *
 * Volatility-adaptive giveback (peak-to-current giveback fraction):
 *   - low_vol  / dead       → 10%
 *   - normal                → 15%
 *   - expansion / high_vol  → 25%
 *
 * The engine is pure — given current state it returns one of:
 *   { action: 'HOLD' }
 *   { action: 'EXIT', reason }
 *   { action: 'TRAIL', newSl }     (caller may persist newSl)
 *
 * Both the live monitor and the backtest call decideRunnerExit() with
 * the same shape so live and backtest stay structurally aligned.
 */

const GIVEBACK_BY_VOL = {
  dead:      0.10,
  low:       0.10,
  normal:    0.15,
  expansion: 0.25,
  high:      0.25,
};

function _adaptiveGiveback(volState, override) {
  if (Number.isFinite(override) && override > 0) return override;
  return GIVEBACK_BY_VOL[String(volState || 'normal')] || 0.15;
}

/**
 * @param {object} args
 * @param {number} args.entry          entry premium
 * @param {number} args.current        current premium (LTP)
 * @param {number} args.peak           peak premium since entry
 * @param {number} args.targetPts      original fixed target in points
 * @param {number} args.slPts          original SL distance in points
 * @param {object} args.smartTrail     { lockTriggerPct, peakGivebackPct, mode }
 * @param {string} [args.volState]     volatility regime state
 * @param {object} [args.momentum]     { utFlipOpposite, slopeStrength, atrRising }
 * @param {number} args.heldSec
 * @param {number} args.maxHoldSec
 * @returns {{action:'HOLD'|'EXIT'|'TRAIL', reason?:string, phase:string}}
 */
function decideRunnerExit({
  entry, current, peak,
  targetPts, slPts,
  smartTrail = {},
  volState = 'normal',
  momentum = {},
  heldSec = 0,
  maxHoldSec = 180,
}) {
  if (!Number.isFinite(entry) || !Number.isFinite(current)) {
    return { action: 'HOLD', phase: 'invalid' };
  }
  const pnlPts = current - entry;
  const peakPts = Math.max(0, (peak || entry) - entry);
  const targetPrice = entry + targetPts;
  const slPrice     = entry - slPts;

  const mode             = smartTrail.mode || 'hybrid';
  const lockTriggerPct   = smartTrail.lockTriggerPct  || 0.5;
  const lockPts          = lockTriggerPct * targetPts;
  const lockedFloorPrice = entry + lockPts;

  // Phase determination
  let phase = 'pre_lock';
  if (peakPts >= targetPts) phase = 'runner';
  else if (peakPts >= lockPts) phase = 'locked';

  // Hard SL — always honoured
  if (current <= slPrice) {
    return { action: 'EXIT', reason: `SL hit ${current.toFixed(2)} ≤ ${slPrice.toFixed(2)}`, phase };
  }

  // Fixed target — only when mode is NOT runner. Hybrid honours target by
  // default but elite-tier hybrid_runner can suppress this if configured.
  if (mode === 'fixed' || mode === 'hybrid') {
    if (current >= targetPrice) {
      // For hybrid, allow target hit ONLY if we've not entered runner phase
      // (i.e. we explicitly want to bank at target on hybrid setups).
      if (mode === 'fixed' || phase !== 'runner') {
        return { action: 'EXIT', reason: `Target hit ${current.toFixed(2)} ≥ ${targetPrice.toFixed(2)}`, phase };
      }
    }
  }

  // Phase 2+ adaptive logic — only for hybrid / runner modes
  if (mode === 'fixed') return { action: 'HOLD', phase };

  // EARLY FAILURE DETECTION (NEW v6) — within first 60s, if peak P&L
  // never exceeded 2pts AND slope is compressing or against us, exit
  // immediately to save theta + spread bleed. Only fires when explicitly
  // enabled via smartTrail.earlyFailureCheck.
  if (smartTrail.earlyFailureCheck && heldSec >= 30 && heldSec <= 60
      && peakPts < 2 && pnlPts <= 0) {
    const slopeWeak = Number.isFinite(momentum.slopeStrength)
                   && momentum.slopeStrength < (smartTrail.earlyFailureSlope || 0.5);
    const slopeCompressing = momentum.slopeTrend === 'compressing';
    if (slopeWeak || slopeCompressing) {
      return {
        action: 'EXIT',
        reason: `Early failure: peak +${peakPts.toFixed(2)}pts at ${heldSec}s, ` +
                `slope=${momentum.slopeStrength?.toFixed?.(2) || '?'} (${momentum.slopeTrend || 'flat'})`,
        phase: 'early_failure',
      };
    }
  }

  // ANTI-MEDIOCRE FILTER (NEW v6.5, refined v6.7) — kill stagnant trades
  // early so we don't wait for TIMEOUT exits at +0.3 / +1.8pts that get
  // eaten by brokerage. Only fires on clear stagnation+retrace.
  const minEffPct  = smartTrail.minEfficiencyPct  ?? 0.30;
  const minEffHeld = smartTrail.minEfficiencyHeldSec ?? 60;
  if (minEffPct > 0 && phase === 'pre_lock' && heldSec >= minEffHeld) {
    const peakPctTarget = (peakPts / Math.max(1, targetPts)) * 100;
    const stagnant = current <= peak * 0.7;
    if (peakPctTarget < (minEffPct * 100) && stagnant) {
      return {
        action: 'EXIT',
        reason: `Anti-mediocre: peak +${peakPts.toFixed(2)}pts (${peakPctTarget.toFixed(0)}% of ${targetPts}pt target) after ${heldSec}s — stagnant + retraced`,
        phase: 'anti_mediocre',
      };
    }
  }

  // PROACTIVE FADE EXIT (NEW v6.8) — if we're past 50% of max hold and
  // pnlPts is negative, exit now before TIMEOUT eats more. UT Bot signal
  // is invalidating; cut losses early.
  const fadeAtPct = smartTrail.fadeAtPct ?? 0.50;
  if (fadeAtPct > 0 && phase === 'pre_lock' && heldSec >= maxHoldSec * fadeAtPct) {
    if (pnlPts < -1) {
      return {
        action: 'EXIT',
        reason: `Proactive fade: ${pnlPts.toFixed(2)}pts at ${heldSec}s/${maxHoldSec}s (${(fadeAtPct*100).toFixed(0)}%) — UT signal invalidating`,
        phase: 'proactive_fade',
      };
    }
  }

  // BREAKEVEN PROTECTION (NEW v6.6) — once we're up by ≥30% target, never
  // let it return to a loss. If price returns below entry+breakevenPct,
  // exit at small profit. Captures small wins instead of timeout losses.
  const beTriggerPct = smartTrail.breakevenTriggerPct ?? 0.30;
  const beFloorPct   = smartTrail.breakevenFloorPct   ?? 0.10;
  if (beTriggerPct > 0 && phase === 'pre_lock') {
    const peakPctTarget = (peakPts / Math.max(1, targetPts)) * 100;
    if (peakPctTarget >= (beTriggerPct * 100)) {
      const beFloorPrice = entry + (beFloorPct * targetPts);
      if (current <= beFloorPrice) {
        return {
          action: 'EXIT',
          reason: `BE protection: peak +${peakPts.toFixed(2)}pts (${peakPctTarget.toFixed(0)}%) returned to ${pnlPts.toFixed(2)}pts (≤ floor +${(beFloorPct * targetPts).toFixed(2)})`,
          phase: 'be_protection',
        };
      }
    }
  }

  if (phase === 'pre_lock') return { action: 'HOLD', phase };

  // PHASE 2 (locked): floor breach
  if (current < lockedFloorPrice) {
    return {
      action: 'EXIT',
      reason: `Smart-lock breach: peak +${peakPts.toFixed(2)}pts > lock @ +${lockPts.toFixed(2)}pts, ` +
              `now ${pnlPts.toFixed(2)}pts (below floor ${lockedFloorPrice.toFixed(2)})`,
      phase,
    };
  }

  // Volatility-adaptive giveback — uses smartTrail override or vol-state default
  const giveback = _adaptiveGiveback(volState, smartTrail.peakGivebackPct);
  const givebackPts = peakPts * giveback;
  const drawdownFromPeak = (peak || entry) - current;
  if (givebackPts > 0 && drawdownFromPeak >= givebackPts && pnlPts > 0) {
    return {
      action: 'EXIT',
      reason: `Adaptive trail: ${(drawdownFromPeak).toFixed(2)}pts giveback ` +
              `(${(giveback * 100).toFixed(0)}% of peak +${peakPts.toFixed(2)}pts, vol=${volState})`,
      phase,
    };
  }

  // PHASE 3 (runner): momentum-decay exits
  if (phase === 'runner' && (mode === 'runner' || mode === 'hybrid_runner_continuation')) {
    if (momentum.utFlipOpposite) {
      return {
        action: 'EXIT',
        reason: `Runner end: UT Bot flipped opposite (peak +${peakPts.toFixed(2)}pts, now ${pnlPts.toFixed(2)}pts)`,
        phase,
      };
    }
    if (Number.isFinite(momentum.slopeStrength) && momentum.slopeStrength < (smartTrail.slopeExitMin || 0.3)) {
      return {
        action: 'EXIT',
        reason: `Runner end: slope ${momentum.slopeStrength.toFixed(2)} < ${smartTrail.slopeExitMin || 0.3} (peak +${peakPts.toFixed(2)}pts, now ${pnlPts.toFixed(2)}pts)`,
        phase,
      };
    }
    if (momentum.atrRising === false && peakPts >= targetPts * 1.2) {
      return {
        action: 'EXIT',
        reason: `Runner end: ATR contracting (peak +${peakPts.toFixed(2)}pts, now ${pnlPts.toFixed(2)}pts)`,
        phase,
      };
    }
    // VELOCITY DECAY (NEW v6.5) — protect burst scalps that already booked
    // a respectable peak. If price has stopped advancing AND slope is
    // compressing, exit before the retrace eats the gain.
    if (peakPts >= 5 && momentum.slopeTrend === 'compressing' && pnlPts < peakPts * 0.85) {
      return {
        action: 'EXIT',
        reason: `Velocity decay: peak +${peakPts.toFixed(2)}pts, now ${pnlPts.toFixed(2)}pts, slope compressing — bank before retrace`,
        phase,
      };
    }
  }

  return { action: 'HOLD', phase };
}

module.exports = {
  decideRunnerExit,
  GIVEBACK_BY_VOL,
};
