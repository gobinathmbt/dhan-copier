// Calibration cycle helper
// 1. Locates the latest backtest log
// 2. Computes: per-day stats, all losing trades + their playbook context,
//    days with < N entries, summary metrics
// 3. Outputs a focused report for the next calibration step
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const MIN_TRADES_PER_DAY = parseInt(process.argv[2] || '3', 10);

function newestLog() {
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => /^backtest-.*\.log$/.test(f))
    .map(f => ({ f, ts: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.ts - a.ts);
  return files.length ? path.join(LOG_DIR, files[0].f) : null;
}

const file = process.argv[3] || newestLog();
if (!file) { console.error('No backtest log found'); process.exit(1); }
console.log('Analyzing:', path.basename(file));

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);

let cycle = {};
const trades = [];
const dailySummaries = [];
let runComplete = null;

for (const ln of lines) {
  let o; try { o = JSON.parse(ln); } catch { continue; }
  const src = o.source;
  const data = o.data || {};

  if (src === 'hybrid:session_phase') cycle.session = data.phase;
  else if (src === 'hybrid:meta_regime') cycle.meta = data.state;
  else if (src === 'hybrid:volatility_regime') cycle.vol = data.state;
  else if (src === 'hybrid:market_regime') cycle.regime = data.regime;
  else if (src === 'hybrid:gamma_regime') cycle.gamma = data.regime;
  else if (src === 'hybrid:strategy') cycle.strategy = data.strategy;
  else if (src === 'hybrid:aggression') cycle.aggression = data.mode;
  else if (src === 'hybrid:entry_type') cycle.entryType = data.bestType;
  else if (src === 'hybrid:trap_detection') cycle.trapScore = data.trapScore;
  else if (src === 'hybrid:confidence') cycle.confidence = data.total;
  else if (src === 'hybrid:score') cycle.score = data.score;
  else if (src === 'hybrid:orderflow_state') cycle.orderflow = data.state;
  else if (src === 'hybrid:trend_phase') cycle.trendPhase = data.phase;
  else if (src === 'hybrid:oi_analytics') cycle.oiRegime = data.regime;
  else if (src === 'hybrid:ut_bot') cycle.utAligned = data.aligned;
  else if (src === 'hybrid:mtf_structure') cycle.mtfAlign = data.alignment;
  else if (src === 'hybrid:playbook') {
    cycle.playbook = data.bestName;
    cycle.playbookConviction = data.bestConviction;
    cycle.playbookScore = data.bestScore;
  }

  if (src === 'backtest') {
    if (o.message === 'cycle_begin') {
      cycle = { dayLabel: data.dayLabel, hhmm: data.hhmm, spotPrice: data.spotPrice };
    } else if (o.message === 'trade_closed') {
      trades.push({ ...cycle, ...data });
    } else if (o.message === 'day_summary') {
      dailySummaries.push(data);
    } else if (o.message === 'run_complete') {
      runComplete = data;
    }
  }
}

const wins   = trades.filter(t => t.result === 'WIN');
const losses = trades.filter(t => t.result === 'LOSS');

console.log('\n══════════════════════════════════════════════════════');
console.log('CALIBRATION CYCLE REPORT');
console.log('══════════════════════════════════════════════════════');
console.log(JSON.stringify(runComplete, null, 2));

console.log('\n--- DAYS WITH < ' + MIN_TRADES_PER_DAY + ' ENTRIES ---');
const lowVolume = dailySummaries.filter(d => (d.trades || 0) < MIN_TRADES_PER_DAY);
for (const d of lowVolume) {
  console.log(`  ${d.dayLabel}: trades=${d.trades||0} wins=${d.wins||0} losses=${d.losses||0} net=₹${(d.netPnL||0).toFixed(0)}`);
}
console.log(`  Total low-volume days: ${lowVolume.length}/${dailySummaries.length}`);

