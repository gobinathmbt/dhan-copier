/**
 * Hybrid Engine — Public Surface
 * ==============================
 * Re-exports the master scalping entry / monitor pair which routes each
 * cycle to the active engine (ULTRA_SCALP / SUPPORT_SCALP / CORE) based
 * on settings flags.
 *
 *   const { entry, monitor } = require('./hybrid');
 *   entry.decide({ ... });
 *   monitor.decide({ ... });
 *
 * Each call inspects `settings.ultraScalpingEngine`, `.supportScalpEngine`,
 * `.coreEngine` and routes accordingly. The trade record is stamped with
 * `engineType` so the monitor can route exits to the matching sub-engine.
 *
 * All sub-engines (session, regime, scoring, etc.) are also exported under
 * their own keys for unit tests or advanced wiring.
 *
 * Hybrid philosophy: deterministic core, AI advisory only.
 */

// Master entry & monitor — these handle routing internally.
const entry   = require('./masterScalpingEntryEngine');
const monitor = require('./masterScalpingMonitorEngine');

// Legacy hybrid entry & monitor — exposed under `core.*` for direct
// access, and used internally by the master engines when coreEngine=true.
const coreEntry   = require('./hybridEntryEngine');
const coreMonitor = require('./hybridMonitorEngine');

module.exports = {
  entry,
  monitor,
  // Direct access to the legacy core engine
  core: { entry: coreEntry, monitor: coreMonitor },
  // Direct access to the new dedicated scalp engines
  ultraScalp:   require('./ultraScalpEngine'),
  ultraStrike:  require('./ultraScalpStrikeSelector'),
  supportScalp: require('./supportScalpEngine'),
  supportStrike: require('./supportScalpStrikeSelector'),
  runnerExit:   require('./runnerExitEngine'),
  // Sub-engines (kept exported for unit tests / advanced wiring)
  sessionEngine:            require('./sessionEngine'),
  volatilityRegimeEngine:   require('./volatilityRegimeEngine'),
  marketRegimeEngine:       require('./marketRegimeEngine'),
  marketStructureEngine:    require('./marketStructureEngine'),
  liquidityEngine:          require('./liquidityEngine'),
  derivativesEngine:        require('./derivativesEngine'),
  volumeAnalysisEngine:     require('./volumeAnalysisEngine'),
  tickDeltaClassifier:      require('./tickDeltaClassifier'),
  oiAnalyticsEngine:        require('./oiAnalyticsEngine'),
  utBotEngine:              require('./utBotEngine'),
  strategySelector:         require('./strategySelector'),
  confidenceScoringEngine:  require('./confidenceScoringEngine'),
  // Phase 1 institutional upgrades
  multiDayContextEngine:    require('./multiDayContextEngine'),
  structuralTargetEngine:   require('./structuralTargetEngine'),
  trapDetectionEngine:      require('./trapDetectionEngine'),
  // Phase 2-5 institutional upgrades
  marketAuctionEngine:      require('./marketAuctionEngine'),
  gammaRegimeEngine:        require('./gammaRegimeEngine'),
  mtfStructureEngine:       require('./mtfStructureEngine'),
  orderflowStateEngine:     require('./orderflowStateEngine'),
  trendPhaseEngine:         require('./trendPhaseEngine'),
  entryTypeEngine:          require('./entryTypeEngine'),
  adaptiveExitEngine:       require('./adaptiveExitEngine'),
  expiryBehaviorEngine:     require('./expiryBehaviorEngine'),
  aggressionModeEngine:     require('./aggressionModeEngine'),
  expectancyEngine:         require('./expectancyEngine'),
  metaRegimeEngine:         require('./metaRegimeEngine'),
  probabilityScoringEngine: require('./probabilityScoringEngine'),
  probabilityDecayEngine:   require('./probabilityDecayEngine'),
  riskEngine:               require('./riskEngine'),
  executionQualityEngine:   require('./executionQualityEngine'),
  tradeQualityClassifier:   require('./tradeQualityClassifier'),
  strikeSelector:           require('./strikeSelector'),
  positionStateMachine:     require('./positionStateMachine'),
  aiAdvisoryLayer:          require('./aiAdvisoryLayer'),
  hybridLogger:             require('./hybridLogger'),
  // Phase 6 (institutional spec 2026-05-18)
  microstructureEngine:     require('./microstructureEngine'),
  futuresLeadershipEngine:  require('./futuresLeadershipEngine'),
  deltaVelocityEngine:      require('./deltaVelocityEngine'),
};
