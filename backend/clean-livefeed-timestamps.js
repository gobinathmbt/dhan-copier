/**
 * Sanitises live-feed candle/futures files:
 *   1. Detects 13-digit ms timestamps (year ~58346) and converts them to
 *      10-digit unix seconds (Math.floor(ms/1000)).
 *   2. Drops any bar whose timestamp is older than 2024 or newer than +1y
 *      (these are corruption artifacts).
 *   3. Drops bars outside the date represented by the folder name.
 *   4. Dedupes by timestamp (keep last).
 *
 * Runs on every YYYY-MM-DD_NIFTY_50 folder. Operates idempotently on
 * candles-{1,5,15,30}m.jsonl and futures-{1,5,15,30}m.jsonl.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, 'live-feed');
const UNDERLYING = 'NIFTY_50';
const IST_OFFSET_SEC = 5 * 3600 + 30 * 60;
const FILES_TO_CLEAN = [
  'candles-1m.jsonl', 'candles-5m.jsonl', 'candles-15m.jsonl', 'candles-30m.jsonl',
  'futures-1m.jsonl', 'futures-5m.jsonl', 'futures-15m.jsonl', 'futures-30m.jsonl',
  'spot.jsonl',
];

const MIN_VALID_TS = 1640995200; // 2022-01-01 UTC
const MAX_VALID_TS = Math.floor(Date.now() / 1000) + 86400 * 365; // ~1y future

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeJsonl(file, rows) {
  if (!rows.length) {
    fs.writeFileSync(file, '', 'utf8');
    return;
  }
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function dateMatchesFolder(ts, folderDate) {
  // folderDate is YYYY-MM-DD
  const istDate = new Date((ts + IST_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
  return istDate === folderDate;
}

function cleanFile(file, folderDate, expectedIntervalSec = null) {
  const rows = readJsonl(file);
  if (rows.length === 0) return { kept: 0, dropped: 0, fixed: 0 };

  let fixed = 0;
  let dropped = 0;
  const byTs = new Map();
  for (const r of rows) {
    let t = Number(r.t);
    // 13-digit ms detection: any timestamp > 1e10 is ms
    if (t > 1e10) {
      t = Math.floor(t / 1000);
      r.t = t;
      fixed++;
    }
    if (!Number.isFinite(t) || t < MIN_VALID_TS || t > MAX_VALID_TS) {
      dropped++;
      continue;
    }
    if (!dateMatchesFolder(t, folderDate)) {
      dropped++;
      continue;
    }
    // Drop bars not aligned to the file's interval (e.g. 1m bar in 5m file)
    if (expectedIntervalSec) {
      const tIst = t + IST_OFFSET_SEC;
      if (tIst % expectedIntervalSec !== 0) {
        dropped++;
        continue;
      }
    }
    byTs.set(t, r);
  }

  const cleaned = [...byTs.values()].sort((a, b) => a.t - b.t);
  if (fixed > 0 || dropped > 0 || cleaned.length !== rows.length) {
    writeJsonl(file, cleaned);
  }
  return { kept: cleaned.length, dropped, fixed };
}

function main() {
  const dirs = fs.readdirSync(ROOT_DIR)
    .filter(d => d.endsWith('_' + UNDERLYING))
    .sort();
  console.log(`Cleaning ${dirs.length} day folders…\n`);

  const grandTotal = { kept: 0, dropped: 0, fixed: 0, filesTouched: 0 };
  for (const d of dirs) {
    const folder = path.join(ROOT_DIR, d);
    const folderDate = d.replace('_' + UNDERLYING, '');
    let folderKept = 0, folderDropped = 0, folderFixed = 0, folderTouched = 0;
    for (const f of FILES_TO_CLEAN) {
      const fp = path.join(folder, f);
      if (!fs.existsSync(fp)) continue;
      // Determine expected interval (e.g. candles-5m -> 5min = 300s)
      const m = f.match(/-(\d+)m\.jsonl$/);
      const expectedIntervalSec = m ? Number(m[1]) * 60 : null;
      const before = fs.statSync(fp).size;
      const r = cleanFile(fp, folderDate, expectedIntervalSec);
      const after = fs.existsSync(fp) ? fs.statSync(fp).size : 0;
      folderKept += r.kept;
      folderDropped += r.dropped;
      folderFixed += r.fixed;
      if (before !== after) folderTouched++;
    }
    if (folderDropped > 0 || folderFixed > 0) {
      console.log(`  ${d}  kept=${folderKept} dropped=${folderDropped} fixed=${folderFixed} files_touched=${folderTouched}`);
    }
    grandTotal.kept += folderKept;
    grandTotal.dropped += folderDropped;
    grandTotal.fixed += folderFixed;
    grandTotal.filesTouched += folderTouched;
  }
  console.log('\nGrand total:', grandTotal);
}

main();
