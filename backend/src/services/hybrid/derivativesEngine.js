/**
 * Derivatives Intelligence Engine
 * -------------------------------
 * The institutional edge for index-options trading. Reads:
 *   - option chain (ATM ± N strikes with OI / IV / greeks / volume)
 *   - PCR (overall + ATM)
 *   - max-pain
 *   - futures premium / spread / momentum
 *   - existing order-flow analysis
 *
 * Produces a directional bias score with reasoning:
 *   - oiBias    : 'bullish' | 'bearish' | 'neutral'
 *   - oiScore   : 0..100 — strength of OI evidence in either direction
 *   - pcrBias   : same
 *   - futBias   : 'bullish' | 'bearish' | 'neutral'
 *   - gammaPress: 'bullish' | 'bearish' | 'neutral'
 *   - directionScore: aggregated 0..100 (50 = neutral, > 50 = bullish)
 *   - allowedDirections: ['bullish'] | ['bearish'] | ['bullish','bearish']
 *
 * This is a Tier 2 weighted input — it never hard-blocks, it only biases the
 * final score. Hard gates live in probabilityScoringEngine.
 */

function _safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Score OI build-up across ATM ± N strikes.
 * Aggressive PE writing (PE OI ↑ + PE price ↓ or stable) = bullish
 * Aggressive CE writing (CE OI ↑ + CE price ↓ or stable) = bearish
 */
function _oiAnalysis(strikes, atmStrike) {
  if (!strikes || !strikes.length || !atmStrike) {
    return { bias: 'neutral', score: 50, reasons: ['no strikes'] };
  }
  let ceOiAdd = 0, peOiAdd = 0, ceOiCut = 0, peOiCut = 0;
  let ceVolume = 0, peVolume = 0;
  for (const s of strikes) {
    const ceChg = _safeNum(s.call?.oiChange ?? s.ce?.oiChg);
    const peChg = _safeNum(s.put?.oiChange  ?? s.pe?.oiChg);
    if (ceChg > 0) ceOiAdd += ceChg; else ceOiCut += Math.abs(ceChg);
    if (peChg > 0) peOiAdd += peChg; else peOiCut += Math.abs(peChg);
    ceVolume += _safeNum(s.call?.volume ?? s.ce?.vol);
    peVolume += _safeNum(s.put?.volume  ?? s.pe?.vol);
  }

  const reasons = [];
  // PE writing > CE writing → bullish bias
  // CE writing > PE writing → bearish bias
  let bias = 'neutral';
  let score = 50;
  if (peOiAdd > ceOiAdd * 1.3) {
    bias = 'bullish';
    score = Math.min(85, 50 + (peOiAdd - ceOiAdd) / Math.max(1, peOiAdd) * 50);
    reasons.push('PE OI build-up > CE OI build-up (bullish)');
  } else if (ceOiAdd > peOiAdd * 1.3) {
    bias = 'bearish';
    score = Math.max(15, 50 - (ceOiAdd - peOiAdd) / Math.max(1, ceOiAdd) * 50);
    reasons.push('CE OI build-up > PE OI build-up (bearish)');
  } else {
    reasons.push('OI build-up balanced');
  }

  // Short covering / unwinding boost
  if (ceOiCut > ceOiAdd && bias === 'bullish') {
    score = Math.min(95, score + 10);
    reasons.push('CE short covering reinforces bullish');
  }
  if (peOiCut > peOiAdd && bias === 'bearish') {
    score = Math.min(95, 100 - score) > score ? Math.min(95, score) : Math.max(5, score - 10);
    // Mirror to bearish strength
    if (bias === 'bearish') reasons.push('PE long unwinding reinforces bearish');
  }

  return {
    bias,
    score: Math.round(score),
    ceOiAdd, peOiAdd, ceOiCut, peOiCut,
    ceVolume, peVolume,
    reasons,
  };
}

function _pcrAnalysis(pcr) {
  if (!Number.isFinite(pcr)) return { bias: 'neutral', score: 50, reasons: ['no pcr'] };
  // PCR > 1 → more puts (bullish reading on contrarian basis up to 1.5)
  // PCR < 1 → more calls (bearish above 0.7-0.8)
  if (pcr >= 1.3) return { bias: 'bullish', score: 70, reasons: [`PCR ${pcr.toFixed(2)} bullish`] };
  if (pcr <= 0.7) return { bias: 'bearish', score: 30, reasons: [`PCR ${pcr.toFixed(2)} bearish`] };
  return { bias: 'neutral', score: 50, reasons: [`PCR ${pcr.toFixed(2)} neutral`] };
}

