/**
 * Strategy Playbook Engine
 * ========================
 * The institutional "auction-event" router.
 *
 * Real professional desks don't ask "is the market bullish or bearish?".
 * They ask: "WHICH AUCTION EVENT is currently happening, and WHICH PLAYBOOK
 * is appropriate for that event?"
 *
 * This engine sits on top of the regime / orderflow / volume layers and
 * detects ONE active institutional setup family per cycle:
 *
 *   TIER 1 — CORE MONEY MAKERS
 *     1. INITIATIVE_MOMENTUM_EXPANSION  — trend-day breakouts (negative gamma + expansion)
 *     2. FAILED_AUCTION_REVERSAL        — sweep-and-reclaim (highest expectancy)
 *     3. GAMMA_PIN_MEAN_REVERSION       — VAH/VAL fades during dealer pinning
 *     4. OPENING_DRIVE_CONTINUATION     — 09:15-10:00 institutional imbalance
 *     5. SHORT_COVERING_SQUEEZE /
 *        LONG_LIQUIDATION_CASCADE       — positioning-driven forced moves
 *
 *   TIER 2 — HIGH-VALUE SUPPORT
 *     6. VWAP_RECLAIM                   — clean reclaim with delta confirmation
 *     7. HVN_REJECTION_ROTATION         — auction rotation off composite HVN
 *     8. EXHAUSTION_REVERSAL            — climactic fade with absorption
 *     9. PULLBACK_CONTINUATION          — trend → pullback → continuation
 *
 *   TIER 3 — ADVANCED
 *    10. LVN_ACCEPTANCE_BREAKOUT        — initiative breakout + LVN acceptance
 *    11. WEEKLY_EXPIRY_DEALER_UNWIND    — Thu 14:00-15:00 gamma flips
 *
 * Each playbook returns:
 *   {
 *     name, family, valid, score, conviction,
 *     holdProfile: { tradeType, maxHoldSec, rrTarget },
 *     riskProfile: { slPct, sizingFactor },
 *     allowedDirections: ['bullish'] | ['bearish'] | ['both'],
 *     preconditions, confirmations, reasoning
 *   }
 *
 * Conviction:
 *   "elite"     — all preconditions + 2+ confirmations  → take it
 *   "standard"  — all preconditions + 1 confirmation    → take with smaller size
 *   "weak"      — preconditions only                    → skip
 *
 * The orchestrator picks the highest-scoring playbook whose `allowedDirections`
 * matches the trade direction AND whose family is permitted by the meta-regime.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }
function _clamp(s, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, Number(s) || 0)); }

// ─── PLAYBOOK 1: INITIATIVE_MOMENTUM_EXPANSION ─────────────────────────────
// Trend-day big-move-capture engine. Negative gamma + expansion vol +
// initiative orderflow + delta velocity + futures aligned + LVN breakout.
// Hold runners. Trail aggressively. Allow 1:3+ RR.
function _initiativeMomentumExpansion(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Hard preconditions
  const isExpansion = ctx.volatilityRegime?.state === 'expansion';
  const isTrendAuction = ctx.metaRegime?.state === 'trend_auction'
    || ctx.metaRegime?.state === 'short_covering'
    || ctx.metaRegime?.state === 'long_liquidation'
    || ctx.metaRegime?.state === 'dealer_hedging';   // negative gamma → momentum
  const isInitiative = ctx.orderflowState?.state === 'initiative_buying'
    || ctx.orderflowState?.state === 'initiative_selling'
    || (ctx.oiAnalytics?.regime || '').startsWith('aggressive_');

  if (!isExpansion)    required.push('volatility expansion');
  if (!isTrendAuction) required.push('trend/squeeze auction');
  if (!isInitiative)   required.push('initiative orderflow or aggressive OI');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'INITIATIVE_MOMENTUM_EXPANSION', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push('expansion + initiative');

  // Confirmations
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if ((ctx.direction === 'bullish' && deltaPct >= 12)
   || (ctx.direction === 'bearish' && deltaPct <= -12)) {
    score += 18; confirmations.push(`delta ${deltaPct}%`);
  }
  if (ctx.gammaRegime?.regime === 'negative') {
    score += 12; confirmations.push('negative gamma');
  }
  // VWAP aligned
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos === 'above')
   || (ctx.direction === 'bearish' && vwapPos === 'below')) {
    score += 10; confirmations.push(`VWAP ${vwapPos}`);
  }
  // Futures lead
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 8; confirmations.push('futures aligned');
  }
  // LVN breakout (price near LVN, moving in direction)
  const lvns = ctx.volumeAnalysis?.frvp?.lvn || [];
  if (ctx.spotPrice && lvns.some(l => Math.abs(l.price - ctx.spotPrice) < 15)) {
    score += 10; confirmations.push('LVN breakout');
  }
  // Above VA acceptance for bullish, below for bearish
  const acc = ctx.volumeAnalysis?.acceptance;
  if ((ctx.direction === 'bullish' && acc === 'above_va')
   || (ctx.direction === 'bearish' && acc === 'below_va')) {
    score += 8; confirmations.push(`accepted ${acc}`);
  }
  // MTF full alignment
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 8; confirmations.push('MTF full');
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'INITIATIVE_MOMENTUM_EXPANSION',
    family: 'momentum_continuation',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 900, rrTarget: 3.0 },
    riskProfile: { slPct: 0.13, sizingFactor: conviction === 'elite' ? 1.0 : 0.7 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['expansion', 'trend_auction', 'initiative'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ') || 'preconditions only'}`,
  };
}

// ─── PLAYBOOK 2: FAILED_AUCTION_REVERSAL ───────────────────────────────────
// Highest-expectancy NIFTY setup. Liquidity sweep → reclaim → squeeze.
// Detection: price swept a key level, delta diverged, reclaim with absorption.
function _failedAuctionReversal(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Need a sweep event in session memory OR auction excess
  const sm = ctx.sessionMemory || {};
  const sweepAbove = (sm.sweepsAboveHigh || 0) >= 1;
  const sweepBelow = (sm.sweepsBelowLow || 0) >= 1;
  const failedBkout = (sm.failedBreakouts || 0) >= 1;
  const failedBkdwn = (sm.failedBreakdowns || 0) >= 1;
  const auctionExcess = ctx.auctionState?.excessHigh || ctx.auctionState?.excessLow;

  // For bullish: sweep BELOW (longs flushed) → reclaim
  // For bearish: sweep ABOVE (shorts flushed) → rejection
  const sweepEvent = ctx.direction === 'bullish'
    ? (sweepBelow || failedBkdwn || ctx.auctionState?.excessLow)
    : (sweepAbove || failedBkout || ctx.auctionState?.excessHigh);
  if (!sweepEvent) required.push('liquidity sweep / failed break');

  // Delta divergence supporting reversal
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  const divergenceOK = div && div !== 'none' && divBias === ctx.direction;
  if (!divergenceOK) required.push('delta divergence');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'FAILED_AUCTION_REVERSAL', family: 'reversal',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 40; reasons.push('sweep + divergence');

  // Confirmations
  // Reclaim of VWAP/VAL/VAH
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos === 'above')
   || (ctx.direction === 'bearish' && vwapPos === 'below')) {
    score += 12; confirmations.push(`reclaimed VWAP (${vwapPos})`);
  }
  // OI absorption
  if (ctx.oiAnalytics?.absorption?.detected) {
    score += 14; confirmations.push(`OI absorption ${ctx.oiAnalytics.absorption.side}`);
  }
  // Responsive flow (institutional fading the move)
  if (ctx.orderflowState?.state === 'responsive_buying' && ctx.direction === 'bullish') {
    score += 12; confirmations.push('responsive buying');
  }
  if (ctx.orderflowState?.state === 'responsive_selling' && ctx.direction === 'bearish') {
    score += 12; confirmations.push('responsive selling');
  }
  // VSA absorption
  if (ctx.volumeAnalysis?.vsa?.pattern === 'absorption'
      && ctx.volumeAnalysis.vsa.bias === ctx.direction) {
    score += 10; confirmations.push('VSA absorption');
  }
  // Spring / upthrust VSA in our direction
  if ((ctx.volumeAnalysis?.vsa?.pattern === 'spring' && ctx.direction === 'bullish')
   || (ctx.volumeAnalysis?.vsa?.pattern === 'upthrust' && ctx.direction === 'bearish')) {
    score += 12; confirmations.push(`VSA ${ctx.volumeAnalysis.vsa.pattern}`);
  }
  // 5m CHOCH
  if ((ctx.direction === 'bullish' && ctx.mtfStructure?.choch5 === 'bullish_choch')
   || (ctx.direction === 'bearish' && ctx.mtfStructure?.choch5 === 'bearish_choch')) {
    score += 10; confirmations.push(`5m ${ctx.mtfStructure.choch5}`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 1 ? 'standard' : 'weak';

  return {
    name: 'FAILED_AUCTION_REVERSAL',
    family: 'reversal',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 360, rrTarget: 1.8 },
    riskProfile: { slPct: 0.10, sizingFactor: conviction === 'elite' ? 1.0 : 0.7 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['sweep', 'divergence'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 3: GAMMA_PIN_MEAN_REVERSION ──────────────────────────────────
// Daily consistency engine. Dealers pin price; rotate VAH ↔ POC ↔ VAL.
// Trade: edge rejections back to the pin.
function _gammaPinMeanReversion(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Hard preconditions
  if (ctx.metaRegime?.state !== 'gamma_pin'
      && ctx.metaRegime?.state !== 'balanced_auction'
      && ctx.metaRegime?.state !== 'slow_grind') {
    required.push('gamma_pin / balanced / slow_grind regime');
  }
  if (ctx.gammaRegime?.regime !== 'positive') required.push('positive gamma');
  if (ctx.volumeAnalysis?.acceptance !== 'inside_va') required.push('inside VA');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'GAMMA_PIN_MEAN_REVERSION', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push('gamma pin + inside VA');

  // Direction must align with VA edge fade:
  //   bullish trade: price near VAL/POC bottom → fade up
  //   bearish trade: price near VAH/POC top → fade down
  const poc = ctx.volumeAnalysis?.frvp?.pocPrice;
  const vah = ctx.volumeAnalysis?.frvp?.vaHigh;
  const val = ctx.volumeAnalysis?.frvp?.vaLow;
  const spot = ctx.spotPrice;
  let edgeOK = false;
  if (Number.isFinite(spot) && Number.isFinite(vah) && Number.isFinite(val)) {
    const range = vah - val;
    if (range > 0) {
      const posInRange = (spot - val) / range;     // 0=VAL, 1=VAH
      if (ctx.direction === 'bullish' && posInRange < 0.35) {
        edgeOK = true; score += 18; confirmations.push(`near VAL (${(posInRange*100).toFixed(0)}%)`);
      } else if (ctx.direction === 'bearish' && posInRange > 0.65) {
        edgeOK = true; score += 18; confirmations.push(`near VAH (${(posInRange*100).toFixed(0)}%)`);
      } else if (Math.abs(posInRange - 0.5) < 0.15) {
        score -= 5; confirmations.push('near POC (no edge)');
      }
    }
  }

  // Weak delta = ideal mean-revert setup (no momentum to fight)
  const deltaPct = Math.abs(_safe(ctx.volumeAnalysis?.delta?.cvdPctLong));
  if (deltaPct < 12) { score += 12; confirmations.push(`weak delta ${deltaPct}%`); }
  else if (deltaPct > 25) { score -= 15; confirmations.push(`strong delta ${deltaPct}% — wrong setup`); }

  // VSA absorption / spring / upthrust at edge
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa?.bias === ctx.direction) { score += 8; confirmations.push(`VSA ${vsa.pattern}`); }

  // Failed breakouts in session = pin is real
  const failed = (ctx.sessionMemory?.failedBreakouts || 0) + (ctx.sessionMemory?.failedBreakdowns || 0);
  if (failed >= 1) { score += 8; confirmations.push(`${failed} prior failed break`); }

  // Dead volatility helps — premium decay favours the seller, but for buyers
  // it means quick rotation back to pin
  if (ctx.volatilityRegime?.state === 'dead' || ctx.volatilityRegime?.atrPercentile < 30) {
    score += 6; confirmations.push('dead/low vol');
  }

  const conviction = (edgeOK && confirmations.length >= 3) ? 'elite' :
                     (edgeOK && confirmations.length >= 2) ? 'standard' :
                     edgeOK ? 'standard' : 'weak';

  return {
    name: 'GAMMA_PIN_MEAN_REVERSION',
    family: 'mean_reversion',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    // CALIBRATED 2026-05-18 cycle 4: 150s was too tight (cut wins short
    // mid-flight). 200s is the sweet spot — pin moves resolve in 60-180s
    // window, with a small buffer.
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 200, rrTarget: 1.0 },
    riskProfile: { slPct: 0.07, sizingFactor: 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['gamma_pin', 'positive_gamma', 'inside_va', 'edge_position'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 4: OPENING_DRIVE_CONTINUATION ────────────────────────────────
// 09:15-10:00 institutional opening imbalance. Strong volume + delta + OI.
function _openingDriveContinuation(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const hhmm = ctx.sessionPhase?.hhmm || 0;
  const inWindow = hhmm >= 915 && hhmm < 1000;
  if (!inWindow) required.push('opening window 09:15-10:00');

  // Delta strongly aligned
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaOK = (ctx.direction === 'bullish' && deltaPct >= 15)
              || (ctx.direction === 'bearish' && deltaPct <= -15);
  if (!deltaOK) required.push(`delta strongly ${ctx.direction} (got ${deltaPct}%)`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'OPENING_DRIVE_CONTINUATION', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 30; reasons.push('opening window + strong delta');

  // OI aligned
  const oiR = ctx.oiAnalytics?.regime || '';
  const oiOK = (ctx.direction === 'bullish'
                 && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
            || (ctx.direction === 'bearish'
                 && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'));
  if (oiOK) { score += 15; confirmations.push(`OI ${oiR}`); }

  // Volume spike on the candle
  if (ctx.volumeAnalysis?.timeVolume?.state === 'spike'
      || ctx.volumeAnalysis?.timeVolume?.state === 'climax') {
    score += 12; confirmations.push(`volume ${ctx.volumeAnalysis.timeVolume.state}`);
  }

  // Above/below opening range high/low (IB extension)
  const ibHigh = ctx.auctionState?.ibHigh;
  const ibLow  = ctx.auctionState?.ibLow;
  if (Number.isFinite(ctx.spotPrice) && Number.isFinite(ibHigh) && Number.isFinite(ibLow)) {
    if (ctx.direction === 'bullish' && ctx.spotPrice > ibHigh) {
      score += 14; confirmations.push('IB high break');
    }
    if (ctx.direction === 'bearish' && ctx.spotPrice < ibLow) {
      score += 14; confirmations.push('IB low break');
    }
  }

  // Futures alignment is critical at the open
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 10; confirmations.push('futures aligned');
  }

  // Breadth aligned
  const internals = ctx.marketInternals;
  if (internals) {
    const adv = _safe(internals.advances ?? internals.advance_decline_ratio);
    const dec = _safe(internals.declines) || 1;
    const ratio = adv / Math.max(1, dec);
    if (ctx.direction === 'bullish' && ratio > 1.3) {
      score += 6; confirmations.push(`breadth ${ratio.toFixed(2)}`);
    }
    if (ctx.direction === 'bearish' && ratio < 0.8) {
      score += 6; confirmations.push(`breadth ${ratio.toFixed(2)}`);
    }
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'OPENING_DRIVE_CONTINUATION',
    family: 'momentum_continuation',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 720, rrTarget: 2.5 },
    riskProfile: { slPct: 0.12, sizingFactor: conviction === 'elite' ? 1.0 : 0.7 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['opening_window', 'strong_delta'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 5: SHORT_COVERING_SQUEEZE / LONG_LIQUIDATION_CASCADE ────────
// Positioning-driven forced moves. Detected by OI velocity flip + direction.
function _positioningForcedMove(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const oiR = ctx.oiAnalytics?.regime || '';
  const isShortCovering = oiR === 'violent_short_covering';
  const isLongLiq       = oiR === 'long_unwinding_collapse';
  const directionOK = (isShortCovering && ctx.direction === 'bullish')
                   || (isLongLiq       && ctx.direction === 'bearish');
  if (!directionOK) required.push(`OI regime mismatch (${oiR} vs ${ctx.direction})`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'POSITIONING_FORCED_MOVE', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`OI ${oiR}`);

  // Delta accelerating in direction
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  if ((ctx.direction === 'bullish' && deltaPct > 8 && deltaTrend === 'rising')
   || (ctx.direction === 'bearish' && deltaPct < -8 && deltaTrend === 'falling')) {
    score += 15; confirmations.push(`delta accelerating ${deltaPct}%`);
  }

  // OI acceleration check
  const oiAccel = ctx.oiAnalytics?.accel;
  if (oiAccel) {
    if (ctx.direction === 'bullish' && (oiAccel.peAccel > 0 || oiAccel.ceAccel < 0)) {
      score += 10; confirmations.push('OI flip bullish');
    }
    if (ctx.direction === 'bearish' && (oiAccel.ceAccel > 0 || oiAccel.peAccel < 0)) {
      score += 10; confirmations.push('OI flip bearish');
    }
  }

  // VWAP reclaim helps
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos === 'above')
   || (ctx.direction === 'bearish' && vwapPos === 'below')) {
    score += 10; confirmations.push(`VWAP ${vwapPos}`);
  }

  // Futures flip
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 10; confirmations.push('futures aligned');
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: isShortCovering ? 'SHORT_COVERING_SQUEEZE' : 'LONG_LIQUIDATION_CASCADE',
    family: 'momentum_continuation',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 600, rrTarget: 2.5 },
    riskProfile: { slPct: 0.13, sizingFactor: conviction === 'elite' ? 1.0 : 0.7 },
    allowedDirections: isShortCovering ? ['bullish'] : ['bearish'],
    preconditions: ['oi_regime_aligned'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 6: VWAP_RECLAIM (CLEAN) ─────────────────────────────────────
// Strict reclaim event detection (was below → cross → hold 3 bars → delta improves)
function _vwapReclaimClean(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const vwap = ctx.vwap;
  const vwapVal = Number(vwap?.vwap);
  const dist = Math.abs(_safe(vwap?.distance_pct));
  if (!vwapVal) required.push('no VWAP');

  const c1m = ctx.candles1m || [];
  const recent = c1m.slice(-12);
  if (recent.length < 6) required.push('insufficient candles');

  let reclaimEvent = false;
  if (vwapVal && recent.length >= 6) {
    const closes = recent.map(c => c.c);
    const wasBelow = closes.some(c => c < vwapVal);
    const wasAbove = closes.some(c => c > vwapVal);
    const last3 = closes.slice(-3);
    if (ctx.direction === 'bullish' && wasBelow && last3.every(c => c > vwapVal) && dist < 0.4) {
      reclaimEvent = true;
    }
    if (ctx.direction === 'bearish' && wasAbove && last3.every(c => c < vwapVal) && dist < 0.4) {
      reclaimEvent = true;
    }
  }
  if (!reclaimEvent) required.push('no clean reclaim event');

  // Delta improving
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  const deltaOK = (ctx.direction === 'bullish' && deltaPct > 5 && deltaTrend === 'rising')
              || (ctx.direction === 'bearish' && deltaPct < -5 && deltaTrend === 'falling');
  if (!deltaOK) required.push('delta not improving');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'VWAP_RECLAIM_CLEAN', family: 'vwap_reclaim',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 40; reasons.push('clean reclaim + delta');

  // Confirmations
  const oiR = ctx.oiAnalytics?.regime || '';
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 12; confirmations.push(`OI ${oiR}`);
  }
  if (ctx.volumeAnalysis?.vsa?.pattern === 'absorption'
      && ctx.volumeAnalysis.vsa.bias === ctx.direction) {
    score += 10; confirmations.push('VSA absorption');
  }
  if (ctx.volumeAnalysis?.timeVolume?.state !== 'dry_up') {
    score += 6; confirmations.push('volume normal/spike');
  }
  if (ctx.mtfStructure?.alignment === 'full' || ctx.mtfStructure?.alignment === 'partial') {
    score += 8; confirmations.push(`MTF ${ctx.mtfStructure.alignment}`);
  }

  const conviction = confirmations.length >= 2 ? 'elite' :
                     confirmations.length >= 1 ? 'standard' : 'weak';

  return {
    name: 'VWAP_RECLAIM_CLEAN',
    family: 'vwap_reclaim',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 360, rrTarget: 1.6 },
    riskProfile: { slPct: 0.09, sizingFactor: conviction === 'elite' ? 1.0 : 0.7 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['clean_reclaim_event', 'delta_improving'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 7: HVN_REJECTION_ROTATION ────────────────────────────────────
// Auction rotation: price rejects composite/weekly HVN → rotates back through value.
function _hvnRejectionRotation(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Need a nearby composite HVN
  const compHvn = ctx.multiDayContext?.compositeProfile?.hvn || [];
  const intraHvn = ctx.volumeAnalysis?.frvp?.hvn || [];
  const allHvn = [...compHvn, ...intraHvn];
  const spot = ctx.spotPrice;
  let nearHvn = null;
  if (Number.isFinite(spot)) {
    nearHvn = allHvn.find(h => Math.abs(h.price - spot) < 12);
  }
  if (!nearHvn) required.push('no HVN within 12pts');

  // Direction: bullish trade requires price BELOW the HVN (rejection up); bearish above HVN
  if (nearHvn) {
    if (ctx.direction === 'bullish' && spot < nearHvn.price) {
      score += 15; confirmations.push(`HVN ${nearHvn.price} above (rejection up)`);
    } else if (ctx.direction === 'bearish' && spot > nearHvn.price) {
      score += 15; confirmations.push(`HVN ${nearHvn.price} below (rejection down)`);
    } else {
      required.push('wrong side of HVN');
    }
  }

  // Need balanced auction or gamma pin
  if (ctx.metaRegime?.state !== 'balanced_auction'
      && ctx.metaRegime?.state !== 'gamma_pin'
      && ctx.metaRegime?.state !== 'slow_grind') {
    required.push('not balanced/pin/grind');
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'HVN_REJECTION_ROTATION', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 25; reasons.push('HVN rejection setup');

  // VSA upthrust (bearish from HVN) / spring (bullish from HVN below)
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa?.bias === ctx.direction) { score += 10; confirmations.push(`VSA ${vsa.pattern}`); }

  // POC distance
  const poc = ctx.volumeAnalysis?.frvp?.pocPrice;
  if (Number.isFinite(poc) && Number.isFinite(spot) && Math.abs(poc - spot) > 15) {
    score += 8; confirmations.push(`POC ${poc.toFixed(0)} ${(poc-spot).toFixed(0)}pts away (target)`);
  }

  // Delta supportive
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if ((ctx.direction === 'bullish' && deltaPct > 0)
   || (ctx.direction === 'bearish' && deltaPct < 0)) {
    score += 6; confirmations.push(`delta ${deltaPct}%`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'HVN_REJECTION_ROTATION',
    family: 'mean_reversion',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.2 },
    riskProfile: { slPct: 0.08, sizingFactor: 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['near_hvn', 'balanced_regime', 'correct_side'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 8: EXHAUSTION_REVERSAL ──────────────────────────────────────
// Climactic move + delta divergence + absorption → fade.
function _exhaustionReversal(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Climactic volume
  const tv = ctx.volumeAnalysis?.timeVolume;
  if (tv?.state !== 'climax') required.push('not climactic volume');

  // Divergence in our direction
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  if (!div || div === 'none' || divBias !== ctx.direction) required.push('no fade divergence');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'EXHAUSTION_REVERSAL', family: 'exhaustion_fade',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push('climax + divergence');

  // Confirmations
  if (ctx.orderflowState?.state === 'exhaustion') {
    score += 15; confirmations.push('orderflow exhaustion');
  }
  if (ctx.volumeAnalysis?.vsa?.pattern === 'absorption'
      && ctx.volumeAnalysis.vsa.bias === ctx.direction) {
    score += 12; confirmations.push('VSA absorption');
  }
  // Auction excess
  if ((ctx.direction === 'bearish' && ctx.auctionState?.excessHigh)
   || (ctx.direction === 'bullish' && ctx.auctionState?.excessLow)) {
    score += 10; confirmations.push('auction excess');
  }
  // Trap engine corroborates
  if ((ctx.trap?.trapScore || 0) >= 50) {
    score += 8; confirmations.push(`trap ${ctx.trap.trapScore}`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 1 ? 'standard' : 'weak';

  return {
    name: 'EXHAUSTION_REVERSAL',
    family: 'exhaustion_fade',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.5 },
    riskProfile: { slPct: 0.08, sizingFactor: 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['climax', 'divergence'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 9: PULLBACK_CONTINUATION ────────────────────────────────────
// Trend → shallow pullback → continuation. Uses trend phase + VWAP proximity.
// CALIBRATED 2026-05-18 cycle 1: was 0/3 WR. Tighten to:
//   - Require MTF FULL (not partial) — pullbacks fail when 15m disagrees
//   - Require delta to be RECOVERING (rising for bullish, falling for bearish)
//   - Require trendPhase strength ≥ 70 (was 60) — only strong trends survive pullbacks
//   - Block in expiry afternoons — premium decay too fast for 600s holds
function _pullbackContinuation(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const phase = ctx.trendPhase?.phase;
  const phaseOK = (phase === 'markup' && ctx.direction === 'bullish')
              || (phase === 'markdown' && ctx.direction === 'bearish');
  if (!phaseOK) required.push(`trend phase ${phase} ≠ ${ctx.direction}`);

  // Trend strength must be ≥ 70 (was 60)
  if ((_safe(ctx.trendPhase?.strength)) < 70) required.push(`trend strength <70`);

  // VWAP supportive
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push('VWAP wrong side');
  }

  // MTF full alignment required (was partial OK)
  if (ctx.mtfStructure?.alignment !== 'full') required.push(`MTF ${ctx.mtfStructure?.alignment} not full`);

  // Block expiry afternoons (long hold + theta decay = death)
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1300) {
    required.push('expiry afternoon — too much theta');
  }
  // Block midday_chop session (fragile pullbacks fail in chop)
  if (ctx.sessionPhase?.phase === 'midday_chop') {
    required.push('midday_chop session');
  }

  // Delta must be RECOVERING in direction (was just positive/negative)
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  const deltaOK = (ctx.direction === 'bullish' && deltaPct > 5 && deltaTrend === 'rising')
              || (ctx.direction === 'bearish' && deltaPct < -5 && deltaTrend === 'falling');
  if (!deltaOK) required.push(`delta not recovering (${deltaPct}%, ${deltaTrend})`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'PULLBACK_CONTINUATION', family: 'pullback',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`${phase} + MTF full + delta ${deltaTrend}`);

  // Confirmations
  // Shallow retrace — close to VWAP
  const dist = Math.abs(_safe(ctx.vwap?.distance_pct));
  if (dist < 0.4) { score += 12; confirmations.push(`shallow retrace (${dist.toFixed(2)}%)`); }

  // OI continues to build in direction
  const oiR = ctx.oiAnalytics?.regime || '';
  if ((ctx.direction === 'bullish' && oiR === 'aggressive_long_buildup')
   || (ctx.direction === 'bearish' && oiR === 'aggressive_short_buildup')) {
    score += 10; confirmations.push(`OI ${oiR}`);
  }

  // Auction state
  if (ctx.auctionState?.dayType === 'trend_up' && ctx.direction === 'bullish') {
    score += 8; confirmations.push('trend_up auction');
  }
  if (ctx.auctionState?.dayType === 'trend_down' && ctx.direction === 'bearish') {
    score += 8; confirmations.push('trend_down auction');
  }

  // Volume normal — no dry-up (failed pullback)
  if (ctx.volumeAnalysis?.timeVolume?.state === 'dry_up') {
    score -= 12; confirmations.push('volume dry-up — pullback failing');
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'PULLBACK_CONTINUATION',
    family: 'pullback',
    valid: conviction !== 'weak' && score >= 55,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 480, rrTarget: 2.0 },
    riskProfile: { slPct: 0.10, sizingFactor: conviction === 'elite' ? 0.8 : 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['trend_phase_aligned', 'vwap_supportive', 'mtf_full', 'delta_recovering'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 10: WEEKLY_EXPIRY_DEALER_UNWIND (Tier-3, Thu 14:00-15:00) ────
function _weeklyExpiryDealerUnwind(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  if (!ctx.sessionPhase?.isExpiryDay) required.push('not expiry day');
  const hhmm = ctx.sessionPhase?.hhmm || 0;
  if (hhmm < 1400 || hhmm >= 1500) required.push('not in 14:00-15:00 window');

  // Need price near gamma flip level
  const flip = ctx.gammaRegime?.gammaFlip;
  if (Number.isFinite(flip) && Number.isFinite(ctx.spotPrice)) {
    const distFlip = Math.abs(ctx.spotPrice - flip);
    if (distFlip > 25) required.push(`gamma flip ${flip} > 25pts away`);
  } else {
    required.push('no gamma flip data');
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'WEEKLY_EXPIRY_DEALER_UNWIND', family: 'breakout_expansion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push('expiry power-hour + near gamma flip');

  // OI velocity expanding strongly
  const ceVel = Math.abs(_safe(ctx.oiAnalytics?.diff?.ceVelocity));
  const peVel = Math.abs(_safe(ctx.oiAnalytics?.diff?.peVelocity));
  if (ceVel > 200_000 || peVel > 200_000) {
    score += 15; confirmations.push(`OI vel ce=${ceVel.toFixed(0)} pe=${peVel.toFixed(0)}`);
  }

  // Delta strong in direction
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if (Math.abs(deltaPct) > 12) { score += 10; confirmations.push(`delta ${deltaPct}%`); }

  // Volatility expanding
  if (ctx.volatilityRegime?.state === 'expansion') {
    score += 10; confirmations.push('vol expansion');
  }

  const conviction = confirmations.length >= 2 ? 'elite' :
                     confirmations.length >= 1 ? 'standard' : 'weak';

  return {
    name: 'WEEKLY_EXPIRY_DEALER_UNWIND',
    family: 'breakout_expansion',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 480, rrTarget: 3.0 },
    riskProfile: { slPct: 0.14, sizingFactor: 0.6 },     // smaller — expiry is binary
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['expiry_day', 'expiry_window', 'near_gamma_flip'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 11: COMPOSITE_PROFILE_EDGE_REJECTION ────────────────────────
// Multi-day institutional auction. Price tests composite (5-day) VAH/VAL/POC
// and rejects → rotates back through value. Highest-WR mean-reversion setup
// because composite levels are where ALL recent institutional value sits.
//
// Direction logic:
//   Bullish trade : spot is at/below CompVAL or PrevDay low → fade up (target POC)
//   Bearish trade : spot is at/above CompVAH or PrevDay high → fade down (target POC)
function _compositeProfileEdgeRejection(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const cp = ctx.multiDayContext?.compositeProfile;
  const pd = ctx.multiDayContext?.priorDay;
  const spot = ctx.spotPrice;
  if (!cp || !Number.isFinite(spot)) required.push('no composite profile');

  // Identify which composite edge is being tested
  let edge = null;
  let edgePrice = null;
  let edgeKind = null;
  if (cp && Number.isFinite(spot)) {
    const checks = [
      { name: 'CompVAH', price: cp.vah, side: 'top' },
      { name: 'CompVAL', price: cp.val, side: 'bottom' },
    ];
    if (pd) {
      checks.push({ name: 'PDH', price: pd.high, side: 'top' });
      checks.push({ name: 'PDL', price: pd.low,  side: 'bottom' });
    }
    let bestDist = Infinity;
    for (const c of checks) {
      if (!Number.isFinite(c.price)) continue;
      const d = Math.abs(c.price - spot);
      if (d < bestDist && d < 18) {                 // within 18pts is "at the edge"
        bestDist = d;
        edge = c.name; edgePrice = c.price; edgeKind = c.side;
      }
    }
  }
  if (!edge) required.push('not at composite edge');

  // Direction must be a FADE of the edge:
  //   top edge    → bearish fade
  //   bottom edge → bullish fade
  let directionOK = false;
  if (edge) {
    if (edgeKind === 'top'    && ctx.direction === 'bearish') directionOK = true;
    if (edgeKind === 'bottom' && ctx.direction === 'bullish') directionOK = true;
  }
  if (!directionOK) required.push('direction not a fade of edge');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'COMPOSITE_PROFILE_EDGE_REJECTION', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`at ${edge}@${edgePrice} (${edgeKind})`);

  // Confirmations
  // Rejection wick / VSA upthrust (top) or spring (bottom)
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa) {
    if (edgeKind === 'top' && (vsa.pattern === 'upthrust' || (vsa.bias === 'bearish' && vsa.strength >= 50))) {
      score += 14; confirmations.push(`VSA ${vsa.pattern}`);
    }
    if (edgeKind === 'bottom' && (vsa.pattern === 'spring' || (vsa.bias === 'bullish' && vsa.strength >= 50))) {
      score += 14; confirmations.push(`VSA ${vsa.pattern}`);
    }
  }

  // Delta divergence in our direction (price tested edge but delta failed)
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  if (div && div !== 'none' && divBias === ctx.direction) {
    score += 12; confirmations.push(`delta div ${div}`);
  }

  // Acceptance must NOT be aggressive beyond the edge
  // (we want the edge HOLDING, not breaking)
  const acc = ctx.volumeAnalysis?.acceptance;
  if (edgeKind === 'top' && acc !== 'above_va') {
    score += 8; confirmations.push(`acceptance ${acc} (edge holding)`);
  }
  if (edgeKind === 'bottom' && acc !== 'below_va') {
    score += 8; confirmations.push(`acceptance ${acc} (edge holding)`);
  }
  if (edgeKind === 'top' && acc === 'above_va') { score -= 12; confirmations.push('acceptance above VA — edge breaking'); }
  if (edgeKind === 'bottom' && acc === 'below_va') { score -= 12; confirmations.push('acceptance below VA — edge breaking'); }

  // POC distance is the target — make sure it's > 12pts away (worth trading)
  if (Number.isFinite(cp?.poc) && Math.abs(cp.poc - spot) > 12) {
    score += 8; confirmations.push(`POC target ${(cp.poc - spot).toFixed(0)}pts away`);
  }

  // Balanced / pin / slow-grind regimes amplify edge rejection
  if (ctx.metaRegime?.state === 'balanced_auction'
    || ctx.metaRegime?.state === 'gamma_pin'
    || ctx.metaRegime?.state === 'slow_grind') {
    score += 8; confirmations.push(`${ctx.metaRegime.state} regime`);
  }

  // Trap engine corroborates (failed breakout at the edge)
  if ((ctx.trap?.trapScore || 0) >= 40) {
    score += 6; confirmations.push(`trap ${ctx.trap.trapScore}`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'COMPOSITE_PROFILE_EDGE_REJECTION',
    family: 'mean_reversion',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 360, rrTarget: 1.5 },
    riskProfile: { slPct: 0.09, sizingFactor: conviction === 'elite' ? 0.9 : 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['composite_edge', 'fade_direction'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | edge=${edge}@${edgePrice} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 12: VOLATILITY_COMPRESSION_SQUEEZE ──────────────────────────
// Pre-breakout entry. ATR percentile <25 + range compression + sudden volume
// expansion + acceptance shifting toward direction. Catches the start of an
// expansion move BEFORE the trend confirms.
function _volatilityCompressionSqueeze(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // CALIBRATED 2026-05-18 cycle 1: Block when positive gamma is suppressing
  // expansion (the squeeze can't resolve through dealer pin) and on expiry
  // afternoons (theta + binary moves).
  if (ctx.gammaRegime?.regime === 'positive'
      && Math.abs(_safe(ctx.gammaRegime?.spotVsPin)) < 30) {
    required.push(`positive gamma pin within 30pts (suppresses squeeze)`);
  }
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1300) {
    required.push('expiry afternoon');
  }

  // Compression: low ATR percentile + tight range. Either a low ATR pct (≤35)
  // OR an explicit rangeCompression flag suffices — these often occur near
  // the start of a session before expansion confirms.
  const atrPct = _safe(ctx.volatilityRegime?.atrPercentile);
  const rangeC = _safe(ctx.volatilityRegime?.rangeCompression);
  const compressed = (atrPct > 0 && atrPct <= 35) || rangeC > 0;
  if (!compressed) required.push(`not compressed (ATR pct ${atrPct}, rangeC ${rangeC})`);

  // Volume must be expanding (spike or rising) — the spark
  const tv = ctx.volumeAnalysis?.timeVolume;
  const volExpanding = tv?.state === 'spike' || tv?.state === 'climax'
    || _safe(tv?.ratio) >= 1.3;
  if (!volExpanding) required.push(`vol not expanding (state ${tv?.state}, ratio ${tv?.ratio})`);

  // Direction must align with delta breakout
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  const deltaOK = (ctx.direction === 'bullish' && deltaPct > 5 && (deltaTrend === 'rising' || deltaTrend === 'flat'))
              || (ctx.direction === 'bearish' && deltaPct < -5 && (deltaTrend === 'falling' || deltaTrend === 'flat'));
  if (!deltaOK) required.push(`delta not breaking out (pct ${deltaPct}, trend ${deltaTrend})`);

  // CALIBRATED cycle 2: Squeeze playbook had 33% WR. Require initiative
  // orderflow — without it the move is dealer hedging, not real expansion.
  const ofOK = (ctx.direction === 'bullish' && ctx.orderflowState?.state === 'initiative_buying')
            || (ctx.direction === 'bearish' && ctx.orderflowState?.state === 'initiative_selling');
  if (!ofOK) required.push(`orderflow ${ctx.orderflowState?.state} not initiative`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'VOLATILITY_COMPRESSION_SQUEEZE', family: 'breakout_expansion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`compressed (ATR ${atrPct}) + vol spike + delta breakout`);

  // Confirmations
  // Expansion volatility now flagged (the squeeze IS resolving)
  if (ctx.volatilityRegime?.state === 'expansion') {
    score += 14; confirmations.push('vol regime expansion');
  }
  // OI velocity expanding
  const oiR = ctx.oiAnalytics?.regime || '';
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 12; confirmations.push(`OI ${oiR}`);
  }
  // VWAP supportive
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos === 'above')
   || (ctx.direction === 'bearish' && vwapPos === 'below')) {
    score += 10; confirmations.push(`VWAP ${vwapPos}`);
  }
  // Initiative orderflow
  if ((ctx.orderflowState?.state === 'initiative_buying' && ctx.direction === 'bullish')
   || (ctx.orderflowState?.state === 'initiative_selling' && ctx.direction === 'bearish')) {
    score += 12; confirmations.push(`orderflow ${ctx.orderflowState.state}`);
  }
  // LVN ahead = clean room to expand
  const lvns = ctx.volumeAnalysis?.frvp?.lvn || [];
  if (Number.isFinite(ctx.spotPrice) && lvns.some(l => Math.abs(l.price - ctx.spotPrice) < 18)) {
    score += 8; confirmations.push('LVN clear path');
  }
  // Futures lead
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('futures aligned');
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'VOLATILITY_COMPRESSION_SQUEEZE',
    family: 'breakout_expansion',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 720, rrTarget: 3.0 },
    riskProfile: { slPct: 0.13, sizingFactor: conviction === 'elite' ? 0.9 : 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['compressed_volatility', 'volume_expansion', 'delta_breakout'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 13: IV_CRUSH_FADE ───────────────────────────────────────────
// Asymmetric premium decay: when ATM IV drops > 1.5pts in 30min OR > 3pts
// session-high → low, premium falls fast. Trade the side benefiting from
// the price direction WHILE IV is collapsing (premium expansion fights theta
// less effectively for the OTHER side).
//
// Best on: post-expiry-open (IV drops 09:15-10:00), post-event days (RBI/Fed
// announcements), Friday afternoons (weekend theta acceleration).
function _ivCrushFade(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const iv = ctx.ivStats;
  if (!iv || iv.samples < 4) required.push('insufficient IV samples');
  // IV must be crushing (rapid drop)
  if (iv && iv.state !== 'crushing') required.push(`IV state ${iv.state}, not crushing`);
  // Drop from session-high must be meaningful (≥3% relative or ≥1.5 absolute)
  const dropOK = iv && (Math.abs(iv.dropPctFromHigh) >= 3 || Math.abs(iv.dropFromHigh) >= 1.5);
  if (iv && !dropOK) required.push(`drop too small (${iv.dropPctFromHigh}%)`);

  // Direction: IV crush typically follows a directional move OR pre-expiry drift.
  // We require price to have a CLEAR directional bias confirmed by VWAP + delta.
  const vwapPos = ctx.vwap?.position;
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const directionConfirmed =
       (ctx.direction === 'bullish' && vwapPos === 'above' && deltaPct > 4)
    || (ctx.direction === 'bearish' && vwapPos === 'below' && deltaPct < -4);
  if (!directionConfirmed) required.push('direction not clearly confirmed');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'IV_CRUSH_FADE', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`IV crushing ${iv.dropPctFromHigh}% (${iv.dropFromHigh}pts)`);

  // Confirmations
  // Strongly compressed pinning regime amplifies the crush
  if (ctx.gammaRegime?.regime === 'positive'
      && Math.abs(_safe(ctx.gammaRegime?.spotVsPin)) < 25) {
    score += 12; confirmations.push('gamma pin amplifies crush');
  }
  // Multi-day IV percentile already low (we're crushing further)
  if (Number.isFinite(ctx.ivPercentile) && ctx.ivPercentile < 40) {
    score += 8; confirmations.push(`IV pct ${ctx.ivPercentile}`);
  }
  // Expiry day or Friday afternoon
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1300) {
    score += 14; confirmations.push('expiry afternoon');
  }
  // Volatility regime is dead or compressed
  if (ctx.volatilityRegime?.state === 'dead' || ctx.volatilityRegime?.atrPercentile < 30) {
    score += 6; confirmations.push('low ATR percentile');
  }
  // Acceptance inside VA = clean rotational fade
  if (ctx.volumeAnalysis?.acceptance === 'inside_va') {
    score += 8; confirmations.push('inside VA');
  }
  // OI building in our direction
  const oiR = ctx.oiAnalytics?.regime || '';
  if ((ctx.direction === 'bullish' && oiR === 'aggressive_long_buildup')
   || (ctx.direction === 'bearish' && oiR === 'aggressive_short_buildup')) {
    score += 8; confirmations.push(`OI ${oiR}`);
  }

  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 3 ? 'standard' : 'weak';

  return {
    name: 'IV_CRUSH_FADE',
    family: 'mean_reversion',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 300, rrTarget: 1.4 },
    riskProfile: { slPct: 0.07, sizingFactor: 0.5 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['iv_crushing', 'direction_confirmed'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 14: VWAP_BOUNCE_SCALP (high-availability filler) ────────────
// A simple, high-availability fallback playbook for days when nothing else
// matches. Captures the bread-and-butter intraday setup: price tags VWAP,
// shows a rejection wick, delta turns in our direction, OI confirms.
//
// Used when other playbooks find no match in the current meta-regime, so
// we can still capture 1-2 entries on otherwise quiet days. Tight SL,
// fast scalp profile to keep risk low.
function _vwapBounceScalp(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const vwap = ctx.vwap;
  const vwapVal = Number(vwap?.vwap);
  const dist = Math.abs(_safe(vwap?.distance_pct));
  if (!vwapVal) required.push('no VWAP');
  if (dist > 0.65) required.push(`too far from VWAP (${dist.toFixed(2)}%)`);

  // Direction must align with VWAP position (price near VWAP, on right side)
  const vwapPos = vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push('VWAP wrong side');
  }

  // Delta must be in direction (≥3% for confirmation)
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaOK = (ctx.direction === 'bullish' && deltaPct > 3)
              || (ctx.direction === 'bearish' && deltaPct < -3);
  if (!deltaOK) required.push(`delta weak (${deltaPct}%)`);

  // Volume not drying up
  if (ctx.volumeAnalysis?.timeVolume?.state === 'dry_up') required.push('vol dry-up');

  // Block during dead vol + gamma_pin (we already have GAMMA_PIN_MEAN_REVERSION
  // as the optimal there)
  if (ctx.metaRegime?.state === 'gamma_pin'
      && ctx.volatilityRegime?.state === 'dead') {
    required.push('gamma_pin + dead vol — use GAMMA_PIN_MEAN_REVERSION instead');
  }

  // Block in expiry afternoons (theta brutal)
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1400) {
    required.push('expiry afternoon');
  }

  // CALIBRATED cycle 14: 4 losses, all had OI not aligned with direction.
  // Require OI to confirm or at least not oppose.
  const oiR3 = ctx.oiAnalytics?.regime || '';
  const oiAligned3 = (ctx.direction === 'bullish' && (oiR3 === 'aggressive_long_buildup' || oiR3 === 'violent_short_covering'))
                 || (ctx.direction === 'bearish' && (oiR3 === 'aggressive_short_buildup' || oiR3 === 'long_unwinding_collapse'));
  const oiAgainst = (ctx.direction === 'bullish' && (oiR3 === 'aggressive_short_buildup' || oiR3 === 'long_unwinding_collapse'))
                || (ctx.direction === 'bearish' && (oiR3 === 'aggressive_long_buildup' || oiR3 === 'violent_short_covering'));
  if (oiAgainst) required.push(`OI ${oiR3} against direction`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'VWAP_BOUNCE_SCALP', family: 'vwap_reclaim',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 30; reasons.push('VWAP bounce + delta');

  // Confirmations
  // OI in direction (now also a confirmation)
  if (oiAligned3) {
    score += 12; confirmations.push(`OI ${oiR3}`);
  }

  // VSA helps
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa?.bias === ctx.direction && _safe(vsa.strength) >= 40) {
    score += 10; confirmations.push(`VSA ${vsa.pattern}`);
  }

  // Liquidity good
  if (ctx.liquidity?.health === 'good' || ctx.liquidity?.health === 'excellent') {
    score += 6; confirmations.push(`liq ${ctx.liquidity.health}`);
  }

  // MTF supportive
  if (ctx.mtfStructure?.alignment === 'full' || ctx.mtfStructure?.alignment === 'partial') {
    score += 8; confirmations.push(`MTF ${ctx.mtfStructure.alignment}`);
  }

  // Acceptance favourable
  const acc = ctx.volumeAnalysis?.acceptance;
  if ((ctx.direction === 'bullish' && (acc === 'above_va' || acc === 'inside_va'))
   || (ctx.direction === 'bearish' && (acc === 'below_va' || acc === 'inside_va'))) {
    score += 5; confirmations.push(`acceptance ${acc}`);
  }

  // Futures alignment
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('futures aligned');
  }

  // CALIBRATED cycle 24: require 3+ confirmations for graduation. Cycle 18-22
  // showed 32 losses dominated by 'standard' conviction trades (only 2 confs).
  // Boosting bar to 3 confs cuts the weakest signals while keeping 100+ trades.
  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 3 ? 'standard' : 'weak';
  return {
    name: 'VWAP_BOUNCE_SCALP',
    family: 'vwap_reclaim',
    valid: conviction !== 'weak' && score >= 45,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.3 },
    riskProfile: { slPct: 0.09, sizingFactor: 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['near_vwap', 'right_side', 'delta_with', 'vol_active'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 15: TREND_VWAP_FOLLOW (high-availability trend-day filler) ──
// Simple trend-following entry for days when the heavyweight playbooks
// (initiative momentum, opening drive, breakout expansion) don't quite
// trigger but the market is clearly trending. Tight risk to keep it safe.
//
// Used in trend_auction / short_covering / long_liquidation /
// dealer_hedging / expiry_expansion regimes when nothing else fires.
function _trendVwapFollow(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Direction must align with both regime and VWAP and 5m trend
  const regime = ctx.marketRegime?.regime;
  const regimeBullish = regime === 'trending_bullish';
  const regimeBearish = regime === 'trending_bearish';
  if (!(regimeBullish || regimeBearish)) required.push('not trending regime');

  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side (${vwapPos})`);
  }

  // Direction must match regime bias
  if ((ctx.direction === 'bullish' && !regimeBullish)
   || (ctx.direction === 'bearish' && !regimeBearish)) {
    required.push('direction vs regime mismatch');
  }

  // Block expiry afternoons (theta brutal)
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1400) {
    required.push('expiry afternoon');
  }

  // Block dead volatility (no follow-through)
  if (ctx.volatilityRegime?.state === 'dead') {
    required.push('dead volatility');
  }

  // CALIBRATED 2026-05-18 cycle 14-15: 4 TIMEOUT losses on TREND_VWAP_FOLLOW.
  // Cycle 15 still showed 88 trend_auction zero blocks — too tight at 8%.
  // Require delta > 6% AND OI alignment to keep quality without starving
  // the trend_auction regime.
  const deltaPctReq = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaStrong = (ctx.direction === 'bullish' && deltaPctReq > 6)
                  || (ctx.direction === 'bearish' && deltaPctReq < -6);
  if (!deltaStrong) required.push(`delta too weak for trend-follow (${deltaPctReq}%)`);

  const oiR2 = ctx.oiAnalytics?.regime || '';
  const oiAligned = (ctx.direction === 'bullish' && (oiR2 === 'aggressive_long_buildup' || oiR2 === 'violent_short_covering'))
                || (ctx.direction === 'bearish' && (oiR2 === 'aggressive_short_buildup' || oiR2 === 'long_unwinding_collapse'));
  if (!oiAligned) required.push(`OI ${oiR2} not aligned`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'TREND_VWAP_FOLLOW', family: 'pullback',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 30; reasons.push(`${regime} + VWAP ${vwapPos}`);

  // Confirmations
  // Delta in direction
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if ((ctx.direction === 'bullish' && deltaPct > 5)
   || (ctx.direction === 'bearish' && deltaPct < -5)) {
    score += 12; confirmations.push(`delta ${deltaPct}%`);
  }

  // OI in direction
  const oiR = ctx.oiAnalytics?.regime || '';
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 12; confirmations.push(`OI ${oiR}`);
  }

  // MTF supportive
  if (ctx.mtfStructure?.alignment === 'full') { score += 10; confirmations.push('MTF full'); }
  else if (ctx.mtfStructure?.alignment === 'partial') { score += 5; confirmations.push('MTF partial'); }

  // VWAP close (not extended)
  const dist = Math.abs(_safe(ctx.vwap?.distance_pct));
  if (dist < 0.4) { score += 6; confirmations.push(`near VWAP ${dist.toFixed(2)}%`); }

  // Liquidity good
  if (ctx.liquidity?.health === 'good' || ctx.liquidity?.health === 'excellent') {
    score += 5; confirmations.push(`liq ${ctx.liquidity.health}`);
  }

  // Futures aligned
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('futures aligned');
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'TREND_VWAP_FOLLOW',
    family: 'pullback',
    valid: conviction !== 'weak' && score >= 50,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 360, rrTarget: 1.6 },
    riskProfile: { slPct: 0.10, sizingFactor: 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['trending_regime', 'vwap_supportive', 'direction_match'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 16: COUNTER_TREND_REVERSAL (regime-counter setup) ──────────
// When the meta is trending but direction is OPPOSITE the regime, we may
// be catching a clean reversal at a key level. Strict preconditions —
// only fires on very high-quality counter-trend setups (sweep + absorption
// + delta divergence) so it doesn't bleed.
//
// Used in: trend_auction, short_covering, long_liquidation, dealer_hedging
// when the playbook engine has no other valid match for the
// (regime, direction) combo.
function _counterTrendReversal(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Need a trending regime
  const regime = ctx.marketRegime?.regime;
  const inTrendRegime = regime === 'trending_bullish' || regime === 'trending_bearish';
  if (!inTrendRegime) required.push('not trending regime');

  // Direction must OPPOSE the trend (counter-trend setup)
  if (regime === 'trending_bullish' && ctx.direction !== 'bearish') required.push('direction not counter-trend');
  if (regime === 'trending_bearish' && ctx.direction !== 'bullish') required.push('direction not counter-trend');

  // Delta divergence in our direction (price going one way, delta the other)
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  const hasDivergence = div && div !== 'none' && divBias === ctx.direction;

  // OR VSA absorption / spring / upthrust supporting our direction
  const vsa = ctx.volumeAnalysis?.vsa;
  const hasVsaSupport = vsa?.bias === ctx.direction && _safe(vsa.strength) >= 50;

  // OR auction excess in our direction (spike rejection at an extreme)
  const hasExcess = (ctx.direction === 'bullish' && ctx.auctionState?.excessLow)
                 || (ctx.direction === 'bearish' && ctx.auctionState?.excessHigh);

  if (!hasDivergence && !hasVsaSupport && !hasExcess) {
    required.push('need divergence OR VSA absorption/spring/upthrust OR auction excess');
  }

  // Block midday_chop and expiry afternoons (low quality)
  if (ctx.sessionPhase?.phase === 'midday_chop') required.push('midday_chop');
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1300) required.push('expiry afternoon');

  // Block dead vol
  if (ctx.volatilityRegime?.state === 'dead') required.push('dead volatility');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'COUNTER_TREND_REVERSAL', family: 'reversal',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`counter-trend ${ctx.direction} vs ${regime}`);

  // Confirmations — counts each evidence piece
  if (hasDivergence) { score += 12; confirmations.push(`delta div ${div}`); }
  if (hasVsaSupport) { score += 12; confirmations.push(`VSA ${vsa.pattern}`); }
  if (hasExcess) { score += 10; confirmations.push('auction excess'); }

  // VWAP context — look for reclaim/rejection at VWAP
  const vwapPos = ctx.vwap?.position;
  const dist = Math.abs(_safe(ctx.vwap?.distance_pct));
  if ((ctx.direction === 'bullish' && vwapPos === 'above' && dist < 0.4)
   || (ctx.direction === 'bearish' && vwapPos === 'below' && dist < 0.4)) {
    score += 10; confirmations.push(`VWAP supportive (${dist.toFixed(2)}%)`);
  }

  // 5m CHOCH supports
  if ((ctx.direction === 'bullish' && ctx.mtfStructure?.choch5 === 'bullish_choch')
   || (ctx.direction === 'bearish' && ctx.mtfStructure?.choch5 === 'bearish_choch')) {
    score += 12; confirmations.push(`5m ${ctx.mtfStructure.choch5}`);
  }

  // OI absorption
  if (ctx.oiAnalytics?.absorption?.detected) {
    score += 10; confirmations.push(`OI absorption ${ctx.oiAnalytics.absorption.side}`);
  }

  // Trap engine corroborates (failed breakout in trend direction)
  if ((ctx.trap?.trapScore || 0) >= 50) {
    score += 8; confirmations.push(`trap ${ctx.trap.trapScore}`);
  }

  // Need at least 2 confirmations beyond the precondition
  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 3 ? 'standard' : 'weak';

  return {
    name: 'COUNTER_TREND_REVERSAL',
    family: 'reversal',
    valid: conviction !== 'weak' && score >= 60,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 300, rrTarget: 1.6 },
    riskProfile: { slPct: 0.09, sizingFactor: 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['trending_regime', 'counter_direction', 'divergence_or_absorption'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 17: DELTA_DRIVE_SCALP (very-high-availability scalp) ───────
// Simplest possible scalp filter — fires when delta is meaningfully in
// our direction AND VWAP supports AND no trap. This is a last-resort
// "the market is moving" entry, used when regime-specific playbooks miss.
// Tight risk to keep losses small if it fires on a fakeout.
function _deltaDriveScalp(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Delta must be clearly in direction (≥10% absolute, >7 strength)
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaStr = _safe(ctx.volumeAnalysis?.delta?.strength);
  const deltaOK = (ctx.direction === 'bullish' && deltaPct > 10 && deltaStr >= 40)
              || (ctx.direction === 'bearish' && deltaPct < -10 && deltaStr >= 40);
  if (!deltaOK) required.push(`delta not strong (${deltaPct}%, str ${deltaStr})`);

  // VWAP supportive (right side, < 0.7% away)
  const vwapPos = ctx.vwap?.position;
  const dist = Math.abs(_safe(ctx.vwap?.distance_pct));
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push('VWAP wrong side');
  }
  if (dist > 0.7) required.push(`too far from VWAP (${dist.toFixed(2)}%)`);

  // OI must not actively oppose
  const oiR = ctx.oiAnalytics?.regime || '';
  const oiAgainst = (ctx.direction === 'bullish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))
                || (ctx.direction === 'bearish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'));
  if (oiAgainst) required.push(`OI ${oiR} against`);

  // Block dead vol, midday chop, expiry afternoons
  if (ctx.volatilityRegime?.state === 'dead') required.push('dead vol');
  if (ctx.sessionPhase?.phase === 'midday_chop') required.push('midday chop');
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1400) required.push('expiry afternoon');

  // Block trap
  if ((ctx.trap?.trapScore || 0) >= 50) required.push(`trap score ${ctx.trap.trapScore}`);

  // Block when same direction as auction trend in mean-revert regimes
  if (ctx.metaRegime?.state === 'gamma_pin'
      || ctx.metaRegime?.state === 'balanced_auction') {
    required.push(`mean-revert regime (${ctx.metaRegime.state}) — use specific playbook`);
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'DELTA_DRIVE_SCALP', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 30; reasons.push(`delta ${deltaPct}% str ${deltaStr}`);

  // Confirmations
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 12; confirmations.push(`OI ${oiR}`);
  }
  if (ctx.mtfStructure?.alignment === 'full' || ctx.mtfStructure?.alignment === 'partial') {
    score += 10; confirmations.push(`MTF ${ctx.mtfStructure.alignment}`);
  }
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 8; confirmations.push('futures aligned');
  }
  // VSA bullish or bearish in our direction
  if (ctx.volumeAnalysis?.vsa?.bias === ctx.direction && _safe(ctx.volumeAnalysis.vsa.strength) >= 50) {
    score += 8; confirmations.push(`VSA ${ctx.volumeAnalysis.vsa.pattern}`);
  }
  // Liquidity good
  if (ctx.liquidity?.health === 'good' || ctx.liquidity?.health === 'excellent') {
    score += 5; confirmations.push(`liq ${ctx.liquidity.health}`);
  }

  // Need at least 2 confirmations
  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'DELTA_DRIVE_SCALP',
    family: 'momentum_continuation',
    valid: conviction !== 'weak' && score >= 45,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.4 },
    riskProfile: { slPct: 0.08, sizingFactor: 0.5 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['strong_delta', 'vwap_supportive', 'oi_not_against', 'no_trap'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// PHASE 1 INSTITUTIONAL PLAYBOOKS (cycle 28+)
// Targeted at rotational / low-vol / micro-scalp regimes where the engine
// previously stayed inactive. These convert "no trade" sessions into
// 2-5 elite micro-scalps per day without breaking high-WR discipline.
// ═════════════════════════════════════════════════════════════════════════

// ─── PLAYBOOK 18: VALUE_AREA_ROTATION (rotational scalp) ──────────────────
// Trade VAL ↔ POC ↔ VAH rotations during gamma-pin / balanced auctions.
// Direction:
//   bullish — price near VAL (≤25% into range) → fade up to POC
//   bearish — price near VAH (≥75% into range) → fade down to POC
// Tight target (1× rr), tight SL — high-frequency rotational engine.
function _valueAreaRotation(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Need rotational meta-regime
  const rotational = ctx.metaRegime?.state === 'gamma_pin'
    || ctx.metaRegime?.state === 'balanced_auction'
    || ctx.metaRegime?.state === 'slow_grind';
  if (!rotational) required.push('not rotational regime');

  // Inside-VA acceptance
  if (ctx.volumeAnalysis?.acceptance !== 'inside_va') required.push('not inside_va');

  // Position in VA
  const va = ctx.volumeAnalysis?.frvp;
  let edgeOK = false;
  let posInRange = 0.5;
  if (va?.vaHigh && va?.vaLow && Number.isFinite(ctx.spotPrice)) {
    const range = va.vaHigh - va.vaLow;
    if (range > 0) {
      posInRange = (ctx.spotPrice - va.vaLow) / range;
      // CALIBRATED cycle 29: relaxed edge tolerance (was 0.30 / 0.70 — only
      // 1 valid match). Now 0.40 / 0.60 covers more rotational entries.
      if (ctx.direction === 'bullish' && posInRange <= 0.40) {
        edgeOK = true; score += 18; reasons.push(`near VAL (${(posInRange*100).toFixed(0)}%)`);
      } else if (ctx.direction === 'bearish' && posInRange >= 0.60) {
        edgeOK = true; score += 18; reasons.push(`near VAH (${(posInRange*100).toFixed(0)}%)`);
      }
    }
  }
  if (!edgeOK) required.push('not at VA edge');

  // Block on expansion volatility (rotation broken)
  if (ctx.volatilityRegime?.state === 'expansion') required.push('expansion vol — rotation broken');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'VALUE_AREA_ROTATION', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 25;

  // Confirmations
  // Weak/neutral delta is ideal for rotation
  const deltaPct = Math.abs(_safe(ctx.volumeAnalysis?.delta?.cvdPctLong));
  if (deltaPct < 12) { score += 10; confirmations.push(`weak delta ${deltaPct}%`); }
  else if (deltaPct > 25) { score -= 8; confirmations.push(`strong delta ${deltaPct}% — wrong setup`); }

  // VSA upthrust (top edge bearish) / spring (bottom edge bullish)
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa?.bias === ctx.direction) {
    score += 8; confirmations.push(`VSA ${vsa.pattern}`);
  }

  // Auction reading favours rotation
  if (ctx.auctionState?.tradingImplication === 'mean_reversion') {
    score += 8; confirmations.push('auction mean_reversion');
  }

  // Failed breaks earlier confirm rotational behaviour
  const failed = (ctx.sessionMemory?.failedBreakouts || 0)
              + (ctx.sessionMemory?.failedBreakdowns || 0);
  if (failed >= 1) { score += 6; confirmations.push(`${failed} prior failed break`); }

  // Liquidity good
  if (ctx.liquidity?.health === 'good' || ctx.liquidity?.health === 'excellent') {
    score += 4; confirmations.push(`liq ${ctx.liquidity.health}`);
  }

  // Dead/low ATR amplifies rotation — small targets
  if (ctx.volatilityRegime?.state === 'dead' || ctx.volatilityRegime?.atrPercentile < 30) {
    score += 5; confirmations.push('dead/low vol');
  }

  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'VALUE_AREA_ROTATION',
    family: 'mean_reversion',
    valid: conviction !== 'weak' && score >= 45,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 180, rrTarget: 1.0 },
    riskProfile: { slPct: 0.07, sizingFactor: 0.5 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['rotational_regime', 'inside_va', 'va_edge'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 19: PIN_REVERSION (gamma-magnet scalp) ─────────────────────
// Trade BACK to gamma pin level when price is stretched away from it.
// Conditions:
//   positive gamma + |spotVsPin| > 15-20pts → reversion to pin is HIGH WR
//   direction must be opposite the spot-vs-pin offset
function _pinReversion(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  if (ctx.gammaRegime?.regime !== 'positive') required.push('not positive gamma');

  const svp = _safe(ctx.gammaRegime?.spotVsPin);
  const stretchAway = Math.abs(svp);
  if (stretchAway < 12) required.push(`spotVsPin ${svp.toFixed(1)} too tight (need >12pts stretch)`);
  if (stretchAway > 60) required.push(`spotVsPin ${svp.toFixed(1)} too wide (pin breaking)`);

  // Direction: bullish trade when spot is BELOW pin (pull up); bearish when ABOVE
  if (ctx.direction === 'bullish' && svp >= 0) required.push('bullish but already above pin');
  if (ctx.direction === 'bearish' && svp <= 0) required.push('bearish but already below pin');

  // Block on expansion vol — pin can break
  if (ctx.volatilityRegime?.state === 'expansion') required.push('expansion vol — pin can break');

  // Block on Friday after 1300 (position-square risk)
  if (ctx.sessionPhase?.weekday === 'Fri' && ctx.sessionPhase?.hhmm >= 1300) {
    required.push('Fri afternoon');
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'PIN_REVERSION', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 30; reasons.push(`positive gamma + stretch ${stretchAway.toFixed(1)}pts`);

  // Confirmations
  // Weak delta = no momentum to fight
  const deltaPct = Math.abs(_safe(ctx.volumeAnalysis?.delta?.cvdPctLong));
  if (deltaPct < 15) { score += 10; confirmations.push(`weak delta ${deltaPct}%`); }
  else if (deltaPct > 30) { score -= 10; confirmations.push(`strong delta ${deltaPct}% — momentum continues`); }

  // VSA reversal pattern
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa?.bias === ctx.direction) {
    score += 8; confirmations.push(`VSA ${vsa.pattern}`);
  }

  // Inside-VA acceptance preferred
  if (ctx.volumeAnalysis?.acceptance === 'inside_va') {
    score += 6; confirmations.push('inside VA');
  }

  // Low volatility is ideal
  if (ctx.volatilityRegime?.state === 'dead' || ctx.volatilityRegime?.atrPercentile < 30) {
    score += 6; confirmations.push('low vol');
  }

  // Stretch zone (15-30pts is sweet spot)
  if (stretchAway >= 15 && stretchAway <= 30) {
    score += 8; confirmations.push(`prime stretch zone ${stretchAway.toFixed(0)}pts`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'PIN_REVERSION',
    family: 'mean_reversion',
    valid: conviction !== 'weak' && score >= 45,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 180, rrTarget: 1.0 },
    riskProfile: { slPct: 0.07, sizingFactor: 0.5 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['positive_gamma', 'stretch_from_pin', 'reversion_direction'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 20: SWEEP_RECLAIM_SCALP (micro stop-hunt fade) ─────────────
// Tight scalp version of FAILED_AUCTION_REVERSAL — fires on smaller sweeps
// without requiring delta divergence. Quick reclaim of swept level + delta
// turns in our direction = 5-8pt scalp.
function _sweepReclaimScalp(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Need a sweep event (smaller threshold than FAILED_AUCTION_REVERSAL)
  const sm = ctx.sessionMemory || {};
  const sweepBelow = (sm.sweepsBelowLow || 0) >= 1 || ctx.auctionState?.excessLow;
  const sweepAbove = (sm.sweepsAboveHigh || 0) >= 1 || ctx.auctionState?.excessHigh;

  // Bullish trade requires below-sweep; bearish above-sweep
  const sweepOK = (ctx.direction === 'bullish' && sweepBelow)
              || (ctx.direction === 'bearish' && sweepAbove);
  if (!sweepOK) required.push('no sweep in direction');

  // Need VWAP reclaim (price back above for bullish, below for bearish)
  const vwapPos = ctx.vwap?.position;
  const reclaim = (ctx.direction === 'bullish' && vwapPos === 'above')
              || (ctx.direction === 'bearish' && vwapPos === 'below');
  if (!reclaim) required.push(`VWAP not reclaimed (${vwapPos})`);

  // Delta turning in direction (any bias supports)
  const deltaBias = ctx.volumeAnalysis?.delta?.bias;
  const deltaSupports = (ctx.direction === 'bullish' && /bullish/i.test(deltaBias || ''))
                    || (ctx.direction === 'bearish' && /bearish/i.test(deltaBias || ''));
  if (!deltaSupports) required.push(`delta ${deltaBias} not supporting`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'SWEEP_RECLAIM_SCALP', family: 'reversal',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push('sweep + reclaim');

  // Confirmations
  // VSA spring/upthrust
  const vsa = ctx.volumeAnalysis?.vsa;
  if ((vsa?.pattern === 'spring' && ctx.direction === 'bullish')
   || (vsa?.pattern === 'upthrust' && ctx.direction === 'bearish')) {
    score += 12; confirmations.push(`VSA ${vsa.pattern}`);
  }

  // OI absorption corroborates
  if (ctx.oiAnalytics?.absorption?.detected) {
    score += 10; confirmations.push(`OI absorption ${ctx.oiAnalytics.absorption.side}`);
  }

  // Responsive flow
  if ((ctx.orderflowState?.state === 'responsive_buying' && ctx.direction === 'bullish')
   || (ctx.orderflowState?.state === 'responsive_selling' && ctx.direction === 'bearish')) {
    score += 10; confirmations.push(`responsive ${ctx.direction}`);
  }

  // 5m CHOCH supports
  if ((ctx.direction === 'bullish' && ctx.mtfStructure?.choch5 === 'bullish_choch')
   || (ctx.direction === 'bearish' && ctx.mtfStructure?.choch5 === 'bearish_choch')) {
    score += 8; confirmations.push(`5m ${ctx.mtfStructure.choch5}`);
  }

  // Trap engine corroborates
  if ((ctx.trap?.trapScore || 0) >= 40) {
    score += 6; confirmations.push(`trap ${ctx.trap.trapScore}`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 1 ? 'standard' : 'weak';

  return {
    name: 'SWEEP_RECLAIM_SCALP',
    family: 'reversal',
    valid: conviction !== 'weak' && score >= 45,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.3 },
    riskProfile: { slPct: 0.08, sizingFactor: 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['sweep', 'reclaim', 'delta_supportive'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 21: LVN_REJECTION_SCALP (rotational fade) ──────────────────
// Price approaches an LVN, fails to accept, rejects back. This is a
// clean rotation entry — high WR for short scalps.
function _lvnRejectionScalp(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const lvns = ctx.volumeAnalysis?.frvp?.lvn || [];
  const spot = ctx.spotPrice;
  let nearLvn = null;
  if (Number.isFinite(spot)) {
    nearLvn = lvns.find(l => Math.abs(l.price - spot) < 10);
  }
  if (!nearLvn) required.push('no LVN within 10pts');

  // Direction: bullish trade requires LVN ABOVE spot (rejection down → fade up)
  // Wait, that's wrong. LVN rejection = price tried to enter LVN but failed → reverses.
  //   - Bullish: spot tried to break BELOW an LVN below us → bounced back up → buy
  //   - Bearish: spot tried to break ABOVE an LVN above us → got rejected → sell
  if (nearLvn) {
    if (ctx.direction === 'bullish' && spot > nearLvn.price) {
      score += 12; reasons.push(`LVN ${nearLvn.price} below — rejected, bouncing up`);
    } else if (ctx.direction === 'bearish' && spot < nearLvn.price) {
      score += 12; reasons.push(`LVN ${nearLvn.price} above — rejected, bouncing down`);
    } else {
      required.push('wrong side of LVN for rejection');
    }
  }

  // Block on expansion (LVN won't reject)
  if (ctx.volatilityRegime?.state === 'expansion') required.push('expansion vol — LVN may break');

  // Need rotational regime
  if (ctx.metaRegime?.state !== 'gamma_pin'
      && ctx.metaRegime?.state !== 'balanced_auction'
      && ctx.metaRegime?.state !== 'slow_grind'
      && ctx.metaRegime?.state !== 'unknown') {
    required.push(`meta ${ctx.metaRegime?.state} not rotational`);
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'LVN_REJECTION_SCALP', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 25;

  // Confirmations
  // VSA reversal pattern
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa?.bias === ctx.direction) {
    score += 10; confirmations.push(`VSA ${vsa.pattern}`);
  }

  // Delta supportive
  const deltaBias = ctx.volumeAnalysis?.delta?.bias;
  const deltaSupports = (ctx.direction === 'bullish' && /bullish/i.test(deltaBias || ''))
                    || (ctx.direction === 'bearish' && /bearish/i.test(deltaBias || ''));
  if (deltaSupports) { score += 8; confirmations.push(`delta ${deltaBias}`); }

  // POC distance — there should be room to rotate back
  const poc = ctx.volumeAnalysis?.frvp?.pocPrice;
  if (Number.isFinite(poc) && Math.abs(poc - spot) > 8) {
    score += 6; confirmations.push(`POC ${poc.toFixed(0)} target`);
  }

  // Liquidity good
  if (ctx.liquidity?.health === 'good' || ctx.liquidity?.health === 'excellent') {
    score += 4; confirmations.push(`liq ${ctx.liquidity.health}`);
  }

  // Low/dead vol amplifies
  if (ctx.volatilityRegime?.state === 'dead' || ctx.volatilityRegime?.atrPercentile < 35) {
    score += 4; confirmations.push('low vol');
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'LVN_REJECTION_SCALP',
    family: 'mean_reversion',
    valid: conviction !== 'weak' && score >= 45,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 200, rrTarget: 1.1 },
    riskProfile: { slPct: 0.07, sizingFactor: 0.5 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['near_lvn', 'rotational_regime', 'rejection_side'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 22: VWAP_OSCILLATION_SCALP (mid-day rotational) ───────────
// Price oscillates around VWAP repeatedly during balanced sessions.
// Different from VWAP_BOUNCE_SCALP (which trades the right side); this
// fades extension and trades back to VWAP from EITHER side after rejection.
function _vwapOscillationScalp(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const vwap = ctx.vwap;
  const dist = Math.abs(_safe(vwap?.distance_pct));
  if (!vwap?.vwap) required.push('no VWAP');

  // Need rotational regime
  const rotational = ctx.metaRegime?.state === 'gamma_pin'
    || ctx.metaRegime?.state === 'balanced_auction'
    || ctx.metaRegime?.state === 'slow_grind'
    || ctx.metaRegime?.state === 'dealer_hedging';
  if (!rotational) required.push('not rotational regime');

  // Direction: bullish from BELOW vwap (heading up to it); bearish from ABOVE vwap
  const vwapPos = vwap?.position;
  const fadeOK = (ctx.direction === 'bullish' && vwapPos === 'below')
              || (ctx.direction === 'bearish' && vwapPos === 'above');
  if (!fadeOK) required.push(`VWAP fade direction wrong (${vwapPos})`);

  // Need extension (price reasonably away from VWAP)
  if (dist < 0.15) required.push(`too close to VWAP (${dist.toFixed(2)}%)`);
  if (dist > 0.80) required.push(`too far from VWAP (${dist.toFixed(2)}%)`);

  // Block on expansion
  if (ctx.volatilityRegime?.state === 'expansion') required.push('expansion vol');

  // Block on midday_chop only when delta strongly opposes (chop-with-trend)
  // (Otherwise this playbook is FOR midday rotation)

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'VWAP_OSCILLATION_SCALP', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 25;

  // Confirmations
  // Delta turning in direction (bias toward our side)
  const deltaBias = ctx.volumeAnalysis?.delta?.bias;
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if ((ctx.direction === 'bullish' && deltaPct > 0)
   || (ctx.direction === 'bearish' && deltaPct < 0)) {
    score += 10; confirmations.push(`delta ${deltaBias} ${deltaPct}%`);
  }

  // VSA absorption / spring / upthrust
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa?.bias === ctx.direction) {
    score += 8; confirmations.push(`VSA ${vsa.pattern}`);
  }

  // Inside-VA helps oscillation
  if (ctx.volumeAnalysis?.acceptance === 'inside_va') {
    score += 6; confirmations.push('inside VA');
  }

  // Low ATR helps
  if (ctx.volatilityRegime?.state === 'dead' || ctx.volatilityRegime?.atrPercentile < 35) {
    score += 6; confirmations.push('low vol');
  }

  // Failed previous breaks confirm rotation
  const failed = (ctx.sessionMemory?.failedBreakouts || 0)
              + (ctx.sessionMemory?.failedBreakdowns || 0);
  if (failed >= 1) { score += 4; confirmations.push(`${failed} failed breaks`); }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'VWAP_OSCILLATION_SCALP',
    family: 'mean_reversion',
    valid: conviction !== 'weak' && score >= 45,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 200, rrTarget: 1.0 },
    riskProfile: { slPct: 0.07, sizingFactor: 0.5 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['rotational_regime', 'vwap_fade_side', 'extension'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 23: OPENING_DRIVE_FAILURE (open trap reversal) ────────────
// Opening 9:15-9:45 saw a strong drive that failed (price re-entered IB
// range or prior-day value). Trade the reversal back into value.
function _openingDriveFailure(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Window: 09:30 - 10:30 (after opening drive starts to fail)
  const hhmm = ctx.sessionPhase?.hhmm || 0;
  if (hhmm < 930 || hhmm >= 1100) required.push(`not in opening-failure window (${hhmm})`);

  // Opening drive direction must be OPPOSITE our trade direction
  const drive = ctx.sessionMemory?.openingDriveDir;
  if (drive && ((ctx.direction === 'bullish' && drive !== 'down')
             || (ctx.direction === 'bearish' && drive !== 'up'))) {
    required.push(`opening drive ${drive} not opposite our direction`);
  }
  if (!drive) required.push('no opening drive recorded');

  // Need price BACK INSIDE prior day range (failure confirmation)
  const pdh = ctx.multiDayContext?.priorDay?.high;
  const pdl = ctx.multiDayContext?.priorDay?.low;
  const insidePrior = Number.isFinite(pdh) && Number.isFinite(pdl)
    && Number.isFinite(ctx.spotPrice)
    && ctx.spotPrice >= pdl && ctx.spotPrice <= pdh;
  if (!insidePrior) required.push('not back inside prior-day range');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'OPENING_DRIVE_FAILURE', family: 'reversal',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`opening drive ${drive} failed → ${ctx.direction} reversal`);

  // Confirmations
  // Delta divergence supports
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  if (div && div !== 'none' && divBias === ctx.direction) {
    score += 12; confirmations.push(`delta div ${div}`);
  }

  // Delta turn in direction
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if ((ctx.direction === 'bullish' && deltaPct > 0)
   || (ctx.direction === 'bearish' && deltaPct < 0)) {
    score += 8; confirmations.push(`delta ${deltaPct}%`);
  }

  // 5m CHOCH
  if ((ctx.direction === 'bullish' && ctx.mtfStructure?.choch5 === 'bullish_choch')
   || (ctx.direction === 'bearish' && ctx.mtfStructure?.choch5 === 'bearish_choch')) {
    score += 12; confirmations.push(`5m ${ctx.mtfStructure.choch5}`);
  }

  // VWAP reclaim corroborates
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos === 'above')
   || (ctx.direction === 'bearish' && vwapPos === 'below')) {
    score += 8; confirmations.push(`VWAP ${vwapPos}`);
  }

  // Trap engine corroborates
  if ((ctx.trap?.trapScore || 0) >= 40) {
    score += 6; confirmations.push(`trap ${ctx.trap.trapScore}`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 1 ? 'standard' : 'weak';

  return {
    name: 'OPENING_DRIVE_FAILURE',
    family: 'reversal',
    valid: conviction !== 'weak' && score >= 50,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 360, rrTarget: 1.6 },
    riskProfile: { slPct: 0.09, sizingFactor: 0.6 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['opening_window', 'drive_opposite', 'back_in_prior_range'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 24: MICRO_DELTA_FLIP (micro-scalp) ─────────────────────────
// 1m delta flips sharply in our direction after a stall. 2-5pt option
// scalp on a tight time stop. Used in slow grind / midday for participation.
function _microDeltaFlip(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Delta must be moderately in direction with the right TREND signal
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  const deltaFlipped = (ctx.direction === 'bullish' && deltaPct > 4 && deltaTrend === 'rising')
                   || (ctx.direction === 'bearish' && deltaPct < -4 && deltaTrend === 'falling');
  if (!deltaFlipped) required.push(`delta not flipped (${deltaPct}%, trend ${deltaTrend})`);

  // Need rotational / low-vol regime (this is a micro-scalp)
  const lowVolRegime = ctx.metaRegime?.state === 'gamma_pin'
    || ctx.metaRegime?.state === 'balanced_auction'
    || ctx.metaRegime?.state === 'slow_grind'
    || ctx.metaRegime?.state === 'dealer_hedging';
  if (!lowVolRegime) required.push(`not low-vol regime (${ctx.metaRegime?.state})`);

  // Block expansion vol — this is a micro-scalp not a momentum trade
  if (ctx.volatilityRegime?.state === 'expansion') required.push('expansion — use momentum playbook');

  // VWAP supportive (right side)
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side (${vwapPos})`);
  }

  // Block on midday_chop ONLY if no clear flip pattern
  // (this playbook is FOR participation in chop)

  // OI must not actively oppose
  const oiR = ctx.oiAnalytics?.regime || '';
  const oiAgainst = (ctx.direction === 'bullish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))
                || (ctx.direction === 'bearish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'));
  if (oiAgainst) required.push(`OI ${oiR} opposes`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'MICRO_DELTA_FLIP', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 30; reasons.push(`delta flip ${deltaTrend} ${deltaPct}%`);

  // Confirmations
  // OI alignment
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 10; confirmations.push(`OI ${oiR}`);
  }

  // VSA bias supports
  const vsa = ctx.volumeAnalysis?.vsa;
  if (vsa?.bias === ctx.direction && _safe(vsa.strength) >= 40) {
    score += 8; confirmations.push(`VSA ${vsa.pattern}`);
  }

  // Acceptance favourable
  const acc = ctx.volumeAnalysis?.acceptance;
  if (acc === 'inside_va'
   || (ctx.direction === 'bullish' && acc === 'above_va')
   || (ctx.direction === 'bearish' && acc === 'below_va')) {
    score += 5; confirmations.push(`acc ${acc}`);
  }

  // Low ATR helps the time-stop math
  if (ctx.volatilityRegime?.state === 'dead' || ctx.volatilityRegime?.atrPercentile < 40) {
    score += 5; confirmations.push('low vol');
  }

  // Liquidity
  if (ctx.liquidity?.health === 'good' || ctx.liquidity?.health === 'excellent') {
    score += 4; confirmations.push(`liq ${ctx.liquidity.health}`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'MICRO_DELTA_FLIP',
    family: 'momentum_continuation',
    valid: conviction !== 'weak' && score >= 45,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 150, rrTarget: 1.0 },
    riskProfile: { slPct: 0.06, sizingFactor: 0.4 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['delta_flipped', 'low_vol_regime', 'vwap_side', 'oi_not_against'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 25: OI_MIGRATION_TREND (positioning trend) ────────────────
// Multi-day OI walls migrate progressively in a direction → strong
// directional bias. Trade with the migration.
function _oiMigrationTrend(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const ceMig = ctx.multiDayContext?.oiMigration?.ce;
  const peMig = ctx.multiDayContext?.oiMigration?.pe;
  // Bullish: PE peaks migrating UP (PE writers pulling stops higher) OR
  //           CE peaks migrating UP (CE walls moving away)
  // Bearish: opposite
  const bullishMig = (ceMig === 'up' || peMig === 'up');
  const bearishMig = (ceMig === 'down' || peMig === 'down');
  const dirMig = (ctx.direction === 'bullish' && bullishMig)
              || (ctx.direction === 'bearish' && bearishMig);
  if (!dirMig) required.push(`OI migration ce=${ceMig} pe=${peMig} not aligned`);

  // Need at least 3 prior days of migration data
  const sessions = ctx.multiDayContext?.oiMigration?.sessionsTracked || 0;
  if (sessions < 3) required.push(`only ${sessions} sessions tracked, need 3+`);

  // Direction must align with current regime/VWAP
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side (${vwapPos})`);
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'OI_MIGRATION_TREND', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 30; reasons.push(`OI migration ${ctx.direction} aligned (${sessions} sessions)`);

  // Confirmations
  // Delta in direction
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if ((ctx.direction === 'bullish' && deltaPct > 5)
   || (ctx.direction === 'bearish' && deltaPct < -5)) {
    score += 10; confirmations.push(`delta ${deltaPct}%`);
  }

  // OI regime alignment
  const oiR = ctx.oiAnalytics?.regime || '';
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 12; confirmations.push(`OI regime ${oiR}`);
  }

  // MTF supportive
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 10; confirmations.push('MTF full');
  } else if (ctx.mtfStructure?.alignment === 'partial') {
    score += 5; confirmations.push('MTF partial');
  }

  // Futures aligned
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('futures aligned');
  }

  // Active volatility helps
  if (ctx.volatilityRegime?.state === 'expansion' || ctx.volatilityRegime?.state === 'normal') {
    score += 4; confirmations.push(`vol ${ctx.volatilityRegime.state}`);
  }

  // CALIBRATED cycle 29: OI_MIGRATION_TREND fired 212× as playbook winner
  // but only 62% WR. Require ELITE conviction only (3+ confirmations) to
  // prevent it from outranking better-WR playbooks like VWAP_BOUNCE_SCALP.
  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 3 ? 'standard' : 'weak';

  return {
    name: 'OI_MIGRATION_TREND',
    family: 'momentum_continuation',
    valid: conviction === 'elite' && score >= 60,
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 600, rrTarget: 2.5 },
    riskProfile: { slPct: 0.12, sizingFactor: 0.7 },
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['oi_migration_aligned', 'multi_day_data', 'vwap_supportive'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 26: LIGHT_TREND_DRIFT_SCALP (institutional fallback) ─────
// CALIBRATED 2026-05-18 cycle 31 (zero-trade-day rescue):
// 8 days produced 0 trades because every elite playbook missed its strict
// preconditions in dealer_hedging / trend_auction / short_covering /
// long_liquidation regimes (typically dead-vol drift days where OI builds
// quietly but no expansion fires).
//
// This playbook fires as a CONSERVATIVE fallback when:
//   - Direction has been resolved (passes pre-checks upstream)
//   - VWAP aligned with direction
//   - OI is NOT actively against the trade
//   - At least 2 of: tf5 aligned, tf15 aligned, futures aligned,
//                    delta in direction (≥3%), derivatives bias matching,
//                    MTF partial+, OI aligned, breadth aligned
//
// Conservative trade management: SCALP, 200s hold, 1.2 RR target, 0.5 sizing.
// Designed for graceful failure — small losses, modest wins.
function _lightTrendDriftScalp(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  // Pre-conditions
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side (${vwapPos})`);
  }

  // OI must NOT actively oppose
  const oiR = ctx.oiAnalytics?.regime || '';
  const oiAgainst = (ctx.direction === 'bullish'
                    && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))
                || (ctx.direction === 'bearish'
                    && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'));
  if (oiAgainst) required.push(`OI ${oiR} against direction`);

  // Block when trapScore is high (handled upstream) but we add a soft check
  if ((ctx.trap?.trapScore || 0) >= 65) required.push(`trap ${ctx.trap.trapScore}`);

  // Block expiry afternoons (theta brutal)
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1400) {
    required.push('expiry afternoon');
  }

  // Block midday_chop session (low edge at lunch)
  if (ctx.sessionPhase?.phase === 'midday_chop') {
    required.push('midday_chop session');
  }

  // CALIBRATED 2026-05-18 cycle 35: institutional anchors gate.
  // Cycles 31-32 with 1 anchor → 36% WR / -₹28k.
  // Cycle 33 with 3 anchors → 62% WR / +₹0.8k (only 8 trades, low rescue).
  // Cycle 34 with 2 anchors → 36% WR / -₹28k.
  // Settling on 3 anchors: high-quality rescue when conditions truly align.
  const derivBias = ctx.derivatives?.overallBias === ctx.direction
                  && (ctx.derivatives?.directionScore || 0) >= 60;
  const tf5OK = ctx.mtfStructure?.tf5 === ctx.direction;
  const tf15OK = ctx.mtfStructure?.tf15 === ctx.direction;
  const oiAligned = (ctx.direction === 'bullish'
                    && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
                || (ctx.direction === 'bearish'
                    && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'));
  const futOK = ctx.futuresData?.direction === ctx.direction;
  const anchorCount = (derivBias ? 1 : 0) + (tf5OK ? 1 : 0) + (tf15OK ? 1 : 0)
                    + (oiAligned ? 1 : 0) + (futOK ? 1 : 0);
  if (anchorCount < 3) {
    required.push(`only ${anchorCount}/5 institutional anchors (need ≥3)`);
  }

  // Don't trade when delta strongly opposes direction (clear conviction wrong)
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaStronglyAgainst = (ctx.direction === 'bullish' && deltaPct < -5)
                            || (ctx.direction === 'bearish' && deltaPct > 5);
  if (deltaStronglyAgainst) required.push(`delta ${deltaPct}% strongly against`);

  // Don't trade when an "absorption against" pattern is detected
  if (ctx.volumeAnalysis?.delta?.divergence
      && ctx.volumeAnalysis.delta.divergenceBias
      && ctx.volumeAnalysis.delta.divergenceBias !== 'neutral'
      && ctx.volumeAnalysis.delta.divergenceBias !== ctx.direction) {
    required.push('absorption against direction');
  }

  // Block when in heavy POC chop (within 5pts) and dead vol — pure stall
  const poc = _safe(ctx.volumeAnalysis?.frvp?.pocPrice);
  const pocDist = (poc && Number.isFinite(ctx.spotPrice))
                ? Math.abs(ctx.spotPrice - poc) : Infinity;
  if (pocDist < 5 && ctx.volatilityRegime?.state === 'dead') {
    required.push(`stuck at POC ${pocDist.toFixed(1)}pts + dead vol`);
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'LIGHT_TREND_DRIFT_SCALP', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 28; reasons.push(`VWAP ${vwapPos} + OI not against`);

  // Confirmations (need ≥2 to be 'standard', ≥3 for 'elite')
  // 1. tf5 aligned
  const tf5 = ctx.mtfStructure?.tf5;
  if (tf5 === ctx.direction) { score += 10; confirmations.push(`tf5 ${tf5}`); }
  // 2. tf15 aligned
  const tf15 = ctx.mtfStructure?.tf15;
  if (tf15 === ctx.direction) { score += 10; confirmations.push(`tf15 ${tf15}`); }
  // 3. Delta in direction (≥3% absolute)
  if ((ctx.direction === 'bullish' && deltaPct >= 3)
   || (ctx.direction === 'bearish' && deltaPct <= -3)) {
    score += 8; confirmations.push(`delta ${deltaPct}%`);
  }
  // 4. Futures aligned
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('futures aligned');
  }
  // 5. OI in direction
  if (oiAligned) {
    score += 10; confirmations.push(`OI ${oiR}`);
  }
  // 6. Derivatives bias matches
  if (ctx.derivatives?.overallBias === ctx.direction) {
    score += 8; confirmations.push(`deriv ${ctx.derivatives.overallBias}`);
  }
  // 7. MTF aligned (partial OK)
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 8; confirmations.push('MTF full');
  } else if (ctx.mtfStructure?.alignment === 'partial') {
    score += 4; confirmations.push('MTF partial');
  }
  // 8. Breadth aligned (if present)
  const internals = ctx.marketInternals;
  if (internals) {
    const adv = _safe(internals.advances ?? internals.advance_decline_ratio);
    const dec = _safe(internals.declines) || 1;
    const ratio = adv / Math.max(1, dec);
    if (ctx.direction === 'bullish' && ratio > 1.2) {
      score += 4; confirmations.push(`breadth ${ratio.toFixed(2)}`);
    }
    if (ctx.direction === 'bearish' && ratio < 0.85) {
      score += 4; confirmations.push(`breadth ${ratio.toFixed(2)}`);
    }
  }
  // 9. VWAP close (drift trades from anchor work better)
  const dist = Math.abs(_safe(ctx.vwap?.distance_pct));
  if (dist < 0.5) { score += 4; confirmations.push(`near VWAP ${dist.toFixed(2)}%`); }
  // 10. Liquidity good
  if (ctx.liquidity?.health === 'good' || ctx.liquidity?.health === 'excellent') {
    score += 3; confirmations.push(`liq ${ctx.liquidity.health}`);
  }

  // Need at least 5 confirmations for 'standard'. Combined with 3+
  // institutional anchors precondition this restricts the fallback to
  // genuinely high-confluence setups (62% WR observed in cycle 33 testing).
  const conviction = confirmations.length >= 7 ? 'elite' :
                     confirmations.length >= 5 ? 'standard' : 'weak';

  return {
    name: 'LIGHT_TREND_DRIFT_SCALP',
    family: 'momentum_continuation',
    valid: conviction !== 'weak' && score >= 65,
    score: _clamp(score),
    conviction,
    // Conservative hold profile: short scalp with modest target
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 200, rrTarget: 1.2 },
    // Tight risk: 8% premium SL, half size for safety net trades
    riskProfile: { slPct: 0.08, sizingFactor: 0.5 },
    // Lower the strategy minScore for this fallback. Without this override the
    // playbook fires but the confidence gate (set by strategy.minScore=78-80)
    // still blocks. 72 keeps quality while allowing institutional drift trades.
    minScoreOverride: 72,
    // CRITICAL: institutional fallback — only fires if NO other playbook is
    // eligible. Prevents this safety-net playbook from cannibalising the
    // higher-edge elite setups.
    isFallback: true,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['vwap_aligned', 'oi_not_against', 'no_strong_counter_delta'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 27: UT_BOT_FAST_SCALP ───────────────────────────────────
// 10-15pt momentum capture using the UT Bot ATR trailing stop as the
// execution trigger (per user spec 2026-05-18). The institutional spec is:
//
//   1. UT Bot 5m trend MUST match direction          (primary momentum filter)
//   2. UT Bot 15m trend MUST match direction         (HARD — per UT guide
//                                                     "5m + 15m balanced
//                                                     intraday best" combo)
//   3. UT Bot 1m trend matches OR price above the 5m trailing stop in dir
//   4. Trending market regime OR expansion vol       (UT Bot's natural
//                                                     habitat — fails in
//                                                     sideways markets per
//                                                     user's UT guide)
//   5. VWAP aligned with direction                   (institutional bias)
//   6. Volume not in dry-up                          (avoid stalled tape)
//   7. Delta in direction (≥5% absolute)             (real participation)
//   8. NOT in midday_chop, NOT dead-vol              (whipsaw guard per UT
//                                                     guide — UT Bot fails
//                                                     in sideways markets)
//
// Hold profile: SCALP, 180s max hold, RR 1.0 → optimised for the 10-15pt
// move the user described in the screenshot. Sizing 0.7x — UT Bot is
// reactive (catches moves AFTER they start), so trades are slightly less
// edge than the elite preconditioned playbooks.
//
// CALIBRATED 2026-05-18 cycle 2: Cycle 1 produced 41 trades at 48.8% WR —
// UT Bot was cannibalising the 77% WR VWAP_BOUNCE_SCALP. Tightened to:
//   - 15m UT trend match REQUIRED (was confirmation only)
//   - Trending regime OR expansion vol REQUIRED (was confirmation only)
//   - Delta ≥5% REQUIRED (was 3%)
//   - Elite-only firing (was standard+)
function _utBotFastScalp(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const ut = ctx.utBot;
  if (!ut) required.push('no UT Bot data');

  // Primary: 5m trend must match
  const tf5 = ut?.perTimeframe?.['5m']?.trend;
  if (tf5 !== ctx.direction) required.push(`UT Bot 5m=${tf5 || 'na'} not ${ctx.direction}`);

  // HARD: 15m trend must match (per user's UT guide — "5m + 15m balanced
  // intraday best" combo). This is the single biggest reliability filter.
  const tf15 = ut?.perTimeframe?.['15m']?.trend;
  if (tf15 !== ctx.direction) required.push(`UT Bot 15m=${tf15 || 'na'} not ${ctx.direction} (HARD)`);

  // Secondary trigger: 1m trend matches OR price holds above/below 5m stop
  const tf1 = ut?.perTimeframe?.['1m']?.trend;
  const ts5 = Number(ut?.perTimeframe?.['5m']?.trailingStop);
  const spot = Number(ctx.spotPrice);
  let triggerOK = tf1 === ctx.direction;
  if (!triggerOK && Number.isFinite(ts5) && Number.isFinite(spot)) {
    triggerOK = (ctx.direction === 'bullish' && spot > ts5)
             || (ctx.direction === 'bearish' && spot < ts5);
  }
  if (!triggerOK) required.push(`UT Bot 1m=${tf1 || 'na'} and price not past 5m stop`);

  // HARD: Must be in UT Bot's natural habitat — trending market OR
  // expansion volatility. UT Bot fails in chop/balanced/pin (per user's
  // guide).
  const regime = ctx.marketRegime?.regime;
  const isTrending = regime === 'trending_bullish' || regime === 'trending_bearish';
  const isExpansion = ctx.volatilityRegime?.state === 'expansion';
  if (!isTrending && !isExpansion) {
    required.push(`regime=${regime} vol=${ctx.volatilityRegime?.state} (need trending OR expansion)`);
  }

  // VWAP must align
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side (${vwapPos})`);
  }

  // Volume must NOT be dry-up (UT Bot needs participation)
  if (ctx.volumeAnalysis?.timeVolume?.state === 'dry_up') {
    required.push('volume dry-up (UT Bot fails on dead tape)');
  }

  // Delta supportive — tightened to ≥5% (was 3%)
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaOK = (ctx.direction === 'bullish' && deltaPct >= 5)
              || (ctx.direction === 'bearish' && deltaPct <= -5);
  if (!deltaOK) required.push(`delta ${deltaPct}% not supportive (need ≥5% in dir)`);

  // Hard exclusion: midday_chop (your guide explicitly warned UT Bot whipsaws)
  if (ctx.sessionPhase?.phase === 'midday_chop') required.push('midday_chop');

  // Hard exclusion: dead volatility (no real moves to ride)
  if (ctx.volatilityRegime?.state === 'dead') required.push('dead volatility');

  // Hard exclusion: trap score high
  if ((ctx.trap?.trapScore || 0) >= 65) required.push(`trap ${ctx.trap.trapScore}`);

  // Hard exclusion: expiry afternoon theta
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1430) {
    required.push('expiry afternoon');
  }

  // CALIBRATED 2026-05-18 cycle 3: 20/29 trades exited on TIMEOUT with tiny
  // losses → UT Bot was firing at exhaustion points. Filter by requiring
  // the LATEST 5m candle to actually be closing in direction with body
  // dominance (real momentum on the entry candle, not reactive whip).
  const c5m = ctx.candles5m || [];
  const lastC = c5m[c5m.length - 1];
  if (lastC) {
    const body = Math.abs(lastC.c - lastC.o);
    const range = lastC.h - lastC.l;
    const bodyPct = range > 0 ? body / range : 0;
    const closingInDir = (ctx.direction === 'bullish' && lastC.c > lastC.o)
                      || (ctx.direction === 'bearish' && lastC.c < lastC.o);
    if (!closingInDir) {
      required.push(`last 5m candle not closing ${ctx.direction}`);
    } else if (bodyPct < 0.45) {
      required.push(`last 5m body weak (${(bodyPct*100).toFixed(0)}% of range)`);
    }
  } else {
    required.push('no 5m candle data');
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'UT_BOT_FAST_SCALP', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35;
  reasons.push(`UT Bot 5m+15m=${ctx.direction} + VWAP ${vwapPos} + delta ${deltaPct}%`);

  // ── Confirmations ──
  // 1. UT Bot 30m aligned (rare but A-tier conviction)
  const tf30 = ut?.perTimeframe?.['30m']?.trend;
  if (tf30 === ctx.direction) {
    score += 10; confirmations.push(`UT Bot 30m ${tf30}`);
  }
  // 2. UT Bot 1m aligned (entry timing precise, beyond just stop break)
  if (tf1 === ctx.direction) {
    score += 6; confirmations.push(`UT Bot 1m ${tf1}`);
  }
  // 3. Strong delta (≥10% absolute)
  if (Math.abs(deltaPct) >= 10) {
    score += 8; confirmations.push(`strong delta ${deltaPct}%`);
  }
  // 4. Delta rising/falling in direction (acceleration)
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  if ((ctx.direction === 'bullish' && deltaTrend === 'rising')
   || (ctx.direction === 'bearish' && deltaTrend === 'falling')) {
    score += 6; confirmations.push(`delta ${deltaTrend}`);
  }
  // 5. Futures aligned (institutional confirmation)
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('futures aligned');
  }
  // 6. OI in direction
  const oiR = ctx.oiAnalytics?.regime || '';
  const oiAligned = (ctx.direction === 'bullish'
                    && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
                || (ctx.direction === 'bearish'
                    && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'));
  if (oiAligned) {
    score += 8; confirmations.push(`OI ${oiR}`);
  }
  // 7. MTF structure aligned
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 8; confirmations.push('MTF full');
  } else if (ctx.mtfStructure?.alignment === 'partial') {
    score += 4; confirmations.push('MTF partial');
  }
  // 8. Volume spike on the candle (real momentum)
  const tvState = ctx.volumeAnalysis?.timeVolume?.state;
  if (tvState === 'spike' || tvState === 'climax') {
    score += 6; confirmations.push(`volume ${tvState}`);
  }
  // 9. Both trending + expansion (best UT Bot habitat)
  if (isTrending && isExpansion) {
    score += 8; confirmations.push('trending+expansion (UT prime habitat)');
  }
  // 10. Orderflow initiative
  if (ctx.orderflowState?.state === 'initiative_buying' && ctx.direction === 'bullish') {
    score += 6; confirmations.push('initiative buying');
  }
  if (ctx.orderflowState?.state === 'initiative_selling' && ctx.direction === 'bearish') {
    score += 6; confirmations.push('initiative selling');
  }
  // 11. Above/below VA acceptance (range expansion confirmation)
  const acc = ctx.volumeAnalysis?.acceptance;
  if ((ctx.direction === 'bullish' && acc === 'above_va')
   || (ctx.direction === 'bearish' && acc === 'below_va')) {
    score += 5; confirmations.push(`accepted ${acc}`);
  }

  // Need ≥4 confirmations for elite. Combined with the much stricter
  // preconditions (5m+15m UT BOTH aligned + trending/expansion + delta ≥5%
  // + VWAP + volume + no chop/dead) this is a genuinely high-quality setup.
  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'UT_BOT_FAST_SCALP',
    family: 'momentum_continuation',
    // ELITE-ONLY: only fires with 4+ confirmations AND all hard preconditions.
    valid: conviction === 'elite',
    score: _clamp(score),
    conviction,
    // Hold profile: 180s scalp with 1.0 RR — optimised for the 10-15pt
    // momentum move the user described. UT Bot reverses on momentum loss
    // so the monitor's UT-flip-exit will close the trade naturally.
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 180, rrTarget: 1.0 },
    // Tight risk: 9% premium SL, 0.7x sizing (slightly conservative because
    // UT Bot is reactive — catches moves AFTER they start, less edge than
    // structurally-confirmed playbooks).
    riskProfile: { slPct: 0.09, sizingFactor: conviction === 'elite' ? 0.85 : 0.6 },
    // Use a moderate strategy threshold — score of 65 is enough since the
    // playbook itself has strict preconditions.
    minScoreOverride: 65,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['ut_bot_5m_aligned', 'ut_bot_15m_aligned', 'trending_or_expansion', 'vwap_aligned', 'volume_not_dry', 'delta_supportive_5pct', 'no_chop_no_dead_vol'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── REGIME → PLAYBOOK ELIGIBILITY MAP (institutional spec) ────────────────
// This is the orchestrator's "permission map". Even if a playbook scores
// high, it must match the current meta-regime to be eligible.
//
// CALIBRATED 2026-05-18 cycle 28-30: Phase 1 institutional rotational
// playbooks added. OI_MIGRATION_TREND removed from REGIME maps because
// it underperformed (55.6% WR) and outranked higher-WR playbooks. It can
// be re-added once we have richer multi-day OI data.
// CALIBRATED 2026-05-18 cycle 31: Phase 2 — added LIGHT_TREND_DRIFT_SCALP
// to trend_auction / dealer_hedging / short_covering / long_liquidation /
// expiry_expansion as the institutional fallback. Resolves the 8 zero-trade
// days observed in the 59-day backtest where every elite playbook missed
// its strict preconditions (typically dead-vol drift). Conservative
// management (200s/1.2RR/0.5 sizing) keeps the win-rate impact minimal.
const REGIME_PLAYBOOKS = {
  trend_auction:    ['INITIATIVE_MOMENTUM_EXPANSION', 'PULLBACK_CONTINUATION', 'OPENING_DRIVE_CONTINUATION', 'OPENING_DRIVE_FAILURE', 'VWAP_RECLAIM_CLEAN', 'VOLATILITY_COMPRESSION_SQUEEZE', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'COUNTER_TREND_REVERSAL', 'DELTA_DRIVE_SCALP', 'UT_BOT_FAST_SCALP', 'LIGHT_TREND_DRIFT_SCALP'],
  short_covering:   ['SHORT_COVERING_SQUEEZE', 'INITIATIVE_MOMENTUM_EXPANSION', 'VWAP_RECLAIM_CLEAN', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'COUNTER_TREND_REVERSAL', 'DELTA_DRIVE_SCALP', 'SWEEP_RECLAIM_SCALP', 'UT_BOT_FAST_SCALP', 'LIGHT_TREND_DRIFT_SCALP'],
  long_liquidation: ['LONG_LIQUIDATION_CASCADE', 'INITIATIVE_MOMENTUM_EXPANSION', 'VWAP_RECLAIM_CLEAN', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'COUNTER_TREND_REVERSAL', 'DELTA_DRIVE_SCALP', 'SWEEP_RECLAIM_SCALP', 'UT_BOT_FAST_SCALP', 'LIGHT_TREND_DRIFT_SCALP'],
  gamma_pin:        ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'FAILED_AUCTION_REVERSAL', 'EXHAUSTION_REVERSAL', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP', 'VALUE_AREA_ROTATION', 'PIN_REVERSION', 'LVN_REJECTION_SCALP', 'VWAP_OSCILLATION_SCALP', 'MICRO_DELTA_FLIP', 'SWEEP_RECLAIM_SCALP'],
  balanced_auction: ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'FAILED_AUCTION_REVERSAL', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP', 'VALUE_AREA_ROTATION', 'PIN_REVERSION', 'LVN_REJECTION_SCALP', 'VWAP_OSCILLATION_SCALP', 'MICRO_DELTA_FLIP', 'SWEEP_RECLAIM_SCALP', 'OPENING_DRIVE_FAILURE'],
  slow_grind:       ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'PULLBACK_CONTINUATION', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP', 'VALUE_AREA_ROTATION', 'PIN_REVERSION', 'LVN_REJECTION_SCALP', 'VWAP_OSCILLATION_SCALP', 'MICRO_DELTA_FLIP', 'LIGHT_TREND_DRIFT_SCALP'],
  dealer_hedging:   ['INITIATIVE_MOMENTUM_EXPANSION', 'PULLBACK_CONTINUATION', 'VWAP_RECLAIM_CLEAN', 'VOLATILITY_COMPRESSION_SQUEEZE', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'COUNTER_TREND_REVERSAL', 'DELTA_DRIVE_SCALP', 'VWAP_OSCILLATION_SCALP', 'MICRO_DELTA_FLIP', 'UT_BOT_FAST_SCALP', 'LIGHT_TREND_DRIFT_SCALP'],
  expiry_expansion: ['WEEKLY_EXPIRY_DEALER_UNWIND', 'INITIATIVE_MOMENTUM_EXPANSION', 'FAILED_AUCTION_REVERSAL', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'DELTA_DRIVE_SCALP', 'PIN_REVERSION', 'SWEEP_RECLAIM_SCALP', 'UT_BOT_FAST_SCALP', 'LIGHT_TREND_DRIFT_SCALP'],
  panic:            ['EXHAUSTION_REVERSAL', 'FAILED_AUCTION_REVERSAL', 'SWEEP_RECLAIM_SCALP'],
  unknown:          ['GAMMA_PIN_MEAN_REVERSION', 'VWAP_RECLAIM_CLEAN', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'VWAP_BOUNCE_SCALP', 'DELTA_DRIVE_SCALP', 'VALUE_AREA_ROTATION', 'VWAP_OSCILLATION_SCALP', 'LVN_REJECTION_SCALP', 'UT_BOT_FAST_SCALP', 'LIGHT_TREND_DRIFT_SCALP'],
};

const ALL_PLAYBOOKS = [
  _initiativeMomentumExpansion,
  _failedAuctionReversal,
  _gammaPinMeanReversion,
  _openingDriveContinuation,
  _positioningForcedMove,
  _vwapReclaimClean,
  _hvnRejectionRotation,
  _exhaustionReversal,
  _pullbackContinuation,
  _weeklyExpiryDealerUnwind,
  _compositeProfileEdgeRejection,
  _volatilityCompressionSqueeze,
  _ivCrushFade,
  _vwapBounceScalp,
  _trendVwapFollow,
  _counterTrendReversal,
  _deltaDriveScalp,
  // Phase 1 institutional rotational playbooks (cycle 28)
  _valueAreaRotation,
  _pinReversion,
  _sweepReclaimScalp,
  _lvnRejectionScalp,
  _vwapOscillationScalp,
  _openingDriveFailure,
  _microDeltaFlip,
  _oiMigrationTrend,
  // Phase 2 institutional fallback (cycle 31) — closes the 8 zero-trade days
  _lightTrendDriftScalp,
  // Phase 3 user-spec UT Bot fast scalp (2026-05-18) — 10-15pt momentum
  // capture using ATR-trailing stop as execution trigger.
  _utBotFastScalp,
];

/**
 * Run all playbooks and pick the best ELIGIBLE one for the active meta-regime.
 *
 * @param {Object} ctx - the full hybrid context
 * @returns { bestPlaybook, allPlaybooks, eligibleNames, regimeAllowed }
 */
