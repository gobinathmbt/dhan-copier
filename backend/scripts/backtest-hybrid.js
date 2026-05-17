/**
 * Hybrid Engine Historical Backtest
 * ----------------------------------
 *
 * Replays recorded NIFTY 50 live-feed data through the hybrid entry engine,
 * simulates trade execution against the recorded option-chain snapshots, and
 * reports a clean win-rate / P&L table.
 *
 * Data source: backend/live-feed/<DATE>_NIFTY_50/
 *   - candles-1m.jsonl, candles-5m.jsonl, candles-15m.jsonl  (spot)
 *   - option-chain.jsonl                                       (per-minute snapshots)
 *   - metadata.json                                            (openingAtm, futures, etc.)
 *
 * Methodology:
 *   1. For each cycle (every 5 minutes from 09:20 IST to 14:30 IST):
 *      - Build aggregator + algorithmOutputs from the data available up to "now"
 *      - Call hybrid.entry.decide()
 *      - If NO_TRADE, advance to next cycle
 *      - If trade fires, lock the option strike + entry LTP and simulate
 *   2. Trade simulation walks forward 1 option-chain snapshot at a time:
 *      - Hard SL hit → EXIT (LOSS)
 *      - Hard target hit → EXIT (WIN)
 *      - Max hold reached → EXIT at current LTP
 *   3. After exit, cooldown for `cooldownSec`, then resume.
 *
 * Position sizing: 1 lot = 65 qty (NIFTY contract spec at the time of recording).
 * Brokerage: ₹40 flat per round-trip (Dhan).
 *
 * Usage:
 *   node scripts/backtest-hybrid.js                  # all available days
 *   node scripts/backtest-hybrid.js 2026-05-15       # single day
 *   node scripts/backtest-hybrid.js 2026-05-01:2026-05-15   # date range
 */

const fs = require('fs');
const path = require('path');

