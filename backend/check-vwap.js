const fs = require('fs');
const raw = fs.readFileSync('logs/session-6a0a9f83fbde2857844d110e-2026-05-18.json','utf8');
for (const line of raw.split(/\r?\n/).filter(Boolean)) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  const d = JSON.stringify(obj.data || {});
  if (d.includes('vwap_analysis') || d.includes('price_vs_vwap') || d.includes('"position"')) {
    console.log('Found in:', (obj.msg||'').slice(0,100));
    // Extract position field
    const m1 = d.match(/"position":"([^"]+)"/);
    const m2 = d.match(/"price_vs_vwap":"([^"]+)"/);
    const m3 = d.match(/"vwap":"([^"]+)"/);
    if (m1) console.log('  position:', m1[1]);
    if (m2) console.log('  price_vs_vwap:', m2[1]);
    if (m3) console.log('  vwap value:', m3[1]);
    break;
  }
}
// Also check what the scoring engine uses vs playbook
console.log('\nChecking score event:');
for (const line of raw.split(/\r?\n/).filter(Boolean)) {
  let obj; try { obj = JSON.parse(line); } catch { continue; }
  if ((obj.msg||'').includes('score=59.7') && (obj.msg||'').includes('vwap=80')) {
    console.log('Score msg:', (obj.msg||'').slice(0,300));
    break;
  }
}
