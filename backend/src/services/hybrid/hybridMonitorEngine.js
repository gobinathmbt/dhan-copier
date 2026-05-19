/**
 * Hybrid Monitor Engine
 * =====================
 * Deterministic, institutional-style monitoring of OPEN trades. AI is not in
 * the path. This engine uses pure rules + the position state machine + the
 * probability decay engine to decide:
 *
 *   EXIT        — close immediately
 *   TRAIL_SL    — move SL up (only up)
 *   HOLD        — keep monitoring
 *   ADD_QUANTITY — only when state == TRAILING and capital mode allows
 *
 * Routes by trade.tradeType:
 *   SCALP rules — short hold (≤ 5 min), tight SL/target, fast structural exit
 *   SWING rules — wider SL/target, structural exit on 3 consecutive 1m closes
 *
 * All decisions land in the session log with `hybrid_monitor_*` event types.
 */

const positionStateMachine    = require('./positionStateMachine');
const probabilityDecayEngine  = require('./probabilityDecayEngine');
const probabilityScoringEngine = require('./probabilityScoringEngine');
const derivativesEngine       = require('./derivativesEngine');
const volumeAnalysisEngine    = require('./volumeAnalysisEngine');
const tickDeltaClassifier     = require('./tickDeltaClassifier');
const oiAnalyticsEngine       = require('./oiAnalyticsEngine');
const utBotEngine             = require('./utBotEngine');
const liquidityEngine         = require('./liquidityEngine');
const volatilityRegimeEngine  = require('./volatilityRegimeEngine');
const marketRegimeEngine      = require('./marketRegimeEngine');
const sessionEngine           = require('./sessionEngine');
const adaptiveExitEngine      = require('./adaptiveExitEngine');
const expectancyEngine        = require('./expectancyEngine');
const hybridLogger            = require('./hybridLogger');
const historicalContext       = require('../historicalContextLoader.service');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const STATES = positionStateMachine.STATES;

