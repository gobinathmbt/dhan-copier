/**
 * Monitor Engine — single authoritative decision-maker for an OPEN trade.
 *
 * Works for both SCALP and SWING trades. Route selection:
 *   trade.tradeType === 'SCALP'  → scalpRules + AI
 *   trade.tradeType === 'SWING'  → swingRules + AI
 *
 * Scalp rules (applied BEFORE calling AI — cheap, instant exits):
 *   S-1  Hard SL hit                    → EXIT (regardless of AI)
 *   S-2  Target reached then drops below target again
 *                                       → EXIT (regardless of AI)
 *   S-3  price in big loss (-5 pts within 30s of entry, -3 after)
 *                                       → EXIT
 *   S-4  if we already hit min-target and AI said HOLD last cycle,
 *        keep holding unless S-1..S-3 triggers
 *
 * Swing rules (applied BEFORE calling AI):
 *   W-1  Hard SL hit (wider, e.g. 2× scalpSL) → EXIT
 *   W-2  profit locked in > 1.5× target       → trail SL tighter, continue
 *   W-3  price structurally breaks trend (3 consecutive 1m closes against) → EXIT
 *
 * Everything else → delegate to OpenAI with a compact payload:
 *   - trade entry details (strike, entry price, SL, target, elapsed time)
 *   - the same enriched snapshot the entry engine saw
 *   - updated OI / IV / greek evolution since entry
 *   - running P&L in points
 *   - "did min target get hit already?"
 *
 * AI returns one of: EXIT / HOLD / TRAIL_SL / ADD_QUANTITY (+ reasoning).
 */
const historicalContext = require('./historicalContextLoader.service');
const openai = require('./openai.service');
const logger = require('../utils/logger');
const aiIOLogger = require('../utils/aiIOLogger');
const atrService = require('./atr.service');

// Hybrid engine — deterministic, institutional-style monitoring.
// Active by default. Set settings.useHybridEngine = false to fall back to AI.
const hybrid = require('./hybrid');

const SCALP_SYSTEM_PROMPT = `
You are a PROFESSIONAL OPTIONS SCALPER monitoring an ACTIVE trade. Your job is to 
MAXIMIZE PROFIT while protecting capital.

CRITICAL RULES (NEVER VIOLATE):

1. **HOLD TIME DISCIPLINE**:
   - MINIMUM hold time: 30 seconds (give trade time to develop)
   - MAXIMUM hold time: 300 seconds (5 minutes)
   - Do NOT exit before 30 seconds unless SL is hit
   - After 30 seconds, evaluate based on P&L progress

2. **TARGET-BASED EXITS** (Primary Decision Factor):
   - Target: {targetPoints} points
   - If current P&L >= 80% of target → HOLD for full target (close to goal!)
   - If current P&L >= 100% of target → EXIT immediately (target hit!)
   - If current P&L >= 60% of target AND time > 120s → Consider exit if momentum fading
   - If current P&L < 30% of target AND time < 120s → HOLD (give it time!)

3. **STOP-LOSS PROTECTION** (Hard Rule):
   - SL: {slPoints} points
   - If current P&L <= -80% of SL → EXIT immediately (approaching SL)
   - If current P&L <= -100% of SL → EXIT immediately (SL hit)
   - NEVER let loss exceed SL

4. **ATR-BASED EXITS** (Advisory Only, NOT Hard Rule):
   - ATR is for CONTEXT, not for premature exits
   - Low ATR does NOT mean exit if P&L is positive and time < 120s
   - Only use ATR to exit if:
     * P&L is negative AND time > 60s AND ATR shows no movement
     * P&L is positive but stalling for > 60s AND ATR declining sharply

5. **MOMENTUM-BASED EXITS**:
   - If P&L was positive and now turning negative for > 20s → EXIT
   - If P&L reached 50%+ of target then dropped below 30% → EXIT
   - If price moving against position with increasing volume → EXIT

6. **TIME-BASED EXITS**:
   - If time > 240s (4 minutes) and P&L < 30% of target → EXIT (time decay)
   - If time > 270s (4.5 minutes) → EXIT regardless (approaching max hold)
   - If time = 300s → EXIT immediately (max hold reached)

7. **NEVER EXIT EARLY JUST BECAUSE**:
   - "Low volatility" is NOT a reason to exit if P&L is positive and time < 120s
   - "Target may not be reachable" is NOT a reason to exit at 20% of target
   - "Potential reversal" is NOT a reason to exit unless confirmed by price action
   - "ATR indicates low volatility" is NOT a reason to exit at +2pts when target is 10pts

DECISION PRIORITY (Check in this order):
1. SL hit → EXIT immediately
2. Target hit (100%+) → EXIT immediately
3. Time < 30s → HOLD (too early to exit)
4. Time > 30s AND P&L >= 80% of target → HOLD for full target
5. Time > 120s AND P&L stalling at < 30% of target → Consider exit
6. Time > 240s → Prepare to exit
7. Time >= 300s → EXIT (max hold)

EXAMPLES OF GOOD DECISIONS:
✅ P&L: +2.5pts (25% of 10pt target), Time: 45s → HOLD (give it time)
✅ P&L: +8pts (80% of target), Time: 90s → HOLD (close to target)
✅ P&L: +10pts (100% of target) → EXIT (target hit)
✅ P&L: -12pts (80% of 15pt SL), Time: 60s → EXIT (approaching SL)
✅ P&L: +3pts, Time: 280s → EXIT (approaching max hold, take profit)

EXAMPLES OF BAD DECISIONS (NEVER DO THIS):
❌ P&L: +2.35pts, Time: 13s, Reason: "Low ATR" → TOO EARLY!
❌ P&L: +1.6pts, Time: 19s, Reason: "Potential reversal" → TOO EARLY!
❌ P&L: -0.85pts, Time: 7s, Reason: "Target not reachable" → TOO EARLY!
❌ P&L: +5pts, Time: 60s, Reason: "ATR low" → HOLD! 50% of target reached!

OUTPUT (strict JSON, no markdown):
{
  "action": "EXIT" | "HOLD" | "TRAIL_SL",
  "new_sl": <number or null>,
  "confidence": <integer 0-10>,
  "reasoning": "<specific reason with P&L %, time, and target achievement %>",
  "exit_urgency": "immediate" | "next_minute" | "soft",
  "current_pnl_pct_of_target": <percentage of target achieved>,
  "time_held_seconds": <seconds>,
  "momentum": "strong" | "moderate" | "weak" | "reversing"
}
`.trim();

