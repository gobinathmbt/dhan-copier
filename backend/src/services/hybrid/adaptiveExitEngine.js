/**
 * Adaptive Exit Engine
 * ====================
 * Manages a live trade with institutional-style exit logic:
 *   - partial booking at 1R (40% off)
 *   - move SL to breakeven after the partial
 *   - trail remainder using one of multiple strategies (ATR / VWAP / swing /
 *     delta-failure / liquidity-reclaim) per the entry-type's exitStyle
 *
 * Inputs (called every monitor cycle):
 *   - trade        : current trade row (with entryPrice, currentPrice, sl,
 *                    target, partialBooked, breakevenSet, etc.)
 *   - currentLtp
 *   - rContext     : risk metric — entryPrice & SL → 1R distance
 *   - volumeAnalysis, oiAnalytics, vwap, mtfStructure, atr (current cycle)
 *
 * Returns a plan:
 *   { action: 'HOLD' | 'PARTIAL_EXIT' | 'TRAIL_SL' | 'EXIT',
 *     newSl, partialPct, reasoning }
 *
 * The monitor engine is the only caller. The plan is advisory — the monitor
 * already runs hard SL / target / max-hold rules above this layer.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : null; }

/**
 * @param {Object} args
 * @param {Object} args.trade       - includes entryPrice, sl, target, hybridEntrySnapshot
 * @param {number} args.currentLtp
 * @param {Object} [args.volumeAnalysis]
 * @param {Object} [args.oiAnalytics]
 * @param {Object} [args.vwap]
 * @param {Object} [args.mtfStructure]
 * @param {number} [args.atr]
 * @param {string} [args.exitStyle]  - from entry type evaluation
 */
function plan({ trade, currentLtp, volumeAnalysis, oiAnalytics, vwap, mtfStructure, atr, exitStyle = 'trail_atr_wide' } = {}) {
  if (!trade || !Number.isFinite(currentLtp)) return { action: 'HOLD', reasoning: 'no inputs' };

  const entry = Number(trade.entryPrice);
  const sl    = Number(trade.sl);
  const target = Number(trade.target);
  if (!entry || !sl) return { action: 'HOLD', reasoning: 'no entry/sl' };

  const direction = trade.signal === 'BUY_CE' ? 'bullish' : 'bearish';
  // R distance — option points
  const rDistance = Math.abs(entry - sl);
  const pnlPts = currentLtp - entry;
  const rMultiple = rDistance > 0 ? pnlPts / rDistance : 0;

  const partialBooked = !!trade.partialBooked;
  const breakevenSet  = !!trade.breakevenSet;

  // ── 1. Partial booking at +1R (40% off) ────────────────────────────────
  if (!partialBooked && rMultiple >= 1.0) {
    return {
      action: 'PARTIAL_EXIT',
      partialPct: 0.4,
      newSl: entry,                                    // also move SL to breakeven
      reasoning: `+1R reached (${rMultiple.toFixed(2)}R) — book 40%, SL → breakeven`,
    };
  }

  // ── 2. Once partial booked, never let SL drop below breakeven ──────────
  if (partialBooked && !breakevenSet && currentLtp > entry) {
    return {
      action: 'TRAIL_SL',
      newSl: entry,
      reasoning: 'lock breakeven after partial',
    };
  }

  // ── 3. Trail logic depends on exit style ───────────────────────────────
  const newSl = _computeTrailSl({ exitStyle, trade, currentLtp, atr, vwap, volumeAnalysis });
  if (Number.isFinite(newSl) && newSl > sl && newSl < currentLtp) {
    return { action: 'TRAIL_SL', newSl: Number(newSl.toFixed(2)), reasoning: `${exitStyle} trail` };
  }

  // ── 4. Delta failure — exit if delta flips against direction strongly ──
  const deltaPct = Number(volumeAnalysis?.delta?.cvdPctLong) || 0;
  const deltaBias = volumeAnalysis?.delta?.bias;
  if (rMultiple > 0.4) {                               // only after some progress
    if (direction === 'bullish' && deltaPct < -25 && (deltaBias === 'bearish' || deltaBias === 'mild_bearish')) {
      return { action: 'EXIT', reasoning: `delta failure (${deltaPct}%)` };
    }
    if (direction === 'bearish' && deltaPct > 25 && (deltaBias === 'bullish' || deltaBias === 'mild_bullish')) {
      return { action: 'EXIT', reasoning: `delta failure (${deltaPct}%)` };
    }
  }

  // ── 5. Liquidity reclaim trail (advanced) ──────────────────────────────
  // If price broke a key level then comes back through it → exit
  const acceptance = volumeAnalysis?.acceptance;
  if (rMultiple > 0.5 && trade.hybridEntrySnapshot?.volume?.acceptance) {
    const prev = trade.hybridEntrySnapshot.volume.acceptance;
    if (direction === 'bullish' && prev === 'above_va' && acceptance === 'below_va') {
      return { action: 'EXIT', reasoning: 'lost above-VA acceptance' };
    }
    if (direction === 'bearish' && prev === 'below_va' && acceptance === 'above_va') {
      return { action: 'EXIT', reasoning: 'lost below-VA acceptance' };
    }
  }

  return { action: 'HOLD', reasoning: `R=${rMultiple.toFixed(2)}` };
}

