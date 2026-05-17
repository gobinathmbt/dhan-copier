/**
 * Strategy Selector
 * -----------------
 * Picks the appropriate intraday strategy for the current market context and
 * returns the parameters that the rest of the pipeline must honour:
 *
 *   - SCALPING            — fast in/out, small target, tight SL
 *   - INTRADAY_MOMENTUM   — trend-following, wider target, larger SL
 *   - MEAN_REVERSION      — fades extension, range trades
 *
 * Each strategy declares:
 *   - rrTarget:       { min, max }      — acceptable RR band
 *   - targetPoints   :     point target on the option premium
 *   - slPoints       :     SL points on the option premium
 *   - maxHoldSec     :     max hold time
 *   - minScore       :     minimum confidence score (entryThreshold)
 *   - tradeType      :     'SCALP' or 'SWING'
 *   - allowedRegimes :     which marketRegime states are valid
 *   - utBotRequired  :     if UT Bot must agree on 5m
 *
 * Selection logic (priority order):
 *   1. Trending regime + expansion volatility   →  INTRADAY_MOMENTUM
 *   2. Trending regime + normal volatility      →  INTRADAY_MOMENTUM (lighter)
 *   3. Ranging  regime + normal volatility      →  MEAN_REVERSION
 *   4. Power hour / opening drive + decent flow →  SCALPING
 *   5. Otherwise                                →  SCALPING (default conservative)
 *
 * The user-facing realistic targets per strategy (from the spec):
 *   Scalping              55-68% win, RR 1:1 to 1:1.5
 *   Intraday Momentum     45-60% win, RR 1:2 to 1:4
 *   Mean Reversion        60-75% win, RR 1:0.8 to 1:1.5
 */

const STRATEGIES = {
  SCALPING: {
    name: 'SCALPING',
    tradeType: 'SCALP',
    targetPointsRatio: 1.0,
    slPointsRatio:     1.0,
    rrTarget: { min: 1.0, max: 1.5 },
    maxHoldSec: 180,
    minScore: 55,                    // calibrated down from 60
    utBotRequired: false,            // never required (calibration spec)
    allowedRegimes: ['trending_bullish','trending_bearish','ranging','reversal_risk'],
  },
  INTRADAY_MOMENTUM: {
    name: 'INTRADAY_MOMENTUM',
    tradeType: 'SWING',
    targetPointsRatio: 3.0,
    slPointsRatio:     1.5,
    rrTarget: { min: 2.0, max: 4.0 },
    maxHoldSec: 15 * 60,
    minScore: 65,                    // calibrated down from 75
    utBotRequired: true,             // momentum swings — UT Bot helps
    allowedRegimes: ['trending_bullish','trending_bearish'],
  },
  MEAN_REVERSION: {
    name: 'MEAN_REVERSION',
    tradeType: 'SCALP',
    targetPointsRatio: 0.8,
    slPointsRatio:     1.0,
    rrTarget: { min: 0.8, max: 1.5 },
    maxHoldSec: 240,
    minScore: 58,                    // calibrated down from 65
    utBotRequired: false,
    allowedRegimes: ['ranging','reversal_risk','trending_bullish','trending_bearish'],
  },
};

function _resolveBaseParams(settings, strat) {
  const baseTarget = Number(settings?.targetPoints) || 10;
  const baseSl     = Number(settings?.slPoints)     || 15;
  const targetPoints = Math.max(2, Math.round(baseTarget * strat.targetPointsRatio));
  const slPoints     = Math.max(2, Math.round(baseSl     * strat.slPointsRatio));
  return { targetPoints, slPoints, maxHoldSec: strat.maxHoldSec };
}

/**
 * Select the strategy for the current market context.
 *
 * @param {Object} ctx
 * @param {Object} ctx.marketRegime    - marketRegimeEngine.classify output
 * @param {Object} ctx.volatilityRegime
 * @param {Object} ctx.session         - sessionEngine.classifySession output
 * @param {Object} ctx.settings        - ScalpingSession.settings
 * @param {Object} [ctx.derivatives]   - derivativesEngine output (used for tie-breaks)
 * @returns {Object} selected strategy + resolved params + reasoning
 */
function select({ marketRegime, volatilityRegime, session, settings, derivatives } = {}) {
  // User can pin a strategy via settings — useful for testing.
  if (settings?.forceStrategy && STRATEGIES[settings.forceStrategy]) {
    const strat = STRATEGIES[settings.forceStrategy];
    return {
      strategy: strat.name,
      ...strat,
      ..._resolveBaseParams(settings, strat),
      reasoning: `forced by settings.forceStrategy=${settings.forceStrategy}`,
    };
  }

  const regime  = marketRegime?.regime;
  const vol     = volatilityRegime?.state;
  const phase   = session?.phase;

  let pick = STRATEGIES.SCALPING;
  const reasons = [];

  // 1. Trending + expansion → momentum
  if ((regime === 'trending_bullish' || regime === 'trending_bearish')
      && (vol === 'expansion' || vol === 'normal')) {
    pick = STRATEGIES.INTRADAY_MOMENTUM;
    reasons.push(`${regime} + ${vol} → momentum`);
  }
  // 2. Power hour or opening drive + trending → momentum
  else if ((phase === 'power_hour' || phase === 'opening_drive')
           && (regime === 'trending_bullish' || regime === 'trending_bearish')) {
    pick = STRATEGIES.INTRADAY_MOMENTUM;
    reasons.push(`${phase} + ${regime} → momentum`);
  }
  // 3. Ranging → mean reversion
  else if (regime === 'ranging' && (vol === 'normal' || vol === 'expansion')) {
    pick = STRATEGIES.MEAN_REVERSION;
    reasons.push(`${regime} + ${vol} → mean reversion`);
  }
  // 4. Midday chop or normal mixed → scalping
  else {
    pick = STRATEGIES.SCALPING;
    reasons.push(`default scalping (regime=${regime}, vol=${vol}, phase=${phase})`);
  }

  return {
    strategy: pick.name,
    ...pick,
    ..._resolveBaseParams(settings, pick),
    reasoning: reasons.join(' | '),
  };
}

module.exports = { select, STRATEGIES };
