// Analyze trade outcomes to find pattern in losses
const fs = require('fs');
const path = require('path');
const file = path.resolve(process.argv[2] || 'logs/backtest-2026-05-17T19-28-24-010Z.log');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);

let cycle = {};
const trades = [];

for (const ln of lines) {
  let obj; try { obj = JSON.parse(ln); } catch { continue; }
  const src = obj.source;
  const data = obj.data || {};
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

  if (src === 'backtest') {
    if (obj.message === 'cycle_begin') {
      cycle = { dayLabel: data.dayLabel, hhmm: data.hhmm };
    }
    if (obj.message === 'trade_closed') {
      trades.push({
        ...cycle,
        ...data,
      });
    }
  }
}

console.log('Total closed trades:', trades.length);

// Bucket all trades by win/loss
const wins = trades.filter(t => t.result === 'WIN');
const losses = trades.filter(t => t.result === 'LOSS');
console.log('Wins:', wins.length, 'Losses:', losses.length);

function bucketRate(trades, keyFn) {
  const buckets = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (!buckets[k]) buckets[k] = { w: 0, l: 0, pnl: 0 };
    if (t.result === 'WIN') buckets[k].w++;
    else if (t.result === 'LOSS') buckets[k].l++;
    buckets[k].pnl += (t.netPnl || 0);
  }
  return buckets;
}

function report(label, b) {
  console.log(`\n${label}:`);
  const rows = Object.entries(b).map(([k, v]) => {
    const total = v.w + v.l;
    const wr = total ? (v.w / total) * 100 : 0;
    return [k, total, v.w, v.l, wr, v.pnl];
  }).sort((a, b) => b[1] - a[1]);
  for (const [k, total, w, l, wr, pnl] of rows) {
    console.log(`  ${String(k).padEnd(30)} : trades=${String(total).padEnd(3)} ${w}W/${l}L  wr=${wr.toFixed(1).padStart(5)}%  net=₹${pnl.toFixed(0)}`);
  }
}

report('By Strategy',  bucketRate(trades, t => t.strategy || '?'));
report('By Entry Type',bucketRate(trades, t => t.entryType || '?'));
report('By Session',   bucketRate(trades, t => t.session || t.phase || '?'));
report('By Meta Regime',bucketRate(trades, t => t.meta || '?'));
report('By Volatility',bucketRate(trades, t => t.vol || '?'));
report('By Gamma',     bucketRate(trades, t => t.gamma || '?'));
report('By Market Regime',bucketRate(trades, t => t.regime || '?'));
report('By Confidence Bucket', bucketRate(trades, t => {
  const s = Number(t.confidenceScore || t.confidence);
  if (!Number.isFinite(s)) return '?';
  return `${Math.floor(s/5)*5}-${Math.floor(s/5)*5+4}`;
}));
report('By Trap Score Bucket', bucketRate(trades, t => {
  const s = Number(t.trapScore);
  if (!Number.isFinite(s)) return '0';
  return `${Math.floor(s/10)*10}`;
}));
report('By Orderflow', bucketRate(trades, t => t.orderflow || '?'));
report('By OI Regime', bucketRate(trades, t => t.oiRegime || '?'));
report('By Trend Phase', bucketRate(trades, t => t.trendPhase || '?'));
report('By Side (CE/PE)', bucketRate(trades, t => t.signal || '?'));
report('By Hold Reason', bucketRate(trades, t => t.reason || '?'));

// Loss-only analysis: what's common
console.log('\n--- LOSS DETAILS ---');
const lossesByDay = {};
for (const l of losses) {
  if (!lossesByDay[l.dayLabel]) lossesByDay[l.dayLabel] = [];
  lossesByDay[l.dayLabel].push(l);
}
const losingDayLossSums = Object.entries(lossesByDay)
  .map(([day, lst]) => [day, lst.length, lst.reduce((a,b)=>a+(b.netPnl||0),0)])
  .sort((a,b)=>a[2]-b[2]);
console.log('Worst loss days:');
for (const [day, n, total] of losingDayLossSums.slice(0, 8)) {
  console.log(`  ${day}: ${n} losses, net loss ₹${total.toFixed(0)}`);
}

// Largest individual losses
console.log('\nTop 10 individual losing trades:');
losses.sort((a, b) => (a.netPnl || 0) - (b.netPnl || 0));
for (const l of losses.slice(0, 10)) {
  console.log(`  ${l.dayLabel} ${l.entryHhmm} ${l.signal} ${l.strike}${l.optionType} entry=${l.entry} exit=${l.exit} pts=${l.pts} held=${l.heldSec}s | conf=${l.confidenceScore} | strat=${l.strategy} | type=${l.entryType} | meta=${l.meta} | net=₹${l.netPnl} | reason=${l.reason}`);
}
