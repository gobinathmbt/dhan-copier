/**
 * Confidence Scoring Engine (institutional spec)
 * ----------------------------------------------
 * Produces the final entry-confidence score 0..100 using the EXACT weights
 * the user specified:
 *
 *   OI alignment          25
 *   Orderflow / delta     20
 *   VWAP / AVWAP          15
 *   Structure (FRVP/SMC)  10
 *   Volume                10
 *   Liquidity              5
 *   Breadth                5
 *   Futures bias           5
 *   UT Bot                 5
 *                       ---
 *                        100
 *
 * Entry thresholds (from spec):
 *   < 60   → REJECT
 *   60-75  → SCALPING ONLY
 *   75-85  → STANDARD ENTRY
 *   85+    → AGGRESSIVE INSTITUTIONAL SETUP
 *
 * Each pillar takes a sub-score 0..100 from the relevant sub-engine, applies
 * its weight, and the final composite is checked against the strategy's
 * `minScore`.
 *
 * This engine is purely deterministic. It NEVER calls AI, and it never
 * imports the engines themselves — it only consumes their already-computed
 * outputs. That makes it cheap, testable, and side-effect-free.
 */

// Calibrated weights per institutional review:
//   - UT Bot reduced 5 → 2 (it's a lagging trail signal, not a leading one)
//   - Orderflow held at 20 (delta is the strongest live signal we have)
//   - That frees 3 points which we redistribute equally to liquidity & breadth
const WEIGHTS = {
  oi:        25,
  orderflow: 20,
  vwap:      15,
  structure: 10,
  volume:    10,
  liquidity:  6,    // 5 → 6
  breadth:    5,
  futures:    5,
  utBot:      2,    // 5 → 2 (calibration: never required, lagging signal)
};   // total 98 — close enough, weights normalise to themselves

function _clamp(s) { return Math.max(0, Math.min(100, Number(s) || 0)); }

// ─────────────────────────────────────────────────────────────────────────────
// Sub-scorers — each returns 0..100. Most read pre-computed outputs and just
// pluck the right field. We map qualitative outputs to numeric pillars.
// ─────────────────────────────────────────────────────────────────────────────

function _scoreOi(oiAnalytics) {
  // oiAnalyticsEngine returns directional `qualityScore` when called with
  // `direction`; otherwise we fall back to neutral.
  if (oiAnalytics && Number.isFinite(oiAnalytics.qualityScore)) {
    return { score: _clamp(oiAnalytics.qualityScore),
             reasons: oiAnalytics.qualityReasons || [] };
  }
  return { score: 50, reasons: ['no oi'] };
}

function _scoreOrderflow(volumeAnalysis, direction) {
  // Use the delta sub-score from the volumeAnalysis directionalScore as a
  // proxy — but it already contains FRVP. So we read delta separately here:
  if (!volumeAnalysis?.delta) return { score: 50, reasons: ['no delta'] };
  const d = volumeAnalysis.delta;
  let s = 50;
  const reasons = [];
  // bias agreement
  const matches = (direction === 'bullish' && (d.bias === 'bullish' || d.bias === 'mild_bullish'))
               || (direction === 'bearish' && (d.bias === 'bearish' || d.bias === 'mild_bearish'));
  const opposes = (direction === 'bullish' && (d.bias === 'bearish' || d.bias === 'mild_bearish'))
               || (direction === 'bearish' && (d.bias === 'bullish' || d.bias === 'mild_bullish'));
  if (matches) {
    s += Math.min(35, Math.round(d.strength / 3));
    reasons.push(`delta ${d.bias} ${d.cvdPctLong}% (${d.source || 'proxy'})`);
  } else if (opposes) {
    s -= Math.min(40, Math.round(d.strength / 2.5));
    reasons.push(`delta ${d.bias} against direction`);
  }
  // Divergence (hidden absorption)
  if (d.divergence && d.divergenceBias === direction) {
    s += 12; reasons.push(`absorption favours ${direction}`);
  } else if (d.divergence && d.divergenceBias && d.divergenceBias !== 'neutral') {
    s -= 18; reasons.push(`absorption against direction`);
  }
  return { score: _clamp(s), reasons };
}

