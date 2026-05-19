// One-time dedupe of live-feed jsonl files for the given date.
// Reads each candles-*.jsonl / futures-*.jsonl, dedupes by `t` (normalised
// to seconds), and rewrites the file. Run after restarting the recorder.
//
// Usage: node scripts/dedupe-livefeed.js [YYYY-MM-DD]
const fs = require('fs');
const path = require('path');

const date = process.argv[2] || (() => {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
})();

const folder = path.resolve(__dirname, `../live-feed/${date}_NIFTY_50`);
console.log('Folder:', folder);
if (!fs.existsSync(folder)) {
  console.error('Folder missing — nothing to do');
  process.exit(1);
}

const files = fs.readdirSync(folder).filter(f =>
  /^(candles|futures)-(1m|5m|15m|30m)\.jsonl$/.test(f)
);

for (const f of files) {
  const full = path.join(folder, f);
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  const kept = [];
  let dups = 0;
  for (const ln of lines) {
    let row; try { row = JSON.parse(ln); } catch { continue; }
    if (!row || !row.t) continue;
    let t = Number(row.t);
    if (!Number.isFinite(t)) continue;
    if (t >= 1e12) t = Math.floor(t / 1000);
    if (seen.has(t)) { dups++; continue; }
    seen.add(t);
    kept.push(JSON.stringify({ ...row, t }));
  }
  // Sort by t ascending
  kept.sort((a, b) => JSON.parse(a).t - JSON.parse(b).t);
  fs.writeFileSync(full, kept.join('\n') + '\n');
  console.log(`  ${f.padEnd(25)} ${lines.length} → ${kept.length} (dups: ${dups})`);
}
console.log('Done');
