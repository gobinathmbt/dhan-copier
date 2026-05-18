// Deep dive on a single trade — find entry, monitor cycles, exit
const fs = require('fs');
const sessionId = process.argv[2] || '6a0aaf37cb6d22a525137056';

const jsonFile = `logs/session-${sessionId}-2026-05-18.json`;
const logFile  = `logs/session-${sessionId}.log`;

console.log('=== ANALYZING SESSION:', sessionId, '===\n');

// --- 1. JSON event log ---
const jsonRaw = fs.readFileSync(jsonFile, 'utf8');
const seen = new Set();
const entries = [];
for (const line of jsonRaw.split(/\r?\n/).filter(Boolean)) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  const k = (obj.timestamp || '') + '|' + (obj.msg || '').slice(0, 80);
  if (seen.has(k)) continue;
  seen.add(k);
  entries.push(obj);
}

// --- 2. Hybrid engine .log (structured) ---
const logRaw = fs.readFileSync(logFile, 'utf8');
const hybridEvents = [];
for (const line of logRaw.split(/\r?\n/).filter(Boolean)) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  hybridEvents.push(obj);
}

console.log(`JSON entries: ${entries.length}`);
console.log(`Hybrid log events: ${hybridEvents.length}`);

// --- Find entry decision ---
const entryEvents = entries.filter(e =>
  (e.msg || '').includes('Trade opened') ||
  (e.msg || '').includes('trade_open') ||
  (e.msg || '').includes('Institutional AI Trade') ||
  (e.msg || '').includes('Hybrid trade entry') ||
  (e.msg || '').includes('hybrid decision') && (e.data?.signal === 'BUY_CE' || e.data?.signal === 'BUY_PE')
);
console.log(`\nEntry events found: ${entryEvents.length}`);
entryEvents.forEach(e => {
  console.log(' ts:', e.timestamp);
  console.log(' msg:', (e.msg || '').slice(0, 200));
  if (e.data) console.log(' data:', JSON.stringify(e.data).slice(0, 500));
});

// --- Find trade close ---
const closeEvents = entries.filter(e =>
  (e.msg || '').includes('Trade closed') ||
  (e.msg || '').includes('closed at') ||
  (e.msg || '').includes('hard_stop') ||
  (e.msg || '').includes('SL hit') ||
  (e.msg || '').includes('Target hit') ||
  (e.msg || '').includes('Max hold')
);
console.log(`\nClose events found: ${closeEvents.length}`);
closeEvents.slice(0, 20).forEach(e => {
  console.log(' ts:', e.timestamp);
  console.log(' msg:', (e.msg || '').slice(0, 200));
  if (e.data) console.log(' data:', JSON.stringify(e.data).slice(0, 400));
});

// --- Hybrid score events ---
const scoreEvents = hybridEvents.filter(e => e.eventType === 'hybrid_score');
console.log(`\nHybrid score events: ${scoreEvents.length}`);
scoreEvents.forEach((e, i) => {
  console.log(` ${i+1}. ts=${e.ts} score=${e.score} weighted=${e.weighted} dir=${e.direction}`);
  console.log(`    msg: ${(e.message||'').slice(0, 200)}`);
});

// --- Hybrid playbook decisions ---
const playbookEvents = hybridEvents.filter(e => e.eventType === 'hybrid_playbook');
console.log(`\nPlaybook events: ${playbookEvents.length}`);
playbookEvents.forEach((e, i) => {
  console.log(` ${i+1}. ts=${e.ts} bestName=${e.bestName} bestScore=${e.bestScore} conv=${e.bestConviction}`);
});

// --- Monitor cycle decisions ---
const monitorEvents = entries.filter(e =>
  (e.msg || '').includes('monitorEngine') ||
  (e.msg || '').includes('monitor decision') ||
  (e.msg || '').includes('Trade monitor decision') ||
  (e.msg || '').includes('hybridMonitor')
);
console.log(`\nMonitor events: ${monitorEvents.length}`);
monitorEvents.slice(0, 30).forEach(e => {
  const action = e.data?.action || 'unknown';
  const reason = e.data?.reasoning || e.data?.rationale || '';
  console.log(` ts=${e.timestamp} action=${action} | ${(e.msg||'').slice(0, 100)}`);
  if (reason) console.log(`   reason: ${reason.slice(0, 200)}`);
});

// --- Timeline summary ---
console.log('\n=== TIMELINE ===');
const allEvents = entries.filter(e =>
  (e.msg || '').match(/Trade opened|trade closed|trade_open|Trade closed|hard_stop|SL hit|Target hit|Max hold|hybrid decision|monitor decision/i)
);
allEvents.slice(0, 50).forEach(e => {
  const t = (e.timestamp || '').slice(11, 19);
  console.log(`  ${t}  ${(e.msg||'').slice(0, 150)}`);
});
