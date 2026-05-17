const { spawnSync } = require('child_process');
const files = [
  'src/services/hybrid/marketAuctionEngine.js',
  'src/services/hybrid/gammaRegimeEngine.js',
  'src/services/hybrid/mtfStructureEngine.js',
  'src/services/hybrid/orderflowStateEngine.js',
  'src/services/hybrid/trendPhaseEngine.js',
  'src/services/hybrid/entryTypeEngine.js',
  'src/services/hybrid/adaptiveExitEngine.js',
  'src/services/hybrid/expiryBehaviorEngine.js',
  'src/services/hybrid/aggressionModeEngine.js',
  'src/services/hybrid/expectancyEngine.js',
  'src/services/hybrid/strikeSelector.js',
  'src/services/hybrid/hybridEntryEngine.js',
  'src/services/hybrid/hybridMonitorEngine.js',
  'src/services/hybrid/index.js',
  'scripts/backtest-hybrid.js',
];
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('FAIL', f); console.log(r.stderr); failed++; }
  else console.log('OK  ', f);
}
process.exit(failed ? 1 : 0);
