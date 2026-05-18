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
    // CALIBRATED 2026-05-18 (institutional spec): hold profile shortened
    // from 200s → 120s. Pin moves resolve in 60-90s typically; longer
    // holds give back wins to mean-revert noise. RR target adjusted to
    // 0.9 for matching faster exit profile.
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 120, rrTarget: 0.9 },
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

// ─── PLAYBOOK 28: RANGE_BREAK_RETEST ──────────────────────────────────
// 2026-05-18 cycle 36 (zero/low-day rescue Phase 1):
// 11 of the 42 low-trade days exhibit "mixed-chop trend" — net direction
// is clearly trending (e.g. -0.81% close-to-close) but candle bodies flip
// jaggedly. Existing playbooks reject because:
//   - VWAP_BOUNCE_SCALP wants a clean reclaim event
//   - UT_BOT_FAST_SCALP needs a strong-body 5m candle (jagged days fail)
//   - INITIATIVE_MOMENTUM wants negative gamma + expansion + initiative orderflow
//
// Pattern this playbook captures: range break → retest → continuation.
// Detection:
//   1. Spot has broken above prior 30m high (bullish) or below prior 30m
//      low (bearish) by ≥0.15% in the last 60 minutes
//   2. Last 5m candle wicked back into the prior range and closed back
//      out (rejection / acceptance pattern)
//   3. VWAP aligned with the break direction
//   4. Delta supportive (≥4% absolute in direction)
//   5. NOT in midday_chop, NOT dead-vol
//
// Hold profile: SCALP, 240s, RR 1.2 — slightly longer hold than UT Bot
// because retests need time to play out. Sizing 0.7x conservative.
function _rangeBreakRetest(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const c5 = ctx.candles5m || [];
  const c15 = ctx.candles15m || [];
  if (c5.length < 12) required.push('insufficient 5m candles');
  if (c15.length < 4) required.push('insufficient 15m candles');

  const spot = Number(ctx.spotPrice);
  if (!Number.isFinite(spot)) required.push('no spot price');

  // Build the "prior 30m range" window: bars before the last 12 (60min)
  // were the consolidation range we want to see broken.
  // CALIBRATED cycle 2: Use bars 6-18 (30-90min ago).
  // CALIBRATED cycle 3: 30 trades at 40% WR — false breakouts. Require:
  //   (a) bigger lookback (24-bar prior range = 2hrs of consolidation)
  //   (b) stronger break magnitude (0.10% — ~25pts on NIFTY)
  //   (c) retest must HOLD for ≥2 bars after rejection
  //   (d) last 2 bars must close in direction
  let priorHigh = null, priorLow = null;
  if (c5.length >= 30) {
    const priorBars = c5.slice(-30, -6); // bars 6-30 ago = 2hr range
    priorHigh = Math.max(...priorBars.map(b => b.h));
    priorLow  = Math.min(...priorBars.map(b => b.l));
  }
  if (priorHigh === null) required.push('cannot establish prior 2hr range');

  // Break magnitude: 0.10% — clear of noise but not unreachable
  const minBreakPct = 0.0010;
  const breakUp = priorHigh && spot > priorHigh * (1 + minBreakPct);
  const breakDn = priorLow && spot < priorLow * (1 - minBreakPct);
  if (ctx.direction === 'bullish' && !breakUp) {
    required.push(`no upper break (spot=${spot} priorHigh=${priorHigh})`);
  }
  if (ctx.direction === 'bearish' && !breakDn) {
    required.push(`no lower break (spot=${spot} priorLow=${priorLow})`);
  }

  // Retest pattern (last 6 bars):
  //   bullish: at least one bar dipped within 5pts of priorHigh and closed above it,
  //            AND ALL bars after that dip closed above priorHigh (retest held)
  //   bearish: mirror
  let retestHeld = false;
  const recent = c5.slice(-6);
  for (let i = 0; i < recent.length - 1; i++) {
    const b = recent[i];
    if (ctx.direction === 'bullish' && priorHigh
        && b.l <= priorHigh + 5 && b.c > priorHigh) {
      // Check that all subsequent bars also closed above priorHigh
      const followBars = recent.slice(i + 1);
      if (followBars.length >= 2 && followBars.every(f => f.c > priorHigh)) {
        retestHeld = true; break;
      }
    }
    if (ctx.direction === 'bearish' && priorLow
        && b.h >= priorLow - 5 && b.c < priorLow) {
      const followBars = recent.slice(i + 1);
      if (followBars.length >= 2 && followBars.every(f => f.c < priorLow)) {
        retestHeld = true; break;
      }
    }
  }
  if (!retestHeld) required.push('no held retest of prior range edge');

  // Last 2 bars must close in direction (real continuation, not whip)
  const last2 = c5.slice(-2);
  if (last2.length === 2) {
    const closesInDir = (ctx.direction === 'bullish' && last2.every(b => b.c > b.o))
                     || (ctx.direction === 'bearish' && last2.every(b => b.c < b.o));
    if (!closesInDir) required.push(`last 2 bars not closing ${ctx.direction}`);
  }

  // VWAP must align with direction
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side (${vwapPos})`);
  }

  // Delta supportive (≥4% absolute)
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaOK = (ctx.direction === 'bullish' && deltaPct >= 4)
              || (ctx.direction === 'bearish' && deltaPct <= -4);
  if (!deltaOK) required.push(`delta ${deltaPct}% not supportive (need ≥4% in dir)`);

  // Hard exclusions
  if (ctx.sessionPhase?.phase === 'midday_chop') required.push('midday_chop');
  if (ctx.volatilityRegime?.state === 'dead') required.push('dead volatility');
  if ((ctx.trap?.trapScore || 0) >= 70) required.push(`trap ${ctx.trap.trapScore}`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'RANGE_BREAK_RETEST', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35;
  reasons.push(`break+retest of ${ctx.direction === 'bullish' ? priorHigh : priorLow} + VWAP ${vwapPos} + delta ${deltaPct}%`);

  // ── Confirmations ──
  // 1. Net move on the day already aligned (>0.5%)
  const c0 = c5[0]?.o;
  const cN = c5[c5.length - 1]?.c;
  if (c0 && cN) {
    const netPct = ((cN - c0) / c0) * 100;
    if (ctx.direction === 'bullish' && netPct > 0.5) {
      score += 8; confirmations.push(`day net +${netPct.toFixed(2)}%`);
    } else if (ctx.direction === 'bearish' && netPct < -0.5) {
      score += 8; confirmations.push(`day net ${netPct.toFixed(2)}%`);
    }
  }
  // 2. 15m last candle in direction
  const last15 = c15[c15.length - 1];
  if (last15) {
    if (ctx.direction === 'bullish' && last15.c > last15.o) {
      score += 8; confirmations.push('15m candle bullish');
    }
    if (ctx.direction === 'bearish' && last15.c < last15.o) {
      score += 8; confirmations.push('15m candle bearish');
    }
  }
  // 3. Strong delta (≥10%)
  if (Math.abs(deltaPct) >= 10) {
    score += 8; confirmations.push(`strong delta ${deltaPct}%`);
  }
  // 4. Futures aligned
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('futures aligned');
  }
  // 5. OI in direction
  const oiR = ctx.oiAnalytics?.regime || '';
  const oiAligned = (ctx.direction === 'bullish'
                    && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
                || (ctx.direction === 'bearish'
                    && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'));
  if (oiAligned) {
    score += 8; confirmations.push(`OI ${oiR}`);
  }
  // 6. Volume spike on entry candle
  const tvState = ctx.volumeAnalysis?.timeVolume?.state;
  if (tvState === 'spike') {
    score += 6; confirmations.push('volume spike');
  } else if (tvState === 'dry_up') {
    score -= 4; confirmations.push('volume dry');
  }
  // 7. VWAP distance moderate (not stretched)
  const dist = Math.abs(_safe(ctx.vwap?.distance_pct));
  if (dist < 0.3) {
    score += 5; confirmations.push(`near VWAP ${dist.toFixed(2)}%`);
  } else if (dist > 0.7) {
    score -= 3; confirmations.push(`stretched VWAP ${dist.toFixed(2)}%`);
  }
  // 8. UT Bot 5m aligned (extra confidence)
  const tf5 = ctx.utBot?.perTimeframe?.['5m']?.trend;
  if (tf5 === ctx.direction) {
    score += 6; confirmations.push(`UT 5m ${tf5}`);
  }
  // 9. MTF structure aligned
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 6; confirmations.push('MTF full');
  }

  // Need ≥3 confirmations for elite, ≥2 for standard
  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'RANGE_BREAK_RETEST',
    family: 'momentum_continuation',
    // Standard+ allowed — this is a fallback for mixed-chop days where
    // structural confirmations are inherently weaker. The break+retest
    // pattern itself is the primary edge.
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.2 },
    riskProfile: { slPct: 0.10, sizingFactor: conviction === 'elite' ? 0.85 : 0.7 },
    minScoreOverride: 65,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['break_of_30m_range', 'retest_held', 'vwap_aligned', 'delta_4pct'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 29: QUIET_RANGE_FADE ────────────────────────────────────
// 2026-05-18 cycle 37 (zero/low-day rescue Phase 2):
// Quiet sideways days (~5 of the 42 low-trade days) have:
//   - rangePct < 0.7%, ATR5m < 25 (tight compressed range)
//   - bouncing between dayHigh and dayLow
//   - GAMMA_PIN_MEAN_REVERSION wants `inside_va` AND a clear edge position
//     (<35% or >65% of VA), but these days hover at POC center
//
// This playbook fades the day's high/low directly when:
//   1. Compressed range: ATR5m < 25 AND rangePct < 0.8%
//   2. Spot within 8pts of dayHigh (bearish setup) or dayLow (bullish setup)
//   3. VWAP near spot (dist_pct < 0.4%)
//   4. Volume not climaxing (pure compressive trade)
//   5. NOT in expansion/high-vol regime (would imply real breakout)
//
// Hold profile: SCALP, 120s, RR 0.8 — quick rotational scalp, sizing 0.4x
// (small positions because tight ranges = tight rewards).
function _quietRangeFade(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const c5 = ctx.candles5m || [];
  if (c5.length < 12) required.push('insufficient 5m candles');

  const spot = Number(ctx.spotPrice);
  if (!Number.isFinite(spot)) required.push('no spot price');

  // Compressed-range gate: small ATR + small range
  // CALIBRATED cycle 2: backtest showed most days have rangePct 0.85-1.15%.
  // Tightening to <0.8% blocked all candidates. Loosen to <1.2% which still
  // captures genuinely range-bound days (vs <2.5% trend days).
  const atr5m = _safe(ctx.volatilityRegime?.atr5m);
  if (atr5m === 0 || atr5m > 35) {
    required.push(`ATR5m ${atr5m} too high (need <35)`);
  }

  // Compute day high/low and rangePct from candles5m
  let dayHigh = -Infinity, dayLow = Infinity;
  for (const b of c5) { if (b.h > dayHigh) dayHigh = b.h; if (b.l < dayLow) dayLow = b.l; }
  const opening = c5[0]?.o;
  const rangePct = opening ? ((dayHigh - dayLow) / opening) * 100 : 999;
  if (rangePct > 2.0) required.push(`range ${rangePct.toFixed(2)}% too wide`);

  // Edge position — spot must be near dayHigh (bearish fade) or dayLow (bullish fade)
  // CALIBRATED cycle 2: 8pts → 12pts to allow more candidates
  const distFromHigh = dayHigh - spot;
  const distFromLow  = spot - dayLow;
  if (ctx.direction === 'bearish' && distFromHigh > 12) {
    required.push(`bearish needs spot near dayHigh (dist=${distFromHigh.toFixed(1)})`);
  }
  if (ctx.direction === 'bullish' && distFromLow > 12) {
    required.push(`bullish needs spot near dayLow (dist=${distFromLow.toFixed(1)})`);
  }

  // VWAP near spot — confirms range-bound character
  const vwapDist = Math.abs(_safe(ctx.vwap?.distance_pct));
  if (vwapDist > 0.4) required.push(`VWAP too far (${vwapDist.toFixed(2)}%)`);

  // Volume must not be climaxing — that signals real breakout, not fade
  const tvState = ctx.volumeAnalysis?.timeVolume?.state;
  if (tvState === 'climax' || tvState === 'spike') {
    required.push(`volume ${tvState} (real breakout signal)`);
  }

  // Block expansion / high-vol regimes
  if (ctx.volatilityRegime?.state === 'expansion') required.push('expansion vol');

  // Block trending market regime — pure mean-revert tool
  const regime = ctx.marketRegime?.regime;
  if (regime === 'trending_bullish' || regime === 'trending_bearish') {
    required.push(`regime ${regime} — fade tool needs ranging market`);
  }

  // Hard exclusions: trap, midday only fine, expiry afternoon
  if ((ctx.trap?.trapScore || 0) >= 70) required.push(`trap ${ctx.trap.trapScore}`);
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1430) {
    required.push('expiry afternoon');
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'QUIET_RANGE_FADE', family: 'mean_reversion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35;
  reasons.push(`compressed ${rangePct.toFixed(2)}% range, edge fade, VWAP ${vwapDist.toFixed(2)}% close`);

  // ── Confirmations ──
  // 1. Failed breakouts in session — pin is real
  const failed = (ctx.sessionMemory?.failedBreakouts || 0) + (ctx.sessionMemory?.failedBreakdowns || 0);
  if (failed >= 1) { score += 8; confirmations.push(`${failed} failed break(s)`); }

  // 2. VSA upthrust (bearish from edge) / spring (bullish from low)
  const vsa = ctx.volumeAnalysis?.vsa;
  if ((ctx.direction === 'bullish' && vsa?.pattern === 'spring')
   || (ctx.direction === 'bearish' && vsa?.pattern === 'upthrust')) {
    score += 12; confirmations.push(`VSA ${vsa.pattern}`);
  }

  // 3. Weak delta — no momentum to fight
  const deltaPct = Math.abs(_safe(ctx.volumeAnalysis?.delta?.cvdPctLong));
  if (deltaPct < 8) {
    score += 8; confirmations.push(`weak delta ${deltaPct}%`);
  } else if (deltaPct > 20) {
    score -= 12; confirmations.push(`strong delta ${deltaPct}% — wrong setup`);
  }

  // 4. Positive gamma regime — supports mean reversion
  if (ctx.gammaRegime?.regime === 'positive') {
    score += 10; confirmations.push('positive gamma');
  }

  // 5. Inside VA helps (we already passed above logic without requiring it)
  if (ctx.volumeAnalysis?.acceptance === 'inside_va') {
    score += 6; confirmations.push('inside VA');
  }

  // 6. Liquidity good
  if (ctx.liquidity?.health === 'good' || ctx.liquidity?.health === 'excellent') {
    score += 4; confirmations.push(`liq ${ctx.liquidity.health}`);
  }

  // 7. Last 5m candle showing rejection wick (fade signal)
  const last = c5[c5.length - 1];
  if (last) {
    const upperWick = last.h - Math.max(last.o, last.c);
    const lowerWick = Math.min(last.o, last.c) - last.l;
    const rng = (last.h - last.l) || 1;
    if (ctx.direction === 'bearish' && upperWick / rng > 0.4) {
      score += 8; confirmations.push('upper wick reject');
    }
    if (ctx.direction === 'bullish' && lowerWick / rng > 0.4) {
      score += 8; confirmations.push('lower wick reject');
    }
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'QUIET_RANGE_FADE',
    family: 'mean_reversion',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 120, rrTarget: 0.8 },
    riskProfile: { slPct: 0.07, sizingFactor: conviction === 'elite' ? 0.6 : 0.4 },
    minScoreOverride: 65,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['compressed_range', 'edge_position', 'vwap_close', 'no_climax', 'no_trend_regime'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 30: TREND_RIDE_NO_CONFIRMATION ──────────────────────────
// 2026-05-18 cycle 38 (zero/low-day rescue Phase 3):
// Strong directional trend days (~6 of the 42 low-trade days) where
// INITIATIVE_MOMENTUM_EXPANSION rejects because:
//   - orderflow_state isn't "initiative_buying" / "initiative_selling"
//   - OR meta_regime isn't "trend_auction"
//
// But the candle action IS clearly trending: 5m/15m/30m all closing in the
// same direction, net move > 0.8%, ATR > 25.
//
// Detection:
//   1. Last 4 of 5m candles: ≥3 closing in direction (not strict every-bar)
//   2. Last 2 of 15m candles: BOTH closing in direction
//   3. Net move on day > 0.6% in direction
//   4. ATR5m > 25 (real moves)
//   5. VWAP aligned
//   6. Delta supportive (≥4% in direction)
//   7. NOT in chop / midday_chop
//
// Hold profile: SCALP, 240s, RR 1.0 (longer hold for trend rides), sizing 0.7x
function _trendRideNoConfirmation(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const c5 = ctx.candles5m || [];
  const c15 = ctx.candles15m || [];
  if (c5.length < 12) required.push('insufficient 5m candles');
  if (c15.length < 4) required.push('insufficient 15m candles');

  // 1. Last 4 of 5m candles — at least 3 closing in direction
  const last5x4 = c5.slice(-4);
  const dirBars5m = last5x4.filter(b => {
    if (ctx.direction === 'bullish') return b.c > b.o;
    if (ctx.direction === 'bearish') return b.c < b.o;
    return false;
  }).length;
  if (dirBars5m < 3) required.push(`only ${dirBars5m}/4 5m bars in dir`);

  // 2. Last 2 of 15m candles — both in direction
  const last15x2 = c15.slice(-2);
  const dirBars15m = last15x2.filter(b => {
    if (ctx.direction === 'bullish') return b.c > b.o;
    if (ctx.direction === 'bearish') return b.c < b.o;
    return false;
  }).length;
  if (dirBars15m < 2) required.push(`only ${dirBars15m}/2 15m bars in dir`);

  // 3. Net move on day > 0.6%
  const c0 = c5[0]?.o;
  const cN = c5[c5.length - 1]?.c;
  const netPct = (c0 && cN) ? ((cN - c0) / c0) * 100 : 0;
  if (ctx.direction === 'bullish' && netPct < 0.6) {
    required.push(`net move +${netPct.toFixed(2)}% < 0.6%`);
  }
  if (ctx.direction === 'bearish' && netPct > -0.6) {
    required.push(`net move ${netPct.toFixed(2)}% > -0.6%`);
  }

  // 4. ATR5m > 25
  const atr5m = _safe(ctx.volatilityRegime?.atr5m);
  if (atr5m < 25) required.push(`ATR5m ${atr5m} < 25`);

  // 5. VWAP aligned
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side (${vwapPos})`);
  }

  // 6. Delta supportive (≥4%)
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaOK = (ctx.direction === 'bullish' && deltaPct >= 4)
              || (ctx.direction === 'bearish' && deltaPct <= -4);
  if (!deltaOK) required.push(`delta ${deltaPct}% not supportive`);

  // Hard exclusions
  const regime = ctx.marketRegime?.regime;
  if (regime === 'choppy' || regime === 'ranging') {
    required.push(`regime ${regime} (need trending)`);
  }
  if (ctx.sessionPhase?.phase === 'midday_chop') required.push('midday_chop');
  if ((ctx.trap?.trapScore || 0) >= 70) required.push(`trap ${ctx.trap.trapScore}`);
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1430) {
    required.push('expiry afternoon');
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'TREND_RIDE_NO_CONFIRMATION', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35;
  reasons.push(`net ${netPct.toFixed(2)}% + ${dirBars5m}/4 5m + ${dirBars15m}/2 15m + VWAP ${vwapPos}`);

  // ── Confirmations ──
  // 1. UT Bot 5m + 15m both aligned
  const ut5 = ctx.utBot?.perTimeframe?.['5m']?.trend;
  const ut15 = ctx.utBot?.perTimeframe?.['15m']?.trend;
  if (ut5 === ctx.direction && ut15 === ctx.direction) {
    score += 12; confirmations.push(`UT 5m+15m ${ctx.direction}`);
  } else if (ut5 === ctx.direction) {
    score += 6; confirmations.push(`UT 5m ${ctx.direction}`);
  }
  // 2. Strong delta
  if (Math.abs(deltaPct) >= 10) {
    score += 8; confirmations.push(`strong delta ${deltaPct}%`);
  }
  // 3. Futures aligned
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('futures aligned');
  }
  // 4. OI in direction
  const oiR = ctx.oiAnalytics?.regime || '';
  const oiAligned = (ctx.direction === 'bullish'
                    && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
                || (ctx.direction === 'bearish'
                    && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'));
  if (oiAligned) {
    score += 8; confirmations.push(`OI ${oiR}`);
  }
  // 5. MTF structure aligned
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 8; confirmations.push('MTF full');
  } else if (ctx.mtfStructure?.alignment === 'partial') {
    score += 4; confirmations.push('MTF partial');
  }
  // 6. Expansion vol
  if (ctx.volatilityRegime?.state === 'expansion') {
    score += 6; confirmations.push('expansion vol');
  }
  // 7. Last 5m candle body strength
  const last = c5[c5.length - 1];
  if (last) {
    const body = Math.abs(last.c - last.o);
    const rng = (last.h - last.l) || 1;
    const closingInDir = (ctx.direction === 'bullish' && last.c > last.o)
                      || (ctx.direction === 'bearish' && last.c < last.o);
    if (closingInDir && body / rng > 0.6) {
      score += 6; confirmations.push(`strong body ${(body/rng*100).toFixed(0)}%`);
    }
  }
  // 8. Volume spike (real participation)
  const tvState = ctx.volumeAnalysis?.timeVolume?.state;
  if (tvState === 'spike' || tvState === 'climax') {
    score += 4; confirmations.push(`volume ${tvState}`);
  }

  // Need ≥3 confirmations for elite (this is a "no orderflow confirmation"
  // playbook — it has fewer structural confirmations available, so we
  // require multiple alternative pillars to align).
  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'TREND_RIDE_NO_CONFIRMATION',
    family: 'momentum_continuation',
    // CALIBRATED 2026-05-19 cycle 33: this playbook has 1W/2L (33% WR,
    // -Rs.4064 net) over 3 backtest trades. Most trends already qualify
    // through a stricter playbook (TREND_VWAP_FOLLOW, INITIATIVE_MOMENTUM,
    // or DELTA_DRIVE_SCALP); the "no orderflow confirmation" trades are
    // exactly the ones that don't pan out. Disable until we have a
    // higher-quality screen.
    valid: false,
    score: 0,
    conviction: 'weak',
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.0 },
    riskProfile: { slPct: 0.10, sizingFactor: conviction === 'elite' ? 0.85 : 0.7 },
    minScoreOverride: 65,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['multi_tf_alignment', 'net_0.6pct', 'atr_25', 'vwap_aligned', 'delta_4pct', 'no_chop'],
    confirmations,
    reasoning: `DISABLED cycle 33 (1W/2L net -Rs.4064) | original ${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// PHASE 5 INSTITUTIONAL PLAYBOOKS (2026-05-18 spec)
// Five high-edge setups requested in the institutional review:
//   - DELTA_VELOCITY_BREAKOUT      (delta acceleration → price expansion)
//   - PDH_PDL_SWEEP_REVERSAL       (highest-WR fade in NIFTY)
//   - DOUBLE_DISTRIBUTION_TREND    (bimodal intraday auction)
//   - ABSORPTION_REVERSAL          (microstructure-driven institutional fade)
//   - OVERNIGHT_OI_SHIFT_FOLLOW    (gap-positioning continuation)
// ═════════════════════════════════════════════════════════════════════════

// ─── PLAYBOOK 31: DELTA_VELOCITY_BREAKOUT ────────────────────────────────
// Trade when delta is accelerating into a directional thrust BEFORE price
// has fully expanded. The deltaVelocityEngine and futuresLeadershipEngine
// give us the leading reads.
//
// Detection:
//   1. deltaVelocity.velocityState ∈ {accelerating_up | accelerating_down}
//      OR flipDetected ∈ {up | down}
//   2. Direction must match the velocity direction
//   3. Microstructure must NOT be flagging spoofRisk
//   4. Futures lead score >= 60 (bullish) or <= 40 (bearish)  [strong corroboration]
//   5. VWAP aligned + OI not against
//   6. Price NOT stuck at POC (POC distance > 8pts)
//
// Hold: 240s scalp with 1.4 RR, sizing 0.7x — faster than INITIATIVE_MOMENTUM
// because we're entering EARLIER (the leading edge of a thrust).
function _deltaVelocityBreakout(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const dv = ctx.deltaVelocity;
  if (!dv?.available) required.push('no delta velocity');
  else {
    const velOK = (ctx.direction === 'bullish'
                   && (dv.velocityState === 'accelerating_up' || dv.flipDetected === 'up'))
               || (ctx.direction === 'bearish'
                   && (dv.velocityState === 'accelerating_down' || dv.flipDetected === 'down'));
    if (!velOK) required.push(`velocity ${dv.velocityState} flip=${dv.flipDetected || '-'} not in dir`);
    if (dv.exhaustionDetected) required.push('exhaustion warning');
  }

  // Microstructure not in spoof state
  if (ctx.microstructure?.spoofRisk) required.push('spoof risk active');

  // Futures lead corroboration
  const lead = ctx.futuresLead?.leadLagScore;
  if (Number.isFinite(lead)) {
    if (ctx.direction === 'bullish' && lead < 60) required.push(`fut lead ${lead} < 60`);
    if (ctx.direction === 'bearish' && lead > 40) required.push(`fut lead ${lead} > 40`);
  } else {
    required.push('no futures lead score');
  }

  // VWAP aligned
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
  if (oiAgainst) required.push(`OI ${oiR} against`);

  // POC distance — not stuck
  const poc = ctx.volumeAnalysis?.frvp?.pocPrice;
  if (Number.isFinite(poc) && Number.isFinite(ctx.spotPrice)) {
    const pocDist = Math.abs(ctx.spotPrice - poc);
    if (pocDist < 8) required.push(`POC stuck ${pocDist.toFixed(1)}pts`);
  }

  // Hard exclusions
  if (ctx.sessionPhase?.phase === 'midday_chop') required.push('midday_chop');
  if (ctx.volatilityRegime?.state === 'dead') required.push('dead vol');
  if ((ctx.trap?.trapScore || 0) >= 65) required.push(`trap ${ctx.trap.trapScore}`);
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1430) required.push('expiry afternoon');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'DELTA_VELOCITY_BREAKOUT', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`vel ${dv.velocityState} + fut lead ${lead}`);

  // Confirmations
  // 1. Microstructure aligned (book imbalance + state confirms)
  const m = ctx.microstructure;
  if (m?.available) {
    if ((ctx.direction === 'bullish' && (m.state === 'aggressive_buying' || m.state === 'absorption_long' || m.state === 'liquidity_pull_up'))
     || (ctx.direction === 'bearish' && (m.state === 'aggressive_selling' || m.state === 'absorption_short' || m.state === 'liquidity_pull_down'))) {
      score += 12; confirmations.push(`micro ${m.state}`);
    }
  }
  // 2. Aggressive futures candle
  if (ctx.futuresLead?.aggressiveCandle?.detected
      && ((ctx.direction === 'bullish' && ctx.futuresLead.aggressiveCandle.direction === 'up')
       || (ctx.direction === 'bearish' && ctx.futuresLead.aggressiveCandle.direction === 'down'))) {
    score += 10; confirmations.push('aggressive fut candle');
  }
  // 3. OI aligned
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 10; confirmations.push(`OI ${oiR}`);
  }
  // 4. Volume spike on entry candle
  const tvState = ctx.volumeAnalysis?.timeVolume?.state;
  if (tvState === 'spike' || tvState === 'climax') {
    score += 6; confirmations.push(`vol ${tvState}`);
  }
  // 5. Strong delta absolute
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if (Math.abs(deltaPct) >= 12) {
    score += 6; confirmations.push(`delta ${deltaPct}%`);
  }
  // 6. MTF supportive
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 8; confirmations.push('MTF full');
  } else if (ctx.mtfStructure?.alignment === 'partial') {
    score += 4; confirmations.push('MTF partial');
  }
  // 7. Basis aligned
  if ((ctx.direction === 'bullish' && ctx.futuresLead?.basis?.trend === 'expanding')
   || (ctx.direction === 'bearish' && ctx.futuresLead?.basis?.trend === 'contracting')) {
    score += 4; confirmations.push(`basis ${ctx.futuresLead.basis.trend}`);
  }

  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'DELTA_VELOCITY_BREAKOUT',
    family: 'momentum_continuation',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.4 },
    riskProfile: { slPct: 0.10, sizingFactor: conviction === 'elite' ? 0.85 : 0.65 },
    minScoreOverride: 65,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['velocity_aligned', 'fut_lead', 'vwap_aligned', 'oi_not_against', 'no_poc_stuck'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ') || 'preconditions only'}`,
  };
}