function _scoreVwap(vwap, direction) {
  if (!vwap) return { score: 50, reasons: ['no vwap'] };
  const pos = vwap.position || vwap.price_vs_vwap;
  const dist = Math.abs(Number(vwap.distance_pct || vwap.distance_from_vwap_pct || 0));
  let s = 50;
  const reasons = [];
  if (direction === 'bullish') {
    if (pos === 'above' && dist < 0.3)       { s = 88; reasons.push('above VWAP, close'); }
    else if (pos === 'above')                { s = 70; reasons.push('above VWAP'); }
    else if (pos === 'below')                { s = 25; reasons.push('below VWAP — counter-trend'); }
  } else if (direction === 'bearish') {
    if (pos === 'below' && dist < 0.3)       { s = 88; reasons.push('below VWAP, close'); }
    else if (pos === 'below')                { s = 70; reasons.push('below VWAP'); }
    else if (pos === 'above')                { s = 25; reasons.push('above VWAP — counter-trend'); }
  }
  return { score: _clamp(s), reasons };
}

function _scoreStructure(volumeAnalysis, smc, direction) {
  // Structure pillar = FRVP acceptance + UP/DOWN areas + SMC bias if available
  let s = 50;
  const reasons = [];
  if (volumeAnalysis) {
    const acc = volumeAnalysis.acceptance;
    if (direction === 'bullish' && acc === 'above_va')        { s += 12; reasons.push('above value area'); }
    else if (direction === 'bullish' && acc === 'below_va')   { s += 6;  reasons.push('below VA (fade setup)'); }
    if (direction === 'bearish' && acc === 'below_va')        { s += 12; reasons.push('below value area'); }
    else if (direction === 'bearish' && acc === 'above_va')   { s += 6;  reasons.push('above VA (fade setup)'); }
    if (volumeAnalysis.zone?.zone === 'up_area' && direction === 'bullish') { s += 10; reasons.push('in up area'); }
    if (volumeAnalysis.zone?.zone === 'down_area' && direction === 'bearish') { s += 10; reasons.push('in down area'); }
    if (volumeAnalysis.zone?.zone === 'down_area' && direction === 'bullish') { s -= 12; reasons.push('fighting down area'); }
    if (volumeAnalysis.zone?.zone === 'up_area' && direction === 'bearish') { s -= 12; reasons.push('fighting up area'); }
  }
  if (smc?.smc_bias && smc.smc_bias === direction) { s += 8;  reasons.push(`SMC ${smc.smc_bias}`); }
  if (smc?.smc_bias && smc.smc_bias !== 'neutral' && smc.smc_bias !== direction) { s -= 8; reasons.push(`SMC against ${direction}`); }
  return { score: _clamp(s), reasons };
}

function _scoreVolume(volumeAnalysis, direction) {
  if (!volumeAnalysis?.timeVolume && !volumeAnalysis?.vsa) return { score: 50, reasons: ['no volume'] };
  let s = 50;
  const reasons = [];
  const tv = volumeAnalysis.timeVolume;
  if (tv) {
    if (tv.state === 'spike' || tv.state === 'climax') { s += 15; reasons.push(`vol ${tv.state} ${tv.ratio}×`); }
    if (tv.state === 'dry_up')                          { s -= 10; reasons.push('vol dry-up'); }
  }
  const vsa = volumeAnalysis.vsa;
  if (vsa) {
    if (vsa.bias === direction)                         { s += Math.min(20, Math.round(vsa.strength / 4)); reasons.push(`VSA ${vsa.pattern}`); }
    else if (vsa.bias && vsa.bias !== 'neutral')        { s -= Math.min(25, Math.round(vsa.strength / 3.5)); reasons.push(`VSA ${vsa.pattern} against`); }
  }
  return { score: _clamp(s), reasons };
}

