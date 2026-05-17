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
 * @param {Object} [opts.currentVolumeAnalysis] - volumeAnalysisEngine.analyze(...) for current ctx
 * @param {Object} [opts.currentOiAnalytics]    - oiAnalyticsEngine.analyze(...) for current ctx
 * @param {Object} [opts.currentUtBot]          - utBotEngine.evaluate(...) for current ctx
 * @returns {Object} { decay (0..1), reasons, exit }
 */
function evaluate({
  trade,
  currentScore = null,
  currentDerivatives = null,
  currentVwap = null,
  currentVolumeAnalysis = null,
  currentOiAnalytics = null,
  currentUtBot = null,
} = {}) {
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

  // 5. FRVP acceptance flipped against us
  //    - long with entry above_va that is now below_va → buyers lost the area
  //    - short with entry below_va that is now above_va → sellers lost the area
  if (currentVolumeAnalysis && snapshot?.volume?.acceptance) {
    const before = snapshot.volume.acceptance;
    const after  = currentVolumeAnalysis.acceptance;
    if (direction === 'bullish' && before !== 'below_va' && after === 'below_va') {
      decay -= 0.25;
      reasons.push(`FRVP acceptance flipped to below_va (was ${before})`);
    }
    if (direction === 'bearish' && before !== 'above_va' && after === 'above_va') {
      decay -= 0.25;
      reasons.push(`FRVP acceptance flipped to above_va (was ${before})`);
    }
  }

  // 6. VSA pattern actively against us on the latest candle
  if (currentVolumeAnalysis?.vsa?.bias && currentVolumeAnalysis.vsa.bias !== 'neutral'
      && currentVolumeAnalysis.vsa.bias !== direction) {
    const strength = Number(currentVolumeAnalysis.vsa.strength) || 0;
    if (strength >= 70) {
      decay -= 0.2;
      reasons.push(`VSA ${currentVolumeAnalysis.vsa.pattern} against ${direction}`);
    } else if (strength >= 50) {
      decay -= 0.1;
      reasons.push(`VSA weak ${currentVolumeAnalysis.vsa.pattern} against ${direction}`);
    }
  }

  // 7. Delta flipped against direction (mid-trade order-flow reversal)
  if (currentVolumeAnalysis?.delta?.bias) {
    const dBias = currentVolumeAnalysis.delta.bias;
    const dStr  = Number(currentVolumeAnalysis.delta.strength) || 0;
    const opposes = (direction === 'bullish' && (dBias === 'bearish' || dBias === 'mild_bearish'))
                 || (direction === 'bearish' && (dBias === 'bullish' || dBias === 'mild_bullish'));
    if (opposes) {
      if (dStr >= 60) {
        decay -= 0.25;
        reasons.push(`delta flipped strong ${dBias} (${currentVolumeAnalysis.delta.cvdPctLong}%)`);
      } else if (dStr >= 30) {
        decay -= 0.12;
        reasons.push(`delta flipped ${dBias} (${currentVolumeAnalysis.delta.cvdPctLong}%)`);
      }
    }
    // Hidden absorption against the trade — early reversal warning
    if (currentVolumeAnalysis.delta.divergence !== 'none'
        && currentVolumeAnalysis.delta.divergenceBias !== 'neutral'
        && currentVolumeAnalysis.delta.divergenceBias !== direction) {
      decay -= 0.15;
      reasons.push(`absorption against ${direction}: ${currentVolumeAnalysis.delta.divergenceReason}`);
    }
  }

  // 8. Price moved into the opposing control area (UP/DOWN area flip)
  if (currentVolumeAnalysis?.zone?.zone && snapshot?.volume?.zone) {
    const wantedZone = direction === 'bullish' ? 'up_area' : 'down_area';
    const opposingZone = direction === 'bullish' ? 'down_area' : 'up_area';
    if (snapshot.volume.zone !== opposingZone && currentVolumeAnalysis.zone.zone === opposingZone) {
      decay -= 0.18;
      reasons.push(`price entered opposing control area (${currentVolumeAnalysis.zone.zone})`);
    }
  }

  // 9. UT Bot reversal — 5m UT Bot now opposes the trade direction
  if (currentUtBot?.perTimeframe?.['5m']?.trend) {
    const tf5 = currentUtBot.perTimeframe['5m'].trend;
    const wantTrend = direction === 'bullish' ? 'bearish' : 'bullish';
    const entry5 = snapshot?.utBot?.utBot5mTrend;
    if (tf5 === wantTrend && entry5 !== wantTrend) {
      decay -= 0.25;
      reasons.push(`UT Bot 5m flipped to ${tf5}`);
    }
  }

  // 10. OI velocity reversed against the trade
  if (currentOiAnalytics?.diff) {
    const ceVel = Number(currentOiAnalytics.diff.ceVelocity) || 0;
    const peVel = Number(currentOiAnalytics.diff.peVelocity) || 0;
    if (direction === 'bullish' && ceVel > 200 && peVel < 0) {
      decay -= 0.2;
      reasons.push(`CE writers piling in (vel ${ceVel.toFixed(0)}/s) while PE unwinding`);
    }
    if (direction === 'bearish' && peVel > 200 && ceVel < 0) {
      decay -= 0.2;
      reasons.push(`PE writers piling in (vel ${peVel.toFixed(0)}/s) while CE unwinding`);
    }
    // Aggressive against-direction OI build
    if (currentOiAnalytics.regime === 'aggressive_short_buildup' && direction === 'bullish') {
      decay -= 0.18; reasons.push('aggressive short buildup against long');
    }
    if (currentOiAnalytics.regime === 'aggressive_long_buildup' && direction === 'bearish') {
      decay -= 0.18; reasons.push('aggressive long buildup against short');
    }
  }

  // 11. OI absorption against direction (institutional defense forming)
  if (currentOiAnalytics?.absorption?.detected) {
    const side = currentOiAnalytics.absorption.side;
    if (direction === 'bullish' && side === 'ce') {
      decay -= 0.12; reasons.push('CE absorption forming bearish ceiling');
    }
    if (direction === 'bearish' && side === 'pe') {
      decay -= 0.12; reasons.push('PE absorption forming bullish floor');
    }
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
