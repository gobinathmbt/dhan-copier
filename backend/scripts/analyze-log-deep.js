// Deeper analyzer — looks at trade outcomes by score bucket, regime, session
const fs = require('fs');
const path = require('path');

const file = path.resolve(process.argv[2] || 'logs/backtest-2026-05-17T19-00-32-196Z.log');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);

// Walk linearly. For each cycle that produced a trade signal, capture context.
// Then look at the next day_summary or trade close logs.
// Backtest engine prints per-day summary; we need per-trade outcomes if logged.

let cycleCtx = null;
const trades = [];          // [{ ctx..., dayLabel, hhmm, signal, strike, optionType }]
let cycleContext = {};   // running context

let allDays = new Set();
let perDay = {};  // dayLabel -> { trades, wins, losses, ... }

const tradeOutcomeLines = [];

for (const ln of lines) {
  let obj; try { obj = JSON.parse(ln); } catch { continue; }
  const src = obj.source;
  const data = obj.data || {};

  if (src === 'hybrid:session_phase') cycleContext.session = data.phase;
  else if (src === 'hybrid:meta_regime') cycleContext.meta = data.state;
  else if (src === 'hybrid:volatility_regime') cycleContext.volatility = data.state;
  else if (src === 'hybrid:market_regime') cycleContext.marketRegime = data.regime;
  else if (src === 'hybrid:derivatives') {
    cycleContext.derivBias = data.overallBias;
    cycleContext.directionScore = data.directionScore;
  }
  else if (src === 'hybrid:score') cycleContext.score = data.score;
  else if (src === 'hybrid:confidence') cycleContext.confidence = data.total;
  else if (src === 'hybrid:strategy') cycleContext.strategy = data.strategy;
  else if (src === 'hybrid:aggression') cycleContext.aggression = data.mode;
  else if (src === 'hybrid:orderflow_state') cycleContext.orderflow = data.state;
  else if (src === 'hybrid:oi_analytics') cycleContext.oiRegime = data.regime;
  else if (src === 'hybrid:trap_detection') cycleContext.trapScore = data.trapScore;
  else if (src === 'hybrid:ut_bot') cycleContext.utAligned = data.aligned;
  else if (src === 'hybrid:gamma_regime') cycleContext.gammaRegime = data.regime;
  else if (src === 'hybrid:mtf_structure') cycleContext.mtfAlign = data.alignment;
  else if (src === 'hybrid:trend_phase') cycleContext.trendPhase = data.phase;
  else if (src === 'hybrid:entry_type') cycleContext.entryType = data.bestType;

  if (src === 'backtest') {
    if (obj.message === 'cycle_begin') {
      cycleCtx = { dayLabel: data.dayLabel, hhmm: data.hhmm, t: data.t };
      cycleContext = { dayLabel: data.dayLabel, hhmm: data.hhmm };
      allDays.add(data.dayLabel);
    } else if (obj.message === 'cycle_decision' && data.signal && data.signal !== 'NO_TRADE') {
      trades.push({
        dayLabel: data.dayLabel, hhmm: data.hhmm, signal: data.signal,
        confidence: data.confidence, strike: data.strike, optionType: data.optionType,
        ...cycleContext,
      });
    } else if (obj.message === 'day_summary') {
      perDay[data.dayLabel] = data;
    } else if (/trade_(?:exit|closed|stopped|target_hit|stop|expired|squared|target)/i.test(obj.message)) {
      tradeOutcomeLines.push(obj);
    } else if (data.outcome || data.netPnL != null || data.tradePnL != null) {
      tradeOutcomeLines.push(obj);
    }
  }
}

console.log('Days:', allDays.size, 'Trades:', trades.length);
console.log('Trade outcome event count:', tradeOutcomeLines.length);

// Bucket trades by various dims
function bucket(arr, keyFn) {
  const map = {};
  for (const t of arr) {
    const k = keyFn(t);
    if (!map[k]) map[k] = [];
    map[k].push(t);
  }
  return map;
}

const byMeta = bucket(trades, t => t.meta || '?');
const bySession = bucket(trades, t => t.session || '?');
const byMarketRegime = bucket(trades, t => t.marketRegime || '?');
const byVolatility = bucket(trades, t => t.volatility || '?');
const byScoreBucket = bucket(trades, t => {
  const s = Number(t.score);
  if (!Number.isFinite(s)) return '?';
  return `${Math.floor(s/5)*5}-${Math.floor(s/5)*5+4}`;
});
const byConfidenceBucket = bucket(trades, t => {
  const s = Number(t.confidence);
  if (!Number.isFinite(s)) return '?';
  return `${Math.floor(s/5)*5}-${Math.floor(s/5)*5+4}`;
});
const byOptionType = bucket(trades, t => t.optionType || '?');
const byEntryType = bucket(trades, t => t.entryType || '?');
const byTrapScore = bucket(trades, t => {
  const s = Number(t.trapScore);
  if (!Number.isFinite(s)) return '?';
  return `${Math.floor(s/10)*10}`;
});
const byOiRegime = bucket(trades, t => t.oiRegime || '?');
const byOrderflow = bucket(trades, t => t.orderflow || '?');
const byTrendPhase = bucket(trades, t => t.trendPhase || '?');
const byGammaRegime = bucket(trades, t => t.gammaRegime || '?');

