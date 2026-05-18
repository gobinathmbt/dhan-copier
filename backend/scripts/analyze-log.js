// Lightweight analyzer for the backtest JSONL log
const fs = require('fs');
const path = require('path');

const file = path.resolve(process.argv[2] || 'logs/backtest-2026-05-17T19-00-32-196Z.log');
const content = fs.readFileSync(file, 'utf8');
const lines = content.split(/\r?\n/).filter(Boolean);

const trades = [];
const dailySummaries = [];
const cycleDecisions = [];
const noTradeReasons = {};
const tradeReasonsBySetup = {};
const trapBlocks = [];
const scoreFails = [];
const filterFails = [];
const aggressionStats = { conservative: 0, balanced: 0, aggressive: 0, institutional: 0 };
const strategyCounts = {};
const dayPnL = {};
const winsByStrategy = {};
const lossesByStrategy = {};
const winsBySession = {};
const lossesBySession = {};
const winsByMetaRegime = {};
const lossesByMetaRegime = {};
const winsByOptionType = {};
const lossesByOptionType = {};
const tradesByConfidenceBucket = {};
const tradesByScoreBucket = {};

let runComplete = null;

let lastSession = null;
let lastMeta = null;
let lastVolatility = null;
let lastMarketRegime = null;
let lastDerivBias = null;
let lastScore = null;
let lastStrategy = null;
let lastAggression = null;
let lastTrapDetection = null;
let lastOrderflow = null;
let lastOI = null;
let lastVolumeAnalysis = null;
let lastUTBot = null;
let lastDayLabel = null;

for (const ln of lines) {
  let obj;
  try { obj = JSON.parse(ln); } catch { continue; }
  const src = obj.source;
  const data = obj.data || {};

  if (src === 'hybrid:session_phase') lastSession = data.phase;
  else if (src === 'hybrid:meta_regime') lastMeta = data.state;
  else if (src === 'hybrid:volatility_regime') lastVolatility = data.state;
  else if (src === 'hybrid:market_regime') lastMarketRegime = data.regime;
  else if (src === 'hybrid:derivatives') lastDerivBias = data.overallBias;
  else if (src === 'hybrid:score') lastScore = data;
  else if (src === 'hybrid:strategy') lastStrategy = data.strategy;
  else if (src === 'hybrid:aggression') {
    lastAggression = data.mode;
    aggressionStats[String(data.mode || 'unknown').split('[')[0]] = (aggressionStats[String(data.mode || 'unknown').split('[')[0]] || 0) + 1;
  } else if (src === 'hybrid:trap_detection') lastTrapDetection = data;
  else if (src === 'hybrid:orderflow_state') lastOrderflow = data.state;
  else if (src === 'hybrid:oi_analytics') lastOI = data.regime;
  else if (src === 'hybrid:volume_analysis') lastVolumeAnalysis = data;
  else if (src === 'hybrid:ut_bot') lastUTBot = data;

  if (src === 'backtest') {
    if (obj.message === 'cycle_begin') {
      lastDayLabel = data.dayLabel;
    } else if (obj.message === 'cycle_decision') {
      cycleDecisions.push(data);
      if (data.signal === 'NO_TRADE') {
        const reason = (data.reasoning || '').slice(0, 80);
        const head = reason.split(':')[0].trim();
        noTradeReasons[head] = (noTradeReasons[head] || 0) + 1;
        if (/below threshold/i.test(reason)) scoreFails.push({ score: lastScore?.score, reasoning: reason });
        if (/Trap detection blocked/i.test(reason)) trapBlocks.push({ trap: lastTrapDetection?.trapScore, reason });
        if (/filter:/i.test(reason)) filterFails.push(reason);
      } else {
        // Trade entered -- capture context
        trades.push({
          day: data.dayLabel,
          hhmm: data.hhmm,
          signal: data.signal,
          tradeType: data.tradeType,
          strike: data.strike,
          optionType: data.optionType,
          confidence: data.confidence,
          lots: data.lots,
          reasoning: data.reasoning,
          session: lastSession,
          meta: lastMeta,
          volatility: lastVolatility,
          marketRegime: lastMarketRegime,
          derivBias: lastDerivBias,
          score: lastScore?.score,
          weighted: lastScore?.weighted,
          strategy: lastStrategy,
          aggression: lastAggression,
          orderflow: lastOrderflow,
          oiRegime: lastOI,
          utBotAligned: lastUTBot?.aligned,
        });
        const stratKey = lastStrategy || 'unknown';
        strategyCounts[stratKey] = (strategyCounts[stratKey] || 0) + 1;
      }
    } else if (obj.message === 'trade_entered' || obj.message === 'trade_exit' || obj.message === 'trade_closed') {
      // Look for outcome in data
      if (typeof data.netPnL === 'number' || typeof data.pnl === 'number') {
        const pnl = (typeof data.netPnL === 'number') ? data.netPnL : data.pnl;
        const last = trades[trades.length - 1];
        if (last && last.pnl == null) {
          last.pnl = pnl;
          last.outcome = pnl >= 0 ? 'win' : 'loss';
        }
      }
    } else if (obj.message === 'day_summary') {
      dailySummaries.push(data);
      dayPnL[data.dayLabel] = data.netPnL;
    } else if (obj.message === 'run_complete') {
      runComplete = data;
    }
  }

  // Match trade exits (could be elsewhere) -- look for any messages that contain win/loss tracking
  if (src === 'backtest' && /trade_/i.test(obj.message)) {
    // ignore for now (handled above)
  }
}

