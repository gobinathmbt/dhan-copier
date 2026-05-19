// Live session diagnostics — what data is missing / arriving late?
const fs = require('fs');
const path = require('path');

const logFile = process.argv[2] || 'logs/session-6a0bdce5354a1fb2c0fffdd6.log';
const date    = process.argv[3] || '2026-05-19';
console.log('Reading log:', logFile);

const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);

// 1) Live data files: how many candles available in each frame
const feedDir = path.resolve(__dirname, `../live-feed/${date}_NIFTY_50`);
console.log('\n=== LIVE-FEED FILES ===');
if (fs.existsSync(feedDir)) {
  for (const f of fs.readdirSync(feedDir)) {
    const full = path.join(feedDir, f);
    const st = fs.statSync(full);
    let count = '-';
    if (f.endsWith('.jsonl')) {
      try {
        count = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean).length;
      } catch (_) {}
    }
    console.log(`  ${f.padEnd(28)} ${(st.size/1024).toFixed(1).padStart(8)}kB  rows=${count}`);
  }
} else {
  console.log('  (folder missing)');
}

// 2) Walk each cycle (session_phase boundary) and capture what the engine saw
const cycles = [];
let cur = null;

for (const ln of lines) {
  let o; try { o = JSON.parse(ln); } catch { continue; }
  const ev = o.eventType || 'unknown';

  if (ev === 'hybrid_session_phase') {
    if (cur) cycles.push(cur);
    cur = { ts: o.ts };
  }
  if (!cur) continue;

  if (ev === 'hybrid_volatility_regime') {
    cur.vol = o.state;
    cur.atr5m = o.atr5m;
  }
  if (ev === 'hybrid_volume_analysis') {
    cur.va_msg = o.message;
    cur.acceptance = o.acceptance;
    cur.delta = o.delta;
    cur.deltaSrc = o.deltaSource;
    cur.poc = o.poc;
  }
  if (ev === 'hybrid_microstructure') {
    cur.micro_state = o.state;
    cur.micro_imb = o.imbalance;
    cur.micro_spread = o.spread;
  }
  if (ev === 'hybrid_oi_analytics') {
    cur.oi_regime = o.regime;
    cur.oi_pe_vel = o.diff?.peVelocity;
    cur.oi_ce_vel = o.diff?.ceVelocity;
    cur.oi_snaps = o.snapshotsHeld;
  }
  if (ev === 'hybrid_derivatives') {
    cur.deriv_bias = o.overallBias;
    cur.deriv_score = o.directionScore;
  }
  if (ev === 'hybrid_score') cur.score = o.score;
  if (ev === 'hybrid_strategy') {
    cur.strategy = o.strategy;
    cur.strat_min = o.minScore;
  }
  if (ev === 'hybrid_aggression') {
    cur.aggr_mode = o.mode;
    cur.aggr_min = o.minScore;
  }
  if (ev === 'hybrid_direction_resolved') {
    cur.dir = o.direction;
    cur.dir_via = o.via;
  }
  if (ev === 'hybrid_meta_regime') cur.meta = o.state;
  if (ev === 'hybrid_orderflow_state') cur.of = o.state;
  if (ev === 'hybrid_mtf_structure') cur.mtf = o.alignment;
  if (ev === 'hybrid_ut_bot') cur.ut = o.message?.match(/(?:1m|5m|15m|30m) (\w+)/)?.[1];
  if (ev === 'hybrid_playbook') {
    cur.pb = o.bestName;
    cur.pb_conv = o.bestConviction;
    cur.pb_score = o.bestScore;
    cur.pb_reasoning = o.bestReasoning;
  }
}
if (cur) cycles.push(cur);

console.log(`\n=== CYCLES (${cycles.length}) — DATA QUALITY OVER TIME ===`);
console.log('  TIME      VA            delta_src    OI_snaps  micro       deriv  ut_bot  pb');
console.log('  ' + '-'.repeat(100));
for (const c of cycles) {
  const va = (c.va_msg || '').slice(0, 25).padEnd(25);
  const ds = (c.deltaSrc || '-').padEnd(12);
  const sn = (c.oi_snaps ?? '-').toString().padStart(2);
  const mi = (c.micro_state || '-').slice(0, 18).padEnd(18);
  const dv = (`${c.deriv_bias || '-'}/${c.deriv_score || '-'}`).padEnd(10);
  const ut = (c.ut || '-').padEnd(8);
  const pb = c.pb ? `${c.pb}(${c.pb_conv})` : 'none';
  console.log(`  ${c.ts.slice(11, 19)}  ${va} ${ds} ${sn}  ${mi}  ${dv}  ${ut}  ${pb}`);
}

// 3) Identify root causes
console.log('\n=== DATA-QUALITY ISSUES ===');
const issues = {
  'volume_profile (insufficient candles)': 0,
  'delta source = candle (live tick missing)': 0,
  'oi_snapshots < 2 (no velocity)': 0,
  'micro_state spoof_risk': 0,
  'deriv neutral score < 60': 0,
  'mtf misaligned': 0,
  'ut_bot neutral': 0,
};
for (const c of cycles) {
  if ((c.va_msg || '').includes('insufficient')) issues['volume_profile (insufficient candles)']++;
  if (c.deltaSrc === 'candle') issues['delta source = candle (live tick missing)']++;
  if ((c.oi_snaps ?? 0) < 2) issues['oi_snapshots < 2 (no velocity)']++;
  if ((c.micro_state || '').includes('spoof')) issues['micro_state spoof_risk']++;
  if ((c.deriv_bias === 'neutral') && (Number(c.deriv_score) || 0) < 60) issues['deriv neutral score < 60']++;
  if (c.mtf && c.mtf !== 'full' && c.mtf !== 'partial') issues['mtf misaligned']++;
  if (!c.ut || c.ut === 'neutral') issues['ut_bot neutral']++;
}
for (const [k, n] of Object.entries(issues)) {
  console.log(`  ${n.toString().padStart(4)}/${cycles.length}  ${k}`);
}

// 4) Spot-check the very first volume_analysis line — what message was logged?
const firstVa = lines.find(l => l.includes('hybrid_volume_analysis'));
if (firstVa) {
  console.log('\n=== FIRST volume_analysis EVENT ===');
  const o = JSON.parse(firstVa);
  console.log(JSON.stringify(o, null, 2));
}
