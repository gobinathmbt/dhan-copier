/**
 * Deep diagnostic for zero-trade days and loss-heavy days.
 *
 * Tracks:
 *   - direction resolution (did upstream produce bullish/bearish/neutral?)
 *   - top playbook near-misses (which playbooks were closest to firing?)
 *   - dominant no-trade reason (what's the upstream filter killing entries?)
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const ZERO_DAYS = ['2026-02-23', '2026-03-23', '2026-04-10', '2026-04-15', '2026-04-16', '2026-04-22'];
const LOSS_DAYS = ['2026-03-02', '2026-03-10', '2026-03-24', '2026-04-20', '2026-04-29', '2026-05-07', '2026-05-08'];

function latestBacktestLog() {
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => /^backtest-.*\.log$/.test(f))
    .map(f => ({ f, mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return path.join(LOG_DIR, files[0].f);
}

function analyzeDay(allLines, day) {
  // Pull just the entries for this day. We anchor on dayLabel; once we see
  // a day_start for ANOTHER day, we stop.
  const events = [];
  let inDay = false;
  for (const line of allLines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.message && j.message.startsWith('day_start')) {
      inDay = (j.data?.dayLabel === day);
      continue;
    }
    if (!inDay) continue;
    events.push(j);
  }
  return events;
}

function summarizeDay(day, events, label) {
  console.log(`\n${'='.repeat(110)}`);
  console.log(`DAY: ${day}  ${label}`);
  console.log('='.repeat(110));

  // Group by hhmm-like cycle id (every cycle has a session_phase event with hhmm)
  const cycles = new Map();
  let curCycle = null;
  for (const j of events) {
    if (j.source === 'hybrid:session_phase') {
      curCycle = { hhmm: j.data?.hhmm, events: [], noTrade: null, playbookBest: null, playbookNear: [] };
      cycles.set(cycles.size, curCycle);
    }
    if (curCycle) curCycle.events.push(j);
  }

  let total = cycles.size;
  let resolvedDirection = 0;
  let neutralDirection = 0;
  const noTradeReasons = {};
  const playbookCandidates = {};
  const directionFailureReasons = {};

  for (const [_, c] of cycles) {
    let dir = null;
    for (const e of c.events) {
      if (e.message?.includes('direction=') && e.data?.direction) dir = e.data.direction;
      if (e.source === 'hybrid:no_trade' || (e.message && e.message.startsWith('No clear directional'))) {
        const r = (e.message || '').slice(0, 90);
        noTradeReasons[r] = (noTradeReasons[r] || 0) + 1;
        if (r.startsWith('No clear directional')) {
          neutralDirection++;
          // Capture sub-data
          const subData = e.data || {};
          if (subData.derivatives) {
            const k = `derivBias=${subData.derivatives.overallBias} score=${subData.derivatives.directionScore}`;
            directionFailureReasons[k] = (directionFailureReasons[k] || 0) + 1;
          }
        }
      }
      if (e.source === 'hybrid:playbook' && e.data?.bestName) {
        c.playbookBest = e.data.bestName;
        const k = `${e.data.bestName} (${e.data.bestConviction}, score=${e.data.bestScore})`;
        playbookCandidates[k] = (playbookCandidates[k] || 0) + 1;
      }
      if (e.source === 'hybrid:playbook' && !e.data?.bestName) {
        // No playbook fired. Check what was eligible but invalid.
        const all = e.data?.allPlaybooks || [];
        const top = all.filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);
        for (const p of top) {
          const k = `${p.name}: score=${p.score} conviction=${p.conviction}`;
          playbookCandidates[k] = (playbookCandidates[k] || 0) + 1;
        }
      }
    }
    if (dir && dir !== 'neutral') resolvedDirection++;
  }

  console.log(`Total cycles with session_phase: ${total}`);
  console.log(`Direction resolved (bullish/bearish): ${resolvedDirection}`);
  console.log(`Direction neutral / no-clear-direction: ${neutralDirection}`);

  console.log(`\nTop no-trade reasons:`);
  Object.entries(noTradeReasons).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([r, c]) => {
    console.log(`  (${String(c).padStart(3)}x) ${r}`);
  });

  console.log(`\nTop playbook candidates / near-misses (frequency):`);
  Object.entries(playbookCandidates).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => {
    console.log(`  (${String(v).padStart(3)}x) ${k}`);
  });
}

function loadTrades(allLines, day) {
  const trades = [];
  let inDay = false;
  for (const line of allLines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.message && j.message.startsWith('day_start')) {
      inDay = (j.data?.dayLabel === day);
      continue;
    }
    if (!inDay) continue;
    if (j.message === 'trade_closed') trades.push(j.data);
  }
  return trades;
}

function summarizeLossDay(day, events, allLines) {
  console.log(`\n${'='.repeat(110)}`);
  console.log(`LOSS DAY: ${day}`);
  console.log('='.repeat(110));

  const trades = loadTrades(allLines, day);
  console.log(`\nTrades on this day: ${trades.length}`);
  for (const t of trades) {
    console.log(`  ${t.entryHhmm}->${t.exitHhmm} ${t.signal} strike=${t.strike} entry=${t.entry} exit=${t.exit} pts=${t.pts} reason=${t.reason} held=${t.heldSec}s`);
  }
  // Summarize entry types
  const entryTypeCounts = {};
  trades.forEach(t => {
    const key = t.entryType || 'unknown';
    if (!entryTypeCounts[key]) entryTypeCounts[key] = { n: 0, w: 0, l: 0, pnl: 0 };
    entryTypeCounts[key].n++;
    if (t.pts > 0) entryTypeCounts[key].w++;
    else entryTypeCounts[key].l++;
    entryTypeCounts[key].pnl += (t.pts || 0);
  });
  console.log(`\nEntry type breakdown:`);
  for (const [k, s] of Object.entries(entryTypeCounts)) {
    console.log(`  ${k.padEnd(40)} n=${s.n} w=${s.w} l=${s.l} totPts=${s.pnl.toFixed(1)}`);
  }
}

function main() {
  const logPath = latestBacktestLog();
  console.log(`Analyzing: ${path.basename(logPath)}\n`);
  const allLines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

  console.log('\n' + '#'.repeat(110));
  console.log('# ZERO-TRADE DAYS');
  console.log('#'.repeat(110));
  for (const day of ZERO_DAYS) {
    const events = analyzeDay(allLines, day);
    summarizeDay(day, events, '(ZERO-TRADE DAY)');
  }

  console.log('\n\n' + '#'.repeat(110));
  console.log('# LOSS-HEAVY DAYS');
  console.log('#'.repeat(110));
  for (const day of LOSS_DAYS) {
    const events = analyzeDay(allLines, day);
    summarizeLossDay(day, events, allLines);
  }
}

main();