const SWING_SYSTEM_PROMPT = `
You are an institutional-grade NIFTY 50 options trader monitoring an OPEN
SWING position. Each call you decide one action only.

Swing holds are 3-15 minutes. You prioritize letting the trade breathe when
the trend is intact, and cutting fast when structure breaks.

You see everything the scalp monitor sees, plus:
  - full session candle evolution (1m/5m/15m from 09:15)
  - prior 5-7 days context for pivot / max-pain alignment

HARD RULES
  - Hard SL hit                       → EXIT (already triggered by engine)
  - 3 consecutive 1m candles against  → EXIT (already triggered by engine)
  - Cannot loosen SL. Can only trail tighter.
  - ADD_QUANTITY only after profit > 1.2× target AND confidence >= 8

OUTPUT (strict JSON):
{
  "action": "EXIT" | "HOLD" | "TRAIL_SL" | "ADD_QUANTITY",
  "new_sl": <number or null>,
  "add_lots": <integer or null>,
  "confidence": <integer 0-10>,
  "reasoning": "<1-2 concise sentences>",
  "exit_urgency": "immediate" | "next_minute" | "soft"
}
`.trim();

// ---------------------------------------------------------------------------
// Pre-AI rule gates
// ---------------------------------------------------------------------------
function scalpPreAIGates(trade, settings, context) {
  const entryPrice = trade.entryPrice;
  const current = trade.currentPrice;
  const pnlPts = current - entryPrice;
  const elapsedSec = Math.floor((Date.now() - new Date(trade.createdAt || trade.openedAt || Date.now()).getTime()) / 1000);

  // ============================================================
  // PHASE 1 FIX: MINIMUM HOLD TIME CHECK (30 seconds)
  // ============================================================
  const MIN_HOLD_TIME = 30; // seconds
  
  if (elapsedSec < MIN_HOLD_TIME) {
    // Only exit before min hold time if SL is hit
    if (trade.sl && current <= trade.sl) {
      return { 
        action: 'EXIT', 
        reasoning: `SL hit (${current} <= ${trade.sl}) at ${elapsedSec}s`, 
        source: 'rule:scalp_sl', 
        confidence: 10, 
        exit_urgency: 'immediate' 
      };
    }
    
    // Otherwise, HOLD - too early to exit
    logger.info({
      tradeId: trade._id,
      elapsedSec,
      minHoldTime: MIN_HOLD_TIME,
      pnlPts: pnlPts.toFixed(2)
    }, '[monitorEngine] Below minimum hold time, forcing HOLD');
    
    return { 
      action: 'HOLD', 
      reasoning: `Minimum hold time not reached (${elapsedSec}s < ${MIN_HOLD_TIME}s), P&L: ${pnlPts.toFixed(2)}pts`, 
      source: 'rule:min_hold_time', 
      confidence: 10, 
      exit_urgency: 'soft' 
    };
  }

  // ============================================================
  // PHASE 1 FIX: TARGET ACHIEVEMENT PERCENTAGE LOGIC
  // ============================================================
  const targetPoints = settings?.targetPoints || 10;
  const slPoints = settings?.slPoints || 15;
  const targetAchievementPct = (pnlPts / targetPoints) * 100;
  const slProximityPct = (Math.abs(pnlPts) / slPoints) * 100;

  logger.info({
    tradeId: trade._id,
    elapsedSec,
    pnlPts: pnlPts.toFixed(2),
    targetAchievementPct: targetAchievementPct.toFixed(1),
    slProximityPct: slProximityPct.toFixed(1),
    targetPoints,
    slPoints
  }, '[monitorEngine] Trade metrics calculated');

  // ============================================================
  // PHASE 1 FIX: SL PROXIMITY LOGIC (80% threshold)
  // ============================================================
  if (pnlPts < 0 && slProximityPct >= 80) {
    return { 
      action: 'EXIT', 
      reasoning: `Approaching SL: ${pnlPts.toFixed(2)}pts (${slProximityPct.toFixed(1)}% of ${slPoints}pt SL) at ${elapsedSec}s`, 
      source: 'rule:sl_proximity', 
      confidence: 10, 
      exit_urgency: 'immediate' 
    };
  }

  // S-1 Hard SL hit
  if (trade.sl && current <= trade.sl) {
    return { 
      action: 'EXIT', 
      reasoning: `SL hit (${current} <= ${trade.sl}) at ${elapsedSec}s`, 
      source: 'rule:scalp_sl', 
      confidence: 10, 
      exit_urgency: 'immediate' 
    };
  }

  // ============================================================
  // PHASE 1 FIX: TARGET HIT LOGIC (100%+ achievement)
  // ============================================================
  if (targetAchievementPct >= 100) {
    return { 
      action: 'EXIT', 
      reasoning: `Target achieved: ${pnlPts.toFixed(2)}pts (${targetAchievementPct.toFixed(1)}% of ${targetPoints}pt target) at ${elapsedSec}s`, 
      source: 'rule:target_hit', 
      confidence: 10, 
      exit_urgency: 'immediate' 
    };
  }

  // ============================================================
  // PHASE 1 FIX: HOLD FOR TARGET (80%+ achievement)
  // ============================================================
  if (targetAchievementPct >= 80 && targetAchievementPct < 100) {
    logger.info({
      tradeId: trade._id,
      pnlPts: pnlPts.toFixed(2),
      targetAchievementPct: targetAchievementPct.toFixed(1),
      elapsedSec
    }, '[monitorEngine] Close to target (80%+), holding for full target');
    
    // Don't exit - let AI decide, but log that we're close
    // AI will see this and should HOLD unless there's a strong reversal
  }

  // NEW: Professional Scalping Indicators Check (AFTER min hold time)
  const professionalScalping = context.algorithmOutputs?.professionalScalping;
  if (professionalScalping) {
    // Check if trend is still intact
    const trendIntact = checkTrendIntact(professionalScalping, trade);
    
    if (!trendIntact.intact) {
      // Only exit on trend break if we're past min hold time AND either:
      // 1. We're in loss, OR
      // 2. We're in profit but below 50% of target
      if (pnlPts < 0 || targetAchievementPct < 50) {
        return { 
          action: 'EXIT', 
          reasoning: `${trendIntact.reason} at ${elapsedSec}s, P&L: ${pnlPts.toFixed(2)}pts (${targetAchievementPct.toFixed(1)}% of target)`, 
          source: 'professional_scalping_trend_break', 
          confidence: 9, 
          exit_urgency: 'immediate' 
        };
      }
    }
    
    // If trend is intact and we have profit, HOLD (don't exit early)
    if (trendIntact.intact && pnlPts > 0) {
      logger.info({
        tradeId: trade._id,
        pnlPts: pnlPts.toFixed(2),
        elapsedSec,
        professionalSignal: professionalScalping.signal,
        supertrend: professionalScalping.supertrend?.trend,
        adx: professionalScalping.adx?.value
      }, '[monitorEngine] Trend intact, holding position');
    }
  }

  // S-2 target hit then pullback - REMOVED (handled by target achievement logic above)

  // ============================================================
  // PHASE 1 FIX: RELAXED FAST LOSS CUTS
  // ============================================================
  // Only exit on fast loss if it's SEVERE (not just normal option volatility)
  if (elapsedSec >= 30 && elapsedSec < 60 && pnlPts <= -10) {
    return { 
      action: 'EXIT', 
      reasoning: `Severe quick loss: ${pnlPts.toFixed(2)}pts in ${elapsedSec}s`, 
      source: 'rule:scalp_fast_loss', 
      confidence: 10, 
      exit_urgency: 'immediate' 
    };
  }
  
  // After 60 seconds, only exit if loss exceeds 60% of SL (was 50%)
  if (elapsedSec >= 60 && slProximityPct >= 60) {
    return { 
      action: 'EXIT', 
      reasoning: `Sustained loss: ${pnlPts.toFixed(2)}pts (${slProximityPct.toFixed(1)}% of SL) after ${elapsedSec}s`, 
      source: 'rule:scalp_sustained_loss', 
      confidence: 8, 
      exit_urgency: 'immediate' 
    };
  }

  // ============================================================
  // PHASE 1 FIX: MAX HOLD TIME (300 seconds)
  // ============================================================
  const MAX_HOLD_TIME = settings?.maxHoldTimeSeconds || 300;
  
  if (elapsedSec >= MAX_HOLD_TIME) {
    return { 
      action: 'EXIT', 
      reasoning: `Max hold time reached: ${elapsedSec}s >= ${MAX_HOLD_TIME}s, P&L: ${pnlPts.toFixed(2)}pts (${targetAchievementPct.toFixed(1)}% of target)`, 
      source: 'rule:scalp_max_hold', 
      confidence: 10, 
      exit_urgency: 'immediate' 
    };
  }
  
  // ============================================================
  // PHASE 1 FIX: TIME-BASED EXIT WARNING (240+ seconds)
  // ============================================================
  if (elapsedSec >= 240 && targetAchievementPct < 30) {
    logger.warn({
      tradeId: trade._id,
      elapsedSec,
      pnlPts: pnlPts.toFixed(2),
      targetAchievementPct: targetAchievementPct.toFixed(1)
    }, '[monitorEngine] Approaching max hold time with low target achievement');
    
    // Let AI decide, but it should consider exiting
  }
  
  return null;
}