// ─── PLAYBOOK 32: PDH_PDL_SWEEP_REVERSAL ─────────────────────────────────
// The single highest-WR setup in NIFTY per the institutional review.
// Detection:
//   1. Price has SWEPT prior-day high (bearish trade) or low (bullish trade)
//      — within last 30 minutes
//   2. After the sweep, price has reclaimed BACK inside the prior-day range
//      AND held there for ≥2 5m bars
//   3. Delta divergence at the sweep extreme (spotted by volumeAnalysis)
//      OR microstructure absorption / iceberg at the sweep level
//   4. VWAP aligned with the reclaim direction
function _pdhPdlSweepReversal(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const pdh = ctx.multiDayContext?.priorDay?.high;
  const pdl = ctx.multiDayContext?.priorDay?.low;
  if (!Number.isFinite(pdh) || !Number.isFinite(pdl)) required.push('no PDH/PDL');

  const c5 = ctx.candles5m || [];
  if (c5.length < 6) required.push('insufficient 5m candles');

  const spot = Number(ctx.spotPrice);
  if (!Number.isFinite(spot)) required.push('no spot');

  // Detect sweep within last 6 5m bars (30min)
  let sweptHigh = false, sweptLow = false, sweepBar = null;
  if (Number.isFinite(pdh) && Number.isFinite(pdl) && c5.length >= 6) {
    const recent = c5.slice(-6);
    for (const b of recent) {
      if (b.h > pdh) { sweptHigh = true; sweepBar = b; }
      if (b.l < pdl) { sweptLow = true; sweepBar = b; }
    }
  }
  // Direction must match the sweep side: bullish trade after a low sweep,
  // bearish trade after a high sweep
  if (ctx.direction === 'bullish' && !sweptLow) required.push('no PDL sweep');
  if (ctx.direction === 'bearish' && !sweptHigh) required.push('no PDH sweep');

  // Reclaim: spot now BACK inside prior-day range
  const insideRange = Number.isFinite(spot) && Number.isFinite(pdh) && Number.isFinite(pdl)
    && spot >= pdl && spot <= pdh;
  if (!insideRange) required.push('not back inside prior range');

  // Hold the reclaim — last 2 5m closes inside prior range
  const last2 = c5.slice(-2);
  const heldReclaim = last2.length === 2 && last2.every(b => b.c >= pdl && b.c <= pdh);
  if (!heldReclaim) required.push('reclaim not held 2 bars');

  // VWAP must support reclaim direction
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side (${vwapPos})`);
  }

  // Hard exclusions
  if ((ctx.trap?.trapScore || 0) >= 70) required.push(`trap ${ctx.trap.trapScore}`);

  // CALIBRATED 2026-05-19 cycle 34: Loss case 2026-04-02 14:15 expiry day —
  // PDH/PDL sweep reversal does NOT work on expiry afternoons. Theta + dealer
  // hedging dominate; price often sweeps and continues rather than reverts.
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1330) {
    required.push('expiry afternoon — sweep reversion fails on dealer flow');
  }
  // Also block expiry_expansion meta — same dynamic, dealer-driven thrust.
  if (ctx.metaRegime?.state === 'expiry_expansion') {
    required.push('expiry_expansion meta');
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'PDH_PDL_SWEEP_REVERSAL', family: 'reversal',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 40; reasons.push(`${ctx.direction === 'bullish' ? 'PDL' : 'PDH'} swept + reclaimed + held`);

  // Confirmations
  // 1. Delta divergence supports
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  if (div && div !== 'none' && divBias === ctx.direction) {
    score += 14; confirmations.push(`delta div ${div}`);
  }
  // 2. Microstructure absorption on the right side
  const m = ctx.microstructure;
  if (m?.available) {
    if ((ctx.direction === 'bullish' && (m.state === 'absorption_long' || m.state === 'iceberg_support'))
     || (ctx.direction === 'bearish' && (m.state === 'absorption_short' || m.state === 'iceberg_resistance'))) {
      score += 12; confirmations.push(`micro ${m.state}`);
    }
  }
  // 3. VSA spring/upthrust
  const vsa = ctx.volumeAnalysis?.vsa;
  if ((vsa?.pattern === 'spring' && ctx.direction === 'bullish')
   || (vsa?.pattern === 'upthrust' && ctx.direction === 'bearish')) {
    score += 12; confirmations.push(`VSA ${vsa.pattern}`);
  }
  // 4. 5m CHOCH
  if ((ctx.direction === 'bullish' && ctx.mtfStructure?.choch5 === 'bullish_choch')
   || (ctx.direction === 'bearish' && ctx.mtfStructure?.choch5 === 'bearish_choch')) {
    score += 10; confirmations.push(`5m ${ctx.mtfStructure.choch5}`);
  }
  // 5. Responsive flow
  if ((ctx.orderflowState?.state === 'responsive_buying' && ctx.direction === 'bullish')
   || (ctx.orderflowState?.state === 'responsive_selling' && ctx.direction === 'bearish')) {
    score += 10; confirmations.push(`responsive ${ctx.direction}`);
  }
  // 6. Trap engine corroborates (failed sweep)
  if ((ctx.trap?.trapScore || 0) >= 40) {
    score += 6; confirmations.push(`trap ${ctx.trap.trapScore}`);
  }
  // 7. Futures lead aligned
  if (ctx.futuresLead?.available
      && ((ctx.direction === 'bullish' && ctx.futuresLead.leadLagScore >= 55)
       || (ctx.direction === 'bearish' && ctx.futuresLead.leadLagScore <= 45))) {
    score += 6; confirmations.push(`fut lead ${ctx.futuresLead.leadLagScore}`);
  }

  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'PDH_PDL_SWEEP_REVERSAL',
    family: 'reversal',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    // Best NIFTY reversal setup → larger target, longer hold
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 420, rrTarget: 2.0 },
    riskProfile: { slPct: 0.10, sizingFactor: conviction === 'elite' ? 1.0 : 0.7 },
    minScoreOverride: 62,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['sweep', 'reclaim', 'held_reclaim', 'vwap_supportive'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 33: DOUBLE_DISTRIBUTION_TREND ──────────────────────────────
// Bimodal intraday auction — price builds value at one level, breaks out
// to a new value, then trends in that direction. Auction state already
// labels this as 'double_distribution'. We trade the second-distribution
// continuation.
function _doubleDistributionTrend(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  if (ctx.auctionState?.dayType !== 'double_distribution') {
    required.push(`auction ${ctx.auctionState?.dayType} not double_distribution`);
  }

  // Direction must align with current macro move (compare last vs first 5m close)
  const c5 = ctx.candles5m || [];
  if (c5.length < 12) required.push('insufficient 5m candles');
  let netMove = 0;
  if (c5.length >= 12) {
    netMove = c5[c5.length - 1].c - c5[0].o;
    if (ctx.direction === 'bullish' && netMove < 5) required.push(`net move ${netMove.toFixed(1)} < 5`);
    if (ctx.direction === 'bearish' && netMove > -5) required.push(`net move ${netMove.toFixed(1)} > -5`);
  }

  // VWAP supportive
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side`);
  }

  // Block expiry afternoons
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1430) {
    required.push('expiry afternoon');
  }

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'DOUBLE_DISTRIBUTION_TREND', family: 'breakout_expansion',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`double_distribution + net ${netMove.toFixed(0)}pts`);

  // Confirmations
  // 1. OI aligned
  const oiR = ctx.oiAnalytics?.regime || '';
  const oiAligned = (ctx.direction === 'bullish'
                    && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
                || (ctx.direction === 'bearish'
                    && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'));
  if (oiAligned) { score += 12; confirmations.push(`OI ${oiR}`); }

  // 2. Delta strong in direction
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if ((ctx.direction === 'bullish' && deltaPct >= 8)
   || (ctx.direction === 'bearish' && deltaPct <= -8)) {
    score += 10; confirmations.push(`delta ${deltaPct}%`);
  }

  // 3. Acceptance beyond second distribution = above/below VA
  const acc = ctx.volumeAnalysis?.acceptance;
  if ((ctx.direction === 'bullish' && acc === 'above_va')
   || (ctx.direction === 'bearish' && acc === 'below_va')) {
    score += 10; confirmations.push(`accepted ${acc}`);
  }

  // 4. MTF aligned
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 10; confirmations.push('MTF full');
  } else if (ctx.mtfStructure?.alignment === 'partial') {
    score += 5; confirmations.push('MTF partial');
  }

  // 5. Futures aligned
  if (ctx.futuresData?.direction === ctx.direction) {
    score += 6; confirmations.push('fut aligned');
  }

  // 6. Microstructure aligned
  const m = ctx.microstructure;
  if (m?.available && ((ctx.direction === 'bullish' && /buying/.test(m.state))
                    || (ctx.direction === 'bearish' && /selling/.test(m.state)))) {
    score += 8; confirmations.push(`micro ${m.state}`);
  }

  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'DOUBLE_DISTRIBUTION_TREND',
    family: 'breakout_expansion',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 600, rrTarget: 2.5 },
    riskProfile: { slPct: 0.13, sizingFactor: conviction === 'elite' ? 0.9 : 0.7 },
    minScoreOverride: 68,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['double_distribution', 'net_move_in_dir', 'vwap_supportive'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 34: ABSORPTION_REVERSAL ────────────────────────────────────
// Pure microstructure-driven institutional fade. Fires when:
//   - microstructure detects absorption_long (large bid eats sells, price flat)
//     or absorption_short
//   - direction matches the absorbed side
//   - we're at a structural level (HVN / VA edge / VWAP / PDH-PDL)
//   - delta neutral or slight against the absorption side (the absorption
//     IS the institutional bid eating retail flow)
//
// This is one of the user-spec institutional setups that needed
// microstructure data to detect.
function _absorptionReversal(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const m = ctx.microstructure;
  if (!m?.available) required.push('no microstructure');

  const absorbingLong  = m && (m.state === 'absorption_long' || m.state === 'iceberg_support');
  const absorbingShort = m && (m.state === 'absorption_short' || m.state === 'iceberg_resistance');
  if (ctx.direction === 'bullish' && !absorbingLong) required.push('no bullish absorption / iceberg');
  if (ctx.direction === 'bearish' && !absorbingShort) required.push('no bearish absorption / iceberg');

  // Need to be at a structural level (within 20pts of a known level)
  const spot = Number(ctx.spotPrice);
  let atLevel = false;
  let levelName = null;
  if (Number.isFinite(spot)) {
    const checks = [];
    const cp = ctx.multiDayContext?.compositeProfile;
    if (cp?.vah) checks.push({ name: 'CompVAH', price: cp.vah });
    if (cp?.val) checks.push({ name: 'CompVAL', price: cp.val });
    if (cp?.poc) checks.push({ name: 'CompPOC', price: cp.poc });
    const pd = ctx.multiDayContext?.priorDay;
    if (pd?.high) checks.push({ name: 'PDH', price: pd.high });
    if (pd?.low)  checks.push({ name: 'PDL', price: pd.low });
    const va = ctx.volumeAnalysis?.frvp;
    if (va?.vaHigh) checks.push({ name: 'VAH', price: va.vaHigh });
    if (va?.vaLow)  checks.push({ name: 'VAL', price: va.vaLow });
    if (va?.pocPrice) checks.push({ name: 'POC', price: va.pocPrice });
    if (Number.isFinite(ctx.vwap?.vwap)) checks.push({ name: 'VWAP', price: Number(ctx.vwap.vwap) });
    for (const c of checks) {
      if (Math.abs(c.price - spot) < 20) {
        atLevel = true; levelName = c.name; break;
      }
    }
  }
  if (!atLevel) required.push('not at structural level');

  // Block on expansion vol — absorption fades fail when real expansion runs through
  if (ctx.volatilityRegime?.state === 'expansion') {
    // Allow only if iceberg (these can hold even in expansion)
    if (m?.state !== 'iceberg_support' && m?.state !== 'iceberg_resistance') {
      required.push('expansion vol');
    }
  }
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1430) {
    required.push('expiry afternoon');
  }
  if (m?.spoofRisk) required.push('spoof risk');

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'ABSORPTION_REVERSAL', family: 'reversal',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`micro ${m.state} at ${levelName}`);

  // Confirmations
  // 1. OI absorption matches
  if (ctx.oiAnalytics?.absorption?.detected) {
    const side = ctx.oiAnalytics.absorption.side;
    if ((ctx.direction === 'bullish' && side === 'pe')
     || (ctx.direction === 'bearish' && side === 'ce')) {
      score += 14; confirmations.push(`OI absorption ${side}`);
    }
  }
  // 2. VSA absorption matches
  if (ctx.volumeAnalysis?.vsa?.pattern === 'absorption'
      && ctx.volumeAnalysis.vsa.bias === ctx.direction) {
    score += 12; confirmations.push('VSA absorption');
  }
  // 3. Delta divergence
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  if (div && div !== 'none' && divBias === ctx.direction) {
    score += 10; confirmations.push(`delta div ${div}`);
  }
  // 4. Auction excess on right side
  if ((ctx.direction === 'bullish' && ctx.auctionState?.excessLow)
   || (ctx.direction === 'bearish' && ctx.auctionState?.excessHigh)) {
    score += 8; confirmations.push('auction excess');
  }
  // 5. Trap corroborates
  if ((ctx.trap?.trapScore || 0) >= 50) {
    score += 6; confirmations.push(`trap ${ctx.trap.trapScore}`);
  }
  // 6. Microstructure imbalance magnitude
  if (Math.abs(m.imbalance || 0) >= 0.30) {
    score += 6; confirmations.push(`imb ${(m.imbalance * 100).toFixed(0)}%`);
  }

  const conviction = confirmations.length >= 3 ? 'elite' :
                     confirmations.length >= 1 ? 'standard' : 'weak';

  return {
    name: 'ABSORPTION_REVERSAL',
    family: 'reversal',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.5 },
    riskProfile: { slPct: 0.08, sizingFactor: conviction === 'elite' ? 0.85 : 0.6 },
    minScoreOverride: 62,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['microstructure_absorption', 'at_structural_level'],
    confirmations,
    reasoning: `${conviction.toUpperCase()} | level=${levelName} | ${confirmations.join(' | ')}`,
  };
}