// Try to attach outcomes by scanning all backtest messages relating to trades after entry
// We'll search for specific patterns in the raw text instead
const rawTradeOutcomes = [];
const tradeRegex = /"trade_(?:exit|closed|stopped|target_hit)"/i;
for (const ln of lines) {
  if (!tradeRegex.test(ln)) continue;
  let obj; try { obj = JSON.parse(ln); } catch { continue; }
  rawTradeOutcomes.push(obj);
}

// Print summary
console.log('===================================');
console.log('BACKTEST LOG ANALYSIS');
console.log('===================================');
console.log('File:', file);
console.log('Lines:', lines.length);
console.log('runComplete:', JSON.stringify(runComplete, null, 2));
console.log('---');
console.log('Daily summaries:', dailySummaries.length);
let totalTrades = 0, totalWins = 0, totalLoss = 0, totalNet = 0;
for (const d of dailySummaries) {
  totalTrades += d.trades || 0;
  totalWins += d.wins || 0;
  totalLoss += d.losses || 0;
  totalNet += d.netPnL || 0;
}
console.log(`Aggregated: trades=${totalTrades} wins=${totalWins} losses=${totalLoss} winRate=${((totalWins/totalTrades)*100).toFixed(2)}% netPnL=${totalNet.toFixed(2)}`);
console.log('---');
console.log('Best 5 days:');
[...dailySummaries].sort((a,b)=>(b.netPnL||0)-(a.netPnL||0)).slice(0,5).forEach(d=>console.log(`  ${d.dayLabel}: trades=${d.trades} wins=${d.wins} losses=${d.losses} net=${(d.netPnL||0).toFixed(2)}`));
console.log('Worst 5 days:');
[...dailySummaries].sort((a,b)=>(a.netPnL||0)-(b.netPnL||0)).slice(0,5).forEach(d=>console.log(`  ${d.dayLabel}: trades=${d.trades} wins=${d.wins} losses=${d.losses} net=${(d.netPnL||0).toFixed(2)}`));
console.log('---');
console.log('Strategy counts:');
Object.entries(strategyCounts).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}: ${v}`));
console.log('---');
console.log('Trade context distributions:');
const sessionDist = {};
const metaDist = {};
const volatilityDist = {};
const marketRegimeDist = {};
const aggressionDist = {};
const optionTypeDist = {};
const scoreBuckets = {};
for (const t of trades) {
  sessionDist[t.session||'?'] = (sessionDist[t.session||'?']||0)+1;
  metaDist[t.meta||'?'] = (metaDist[t.meta||'?']||0)+1;
  volatilityDist[t.volatility||'?'] = (volatilityDist[t.volatility||'?']||0)+1;
  marketRegimeDist[t.marketRegime||'?'] = (marketRegimeDist[t.marketRegime||'?']||0)+1;
  aggressionDist[t.aggression||'?'] = (aggressionDist[t.aggression||'?']||0)+1;
  optionTypeDist[t.optionType||'?'] = (optionTypeDist[t.optionType||'?']||0)+1;
  const b = t.score == null ? '?' : `${Math.floor(t.score/5)*5}-${Math.floor(t.score/5)*5+5}`;
  scoreBuckets[b] = (scoreBuckets[b]||0)+1;
}
console.log('  Sessions:', sessionDist);
console.log('  MetaRegimes:', metaDist);
console.log('  Volatility:', volatilityDist);
console.log('  MarketRegime:', marketRegimeDist);
console.log('  Aggression:', aggressionDist);
console.log('  OptionType:', optionTypeDist);
console.log('  Score buckets:', scoreBuckets);
console.log('---');
console.log('Top NO_TRADE reasons (head):');
Object.entries(noTradeReasons).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>console.log(`  ${v.toString().padStart(5)} : ${k}`));
console.log('---');
console.log('Total cycle_decisions:', cycleDecisions.length);
const tradeCount = cycleDecisions.filter(d=>d.signal !== 'NO_TRADE').length;
const noTradeCount = cycleDecisions.length - tradeCount;
console.log('  Trades:', tradeCount, 'No trades:', noTradeCount, ' rate:', ((tradeCount/cycleDecisions.length)*100).toFixed(2)+'%');
console.log('---');
console.log('Trap blocks count:', trapBlocks.length);
console.log('Score fails count:', scoreFails.length);
console.log('Filter fails count:', filterFails.length);