function _computeTrailSl({ exitStyle, trade, currentLtp, atr, vwap, volumeAnalysis }) {
  const direction = trade.signal === 'BUY_CE' ? 'bullish' : 'bearish';
  const sl = Number(trade.sl);
  const partialBooked = !!trade.partialBooked;

  // For OPTION premium SL, all the trails work in option-premium space.
  // We'll convert spot-side trails to option premium using an approximate
  // delta of 0.5 (caller can override later).

  switch (exitStyle) {
    case 'trail_atr_wide':
    case 'trail_atr': {
      if (!atr) return null;
      const mult = exitStyle === 'trail_atr_wide' ? 2.0 : 1.4;
      const trailDist = atr * mult * 0.5;          // 0.5 = approx delta
      const proposed = direction === 'bullish' ? currentLtp - trailDist : currentLtp + trailDist;
      // Direction-aware: SL only ever moves in profit direction
      if (direction === 'bullish' && proposed > sl) return proposed;
      if (direction === 'bearish' && proposed < sl) return proposed;
      return null;
    }
    case 'trail_swing': {
      // Use volumeAnalysis HVNs as swing points — trail behind the most
      // recent HVN below (for bullish) or above (for bearish)
      const hvns = volumeAnalysis?.frvp?.hvn || [];
      if (!hvns.length) return null;
      if (direction === 'bullish') {
        const below = hvns.filter(n => n.price < currentLtp).sort((a, b) => b.price - a.price);
        if (below.length) {
          // Spot-side level → option-side trail (approx)
          const distSpot = currentLtp - below[0].price;
          const proposed = currentLtp - distSpot * 0.5;
          if (proposed > sl) return proposed;
        }
      } else {
        const above = hvns.filter(n => n.price > currentLtp).sort((a, b) => a.price - b.price);
        if (above.length) {
          const distSpot = above[0].price - currentLtp;
          const proposed = currentLtp + distSpot * 0.5;
          if (proposed < sl) return proposed;
        }
      }
      return null;
    }
    case 'tight_sl_target_va':
    case 'fixed_target_tight_sl':
    case 'fast_scalp_target_poc':
    case 'fast_exit_if_stalls':
    default: {
      // Fairly tight: trail by 30% of profit distance
      const distFromEntry = Math.abs(currentLtp - Number(trade.entryPrice));
      if (distFromEntry < 4) return null;
      const proposed = direction === 'bullish' ? currentLtp - distFromEntry * 0.6
                                                : currentLtp + distFromEntry * 0.6;
      if (direction === 'bullish' && proposed > sl) return proposed;
      if (direction === 'bearish' && proposed < sl) return proposed;
      return null;
    }
  }
}

module.exports = { plan };
