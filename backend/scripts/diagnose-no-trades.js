/**
 * Diagnostic: which gate is blocking trades?
 * Runs ONE cycle for 2026-05-14 mid-morning and prints the verbose hybrid log.
 */
const Module = require('module');
const origRequire = Module.prototype.require;
let _activeContext = { today: { candles: { '1m': [], '5m': [], '15m': [] }, sessionStats: {} }, priorDays: [] };
let _activeHhmm = 1015, _activeWeekday = 'Wed', _openingStrike = null;

const stubs = {
  '../config/env': { dhanAccessToken: 'test', dhanClientId: 'test', nodeEnv: 'test', port: 0 },
  './feedRecorder.service': { instance: { recordSpotTick: () => {}, recordFuturesTick: () => {}, init: () => {}, shutdown: () => {} } },
  './openai.service': { callOpenAICustom: async () => ({}) },
  '../openai.service': { callOpenAICustom: async () => ({}) },
  './engineLogger.service': { logEvent: async () => {} },
  '../engineLogger.service': { logEvent: async () => {} },
  './historicalContextLoader.service': { buildHistoricalContext: async () => _activeContext },
  '../historicalContextLoader.service': null,
  '../professionalTrader.service': { getMarketSession: () => ({ openingStrike: _openingStrike }) },
  './sessionEngine': {
    classifySession: () => ({
      phase: 'morning', hhmm: _activeHhmm, weekday: _activeWeekday,
      aggressionFactor: 1.0, allowEntries: true,
      allowedStrategies: ['momentum','breakout','trend_continuation','scalp'],
      isExpiryDay: false, isExpiryWindow: false, isMiddayChop: false, isPowerHour: false, isOpeningDrive: false,
    }),
    isEntryAllowed: () => true,
  },
  '../../models/ScalpingTrade': { find: () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }), lean: async () => [] }) }) }) },
};
stubs['../historicalContextLoader.service'] = stubs['./historicalContextLoader.service'];
Module.prototype.require = function (id) {
  if (Object.prototype.hasOwnProperty.call(stubs, id) && stubs[id] !== null) return stubs[id];
  return origRequire.call(this, id);
};

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../live-feed');
function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function normCandle(c) { return { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, t: c.t }; }

const day = '2026-05-14';
const folder = path.join(ROOT, day + '_NIFTY_50');
const meta = readJson(path.join(folder, 'metadata.json'));
const c1m = readJsonl(path.join(folder, 'candles-1m.jsonl')).map(normCandle);
const c5m = readJsonl(path.join(folder, 'candles-5m.jsonl')).map(normCandle);
const c15m= readJsonl(path.join(folder, 'candles-15m.jsonl')).map(normCandle);
const oc  = readJsonl(path.join(folder, 'option-chain.jsonl'));

// Cycle at 11:00 IST
const cycleEpoch = new Date(day + 'T05:30:00.000Z').getTime() / 1000 + 5.5 * 3600;   // 11:00 IST
_activeContext.today.candles = { '1m': c1m.filter(c => c.t <= cycleEpoch), '5m': c5m.filter(c => c.t <= cycleEpoch), '15m': c15m.filter(c => c.t <= cycleEpoch) };
_openingStrike = meta?.openingAtm || 23700;
_activeHhmm = 1100;
_activeWeekday = 'Thu';

const ocCur = oc.filter(s => s.t <= cycleEpoch * 1000).pop();
const strikes = ocCur.strikes.map(s => ({
  strike: s.strike,
  call: { ltp: s.ce.ltp, oi: s.ce.oi, oiChange: 0, volume: s.ce.vol, iv: s.ce.iv,
          greeks: { delta: s.ce.delta, theta: s.ce.theta, gamma: s.ce.gamma, vega: s.ce.vega },
          bid: s.ce.bid || s.ce.ltp - 0.5, ask: s.ce.ask || s.ce.ltp + 0.5 },
  put:  { ltp: s.pe.ltp, oi: s.pe.oi, oiChange: 0, volume: s.pe.vol, iv: s.pe.iv,
          greeks: { delta: s.pe.delta, theta: s.pe.theta, gamma: s.pe.gamma, vega: s.pe.vega },
          bid: s.pe.bid || s.pe.ltp - 0.5, ask: s.pe.ask || s.pe.ltp + 0.5 },
}));

const spotLtp = c1m.filter(c => c.t <= cycleEpoch).pop().c;
const atmStrike = ocCur.atm || Math.round(spotLtp / 50) * 50;
const ema = (vals, p) => { const k = 2/(p+1); let e = vals[0]; for (let i=1;i<vals.length;i++) e = vals[i]*k + e*(1-k); return e; };
const closes = c1m.filter(c => c.t <= cycleEpoch).map(c => c.c);
const ema9 = ema(closes, 9), ema20 = ema(closes, 20);
const tfTrend = (cs, n) => { const sub = cs.slice(-n); let u=0,d=0; for (let i=1;i<sub.length;i++) { if (sub[i].c>sub[i-1].c) u++; else if (sub[i].c<sub[i-1].c) d++; } if (u>d*1.4) return 'bullish'; if (d>u*1.4) return 'bearish'; return 'neutral'; };