function reportBucket(name, b) {
  console.log(`\n${name}:`);
  Object.entries(b)
    .map(([k, v]) => [k, v.length])
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${String(k).padEnd(35)} : ${n}`));
}

reportBucket('By Meta Regime', byMeta);
reportBucket('By Session', bySession);
reportBucket('By Market Regime', byMarketRegime);
reportBucket('By Volatility', byVolatility);
reportBucket('By Score Bucket', byScoreBucket);
reportBucket('By Confidence Bucket', byConfidenceBucket);
reportBucket('By OptionType (CE/PE)', byOptionType);
reportBucket('By Entry Type', byEntryType);
reportBucket('By Trap Score Bucket', byTrapScore);
reportBucket('By OI Regime', byOiRegime);
reportBucket('By Orderflow State', byOrderflow);
reportBucket('By Trend Phase', byTrendPhase);
reportBucket('By Gamma Regime', byGammaRegime);

// Now: which combos correlate with worst days?
// Worst days: 03-17, 03-12, 03-10, 03-09, 04-22
const worstDays = ['2026-03-17','2026-03-12','2026-03-10','2026-03-09','2026-04-22'];
const bestDays  = ['2026-03-25','2026-03-20','2026-03-30','2026-05-14','2026-04-07'];
const worstTrades = trades.filter(t => worstDays.includes(t.dayLabel));
const bestTrades = trades.filter(t => bestDays.includes(t.dayLabel));
console.log(`\nWorst days trades (${worstTrades.length}):`);
console.log('  Sessions:', Object.fromEntries(Object.entries(bucket(worstTrades, t=>t.session)).map(([k,v])=>[k,v.length])));
console.log('  MetaRegime:', Object.fromEntries(Object.entries(bucket(worstTrades, t=>t.meta)).map(([k,v])=>[k,v.length])));
console.log('  Score buckets:', Object.fromEntries(Object.entries(bucket(worstTrades, t=>{const s=Number(t.score);return !Number.isFinite(s)?'?':`${Math.floor(s/5)*5}-${Math.floor(s/5)*5+4}`;})).map(([k,v])=>[k,v.length])));
console.log('  Volatility:', Object.fromEntries(Object.entries(bucket(worstTrades, t=>t.volatility)).map(([k,v])=>[k,v.length])));
console.log(`\nBest days trades (${bestTrades.length}):`);
console.log('  Sessions:', Object.fromEntries(Object.entries(bucket(bestTrades, t=>t.session)).map(([k,v])=>[k,v.length])));
console.log('  MetaRegime:', Object.fromEntries(Object.entries(bucket(bestTrades, t=>t.meta)).map(([k,v])=>[k,v.length])));
console.log('  Score buckets:', Object.fromEntries(Object.entries(bucket(bestTrades, t=>{const s=Number(t.score);return !Number.isFinite(s)?'?':`${Math.floor(s/5)*5}-${Math.floor(s/5)*5+4}`;})).map(([k,v])=>[k,v.length])));

// Distribution of trades per day
const perDayCount = {};
for (const t of trades) perDayCount[t.dayLabel] = (perDayCount[t.dayLabel]||0)+1;
const counts = Object.values(perDayCount);
const avg = counts.reduce((a,b)=>a+b,0)/counts.length;
const max = Math.max(...counts);
const min = Math.min(...counts);
console.log(`\nTrades/day: avg=${avg.toFixed(2)} min=${min} max=${max} (over ${counts.length} days)`);
const buckets = {};
for (const c of counts) {
  const b = c >= 15 ? '15+' : c >= 10 ? '10-14' : c >= 6 ? '6-9' : c >= 3 ? '3-5' : c >=1 ? '1-2' : '0';
  buckets[b] = (buckets[b]||0)+1;
}
console.log('  Distribution:', buckets);

// Day-level WR vs trade count
console.log('\nDay-level: trade count vs WR vs net PnL');
const days = Object.values(perDay);
days.sort((a,b)=>(a.trades||0)-(b.trades||0));
const groups = {};
for (const d of days) {
  const c = d.trades || 0;
  const grp = c >= 15 ? '15+' : c >= 10 ? '10-14' : c >= 6 ? '6-9' : c >= 3 ? '3-5' : '1-2';
  if (!groups[grp]) groups[grp] = { days: 0, totalTrades: 0, wins: 0, losses: 0, pnl: 0 };
  groups[grp].days++;
  groups[grp].totalTrades += d.trades || 0;
  groups[grp].wins += d.wins || 0;
  groups[grp].losses += d.losses || 0;
  groups[grp].pnl += d.netPnL || 0;
}
for (const [grp, g] of Object.entries(groups)) {
  const wr = (g.wins / Math.max(1,g.totalTrades)) * 100;
  console.log(`  ${grp.padEnd(7)} : ${g.days} days, ${g.totalTrades} trades, ${g.wins}W/${g.losses}L, WR=${wr.toFixed(1)}%, netPnL=${g.pnl.toFixed(0)}`);
}
