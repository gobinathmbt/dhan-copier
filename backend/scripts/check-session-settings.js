const fs = require('fs');
const file = process.argv[2] || 'logs/session-6a0bf1c8cf08df6c3692066b-2026-05-19.json';
const raw = fs.readFileSync(file, 'utf8');
// File is huge; pull just the settings object
const m = raw.match(/"settings"\s*:\s*\{[^}]*\}/);
if (m) {
  console.log('SETTINGS BLOCK:');
  console.log(m[0]);
} else {
  // Some keys
  for (const key of ['minEntryPremium', 'minConfidence', 'maxConcurrentTrades', 'targetPoints', 'slPoints', 'lotSize', 'minLots', 'maxLots']) {
    const r = new RegExp('"' + key + '"\\s*:\\s*([^,}\\]\\s]+)');
    const x = raw.match(r);
    console.log(`  ${key}: ${x ? x[1] : 'not found'}`);
  }
}