const tf1=tfTrend(c1m.filter(c => c.t <= cycleEpoch), 12);
const tf5=tfTrend(c5m.filter(c => c.t <= cycleEpoch), 8);
const tf15=tfTrend(c15m.filter(c => c.t <= cycleEpoch), 6);

const ut=(t)=>t==='bullish'?'buy':t==='bearish'?'sell':'none';

const algorithmOutputs = {
  multiTimeframe: {
    timeframes: {
      '1m':  { trend: tf1,  ut_bot_signal: ut(tf1),  ut_bot_trailing_stop: spotLtp - 8 },
      '5m':  { trend: tf5,  ut_bot_signal: ut(tf5),  ut_bot_trailing_stop: spotLtp - 18 },
      '15m': { trend: tf15, ut_bot_signal: ut(tf15), ut_bot_trailing_stop: spotLtp - 35 },
      '30m': { trend: tf15, ut_bot_signal: ut(tf15), ut_bot_trailing_stop: spotLtp - 50 },
    },
    higher_tf_bias: tf15,
  },
  professionalScalping: { adx: { value: 28, strength: 'strong' }, ema: { crossover: ema9 > ema20 ? 'bullish' : 'bearish' } },
  liquidityAnalysis: { liquidity_health: 'good', liquidity_score: 80, liquidity_sweeps: { sweep_risk: 'low', sweep_detected: false }, spread_analysis: { spread_status: 'normal' }, dom_depth: { depth_quality: 'good' } },
  orderFlow: { market_imbalance: tf5 === 'bullish' ? 1.4 : tf5 === 'bearish' ? 0.7 : 1.0, flow_quality: 'institutional' },
  marketInternals: { advances: 1000, declines: 1000, vix: 14 },
  smartMoneyConcepts: { smc_bias: tf15, smc_score: 60 },
  gammaExposure: null,
  globalMarkets: null,
};

const payload = {
  spot_data: { ltp: spotLtp, returns_1m: 0 },
  actual_atm_strike: atmStrike,
  actual_spot_price: spotLtp,
  options_chain: { strikes, atm_strike: atmStrike, pcr_oi: 1.0, pcr_total: 1.0, max_pain: atmStrike, atm_iv: 16, iv_percentile: 50 },
  vwap_analysis: { vwap: spotLtp, price_vs_vwap: 'above', position: 'above', distance_pct: 0.05 },
  volume_orderflow: { volume_spike: false, oi_direction: tf5 },
  market_internals: { vix: 14 },
  market_regime: { current_regime: 'ranging' },
  market_character: 'normal',
  multi_timeframe: algorithmOutputs.multiTimeframe,
  futures_data: { build_up_type: 'unknown' },
};

const settings = {
  targetPoints: 10, slPoints: 15,
  minLots: 1, maxLots: 5,
  maxConcurrentTrades: 1,
  maxDailyLossPct: 3,
  cooldownSec: 300,
  enableSwing: true, swingMaxHoldMinutes: 15,
  maxHoldTimeSeconds: 180,
  enableATRConfirmation: true,
  minEntryPremium: 30,
  hybridMinScore: 60, hybridMinGrade: 'C', executionMinScore: 50,
  enableHybridAIAdvisory: false,
  referenceDate: day,
  trapBlockThreshold: 70,
  aggressionMode: 'institutional',
};

const session = { _id: `diag`, aiModel: 'none', initialCapital: 100000, currentCapital: 100000, realizedPnL: 0, settings };

(async () => {
  // Load hybrid AFTER stubs are in place
  const hybrid = require('../src/services/hybrid');
  hybrid.oiAnalyticsEngine.reset(`diag`);

  // Capture every hybrid log entry
  const origLog = hybrid.hybridLogger.log;
  hybrid.hybridLogger.log = async (e) => { console.log(`[${e.event}] ${e.message}`); };
  hybrid.hybridLogger.info  = async (e) => { console.log(`[${e.event}] ${e.message}`); };
  hybrid.hybridLogger.warn  = async (e) => { console.log(`[WARN ${e.event}] ${e.message}`); };
  hybrid.hybridLogger.error = async (e) => { console.log(`[ERR  ${e.event}] ${e.message}`); };

  const decision = await hybrid.entry.decide({
    aggregator: { payload, atmStrike, optionChain: { strikes } },
    algorithmOutputs,
    masterDecision: null,
    settings, session,
    openTradesCount: 0,
    futuresData: null,
  });
  console.log('\n=== DECISION ===');
  console.log(JSON.stringify({ signal: decision.signal, reasoning: decision.reasoning, strategy: decision.strategy, confidence: decision.confidence }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
