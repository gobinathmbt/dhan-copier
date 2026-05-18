/**
 * Backfill missing live-feed files.
 *
 * For every YYYY-MM-DD_NIFTY_50 folder:
 *   - If 1m source exists and a higher TF (5m/15m/30m) is missing or empty,
 *     re-aggregate from 1m and overwrite the higher-TF file.
 *
 * Runs the SAME aggregator as candleSynthesizer.service.js, so live and
 * backfilled files are byte-for-byte equivalent (apart from creation order).
 *
 * Skips the "current bar" guard so historical 30m/15m bars at end-of-day are
 * also written. (Synthesizer skips them only because the bar may still be
 * forming when running live; for past days every bar is closed.)
 */

const fs = require('fs');
const path = require('path');
const { aggregate } = require('./src/services/candleSynthesizer.service');

const ROOT_DIR = path.join(__dirname, 'live-feed');
const UNDERLYING = 'NIFTY_50';
const IST_OFFSET_SEC = 5 * 3600 + 30 * 60;
const INTERVALS = [5, 15, 30];

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

/**
 * Re-aggregate a higher TF from 1m source, ignoring the "current bar" guard
 * since this is for past days. Always writes (overwrite) the destination
 * file with all closed bars produced from 1m.
 */
function backfillAggregateNoCurrentBarGuard(candles1m, intervalMin) {
  if (!candles1m.length) return [];
  const intervalSec = intervalMin * 60;
  const groups = new Map();
  for (const c of candles1m) {
    const tIst = c.t + IST_OFFSET_SEC;
    const barStartIst = Math.floor(tIst / intervalSec) * intervalSec;
    const barStartUtc = barStartIst - IST_OFFSET_SEC;
    if (!groups.has(barStartUtc)) groups.set(barStartUtc, []);
    groups.get(barStartUtc).push(c);
  }
  const result = [];
  for (const [barStart, bars] of groups) {
    if (!bars.length) continue;
    bars.sort((a, b) => a.t - b.t);
    const o = bars[0].o;
    const h = Math.max(...bars.map(b => b.h));
    const l = Math.min(...bars.map(b => b.l));
    const c = bars[bars.length - 1].c;
    const v = bars.reduce((s, b) => s + (b.v || 0), 0);
    result.push({ t: barStart, o, h, l, c, v });
  }
  result.sort((a, b) => a.t - b.t);
  return result;
}

function writeJsonl(file, candles) {
  if (!candles.length) return;
  const lines = candles.map(c => JSON.stringify({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })).join('\n') + '\n';
  fs.writeFileSync(file, lines, 'utf8');
}

function backfillFolder(folderName) {
  const folder = path.join(ROOT_DIR, folderName);
  if (!fs.existsSync(folder)) return { folder: folderName, error: 'no folder' };

  const result = { folder: folderName, candles: {}, futures: {}, skipped: [] };

  for (const type of ['candles', 'futures']) {
    const src1m = path.join(folder, `${type}-1m.jsonl`);
    const candles1m = readJsonl(src1m);
    if (candles1m.length < 2) {
      result.skipped.push(`${type}-1m has ${candles1m.length} bars`);
      continue;
    }

    for (const interval of INTERVALS) {
      const destFile = path.join(folder, `${type}-${interval}m.jsonl`);
      const existing = readJsonl(destFile);
      const expected = backfillAggregateNoCurrentBarGuard(candles1m, interval);

      // If the destination file already has the expected number of bars
      // (or more), skip -- but always ensure 30m gets written since most
      // folders are missing it.
      if (interval === 30 || existing.length === 0 || existing.length < expected.length) {
        writeJsonl(destFile, expected);
        result[type][`${interval}m`] = `wrote ${expected.length} bars (was ${existing.length})`;
      } else {
        result[type][`${interval}m`] = `kept ${existing.length} (expected ${expected.length})`;
      }
    }
  }
  return result;
}

function main() {
  const dirs = fs.readdirSync(ROOT_DIR)
    .filter(d => d.endsWith('_' + UNDERLYING))
    .sort();
  console.log(`Backfilling ${dirs.length} day folders…\n`);

  const summary = { processed: 0, skipped: 0, errors: 0 };
  for (const d of dirs) {
    const r = backfillFolder(d);
    if (r.error) {
      console.log(`  ${d}  ERROR: ${r.error}`);
      summary.errors++;
      continue;
    }
    const haveCandles = Object.keys(r.candles).length;
    const haveFutures = Object.keys(r.futures).length;
    if (haveCandles === 0 && haveFutures === 0) {
      console.log(`  ${d}  SKIP (${r.skipped.join(', ')})`);
      summary.skipped++;
      continue;
    }
    summary.processed++;
    const cMsg = ['5m','15m','30m'].map(k => r.candles[k] ? r.candles[k].split(' ')[1] : '-').join('/');
    const fMsg = ['5m','15m','30m'].map(k => r.futures[k] ? r.futures[k].split(' ')[1] : '-').join('/');
    console.log(`  ${d}  candles[${cMsg}]  futures[${fMsg}]`);
  }
  console.log('\nSummary:', summary);
}

main();