/**
 * Check if trend is still intact based on professional scalping indicators
 * @param {Object} professionalScalping - Professional scalping analysis
 * @param {Object} trade - Current trade
 * @returns {Object} - { intact: boolean, reason: string, strength: string }
 */
function checkTrendIntact(professionalScalping, trade) {
  const isCE = trade.optionType === 'CE';
  const isPE = trade.optionType === 'PE';
  
  // Check Supertrend (PRIMARY indicator for trend)
  if (professionalScalping.supertrend) {
    const supertrendTrend = professionalScalping.supertrend.trend;
    
    if (isCE && supertrendTrend === 'bearish') {
      return { 
        intact: false, 
        reason: `Supertrend flipped bearish (was bullish for CE)`, 
        strength: 'broken' 
      };
    }
    
    if (isPE && supertrendTrend === 'bullish') {
      return { 
        intact: false, 
        reason: `Supertrend flipped bullish (was bearish for PE)`, 
        strength: 'broken' 
      };
    }
  }
  
  // Check ADX (trend strength)
  if (professionalScalping.adx) {
    const adxValue = professionalScalping.adx.value;
    const adxStrength = professionalScalping.adx.strength;
    
    if (adxValue < 20 || adxStrength === 'weak') {
      return { 
        intact: false, 
        reason: `ADX dropped to ${adxValue} (trend weakening)`, 
        strength: 'weak' 
      };
    }
  }
  
  // Check VWAP (institutional bias)
  if (professionalScalping.vwap) {
    const vwapPosition = professionalScalping.vwap.position;
    
    if (isCE && vwapPosition === 'below') {
      return { 
        intact: false, 
        reason: `Price dropped below VWAP (bullish bias lost)`, 
        strength: 'broken' 
      };
    }
    
    if (isPE && vwapPosition === 'above') {
      return { 
        intact: false, 
        reason: `Price rose above VWAP (bearish bias lost)`, 
        strength: 'broken' 
      };
    }
  }
  
  // Check EMA crossover
  if (professionalScalping.ema) {
    const emaCrossover = professionalScalping.ema.crossover;
    
    if (isCE && emaCrossover === 'bearish') {
      return { 
        intact: false, 
        reason: `9 EMA crossed below 20 EMA (momentum lost)`, 
        strength: 'broken' 
      };
    }
    
    if (isPE && emaCrossover === 'bullish') {
      return { 
        intact: false, 
        reason: `9 EMA crossed above 20 EMA (momentum lost)`, 
        strength: 'broken' 
      };
    }
  }
  
  // Check overall signal
  if (professionalScalping.signal) {
    const signal = professionalScalping.signal;
    
    if (isCE && (signal === 'strong_sell' || signal === 'sell')) {
      return { 
        intact: false, 
        reason: `Professional signal turned ${signal} (against CE position)`, 
        strength: 'broken' 
      };
    }
    
    if (isPE && (signal === 'strong_buy' || signal === 'buy')) {
      return { 
        intact: false, 
        reason: `Professional signal turned ${signal} (against PE position)`, 
        strength: 'broken' 
      };
    }
  }
  
  // Determine strength
  let strength = 'moderate';
  if (professionalScalping.adx && professionalScalping.adx.value >= 30) {
    strength = 'strong';
  } else if (professionalScalping.adx && professionalScalping.adx.value >= 25) {
    strength = 'moderate';
  }
  
  // All checks passed - trend is intact
  return { 
    intact: true, 
    reason: 'All indicators confirm trend is intact', 
    strength 
  };
}

