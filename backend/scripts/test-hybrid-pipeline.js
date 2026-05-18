/**
 * Hybrid Pipeline End-to-End Test
 * --------------------------------
 *
 * Runs the full hybrid entry engine against synthetic but realistic NIFTY 50
 * data. No DB. No live feed. No AI calls.
 *
 * Scenarios:
 *   1. STRONG BULLISH  -- should fire BUY_CE
 *   2. STRONG BEARISH  -- should fire BUY_PE
 *   3. CHOPPY MARKET   -- should refuse (NO_TRADE)
 *
 * The market session is mocked to "morning" so volatility / regime checks
 * pass. NIFTY-realistic candle noise (≈25pts/5m bar) is used so the FRVP
 * and ATR engines see a normal/expansion regime instead of "dead".
 *
 * Invocation:
 *   node scripts/test-hybrid-pipeline.js
 */

// --- Module-level stubs (must run before any hybrid require) ---------------
const Module = require('module');
const origRequire = Module.prototype.require;

// Forward-declared so the historical context stub can read the active scenario
let _activeScenarioCandles = null;

const stubs = {
  '../config/env': { dhanAccessToken: 'test', dhanClientId: 'test', nodeEnv: 'test', port: 0 },

  './feedRecorder.service':  { instance: { recordSpotTick: () => {}, recordFuturesTick: () => {}, init: () => {}, shutdown: () => {} } },

  './openai.service':  { callOpenAICustom: async () => ({}) },
  '../openai.service': { callOpenAICustom: async () => ({}) },

  './engineLogger.service':  { logEvent: async () => {} },
  '../engineLogger.service': { logEvent: async () => {} },

  './historicalContextLoader.service': {
    buildHistoricalContext: async () => ({
      today: { candles: _activeScenarioCandles || { '1m': [], '5m': [], '15m': [] }, sessionStats: {} },
      priorDays: [],
      rollup: null,
    }),
  },
  '../historicalContextLoader.service': null,        // populated below

  '../professionalTrader.service': { getMarketSession: () => ({ openingStrike: 23750 }) },

  // Mock the session engine so we don't depend on real IST clock.
  './sessionEngine': {
    classifySession: () => ({
      phase: 'morning',
      hhmm: 1015,
      weekday: 'Mon',
      aggressionFactor: 1.0,
      allowEntries: true,
      allowedStrategies: ['momentum','breakout','trend_continuation','scalp'],
      isExpiryDay: false,
      isExpiryWindow: false,
      isMiddayChop: false,
      isPowerHour: false,
      isOpeningDrive: false,
    }),
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

// --- Realistic candle generator -- NIFTY scale -----------------------------
// Use a deterministic LCG for repeatability so the test is stable.
let _rngState = 0xC0FFEE;
function rng() {
  _rngState = (_rngState * 1103515245 + 12345) & 0x7FFFFFFF;
  return _rngState / 0x7FFFFFFF;
}
function seedRng(s) { _rngState = (s >>> 0) || 1; }

function genCandles({ count, basePrice, drift, noise, volBase, fattenLast = false }) {
  const out = [];
  let p = basePrice;
  for (let i = 0; i < count; i++) {
    const o = p;
    const c = o + drift + (rng() - 0.5) * noise;
    const h = Math.max(o, c) + rng() * (noise * 0.4);
    const l = Math.min(o, c) - rng() * (noise * 0.4);
    let v = volBase * (0.7 + rng() * 0.6);
    if (fattenLast && i === count - 1) v *= 5;
    out.push({ o, h, l, c, v });
    p = c;
  }
  return out;
}

function buildScenario(kind, cycle = 1) {
  const baseSpot = 23800;

  // NIFTY-realistic noise so volatility regime reads normal / expansion.
  // Drift is the dominant move per bar in the chosen direction.
  // We make bullish/bearish much more pronounced to keep the regime engine
  // out of "ranging" territory.
  const cfg = {
    bullish: { drift1: 3,   drift5: 14, drift15: 30, noise1: 8,  noise5: 24, noise15: 40, futDir: 'bullish', utSig: 'buy'  },
    bearish: { drift1:-3,   drift5:-14, drift15:-30, noise1: 8,  noise5: 24, noise15: 40, futDir: 'bearish', utSig: 'sell' },
    choppy : { drift1: 0,   drift5: 0,  drift15: 0,  noise1:14,  noise5: 50, noise15: 80, futDir: 'neutral', utSig: 'none' },
  }[kind];

  const candles1m  = genCandles({ count: 60, basePrice: baseSpot - cfg.drift5*5, drift: cfg.drift1, noise: cfg.noise1, volBase: 90000,  fattenLast: kind !== 'choppy' });
  const candles5m  = genCandles({ count: 30, basePrice: baseSpot - cfg.drift5*15,drift: cfg.drift5, noise: cfg.noise5, volBase: 220000 });
  const candles15m = genCandles({ count: 25, basePrice: baseSpot - cfg.drift15*8,drift: cfg.drift15,noise: cfg.noise15,volBase: 320000 });

  const lastSpot  = candles5m[candles5m.length - 1].c;
  const atmStrike = Math.round(lastSpot / 50) * 50;

  // Option chain (ATM ± 6) -- supply both absolute OI AND oiChange so
  // derivatives engine sees a clear bias. Bullish = aggressive PE writing,
  // bearish = aggressive CE writing.
  //
  // Cycle 2 OI is larger than cycle 1 in the trend direction, so the OI
  // analytics engine sees genuine velocity (and acceleration on cycle 3+).
  const cycleMul = cycle;
  const strikes = [];
  for (let i = -6; i <= 6; i++) {
    const strike = atmStrike + i * 50;
    const ceLtp = Math.max(20, 200 - i * 22);
    const peLtp = Math.max(20, 50  + i * 22);
    let ceOi = 30000 + Math.abs(i) * 1500;
    let peOi = 30000 + Math.abs(i) * 1500;
    let ceChg = 0, peChg = 0;
    if (kind === 'bullish') {
      // Heavy fresh PE writing piling in across cycles
      peOi  += 28000 + cycleMul * 18000;
      peChg += 16000 + cycleMul * 4000;
      ceOi  += 3000  - cycleMul * 1000;
      ceChg += -3000 - cycleMul * 1500; // CE short covering
    } else if (kind === 'bearish') {
      ceOi  += 28000 + cycleMul * 18000;
      ceChg += 16000 + cycleMul * 4000;
      peOi  += 3000  - cycleMul * 1000;
      peChg += -3000 - cycleMul * 1500;
    } else {
      ceChg += (Math.random() - 0.5) * 1000;
      peChg += (Math.random() - 0.5) * 1000;
    }

    strikes.push({
      strike,
      call: { ltp: ceLtp, oi: Math.round(ceOi), oiChange: Math.round(ceChg), volume: 50000, iv: 16,
              greeks: { delta: Math.max(0.05, 0.5 - i * 0.07), theta: -2, gamma: 0.001, vega: 5 },
              bid: ceLtp - 0.5, ask: ceLtp + 0.5 },
      put:  { ltp: peLtp, oi: Math.round(peOi), oiChange: Math.round(peChg), volume: 50000, iv: 16,
              greeks: { delta: Math.max(0.05, -0.5 - i * 0.07), theta: -2, gamma: 0.001, vega: 5 },
              bid: peLtp - 0.5, ask: peLtp + 0.5 },
    });
  }

  // VWAP -- keep it 8-12 pts away in the right direction so vwap pillar fires
  const vwap = lastSpot - (kind === 'bullish' ? 10 : kind === 'bearish' ? -10 : 0);

  const dir = kind === 'bullish' ? 'bullish' : kind === 'bearish' ? 'bearish' : 'neutral';
  const algorithmOutputs = {
    multiTimeframe: {
      timeframes: {
        '1m':  { trend: dir, ut_bot_signal: cfg.utSig, ut_bot_trailing_stop: lastSpot - cfg.drift1 * 8 },
        '5m':  { trend: dir, ut_bot_signal: cfg.utSig, ut_bot_trailing_stop: lastSpot - cfg.drift5 * 4 },
        '15m': { trend: dir, ut_bot_signal: cfg.utSig, ut_bot_trailing_stop: lastSpot - cfg.drift15 * 2 },
        '30m': { trend: dir, ut_bot_signal: cfg.utSig, ut_bot_trailing_stop: lastSpot - cfg.drift15 * 3 },
      },
      higher_tf_bias: dir,
    },
    professionalScalping: {
      adx: { value: kind === 'choppy' ? 14 : 32, strength: kind === 'choppy' ? 'weak' : 'strong' },
      ema: { crossover: dir },
    },
    liquidityAnalysis: {
      liquidity_health: 'good', liquidity_score: 80,
      liquidity_sweeps: { sweep_risk: 'low', sweep_detected: false },
      spread_analysis:  { spread_status: 'normal' },
      dom_depth:        { depth_quality: 'good' },
    },
    orderFlow: {
      market_imbalance: kind === 'bullish' ? 1.6 : kind === 'bearish' ? 0.55 : 1.0,
      flow_quality: 'institutional',
    },
    marketInternals: {
      advances: kind === 'bullish' ? 1700 : kind === 'bearish' ? 600 : 1000,
      declines: kind === 'bullish' ? 600  : kind === 'bearish' ? 1700: 1000,
      vix: 14,
    },
    smartMoneyConcepts: { smc_bias: dir, smc_score: 65 },
    gammaExposure: null,
    globalMarkets: null,
  };

  const payload = {
    spot_data: { ltp: lastSpot, returns_1m: cfg.drift1 * 0.05 },
    actual_atm_strike: atmStrike,
    actual_spot_price: lastSpot,
    options_chain: {
      strikes,
      atm_strike: atmStrike,
      pcr_oi:    kind === 'bullish' ? 1.45 : kind === 'bearish' ? 0.6 : 1.0,
      pcr_total: kind === 'bullish' ? 1.45 : kind === 'bearish' ? 0.6 : 1.0,
      max_pain: atmStrike + (kind === 'bullish' ? -100 : kind === 'bearish' ? +100 : 0),
      atm_iv: 16, iv_percentile: 55,
    },
    vwap_analysis: {
      vwap,
      price_vs_vwap: kind === 'bullish' ? 'above' : kind === 'bearish' ? 'below' : 'neutral',
      position:      kind === 'bullish' ? 'above' : kind === 'bearish' ? 'below' : 'neutral',
      distance_pct: Math.abs(lastSpot - vwap) / vwap * 100,
    },
    volume_orderflow: {
      volume_spike: kind !== 'choppy',
      oi_direction: dir,
    },
    market_internals: { vix: 14 },
    market_regime: { current_regime: kind === 'bullish' ? 'trending_bullish' : kind === 'bearish' ? 'trending_bearish' : 'ranging' },
    market_character: kind === 'choppy' ? 'volatile' : 'trending',
    multi_timeframe: algorithmOutputs.multiTimeframe,
    futures_data: { build_up_type: kind === 'bullish' ? 'long_buildup' : kind === 'bearish' ? 'short_buildup' : 'unknown' },
  };

  const futuresData = {
    premium: 5, spread: 5,
    direction: cfg.futDir,
    momentum:  kind === 'choppy' ? 'weak' : 'strong',
    change_1m: cfg.drift1 * 0.5,
    change_5m: cfg.drift5 * 0.5,
    trend:     kind === 'bullish' ? 'uptrend' : kind === 'bearish' ? 'downtrend' : 'sideways',
    divergence: null,
  };

  return {
    kind,
    aggregator: { payload, atmStrike, optionChain: { strikes } },
    algorithmOutputs,
    futuresData,
    candles: { '1m': candles1m, '5m': candles5m, '15m': candles15m },
    spotPrice: lastSpot,
    atmStrike,
  };
}

// --- Now require the hybrid entry engine ----------------------------------
const hybrid = require('../src/services/hybrid');

// --- Run scenarios --------------------------------------------------------
function fmtDecision(d) {
  return {
    signal:        d.signal,
    strategy:      d.strategy || null,
    trade_type:    d.trade_type,
    strike:        d.strike,
    option_type:   d.option_type,
    moneyness:     d.moneyness,
    confidence:    d.confidence,
    confScore:     d.confidenceScore,
    confTier:      d.confidenceTier,
    expectedPts:   d.expected_points,
    targetPts:     d.target_points,
    slPts:         d.sl_points,
    maxHoldSec:    d.max_hold_seconds,
    lots:          d.lots_suggested,
    reasoning:     d.reasoning,
  };
}

async function runScenario(name, expected) {
  console.log('\n' + '='.repeat(78));
  console.log(`SCENARIO: ${name.toUpperCase()}`);
  console.log('='.repeat(78));

  // Seed deterministic RNG so each scenario gets a reproducible candle stream.
  seedRng(name === 'bullish' ? 7777 : name === 'bearish' ? 2002 : 3003);

  const settings = {
    targetPoints: 10, slPoints: 15,
    minLots: 1, maxLots: 3,
    maxConcurrentTrades: 2,
    maxDailyLossPct: 3,
    cooldownSec: 60,
    enableSwing: true,
    swingMaxHoldMinutes: 15,
    maxHoldTimeSeconds: 180,
    enableATRConfirmation: true,
    minEntryPremium: 30,
    hybridMinScore: 60,
    hybridMinGrade: 'C',
    executionMinScore: 50,
    enableHybridAIAdvisory: false,
    // Force SCALPING so threshold is 60 -- keeps the test deterministic.
    // Without this, trending+expansion would auto-pick INTRADAY_MOMENTUM
    // (threshold 75) and synthetic data may not always clear that bar.
    forceStrategy: name === 'choppy' ? undefined : 'SCALPING',
  };

  const session = {
    _id: `test-${name}`,
    aiModel: 'none',
    initialCapital: 100000,
    currentCapital: 100000,
    realizedPnL: 0,
    settings,
  };

  // Two cycles so OI velocity / acceleration can compute.
  const scen1 = buildScenario(name, 1);
  _activeScenarioCandles = scen1.candles;
  await hybrid.entry.decide({
    aggregator:        scen1.aggregator,
    algorithmOutputs:  scen1.algorithmOutputs,
    masterDecision:    null,
    settings,
    session,
    openTradesCount:   0,
    futuresData:       scen1.futuresData,
  });

  await new Promise(r => setTimeout(r, 80));

  const scen2 = buildScenario(name, 2);
  _activeScenarioCandles = scen2.candles;
  const decision = await hybrid.entry.decide({
    aggregator:        scen2.aggregator,
    algorithmOutputs:  scen2.algorithmOutputs,
    masterDecision:    null,
    settings,
    session,
    openTradesCount:   0,
    futuresData:       scen2.futuresData,
  });

  console.log(JSON.stringify(fmtDecision(decision), null, 2));

  const ok = expected.signals.includes(decision.signal);
  console.log(ok
    ? `\n✓ PASS -- got ${decision.signal}, expected one of ${expected.signals.join(', ')}`
    : `\n✗ FAIL -- got ${decision.signal}, expected ${expected.signals.join(', ')}`);
  if (!ok && decision.reasoning) console.log(`  reason: ${decision.reasoning}`);

  return { name, ok, decision };
}

(async () => {
  const results = [];
  results.push(await runScenario('bullish', { signals: ['BUY_CE'] }));
  results.push(await runScenario('bearish', { signals: ['BUY_PE'] }));
  results.push(await runScenario('choppy',  { signals: ['NO_TRADE'] }));

  console.log('\n' + '='.repeat(78));
  console.log('SUMMARY');
  console.log('='.repeat(78));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'}  ${r.name.padEnd(10)} -> ${r.decision.signal} ${r.decision.strategy ? '(' + r.decision.strategy + ')' : ''}`);
  }
  const allOk = results.every(r => r.ok);
  console.log(allOk ? '\nALL PASS\n' : '\nSOME FAILED\n');
  process.exit(allOk ? 0 : 1);
})().catch(e => {
  console.error('TEST ERROR:', e);
  console.error(e.stack);
  process.exit(1);
});