console.log('\n--- ALL LOSSES (' + losses.length + ') ---');
losses.sort((a, b) => (a.netPnl || 0) - (b.netPnl || 0));
for (const l of losses) {
  console.log(`  ${l.dayLabel} ${l.entryHhmm} ${l.signal} ${l.strike} | ` +
    `ent=${l.entry} ex=${l.exit} pts=${l.pts} hold=${l.heldSec}s | ` +
    `pb=${l.playbook||l.entryType} (${l.playbookConviction||'?'}) score=${l.confidenceScore} | ` +
    `meta=${l.meta} vol=${l.vol} gamma=${l.gamma} reg=${l.regime} of=${l.orderflow} oi=${l.oiRegime} | ` +
    `reason=${l.reason} | net=₹${l.netPnl}`);
}

console.log('\n--- LOSSES BY PLAYBOOK ---');
const lossByPb = {};
for (const l of losses) {
  const k = l.playbook || l.entryType || 'unknown';
  if (!lossByPb[k]) lossByPb[k] = { count: 0, sum: 0 };
  lossByPb[k].count++;
  lossByPb[k].sum += (l.netPnl || 0);
}
Object.entries(lossByPb)
  .sort((a, b) => a[1].sum - b[1].sum)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(35)} : ${v.count} losses, total ₹${v.sum.toFixed(0)}`));

console.log('\n--- LOSSES BY META REGIME ---');
const lossByMeta = {};
for (const l of losses) {
  const k = l.meta || 'unknown';
  if (!lossByMeta[k]) lossByMeta[k] = { count: 0, sum: 0 };
  lossByMeta[k].count++;
  lossByMeta[k].sum += (l.netPnl || 0);
}
Object.entries(lossByMeta)
  .sort((a, b) => a[1].sum - b[1].sum)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(35)} : ${v.count} losses, total ₹${v.sum.toFixed(0)}`));

console.log('\n--- LOSSES BY EXIT REASON ---');
const lossByReason = {};
for (const l of losses) {
  const k = l.reason || 'unknown';
  if (!lossByReason[k]) lossByReason[k] = { count: 0, sum: 0 };
  lossByReason[k].count++;
  lossByReason[k].sum += (l.netPnl || 0);
}
Object.entries(lossByReason)
  .sort((a, b) => a[1].sum - b[1].sum)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(15)} : ${v.count} losses, total ₹${v.sum.toFixed(0)}`));

console.log('\n--- WIN RATE BY PLAYBOOK ---');
const wrByPb = {};
for (const t of trades) {
  const k = t.playbook || t.entryType || 'unknown';
  if (!wrByPb[k]) wrByPb[k] = { w: 0, l: 0, sum: 0 };
  if (t.result === 'WIN') wrByPb[k].w++; else wrByPb[k].l++;
  wrByPb[k].sum += (t.netPnl || 0);
}
Object.entries(wrByPb)
  .sort((a, b) => (b[1].w + b[1].l) - (a[1].w + a[1].l))
  .forEach(([k, v]) => {
    const total = v.w + v.l;
    console.log(`  ${k.padEnd(35)} : ${total.toString().padStart(3)} trades, ${v.w}W/${v.l}L, WR=${(v.w/total*100).toFixed(1).padStart(5)}%, net=₹${v.sum.toFixed(0)}`);
  });

console.log('\n--- AGGREGATE ---');
console.log(`  Total trades: ${trades.length}, Wins: ${wins.length}, Losses: ${losses.length}`);
const wr = trades.length ? (wins.length / trades.length) * 100 : 0;
const net = trades.reduce((a, t) => a + (t.netPnl || 0), 0);
const grossWin = wins.reduce((a, t) => a + (t.netPnl || 0), 0);
const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.netPnl || 0), 0));
console.log(`  Win rate: ${wr.toFixed(2)}%, Net: ₹${net.toFixed(0)}, PF: ${(grossWin/Math.max(1,grossLoss)).toFixed(2)}`);
console.log(`  Avg trades/day: ${(trades.length/dailySummaries.length).toFixed(2)}`);
