// Analyze a backtest log file: extract day summaries and zero-trade days
const fs = require('fs');
const path = require('path');

const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: node analyze-log.js <logfile>');
  process.exit(1);
}

const content = fs.readFileSync(logFile, 'utf8');
const lines = content.split(/\r?\n/);

const days = new Map(); // dayLabel -> { trades: [], cycles: 0, decisions: {}, regimes: {}, reasons: Map }
let runStart = null;
let runComplete = null;

for (const raw of lines) {
  if (!raw.trim()) continue;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    continue;
  }
  const { source, message, data } = obj;

  if (source === 'backtest' && message === 'run_start') {
    runStart = data;
    continue;
  }
  if (source === 'backtest' && (message === 'run_complete' || message === 'run_summary')) {
    runComplete = data;
    continue;
  }

  if (source === 'backtest' && typeof message === 'string' && message.startsWith('day_start')) {
    const day = data?.dayLabel;
    if (!day) continue;
    if (!days.has(day)) {
      days.set(day, {
        dayLabel: day,
        cycles: 0,
        decisions: {},
        noTradeReasons: new Map(),
        trades: [],
        regimeBuckets: { meta: new Map(), market: new Map(), volatility: new Map() },
      });
    }
  }

  if (source === 'backtest' && message === 'cycle_decision') {
    const day = data?.dayLabel;
    if (!day) continue;
    if (!days.has(day)) {
      days.set(day, {
        dayLabel: day,
        cycles: 0,
        decisions: {},
        noTradeReasons: new Map(),
        trades: [],
        regimeBuckets: { meta: new Map(), market: new Map(), volatility: new Map() },
      });
    }
    const d = days.get(day);
    d.cycles++;
    const sig = data?.signal || 'UNKNOWN';
    d.decisions[sig] = (d.decisions[sig] || 0) + 1;
    if (sig === 'NO_TRADE') {
      const r = data?.reasoning || 'unknown';
      // collapse reason by trimming numeric values
      const norm = r.replace(/\d+(\.\d+)?/g, 'N').slice(0, 200);
      d.noTradeReasons.set(norm, (d.noTradeReasons.get(norm) || 0) + 1);
    } else if (sig && sig !== 'NO_TRADE' && sig !== 'UNKNOWN') {
      d.trades.push({ hhmm: data.hhmm, signal: sig, tradeType: data.tradeType, optionType: data.optionType, lots: data.lots, confidence: data.confidence });
    }
  }

  // Capture trade open/close events  
  if (source === 'backtest' && (message === 'trade_open' || message === 'trade_close' || message === 'order_placed')) {
    const day = data?.dayLabel || data?.day;
    if (day && days.has(day)) {
      days.get(day).trades.push({ event: message, ...data });
    }
  }
}

// Print summary
console.log('=== RUN INFO ===');
console.log('Start:', JSON.stringify(runStart));
console.log('Complete:', JSON.stringify(runComplete));
console.log('Total days seen:', days.size);
console.log('');

const sorted = [...days.values()].sort((a, b) => a.dayLabel.localeCompare(b.dayLabel));
const zeroTradeDays = [];
const tradeCounts = [];

for (const d of sorted) {
  const totalTrades = d.trades.length;
  tradeCounts.push({ day: d.dayLabel, cycles: d.cycles, trades: totalTrades, decisions: d.decisions });
  if (totalTrades === 0) {
    zeroTradeDays.push(d);
  }
}

console.log('=== DAY-BY-DAY TRADE COUNTS ===');
for (const t of tradeCounts) {
  console.log(`${t.day} | cycles=${t.cycles} | trades=${t.trades} | decisions=${JSON.stringify(t.decisions)}`);
}

console.log('\n=== ZERO TRADE DAYS:', zeroTradeDays.length, '===');
for (const d of zeroTradeDays) {
  console.log(`\n--- ${d.dayLabel} (cycles=${d.cycles}) ---`);
  // Top 12 no-trade reasons
  const top = [...d.noTradeReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [reason, count] of top) {
    console.log(`  ${count.toString().padStart(4)}x  ${reason}`);
  }
}
