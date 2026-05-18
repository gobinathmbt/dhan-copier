// Deep analysis of a live session log — focus on data quality issues
const fs = require('fs');
const logFile = process.argv[2];
if (!logFile) { console.error('Usage: node analyze-session-deep.js <logfile>'); process.exit(1); }

const raw = fs.readFileSync(logFile, 'utf8');
const seen = new Set();
const entries = [];
for (const line of raw.split(/\r?\n/).filter(Boolean)) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  const key = (obj.timestamp || '') + '|' + (obj.msg || '').slice(0, 80);
  if (seen.has(key)) continue;
  seen.add(key);
  entries.push(obj);
}

// ── 1. Candle data quality ──────────────────────────────────────────────────
console.log('\n=== CANDLE DATA QUALITY ===');
const candleEvents = entries.filter(e => e.msg && e.msg.includes('liveFeedDataProvider'));
const candleCounts = {};
candleEvents.forEach(e => {
  const src = e.data?.source || 'unknown';
  const cnt = e.data?.candleCount || 0;
  const interval = e.data?.interval || '?';
  const key = `${src}/${interval}`;
  if (!candleCounts[key]) candleCounts[key] = { count: 0, totalCandles: 0, minCandles: Infinity, maxCandles: 0 };
  candleCounts[key].count++;
  candleCounts[key].totalCandles += cnt;
  candleCounts[key].minCandles = Math.min(candleCounts[key].minCandles, cnt);
  candleCounts[key].maxCandles = Math.max(candleCounts[key].maxCandles, cnt);
});
Object.entries(candleCounts).forEach(([k, v]) => {
  const avg = (v.totalCandles / v.count).toFixed(1);
  console.log(`  ${k.padEnd(35)} calls=${v.count} avg=${avg} min=${v.minCandles} max=${v.maxCandles}`);
});

// ── 2. ATR null issue ───────────────────────────────────────────────────────
console.log('\n=== ATR NULL ISSUE ===');
const atrNull = entries.filter(e => e.msg && e.msg.includes('atr5m=null'));
const atrOk   = entries.filter(e => e.msg && e.msg.includes('atr5m=') && !e.msg.includes('atr5m=null'));
console.log(`  Cycles with atr5m=null: ${atrNull.length}`);
console.log(`  Cycles with atr5m OK:   ${atrOk.length}`);
if (atrNull.length > 0) {
  console.log('  Sample null ATR event:');
  console.log('  ', atrNull[0].msg);
}
if (atrOk.length > 0) {
  console.log('  Sample OK ATR event:');
  console.log('  ', atrOk[0].msg);
}

// ── 3. Volume profile issue ─────────────────────────────────────────────────
console.log('\n=== VOLUME PROFILE ISSUE ===');
const volNull = entries.filter(e => e.msg && e.msg.includes('no_volume_profile'));
const volOk   = entries.filter(e => e.msg && e.msg.includes('acceptance=') && !e.msg.includes('no_volume_profile'));
console.log(`  Cycles with no_volume_profile: ${volNull.length}`);
console.log(`  Cycles with volume profile OK: ${volOk.length}`);
if (volNull.length > 0) {
  const sample = volNull[0];
  console.log('  Sample:', sample.msg);
  if (sample.data?.snapshotsHeld !== undefined) console.log('  snapshotsHeld:', sample.data.snapshotsHeld);
}

// ── 4. Direction resolution ─────────────────────────────────────────────────
console.log('\n=== DIRECTION RESOLUTION ===');
const dirEvents = entries.filter(e => e.msg && e.msg.includes('direction_resolved'));
const dirCounts = {};
dirEvents.forEach(e => {
  const dir = e.data?.direction || e.msg?.match(/direction=(\w+)/)?.[1] || 'unknown';
  const src = e.data?.source || e.msg?.match(/via (\w+)/)?.[1] || 'unknown';
  const key = `${dir} via ${src}`;
  dirCounts[key] = (dirCounts[key] || 0) + 1;
});
Object.entries(dirCounts).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k.padEnd(40)} ${v}x`));

const noBias = entries.filter(e => e.msg && e.msg.includes('No clear directional bias'));
console.log(`  No directional bias (no direction resolved): ${noBias.length}x`);

// ── 5. Meta-regime distribution ─────────────────────────────────────────────
console.log('\n=== META-REGIME DISTRIBUTION ===');
const metaEvents = entries.filter(e => e.msg && e.msg.includes('[hybrid] ') && 
  (e.msg.includes('gamma_pin') || e.msg.includes('slow_grind') || e.msg.includes('trend_auction') || 
   e.msg.includes('dealer_hedging') || e.msg.includes('balanced_auction') || e.msg.includes('panic') ||
   e.msg.includes('short_covering') || e.msg.includes('long_liquidation') || e.msg.includes('expiry_expansion')));
const metaCounts = {};
metaEvents.forEach(e => {
  const m = e.msg.match(/(gamma_pin|slow_grind|trend_auction|dealer_hedging|balanced_auction|panic|short_covering|long_liquidation|expiry_expansion|unknown)/);
  if (m) metaCounts[m[1]] = (metaCounts[m[1]] || 0) + 1;
});
Object.entries(metaCounts).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k.padEnd(25)} ${v}x`));

