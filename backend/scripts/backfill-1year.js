/**
 * 1-Year Sequential Backfill — NIFTY 50 (spot + futures + option chain + 30m)
 * ==========================================================================
 * Loads a full year of historical NIFTY 50 data into the live-feed/ folder
 * day-by-day, IN ORDER, with proper checkpointing:
 *
 *   1. Computes the target date range (today minus 365 days, walking back)
 *   2. For each trading day (skips weekends):
 *      - if folder already has all required files non-empty → SKIP (resume)
 *      - else fetches spot 1m/5m/15m + futures 1m/5m/15m + option chain
 *      - derives 30m locally from 1m (IST-aligned aggregation)
 *      - writes every file before moving to the next day
 *   3. Honours Dhan rate limits (1.5s cool-down between days, 750ms between
 *      option-chain legs)
 *   4. Writes progress checkpoint to backend/logs/backfill-1year.progress.json
 *      so the run can be safely killed and resumed
 *
 * Usage:
 *   node scripts/backfill-1year.js                    # full year
 *   node scripts/backfill-1year.js 2025-08-01         # from this date forward
 *   node scripts/backfill-1year.js 2025-08-01 2025-12-31   # explicit range
 *   node scripts/backfill-1year.js --force            # re-fetch even if files exist
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { backfillDay } = require('../src/services/historicalBackfill.service');
const logger = require('../src/utils/logger');

const PROGRESS_FILE = path.join(__dirname, '..', 'logs', 'backfill-1year.progress.json');
const LIVE_FEED_DIR = path.join(__dirname, '..', 'live-feed');
const UNDERLYING = 'NIFTY_50';

const REQUIRED_FILES = [
  'candles-1m.jsonl', 'candles-5m.jsonl', 'candles-15m.jsonl', 'candles-30m.jsonl',
  'futures-1m.jsonl', 'futures-5m.jsonl', 'futures-15m.jsonl', 'futures-30m.jsonl',
  'option-chain.jsonl', 'spot.jsonl', 'metadata.json',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toISTDateStr(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isWeekend(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function buildDateList(fromDate, toDate) {
  const dates = [];
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const ds = toISTDateStr(cursor);
    if (!isWeekend(ds)) dates.push(ds);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function isFolderComplete(dateStr) {
  const folder = path.join(LIVE_FEED_DIR, `${dateStr}_${UNDERLYING}`);
  if (!fs.existsSync(folder)) return false;
  for (const f of REQUIRED_FILES) {
    const fp = path.join(folder, f);
    if (!fs.existsSync(fp)) return false;
    if (fs.statSync(fp).size === 0) return false;
  }
  return true;
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch (_) {}
  return { startedAt: null, lastCompletedDate: null, completed: [], failed: [], skipped: [] };
}

function saveProgress(progress) {
  try {
    const dir = path.dirname(PROGRESS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch (e) {
    logger.warn({ err: e.message }, '[1year] failed to save progress');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
  const force = flags.includes('--force');

  // Resolve date range
  let fromDate, toDate;
  const today = toISTDateStr(new Date());
  if (args.length === 0) {
    // default: today minus 365 days → today
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 365);
    fromDate = toISTDateStr(start);
    toDate = today;
  } else if (args.length === 1) {
    fromDate = args[0];
    toDate = today;
  } else {
    fromDate = args[0];
    toDate = args[1];
  }

  // Build date list (excludes weekends)
  const allDates = buildDateList(fromDate, toDate);

  // Determine which dates need backfilling
  const todoDates = force
    ? allDates
    : allDates.filter(d => !isFolderComplete(d));

  const skipCount = allDates.length - todoDates.length;

  console.log('='.repeat(80));
  console.log('1-YEAR HISTORICAL BACKFILL -- NIFTY 50');
  console.log('='.repeat(80));
  console.log(`Date range:        ${fromDate} -> ${toDate}`);
  console.log(`Trading days:      ${allDates.length}`);
  console.log(`Already complete:  ${skipCount} (skipping)`);
  console.log(`To backfill:       ${todoDates.length}`);
  console.log(`Force mode:        ${force ? 'YES (will re-fetch all)' : 'NO (resume mode)'}`);
  console.log(`Progress file:     ${path.relative(process.cwd(), PROGRESS_FILE)}`);
  console.log('='.repeat(80));
  console.log();

  if (todoDates.length === 0) {
    console.log('Nothing to do — all days are already backfilled.');
    process.exit(0);
  }

  // Load progress
  const progress = loadProgress();
  if (!progress.startedAt) progress.startedAt = new Date().toISOString();

  let completed = progress.completed.length;
  let failed = progress.failed.length;
  let skipped = progress.skipped.length;
  const startTime = Date.now();

  for (let i = 0; i < todoDates.length; i++) {
    const date = todoDates[i];
    const idxLabel = `[${i + 1}/${todoDates.length}]`;

    // Re-check completeness right before each fetch (handles partial recovery)
    if (!force && isFolderComplete(date)) {
      console.log(`${idxLabel} ${date}  SKIP (already complete)`);
      progress.skipped.push(date);
      skipped++;
      continue;
    }

    try {
      const t0 = Date.now();
      const result = await backfillDay(date, {
        window: 6,
        expiryFlag: 'WEEK',
        expiryCode: 1,
        overwrite: force,
        skipIfComplete: !force,
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (result.skipped) {
        console.log(`${idxLabel} ${date}  SKIP (cached) [${elapsed}s]`);
        progress.skipped.push(date);
        skipped++;
      } else {
        const c = result.counts;
        console.log(
          `${idxLabel} ${date}  OK  ` +
          `1m=${c.candles1m} 5m=${c.candles5m} 15m=${c.candles15m} 30m=${c.candles30m} ` +
          `f1m=${c.futures1m} chain=${c.chain} [${elapsed}s]`
        );
        progress.completed.push(date);
        progress.lastCompletedDate = date;
        completed++;
      }
    } catch (e) {
      console.log(`${idxLabel} ${date}  FAIL  ${e.message.slice(0, 100)}`);
      progress.failed.push({ date, err: e.message });
      failed++;
    }

    // Save progress every 5 days
    if ((i + 1) % 5 === 0 || i === todoDates.length - 1) {
      saveProgress(progress);
    }

    // Cool-down between days to respect Dhan rate limits
    if (i < todoDates.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  saveProgress(progress);

  const totalSec = Math.round((Date.now() - startTime) / 1000);
  console.log();
  console.log('='.repeat(80));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(80));
  console.log(`Completed: ${completed}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Total time: ${Math.floor(totalSec / 60)}m ${totalSec % 60}s`);
  console.log('='.repeat(80));

  if (progress.failed.length > 0) {
    console.log('\nFailed days (you can re-run to retry):');
    progress.failed.forEach(f => console.log(`  ${f.date}: ${f.err.slice(0, 80)}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