// ─── PLAYBOOK 35: OVERNIGHT_OI_SHIFT_FOLLOW ──────────────────────────────
// Multi-day OI walls migrated overnight → strong directional positioning
// for the new session. Trade in the direction of the migration during
// the morning power window (09:15 - 11:00) when positioning resolves.
function _overnightOiShiftFollow(ctx) {
  const reasons = [];
  let score = 0;
  const required = [];
  const confirmations = [];

  const ceMig = ctx.multiDayContext?.oiMigration?.ce;
  const peMig = ctx.multiDayContext?.oiMigration?.pe;

  // Bullish: PE peak migrating up (PE writers raising stops) OR
  //          CE peak migrating up (CE walls rising = resistance moving away)
  // Bearish: opposite
  const bullishMig = (ceMig === 'up' || peMig === 'up');
  const bearishMig = (ceMig === 'down' || peMig === 'down');
  const dirMig = (ctx.direction === 'bullish' && bullishMig)
              || (ctx.direction === 'bearish' && bearishMig);
  if (!dirMig) required.push(`OI mig ce=${ceMig} pe=${peMig} not aligned`);

  // Window 09:15 - 11:30 — overnight repositioning resolves in the AM
  const hhmm = ctx.sessionPhase?.hhmm || 0;
  if (hhmm < 915 || hhmm >= 1130) required.push(`outside AM window (${hhmm})`);

  // VWAP supportive
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push(`VWAP wrong side`);
  }

  // Need at least 3 prior session migrations tracked for stability
  const sessions = ctx.multiDayContext?.oiMigration?.sessionsTracked || 0;
  if (sessions < 3) required.push(`only ${sessions} sessions tracked`);

  // Hard exclusions
  if (ctx.volatilityRegime?.state === 'dead') required.push('dead vol');
  if ((ctx.trap?.trapScore || 0) >= 65) required.push(`trap ${ctx.trap.trapScore}`);

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'OVERNIGHT_OI_SHIFT_FOLLOW', family: 'momentum_continuation',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 35; reasons.push(`OI mig ${ctx.direction} aligned (${sessions} sessions)`);

  // Confirmations
  // 1. Both CE and PE migrate in same direction (full positioning shift)
  if ((ctx.direction === 'bullish' && ceMig === 'up' && peMig === 'up')
   || (ctx.direction === 'bearish' && ceMig === 'down' && peMig === 'down')) {
    score += 12; confirmations.push(`full mig ce+pe ${ctx.direction}`);
  }
  // 2. OI regime aligned today
  const oiR = ctx.oiAnalytics?.regime || '';
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 12; confirmations.push(`OI ${oiR}`);
  }
  // 3. Delta in direction
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  if ((ctx.direction === 'bullish' && deltaPct >= 5)
   || (ctx.direction === 'bearish' && deltaPct <= -5)) {
    score += 8; confirmations.push(`delta ${deltaPct}%`);
  }
  // 4. Futures lead
  if (ctx.futuresLead?.available
      && ((ctx.direction === 'bullish' && ctx.futuresLead.leadLagScore >= 55)
       || (ctx.direction === 'bearish' && ctx.futuresLead.leadLagScore <= 45))) {
    score += 8; confirmations.push(`fut lead ${ctx.futuresLead.leadLagScore}`);
  }
  // 5. MTF supportive
  if (ctx.mtfStructure?.alignment === 'full') {
    score += 8; confirmations.push('MTF full');
  } else if (ctx.mtfStructure?.alignment === 'partial') {
    score += 4; confirmations.push('MTF partial');
  }
  // 6. Acceptance favourable
  const acc = ctx.volumeAnalysis?.acceptance;
  if ((ctx.direction === 'bullish' && acc === 'above_va')
   || (ctx.direction === 'bearish' && acc === 'below_va')) {
    score += 6; confirmations.push(`acc ${acc}`);
  }

  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'OVERNIGHT_OI_SHIFT_FOLLOW',
    family: 'momentum_continuation',
    valid: conviction !== 'weak',
    score: _clamp(score),
    conviction,
    holdProfile: { tradeType: 'SWING', maxHoldSec: 600, rrTarget: 2.5 },
    riskProfile: { slPct: 0.12, sizingFactor: conviction === 'elite' ? 0.9 : 0.65 },
    minScoreOverride: 65,
    allowedDirections: ['bullish', 'bearish'],
    preconditions: ['oi_migration', 'am_window', 'vwap_supportive', 'sessions_tracked'],
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
  trend_auction:    ['INITIATIVE_MOMENTUM_EXPANSION', 'PULLBACK_CONTINUATION', 'OPENING_DRIVE_CONTINUATION', 'OPENING_DRIVE_FAILURE', 'VWAP_RECLAIM_CLEAN', 'VOLATILITY_COMPRESSION_SQUEEZE', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'COUNTER_TREND_REVERSAL', 'DELTA_DRIVE_SCALP', 'UT_BOT_FAST_SCALP', 'TREND_RIDE_NO_CONFIRMATION', 'LIGHT_TREND_DRIFT_SCALP', 'DELTA_VELOCITY_BREAKOUT', 'PDH_PDL_SWEEP_REVERSAL', 'DOUBLE_DISTRIBUTION_TREND', 'OVERNIGHT_OI_SHIFT_FOLLOW'],
  short_covering:   ['SHORT_COVERING_SQUEEZE', 'INITIATIVE_MOMENTUM_EXPANSION', 'VWAP_RECLAIM_CLEAN', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'COUNTER_TREND_REVERSAL', 'DELTA_DRIVE_SCALP', 'SWEEP_RECLAIM_SCALP', 'UT_BOT_FAST_SCALP', 'TREND_RIDE_NO_CONFIRMATION', 'LIGHT_TREND_DRIFT_SCALP', 'DELTA_VELOCITY_BREAKOUT', 'OVERNIGHT_OI_SHIFT_FOLLOW'],
  long_liquidation: ['LONG_LIQUIDATION_CASCADE', 'INITIATIVE_MOMENTUM_EXPANSION', 'VWAP_RECLAIM_CLEAN', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'COUNTER_TREND_REVERSAL', 'DELTA_DRIVE_SCALP', 'SWEEP_RECLAIM_SCALP', 'UT_BOT_FAST_SCALP', 'TREND_RIDE_NO_CONFIRMATION', 'LIGHT_TREND_DRIFT_SCALP', 'DELTA_VELOCITY_BREAKOUT', 'OVERNIGHT_OI_SHIFT_FOLLOW'],
  gamma_pin:        ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'FAILED_AUCTION_REVERSAL', 'EXHAUSTION_REVERSAL', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP', 'VALUE_AREA_ROTATION', 'PIN_REVERSION', 'LVN_REJECTION_SCALP', 'VWAP_OSCILLATION_SCALP', 'MICRO_DELTA_FLIP', 'SWEEP_RECLAIM_SCALP', 'PDH_PDL_SWEEP_REVERSAL', 'ABSORPTION_REVERSAL'],
  balanced_auction: ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'FAILED_AUCTION_REVERSAL', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP', 'VALUE_AREA_ROTATION', 'PIN_REVERSION', 'LVN_REJECTION_SCALP', 'VWAP_OSCILLATION_SCALP', 'MICRO_DELTA_FLIP', 'SWEEP_RECLAIM_SCALP', 'OPENING_DRIVE_FAILURE', 'PDH_PDL_SWEEP_REVERSAL', 'ABSORPTION_REVERSAL'],
  slow_grind:       ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'PULLBACK_CONTINUATION', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP', 'VALUE_AREA_ROTATION', 'PIN_REVERSION', 'LVN_REJECTION_SCALP', 'VWAP_OSCILLATION_SCALP', 'MICRO_DELTA_FLIP', 'LIGHT_TREND_DRIFT_SCALP', 'ABSORPTION_REVERSAL'],
  dealer_hedging:   ['INITIATIVE_MOMENTUM_EXPANSION', 'PULLBACK_CONTINUATION', 'VWAP_RECLAIM_CLEAN', 'VOLATILITY_COMPRESSION_SQUEEZE', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'COUNTER_TREND_REVERSAL', 'DELTA_DRIVE_SCALP', 'VWAP_OSCILLATION_SCALP', 'MICRO_DELTA_FLIP', 'UT_BOT_FAST_SCALP', 'TREND_RIDE_NO_CONFIRMATION', 'LIGHT_TREND_DRIFT_SCALP', 'DELTA_VELOCITY_BREAKOUT'],
  expiry_expansion: ['WEEKLY_EXPIRY_DEALER_UNWIND', 'INITIATIVE_MOMENTUM_EXPANSION', 'FAILED_AUCTION_REVERSAL', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP', 'TREND_VWAP_FOLLOW', 'DELTA_DRIVE_SCALP', 'PIN_REVERSION', 'SWEEP_RECLAIM_SCALP', 'UT_BOT_FAST_SCALP', 'TREND_RIDE_NO_CONFIRMATION', 'LIGHT_TREND_DRIFT_SCALP', 'DELTA_VELOCITY_BREAKOUT', 'PDH_PDL_SWEEP_REVERSAL'],
  panic:            ['EXHAUSTION_REVERSAL', 'FAILED_AUCTION_REVERSAL', 'SWEEP_RECLAIM_SCALP', 'PDH_PDL_SWEEP_REVERSAL', 'ABSORPTION_REVERSAL'],
  unknown:          ['GAMMA_PIN_MEAN_REVERSION', 'VWAP_RECLAIM_CLEAN', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'VWAP_BOUNCE_SCALP', 'DELTA_DRIVE_SCALP', 'VALUE_AREA_ROTATION', 'VWAP_OSCILLATION_SCALP', 'LVN_REJECTION_SCALP', 'UT_BOT_FAST_SCALP', 'TREND_RIDE_NO_CONFIRMATION', 'LIGHT_TREND_DRIFT_SCALP', 'PDH_PDL_SWEEP_REVERSAL'],
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
  // Phase 4 trend-ride no-confirmation (2026-05-18 cycle 38) — strong trends
  // without orderflow's strict initiative classification.
  _trendRideNoConfirmation,
  // Phase 5 institutional spec 2026-05-18 — microstructure / leadership /
  // velocity driven elite setups.
  _deltaVelocityBreakout,
  _pdhPdlSweepReversal,
  _doubleDistributionTrend,
  _absorptionReversal,
  _overnightOiShiftFollow,
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
