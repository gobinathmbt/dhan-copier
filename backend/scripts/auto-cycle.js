/**
 * auto-cycle.js
 * --------------
 * Convenience runner: invokes backtest-hybrid.js, lets it terminate cleanly
 * (the backtest now calls process.exit(0) on its own), then prints a brief
 * summary plus the path to the resulting log so the calibration step can
 * pick it up.
 *
 * Usage: node scripts/auto-cycle.js
 * Exit code: 0 on success, 1 on backtest failure.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, '../logs');

function run() {
  return new Promise((resolve) => {
    const before = new Set(fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : []);
    const child = spawn(process.execPath, [path.join(__dirname, 'backtest-hybrid.js')], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => {
      const after = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : [];
      const newLogs = after.filter(f => !before.has(f) && /^backtest-.*\.log$/.test(f));
      const log = newLogs.sort().pop() || null;
      resolve({ code, log: log ? path.join(LOG_DIR, log) : null });
    });
  });
}

(async () => {
  const t0 = Date.now();
  const { code, log } = await run();
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[auto-cycle] backtest finished in ${dur}s (exit=${code})`);
  if (log) console.log(`[auto-cycle] log: ${log}`);
  process.exit(code === 0 ? 0 : 1);
})();