function _futuresAnalysis(futuresData) {
  if (!futuresData) return { bias: 'neutral', score: 50, reasons: ['no futures data'] };

  const dir = futuresData.direction || futuresData.futures_direction || 'neutral';
  const mom = futuresData.momentum  || futuresData.futures_momentum  || 'neutral';
  const trend = futuresData.trend   || futuresData.futures_trend     || 'neutral';
  const change1m = _safeNum(futuresData.change_1m ?? futuresData.futures_1m_change);
  const divergence = futuresData.divergence ?? futuresData.spot_futures_divergence ?? null;

  let bias = 'neutral';
  let score = 50;
  const reasons = [];

  if (dir === 'bullish' || trend === 'uptrend' || change1m > 0) {
    bias = 'bullish';
    score = 65;
    reasons.push(`futures ${dir}/${trend}`);
  } else if (dir === 'bearish' || trend === 'downtrend' || change1m < 0) {
    bias = 'bearish';
    score = 35;
    reasons.push(`futures ${dir}/${trend}`);
  }

  if (mom === 'strong' && bias === 'bullish') { score = Math.min(85, score + 15); reasons.push('strong momentum'); }
  if (mom === 'strong' && bias === 'bearish') { score = Math.max(15, score - 15); reasons.push('strong momentum'); }

  if (divergence) reasons.push(`spot/futures divergence: ${divergence}`);
  return { bias, score, reasons };
}

function _maxPainAnalysis(maxPain, spotPrice) {
  if (!Number.isFinite(maxPain) || !Number.isFinite(spotPrice)) {
    return { bias: 'neutral', score: 50, reasons: ['no max pain'] };
  }
  const dist = spotPrice - maxPain;
  // Market gravitates to max pain. Above max-pain → expected to drift down.
  if (dist > 25)  return { bias: 'bearish', score: 40, reasons: [`spot ${dist.toFixed(0)}pts above max-pain`] };
  if (dist < -25) return { bias: 'bullish', score: 60, reasons: [`spot ${Math.abs(dist).toFixed(0)}pts below max-pain`] };
  return { bias: 'neutral', score: 50, reasons: [`near max-pain ${maxPain}`] };
}

function _gammaAnalysis(gammaExposure, spotPrice) {
  if (!gammaExposure) return { bias: 'neutral', score: 50, reasons: ['no gamma'] };
  // Use the gamma flip / dealer position when available.
  const flip = gammaExposure.gamma_flip;
  const totalGex = _safeNum(gammaExposure.total_gex);
  const dealerPos = gammaExposure.dealer_positioning;

  let bias = 'neutral';
  let score = 50;
  const reasons = [];

  if (Number.isFinite(flip) && Number.isFinite(spotPrice)) {
    if (spotPrice > flip + 25) { bias = 'bullish'; score = 60; reasons.push(`above gamma flip ${flip}`); }
    else if (spotPrice < flip - 25) { bias = 'bearish'; score = 40; reasons.push(`below gamma flip ${flip}`); }
  }
  if (dealerPos === 'short_gamma') reasons.push('dealers short gamma — expect amplified moves');
  if (dealerPos === 'long_gamma')  reasons.push('dealers long gamma — expect dampened moves');
  if (totalGex) reasons.push(`total GEX ${Math.round(totalGex)}`);
  return { bias, score, reasons };
}

/**
 * Aggregate everything into a single direction score 0..100.
 * Weights inside derivatives:
 *   OI 35% | Futures 25% | PCR 15% | Gamma 15% | MaxPain 10%
 */
function analyze({
  optionChain = null,
  primaryStrikes = null,
  pcr = null,
  maxPain = null,
  gammaExposure = null,
  futuresData = null,
  spotPrice = null,
  atmStrike = null,
} = {}) {
  const strikes = primaryStrikes
    || optionChain?.strikes
    || [];

  const oi      = _oiAnalysis(strikes, atmStrike);
  const pcrR    = _pcrAnalysis(pcr ?? optionChain?.pcr_oi ?? optionChain?.pcr_total);
  const fut     = _futuresAnalysis(futuresData);
  const gamma   = _gammaAnalysis(gammaExposure, spotPrice);
  const maxP    = _maxPainAnalysis(
    maxPain ?? optionChain?.max_pain ?? optionChain?.max_pain_strike,
    spotPrice
  );

  const weights = { oi: 0.35, fut: 0.25, pcr: 0.15, gamma: 0.15, maxP: 0.10 };
  const directionScore =
      oi.score    * weights.oi
    + fut.score   * weights.fut
    + pcrR.score  * weights.pcr
    + gamma.score * weights.gamma
    + maxP.score  * weights.maxP;

  let overallBias = 'neutral';
  if (directionScore >= 60) overallBias = 'bullish';
  else if (directionScore <= 40) overallBias = 'bearish';

  // Allowed directions — both unless something is *strongly* one way.
  let allowedDirections = ['bullish', 'bearish'];
  if (directionScore >= 70) allowedDirections = ['bullish'];
  else if (directionScore <= 30) allowedDirections = ['bearish'];

  return {
    oi,
    pcr: pcrR,
    futures: fut,
    gamma,
    maxPain: maxP,
    directionScore: Number(directionScore.toFixed(1)),
    overallBias,
    allowedDirections,
    reasoning: [
      ...oi.reasons,
      ...fut.reasons,
      ...pcrR.reasons,
      ...gamma.reasons,
      ...maxP.reasons,
    ].join(' | '),
  };
}

module.exports = { analyze };