function _elapsedSec(trade) {
  const t = new Date(trade.openedAt || trade.createdAt || Date.now()).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function _pnlPts(trade) {
  return Number(((trade.currentPrice || trade.entryPrice) - trade.entryPrice).toFixed(2));
}

function _focusStrikes(strike) {
  const out = [];
  for (let i = -4; i <= 4; i++) out.push(strike + i * 50);
  return out;
}

function _buildPrimaryStrikesBlock(aggregator, focusStrikes) {
  const strikes = aggregator?.payload?.options_chain?.strikes
    || aggregator?.optionChain?.strikes
    || [];
  if (!strikes.length) return [];
  const byStrike = new Map(strikes.map(s => [s.strike, s]));
  return focusStrikes.map(strike => {
    const s = byStrike.get(strike);
    if (!s) return { strike, missing: true };
    return {
      strike,
      ce: { ltp: s.call?.ltp, oi: s.call?.oi, oiChg: s.call?.oiChange,
            iv: s.call?.iv, delta: s.call?.greeks?.delta, theta: s.call?.greeks?.theta },
      pe: { ltp: s.put?.ltp,  oi: s.put?.oi,  oiChg: s.put?.oiChange,
            iv: s.put?.iv,  delta: s.put?.greeks?.delta,  theta: s.put?.greeks?.theta },
    };
  });
}

function _exit(reasoning, source = 'hybrid_rule', urgency = 'immediate') {
  return { action: 'EXIT', new_sl: null, add_lots: null, confidence: 10, reasoning, exit_urgency: urgency, source };
}
function _hold(reasoning, source = 'hybrid_rule') {
  return { action: 'HOLD', new_sl: null, add_lots: null, confidence: 10, reasoning, exit_urgency: 'soft', source };
}
function _trail(newSl, reasoning, source = 'hybrid_rule') {
  return { action: 'TRAIL_SL', new_sl: newSl, add_lots: null, confidence: 9, reasoning, exit_urgency: 'soft', source };
}

// ────────────────────────────────────────────────────────────────────────────
// Pre-rule gates (no expensive computation needed)
// ────────────────────────────────────────────────────────────────────────────

function _scalpGates(trade, settings) {
  const elapsed = _elapsedSec(trade);
  const pnlPts = _pnlPts(trade);
  const targetPts = Number(settings?.targetPoints) || 10;
  const slPts     = Number(settings?.slPoints) || 15;
  const targetPct = (pnlPts / Math.max(1, targetPts)) * 100;
  const slPct     = pnlPts < 0 ? (Math.abs(pnlPts) / Math.max(1, slPts)) * 100 : 0;

  // CALIBRATED 2026-05-19: align live monitor gates with backtest simulator.
  // The backtest only checks: (a) hard SL, (b) hard target, (c) max hold.
  // It does NOT check sl_proximity, sustained_loss, or severe_quick_loss.
  // Live monitor previously had all three extra gates → exited many trades
  // that would have recovered in backtest. We disable sl_proximity (gate 2)
  // and sustained_loss (gate 6) outright, and only retain severe_quick_loss
  // as a true-emergency safety net.

  // 1. Hard SL
  if (trade.sl && trade.currentPrice <= trade.sl) {
    return _exit(`SL hit (${trade.currentPrice} ≤ ${trade.sl}) at ${elapsed}s`, 'hybrid:scalp_sl');
  }
  // 2. SL proximity ≥ 80% — DISABLED 2026-05-19 (not in backtest)
  // if (pnlPts < 0 && slPct >= 80) {
  //   return _exit(`Approaching SL: ${pnlPts.toFixed(2)}pts (${slPct.toFixed(1)}% of ${slPts}pt SL)`, 'hybrid:sl_proximity');
  // }
  // 3. Target hit
  if (targetPct >= 100) {
    return _exit(`Target hit: ${pnlPts.toFixed(2)}pts (${targetPct.toFixed(1)}%)`, 'hybrid:target_hit');
  }

  // 3b. CALIBRATED 2026-05-19: SMART-TRAIL (ultra-scalp lock + peak giveback)
  // When the entry's hybridSnapshot carries a smartTrail config:
  //   - lockTriggerPct: once peak P&L reaches this fraction of target,
  //     remember that level as a "locked floor". Any return below it = exit.
  //   - peakGivebackPct: after lock, exit when current P&L gives back this
  //     fraction of the peak run-up.
  // Hard SL still triggers immediately above; this is a *profit-protection*
  // layer that captures most of the move and avoids round-trips.
  const smartTrail = trade.aiEntryDecision?.hybridSnapshot?.entryType?.playbook?.smartTrail
                  || trade.hybridEntrySnapshot?.entryType?.playbook?.smartTrail
                  || null;
  if (smartTrail && (smartTrail.lockTriggerPct > 0 || smartTrail.peakGivebackPct > 0)) {
    const peakPrice = Number(trade.maxPriceReached) || trade.entryPrice;
    const peakPts   = peakPrice - trade.entryPrice;
    const lockPts   = (smartTrail.lockTriggerPct || 0) * targetPts;
    if (lockPts > 0 && peakPts >= lockPts) {
      const lockedFloor = trade.entryPrice + lockPts;
      if (trade.currentPrice < lockedFloor) {
        return _exit(
          `Smart-lock breach: peak +${peakPts.toFixed(2)}pts crossed lock at +${lockPts.toFixed(2)}pts, ` +
          `now ${pnlPts.toFixed(2)}pts (below floor ${lockedFloor.toFixed(2)})`,
          'hybrid:scalp_smart_lock'
        );
      }
      const giveback = peakPts * (smartTrail.peakGivebackPct || 0);
      if (giveback > 0 && peakPts - pnlPts >= giveback && pnlPts > 0) {
        return _exit(
          `Smart-trail: ${(giveback).toFixed(2)}pts giveback from peak (peak +${peakPts.toFixed(2)}, now +${pnlPts.toFixed(2)})`,
          'hybrid:scalp_smart_trail'
        );
      }
    }
  }

  // 4. Below min hold time — only SL is allowed to exit (already handled above)
  const minHold = 30;
  if (elapsed < minHold) {
    return _hold(`Min hold ${elapsed}s/${minHold}s`, 'hybrid:min_hold');
  }
  // 5. Severe quick loss in 30..60s — KEEP as emergency safety net only.
  //    A -10pt move in <60s is structural, not noise.
  if (elapsed >= 30 && elapsed < 60 && pnlPts <= -10) {
    return _exit(`Severe quick loss ${pnlPts.toFixed(2)}pts at ${elapsed}s`, 'hybrid:scalp_fast_loss');
  }
  // 6. Sustained loss after 60s ≥ 60% of SL — DISABLED 2026-05-19.
  //    This was forcing exits at -3 to -4pts when SL was capped to 6pts,
  //    well before the trade had a fair chance to recover. Backtest holds
  //    until either hard SL or max hold without this gate, and shows 81% WR.
  // if (elapsed >= 60 && slPct >= 60) {
  //   return _exit(`Sustained loss ${pnlPts.toFixed(2)}pts (${slPct.toFixed(1)}% of SL)`, 'hybrid:scalp_sustained_loss');
  // }
  // 7. Max hold time
  // CALIBRATED 2026-05-19: prefer the trade-specific maxHoldSeconds set by
  // the entry engine (sourced from strategy.maxHoldSec / playbook.holdProfile)
  // over the static settings.maxHoldTimeSeconds. Live sessions previously
  // used 300s for every trade because settings was checked FIRST — but the
  // backtest sim respects the engine's per-trade hold (180-240s typically),
  // so live and backtest were exiting at very different times.
  // Falls back to settings.maxHoldTimeSeconds if the trade doesn't carry one.
  const maxHold = Number(trade.maxHoldSeconds)
                || Number(settings?.maxHoldTimeSeconds)
                || 180;
  if (elapsed >= maxHold) {
    return _exit(`Max hold reached ${elapsed}s ≥ ${maxHold}s, P&L ${pnlPts.toFixed(2)}pts`, 'hybrid:scalp_max_hold');
  }

  // 8. CALIBRATED 2026-05-19: no-progress early exit.
  // Today's live trades sat near zero (P&L between -3 and +1) for 60-80%
  // of their life and then leaked into a max-hold timeout loss. If the
  // trade is past 70% of its allocated hold AND the highest unrealized
  // profit ever seen was less than 30% of target AND we're still flat
  // or below, the setup is dead — exit now to save rupees vs the
  // eventual timeout exit. Hard SL still triggers immediately and
  // trailing SL handles the profitable cases, so this only catches the
  // slow-leak losers that the timer would otherwise resolve unfavourably.
  const noProgressDeadline = Math.floor(maxHold * 0.7);
  if (elapsed >= noProgressDeadline) {
    const entry = Number(trade.entryPrice) || 0;
    const peak = Number(trade.maxPriceReached) || entry;
    const peakPnlPts = peak - entry;
    const peakAsTargetPct = (peakPnlPts / Math.max(1, targetPts)) * 100;
    if (peakAsTargetPct < 30 && pnlPts <= 1) {
      return _exit(
        `No-progress exit at ${elapsed}s/${maxHold}s: ` +
        `peak P&L ${peakPnlPts.toFixed(2)}pts (${peakAsTargetPct.toFixed(0)}% of ${targetPts}pt target), ` +
        `current ${pnlPts.toFixed(2)}pts`,
        'hybrid:scalp_no_progress'
      );
    }
  }

  return null;
}

function _swingGates(trade, settings, history) {
  const elapsed = _elapsedSec(trade);
  const pnlPts = _pnlPts(trade);
  const slPts = Number(settings?.slPoints) || 15;

  // W-1 hard SL
  if (trade.sl && trade.currentPrice <= trade.sl) {
    return _exit(`Swing SL hit (${trade.currentPrice} ≤ ${trade.sl})`, 'hybrid:swing_sl');
  }
  // W-2 max hold
  const swingMaxHold = (Number(settings?.swingMaxHoldMinutes) || 15) * 60;
  if (elapsed >= swingMaxHold) {
    return _exit(`Swing max hold ${Math.floor(elapsed/60)}min`, 'hybrid:swing_max_hold');
  }
  // W-3 structural break: 3 consecutive 1m closes against position AND in loss
  const c1 = history?.today?.candles?.['1m'] || [];
  if (c1.length >= 3) {
    const last3 = c1.slice(-3);
    const goingDown = last3.every((c, i, a) => i === 0 || (c.c ?? c.close) < (a[i-1].c ?? a[i-1].close));
    const goingUp   = last3.every((c, i, a) => i === 0 || (c.c ?? c.close) > (a[i-1].c ?? a[i-1].close));
    const isCe = trade.signal === 'BUY_CE';
    if ((isCe && goingDown) || (!isCe && goingUp)) {
      if (pnlPts < 0) {
        return _exit(`3 consecutive 1m closes against ${isCe ? 'CE' : 'PE'}, P&L ${pnlPts.toFixed(1)}pts`, 'hybrid:swing_structural_break');
      }
    }
  }
  return null;
}

function _trailingSl(trade, pnlPts, settings) {
  // Move SL to entry + (pnlPts - lockBackPts) once trade is comfortably in profit.
  const targetPts = Number(settings?.targetPoints) || 10;
  // Phase 1: at +30% of target → SL to entry (breakeven)
  const phase1Trigger = targetPts * 0.30;
  // Phase 2: at +60% of target → SL = entry + 30% of target
  const phase2Trigger = targetPts * 0.60;
  // Phase 3: at +80% → SL = entry + 60% of target
  const phase3Trigger = targetPts * 0.80;

  const cur = trade.currentPrice;
  const entry = trade.entryPrice;
  let proposed = trade.sl || (entry - (Number(settings?.slPoints) || 15));

  if (pnlPts >= phase3Trigger) proposed = Number((entry + targetPts * 0.60).toFixed(2));
  else if (pnlPts >= phase2Trigger) proposed = Number((entry + targetPts * 0.30).toFixed(2));
  else if (pnlPts >= phase1Trigger) proposed = Number(entry.toFixed(2));

  // SL must move up only AND be strictly below current price.
  if (proposed > (trade.sl || 0) && proposed < cur) {
    return proposed;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Public: decide
// ────────────────────────────────────────────────────────────────────────────

async function decide({
  trade,
  aggregator,
  algorithmOutputs,
  masterDecision,
  settings,
  allOpenTrades,
  futuresData,
}) {
  const sessionId = trade?.sessionId;
  const tradeType = trade?.tradeType || 'SCALP';

  // ── 1. Compute lifecycle state ───────────────────────────────────────
  const state = positionStateMachine.computeState(trade, settings || {});
  const allowedActions = positionStateMachine.allowedActions(state);

  hybridLogger.info({
    sessionId, tradeId: trade?._id,
    event: 'monitor_state',
    message: `state=${state} allowed=${allowedActions.join(',')}`,
    data: { state, allowedActions, elapsedSec: _elapsedSec(trade), pnlPts: _pnlPts(trade) },
  });

  // ── 2. Build minimal historical context for structural rules ─────────
  const focus = _focusStrikes(trade.strike);
  let history = { today: null };
  try {
    history = await historicalContext.buildHistoricalContext({
      maxBackfillDays: tradeType === 'SWING' ? 5 : 1,
      focusStrikes: focus,
      includeRawToday: true,
    });
  } catch (_) {}

  // ── 3. Run pre-rule gates (very cheap, no recompute) ─────────────────
  const gateDecision = tradeType === 'SWING'
    ? _swingGates(trade, settings, history)
    : _scalpGates(trade, settings);

  if (gateDecision) {
    // Honour state-machine: if action isn't allowed we downgrade to HOLD.
    if (!allowedActions.includes(gateDecision.action)) {
      const fallback = _hold(`State ${state} disallows ${gateDecision.action} — ${gateDecision.reasoning}`, 'hybrid:state_block');
      hybridLogger.warn({ sessionId, tradeId: trade._id, event: 'monitor_gate_blocked',
        message: fallback.reasoning, data: { state, gateAction: gateDecision.action } });
      return fallback;
    }
    hybridLogger.info({ sessionId, tradeId: trade._id, event: 'monitor_gate',
      message: `${gateDecision.action} — ${gateDecision.reasoning}`, data: gateDecision });
    return gateDecision;
  }

  // ── 4. Build "current snapshot" for decay analysis ───────────────────
  const payload = aggregator?.payload || {};
  const candles1m  = history?.today?.candles?.['1m']  || [];
  const candles5m  = history?.today?.candles?.['5m']  || [];
  const candles15m = history?.today?.candles?.['15m'] || [];
  const spotPrice = payload?.spot_data?.ltp || aggregator?.spotPrice;
  const atmStrike = aggregator?.atmStrike || payload?.actual_atm_strike || Math.round(spotPrice / 50) * 50;
  const primaryStrikes = _buildPrimaryStrikesBlock(aggregator, focus);

  const sessionPhase     = sessionEngine.classifySession();
  const vix              = payload?.market_internals?.vix ?? algorithmOutputs?.globalMarkets?.vix?.value ?? null;
  const volatilityRegime = volatilityRegimeEngine.classify({ candles1m, candles5m, vix });
  const marketRegime     = marketRegimeEngine.classify({
    candles5m, candles15m, volatilityRegime,
    multiTimeframe: algorithmOutputs?.multiTimeframe,
    vwap: payload?.vwap_analysis,
    adx: algorithmOutputs?.professionalScalping?.adx,
  });
  const liquidity        = liquidityEngine.evaluate(algorithmOutputs?.liquidityAnalysis);
  const derivatives      = derivativesEngine.analyze({
    optionChain: aggregator?.optionChain,
    primaryStrikes,
    pcr: payload?.options_chain?.pcr_total ?? payload?.options_chain?.pcr_oi,
    maxPain: payload?.options_chain?.max_pain ?? payload?.options_chain?.max_pain_strike,
    gammaExposure: algorithmOutputs?.gammaExposure,
    futuresData,
    spotPrice,
    atmStrike,
  });
  // Live tick delta — true bid/ask classification for the spot. Used when
  // the sample is large enough; otherwise volumeAnalysisEngine falls back to
  // the wick-weighted candle proxy.
  let liveTickDelta = null;
  try {
    const cls = tickDeltaClassifier.instance;
    if (cls && cls.started) {
      const long  = cls.getDelta('IDX_I', 13, { windowMs: 180_000 });
      const short = cls.getDelta('IDX_I', 13, { windowMs: 60_000 });
      if (long && (long.sampleSize || 0) >= 30) liveTickDelta = { long, short };
    }
  } catch (_) {}
  const volumeAnalysis = volumeAnalysisEngine.analyze({ candles5m, candles15m, spotPrice, liveTickDelta });

  // OI analytics — re-uses the per-session snapshot history maintained by the
  // entry engine. We re-analyze with direction so we get a directional score.
  const oiAnalyticsCur = oiAnalyticsEngine.analyze({
    primaryStrikes, atmStrike, spotPrice,
    sessionId: trade?.sessionId,
    direction: trade.signal === 'BUY_CE' ? 'bullish' : 'bearish',
  });

  // UT Bot read on current TF stack
  const utBotCur = utBotEngine.evaluate(
    algorithmOutputs?.multiTimeframe,
    trade.signal === 'BUY_CE' ? 'bullish' : 'bearish'
  );

  const direction = trade.signal === 'BUY_CE' ? 'bullish' : 'bearish';
  const ctxNow = {
    session: sessionPhase, marketRegime, volatilityRegime, liquidity,
    dataFresh: true,
    killSwitch: false,
    riskBlock: false,
    derivatives,
    vwap: payload?.vwap_analysis,
    volumeOI: payload?.volume_orderflow,
    volumeAnalysis,
    orderFlow: algorithmOutputs?.orderFlow,
    ivPercentile: payload?.options_chain?.iv_percentile,
    vix,
    marketInternals: algorithmOutputs?.marketInternals,
    pcr: payload?.options_chain?.pcr_total ?? payload?.options_chain?.pcr_oi,
    professionalScalping: algorithmOutputs?.professionalScalping,
    multiTimeframe: algorithmOutputs?.multiTimeframe,
  };
  const currentScore = probabilityScoringEngine.score(ctxNow, direction, { minScore: 0 });

  // ── 5. Decay analysis ────────────────────────────────────────────────
  const decay = probabilityDecayEngine.evaluate({
    trade,
    currentScore,
    currentDerivatives: derivatives,
    currentVwap: payload?.vwap_analysis,
    currentVolumeAnalysis: volumeAnalysis,
    currentOiAnalytics: oiAnalyticsCur,
    currentUtBot: utBotCur,
  });
  hybridLogger.info({
    sessionId, tradeId: trade._id, event: 'monitor_decay',
    message: `decay=${decay.decay} ${decay.reasoning}`,
    data: {
      decay: decay.decay,
      reasons: decay.reasons,
      scoreNow: currentScore.score,
      acceptance: volumeAnalysis?.acceptance,
      delta: volumeAnalysis?.delta?.bias,
      deltaPct: volumeAnalysis?.delta?.cvdPctLong,
      deltaSource: volumeAnalysis?.deltaSource,
      zone: volumeAnalysis?.zone?.zone,
      vsa: volumeAnalysis?.vsa?.pattern,
      oiRegime: oiAnalyticsCur?.regime,
      oiCeVel: oiAnalyticsCur?.diff?.ceVelocity,
      oiPeVel: oiAnalyticsCur?.diff?.peVelocity,
      utBot5m: utBotCur?.perTimeframe?.['5m']?.trend,
    },
  });

  if (decay.exit) {
    if (allowedActions.includes('EXIT')) {
      return _exit(`Probability decay ${decay.decay}: ${decay.reasoning}`, 'hybrid:decay_exit');
    }
    return _hold(`Decay detected but state ${state} disallows EXIT`, 'hybrid:decay_held');
  }

  // ── 6. Adaptive exit plan (partial booking, smart trail, delta-failure) ─
  // Only call after min hold time and once trade is in MANAGING/TRAILING state.
  const exitStyle = trade.hybridEntrySnapshot?.entryType?.exitStyle
                 || trade.aiEntryDecision?.hybridSnapshot?.entryType?.exitStyle
                 || 'trail_atr_wide';
  if (state === STATES.MANAGING || state === STATES.TRAILING) {
    const adaptive = adaptiveExitEngine.plan({
      trade,
      currentLtp: trade.currentPrice,
      volumeAnalysis,
      oiAnalytics: oiAnalyticsCur,
      vwap: payload?.vwap_analysis,
      mtfStructure: null,
      atr: volatilityRegime?.atr5m,
      exitStyle,
    });
    if (adaptive.action === 'EXIT' && allowedActions.includes('EXIT')) {
      hybridLogger.info({ sessionId, tradeId: trade._id, event: 'monitor_adaptive_exit',
        message: adaptive.reasoning, data: { exitStyle, adaptive } });
      return _exit(`Adaptive exit: ${adaptive.reasoning}`, 'hybrid:adaptive_exit');
    }
    if (adaptive.action === 'PARTIAL_EXIT') {
      hybridLogger.info({ sessionId, tradeId: trade._id, event: 'monitor_partial_exit',
        message: adaptive.reasoning, data: { exitStyle, adaptive } });
      // We surface PARTIAL_EXIT as TRAIL_SL with the new breakeven SL — the
      // backtester / live engine doesn't yet handle partial books in the row.
      // The intent is captured in the reasoning string for analytics.
      return {
        action: 'TRAIL_SL', new_sl: adaptive.newSl, add_lots: null,
        confidence: 9, reasoning: `Partial exit (40%) + breakeven: ${adaptive.reasoning}`,
        exit_urgency: 'soft', source: 'hybrid:adaptive_partial',
        partialExitPct: adaptive.partialPct,
      };
    }
    if (adaptive.action === 'TRAIL_SL' && allowedActions.includes('TRAIL_SL')
        && Number.isFinite(adaptive.newSl) && adaptive.newSl > (trade.sl || 0)) {
      hybridLogger.info({ sessionId, tradeId: trade._id, event: 'monitor_adaptive_trail',
        message: adaptive.reasoning, data: { exitStyle, adaptive } });
      return _trail(adaptive.newSl, `Adaptive trail (${exitStyle}): ${adaptive.reasoning}`, 'hybrid:adaptive_trail');
    }
  }

  // ── 7. Trailing SL when in trailing state (fallback to phased trail) ─
  const pnlPts = _pnlPts(trade);
  if (state === STATES.TRAILING && allowedActions.includes('TRAIL_SL')) {
    const newSl = _trailingSl(trade, pnlPts, settings);
    if (newSl != null) {
      hybridLogger.info({ sessionId, tradeId: trade._id, event: 'monitor_trail',
        message: `trail SL → ${newSl}`, data: { newSl, pnlPts } });
      return _trail(newSl, `Trailing SL to ${newSl} (P&L ${pnlPts.toFixed(2)}pts)`, 'hybrid:trail');
    }
  }

  // ── 7. Default — HOLD ────────────────────────────────────────────────
  hybridLogger.info({ sessionId, tradeId: trade._id, event: 'monitor_hold',
    message: `state=${state} score=${currentScore.score} decay=${decay.decay}`,
    data: { state, score: currentScore.score, decay: decay.decay, pnlPts } });
  return _hold(`state=${state} score=${currentScore.score} decay=${decay.decay}`, 'hybrid:hold');
}

module.exports = { decide };
