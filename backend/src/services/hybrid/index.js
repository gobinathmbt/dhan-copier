/**
 * Hybrid Engine — Public Surface
 * ==============================
 * Re-exports the only two functions the rest of the codebase needs:
 *
 *   const { entry, monitor } = require('./hybrid');
 *   entry.decide({ ... });
 *   monitor.decide({ ... });
 *
 * All sub-engines (session, regime, scoring, etc.) are also exported under
 * their own keys for unit tests or advanced wiring, but the standard usage is
 * through `entry` and `monitor`.
 *
 * Hybrid philosophy: deterministic core, AI advisory only.
 */

const entry   = require('./hybridEntryEngine');
const monitor = require('./hybridMonitorEngine');

module.exports = {
  entry,
  monitor,
  sessionEngine:            require('./sessionEngine'),
  volatilityRegimeEngine:   require('./volatilityRegimeEngine'),
  marketRegimeEngine:       require('./marketRegimeEngine'),
  marketStructureEngine:    require('./marketStructureEngine'),
  liquidityEngine:          require('./liquidityEngine'),
  derivativesEngine:        require('./derivativesEngine'),
  volumeAnalysisEngine:     require('./volumeAnalysisEngine'),
  tickDeltaClassifier:      require('./tickDeltaClassifier'),
  probabilityScoringEngine: require('./probabilityScoringEngine'),
  probabilityDecayEngine:   require('./probabilityDecayEngine'),
  riskEngine:               require('./riskEngine'),
  executionQualityEngine:   require('./executionQualityEngine'),
  tradeQualityClassifier:   require('./tradeQualityClassifier'),
  strikeSelector:           require('./strikeSelector'),
  positionStateMachine:     require('./positionStateMachine'),
  aiAdvisoryLayer:          require('./aiAdvisoryLayer'),
  hybridLogger:             require('./hybridLogger'),
};