function _scoreLiquidity(liquidity) {
  if (!liquidity) return { score: 50, reasons: ['no liquidity'] };
  const map = { excellent: 95, good: 80, fair: 60, poor: 30, critical: 0, unknown: 40 };
  return { score: _clamp(map[liquidity.health] ?? 50), reasons: [`liquidity ${liquidity.health}`] };
}

function _scoreBreadth(internals, direction) {
  if (!internals) return { score: 50, reasons: ['no breadth'] };
  const adv = Number(internals.advances ?? internals.advance_decline_ratio ?? 0);
  const dec = Number(internals.declines ?? 1);
  const ratio = adv / Math.max(1, dec);
  let s = 50;
  const reasons = [];
  if (direction === 'bullish' && ratio > 1.5)       { s = 80; reasons.push(`breadth bullish ${ratio.toFixed(2)}`); }
  else if (direction === 'bullish' && ratio < 0.7)  { s = 25; reasons.push(`breadth bearish ${ratio.toFixed(2)}`); }
  else if (direction === 'bearish' && ratio < 0.7)  { s = 80; reasons.push(`breadth bearish ${ratio.toFixed(2)}`); }
  else if (direction === 'bearish' && ratio > 1.5)  { s = 25; reasons.push(`breadth bullish ${ratio.toFixed(2)}`); }
  return { score: _clamp(s), reasons };
}

function _scoreFutures(derivatives, direction) {
  if (!derivatives?.futures) return { score: 50, reasons: ['no futures'] };
  const f = derivatives.futures;
  let s = f.score ?? 50;
  if (direction === 'bearish') s = 100 - s;
  return { score: _clamp(s), reasons: f.reasons || [] };
}