// ─── Log capture: every hybrid log entry + cycle/decision/trade events go
// to a structured file under backend/logs/ for post-run debugging.
const LOG_DIR  = path.resolve(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const _runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(LOG_DIR, `backtest-${_runStamp}.log`);
const _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function _writeLog(level, source, message, data) {
  const ts = new Date().toISOString();
  let safeData = null;
  if (data !== undefined && data !== null) {
    try {
      // Strip very large fields (option chains, candle arrays) to keep file small
      safeData = JSON.parse(JSON.stringify(data, (k, v) => {
        if (k === 'allEvaluations') return undefined;          // keep summary only
        if (k === 'perStrike' && Array.isArray(v) && v.length > 13) return v.slice(0, 13);
        if (k === 'candidates' && Array.isArray(v) && v.length > 5) return v.slice(0, 5);
        if (k === 'levelsUsed' && Array.isArray(v) && v.length > 8) return v.slice(0, 8);
        return v;
      }));
    } catch (_) { safeData = String(data).slice(0, 800); }
  }
  const line = JSON.stringify({ ts, level, source, message, data: safeData });
  _logStream.write(line + '\n');
}
process.on('exit',   () => { try { _logStream.end(); } catch (_) {} });
process.on('SIGINT', () => { try { _logStream.end(); } catch (_) {} process.exit(130); });

// ─── Module-level stubs (must run BEFORE requiring hybrid) ────────────────
const Module = require('module');
const origRequire = Module.prototype.require;

// Live state shared with the historical-context stub
let _activeContext = { today: { candles: { '1m': [], '5m': [], '15m': [] }, sessionStats: {} }, priorDays: [] };
// Live IST hhmm used by sessionEngine stub (so backtest matches the candle's clock)
let _activeHhmm = 1015;
let _activeWeekday = 'Mon';
// Opening strike communicated to professionalTrader stub
let _openingStrike = null;

const stubs = {
  '../config/env': { dhanAccessToken: 'test', dhanClientId: 'test', nodeEnv: 'test', port: 0 },

  './feedRecorder.service':  { instance: { recordSpotTick: () => {}, recordFuturesTick: () => {}, init: () => {}, shutdown: () => {} } },

  './openai.service':  { callOpenAICustom: async () => ({}) },
  '../openai.service': { callOpenAICustom: async () => ({}) },

  './engineLogger.service':  { logEvent: async (e) => { _writeLog(e.level || 'info', 'engineLogger', `[${e.eventType}] ${e.message}`, e.data); } },
  '../engineLogger.service': { logEvent: async (e) => { _writeLog(e.level || 'info', 'engineLogger', `[${e.eventType}] ${e.message}`, e.data); } },

  './historicalContextLoader.service': {
    buildHistoricalContext: async () => _activeContext,
  },
  '../historicalContextLoader.service': null,

  '../professionalTrader.service': {
    getMarketSession: () => ({ openingStrike: _openingStrike }),
  },

  // Mock the session engine to use the candle clock instead of wall clock
  './sessionEngine': {
    classifySession: () => {
      const hhmm = _activeHhmm;
      let phase = 'closed';
      let aggressionFactor = 0;
      let allowEntries = false;
      const allowed = new Set();

      if (hhmm >= 915 && hhmm < 945)         { phase='opening_drive'; aggressionFactor=0.6; allowEntries=true; allowed.add('momentum'); allowed.add('breakout'); }
      else if (hhmm >= 945 && hhmm < 1130)   { phase='morning'; aggressionFactor=1.0; allowEntries=true; allowed.add('momentum'); allowed.add('breakout'); allowed.add('trend_continuation'); allowed.add('scalp'); }
      else if (hhmm >= 1130 && hhmm < 1330)  { phase='midday_chop'; aggressionFactor=0.5; allowEntries=true; allowed.add('mean_reversion'); allowed.add('scalp'); }
      else if (hhmm >= 1330 && hhmm < 1415)  { phase='afternoon'; aggressionFactor=0.8; allowEntries=true; allowed.add('momentum'); allowed.add('trend_continuation'); allowed.add('scalp'); }
      else if (hhmm >= 1415 && hhmm < 1515)  { phase='power_hour'; aggressionFactor=1.0; allowEntries=true; allowed.add('momentum'); allowed.add('breakout'); allowed.add('trend_continuation'); allowed.add('scalp'); }
      else if (hhmm >= 1515 && hhmm < 1530)  { phase='closing'; aggressionFactor=0; allowEntries=false; }

      return {
        phase, hhmm,
        weekday: _activeWeekday,
        aggressionFactor,
        allowEntries,
        allowedStrategies: Array.from(allowed),
        isExpiryDay: _activeWeekday === 'Thu',
        isExpiryWindow: _activeWeekday === 'Thu' && hhmm >= 1400,
        isMiddayChop: phase === 'midday_chop',
        isPowerHour: phase === 'power_hour',
        isOpeningDrive: phase === 'opening_drive',
      };
    },
    isEntryAllowed: () => true,
  },

  '../../models/ScalpingTrade': {
    find: () => ({
      sort: () => ({
        limit: () => ({ select: () => ({ lean: async () => [] }), lean: async () => [] }),
      }),
    }),
  },
};
stubs['../historicalContextLoader.service'] = stubs['./historicalContextLoader.service'];

Module.prototype.require = function (id) {
  if (Object.prototype.hasOwnProperty.call(stubs, id) && stubs[id] !== null) return stubs[id];
  return origRequire.call(this, id);
};

const hybrid = require('../src/services/hybrid');

// Override hybridLogger so we capture every internal emit (per-engine logs,
// scoring breakdowns, decay reasons, etc.) directly to the file.
{
  const hl = hybrid.hybridLogger;
  hl.log   = async (e = {}) => { _writeLog(e.level || 'info', `hybrid:${e.event || 'log'}`, e.message || '', e.data); };
  hl.info  = async (e = {}) => { _writeLog('info',  `hybrid:${e.event || 'log'}`, e.message || '', e.data); };
  hl.warn  = async (e = {}) => { _writeLog('warn',  `hybrid:${e.event || 'log'}`, e.message || '', e.data); };
  hl.error = async (e = {}) => { _writeLog('error', `hybrid:${e.event || 'log'}`, e.message || '', e.data); };
}

// ─── IO helpers ────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '../live-feed');
const NIFTY_LOT_SIZE = 65;
const LOTS_PER_TRADE = 5;                          // 5 lots → 325 qty per trade
const ROUND_TRIP_BROKERAGE = 60;                   // ₹60 flat round-trip

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function listDays(filter) {
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.endsWith('_NIFTY_50'))
    .map(d => d.name.replace('_NIFTY_50', ''))
    .sort();
  if (!filter) return dirs;
  if (filter.includes(':')) {
    const [from, to] = filter.split(':');
    return dirs.filter(d => d >= from && d <= to);
  }
  return dirs.filter(d => d === filter);
}

function epochSecToIstHhmm(t) {
  // t is in seconds; convert to IST hh*100+mm
  const ms = t * 1000;
  const istOffset = 5.5 * 60 * 60 * 1000;
  const d = new Date(ms + istOffset);
  return d.getUTCHours() * 100 + d.getUTCMinutes();
}

function epochSecToIstWeekday(t) {
  const ms = t * 1000;
  const istOffset = 5.5 * 60 * 60 * 1000;
  const d = new Date(ms + istOffset);
  const arr = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return arr[d.getUTCDay()];
}

// Convert recorded candle row {t,o,h,l,c,v} → standard form used by the engine.
function normCandle(c) {
  return { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, t: c.t };
}

// VWAP from cumulative TP × V / V over a candle stream
function vwapFromCandles(candles) {
  let pv = 0, vv = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * (c.v || 0);
    vv += c.v || 0;
  }
  return vv ? pv / vv : null;
}

// Simple ADX-ish trend strength: |sum of last-N close differences| / range
function trendStrength(candles, lookback = 10) {
  if (candles.length < lookback + 1) return { value: 0, strength: 'weak' };
  const tail = candles.slice(-lookback);
  const ups   = tail.filter((c, i, a) => i > 0 && c.c > a[i-1].c).length;
  const downs = tail.filter((c, i, a) => i > 0 && c.c < a[i-1].c).length;
  const directional = Math.abs(ups - downs) / (tail.length - 1);
  const value = Math.round(15 + directional * 30); // 15..45
  return { value, strength: value >= 25 ? 'strong' : value >= 18 ? 'moderate' : 'weak' };
}

