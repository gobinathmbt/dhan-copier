/**
 * Probability Scoring Engine
 * --------------------------
 * The heart of the deterministic hybrid logic. This is what replaces
 * "ask AI to vote on the trade".
 *
 * Three-tier evaluation:
 *
 *   TIER 1 — HARD GATES (any single failure = NO_TRADE)
 *     - session entry permission
 *     - market regime allows entries
 *     - volatility regime allows entries
 *     - liquidity allows entries
 *     - data freshness OK
 *
 *   TIER 2 — WEIGHTED SCORING (need score ≥ threshold to trade)
 *     OI / derivatives          25
 *     VWAP / AVWAP              20
 *     Volume profile + Volume   15
 *     Delta / order flow        15
 *     Liquidity quality         10
 *     IV / VIX context           5
 *     Breadth / market internals 5
 *     PCR                        5
 *
 *   TIER 3 — LIGHT FILTERS (informational, small bonus)
 *     EMA structure (3%)
 *     UT Bot continuation (2%)
 *
 * Output:
 *   {
 *     allowed, direction, score, hardGates: [...], weightedScore,
 *     lightBonus, totals, reasoning
 *   }
 *
 * The probability score isn't tied to either CE or PE — direction is decided
 * by the derivatives engine and confirmed by VWAP / structure.
 */

// Default Tier-2 weights (sum = 100). Settings can override.
const DEFAULT_WEIGHTS = {
  derivatives: 25,    // OI + futures + PCR + gamma blend (from derivativesEngine)
  vwap:        20,    // VWAP/AVWAP positioning
  volume:      15,    // Volume profile + volume confirmation
  delta:       15,    // Delta / order flow imbalance
  liquidity:   10,    // Liquidity quality (higher = better)
  ivVix:        5,    // IV/VIX context (in-band = bonus)
  breadth:      5,    // Market internals
  pcr:          5,    // PCR (separate from derivatives blend)
};

const DEFAULT_LIGHT_WEIGHTS = {
  ema:    3,
  utBot:  2,
};

// ── Tier 1: hard gates ──────────────────────────────────────────────────────
function _checkHardGates({
  session,
  marketRegime,
  volatilityRegime,
  liquidity,
  dataFresh = true,
  killSwitch = false,
  riskBlock = false,
}) {
  const failed = [];

  if (killSwitch) failed.push('kill_switch_engaged');
  if (riskBlock) failed.push('risk_engine_blocked');
  if (!dataFresh) failed.push('stale_data');
  if (session && session.allowEntries === false) failed.push(`session:${session.phase}`);
  if (marketRegime && marketRegime.allowEntries === false) failed.push(`regime:${marketRegime.regime}`);
  if (volatilityRegime && volatilityRegime.allowEntries === false) failed.push(`volatility:${volatilityRegime.state}`);
  if (liquidity && liquidity.allowEntries === false) failed.push(`liquidity:${liquidity.health}`);

  return { passed: failed.length === 0, failed };
}

// ── Tier 2 sub-scorers — each returns { score: 0..100, bias, reasons } ─────
function _scoreDerivatives(derivatives, direction) {
  if (!derivatives) return { score: 50, bias: 'neutral', reasons: ['no derivatives'] };
  // directionScore is bullish-from-50 — flip if direction is bearish
  let s = derivatives.directionScore;
  if (direction === 'bearish') s = 100 - s;
  return { score: s, bias: derivatives.overallBias, reasons: [`derivatives ${derivatives.overallBias} ${derivatives.directionScore}`] };
}

