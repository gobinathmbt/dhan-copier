/**
 * Backtest Log Analyzer
 * =====================
 * Streams the latest backtest log and produces a structured deep-dive:
 *   - cycle outcome distribution (no_trade reasons, signal types)
 *   - score distribution + threshold spread
 *   - per-engine state distribution
 *   - rejection bucket counts (which gate / penalty hits most)
 *   - winning vs losing trade context comparison
 *   - data quality checks (OI deltas, volumes, futures premiums)
 *   - time-of-day distribution
 *   - per-strategy / entry-type / direction P&L
 *
 * Streams the file line-by-line so 28MB doesn't blow memory.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LOGS_DIR = path.resolve(__dirname, '../logs');

function pickLatestLog() {
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.startsWith('backtest-') && f.endsWith('.log')).sort();
  return files.length ? path.join(LOGS_DIR, files[files.length - 1]) : null;
}

const file = process.argv[2] ? path.resolve(process.argv[2]) : pickLatestLog();
if (!file || !fs.existsSync(file)) {
  console.error('No log file found.');
  process.exit(1);
}
console.log(`Analyzing: ${path.basename(file)}\n`);

// ─── Counters ─────────────────────────────────────────────────────────────
const counters = {
  totalLines: 0,
  byMessage: {},                    // top-level message frequency
  cycles: 0,
  cyclesNoTrade: 0,
  cyclesTrade: 0,
  cyclesError: 0,
  cyclesSkippedNoInputs: 0,
  noTradeReasons: {},               // grouped reason → count
  decisionByEntryType: {},
  decisionBySignal: { BUY_CE: 0, BUY_PE: 0, NO_TRADE: 0 },
  decisionByStrategy: {},
  decisionByConfidenceTier: {},
  metaRegimeStates: {},
  marketRegimes: {},
  volatilityStates: {},
  gammaRegimes: {},
  auctionDayTypes: {},
  trendPhases: {},
  trapScoreDistribution: { '0-29':0, '30-49':0, '50-69':0, '70-89':0, '90+':0 },
  scoreDistribution: {},
  hardGateFails: {},
  trades: [],
  // sub-engine state per cycle (latest snapshot)
  // signalQuality buckets: track when score was just below threshold
  scoreVsThreshold: [],             // {score, minScore, gap, signal}
  // Data quality sniff: OI deltas + volumes
  oiSamples: { ceVel: [], peVel: [], ceAdd: [], peAdd: [] },
  futuresSamples: { premium: [], change5m: [] },
  volumeSamples: { vsa: {}, timeVolume: {} },
};

function bucket(s, b = '0-29|30-49|50-69|70-89|90+'.split('|')) {
  if (s >= 90) return '90+';
  if (s >= 70) return '70-89';
  if (s >= 50) return '50-69';
  if (s >= 30) return '30-49';
  return '0-29';
}
function inc(map, key, by = 1) { map[key] = (map[key] || 0) + by; }
function bumpHist(h, val, step = 5) {
  if (!Number.isFinite(val)) return;
  const k = Math.floor(val / step) * step;
  h[k] = (h[k] || 0) + 1;
}

// Group reasoning into a coarse bucket for tallying
function classifyNoTradeReason(reason) {
  if (!reason) return 'unknown';
  const r = reason.toLowerCase();
  if (r.includes('confidence') && r.includes('below'))    return 'confidence_below_threshold';
  if (r.includes('hybrid score'))                          return 'probability_score_below_threshold';
  if (r.includes('trap detection blocked'))                return 'trap_blocked';
  if (r.includes('mtf blocked'))                           return 'mtf_blocked';
  if (r.includes('directional bias'))                      return 'no_direction';
  if (r.includes('htf strongly_bullish'))                  return 'htf_conflict_bullish';
  if (r.includes('htf strongly_bearish'))                  return 'htf_conflict_bearish';
  if (r.includes('atr rejects'))                           return 'atr_rejected_target';
  if (r.includes('strike selection failed'))               return 'no_viable_strike';
  if (r.includes('execution quality blocked'))             return 'execution_quality';
  if (r.includes('risk engine blocks'))                    return 'risk_block';
  if (r.includes('expiry cutoff'))                         return 'expiry_cutoff';
  if (r.includes('forbids'))                               return 'phase_forbid';
  if (r.includes('disallows regime'))                      return 'strategy_regime_mismatch';
  if (r.includes('intraday_momentum requires standard'))   return 'momentum_needs_standard_tier';
  if (r.includes('grade'))                                 return 'grade_too_low';
  if (r.includes('max concurrent'))                        return 'max_concurrent';
  if (r.includes('insufficient sample'))                   return 'insufficient';
  return 'other:' + reason.slice(0, 80);
}

// ─── Stream and parse ──────────────────────────────────────────────────────
(async () => {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // Per-cycle latest sub-engine snapshot (reset each cycle_begin)
  let cycleLatest = {};

  for await (const raw of rl) {
    if (!raw.trim()) continue;
    counters.totalLines++;
    let log;
    try { log = JSON.parse(raw); } catch (_) { continue; }
    inc(counters.byMessage, log.message || 'unknown');

    // Sub-engine outputs
    if (log.source === 'hybrid:meta_regime' && log.data?.state) {
      inc(counters.metaRegimeStates, log.data.state);
      cycleLatest.metaRegime = log.data.state;
    }
    if (log.source === 'hybrid:market_regime' && log.data?.regime) {
      inc(counters.marketRegimes, log.data.regime);
      cycleLatest.regime = log.data.regime;
    }
    if (log.source === 'hybrid:volatility_regime' && log.data?.state) {
      inc(counters.volatilityStates, log.data.state);
      cycleLatest.vol = log.data.state;
    }
    if (log.source === 'hybrid:gamma_regime' && log.data?.regime) {
      inc(counters.gammaRegimes, log.data.regime);
      cycleLatest.gamma = log.data.regime;
    }
    if (log.source === 'hybrid:market_auction' && log.data?.dayType) {
      inc(counters.auctionDayTypes, log.data.dayType);
      cycleLatest.auction = log.data.dayType;
    }
    if (log.source === 'hybrid:trend_phase' && log.data?.phase) {
      inc(counters.trendPhases, log.data.phase);
      cycleLatest.trendPhase = log.data.phase;
    }
    if (log.source === 'hybrid:trap_detection' && log.data?.trapScore != null) {
      inc(counters.trapScoreDistribution, bucket(log.data.trapScore));
      cycleLatest.trap = log.data.trapScore;
    }
    if (log.source === 'hybrid:confidence' && log.data?.total != null) {
      inc(counters.scoreDistribution, Math.floor(log.data.total / 5) * 5);
      cycleLatest.confScore = log.data.total;
      cycleLatest.confTier  = log.data.tier;
      cycleLatest.confAdj   = log.data.adjustments;
    }
    if (log.source === 'hybrid:score' && log.data?.hardGates?.failed?.length) {
      for (const f of log.data.hardGates.failed) inc(counters.hardGateFails, f);
    }
    if (log.source === 'hybrid:oi_analytics' && log.data?.diff) {
      counters.oiSamples.ceVel.push(log.data.diff.ceVelocity);
      counters.oiSamples.peVel.push(log.data.diff.peVelocity);
      counters.oiSamples.ceAdd.push(log.data.diff.ceAdd);
      counters.oiSamples.peAdd.push(log.data.diff.peAdd);
    }
    if (log.source === 'hybrid:volume_analysis' && log.data) {
      const vsa = log.data.vsa?.pattern || 'none';
      inc(counters.volumeSamples.vsa, vsa);
      const tv = log.data.timeVolume?.state || 'none';
      inc(counters.volumeSamples.timeVolume, tv);
    }

    // Cycle outcomes
    if (log.source === 'backtest') {
      if (log.message === 'cycle_begin') {
        counters.cycles++;
        cycleLatest = {};
      }
      else if (log.message === 'cycle_decision') {
        const d = log.data || {};
        inc(counters.decisionBySignal, d.signal);
        if (d.signal !== 'NO_TRADE') {
          counters.cyclesTrade++;
          inc(counters.decisionByEntryType, d.entryType || 'unknown');
          inc(counters.decisionByStrategy,  d.strategy  || 'unknown');
          inc(counters.decisionByConfidenceTier, d.confidenceTier || 'unknown');
        } else {
          counters.cyclesNoTrade++;
          inc(counters.noTradeReasons, classifyNoTradeReason(d.reasoning));
        }
        if (d.confidenceScore != null) {
          counters.scoreVsThreshold.push({
            score: d.confidenceScore, signal: d.signal,
            entryType: d.entryType, strategy: d.strategy,
          });
        }
      }
      else if (log.message === 'trade_closed') {
        counters.trades.push(log.data);
      }
      else if (log.message === 'cycle_error')   counters.cyclesError++;
      else if (log.message?.startsWith('cycle_skipped')) counters.cyclesSkippedNoInputs++;
    }
  }

  // ─── Analytics ────────────────────────────────────────────────────────
  const trades = counters.trades;
  const wins   = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');

  function avg(arr, key) {
    if (!arr.length) return 0;
    return arr.reduce((a, x) => a + (Number(x[key]) || 0), 0) / arr.length;
  }
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // Compare winning vs losing trades by entry type
  const byTypeStats = {};
  for (const t of trades) {
    const k = t.entryType || 'UNKNOWN';
    if (!byTypeStats[k]) byTypeStats[k] = { n:0, w:0, l:0, pnl:0, sumHeld:0,
      avgScore: 0, scoreSum: 0, regimes: {}, phases: {}, signals: {} };
    const s = byTypeStats[k];
    s.n++;
    if (t.result === 'WIN') s.w++;
    if (t.result === 'LOSS') s.l++;
    s.pnl += Number(t.netPnl) || 0;
    s.sumHeld += Number(t.heldSec) || 0;
    if (t.confidenceScore) { s.scoreSum += t.confidenceScore; }
    inc(s.regimes, t.regime || 'unknown');
    inc(s.phases,  t.phase  || 'unknown');
    inc(s.signals, t.signal || 'unknown');
  }
  for (const k of Object.keys(byTypeStats)) {
    const s = byTypeStats[k];
    s.avgScore = s.n ? Number((s.scoreSum / s.n).toFixed(1)) : 0;
    s.avgHeld  = s.n ? Math.round(s.sumHeld / s.n) : 0;
    s.winRate  = s.n ? Number(((s.w / s.n) * 100).toFixed(1)) : 0;
  }

  // Time-of-day analysis
  const tod = {};
  for (const t of trades) {
    const hh = Number(String(t.entryHhmm || '0').padStart(4, '0').slice(0, 2));
    const slot = `${hh}:00`;
    if (!tod[slot]) tod[slot] = { n:0, w:0, pnl:0 };
    tod[slot].n++;
    if (t.result === 'WIN') tod[slot].w++;
    tod[slot].pnl += Number(t.netPnl) || 0;
  }

  // Score buckets winners vs losers
  const scoreBucketsW = {};
  const scoreBucketsL = {};
  for (const t of wins)  bumpHist(scoreBucketsW, t.confidenceScore, 5);
  for (const t of losses) bumpHist(scoreBucketsL, t.confidenceScore, 5);

  // ─── Print ─────────────────────────────────────────────────────────────
  function printObj(o, top = 25, sortByValue = true) {
    const entries = Object.entries(o);
    if (sortByValue) entries.sort((a, b) => b[1] - a[1]);
    for (const [k, v] of entries.slice(0, top)) {
      console.log(`  ${String(k).padEnd(40)} ${v}`);
    }
  }

  console.log(`Total log lines:                 ${counters.totalLines}`);
  console.log(`Cycles (cycle_begin events):     ${counters.cycles}`);
  console.log(`Cycles ending in trade:          ${counters.cyclesTrade}`);
  console.log(`Cycles ending in NO_TRADE:       ${counters.cyclesNoTrade}`);
  console.log(`Cycles errored:                  ${counters.cyclesError}`);
  console.log(`Cycles skipped (no inputs):      ${counters.cyclesSkippedNoInputs}`);

  console.log('\n═══ NO-TRADE REASON DISTRIBUTION ═══');
  printObj(counters.noTradeReasons);

  console.log('\n═══ HARD GATE FAILURES ═══');
  if (Object.keys(counters.hardGateFails).length === 0) {
    console.log('  (none — all cycles passed tier-1 gates)');
  } else {
    printObj(counters.hardGateFails);
  }

  console.log('\n═══ META REGIME STATE DISTRIBUTION ═══');
  printObj(counters.metaRegimeStates);

  console.log('\n═══ MARKET REGIME DISTRIBUTION ═══');
  printObj(counters.marketRegimes);

  console.log('\n═══ VOLATILITY STATE DISTRIBUTION ═══');
  printObj(counters.volatilityStates);

  console.log('\n═══ GAMMA REGIME DISTRIBUTION ═══');
  printObj(counters.gammaRegimes);

  console.log('\n═══ AUCTION DAY TYPE DISTRIBUTION ═══');
  printObj(counters.auctionDayTypes);

  console.log('\n═══ TREND PHASE DISTRIBUTION ═══');
  printObj(counters.trendPhases);

  console.log('\n═══ TRAP SCORE BUCKETS ═══');
  for (const k of ['0-29','30-49','50-69','70-89','90+']) {
    console.log(`  ${k.padEnd(40)} ${counters.trapScoreDistribution[k] || 0}`);
  }

  console.log('\n═══ CONFIDENCE SCORE DISTRIBUTION (5-pt buckets) ═══');
  const scoreKeys = Object.keys(counters.scoreDistribution).map(Number).sort((a, b) => a - b);
  for (const k of scoreKeys) {
    console.log(`  ${(k + '-' + (k + 4)).padEnd(40)} ${counters.scoreDistribution[k]}`);
  }

  console.log('\n═══ TRADES BY ENTRY TYPE ═══');
  console.log('  Type                                      n     W     L   WR%   AvgScore  AvgHold  NetP&L');
  for (const [k, s] of Object.entries(byTypeStats).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${k.padEnd(38)}    ${String(s.n).padStart(3)}  ${String(s.w).padStart(3)}  ${String(s.l).padStart(3)}  ${String(s.winRate).padStart(5)}     ${String(s.avgScore).padStart(4)}    ${String(s.avgHeld).padStart(4)}s   ₹${s.pnl.toFixed(0).padStart(7)}`);
  }

  console.log('\n═══ TRADES BY ENTRY HOUR (IST) ═══');
  const todKeys = Object.keys(tod).sort();
  for (const k of todKeys) {
    const s = tod[k];
    const wr = ((s.w / Math.max(1, s.n)) * 100).toFixed(1);
    console.log(`  ${k.padEnd(40)} n=${s.n}  WR=${wr}%  P&L=₹${s.pnl.toFixed(0)}`);
  }

  console.log('\n═══ SCORE BUCKETS — WINNERS vs LOSERS ═══');
  const allScoreKeys = Array.from(new Set([
    ...Object.keys(scoreBucketsW), ...Object.keys(scoreBucketsL),
  ])).map(Number).sort((a, b) => a - b);
  console.log('  Score bucket           Wins   Losses');
  for (const k of allScoreKeys) {
    console.log(`  ${(k + '-' + (k + 4)).padEnd(20)}    ${String(scoreBucketsW[k] || 0).padStart(4)}    ${String(scoreBucketsL[k] || 0).padStart(4)}`);
  }

  console.log('\n═══ DATA QUALITY — OI DELTAS ═══');
  const oi = counters.oiSamples;
  function describe(arr, label) {
    if (!arr.length) { console.log(`  ${label.padEnd(30)} no samples`); return; }
    const nonZero = arr.filter(x => Math.abs(x) > 0.5).length;
    const med = median(arr);
    const max = Math.max(...arr.map(Math.abs));
    console.log(`  ${label.padEnd(30)} samples=${arr.length}  non-zero=${nonZero}  median=${med}  max=${max}`);
  }
  describe(oi.ceVel, 'CE velocity');
  describe(oi.peVel, 'PE velocity');
  describe(oi.ceAdd, 'CE OI added (last bar)');
  describe(oi.peAdd, 'PE OI added (last bar)');

  console.log('\n═══ DATA QUALITY — VSA / TIME-VOLUME ═══');
  console.log('  VSA pattern distribution:');
  printObj(counters.volumeSamples.vsa);
  console.log('  Time-volume state distribution:');
  printObj(counters.volumeSamples.timeVolume);

  console.log('\n═══ TRADE-LEVEL SUMMARY ═══');
  console.log(`  Total trades:             ${trades.length}`);
  console.log(`  Wins:                     ${wins.length} (${((wins.length / Math.max(1, trades.length)) * 100).toFixed(1)}%)`);
  console.log(`  Losses:                   ${losses.length}`);
  console.log(`  Avg confidence (winners): ${avg(wins, 'confidenceScore').toFixed(1)}`);
  console.log(`  Avg confidence (losers):  ${avg(losses, 'confidenceScore').toFixed(1)}`);
  console.log(`  Avg P&L (winners):        ₹${avg(wins, 'netPnl').toFixed(0)}`);
  console.log(`  Avg P&L (losers):         ₹${avg(losses, 'netPnl').toFixed(0)}`);
  console.log(`  Avg hold (winners):       ${avg(wins, 'heldSec').toFixed(0)}s`);
  console.log(`  Avg hold (losers):        ${avg(losses, 'heldSec').toFixed(0)}s`);

  // Top losing entry types — drill-in
  const losingTypes = Object.entries(byTypeStats)
    .filter(([, s]) => s.pnl < 0)
    .sort((a, b) => a[1].pnl - b[1].pnl);
  if (losingTypes.length) {
    console.log('\n═══ DRILL-IN: LOSING ENTRY TYPES ═══');
    for (const [k, s] of losingTypes) {
      console.log(`\n  ${k} — n=${s.n}, WR=${s.winRate}%, P&L ₹${s.pnl.toFixed(0)}`);
      console.log('    by regime:'); printObj(s.regimes, 8);
      console.log('    by phase:');  printObj(s.phases,  8);
      console.log('    by signal:'); printObj(s.signals, 8);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