// ─── Build inputs to the hybrid engine for a given cycle time ─────────────
function buildCycleInputs(day, cycleEpoch, prev) {
  const meta = day.meta;

  // Filter candles up to cycle time (inclusive)
  const c1m  = day.candles1m.filter(c => c.t <= cycleEpoch);
  const c5m  = day.candles5m.filter(c => c.t <= cycleEpoch);
  const c15m = day.candles15m.filter(c => c.t <= cycleEpoch);
  if (c5m.length < 14 || c15m.length < 8) return null;

  // Find latest option-chain snapshot at or before cycle time
  const ocIdx = day.optionChain.findIndex(s => s.t > cycleEpoch * 1000);
  const ocCur = ocIdx === -1 ? day.optionChain[day.optionChain.length - 1] : day.optionChain[ocIdx - 1];
  if (!ocCur) return null;
  // Previous snapshot, ~5 minutes earlier, for OI delta
  const prevTimeMs = cycleEpoch * 1000 - 5 * 60 * 1000;
  let ocPrev = null;
  for (let i = day.optionChain.length - 1; i >= 0; i--) {
    if (day.optionChain[i].t <= prevTimeMs) { ocPrev = day.optionChain[i]; break; }
  }

  // Build chain with computed oiChange
  const prevByStrike = new Map();
  if (ocPrev) for (const s of ocPrev.strikes) prevByStrike.set(s.strike, s);
  const strikes = ocCur.strikes.map(s => {
    const p = prevByStrike.get(s.strike);
    return {
      strike: s.strike,
      call: {
        ltp: s.ce.ltp, oi: s.ce.oi, oiChange: p ? (s.ce.oi - p.ce.oi) : 0,
        volume: s.ce.vol, iv: s.ce.iv,
        greeks: { delta: s.ce.delta, theta: s.ce.theta, gamma: s.ce.gamma, vega: s.ce.vega },
        bid: s.ce.bid || (s.ce.ltp - 0.5),
        ask: s.ce.ask || (s.ce.ltp + 0.5),
      },
      put: {
        ltp: s.pe.ltp, oi: s.pe.oi, oiChange: p ? (s.pe.oi - p.pe.oi) : 0,
        volume: s.pe.vol, iv: s.pe.iv,
        greeks: { delta: s.pe.delta, theta: s.pe.theta, gamma: s.pe.gamma, vega: s.pe.vega },
        bid: s.pe.bid || (s.pe.ltp - 0.5),
        ask: s.pe.ask || (s.pe.ltp + 0.5),
      },
    };
  });

  const lastCandle5m = c5m[c5m.length - 1];
  const lastCandle1m = c1m[c1m.length - 1];
  const spotLtp = lastCandle1m ? lastCandle1m.c : lastCandle5m.c;
  const atmStrike = ocCur.atm || Math.round(spotLtp / 50) * 50;

  // Aggregate stats
  const vwap = vwapFromCandles(c5m);
  const ema9  = (() => { const k = 2/(9+1);  let e = c1m[0].c; for (let i=1;i<c1m.length;i++) e = c1m[i].c*k + e*(1-k); return e; })();
  const ema20 = (() => { const k = 2/(20+1); let e = c1m[0].c; for (let i=1;i<c1m.length;i++) e = c1m[i].c*k + e*(1-k); return e; })();

  const vwapPos  = spotLtp > vwap ? 'above' : 'below';
  const distPct  = Math.abs((spotLtp - vwap) / vwap) * 100;

  // Trend reads from the candle direction over the last N
  const tfTrend = (candles, n = 10) => {
    const sub = candles.slice(-n);
    if (sub.length < 3) return 'neutral';
    const upMoves   = sub.filter((c, i, a) => i > 0 && c.c > a[i-1].c).length;
    const downMoves = sub.filter((c, i, a) => i > 0 && c.c < a[i-1].c).length;
    if (upMoves > downMoves * 1.4) return 'bullish';
    if (downMoves > upMoves * 1.4) return 'bearish';
    return 'neutral';
  };

  const tf1Trend  = tfTrend(c1m, 12);
  const tf5Trend  = tfTrend(c5m, 8);
  const tf15Trend = tfTrend(c15m, 6);
  const tf30Trend = tfTrend(c15m.filter((_, i) => i % 2 === 0), 5);
  const adx = trendStrength(c5m, 10);

  // UT Bot: derive simple bias by checking whether close > recent SMA + ATR/2
  const utBotSig = (trend) => trend === 'bullish' ? 'buy' : trend === 'bearish' ? 'sell' : 'none';

  // Synthesize algorithm outputs
  const algorithmOutputs = {
    multiTimeframe: {
      timeframes: {
        '1m':  { trend: tf1Trend,  ut_bot_signal: utBotSig(tf1Trend),  ut_bot_trailing_stop: spotLtp - 8 },
        '5m':  { trend: tf5Trend,  ut_bot_signal: utBotSig(tf5Trend),  ut_bot_trailing_stop: spotLtp - 18 },
        '15m': { trend: tf15Trend, ut_bot_signal: utBotSig(tf15Trend), ut_bot_trailing_stop: spotLtp - 35 },
        '30m': { trend: tf30Trend, ut_bot_signal: utBotSig(tf30Trend), ut_bot_trailing_stop: spotLtp - 50 },
      },
      higher_tf_bias: tf15Trend,
    },
    professionalScalping: {
      adx,
      ema: { crossover: ema9 > ema20 ? 'bullish' : 'bearish' },
    },
    liquidityAnalysis: {
      liquidity_health: 'good',
      liquidity_score: 80,
      liquidity_sweeps: { sweep_risk: 'low', sweep_detected: false },
      spread_analysis:  { spread_status: 'normal' },
      dom_depth:        { depth_quality: 'good' },
    },
    orderFlow: {
      market_imbalance: tf5Trend === 'bullish' ? 1.4 : tf5Trend === 'bearish' ? 0.7 : 1.0,
      flow_quality: 'institutional',
    },
    marketInternals: { advances: 1000, declines: 1000, vix: 14 },  // we don't have it — neutral
    smartMoneyConcepts: { smc_bias: tf15Trend, smc_score: 60 },
    gammaExposure: null,
    globalMarkets: null,
  };

  const payload = {
    spot_data: { ltp: spotLtp, returns_1m: lastCandle1m.c - (c1m[c1m.length - 2]?.c || lastCandle1m.c) },
    actual_atm_strike: atmStrike,
    actual_spot_price: spotLtp,
    options_chain: {
      strikes,
      atm_strike: atmStrike,
      pcr_oi: ocCur.pcr_oi || (() => {
        const tot = strikes.reduce((a, s) => ({ ce: a.ce + s.call.oi, pe: a.pe + s.put.oi }), { ce:0, pe:0 });
        return tot.ce > 0 ? tot.pe / tot.ce : 1;
      })(),
      pcr_total: null,
      max_pain: ocCur.maxPain || atmStrike,
      atm_iv: 16, iv_percentile: 50,
    },
    vwap_analysis: { vwap, price_vs_vwap: vwapPos, position: vwapPos, distance_pct: distPct },
    volume_orderflow: { volume_spike: lastCandle5m.v > 1.5 * (c5m.slice(-10).reduce((a, c) => a + c.v, 0) / 10), oi_direction: tf5Trend },
    market_internals: { vix: 14 },
    market_regime: { current_regime: tf5Trend === 'bullish' ? 'trending_bullish' : tf5Trend === 'bearish' ? 'trending_bearish' : 'ranging' },
    market_character: 'trending',
    multi_timeframe: algorithmOutputs.multiTimeframe,
    futures_data: { build_up_type: tf5Trend === 'bullish' ? 'long_buildup' : tf5Trend === 'bearish' ? 'short_buildup' : 'unknown' },
  };

  // Futures data — read from futures candles
  const fc5m  = day.futures5m.filter(c => c.t <= cycleEpoch);
  const lastFut = fc5m[fc5m.length - 1];
  const futChange1m = lastFut ? (fc5m[fc5m.length - 1]?.c - (fc5m[fc5m.length - 2]?.c || lastFut.c)) : 0;
  const futChange5m = lastFut && fc5m.length >= 2 ? lastFut.c - fc5m[fc5m.length - 2].c : 0;
  const futTrend = futChange5m > 5 ? 'uptrend' : futChange5m < -5 ? 'downtrend' : 'sideways';
  const futuresData = lastFut ? {
    premium: 5, spread: lastFut.c - spotLtp,
    direction: futChange1m > 0 ? 'bullish' : futChange1m < 0 ? 'bearish' : 'neutral',
    momentum: Math.abs(futChange5m) > 10 ? 'strong' : 'moderate',
    change_1m: futChange1m,
    change_5m: futChange5m,
    trend: futTrend,
    divergence: null,
  } : null;

  // Today candles for the historical-context stub
  _activeContext = {
    today: { candles: { '1m': c1m, '5m': c5m, '15m': c15m }, sessionStats: {} },
    priorDays: [],
    rollup: null,
  };
  _activeHhmm = epochSecToIstHhmm(cycleEpoch);
  _activeWeekday = epochSecToIstWeekday(cycleEpoch);
  _openingStrike = meta.openingAtm || meta.openingStrikes?.[Math.floor((meta.openingStrikes?.length || 1) / 2)] || atmStrike;

  return {
    aggregator: { payload, atmStrike, optionChain: { strikes } },
    algorithmOutputs,
    futuresData,
    spotLtp,
    atmStrike,
    cycleEpoch,
    optionChain: ocCur,
  };
}