function _scoreVwap(vwap, direction) {
  if (!vwap) return { score: 50, reasons: ['no vwap'] };
  const pos = vwap.position || vwap.price_vs_vwap;
  const dist = Math.abs(Number(vwap.distance_pct || vwap.distance_from_vwap_pct || 0));
  let s = 50;
  const reasons = [];
  if (direction === 'bullish') {
    if (pos === 'above' && dist < 0.3) { s = 80; reasons.push('above VWAP, close'); }
    else if (pos === 'above')          { s = 65; reasons.push('above VWAP'); }
    else if (pos === 'below')          { s = 25; reasons.push('below VWAP — counter-trend'); }
  } else if (direction === 'bearish') {
    if (pos === 'below' && dist < 0.3) { s = 80; reasons.push('below VWAP, close'); }
    else if (pos === 'below')          { s = 65; reasons.push('below VWAP'); }
    else if (pos === 'above')          { s = 25; reasons.push('above VWAP — counter-trend'); }
  }
  return { score: s, reasons };
}

// Volume analyzer (FRVP + VSA + time-volume). Lazily required to avoid
// circular import risks during initial module load.
let _volumeAnalysisEngine = null;
function _volumeEngine() {
  if (_volumeAnalysisEngine) return _volumeAnalysisEngine;
  try { _volumeAnalysisEngine = require('./volumeAnalysisEngine'); }
  catch (_) { _volumeAnalysisEngine = null; }
  return _volumeAnalysisEngine;
}

/**
 * Volume pillar — fuses three views:
 *   - FRVP (where volume sat) via volumeAnalysis
 *   - VSA  (effort vs result on the latest candle)
 *   - Time-volume / OI direction (legacy `volumeOI` payload)
 *
 * If volumeAnalysis is supplied (institutional), we trust its directional
 * score and only overlay a small OI-confirmation boost. If only the legacy
 * volumeOI block is available, we fall back to that simpler score.
 */
function _scoreVolume(volumeOI, direction, volumeAnalysis) {
  const engine = _volumeEngine();
  if (volumeAnalysis && engine) {
    const r = engine.score(volumeAnalysis, direction);
    let s = r.score;
    const reasons = [...r.reasons];
    // Small OI overlay if we also have OI direction
    const oiDir = volumeOI?.oi_direction || 'neutral';
    if (oiDir === direction)         { s = Math.min(100, s + 5); reasons.push(`oi ${oiDir}`); }
    else if (oiDir !== 'neutral')    { s = Math.max(0,   s - 5); reasons.push(`oi against ${direction}`); }
    return { score: s, reasons };
  }

  // Legacy fallback (no FRVP/VSA available)
  if (!volumeOI) return { score: 50, reasons: ['no volume'] };
  const oiDir = volumeOI.oi_direction || 'neutral';
  let s = 50;
  const reasons = [];
  if (volumeOI.volume_spike) { s += 20; reasons.push('volume spike'); }
  if (oiDir === direction) { s += 20; reasons.push(`oi confirms ${direction}`); }
  else if (oiDir !== 'neutral' && oiDir !== direction) { s -= 20; reasons.push(`oi against ${direction}`); }
  return { score: Math.max(0, Math.min(100, s)), reasons };
}

function _scoreDelta(orderFlow, direction) {
  if (!orderFlow) return { score: 50, reasons: ['no orderflow'] };
  const imbalance = Number(orderFlow.market_imbalance ?? orderFlow.imbalance ?? 1);
  let s = 50;
  const reasons = [];
  if (direction === 'bullish') {
    if (imbalance > 1.3) { s = 80; reasons.push(`buy pressure ${imbalance.toFixed(2)}`); }
    else if (imbalance < 0.8) { s = 25; reasons.push(`sell pressure ${imbalance.toFixed(2)}`); }
  } else if (direction === 'bearish') {
    if (imbalance < 0.7) { s = 80; reasons.push(`sell pressure ${imbalance.toFixed(2)}`); }
    else if (imbalance > 1.2) { s = 25; reasons.push(`buy pressure ${imbalance.toFixed(2)}`); }
  }
  if (orderFlow.flow_quality === 'institutional') { s = Math.min(100, s + 5); reasons.push('institutional flow'); }
  if (orderFlow.flow_quality === 'toxic') { s = Math.max(0, s - 10); reasons.push('toxic flow'); }
  return { score: s, reasons };
}

