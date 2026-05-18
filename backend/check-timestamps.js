const fs = require('fs');

const files = ['candles-1m', 'candles-5m', 'candles-15m', 'futures-1m', 'futures-5m', 'futures-15m'];
for (const f of files) {
  try {
    const lines = fs.readFileSync('live-feed/2026-05-18_NIFTY_50/' + f + '.jsonl', 'utf8')
      .trim().split('\n').filter(Boolean);
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    const IST = 5 * 3600 + 30 * 60;
    const tStr = last && last.t
      ? new Date((last.t + IST) * 1000).toISOString().slice(11, 19) + ' IST'
      : 'n/a';
    const digits = String(last?.t || 0).length;
    const tag = digits === 10 ? '✅' : digits === 13 ? '❌ ms!' : '?';
    console.log(`${tag}  ${f.padEnd(15)} count=${lines.length}  last=${tStr}  digits=${digits}`);
  } catch (e) {
    console.log(`ERR ${f}: ${e.message}`);
  }
}
