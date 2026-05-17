/**
 * Trade Quality Classifier
 * ------------------------
 * Tags every entry with a grade so we can analyse expectancy by quality bucket.
 *
 *   A+  full institutional alignment (score ≥ 85, all hard gates green,
 *        derivatives strongly aligned, liquidity good, regime trending)
 *   A   strong setup
 *   B   moderate
 *   C   weak — only allowed in aggressive mode
 *   D   would normally be skipped
 *
 * The classifier doesn't gate by itself — it returns a grade that the entry
 * engine can use to refuse low grades when the user wants to be selective.
 */

function classify({ score, derivatives, liquidity, marketRegime, riskMode } = {}) {
  const s = Number(score) || 0;
  const reasons = [];

  // Penalties
  let penalty = 0;
  if (liquidity?.health === 'fair') { penalty += 5; reasons.push('liquidity fair'); }
  if (liquidity?.health === 'poor') { penalty += 15; reasons.push('liquidity poor'); }
  if (marketRegime?.regime === 'ranging') { penalty += 5; reasons.push('regime ranging'); }
  if (riskMode === 'defensive') { penalty += 5; reasons.push('risk defensive'); }
  if (riskMode === 'survival')  { penalty += 15; reasons.push('risk survival'); }
  if (derivatives && Math.abs((derivatives.directionScore || 50) - 50) < 8) {
    penalty += 5;
    reasons.push('derivatives weak');
  }

  // Bonuses
  let bonus = 0;
  if (derivatives && Math.abs((derivatives.directionScore || 50) - 50) > 20) {
    bonus += 5;
    reasons.push('derivatives strong');
  }
  if (marketRegime?.regime === 'trending_bullish' || marketRegime?.regime === 'trending_bearish') {
    bonus += 5;
    reasons.push('regime trending');
  }

  const adjScore = s - penalty + bonus;

  let grade = 'D';
  if (adjScore >= 85) grade = 'A+';
  else if (adjScore >= 75) grade = 'A';
  else if (adjScore >= 65) grade = 'B';
  else if (adjScore >= 55) grade = 'C';
  else grade = 'D';

  return {
    grade,
    score: s,
    adjustedScore: Number(adjScore.toFixed(1)),
    penalty,
    bonus,
    reasoning: reasons.join(' | '),
  };
}

module.exports = { classify };
