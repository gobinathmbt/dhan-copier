// Analyze a live session JSON log file
// Usage: node analyze-session.js <logfile>
const fs = require('fs');
const path = require('path');

const logFile = process.argv[2];
if (!logFile) { console.error('Usage: node analyze-session.js <logfile>'); process.exit(1); }

const raw = fs.readFileSync(logFile, 'utf8');

// The file may be duplicate-appended (two copies) -- deduplicate by timestamp+msg
const seen = new Set();
const lines = raw.split(/\r?\n/).filter(Boolean);
const entries = [];
for (const line of lines) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  const key = (obj.timestamp || '') + '|' + (obj.msg || '').slice(0, 80);
  if (seen.has(key)) continue;
  seen.add(key);
  entries.push(obj);
}

console.log(`Total unique log entries: ${entries.length}`);

// -- Categorise --------------------------------------------------------------
const errors   = entries.filter(e => e.level === 50 || e.level === 'error' || (e.msg && e.msg.includes('error') && !e.msg.includes('errorType')));
const warnings = entries.filter(e => e.level === 40 || e.level === 'warn');
const hybrid   = entries.filter(e => e.msg && e.msg.includes('[hybrid]'));
const entryDec = entries.filter(e => e.msg && (e.msg.includes('hybrid decision') || e.msg.includes('cycle_decision') || e.msg.includes('entryEngine')));
const trades   = entries.filter(e => e.msg && (e.msg.includes('Trade opened') || e.msg.includes('trade_open') || e.msg.includes('Institutional AI Trade') || e.msg.includes('BUY_CE') || e.msg.includes('BUY_PE')));
const noTrades = entries.filter(e => e.msg && e.msg.includes('NO_TRADE'));
const cycles   = entries.filter(e => e.msg && e.msg.includes('cycle'));

console.log('\n=== SUMMARY ===');
console.log(`Errors:          ${errors.length}`);
console.log(`Warnings:        ${warnings.length}`);
console.log(`Hybrid events:   ${hybrid.length}`);
console.log(`Entry decisions: ${entryDec.length}`);
console.log(`Trade signals:   ${trades.length}`);
console.log(`NO_TRADE:        ${noTrades.length}`);
console.log(`Cycle events:    ${cycles.length}`);

if (errors.length) {
  console.log('\n=== ERRORS (first 20) ===');
  errors.slice(0, 20).forEach(e => {
    console.log(`  [${e.timestamp}] ${(e.msg || '').slice(0, 200)}`);
    if (e.data?.err) console.log(`    err: ${e.data.err}`);
  });
}

if (warnings.length) {
  console.log('\n=== WARNINGS (first 20) ===');
  warnings.slice(0, 20).forEach(e => {
    console.log(`  [${e.timestamp}] ${(e.msg || '').slice(0, 200)}`);
  });
}

console.log('\n=== HYBRID ENTRY DECISIONS (last 30) ===');
const hybridDecisions = entries.filter(e => e.msg && e.msg.includes('[entryEngine] hybrid decision'));
hybridDecisions.slice(-30).forEach(e => {
  const d = e.data || {};
  console.log(`  [${e.timestamp}] signal=${d.signal || '?'} score=${d.score || '?'} grade=${d.grade || '?'} conf=${d.confidence || '?'} type=${d.tradeType || '?'}`);
  if (d.reasoning) console.log(`    reason: ${String(d.reasoning).slice(0, 150)}`);
});

console.log('\n=== HYBRID ENGINE EVENTS (last 20) ===');
hybrid.slice(-20).forEach(e => {
  console.log(`  [${e.timestamp}] ${(e.msg || '').slice(0, 200)}`);
});

console.log('\n=== TRADE SIGNALS ===');
trades.forEach(e => {
  console.log(`  [${e.timestamp}] ${(e.msg || '').slice(0, 200)}`);
});

console.log('\n=== NO_TRADE REASONS (last 20) ===');
noTrades.slice(-20).forEach(e => {
  const reason = e.data?.reasoning || e.msg || '';
  console.log(`  [${e.timestamp}] ${String(reason).slice(0, 200)}`);
});

// Check if hybrid is actually being used
const hybridUsed = entries.some(e => e.msg && e.msg.includes('[entryEngine] hybrid decision'));
const legacyAIUsed = entries.some(e => e.msg && e.msg.includes('[entryEngine] Building AI decision'));
const hybridFailed = entries.some(e => e.msg && e.msg.includes('hybrid path failed'));

console.log('\n=== HYBRID ENGINE STATUS ===');
console.log(`Hybrid engine used:     ${hybridUsed ? '✅ YES' : '❌ NO'}`);
console.log(`Legacy AI path used:    ${legacyAIUsed ? '⚠️  YES (should be NO)' : '✅ NO'}`);
console.log(`Hybrid path failed:     ${hybridFailed ? '❌ YES (check errors)' : '✅ NO'}`);

// Check sessionId propagation
const noSessionId = entries.filter(e => e.sessionId === null && e.msg && e.msg.includes('[hybrid]'));
console.log(`Hybrid events missing sessionId: ${noSessionId.length} ${noSessionId.length > 0 ? '⚠️' : '✅'}`);
