/**
 * Probability Decay Engine
 * ------------------------
 * For OPEN trades, monitors signal-strength deterioration:
 *   - delta weakening
 *   - volume fading
 *   - OI momentum slowing
 *   - breadth deteriorating
 *
 * Returns a "confidence decay" 0..1 where 1 = signal still strong, 0 = gone.
 * If decay drops below the configured floor, monitor will EXIT.
 *
 * The logic is purely structural — no AI involvement. We compare the current
 * snapshot to the entry snapshot stored on the trade.
 */

function _safe(n, fb = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fb;
}

/**
 * @param {Object} opts
 * @param {Object} opts.trade            - ScalpingTrade with hybridEntrySnapshot
 * @param {Object} opts.currentScore     - probabilityScoringEngine.score(...) result for current ctx
 * @param {Object} opts.currentDerivatives - derivativesEngine.analyze(...) for current ctx
 * @param {Object} opts.currentVwap      - { position, distance_pct }
 * @returns {Object} { decay (0..1), reasons, exit }
 */
function evaluate({ trade, currentScore = null, currentDerivatives = null, currentVwap = null } = {}) {
  if (!trade) return { decay: 1, reasons: ['no trade'], exit: false };

  const reasons = [];
  let decay = 1.0;

  const direction = trade.signal === 'BUY_CE' ? 'bullish' : 'bearish';
  const snapshot  = trade.hybridEntrySnapshot || trade.aiEntryDecision?.hybridSnapshot || null;

  // 1. Score decay vs entry score
  if (snapshot?.score && currentScore?.score) {
    const drop = snapshot.score - currentScore.score;
    if (drop > 15) {
      decay -= 0.4;
      reasons.push(`score dropped ${drop.toFixed(1)}pts (${snapshot.score}→${currentScore.score})`);
    } else if (drop > 8) {
      decay -= 0.2;
      reasons.push(`score weakening (${drop.toFixed(1)}pts down)`);
    }
  }

  // 2. Derivatives bias flipped against us
  if (currentDerivatives) {
    const wantedBias = direction;
    if (currentDerivatives.overallBias && currentDerivatives.overallBias !== 'neutral'
        && currentDerivatives.overallBias !== wantedBias) {
      decay -= 0.3;
      reasons.push(`derivatives bias flipped to ${currentDerivatives.overallBias}`);
    }
  }

  // 3. VWAP flipped against us
  if (currentVwap) {
    const pos = currentVwap.position || currentVwap.price_vs_vwap;
    if (direction === 'bullish' && pos === 'below') {
      decay -= 0.3;
      reasons.push('price flipped below VWAP');
    } else if (direction === 'bearish' && pos === 'above') {
      decay -= 0.3;
      reasons.push('price flipped above VWAP');
    }
  }

  // 4. Hard tier-2 collapse (current tier2 score < 50 for the trade direction)
  if (currentScore && _safe(currentScore.weightedScore, 50) < 45) {
    decay -= 0.2;
    reasons.push(`tier2 weighted ${currentScore.weightedScore}`);
  }

  decay = Number(Math.max(0, Math.min(1, decay)).toFixed(2));

  // If decay below 0.4 → recommend exit
  const exit = decay < 0.4;

  return {
    decay,
    exit,
    reasons,
    reasoning: reasons.length ? reasons.join(' | ') : 'no decay detected',
  };
}

module.exports = { evaluate };
