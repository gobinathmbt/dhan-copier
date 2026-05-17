const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const day = process.argv[3], hhmm = parseInt(process.argv[4], 10);
for (const ln of lines) {
  let o; try { o = JSON.parse(ln); } catch { continue; }
  if (!o.data) continue;
  if (o.data.dayLabel !== day) continue;
  if (o.data.hhmm !== hhmm) continue;
  if (o.source === 'hybrid:structural_target') {
    console.log('STRUCT:', JSON.stringify(o.data));
  }
  if (o.source === 'backtest' && o.message === 'cycle_decision' && o.data.signal !== 'NO_TRADE') {
    console.log('DECISION:', JSON.stringify({ signal: o.data.signal, strike: o.data.strike, lots: o.data.lots, reasoning: o.data.reasoning }));
  }
  if (o.message === 'trade_closed') {
    console.log('CLOSED:', JSON.stringify(o.data));
  }
}
