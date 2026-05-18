/**
 * Entry Type Engine
 * =================
 * Classifies the *kind* of setup we're looking at, validates it, and
 * returns the recommended trade-management profile for that setup.
 *
 * Six institutional entry types:
 *
 *   A. MOMENTUM_CONTINUATION
 *        trend aligned + negative gamma + delta expanding + price outside VA
 *        + OI building. Hold longer, wider trail.
 *
 *   B. REVERSAL
 *        liquidity sweep + absorption + delta divergence + reclaim. Tight SL,
 *        target = mid VA / POC.
 *
 *   C. MEAN_REVERSION
 *        positive gamma + inside value + weak delta + failed breakout. Small
 *        target, very tight SL.
 *
 *   D. BREAKOUT_EXPANSION
 *        volatility expansion + LVN breakout + initiative + futures lead.
 *        Aggressive RR, quick exit if no follow-through.
 *
 *   E. PULLBACK
 *        AVWAP/VWAP reclaim + delta support + shallow retracement against
 *        a confirmed trend.
 *
 *   F. EXHAUSTION_FADE
 *        climactic volume + delta divergence + parabolic move. Counter-trend
 *        scalp only.
 *
 * Each entry type returns:
 *   { type, valid, score, holdProfile, exitStyle, reasoning }
 *
 * The orchestrator picks the highest-scoring valid type and uses its
 * holdProfile to override the default strategy parameters.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

// ── Per-type evaluators ──────────────────────────────────────────────────
function _momentumContinuation(ctx) {
  const reasons = [];
  let score = 0, valid = true;
  // Trend alignment — full MTF required
  if (ctx.mtfStructure?.alignment !== 'full') { valid = false; reasons.push('not full MTF alignment'); }
  else { score += 20; reasons.push('full MTF alignment'); }
  // CALIBRATED 2026-05-18 cycle 2: momentum still bleeding (37.5% WR with
  // 5 losses -₹16k). Add stricter preconditions:
  //   - Volatility must be expansion or normal (not dead)
  //   - Gamma must be negative OR explicit short_covering / long_liquidation
  //     OI regime (institutions actually pushing the move)
  //   - Delta must be rising/falling in direction (not just absolute)
  //   - Orderflow MUST be initiative_buying / initiative_selling — otherwise
  //     the institutional push isn't there yet
  //   - Block midday_chop session (most losses here)
  if (ctx.volatilityRegime?.state === 'dead') {
    valid = false; reasons.push('dead volatility');
  }
  if (ctx.sessionPhase?.phase === 'midday_chop') {
    valid = false; reasons.push('midday_chop session');
  }
  const gammaOK = ctx.gammaRegime?.regime === 'negative';
  const oiPush = (ctx.direction === 'bullish' && ctx.oiAnalytics?.regime === 'violent_short_covering')
              || (ctx.direction === 'bearish' && ctx.oiAnalytics?.regime === 'long_unwinding_collapse');
  if (!gammaOK && !oiPush) {
    valid = false; reasons.push('need negative gamma OR positioning push');
  } else if (gammaOK) {
    score += 18; reasons.push('negative gamma');
  } else {
    score += 18; reasons.push(`OI ${ctx.oiAnalytics.regime}`);
  }
  // Orderflow MUST be initiative (not neutral)
  const ofOK = (ctx.direction === 'bullish' && ctx.orderflowState?.state === 'initiative_buying')
            || (ctx.direction === 'bearish' && ctx.orderflowState?.state === 'initiative_selling');
  if (!ofOK) { valid = false; reasons.push(`orderflow ${ctx.orderflowState?.state} not initiative`); }
  else { score += 12; reasons.push(`orderflow ${ctx.orderflowState.state}`); }
  // Delta expanding in direction (must be RISING/FALLING, not just absolute)
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  if (ctx.direction === 'bullish' && deltaPct >= 15 && deltaTrend === 'rising') {
    score += 18; reasons.push(`delta rising +${deltaPct}%`);
  } else if (ctx.direction === 'bearish' && deltaPct <= -15 && deltaTrend === 'falling') {
    score += 18; reasons.push(`delta falling ${deltaPct}%`);
  } else {
    valid = false; reasons.push(`delta weak/flat (${deltaPct}%, trend ${deltaTrend})`);
  }
  // Price outside value
  const acc = ctx.volumeAnalysis?.acceptance;
  if ((ctx.direction === 'bullish' && acc === 'above_va') ||
      (ctx.direction === 'bearish' && acc === 'below_va')) { score += 12; reasons.push(`price ${acc}`); }
  // OI building (additional confirm beyond gamma/positioning gate)
  if (ctx.oiAnalytics?.regime?.startsWith('aggressive_')) { score += 10; reasons.push(ctx.oiAnalytics.regime); }
  // Auction state
  if (ctx.auctionState?.tradingImplication === 'momentum_continuation') { score += 10; reasons.push('auction momentum'); }

  return {
    type: 'MOMENTUM_CONTINUATION',
    valid, score: Math.max(0, score),
    holdProfile: { tradeType: 'SWING', maxHoldSec: 600, rrTarget: 2.5 },
    exitStyle: 'trail_atr_wide',
    reasoning: reasons.join(' | '),
  };
}

function _reversal(ctx) {
  const reasons = [];
  let score = 0, valid = true;
  // Need auction state = reversal_setup OR exhaustion in orderflow state
  const auctionOk = ctx.auctionState?.tradingImplication === 'reversal_setup';
  const orderflowOk = ctx.orderflowState?.state === 'exhaustion'
                   || ctx.orderflowState?.state === 'absorption';
  if (!auctionOk && !orderflowOk) { valid = false; reasons.push('no reversal context'); }
  else { score += 25; reasons.push(auctionOk ? 'auction reversal' : `orderflow ${ctx.orderflowState.state}`); }
  // Delta divergence
  if (ctx.volumeAnalysis?.delta?.divergence !== 'none' &&
      ctx.volumeAnalysis?.delta?.divergenceBias === ctx.direction) {
    score += 20; reasons.push('delta divergence supports');
  }
  // VWAP reclaim
  const vwapPos = ctx.vwap?.position;
  if (vwapPos && ctx.direction === 'bullish' && vwapPos === 'above') { score += 12; reasons.push('above VWAP'); }
  if (vwapPos && ctx.direction === 'bearish' && vwapPos === 'below') { score += 12; reasons.push('below VWAP'); }
  // CHOCH on 5m
  if ((ctx.direction === 'bullish' && ctx.mtfStructure?.choch5 === 'bullish_choch') ||
      (ctx.direction === 'bearish' && ctx.mtfStructure?.choch5 === 'bearish_choch')) {
    score += 18; reasons.push(`5m ${ctx.mtfStructure.choch5}`);
  }
  // OI shift consistent
  if (ctx.direction === 'bullish' && ctx.oiAnalytics?.diff?.peVelocity > 100) { score += 10; reasons.push('PE writing'); }
  if (ctx.direction === 'bearish' && ctx.oiAnalytics?.diff?.ceVelocity > 100) { score += 10; reasons.push('CE writing'); }

  return {
    type: 'REVERSAL',
    valid, score: Math.max(0, score),
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 300, rrTarget: 1.5 },
    exitStyle: 'tight_sl_target_va',
    reasoning: reasons.join(' | '),
  };
}

function _meanReversion(ctx) {
  const reasons = [];
  let score = 0, valid = true;
  // CALIBRATED 2026-05-19 cycle 37: legacy MEAN_REVERSION fallback has
  // historically pulled WR down. The institutional playbooks
  // (GAMMA_PIN_MEAN_REVERSION + PIN_REVERSION + VALUE_AREA_ROTATION +
  // COMPOSITE_PROFILE_EDGE_REJECTION) are strictly better. Force-invalid
  // so it can never be chosen as the legacy fallback.
  return {
    type: 'MEAN_REVERSION',
    valid: false,
    score: 0,
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 200, rrTarget: 1.0 },
    exitStyle: 'fixed_target_tight_sl',
    reasoning: 'DISABLED cycle 37 — legacy fallback. Use playbook variants.',
  };
  // eslint-disable-next-line no-unreachable
  // Positive gamma essential
  if (ctx.gammaRegime?.regime !== 'positive') { valid = false; reasons.push('not positive gamma'); }
  else { score += 25; reasons.push('positive gamma'); }
  // CALIBRATED 2026-05-18 cycle 7-8: 13 losses on MEAN_REVERSION, 11 TIMEOUTs.
  // Pattern: gamma_pin meta but regime is trending — pin already starting
  // to break. Require spot to be reasonably close to gamma pinning level
  // (<30pts). 20pts was too tight (cut wins).
  const spotVsPin = Math.abs(_safe(ctx.gammaRegime?.spotVsPin));
  if (spotVsPin > 30) {
    valid = false; reasons.push(`spotVsPin ${spotVsPin}pts > 30 (pin breaking)`);
  } else if (spotVsPin > 0 && spotVsPin <= 15) {
    score += 8; reasons.push(`tight pin ${spotVsPin}pts`);
  }
  // CALIBRATED cycle 14: 3 losses in `choppy` regime + gamma_pin. Fade
  // setups in choppy regime are particularly fragile because there's no
  // anchor. Require expansion volatility OR clear absorption to enter.
  if (ctx.marketRegime?.regime === 'choppy') {
    const hasAbsorption = ctx.volumeAnalysis?.vsa?.pattern === 'absorption'
                        && ctx.volumeAnalysis.vsa.bias === ctx.direction;
    const isExpansion = ctx.volatilityRegime?.state === 'expansion';
    if (!hasAbsorption && !isExpansion) {
      valid = false; reasons.push('choppy regime needs absorption or expansion');
    }
  }
  // Block on Friday afternoons (theta + position-square risk)
  if (ctx.sessionPhase?.weekday === 'Fri' && ctx.sessionPhase?.hhmm >= 1300) {
    valid = false; reasons.push('Fri afternoon — position square risk');
  }
  // Inside value area
  if (ctx.volumeAnalysis?.acceptance === 'inside_va') { score += 15; reasons.push('inside VA'); }
  // Weak delta (we're fading)
  const deltaPct = Math.abs(_safe(ctx.volumeAnalysis?.delta?.cvdPctLong));
  if (deltaPct < 15) { score += 10; reasons.push(`weak delta ${deltaPct}%`); }
  // CALIBRATED 2026-05-18 cycle 4: relaxed VA-edge requirement (was too
  // strict, killed entries from 50 → 0). Now: prefer (not require) edge
  // position. Mid-range setups still allowed but score lower.
  const va = ctx.volumeAnalysis?.frvp;
  if (va?.vaHigh && va?.vaLow && Number.isFinite(ctx.spotPrice)) {
    const range = va.vaHigh - va.vaLow;
    if (range > 0) {
      const posInRange = (ctx.spotPrice - va.vaLow) / range;
      if (ctx.direction === 'bullish' && posInRange < 0.40) {
        score += 12; reasons.push(`near VAL (${(posInRange*100).toFixed(0)}%)`);
      } else if (ctx.direction === 'bearish' && posInRange > 0.60) {
        score += 12; reasons.push(`near VAH (${(posInRange*100).toFixed(0)}%)`);
      } else if (Math.abs(posInRange - 0.5) < 0.10) {
        score -= 8; reasons.push('mid-VA fade — risky');
      }
    }
  }
  // Failed breakout history (session memory)
  if (ctx.sessionMemory?.failedBreakouts > 0 || ctx.sessionMemory?.failedBreakdowns > 0) {
    score += 10; reasons.push(`prior failures (${ctx.sessionMemory.failedBreakouts}/${ctx.sessionMemory.failedBreakdowns})`);
  }
  // VSA absorption
  if (ctx.volumeAnalysis?.vsa?.pattern === 'absorption' && ctx.volumeAnalysis.vsa.bias === ctx.direction) {
    score += 15; reasons.push('VSA absorption');
  }
  // Auction
  if (ctx.auctionState?.tradingImplication === 'mean_reversion') { score += 10; reasons.push('auction mean_reversion'); }

  return {
    type: 'MEAN_REVERSION',
    valid, score: Math.max(0, score),
    // Hold 200s — pin moves resolve fast but a few seconds of patience helps
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 200, rrTarget: 1.0 },
    exitStyle: 'fixed_target_tight_sl',
    reasoning: reasons.join(' | '),
  };
}

function _breakoutExpansion(ctx) {
  const reasons = [];
  let score = 0, valid = true;
  // Need volatility expansion regime
  if (ctx.volatilityRegime?.state !== 'expansion') { valid = false; reasons.push('not in expansion regime'); }
  else { score += 20; reasons.push('volatility expansion'); }
  // CALIBRATED 2026-05-18 cycle 3: 2 losses, both in expiry afternoon with
  // late-stage moves. Block expiry afternoons + require initiative orderflow
  // (not just orderflow_state.state being neutral).
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1300) {
    valid = false; reasons.push('expiry afternoon — late-stage');
  }
  // LVN breakout (price moving into low-volume zone)
  const lvns = ctx.volumeAnalysis?.frvp?.lvn || [];
  const spot = ctx.spotPrice;
  if (spot && lvns.some(l => Math.abs(l.price - spot) < 15)) { score += 15; reasons.push('near LVN'); }
  // Initiative — REQUIRED (not optional)
  const ofOK = (ctx.orderflowState?.state === 'initiative_buying' && ctx.direction === 'bullish')
            || (ctx.orderflowState?.state === 'initiative_selling' && ctx.direction === 'bearish');
  if (!ofOK) { valid = false; reasons.push(`orderflow ${ctx.orderflowState?.state} not initiative`); }
  else { score += 18; reasons.push(`orderflow ${ctx.orderflowState.state}`); }
  // Futures lead
  const futDir = ctx.futuresData?.direction;
  if (futDir === ctx.direction) { score += 10; reasons.push('futures aligned'); }

  return {
    type: 'BREAKOUT_EXPANSION',
    valid, score: Math.max(0, score),
    holdProfile: { tradeType: 'SWING', maxHoldSec: 480, rrTarget: 2.0 },
    exitStyle: 'fast_exit_if_stalls',
    reasoning: reasons.join(' | '),
  };
}

function _pullback(ctx) {
  const reasons = [];
  let score = 0, valid = true;
  // Trend phase = markup or markdown only
  const phase = ctx.trendPhase?.phase;
  if (phase !== 'markup' && phase !== 'markdown') { valid = false; reasons.push(`phase ${phase}`); }
  else if ((phase === 'markup' && ctx.direction === 'bullish') ||
           (phase === 'markdown' && ctx.direction === 'bearish')) {
    score += 25; reasons.push(`with-trend ${phase}`);
  } else { valid = false; reasons.push('counter-trend pullback'); }
  // CALIBRATED 2026-05-18 cycle 3: legacy _pullback degraded from 85% to
  // 54% WR after admitting more entries. Add stricter preconditions:
  //   - Block midday_chop (fragile pullbacks fail in chop)
  //   - Block expiry afternoons (theta brutal)
  //   - Require delta to be RECOVERING (rising/falling), not just present
  //   - Trend phase strength ≥ 60
  if (ctx.sessionPhase?.phase === 'midday_chop') {
    valid = false; reasons.push('midday_chop session');
  }
  if (ctx.sessionPhase?.isExpiryDay && ctx.sessionPhase?.hhmm >= 1300) {
    valid = false; reasons.push('expiry afternoon');
  }
  if (_safe(ctx.trendPhase?.strength) < 60) {
    valid = false; reasons.push(`trend strength ${ctx.trendPhase?.strength} < 60`);
  }
  // VWAP reclaim
  const vwapPos = ctx.vwap?.position;
  if ((ctx.direction === 'bullish' && vwapPos === 'above') ||
      (ctx.direction === 'bearish' && vwapPos === 'below')) { score += 12; reasons.push('VWAP supportive'); }
  else { valid = false; reasons.push('VWAP wrong side'); }
  // Delta RECOVERING in direction
  const deltaPct = _safe(ctx.volumeAnalysis?.delta?.cvdPctLong);
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  const deltaOK = (ctx.direction === 'bullish' && deltaPct > 5 && deltaTrend === 'rising')
              || (ctx.direction === 'bearish' && deltaPct < -5 && deltaTrend === 'falling');
  if (!deltaOK) { valid = false; reasons.push(`delta not recovering (${deltaPct}%, ${deltaTrend})`); }
  else { score += 10; reasons.push(`delta ${deltaTrend} ${deltaPct}%`); }
  // Shallow retrace — price not far from VWAP / POC
  const distPct = Math.abs(_safe(ctx.vwap?.distance_pct));
  if (distPct < 0.5) { score += 8; reasons.push(`near VWAP (${distPct.toFixed(2)}%)`); }

  return {
    type: 'PULLBACK',
    valid, score: Math.max(0, score),
    holdProfile: { tradeType: 'SWING', maxHoldSec: 480, rrTarget: 2.0 },
    exitStyle: 'trail_swing',
    reasoning: reasons.join(' | '),
  };
}

function _exhaustionFade(ctx) {
  const reasons = [];
  let score = 0, valid = true;
  // Climactic volume + divergence
  if (ctx.volumeAnalysis?.timeVolume?.state !== 'climax') { valid = false; reasons.push('no climax'); }
  else { score += 25; reasons.push('climactic volume'); }
  // Divergence in opposite direction
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  if (div !== 'none' && divBias === ctx.direction) { score += 20; reasons.push(`div ${div}`); }
  else if (div === 'none') { valid = false; reasons.push('no divergence'); }
  // Orderflow exhaustion
  if (ctx.orderflowState?.state === 'exhaustion') { score += 15; reasons.push('orderflow exhaustion'); }

  return {
    type: 'EXHAUSTION_FADE',
    valid, score: Math.max(0, score),
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 180, rrTarget: 1.2 },
    exitStyle: 'fast_scalp_target_poc',
    reasoning: reasons.join(' | '),
  };
}

// G. VWAP RECLAIM — institutional setup, requires actual reclaim event
//    A real reclaim is: price WAS below VWAP (recently) → CROSSED above →
//    HELD above for 2-3 candles → delta IMPROVED. Not just "above VWAP".
function _vwapReclaim(ctx) {
  const reasons = [];
  let score = 0, valid = true;

  const vwap = ctx.vwap;
  const vwapPos = vwap?.position;
  const vwapVal = Number(vwap?.vwap);
  const dist = Math.abs(Number(vwap?.distance_pct) || 0);

  if (!vwapVal || !vwapPos || vwapPos === 'unknown') { valid = false; reasons.push('no VWAP'); }

  // Need recent candles to detect reclaim event
  const c1m = ctx.candles1m || [];
  const recent = c1m.slice(-12);                       // last ~12 minutes
  if (recent.length < 6) { valid = false; reasons.push('insufficient candles'); }

  if (valid) {
    // Detect a reclaim event in last 12 bars:
    //   bullish reclaim: at least one bar had close < vwap, and last 2-3 bars closed > vwap
    //   bearish reclaim (rejection): mirror
    const closes = recent.map(c => c.c);
    const wasBelow = closes.some(c => c < vwapVal);
    const wasAbove = closes.some(c => c > vwapVal);
    const last3   = closes.slice(-3);
    const last3AllAbove = last3.every(c => c > vwapVal);
    const last3AllBelow = last3.every(c => c < vwapVal);

    if (ctx.direction === 'bullish') {
      if (wasBelow && last3AllAbove && dist < 0.4) {
        score += 30; reasons.push('crossed up + held 3 bars above VWAP');
      } else if (wasBelow && last3AllAbove) {
        score += 18; reasons.push('reclaim but extended');
      } else if (vwapPos === 'above' && dist < 0.2) {
        score += 8; reasons.push('above VWAP but no reclaim event');
      } else {
        valid = false; reasons.push('no bullish reclaim pattern');
      }
    } else if (ctx.direction === 'bearish') {
      if (wasAbove && last3AllBelow && dist < 0.4) {
        score += 30; reasons.push('rejected from VWAP + held 3 bars below');
      } else if (wasAbove && last3AllBelow) {
        score += 18; reasons.push('rejection but extended');
      } else if (vwapPos === 'below' && dist < 0.2) {
        score += 8; reasons.push('below VWAP but no rejection event');
      } else {
        valid = false; reasons.push('no bearish rejection pattern');
      }
    }
  }

  // Delta must IMPROVE in our direction (not just any positive)
  const deltaPct = Number(ctx.volumeAnalysis?.delta?.cvdPctLong) || 0;
  const deltaTrend = ctx.volumeAnalysis?.delta?.trend;
  if (ctx.direction === 'bullish' && deltaPct > 5 && deltaTrend === 'rising') {
    score += 14; reasons.push(`delta rising +${deltaPct}%`);
  } else if (ctx.direction === 'bearish' && deltaPct < -5 && deltaTrend === 'falling') {
    score += 14; reasons.push(`delta falling ${deltaPct}%`);
  } else if ((ctx.direction === 'bullish' && deltaPct < -5) ||
             (ctx.direction === 'bearish' && deltaPct > 5)) {
    valid = false; reasons.push('delta against reclaim');
  }

  // OI confirms (PE writing for bullish, CE writing for bearish)
  const oiRegime = ctx.oiAnalytics?.regime;
  if (ctx.direction === 'bullish' &&
      (oiRegime === 'aggressive_long_buildup' || oiRegime === 'violent_short_covering')) {
    score += 10; reasons.push(`OI ${oiRegime}`);
  }
  if (ctx.direction === 'bearish' &&
      (oiRegime === 'aggressive_short_buildup' || oiRegime === 'long_unwinding_collapse')) {
    score += 10; reasons.push(`OI ${oiRegime}`);
  }

  // Time-volume must NOT be dry-up
  if (ctx.volumeAnalysis?.timeVolume?.state === 'dry_up') {
    score -= 10; reasons.push('volume dry-up');
  }

  // VSA absorption near VWAP is the ideal reclaim confirmation
  if (ctx.volumeAnalysis?.vsa?.pattern === 'absorption' &&
      ctx.volumeAnalysis.vsa.bias === ctx.direction) {
    score += 8; reasons.push('VSA absorption at VWAP');
  }

  return {
    type: 'VWAP_RECLAIM',
    valid: valid && score >= 30,
    score: Math.max(0, score),
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 240, rrTarget: 1.5 },
    exitStyle: 'tight_sl_target_va',
    reasoning: reasons.join(' | '),
  };
}

// H. OPENING TRAP REVERSAL — 09:15-09:45 special
//    Gap move that fails: opening drive against direction, then reverses.
//    Detection: opening drive direction recorded in session memory + delta
//    divergence + price re-entering prior range.
function _openingTrapReversal(ctx) {
  const reasons = [];
  let score = 0, valid = true;
  const phase = ctx.sessionPhase?.phase;
  const hhmm  = ctx.sessionPhase?.hhmm;
  if (phase !== 'opening_drive' && !(hhmm >= 945 && hhmm < 1015)) {
    valid = false; reasons.push(`not opening window (phase=${phase}, ${hhmm})`);
  } else { score += 15; reasons.push(`opening window ${phase}`); }

  // Opening drive direction was OPPOSITE to candidate direction
  const drive = ctx.sessionMemory?.openingDriveDir;
  if (drive && ((ctx.direction === 'bullish' && drive === 'down') ||
                (ctx.direction === 'bearish' && drive === 'up'))) {
    score += 20; reasons.push(`opening drive ${drive} — fade setup`);
  }

  // Price back inside prior day range
  const pdh = ctx.multiDayContext?.priorDay?.high;
  const pdl = ctx.multiDayContext?.priorDay?.low;
  if (Number.isFinite(pdh) && Number.isFinite(pdl) &&
      ctx.spotPrice >= pdl && ctx.spotPrice <= pdh) {
    score += 15; reasons.push('back inside prior day range');
  }

  // Delta divergence in trade direction
  const div = ctx.volumeAnalysis?.delta?.divergence;
  const divBias = ctx.volumeAnalysis?.delta?.divergenceBias;
  if (div !== 'none' && divBias === ctx.direction) { score += 18; reasons.push(`${div} supports`); }

  // 5m CHOCH
  if ((ctx.direction === 'bullish' && ctx.mtfStructure?.choch5 === 'bullish_choch') ||
      (ctx.direction === 'bearish' && ctx.mtfStructure?.choch5 === 'bearish_choch')) {
    score += 12; reasons.push(`5m ${ctx.mtfStructure.choch5}`);
  }

  if (score < 30) valid = false;

  return {
    type: 'OPENING_TRAP_REVERSAL',
    valid, score: Math.max(0, score),
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 300, rrTarget: 1.5 },
    exitStyle: 'tight_sl_target_va',
    reasoning: reasons.join(' | '),
  };
}

/**
 * Run all evaluators and return the highest-scoring valid type, plus the full
 * scorecard for diagnostics.
 *
 * @param {Object} ctx - rich context bundle from the entry orchestrator
 *   ctx.metaRegime - optional, used to pre-filter blocked families before
 *                    picking the best entry type. This matches the meta-regime
 *                    family hard-block applied later in the pipeline so the
 *                    selected entry type is always one we can actually take.
 */
