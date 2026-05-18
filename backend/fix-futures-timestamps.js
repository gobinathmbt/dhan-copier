// One-time fix: convert futures candle timestamps from ms -> seconds.
// Safe to run repeatedly -- it only converts 13-digit entries to 10-digit.
//
// Why this exists:
//   futures-ticks.jsonl uses Date.now() (milliseconds) for `t`.
//   futuresCandleAggregator was emitting candle.time in ms.
//   Spot candles + hybrid engine use seconds.
//   Result: candle synthesizer treated futures as year ~56347.
//
// The aggregator source is now fixed (emits seconds). This script cleans
// up any legacy ms entries written by the old code before restart.
const fs = require('fs');
const path = require('path');

const today = new Date().toISOString().slice(0, 10);
const folder = path.join('live-feed', `${today}_NIFTY_50`);

if (!fs.existsSync(folder)) {
  console.log('No folder for today:', folder);
  process.exit(0);
}

let totalFixed = 0;
for (const interval of ['1m', '5m', '15m']) {
  const file = path.join(folder, `futures-${interval}.jsonl`);
  if (!fs.existsSync(file)) continue;

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const fixed = [];
  let convertedCount = 0;
  const seen = new Set();

  for (const line of lines) {
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (!obj.t) continue;
    if (String(obj.t).length >= 13) {
      obj.t = Math.floor(obj.t / 1000);
      convertedCount++;
    }
    // Dedup on timestamp (the aggregator may write the same candle twice)
    if (seen.has(obj.t)) continue;
    seen.add(obj.t);
    fixed.push(JSON.stringify(obj));
  }

  fixed.sort((a, b) => JSON.parse(a).t - JSON.parse(b).t);
  fs.writeFileSync(file, fixed.join('\n') + '\n');
  console.log(`futures-${interval}: ${lines.length} -> ${fixed.length} lines (converted ${convertedCount}, deduped ${lines.length - fixed.length - convertedCount})`);
  totalFixed += convertedCount;
}
console.log(`Total fixed: ${totalFixed} entries`);
