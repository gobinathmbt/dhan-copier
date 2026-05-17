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
    // CALIBRATED 2026-05-18 cycle 1: TIMEOUT bleeds were 16 small losses
    // totalling -₹25k. Cut hold from 240s to 150s — pin moves resolve fast
    // or not at all. Tight SL too.
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 150, rrTarget: 1.0 },
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
  if (dist > 0.6) required.push(`too far from VWAP (${dist.toFixed(2)}%)`);

  // Direction must align with VWAP position (price near VWAP, on right side)
  const vwapPos = vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos !== 'above')
   || (ctx.direction === 'bearish' && vwapPos !== 'below')) {
    required.push('VWAP wrong side');
  }

  // Delta must be in direction (any positive/negative)
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

  const valid = required.length === 0;
  if (!valid) {
    return { name: 'VWAP_BOUNCE_SCALP', family: 'vwap_reclaim',
             valid: false, score: 0, conviction: 'weak', missing: required,
             reasoning: `missing: ${required.join(', ')}` };
  }
  score += 30; reasons.push('VWAP bounce + delta');

  // Confirmations
  // OI in direction
  const oiR = ctx.oiAnalytics?.regime || '';
  if ((ctx.direction === 'bullish' && (oiR === 'aggressive_long_buildup' || oiR === 'violent_short_covering'))
   || (ctx.direction === 'bearish' && (oiR === 'aggressive_short_buildup' || oiR === 'long_unwinding_collapse'))) {
    score += 12; confirmations.push(`OI ${oiR}`);
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

  // Need at least 2 confirmations to graduate to standard
  const conviction = confirmations.length >= 4 ? 'elite' :
                     confirmations.length >= 2 ? 'standard' : 'weak';

  return {
    name: 'VWAP_BOUNCE_SCALP',
    family: 'vwap_reclaim',
    valid: conviction !== 'weak' && score >= 50,
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

// ─── REGIME → PLAYBOOK ELIGIBILITY MAP (institutional spec) ────────────────
// This is the orchestrator's "permission map". Even if a playbook scores
// high, it must match the current meta-regime to be eligible.
const REGIME_PLAYBOOKS = {
  trend_auction:    ['INITIATIVE_MOMENTUM_EXPANSION', 'PULLBACK_CONTINUATION', 'OPENING_DRIVE_CONTINUATION', 'VWAP_RECLAIM_CLEAN', 'VOLATILITY_COMPRESSION_SQUEEZE', 'VWAP_BOUNCE_SCALP'],
  short_covering:   ['SHORT_COVERING_SQUEEZE', 'INITIATIVE_MOMENTUM_EXPANSION', 'VWAP_RECLAIM_CLEAN', 'VWAP_BOUNCE_SCALP'],
  long_liquidation: ['LONG_LIQUIDATION_CASCADE', 'INITIATIVE_MOMENTUM_EXPANSION', 'VWAP_RECLAIM_CLEAN', 'VWAP_BOUNCE_SCALP'],
  gamma_pin:        ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'FAILED_AUCTION_REVERSAL', 'EXHAUSTION_REVERSAL', 'IV_CRUSH_FADE'],
  balanced_auction: ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'FAILED_AUCTION_REVERSAL', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP'],
  slow_grind:       ['GAMMA_PIN_MEAN_REVERSION', 'HVN_REJECTION_ROTATION', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'PULLBACK_CONTINUATION', 'IV_CRUSH_FADE', 'VWAP_BOUNCE_SCALP'],
  dealer_hedging:   ['INITIATIVE_MOMENTUM_EXPANSION', 'PULLBACK_CONTINUATION', 'VWAP_RECLAIM_CLEAN', 'VOLATILITY_COMPRESSION_SQUEEZE', 'VWAP_BOUNCE_SCALP'],
  expiry_expansion: ['WEEKLY_EXPIRY_DEALER_UNWIND', 'INITIATIVE_MOMENTUM_EXPANSION', 'FAILED_AUCTION_REVERSAL', 'IV_CRUSH_FADE'],
  panic:            ['EXHAUSTION_REVERSAL', 'FAILED_AUCTION_REVERSAL'],
  unknown:          ['GAMMA_PIN_MEAN_REVERSION', 'VWAP_RECLAIM_CLEAN', 'COMPOSITE_PROFILE_EDGE_REJECTION', 'VWAP_BOUNCE_SCALP'],
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

  eligible.sort((a, b) => {
    // Prefer elite > standard
    const rank = { elite: 3, standard: 2, weak: 1 };
    if (rank[b.conviction] !== rank[a.conviction]) {
      return (rank[b.conviction] || 0) - (rank[a.conviction] || 0);
    }
    return (b.score || 0) - (a.score || 0);
  });

  const best = eligible[0] || null;

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