// Get LTP for a (strike, side) at a given epoch from the recorded chain
function getOptionLtpAt(day, strike, side, epochSec) {
  const tMs = epochSec * 1000;
  // Walk forward to find the snapshot that covers this time
  let snap = null;
  for (const s of day.optionChain) {
    if (s.t > tMs) break;
    snap = s;
  }
  if (!snap) snap = day.optionChain[0];
  const row = snap.strikes.find(x => x.strike === strike);
  if (!row) return null;
  return side === 'CE' ? row.ce.ltp : row.pe.ltp;
}

// ─── Trade simulator ──────────────────────────────────────────────────────
function simulateTrade(day, decision, entryEpoch) {
  const side = decision.option_type === 'CE' ? 'CE' : 'PE';
  const strike = decision.strike;
  const entryLtp = decision.entry_premium_estimate;
  if (!entryLtp || entryLtp <= 0) return null;
  const slPrice     = entryLtp - (decision.sl_points || 15);
  const targetPrice = entryLtp + (decision.target_points || 10);
  const maxHoldSec  = decision.max_hold_seconds || 180;

  const exitDeadline = entryEpoch + maxHoldSec;
  // Walk forward in 30-second steps
  for (let t = entryEpoch + 30; t <= exitDeadline; t += 30) {
    const ltp = getOptionLtpAt(day, strike, side, t);
    if (ltp == null) continue;
    if (ltp <= slPrice) {
      return _closeTrade('SL', entryLtp, ltp, t - entryEpoch, decision);
    }
    if (ltp >= targetPrice) {
      return _closeTrade('TARGET', entryLtp, ltp, t - entryEpoch, decision);
    }
  }
  // Max hold reached → exit at last available LTP
  const finalLtp = getOptionLtpAt(day, strike, side, exitDeadline);
  return _closeTrade('TIMEOUT', entryLtp, finalLtp ?? entryLtp, maxHoldSec, decision);
}