function swingPreAIGates(trade, settings, context) {
  const entryPrice = trade.entryPrice;
  const current = trade.currentPrice;
  const pnlPts = current - entryPrice;
  const elapsedSec = Math.floor((Date.now() - new Date(trade.createdAt || trade.openedAt || Date.now()).getTime()) / 1000);

  // W-1 hard SL
  if (trade.sl && current <= trade.sl) {
    return { action: 'EXIT', reasoning: `Swing SL hit (${current} <= ${trade.sl})`, source: 'rule:swing_sl', confidence: 10, exit_urgency: 'immediate' };
  }

  // W-2 max hold (swing)
  const swingMaxHold = settings?.swingMaxHoldMinutes ? settings.swingMaxHoldMinutes * 60 : 15 * 60;
  if (elapsedSec >= swingMaxHold) {
    return { action: 'EXIT', reasoning: `Swing max hold exceeded (${Math.floor(elapsedSec/60)}min >= ${Math.floor(swingMaxHold/60)}min)`, source: 'rule:swing_max_hold', confidence: 8, exit_urgency: 'immediate' };
  }

  // W-3 structural break — 3 consecutive 1m closes against position
  const c1 = context?.today?.candles?.['1m'] || [];
  if (c1.length >= 3) {
    const last3 = c1.slice(-3);
    const goingDown = last3.every((c, i, a) => i === 0 || c.c < a[i-1].c);
    const goingUp = last3.every((c, i, a) => i === 0 || c.c > a[i-1].c);
    const isCE = trade.signal === 'BUY_CE';
    if ((isCE && goingDown) || (!isCE && goingUp)) {
      // Only cut if we're at a loss — if we're at profit, let it trail
      if (pnlPts < 0) {
        return { action: 'EXIT', reasoning: `3 consecutive 1m closes against ${isCE ? 'CE' : 'PE'} and P&L is ${pnlPts.toFixed(1)}pts`, source: 'rule:swing_structural_break', confidence: 9, exit_urgency: 'immediate' };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI payload for monitor
// ---------------------------------------------------------------------------
async function buildMonitorPayload({ trade, aggregator, algorithmOutputs, masterDecision, settings, allOpenTrades, futuresData }) {
  const focusStrikes = [];
  const center = trade.strike;
  for (let i = -4; i <= 4; i++) focusStrikes.push(center + i * 50);

  const history = await historicalContext.buildHistoricalContext({
    maxBackfillDays: trade.tradeType === 'SWING' ? 7 : 3,
    focusStrikes,
    includeRawToday: true,
  });

  const elapsedSec = Math.floor((Date.now() - new Date(trade.createdAt || trade.openedAt || Date.now()).getTime()) / 1000);
  const pnlPts = (trade.currentPrice || 0) - trade.entryPrice;
  const pnlPct = trade.entryPrice ? (pnlPts / trade.entryPrice) * 100 : 0;

  // ============================================================
  // PHASE 1 FIX: TRADE PERFORMANCE METRICS
  // ============================================================
  const targetPoints = settings?.targetPoints || 10;
  const slPoints = settings?.slPoints || 15;
  const targetAchievementPct = (pnlPts / targetPoints) * 100;
  const slProximityPct = pnlPts < 0 ? (Math.abs(pnlPts) / slPoints) * 100 : 0;
  
  // Calculate P&L trend (improving/stable/declining)
  const maxPnl = trade.maxPriceReached ? (trade.maxPriceReached - trade.entryPrice) : pnlPts;
  const minPnl = trade.minPriceReached ? (trade.minPriceReached - trade.entryPrice) : pnlPts;
  
  let pnlTrend = 'stable';
  if (pnlPts > maxPnl * 0.9) {
    pnlTrend = 'improving';
  } else if (pnlPts < maxPnl * 0.7) {
    pnlTrend = 'declining';
  }
  
  const tradeMetrics = {
    time_held_seconds: elapsedSec,
    pnl_points: Number(pnlPts.toFixed(2)),
    pnl_percentage: Number(pnlPct.toFixed(2)),
    target_achievement_pct: Number(targetAchievementPct.toFixed(1)),
    sl_proximity_pct: Number(slProximityPct.toFixed(1)),
    max_pnl_reached: Number(maxPnl.toFixed(2)),
    min_pnl_reached: Number(minPnl.toFixed(2)),
    pnl_trend: pnlTrend,
    is_close_to_target: targetAchievementPct >= 80,
    is_approaching_sl: slProximityPct >= 60,
    min_hold_time_met: elapsedSec >= 30,
    approaching_max_hold: elapsedSec >= 240,
  };

  // Build open positions summary for AI context
  const openPositionsSummary = (allOpenTrades || []).map(t => ({
    id: String(t._id || '').slice(-6),
    signal: t.signal,
    strike: t.strike,
    entryPrice: t.entryPrice,
    currentPrice: t.currentPrice,
    pnlPoints: Number(((t.currentPrice || 0) - t.entryPrice).toFixed(2)),
    pnlPct: Number((((t.currentPrice || 0) - t.entryPrice) / t.entryPrice * 100).toFixed(2)),
    elapsedSec: Math.floor((Date.now() - new Date(t.createdAt || t.openedAt || Date.now()).getTime()) / 1000),
    tradeType: t.tradeType || 'SCALP',
    hasReachedTarget: !!t.hasReachedTarget,
  }));

  // ============================================================
  // ATR ANALYSIS - Check current volatility for exit decisions
  // ============================================================
  let atrAnalysis = null;
  if (settings?.enableATRConfirmation) {
    const candles1m = history?.today?.candles?.['1m'] || [];
    const candles5m = history?.today?.candles?.['5m'] || [];
    const currentPrice = trade.currentPrice || trade.entryPrice;
    
    // Calculate remaining points to target
    const remainingPoints = (trade.target || trade.entryPrice + (settings?.targetPoints || 5)) - currentPrice;
    
    atrAnalysis = atrService.getATRAnalysis(
      candles1m,
      candles5m,
      Math.max(1, remainingPoints), // Remaining points to capture
      currentPrice
    );
    
    logger.info({
      tradeId: String(trade._id),
      atr: atrAnalysis.primary_atr,
      volatility: atrAnalysis.volatility,
      remainingPoints,
      currentPrice,
    }, '[monitorEngine] ATR analysis for open trade');
  }

  return {
    meta: {
      timestamp: new Date().toISOString(),
      elapsedSec,
      tradeType: trade.tradeType || 'SCALP',
      totalOpenTrades: openPositionsSummary.length,
    },
    trade: {
      id: String(trade._id || ''),
      signal: trade.signal,
      strike: trade.strike,
      lots: Math.floor(trade.quantity / trade.lotSize) || 1,
      entryPrice: trade.entryPrice,
      currentPrice: trade.currentPrice,
      sl: trade.sl,
      target: trade.target,
      maxPriceReached: trade.maxPriceReached,
      hasReachedTarget: !!trade.hasReachedTarget,
      pnlPoints: Number(pnlPts.toFixed(2)),
      pnlPct: Number(pnlPct.toFixed(2)),
      monitorTicks: trade.monitorTicks || 0,
    },
    // ============================================================
    // PHASE 1 FIX: TRADE METRICS (NEW)
    // ============================================================
    trade_metrics: tradeMetrics,
    // ============================================================
    // PHASE 1 FIX: EXIT THRESHOLDS (NEW)
    // ============================================================
    exit_thresholds: {
      target_points: targetPoints,
      sl_points: slPoints,
      min_hold_seconds: 30,
      max_hold_seconds: settings?.maxHoldTimeSeconds || 300,
      target_80pct: Number((targetPoints * 0.8).toFixed(2)),
      target_60pct: Number((targetPoints * 0.6).toFixed(2)),
      sl_80pct: Number((slPoints * 0.8).toFixed(2)),
      sl_60pct: Number((slPoints * 0.6).toFixed(2)),
    },
    open_positions: openPositionsSummary,
    settings: {
      targetPoints: settings?.targetPoints || 5,
      slPoints: settings?.slPoints || 10,
      maxLots: settings?.maxLots || 3,
      swingMinPoints: settings?.swingMinPoints || 40,
      maxHoldTimeSeconds: settings?.maxHoldTimeSeconds || 300,
    },
    live_snapshot: aggregator?.payload || null,
    primary_strikes: buildPrimaryStrikesBlock(aggregator, focusStrikes),
    algorithm_outputs: {
      gamma_exposure: algorithmOutputs?.gammaExposure || null,
      order_flow: algorithmOutputs?.orderFlow || null,
      multi_timeframe: algorithmOutputs?.multiTimeframe || null,
      liquidity_analysis: algorithmOutputs?.liquidityAnalysis || null,
      smart_money_concepts: algorithmOutputs?.smartMoneyConcepts ? {
        smc_score: algorithmOutputs.smartMoneyConcepts.smc_score,
        smc_bias: algorithmOutputs.smartMoneyConcepts.smc_bias,
        market_structure: algorithmOutputs.smartMoneyConcepts.market_structure,
        order_blocks: algorithmOutputs.smartMoneyConcepts.order_blocks,
        fair_value_gaps: algorithmOutputs.smartMoneyConcepts.fair_value_gaps,
        liquidity_zones: algorithmOutputs.smartMoneyConcepts.liquidity_zones,
        break_of_structure: algorithmOutputs.smartMoneyConcepts.break_of_structure,
        change_of_character: algorithmOutputs.smartMoneyConcepts.change_of_character,
        mitigation_blocks: algorithmOutputs.smartMoneyConcepts.mitigation_blocks,
        inducement: algorithmOutputs.smartMoneyConcepts.inducement,
        trading_implication: algorithmOutputs.smartMoneyConcepts.trading_implication,
      } : null,
      market_internals: algorithmOutputs?.marketInternals || null,
      sector_rotation: algorithmOutputs?.sectorRotation || null,
      global_markets: algorithmOutputs?.globalMarkets || null,
      behavioral_analysis: algorithmOutputs?.behavioral || null,
      dema_indicator: algorithmOutputs?.dema || null,
    },
    master_algorithm: {
      score: masterDecision?.master_score,
      confidence: masterDecision?.confidence,
      signal: masterDecision?.signal,
      agreement: masterDecision?.agreement,
    },
    atr_analysis: atrAnalysis,  // ATR for monitor decisions
    futures_data: futuresData ? {
      current_premium: futuresData.premium,
      entry_premium: trade.futuresPremium || null,
      premium_change: futuresData.premium && trade.futuresPremium 
        ? Number((futuresData.premium - trade.futuresPremium).toFixed(2))
        : null,
      futures_direction: futuresData.direction,
      futures_momentum: futuresData.momentum,
      futures_trend: futuresData.trend,
      spot_futures_divergence: futuresData.divergence,
      futures_1m_change: futuresData.change_1m,
      futures_5m_change: futuresData.change_5m,
    } : null,
    today_intraday: history.today || null,
    prior_days: history.priorDays || [],
  };
}

function buildPrimaryStrikesBlock(aggregator, focusStrikes) {
  const strikes = aggregator?.payload?.options_chain?.strikes || aggregator?.optionChain?.strikes || [];
  if (!strikes.length) return [];
  const byStrike = new Map(strikes.map(s => [s.strike, s]));
  return focusStrikes.map(strike => {
    const s = byStrike.get(strike);
    if (!s) return { strike, missing: true };
    return {
      strike,
      ce: { ltp: s.call?.ltp, oi: s.call?.oi, oiChg: s.call?.oiChange, iv: s.call?.iv, delta: s.call?.greeks?.delta, theta: s.call?.greeks?.theta },
      pe: { ltp: s.put?.ltp,  oi: s.put?.oi,  oiChg: s.put?.oiChange,  iv: s.put?.iv,  delta: s.put?.greeks?.delta,  theta: s.put?.greeks?.theta },
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function decide({ trade, aggregator, algorithmOutputs, masterDecision, settings, allOpenTrades, futuresData }) {
  // ──────────────────────────────────────────────────────────────────────────
  // HYBRID PATH — deterministic, institutional-style. ON BY DEFAULT.
  // Returns the SAME shape as the legacy AI path:
  //   { action, new_sl, add_lots, confidence, reasoning, exit_urgency, source }
  // To opt out per-session: settings.useHybridEngine = false
  // ──────────────────────────────────────────────────────────────────────────
  const useHybrid = settings?.useHybridEngine !== false;
  if (useHybrid) {
    try {
      const decision = await hybrid.monitor.decide({
        trade, aggregator, algorithmOutputs, masterDecision, settings, allOpenTrades, futuresData,
      });
      logger.info({
        tradeId: String(trade?._id || ''),
        action: decision.action,
        source: decision.source,
        reasoning: decision.reasoning,
      }, '[monitorEngine] hybrid decision');
      return decision;
    } catch (e) {
      logger.error({ err: e.message, stack: e.stack, tradeId: String(trade?._id || '') },
        '[monitorEngine] hybrid path failed — falling back to legacy AI path');
      // fall through
    }
  }

  // ─── LEGACY AI PATH ────────────────────────────────────────────────────────
  const tradeType = trade.tradeType || 'SCALP';

  // Build history once — used by both pre-AI gates (swing) and AI payload
  const focusStrikes = [];
  for (let i = -4; i <= 4; i++) focusStrikes.push(trade.strike + i * 50);
  const history = await historicalContext.buildHistoricalContext({
    maxBackfillDays: tradeType === 'SWING' ? 7 : 3,
    focusStrikes,
    includeRawToday: true,
  });

  // Pre-AI rule gates — decide without calling AI when possible
  const preGate = tradeType === 'SWING'
    ? swingPreAIGates(trade, settings, history)
    : scalpPreAIGates(trade, settings, history);

  if (preGate) {
    logger.info({ tradeId: trade._id, source: preGate.source, reasoning: preGate.reasoning }, '[monitorEngine] pre-AI gate fired');
    return preGate;
  }

  // No hard rule fired — ask AI
  const payload = await buildMonitorPayload({ trade, aggregator, algorithmOutputs, masterDecision, settings, allOpenTrades, futuresData });
  let raw;
  try {
    raw = await openai.callOpenAICustom({
      systemPrompt: tradeType === 'SWING' ? SWING_SYSTEM_PROMPT : SCALP_SYSTEM_PROMPT,
      userPayload: payload,
      model: 'gpt-4o-mini',
      temperature: 0.15,
      responseFormat: 'json',
      purpose: tradeType === 'SWING' ? 'swing_monitor' : 'scalp_monitor',
    });
  } catch (e) {
    logger.error({ err: e.message, tradeId: trade._id }, '[monitorEngine] OpenAI call failed');
    // Default action: HOLD and let the next cycle's rules catch it
    return { action: 'HOLD', reasoning: `AI call failed: ${e.message}`, confidence: 0, exit_urgency: 'soft', source: 'ai_failed' };
  }

  try { 
    aiIOLogger.logAICall?.({ 
      purpose: `monitor_${tradeType.toLowerCase()}`,
      model: 'gpt-4o-mini',
      systemPrompt: tradeType === 'SWING' ? SWING_SYSTEM_PROMPT : SCALP_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(payload),
      responseText: typeof raw === 'string' ? raw : JSON.stringify(raw),
      parsedResponse: raw,
      sessionId: String(trade.sessionId || ''),
    }); 
  } catch (_) {}

  return normaliseMonitorDecision(raw, trade, settings);
}

function normaliseMonitorDecision(raw, trade, settings) {
  const d = typeof raw === 'string' ? safeParse(raw) : (raw || {});
  const action = ['EXIT', 'HOLD', 'TRAIL_SL', 'ADD_QUANTITY'].includes(d.action) ? d.action : 'HOLD';

  const out = {
    action,
    new_sl: d.new_sl != null ? Number(d.new_sl) : null,
    add_lots: d.add_lots != null ? Math.max(1, Math.round(Number(d.add_lots))) : null,
    confidence: clampInt(d.confidence, 0, 10),
    reasoning: String(d.reasoning || '').slice(0, 400),
    exit_urgency: ['immediate', 'next_minute', 'soft'].includes(d.exit_urgency) ? d.exit_urgency : 'soft',
    source: 'ai',
  };

  // Guard: TRAIL_SL must be strictly above current SL and below current price
  if (out.action === 'TRAIL_SL') {
    if (!out.new_sl || out.new_sl <= (trade.sl || 0) || out.new_sl >= (trade.currentPrice || 0)) {
      out.action = 'HOLD';
      out.reasoning = `[guarded] AI proposed invalid new_sl ${out.new_sl}, keeping trade. Original: ${out.reasoning}`;
    }
  }

  // Guard: ADD_QUANTITY only after target hit AND current lots < max lots AND confidence >= 8
  if (out.action === 'ADD_QUANTITY') {
    const currentLots = Math.floor(trade.quantity / trade.lotSize) || 1;
    const maxLots = settings?.maxLots || 3;
    if (!trade.hasReachedTarget || currentLots >= maxLots || out.confidence < 8) {
      out.action = 'HOLD';
      out.add_lots = null;
      out.reasoning = `[guarded] AI proposed ADD_QUANTITY but rules not met (targetHit=${!!trade.hasReachedTarget}, lots=${currentLots}/${maxLots}, conf=${out.confidence}). Original: ${out.reasoning}`;
    }
  }

  return out;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function safeParse(txt) {
  try { return JSON.parse(txt); }
  catch (_) {
    const m = String(txt).match(/\{[\s\S]*\}/);
    if (!m) return {};
    try { return JSON.parse(m[0]); } catch (_) { return {}; }
  }
}

module.exports = {
  decide,
  buildMonitorPayload,
  scalpPreAIGates,
  swingPreAIGates,
};