// ── 6. Score distribution ───────────────────────────────────────────────────
console.log('\n=== SCORE DISTRIBUTION (when direction resolved) ===');
const scoreEvents = entries.filter(e => e.msg && e.msg.includes('score=') && e.msg.includes('need ≥'));
const scores = scoreEvents.map(e => {
  const m = e.msg.match(/score=([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}).filter(Boolean);
if (scores.length) {
  const avg = (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1);
  const max = Math.max(...scores).toFixed(1);
  const min = Math.min(...scores).toFixed(1);
  console.log(`  Scores: avg=${avg} min=${min} max=${max} count=${scores.length}`);
  const buckets = { '<40': 0, '40-50': 0, '50-55': 0, '55-60': 0, '60-70': 0, '70+': 0 };
  scores.forEach(s => {
    if (s < 40) buckets['<40']++;
    else if (s < 50) buckets['40-50']++;
    else if (s < 55) buckets['50-55']++;
    else if (s < 60) buckets['55-60']++;
    else if (s < 70) buckets['60-70']++;
    else buckets['70+']++;
  });
  Object.entries(buckets).forEach(([k,v]) => console.log(`  ${k.padEnd(10)} ${v}x`));
}

// ── 7. Option chain data quality ────────────────────────────────────────────
console.log('\n=== OPTION CHAIN DATA ===');
const ocEvents = entries.filter(e => e.msg && e.msg.includes('option') && e.msg.includes('chain'));
console.log(`  Option chain related events: ${ocEvents.length}`);
const ocSnaps = entries.filter(e => e.data?.optionChainSnapshots !== undefined);
if (ocSnaps.length) {
  const snaps = ocSnaps.map(e => e.data.optionChainSnapshots);
  console.log(`  OC snapshots: min=${Math.min(...snaps)} max=${Math.max(...snaps)} avg=${(snaps.reduce((a,b)=>a+b,0)/snaps.length).toFixed(1)}`);
}

// ── 8. Futures data ─────────────────────────────────────────────────────────
console.log('\n=== FUTURES DATA ===');
const futEvents = entries.filter(e => e.msg && e.msg.includes('futures'));
const futOk = entries.filter(e => e.msg && e.msg.includes('futures') && e.msg.includes('direction'));
const futFail = entries.filter(e => e.msg && (e.msg.includes('futures') && (e.msg.includes('failed') || e.msg.includes('no futures'))));
console.log(`  Futures events: ${futEvents.length}`);
console.log(`  Futures with direction: ${futOk.length}`);
console.log(`  Futures failures: ${futFail.length}`);

// ── 9. Key issues summary ───────────────────────────────────────────────────
console.log('\n=== ROOT CAUSE ANALYSIS ===');
const issues = [];
if (atrNull.length > atrOk.length) issues.push(`❌ ATR is null in ${atrNull.length}/${atrNull.length+atrOk.length} cycles — candles too few for ATR calculation`);
if (volNull.length > volOk.length) issues.push(`❌ Volume profile missing in ${volNull.length}/${volNull.length+volOk.length} cycles — insufficient candle history`);
if (noBias.length > 5) issues.push(`⚠️  No directional bias in ${noBias.length} cycles — derivatives/OI data may be sparse at session start`);
if (scores.length && Math.max(...scores) < 55) issues.push(`⚠️  All scores below threshold (max=${Math.max(...scores).toFixed(1)}) — market conditions not meeting entry criteria`);
if (issues.length === 0) issues.push('✅ No critical data issues found');
issues.forEach(i => console.log(' ', i));