function _closeTrade(reason, entry, exit, heldSec, decision) {
  const pts = exit - entry;
  const qty = LOTS_PER_TRADE * NIFTY_LOT_SIZE;     // e.g. 5 × 65 = 325 qty
  const grossPnl = pts * qty;
  const netPnl   = grossPnl - ROUND_TRIP_BROKERAGE;
  const result = netPnl > 0 ? 'WIN' : netPnl < 0 ? 'LOSS' : 'BE';
  const trade = {
    reason, entry, exit, pts: +pts.toFixed(2),
    qty,
    grossPnl: +grossPnl.toFixed(2),
    netPnl: +netPnl.toFixed(2),
    heldSec, result,
    strategy: decision.strategy, signal: decision.signal,
    strike: decision.strike, optionType: decision.option_type,
    confidence: decision.confidence,
    confidenceScore: decision.confidenceScore,
    grade: decision.hybridSnapshot?.grade,
    entryType: decision.hybridSnapshot?.entryType?.type,
    regime: decision.hybridSnapshot?.marketRegime,
    phase: decision.hybridSnapshot?.sessionPhase,
    expiry: decision.hybridSnapshot?.expiry?.behavior === 'expiry_special',
  };
  // Feed expectancy engine for self-tuning
  try {
    require('../src/services/hybrid').expectancyEngine.recordTrade({
      entryType: trade.entryType, regime: trade.regime, phase: trade.phase, expiry: trade.expiry,
      netPnl: trade.netPnl, result: trade.result, holdSec: trade.heldSec,
    });
  } catch (_) {}
  return trade;
}