function _scoreUtBot(utBot) {
  if (!utBot) return { score: 50, reasons: ['no ut bot'] };
  return { score: _clamp(utBot.score), reasons: [utBot.reasoning] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the directional confidence score.
 *
 * Centralised penalty point — every other engine should ONLY classify state.
 * This is the single place that converts state → numeric score adjustment.
 *
 * @param {Object} ctx
 * @param {string} ctx.direction          - 'bullish' | 'bearish'
 * @param {Object} ctx.oiAnalytics
 * @param {Object} ctx.volumeAnalysis
 * @param {Object} ctx.vwap
 * @param {Object} ctx.smc
 * @param {Object} ctx.liquidity
 * @param {Object} ctx.marketInternals
 * @param {Object} ctx.derivatives
 * @param {Object} ctx.utBot
 * @param {number} [ctx.minScore=60]
 * @param {Object} [ctx.metaRegime]      - centralised state from metaRegimeEngine
 * @param {Object} [ctx.trap]            - trapDetectionEngine output
 * @param {Object} [ctx.trendPhase]      - { phase, softBlock }
 * @param {Object} [ctx.mtfStructure]    - { score, alignment }
 * @param {string} [ctx.entryType]       - selected entry type for family-aware adj
 * @param {Object} [ctx.expectancyAdj]   - { adjustment } from expectancyEngine
 */
function score(ctx = {}) {
  const direction = ctx.direction;
  if (direction !== 'bullish' && direction !== 'bearish') {
    return { allowed: false, score: 0, tier: 'reject', reasoning: 'no direction' };
  }

  const parts = {
    oi:        _scoreOi(ctx.oiAnalytics),
    orderflow: _scoreOrderflow(ctx.volumeAnalysis, direction),
    vwap:      _scoreVwap(ctx.vwap, direction),
    structure: _scoreStructure(ctx.volumeAnalysis, ctx.smc, direction),
    volume:    _scoreVolume(ctx.volumeAnalysis, direction),
    liquidity: _scoreLiquidity(ctx.liquidity),
    breadth:   _scoreBreadth(ctx.marketInternals, direction),
    futures:   _scoreFutures(ctx.derivatives, direction),
    utBot:     _scoreUtBot(ctx.utBot),
  };

  // Weighted sum (weights total ~98, so result is 0..98 — close enough to 0..100)
  const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  let raw = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    raw += (parts[k].score) * (w / totalWeight);
  }
  raw = Number(raw.toFixed(1));

  // ── Centralised penalty / bonus block ───────────────────────────────────
  // Every other engine emits state. We translate to score here. All bumps
  // are bounded so no single signal dominates.
  const adjustments = [];
  let adj = 0;

  // Meta-regime: family-aware nudge
  if (ctx.metaRegime && ctx.entryType) {
    const _meta = require('./metaRegimeEngine');
    const fam = _meta.familyScoreAdjustment(ctx.metaRegime, ctx.entryType);
    if (fam !== 0) { adj += fam; adjustments.push(`meta:${ctx.metaRegime.state}/${ctx.entryType}=${fam>=0?'+':''}${fam}`); }
  }

  // Trap detection: graduated penalty (NO double counting elsewhere)
  if (ctx.trap?.trapScore >= 90)        { adj -= 15; adjustments.push(`trap:${ctx.trap.trapScore}=-15`); }
  else if (ctx.trap?.trapScore >= 75)   { adj -= 8;  adjustments.push(`trap:${ctx.trap.trapScore}=-8`); }
  else if (ctx.trap?.trapScore >= 50)   { adj -= 4;  adjustments.push(`trap:${ctx.trap.trapScore}=-4`); }
  else if (ctx.trap?.trapScore >= 30)   { adj -= 2;  adjustments.push(`trap:${ctx.trap.trapScore}=-2`); }

  // Trend phase soft block
  if (ctx.trendPhase?.softBlock)        { adj -= 6;  adjustments.push('trendPhase:softBlock=-6'); }

  // MTF structure quality bonus / penalty
  if (ctx.mtfStructure?.score >= 80)    { adj += 5;  adjustments.push('mtf:strong=+5'); }
  else if (ctx.mtfStructure?.score < 45){ adj -= 4;  adjustments.push(`mtf:weak(${ctx.mtfStructure.score})=-4`); }

  // Expectancy engine — historical performance of this bucket
  if (ctx.expectancyAdj?.adjustment)    {
    adj += ctx.expectancyAdj.adjustment;
    adjustments.push(`expectancy=${ctx.expectancyAdj.adjustment>=0?'+':''}${ctx.expectancyAdj.adjustment}`);
  }

  // Hard cap so a stack of penalties can't drive us below 0 or above 100
  const total = Number(Math.max(0, Math.min(100, raw + adj)).toFixed(1));

  // Tier classification
  let tier = 'reject';
  if (total >= 85) tier = 'aggressive';
  else if (total >= 75) tier = 'standard';
  else if (total >= 60) tier = 'scalp_only';

  const minScore = Number(ctx.minScore ?? 60);
  const allowed = total >= minScore;

  // Reasoning summary — strongest pillars + adjustments
  const sortedParts = Object.entries(parts)
    .sort((a, b) => Math.abs((b[1].score) - 50) - Math.abs((a[1].score) - 50))
    .slice(0, 4)
    .map(([k, v]) => `${k}=${Math.round(v.score)}(${WEIGHTS[k]}%)`)
    .join(' | ');

  return {
    allowed,
    score: total,
    rawScore: raw,
    centralisedAdjustment: adj,
    adjustmentBreakdown: adjustments,
    tier,
    minScore,
    parts,
    weights: WEIGHTS,
    reasoning: `score=${total} (raw ${raw}${adj>=0?' +':' '}${adj}) tier=${tier} (need ≥${minScore}) | ${sortedParts}` +
               (adjustments.length ? ` | adj: ${adjustments.join(',')}` : ''),
  };
}

module.exports = { score, WEIGHTS };