function evaluate(ctx = {}) {
  const evals = ALL_PLAYBOOKS.map(fn => {
    try { return fn(ctx); }
    catch (e) {
      return { name: fn.name, valid: false, score: 0, error: e.message,
               reasoning: `evaluator error: ${e.message}` };
    }
  });

  // Filter by regime eligibility (institutional spec — only playbooks that
  // belong to the current auction event are considered).
  const allowed = REGIME_PLAYBOOKS[ctx.metaRegime?.state] || REGIME_PLAYBOOKS.unknown;

  // Filter further by trade direction
  const eligible = evals.filter(e =>
    e.valid && allowed.includes(e.name) && (
      !e.allowedDirections
      || e.allowedDirections.includes(ctx.direction)
      || e.allowedDirections.includes('both')
    )
  );

  // CALIBRATED 2026-05-18 cycle 31: Fallback playbooks (institutional safety
  // net) only fire when no non-fallback playbook qualifies. This protects
  // the 80%+ WR of elite playbooks from being cannibalised by the more
  // permissive LIGHT_TREND_DRIFT_SCALP and similar safety-net entries.
  const nonFallback = eligible.filter(e => !e.isFallback);
  const final = nonFallback.length > 0 ? nonFallback : eligible;

  final.sort((a, b) => {
    // Prefer elite > standard
    const rank = { elite: 3, standard: 2, weak: 1 };
    if (rank[b.conviction] !== rank[a.conviction]) {
      return (rank[b.conviction] || 0) - (rank[a.conviction] || 0);
    }
    return (b.score || 0) - (a.score || 0);
  });

  const best = final[0] || null;

  return {
    bestPlaybook: best,
    bestName: best?.name || null,
    bestFamily: best?.family || null,
    bestConviction: best?.conviction || null,
    bestScore: best?.score || 0,
    bestProfile: best?.holdProfile || null,
    bestRisk: best?.riskProfile || null,
    bestReasoning: best?.reasoning || 'no eligible playbook',
    allPlaybooks: evals.map(e => ({
      name: e.name, valid: e.valid, score: e.score,
      conviction: e.conviction, missing: e.missing,
    })),
    eligibleNames: allowed,
    regimeAllowed: ctx.metaRegime?.state,
  };
}

module.exports = { evaluate, REGIME_PLAYBOOKS, ALL_PLAYBOOKS };