function _scoreLiquidity(liquidity) {
  if (!liquidity) return { score: 50, reasons: ['no liquidity'] };
  // health is qualitative — map to 0..100
  const map = { excellent: 90, good: 75, fair: 60, poor: 40, critical: 0, unknown: 40 };
  return { score: map[liquidity.health] ?? 50, reasons: [`liquidity ${liquidity.health}`] };
}

function _scoreIvVix({ ivPercentile = null, vix = null } = {}) {
  let s = 50;
  const reasons = [];
  if (Number.isFinite(ivPercentile)) {
    if (ivPercentile > 80) { s = 30; reasons.push('IV elevated (theta risk)'); }
    else if (ivPercentile < 30) { s = 60; reasons.push('IV low (cheap premium)'); }
    else { s = 55; reasons.push(`IV pct ${ivPercentile}`); }
  }
  if (Number.isFinite(vix)) {
    if (vix > 22) { s = Math.min(s, 30); reasons.push(`VIX panic ${vix.toFixed(1)}`); }
    else if (vix > 18) { reasons.push(`VIX elevated ${vix.toFixed(1)}`); }
  }
  return { score: s, reasons };
}

function _scoreBreadth(internals, direction) {
  if (!internals) return { score: 50, reasons: ['no breadth'] };
  const adv = Number(internals.advances ?? internals.advance_decline_ratio ?? 0);
  const dec = Number(internals.declines ?? 1);
  const ratio = adv / Math.max(1, dec);
  let s = 50;
  const reasons = [];
  if (direction === 'bullish' && ratio > 1.5) { s = 75; reasons.push(`breadth bullish ${ratio.toFixed(2)}`); }
  else if (direction === 'bullish' && ratio < 0.7) { s = 25; reasons.push(`breadth bearish ${ratio.toFixed(2)}`); }
  else if (direction === 'bearish' && ratio < 0.7) { s = 75; reasons.push(`breadth bearish ${ratio.toFixed(2)}`); }
  else if (direction === 'bearish' && ratio > 1.5) { s = 25; reasons.push(`breadth bullish ${ratio.toFixed(2)}`); }
  return { score: s, reasons };
}

function _scorePcr(pcr, direction) {
  if (!Number.isFinite(pcr)) return { score: 50, reasons: ['no pcr'] };
  let s = 50;
  const reasons = [`pcr ${pcr.toFixed(2)}`];
  if (direction === 'bullish' && pcr >= 1.2) s = 70;
  else if (direction === 'bullish' && pcr <= 0.7) s = 30;
  else if (direction === 'bearish' && pcr <= 0.7) s = 70;
  else if (direction === 'bearish' && pcr >= 1.2) s = 30;
  return { score: s, reasons };
}

// ── Tier 3 — light filters ──────────────────────────────────────────────────
function _scoreEma(professionalScalping, direction) {
  if (!professionalScalping?.ema) return { score: 50, reasons: ['no ema'] };
  const cross = professionalScalping.ema.crossover; // 'bullish' / 'bearish'
  if (cross === direction) return { score: 80, reasons: [`9 EMA / 20 EMA ${cross}`] };
  if (cross && cross !== direction) return { score: 20, reasons: [`EMA against direction`] };
  return { score: 50, reasons: ['ema neutral'] };
}

function _scoreUtBot(multiTimeframe, direction) {
  // multiTimeframe analyzeTimeframe stores ut_bot_signal per TF
  const tf5 = multiTimeframe?.timeframes?.['5m'];
  if (!tf5?.ut_bot_signal) return { score: 50, reasons: ['no ut bot'] };
  if (tf5.ut_bot_signal === direction) return { score: 80, reasons: [`UT Bot ${direction}`] };
  return { score: 30, reasons: [`UT Bot against ${direction}`] };
}

// ── Public scoring ──────────────────────────────────────────────────────────

