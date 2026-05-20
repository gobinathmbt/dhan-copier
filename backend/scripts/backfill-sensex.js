#!/usr/bin/env node
/**
 * Backfill SENSEX spot history.
 *
 * Usage:
 *   node scripts/backfill-sensex.js               # backfills last 7 trading days
 *   node scripts/backfill-sensex.js --days=14     # last 14 trading days
 *   node scripts/backfill-sensex.js --date=2026-05-19   # single day
 *   node scripts/backfill-sensex.js --days=14 --overwrite   # force re-fetch
 *
 * Writes JSONL files under backend/live-feed/<YYYY-MM-DD>_SENSEX/
 * matching the layout the live recorder uses, so the historical context
 * loader and ultra/support scalp engines find the data on the next run.
 */
require('dotenv').config();
const { backfillSensexDay, backfillSensexRange } = require('../src/services/sensexBackfill.service');
const logger = require('../src/utils/logger');

function parseArgs() {
  const out = { days: 7, date: null, overwrite: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--days=')) out.days = parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--date=')) out.date = arg.slice(7);
    else if (arg === '--overwrite') out.overwrite = true;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  console.log('[sensex-backfill] args:', args);

  if (args.date) {
    const r = await backfillSensexDay(args.date, { overwrite: args.overwrite });
    console.log('Result:', JSON.stringify(r, null, 2));
    process.exit(r.ok || r.skipped ? 0 : 1);
  }

  const result = await backfillSensexRange({ days: args.days, overwrite: args.overwrite });
  const ok = result.days.filter(r => r.ok).length;
  const skipped = result.days.filter(r => r.skipped).length;
  const failed = result.days.filter(r => !r.ok && !r.skipped).length;
  console.log(`\n[sensex-backfill] done — ${ok} ok, ${skipped} skipped, ${failed} failed`);
  if (failed) console.log('Failed days:', result.days.filter(r => !r.ok && !r.skipped));
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error('[sensex-backfill] FATAL', e);
  process.exit(1);
});