function evaluate(ctx = {}) {
  const evals = [
    _momentumContinuation(ctx),
    _reversal(ctx),
    _meanReversion(ctx),
    _breakoutExpansion(ctx),
    _pullback(ctx),
    _exhaustionFade(ctx),
    _vwapReclaim(ctx),                 // calibrated: VWAP reclaim setup
    _openingTrapReversal(ctx),         // calibrated: opening drive fade
  ];

  // Map entry type → family (mirrors metaRegimeEngine.familyOf)
  const TYPE_TO_FAMILY = {
    // Legacy entry-type evaluator outputs
    MOMENTUM_CONTINUATION:  'momentum_continuation',
    REVERSAL:               'reversal',
    MEAN_REVERSION:         'mean_reversion',
    BREAKOUT_EXPANSION:     'breakout_expansion',
    PULLBACK:               'pullback',
    EXHAUSTION_FADE:        'exhaustion_fade',
    VWAP_RECLAIM:           'vwap_reclaim',
    OPENING_TRAP_REVERSAL:  'reversal',
    // Playbook outputs (for completeness if they reach this layer)
    INITIATIVE_MOMENTUM_EXPANSION: 'momentum_continuation',
    FAILED_AUCTION_REVERSAL:       'reversal',
    GAMMA_PIN_MEAN_REVERSION:      'mean_reversion',
    OPENING_DRIVE_CONTINUATION:    'momentum_continuation',
    SHORT_COVERING_SQUEEZE:        'momentum_continuation',
    LONG_LIQUIDATION_CASCADE:      'momentum_continuation',
    VWAP_RECLAIM_CLEAN:            'vwap_reclaim',
    HVN_REJECTION_ROTATION:        'mean_reversion',
    EXHAUSTION_REVERSAL:           'exhaustion_fade',
    PULLBACK_CONTINUATION:         'pullback',
    WEEKLY_EXPIRY_DEALER_UNWIND:   'breakout_expansion',
    COMPOSITE_PROFILE_EDGE_REJECTION: 'mean_reversion',
    VOLATILITY_COMPRESSION_SQUEEZE: 'breakout_expansion',
    IV_CRUSH_FADE:                 'mean_reversion',
    VWAP_BOUNCE_SCALP:             'vwap_reclaim',
    TREND_VWAP_FOLLOW:             'pullback',
    COUNTER_TREND_REVERSAL:        'reversal',
    DELTA_DRIVE_SCALP:             'momentum_continuation',
    // Phase 1 rotational (cycle 28)
    VALUE_AREA_ROTATION:           'mean_reversion',
    PIN_REVERSION:                 'mean_reversion',
    SWEEP_RECLAIM_SCALP:           'reversal',
    LVN_REJECTION_SCALP:           'mean_reversion',
    VWAP_OSCILLATION_SCALP:        'mean_reversion',
    OPENING_DRIVE_FAILURE:         'reversal',
    MICRO_DELTA_FLIP:              'momentum_continuation',
    OI_MIGRATION_TREND:            'momentum_continuation',
    // Phase 5 institutional spec 2026-05-18
    DELTA_VELOCITY_BREAKOUT:       'momentum_continuation',
    PDH_PDL_SWEEP_REVERSAL:        'reversal',
    DOUBLE_DISTRIBUTION_TREND:     'breakout_expansion',
    ABSORPTION_REVERSAL:           'reversal',
    OVERNIGHT_OI_SHIFT_FOLLOW:     'momentum_continuation',
  };

  // Pre-filter: drop any setup whose family is blocked under the current
  // meta-regime. This keeps us from picking BREAKOUT_EXPANSION while in
  // gamma_pin and then having the orchestrator bounce the trade.
  const blocked = new Set(ctx.metaRegime?.blockedFamilies || []);
  const filtered = evals.filter(e => {
    if (!e.valid) return false;
    const fam = TYPE_TO_FAMILY[e.type];
    return !fam || !blocked.has(fam);
  });

  filtered.sort((a, b) => b.score - a.score);
  const best = filtered[0] || null;

  return {
    bestType: best ? best.type : null,
    bestProfile: best ? best.holdProfile : null,
    bestExitStyle: best ? best.exitStyle : null,
    bestScore: best ? best.score : 0,
    bestReasoning: best ? best.reasoning : 'no valid entry type',
    allEvaluations: evals,
    blockedFamilies: Array.from(blocked),
  };
}

module.exports = { evaluate };