// ─── Day backtest loop ────────────────────────────────────────────────────
async function backtestDay(dayLabel) {
  const folder = path.join(ROOT, dayLabel + '_NIFTY_50');
  const meta = readJson(path.join(folder, 'metadata.json'));
  if (!meta) { console.log(`  · ${dayLabel}: missing metadata, skipped`); return null; }

  const candles1m = readJsonl(path.join(folder, 'candles-1m.jsonl')).map(normCandle);
  const candles5m = readJsonl(path.join(folder, 'candles-5m.jsonl')).map(normCandle);
  const candles15m= readJsonl(path.join(folder, 'candles-15m.jsonl')).map(normCandle);
  const futures5m = readJsonl(path.join(folder, 'futures-5m.jsonl')).map(normCandle);
  const optionChain = readJsonl(path.join(folder, 'option-chain.jsonl'));

  if (!candles5m.length || !optionChain.length) { console.log(`  · ${dayLabel}: insufficient data, skipped`); return null; }

  const day = { dayLabel, meta, candles1m, candles5m, candles15m, futures5m, optionChain };

  const settings = {
    targetPoints: 10, slPoints: 15,
    // CALIBRATED 2026-05-18: institutional spec — fewer lots, longer holds.
    // Allow engine to scale lots down to 1 on high-premium strikes (saves
    // absolute rupee loss on adverse moves) while still capping at 5.
    minLots: 1, maxLots: LOTS_PER_TRADE,
    maxConcurrentTrades: 1,
    maxDailyLossPct: 3,
    cooldownSec: 5,                              // 5 min cooldown between trades
    enableSwing: true,                             // entry types may pick SWING profile
    swingMaxHoldMinutes: 15,
    maxHoldTimeSeconds: 180,
    enableATRConfirmation: true,
    minEntryPremium: 30,
    hybridMinScore: 60,
    hybridMinGrade: 'C',
    executionMinScore: 50,
    enableHybridAIAdvisory: false,
    referenceDate: dayLabel,
    // CALIBRATED 2026-05-18: align with engine defaults
    trapBlockThreshold: 80,                       // was 70 (engine default 80)
    aggressionMode: 'institutional',
    maxTradesPerDay: 8,                           // institutional spec daily cap
    maxLossesPerDay: 2,                           // halt after 2 losses today (was 3)
  };

  const session = {
    _id: `bt-${dayLabel}`,
    aiModel: 'none',
    initialCapital: 100000,
    currentCapital: 100000,
    realizedPnL: 0,
    settings,
  };

  // Cycle every 5 minutes from 09:20 IST to 14:30 IST
  const dayTs = new Date(`${dayLabel}T00:00:00.000Z`).getTime() / 1000;
  const istOffsetSec = -5.5 * 3600;   // bring IST 09:20 back to UTC seconds
  const cycleStart = dayTs + (9 * 3600 + 20 * 60) + istOffsetSec;
  const cycleEnd   = dayTs + (14 * 3600 + 30 * 60) + istOffsetSec;
  const stepSec    = 5 * 60;

  const trades = [];
  let cooldownUntil = 0;
  let cycles = 0;
  let signalsGenerated = 0;

  // Reset per-day OI snapshot history so velocity/acceleration start fresh
  hybrid.oiAnalyticsEngine.reset(`bt-${dayLabel}`);
  // Reset per-day session memory (failed breakouts, sweeps, etc.)
  hybrid.multiDayContextEngine.resetSessionMemory(dayLabel);

  _writeLog('info', 'backtest', `day_start ${dayLabel}`, {
    dayLabel, openingStrike: meta?.openingAtm,
    candleCounts: { c1m: candles1m.length, c5m: candles5m.length, c15m: candles15m.length },
    optionChainSnapshots: optionChain.length,
  });

  for (let t = cycleStart; t <= cycleEnd; t += stepSec) {
    cycles++;
    if (t < cooldownUntil) continue;

    const inputs = buildCycleInputs(day, t, null);
    if (!inputs) {
      _writeLog('debug', 'backtest', `cycle_skipped (no inputs)`, { dayLabel, hhmm: _activeHhmm, t });
      continue;
    }

    _writeLog('info', 'backtest', `cycle_begin`, {
      dayLabel, hhmm: _activeHhmm, t,
      spotPrice: inputs.spotLtp, atmStrike: inputs.atmStrike,
    });

    let decision;
    try {
      decision = await hybrid.entry.decide({
        aggregator:       inputs.aggregator,
        algorithmOutputs: inputs.algorithmOutputs,
        masterDecision:   null,
        settings, session,
        openTradesCount:  0,
        futuresData:      inputs.futuresData,
        // Calibrated: pass today's trade count + loss streak to entry engine
        // so the daily caps actually fire.
        tradesToday: trades.length,
        lossesToday: trades.filter(r => r.result === 'LOSS').length,
      });
    } catch (e) {
      _writeLog('error', 'backtest', `cycle_error: ${e.message}`, { dayLabel, hhmm: _activeHhmm, stack: e.stack });
      console.log(`    × cycle ${dayLabel} ${_activeHhmm}: error ${e.message}`);
      continue;
    }

    _writeLog('info', 'backtest', `cycle_decision`, {
      dayLabel, hhmm: _activeHhmm,
      signal: decision.signal,
      strategy: decision.strategy,
      tradeType: decision.trade_type,
      entryType: decision.hybridSnapshot?.entryType?.type,
      strike: decision.strike,
      optionType: decision.option_type,
      moneyness: decision.moneyness,
      confidence: decision.confidence,
      confidenceScore: decision.confidenceScore,
      confidenceTier: decision.confidenceTier,
      lots: decision.lots_suggested,
      reasoning: decision.reasoning,
    });

    if (decision.signal === 'NO_TRADE') continue;
    signalsGenerated++;

    // Simulate the trade
    const result = simulateTrade(day, decision, t);
    if (!result) {
      _writeLog('warn', 'backtest', `simulation_failed`, { dayLabel, decision: { signal: decision.signal, strike: decision.strike, entryPremium: decision.entry_premium_estimate } });
      continue;
    }

    result.entryHhmm = epochSecToIstHhmm(t);
    result.exitHhmm  = epochSecToIstHhmm(t + result.heldSec);
    trades.push(result);

    _writeLog('info', 'backtest', `trade_closed`, {
      dayLabel, entryHhmm: result.entryHhmm, exitHhmm: result.exitHhmm,
      reason: result.reason, signal: result.signal, strike: result.strike,
      entry: result.entry, exit: result.exit, pts: result.pts,
      heldSec: result.heldSec, qty: result.qty,
      grossPnl: result.grossPnl, netPnl: result.netPnl, result: result.result,
      strategy: result.strategy, entryType: result.entryType, grade: result.grade,
      confidence: result.confidence, confidenceScore: result.confidenceScore,
      regime: result.regime, phase: result.phase, expiry: result.expiry,
    });

    cooldownUntil = t + result.heldSec + (settings.cooldownSec || 300);
  }

  // Day summary
  const wins   = trades.filter(t => t.result === 'WIN').length;
  const losses = trades.filter(t => t.result === 'LOSS').length;
  const grossPnL = trades.reduce((a, t) => a + t.grossPnl, 0);
  const netPnL   = trades.reduce((a, t) => a + t.netPnl, 0);
  const avgHold  = trades.length ? trades.reduce((a, t) => a + t.heldSec, 0) / trades.length : 0;

  _writeLog('info', 'backtest', `day_summary`, {
    dayLabel, cycles, signalsGenerated, trades: trades.length,
    wins, losses, grossPnL, netPnL, avgHold,
  });

  return { dayLabel, cycles, signalsGenerated, trades, wins, losses, grossPnL, netPnL, avgHold };
}