/**
 * @param {Object} ctx — full hybrid context
 * @param {string} direction — 'bullish' | 'bearish'
 * @param {Object} thresholds - optional { minScore, weights, lightWeights }
 * @returns { allowed, direction, score, weightedScore, lightBonus, ... }
 */
function score(ctx, direction, thresholds = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(thresholds.weights || {}) };
  const lightWeights = { ...DEFAULT_LIGHT_WEIGHTS, ...(thresholds.lightWeights || {}) };
  const minScore = Number(thresholds.minScore ?? 65);

  // Tier 1
  const hard = _checkHardGates({
    session: ctx.session,
    marketRegime: ctx.marketRegime,
    volatilityRegime: ctx.volatilityRegime,
    liquidity: ctx.liquidity,
    dataFresh: ctx.dataFresh !== false,
    killSwitch: !!ctx.killSwitch,
    riskBlock: !!ctx.riskBlock,
  });
  if (!hard.passed) {
    return {
      allowed: false,
      direction,
      score: 0,
      hardGates: { passed: false, failed: hard.failed },
      tier2: null,
      tier3: null,
      reasoning: `tier1 failed: ${hard.failed.join(', ')}`,
    };
  }

  // Tier 2
  const tier2Parts = {
    derivatives: _scoreDerivatives(ctx.derivatives, direction),
    vwap:        _scoreVwap(ctx.vwap, direction),
    volume:      _scoreVolume(ctx.volumeOI, direction, ctx.volumeAnalysis),
    delta:       _scoreDelta(ctx.orderFlow, direction),
    liquidity:   _scoreLiquidity(ctx.liquidity),
    ivVix:       _scoreIvVix({ ivPercentile: ctx.ivPercentile, vix: ctx.vix }),
    breadth:     _scoreBreadth(ctx.marketInternals, direction),
    pcr:         _scorePcr(ctx.pcr, direction),
  };

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0); // = 100
  let weightedScore = 0;
  for (const [k, w] of Object.entries(weights)) {
    weightedScore += (tier2Parts[k]?.score ?? 50) * (w / totalWeight);
  }
  weightedScore = Number(weightedScore.toFixed(1));

  // Tier 3 (small adjustment to weighted score, capped ±5)
  const tier3Parts = {
    ema:   _scoreEma(ctx.professionalScalping, direction),
    utBot: _scoreUtBot(ctx.multiTimeframe, direction),
  };
  const tier3TotalWeight = lightWeights.ema + lightWeights.utBot;
  let lightBonus = 0;
  if (tier3TotalWeight > 0) {
    const lightAvg =
      tier3Parts.ema.score   * (lightWeights.ema   / tier3TotalWeight)
    + tier3Parts.utBot.score * (lightWeights.utBot / tier3TotalWeight);
    // map 0..100 to -5..+5 around 50
    lightBonus = Number(((lightAvg - 50) / 10).toFixed(2));
  }

  const finalScore = Number(Math.max(0, Math.min(100, weightedScore + lightBonus)).toFixed(1));

  // Build reasoning string from top contributors
  const reasoningTop = Object.entries(tier2Parts)
    .filter(([, v]) => v.reasons?.length)
    .sort((a, b) => Math.abs((b[1].score || 50) - 50) - Math.abs((a[1].score || 50) - 50))
    .slice(0, 4)
    .map(([k, v]) => `${k}=${v.score} (${v.reasons.join(',')})`)
    .join(' | ');

  return {
    allowed: finalScore >= minScore,
    direction,
    score: finalScore,
    weightedScore,
    lightBonus,
    minScore,
    hardGates: { passed: true, failed: [] },
    tier2: tier2Parts,
    tier3: tier3Parts,
    weights,
    lightWeights,
    reasoning: `score=${finalScore} (need ≥${minScore}) | ${reasoningTop}`,
  };
}

module.exports = {
  score,
  DEFAULT_WEIGHTS,
  DEFAULT_LIGHT_WEIGHTS,
};
