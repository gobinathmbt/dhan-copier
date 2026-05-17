// Analyzer: for each zero-trade day, find what blocked the cycles.
// Outputs the most common block reasons aggregated across zero-trade days.
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || (() => {
  const dir = path.resolve(__dirname, '..', 'logs');
  const f = fs.readdirSync(dir).filter(x => /^backtest-.*\.log$/.test(x))
    .map(x => ({ x, t: fs.statSync(path.join(dir, x)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  return path.join(dir, f.x);
})();
console.log('Analyzing:', path.basename(file));

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const dayBlocks = {};                 // dayLabel -> { reasonHead -> count }
const dayTrades = {};
const dayMetaCounts = {};             // dayLabel -> { meta -> count }

for (const ln of lines) {
  let o; try { o = JSON.parse(ln); } catch { continue; }
  const data = o.data || {};

  if (o.source === 'backtest' && o.message === 'cycle_decision') {
    const day = data.dayLabel;
    if (!dayBlocks[day]) dayBlocks[day] = {};
    if (!dayTrades[day]) dayTrades[day] = 0;
    if (data.signal === 'NO_TRADE') {
      const r = (data.reasoning || '').slice(0, 90);
      // Extract the head of the reason (before ':')
      const head = r.split(':').slice(0, 2).join(':').trim();
      dayBlocks[day][head] = (dayBlocks[day][head] || 0) + 1;
    } else {
      dayTrades[day]++;
    }
  }
  if (o.source === 'hybrid:meta_regime') {
    // Track meta regimes per day (need lastDayLabel)
    // Skip for now
  }
}

// Show only days with 0 trades
console.log('\n--- ZERO-TRADE DAYS BLOCK ANALYSIS ---');
const zeroDays = Object.entries(dayTrades).filter(([d, t]) => t === 0).map(([d]) => d);
console.log(`${zeroDays.length} zero-trade days\n`);

// Aggregate block reasons across zero-trade days
const aggBlocks = {};
for (const d of zeroDays) {
  for (const [reason, count] of Object.entries(dayBlocks[d] || {})) {
    aggBlocks[reason] = (aggBlocks[reason] || 0) + count;
  }
}

console.log('TOP BLOCK REASONS ACROSS ALL ZERO-TRADE DAYS:');
Object.entries(aggBlocks).sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([r, n]) => {
  console.log(`  ${String(n).padStart(5)} : ${r}`);
});

// Per-day breakdown
console.log('\nPER-DAY BLOCK SUMMARY (zero-trade days only):');
for (const d of zeroDays) {
  const total = Object.values(dayBlocks[d] || {}).reduce((a, b) => a + b, 0);
  const top = Object.entries(dayBlocks[d] || {}).sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${d}: ${total} blocks | top: ${top?.[1]}× ${top?.[0]?.slice(0, 80)}`);
}