// ─── Main ─────────────────────────────────────────────────────────────────
(async () => {
  const filter = process.argv[2] || null;
  const days = listDays(filter);
  if (!days.length) { console.error('No days found.'); process.exit(1); }

  console.log(`\nBacktesting ${days.length} day(s) from ${days[0]} to ${days[days.length - 1]}`);
  console.log(`Settings: ${LOTS_PER_TRADE} lots (${LOTS_PER_TRADE * NIFTY_LOT_SIZE} qty), SL 15pts, Target 10pts, Max-hold 180s, Cooldown 5min, Strategy SCALPING`);
  console.log(`Brokerage: ₹${ROUND_TRIP_BROKERAGE} flat per round-trip\n`);
  console.log(`Logging to: ${LOG_FILE}\n`);

  _writeLog('info', 'backtest', 'run_start', {
    days: days.length, from: days[0], to: days[days.length - 1],
    lots: LOTS_PER_TRADE, qty: LOTS_PER_TRADE * NIFTY_LOT_SIZE,
    brokerage: ROUND_TRIP_BROKERAGE,
  });

  // Reset expectancy at the start so we measure true single-pass behaviour
  try { hybrid.expectancyEngine.reset(); } catch (_) {}

  const all = [];
  for (const d of days) {
    process.stdout.write(`  ${d}: `);
    const r = await backtestDay(d);
    if (!r) { console.log('skipped'); continue; }
    console.log(`${r.trades.length} trades, ${r.wins}W/${r.losses}L, P&L ₹${r.netPnL.toFixed(0)}`);
    all.push(r);
  }

  // ─── Aggregate ────────────────────────────────────────────────────────
  const totalTrades = all.reduce((a, d) => a + d.trades.length, 0);
  const totalWins   = all.reduce((a, d) => a + d.wins, 0);
  const totalLoss   = all.reduce((a, d) => a + d.losses, 0);
  const totalSignals= all.reduce((a, d) => a + d.signalsGenerated, 0);
  const totalCycles = all.reduce((a, d) => a + d.cycles, 0);
  const grossPnL    = all.reduce((a, d) => a + d.grossPnL, 0);
  const netPnL      = all.reduce((a, d) => a + d.netPnL, 0);

  const profitableDays = all.filter(d => d.netPnL > 0).length;
  const avgHold        = all.flatMap(d => d.trades).reduce((a, t) => a + t.heldSec, 0) / Math.max(1, totalTrades);

  // R:R achieved
  const allTrades = all.flatMap(d => d.trades);
  const winners  = allTrades.filter(t => t.result === 'WIN');
  const losers   = allTrades.filter(t => t.result === 'LOSS');
  const avgWin   = winners.length ? winners.reduce((a, t) => a + t.netPnl, 0) / winners.length : 0;
  const avgLoss  = losers.length  ? losers.reduce((a, t) => a + t.netPnl, 0)  / losers.length  : 0;
  const expectancy = totalTrades ? netPnL / totalTrades : 0;
  const winRate    = totalTrades ? (totalWins / totalTrades) * 100 : 0;

  console.log('\n' + '═'.repeat(78));
  console.log('BACKTEST RESULTS — HYBRID ENTRY ENGINE');
  console.log('═'.repeat(78));

  console.log('\nPER-DAY BREAKDOWN');
  console.log('─'.repeat(78));
  console.log('Date         Cycles  Signals  Trades   W   L   WinRate    Net P&L');
  console.log('─'.repeat(78));
  for (const d of all) {
    const wr = d.trades.length ? ((d.wins / d.trades.length) * 100).toFixed(1) : '  - ';
    console.log(
      `${d.dayLabel}  ${String(d.cycles).padStart(5)}  ${String(d.signalsGenerated).padStart(7)}  ${String(d.trades.length).padStart(6)}  ${String(d.wins).padStart(2)}  ${String(d.losses).padStart(2)}  ${String(wr).padStart(5)}%   ₹${d.netPnL.toFixed(0).padStart(7)}`
    );
  }
  console.log('─'.repeat(78));

  console.log('\nAGGREGATE');
  console.log('─'.repeat(78));
  const fmt = (k, v) => `  ${k.padEnd(28)} ${v}`;
  console.log(fmt('Days backtested',          all.length));
  console.log(fmt('Profitable days',          `${profitableDays}/${all.length} (${(profitableDays/Math.max(1,all.length)*100).toFixed(1)}%)`));
  console.log(fmt('Total cycles run',         totalCycles));
  console.log(fmt('Signals generated',        totalSignals));
  console.log(fmt('Trades taken',             totalTrades));
  console.log(fmt('Wins',                     totalWins));
  console.log(fmt('Losses',                   totalLoss));
  console.log(fmt('Win rate',                 `${winRate.toFixed(2)}%`));
  console.log(fmt('Gross P&L (₹)',            `${grossPnL.toFixed(2)}`));
  console.log(fmt('Net P&L (₹, after charges)', `${netPnL.toFixed(2)}`));
  console.log(fmt('Average win (₹)',          avgWin.toFixed(2)));
  console.log(fmt('Average loss (₹)',         avgLoss.toFixed(2)));
  console.log(fmt('Expectancy / trade (₹)',   expectancy.toFixed(2)));
  console.log(fmt('Avg hold time (sec)',      avgHold.toFixed(0)));
  console.log(fmt('Profit factor',            (winners.reduce((a,t)=>a+t.netPnl,0) / Math.max(1, Math.abs(losers.reduce((a,t)=>a+t.netPnl,0)))).toFixed(2)));

  // Strategy breakdown
  const byStrat = {};
  for (const t of allTrades) {
    const s = t.strategy || 'UNKNOWN';
    byStrat[s] = byStrat[s] || { n: 0, w: 0, l: 0, pnl: 0 };
    byStrat[s].n++;
    if (t.result === 'WIN') byStrat[s].w++;
    if (t.result === 'LOSS') byStrat[s].l++;
    byStrat[s].pnl += t.netPnl;
  }
  console.log('\nSTRATEGY BREAKDOWN');
  console.log('─'.repeat(78));
  console.log('Strategy            Trades   W    L    WinRate    Net P&L');
  console.log('─'.repeat(78));
  for (const [name, s] of Object.entries(byStrat)) {
    const wr = ((s.w / Math.max(1, s.n)) * 100).toFixed(1);
    console.log(`${name.padEnd(20)} ${String(s.n).padStart(5)}  ${String(s.w).padStart(3)}  ${String(s.l).padStart(3)}  ${wr.padStart(5)}%   ₹${s.pnl.toFixed(0).padStart(7)}`);
  }

  // Entry-type breakdown
  const byEntryType = {};
  for (const t of allTrades) {
    const k = t.entryType || 'UNKNOWN';
    byEntryType[k] = byEntryType[k] || { n: 0, w: 0, l: 0, pnl: 0 };
    byEntryType[k].n++;
    if (t.result === 'WIN') byEntryType[k].w++;
    if (t.result === 'LOSS') byEntryType[k].l++;
    byEntryType[k].pnl += t.netPnl;
  }
  console.log('\nENTRY TYPE BREAKDOWN');
  console.log('─'.repeat(78));
  console.log('Entry Type             Trades   W    L    WinRate    Net P&L');
  console.log('─'.repeat(78));
  for (const [name, s] of Object.entries(byEntryType).sort((a,b) => b[1].n - a[1].n)) {
    const wr = ((s.w / Math.max(1, s.n)) * 100).toFixed(1);
    console.log(`${name.padEnd(22)} ${String(s.n).padStart(5)}  ${String(s.w).padStart(3)}  ${String(s.l).padStart(3)}  ${wr.padStart(5)}%   ₹${s.pnl.toFixed(0).padStart(7)}`);
  }

  // Direction breakdown
  const byDir = { BUY_CE: { n:0, w:0, l:0, pnl:0 }, BUY_PE: { n:0, w:0, l:0, pnl:0 } };
  for (const t of allTrades) {
    const k = t.signal;
    if (!byDir[k]) continue;
    byDir[k].n++;
    if (t.result === 'WIN') byDir[k].w++;
    if (t.result === 'LOSS') byDir[k].l++;
    byDir[k].pnl += t.netPnl;
  }
  console.log('\nDIRECTION BREAKDOWN');
  console.log('─'.repeat(78));
  console.log('Side    Trades   W    L    WinRate    Net P&L');
  console.log('─'.repeat(78));
  for (const [name, s] of Object.entries(byDir)) {
    const wr = ((s.w / Math.max(1, s.n)) * 100).toFixed(1);
    console.log(`${name.padEnd(7)} ${String(s.n).padStart(5)}  ${String(s.w).padStart(3)}  ${String(s.l).padStart(3)}  ${wr.padStart(5)}%   ₹${s.pnl.toFixed(0).padStart(7)}`);
  }

  console.log('\n' + '═'.repeat(78));
  console.log(`FINAL: ${totalWins}/${totalTrades} wins (${winRate.toFixed(2)}%) — Net ₹${netPnL.toFixed(2)} over ${all.length} days`);
  console.log('═'.repeat(78) + '\n');
  console.log(`Full debug log: ${LOG_FILE}\n`);

  _writeLog('info', 'backtest', 'run_complete', {
    days: all.length, totalCycles, totalSignals, totalTrades,
    totalWins, totalLoss, winRate: Number(winRate.toFixed(2)),
    grossPnL: Number(grossPnL.toFixed(2)),
    netPnL: Number(netPnL.toFixed(2)),
    profitFactor: Number((winners.reduce((a,t)=>a+t.netPnl,0) / Math.max(1, Math.abs(losers.reduce((a,t)=>a+t.netPnl,0)))).toFixed(2)),
    avgHoldSec: Number(avgHold.toFixed(0)),
  });
  _logStream.end();
  // Ensure the node process exits cleanly so the calibration loop knows
  // when the run is finished.
  setImmediate(() => process.exit(0));
})().catch(e => {
  console.error('BACKTEST ERROR:', e.stack);
  process.exit(1);
});
