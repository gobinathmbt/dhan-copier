// Deep-dive analysis of one zero-trade day
const fs = require('fs');
const day = process.argv[2];
const log = process.argv[3];
if (!day || !log) {
  console.error('Usage: node day-deepdive.js <YYYY-MM-DD> <logfile>');
  process.exit(1);
}

const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/);
let inDay = false;
const cycles = []; // each cycle: { hhmm, spotPrice, regime, vol, meta, direction, score, weighted, threshold, decision, reason, playbook }
let cur = null;

for (const raw of lines) {
  if (!raw.trim()) continue;
  let obj; try { obj = JSON.parse(raw); } catch { continue; }
  const { source, message, data } = obj;

  if (source === 'backtest' && message && message.startsWith('day_start')) {
    inDay = (data?.dayLabel === day);
    if (!inDay) cur = null;
    continue;
  }
  if (!inDay) continue;

  if (source === 'backtest' && message === 'cycle_begin') {
    if (cur) cycles.push(cur);
    cur = { hhmm: data.hhmm, spotPrice: data.spotPrice, atmStrike: data.atmStrike };
    continue;
  }
  if (!cur) continue;

  if (source === 'hybrid:meta_regime')        cur.meta = obj.message;
  if (source === 'hybrid:market_regime')      cur.regime = obj.message;
  if (source === 'hybrid:volatility_regime')  cur.vol = obj.message;
  if (source === 'hybrid:direction_resolved') cur.direction = data?.direction || 'none';
  if (source === 'hybrid:score')              cur.score = data;
  if (source === 'hybrid:strategy')           cur.strategy = data?.strategy;
  if (source === 'hybrid:aggression')         cur.aggression = data;
  if (source === 'hybrid:playbook')           cur.playbook = obj.message;
  if (source === 'hybrid:entry_type')         cur.entryType = obj.message;
  if (source === 'hybrid:trap_detection')     cur.trap = obj.message;

  if (source === 'backtest' && message === 'cycle_decision') {
    cur.decision = data.signal;
    cur.reason = data.reasoning;
    cycles.push(cur);
    cur = null;
  }
}
if (cur) cycles.push(cur);

console.log(`=== Day ${day} | ${cycles.length} cycles ===`);
for (const c of cycles) {
  console.log(
    `${String(c.hhmm).padStart(4)} ` +
    `spot=${(c.spotPrice||0).toFixed(1).padStart(8)} ` +
    `dir=${(c.direction||'-').padEnd(7)} ` +
    `meta=${(c.meta||'-').slice(0, 40).padEnd(40)} ` +
    `regime=${(c.regime||'-').slice(0, 25).padEnd(25)} ` +
    `vol=${(c.vol||'-').slice(0,30).padEnd(30)} `
  );
  console.log(`     score: ${c.score ? `${c.score.score}/${c.score.weighted}` : '-'}  strat=${c.strategy || '-'}  agg=${c.aggression?.minScore || '-'}  pb=${(c.playbook||'-').slice(0,60)}  et=${(c.entryType||'-').slice(0,60)}`);
  console.log(`     -> ${c.decision} | ${(c.reason||'-').slice(0, 200)}`);
}
