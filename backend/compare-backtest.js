const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('logs').filter(f => f.startsWith('backtest-') && f.endsWith('.log')).sort();
const latest = files[files.length - 1];
console.log('Using backtest log:', latest);

const raw = fs.readFileSync(path.join('logs', latest), 'utf8');
let count1135 = 0;
let trades1135 = 0;
const decisions = [];
for (const line of raw.split('\n').filter(Boolean)) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  if (obj.message === 'cycle_decision' && obj.data && obj.data.hhmm === 1135) {
    count1135++;
    decisions.push(obj.data);
    if (obj.data.signal !== 'NO_TRADE') trades1135++;
  }
}
console.log('Cycles at 11:35:', count1135);
console.log('Trades at 11:35:', trades1135);
console.log('');
console.log('Top no-trade reasons at 11:35:');
const reasons = {};
decisions.forEach(d => {
  const r = (d.reasoning || '').slice(0, 80);
  reasons[r] = (reasons[r] || 0) + 1;
});
Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([r, c]) => {
  console.log('  ' + c + 'x  ' + r);
});
