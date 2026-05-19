/**
 * Ultra Scalp ONLY Backtest
 * =========================
 * Pure UT-Bot multi-layer ultra-scalp engine, bypassing the institutional
 * playbook layer entirely. Walks the live-feed JSONL data, calls only:
 *
 *   - ultraScalpEngine.decide()           — multi-layer UT Bot stack
 *   - ultraScalpStrikeSelector.select()   — tier-aware delta/spread picking
 *   - runnerExitEngine.decideRunnerExit() — adaptive exits
 *
 * Reports a clean win-rate / P&L table over the recorded days.
 *
 * Usage:
 *   node scripts/backtest-ultra-scalp.js                       # all days
 *   node scripts/backtest-ultra-scalp.js 2026-05-15            # single day
 *   node scripts/backtest-ultra-scalp.js 2026-05-01:2026-05-15 # date range
 *   node scripts/backtest-ultra-scalp.js --preset=aggressive
 *   node scripts/backtest-ultra-scalp.js --minScore=60
 */

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────────────────────────────────
// Args
// ────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let dayFilter = null;
const userOpts = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.replace(/^--/, '').split('=');
    userOpts[k] = v === undefined ? true : v;
  } else if (!dayFilter) {
    dayFilter = a;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Logging
// ────────────────────────────────────────────────────────────────────────
const LOG_DIR = path.resolve(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const _runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(LOG_DIR, `backtest-ultra-${_runStamp}.log`);
// Open a synchronous file descriptor — guarantees every write is flushed
// to disk before process.exit() is called. The previous WriteStream-based
// approach was async and lost all buffered output on exit.
const _logFd = fs.openSync(LOG_FILE, 'a');
function _log(level, source, message, data) {
  const ts = new Date().toISOString();
  let safeData = null;
  if (data !== undefined && data !== null) {
    try {
      safeData = JSON.parse(JSON.stringify(data, (k, v) => {
        if (k === 'tfReads' || k === 'streams') {
          if (Array.isArray(v) && v.length > 8) return v.slice(0, 8);
          if (v && typeof v === 'object') {
            const o = {};
            for (const kk of Object.keys(v)) {
              if (kk === 'posSeq' || kk === 'stopSeq') continue;
              o[kk] = v[kk];
            }
            return o;
          }
        }
        if (k === 'candidates' && Array.isArray(v) && v.length > 5) return v.slice(0, 5);
        if (k === 'allEvaluations') return undefined;
        return v;
      }));
    } catch (_) { safeData = String(data).slice(0, 800); }
  }
  try {
    fs.writeSync(_logFd, JSON.stringify({ ts, level, source, message, data: safeData }) + '\n');
  } catch (_) { /* never block the run on a log error */ }
}
function _closeLog() { try { fs.closeSync(_logFd); } catch (_) {} }
process.on('exit', _closeLog);
process.on('SIGINT', () => { _closeLog(); process.exit(130); });

// ────────────────────────────────────────────────────────────────────────
// Stub config/env so requires don't blow up
// ────────────────────────────────────────────────────────────────────────
const Module = require('module');
const origRequire = Module.prototype.require;
const stubs = {
  '../config/env': { dhanAccessToken: 'test', dhanClientId: 'test', nodeEnv: 'test', port: 0 },
};
Module.prototype.require = function (id) {
  if (Object.prototype.hasOwnProperty.call(stubs, id) && stubs[id] !== null) return stubs[id];
  return origRequire.call(this, id);
};

// ────────────────────────────────────────────────────────────────────────
// Engines under test
// ────────────────────────────────────────────────────────────────────────
const ultraScalpEngine = require('../src/services/hybrid/ultraScalpEngine');
const strikeSelector   = require('../src/services/hybrid/ultraScalpStrikeSelector');
const runnerExit       = require('../src/services/hybrid/runnerExitEngine');

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '../live-feed');
const NIFTY_LOT_SIZE = 65;
const LOTS_PER_TRADE = 5;
const ROUND_TRIP_BROKERAGE = 60;

// User-tunable settings (CLI flags override defaults)
const SETTINGS = {
  cooldownSec: Number(userOpts.cooldown) || 180,         // 3 min between trades
  maxTradesPerDay: Number(userOpts.maxTradesPerDay) || 12,
  cycleStepSec: Number(userOpts.cycleStep) || 60,        // walk every 60s
  windowStartHhmm: Number(userOpts.windowStart) || 920,
  windowEndHhmm:   Number(userOpts.windowEnd)   || 1500,
  ultraScalp: {
    preset: userOpts.preset || 'high_accuracy',
    minScore: Number(userOpts.minScore) || 80,
    requireRegime: userOpts.requireRegime !== 'false',
    flipWindowMin: Number(userOpts.flipWindowMin) || 10,
    flipLimit: Number(userOpts.flipLimit) || 2,
    atrExpansionMin: Number(userOpts.atrExpansionMin) || 0.85,
    slopeMin: Number(userOpts.slopeMin) || 1.0,
  },
};

// ────────────────────────────────────────────────────────────────────────
// IO helpers
// ────────────────────────────────────────────────────────────────────────
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim())
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
  const ms = t * 1000;
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return d.getUTCHours() * 100 + d.getUTCMinutes();
}
function normCandle(c) { return { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, t: c.t }; }
function vwapFromCandles(candles) {
  let pv = 0, vv = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * (c.v || 0); vv += c.v || 0;
  }
  return vv ? pv / vv : null;
}

// ────────────────────────────────────────────────────────────────────────
// Build inputs for the ultra-scalp engine
// ────────────────────────────────────────────────────────────────────────
function _build3mFromOneMin(c1m) {
  if (!Array.isArray(c1m) || c1m.length < 3) return [];
  const out = [];
  for (let i = 0; i < c1m.length; i += 3) {
    const slice = c1m.slice(i, i + 3);
    if (!slice.length) continue;
    const o = slice[0].o, c = slice[slice.length - 1].c;
    let h = -Infinity, l = Infinity, v = 0;
    for (const b of slice) {
      if (b.h > h) h = b.h;
      if (b.l < l) l = b.l;
      v += b.v || 0;
    }
    out.push({ o, h, l, c, v, t: slice[0].t });
  }
  return out;
}

function buildContext(day, cycleEpoch) {
  const c1m  = day.candles1m.filter(c => c.t <= cycleEpoch);
  const c5m  = day.candles5m.filter(c => c.t <= cycleEpoch);
  const c15m = day.candles15m.filter(c => c.t <= cycleEpoch);
  if (c1m.length < 10 || c5m.length < 10) return null;

  // Find latest option chain at or before this time
  let oc = null;
  for (let i = day.optionChain.length - 1; i >= 0; i--) {
    if (day.optionChain[i].t <= cycleEpoch * 1000) { oc = day.optionChain[i]; break; }
  }
  if (!oc) return null;

  const lastC1 = c1m[c1m.length - 1];
  const lastC5 = c5m[c5m.length - 1];
  const spotPrice = lastC1?.c || lastC5?.c;
  const atmStrike = oc.atm || Math.round(spotPrice / 50) * 50;
  const vwap = vwapFromCandles(c5m);
  const vwapPos = spotPrice > vwap ? 'above' : 'below';

  // Crude volatility regime from ATR
  let atr5m = 0;
  if (c5m.length >= 15) {
    let tr = 0;
    for (let i = c5m.length - 14; i < c5m.length; i++) {
      const cur = c5m[i], prev = c5m[i - 1] || c5m[i];
      const t = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
      tr += t;
    }
    atr5m = tr / 14;
  }
  const atrPct5m = atr5m / Math.max(1, spotPrice) * 100;
  const volState = atrPct5m < 0.04 ? 'dead'
                 : atrPct5m < 0.08 ? 'low'
                 : atrPct5m < 0.16 ? 'normal'
                 :                   'expansion';
  const volatilityRegime = { state: volState, atr5m, atrPct5m };

  // Crude delta read for noise filter — % up bars vs down over last N
  const tail = c5m.slice(-12);
  let upVol = 0, downVol = 0;
  for (const c of tail) {
    if (c.c >= c.o) upVol += c.v || 0;
    else            downVol += c.v || 0;
  }
  const cvdPctLong = (upVol + downVol) > 0 ? ((upVol - downVol) / (upVol + downVol)) * 100 : 0;
  const volumeAnalysis = { delta: { cvdPctLong, bias: cvdPctLong > 5 ? 'bullish' : cvdPctLong < -5 ? 'bearish' : 'neutral' } };

  return {
    candles1m: c1m,
    candles3m: _build3mFromOneMin(c1m),
    candles5m: c5m,
    candles15m: c15m,
    spotPrice, atmStrike,
    vwap: { vwap, position: vwapPos },
    volumeAnalysis,
    volatilityRegime,
    optionChain: oc,
  };
}

// Build the strike chain in API shape from a recorded option-chain snapshot
function buildPrimaryStrikes(oc, prevOc) {
  const prevByStrike = new Map();
  if (prevOc) for (const s of prevOc.strikes) prevByStrike.set(s.strike, s);
  return oc.strikes.map(s => {
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
}

// Get LTP at a given epoch from the recorded option chain
function getLtpAt(day, strike, side, epochSec) {
  let snap = null;
  for (const s of day.optionChain) {
    if (s.t > epochSec * 1000) break;
    snap = s;
  }
  if (!snap) snap = day.optionChain[0];
  const row = snap.strikes.find(x => x.strike === strike);
  if (!row) return null;
  return side === 'CE' ? row.ce.ltp : row.pe.ltp;
}

// ────────────────────────────────────────────────────────────────────────
// Trade simulator
// ────────────────────────────────────────────────────────────────────────
function simulateTrade(day, decision, entryEpoch) {
  const side = decision.option_type === 'CE' ? 'CE' : 'PE';
  const strike = decision.strike;
  const entryLtp = decision.entry_premium_estimate;
  if (!entryLtp || entryLtp <= 0) return null;
  const slPts     = decision.sl_points || 8;
  const targetPts = decision.target_points || 10;
  const maxHoldSec = decision.max_hold_seconds || 120;
  const smartTrail = decision.smartTrail || null;
  const volState   = decision.volState || 'normal';

  const isRunner = smartTrail?.mode === 'runner' || smartTrail?.mode === 'hybrid_runner_continuation';
  let effectiveMaxHoldSec = maxHoldSec;
  let runnerExtended = false;
  let peakLtp = entryLtp;
  const noProgressDeadline = entryEpoch + Math.floor(maxHoldSec * 0.7);

  let t = entryEpoch + 30;
  while (t <= entryEpoch + effectiveMaxHoldSec) {
    const ltp = getLtpAt(day, strike, side, t);
    if (ltp == null) { t += 30; continue; }
    if (ltp > peakLtp) peakLtp = ltp;

    // Runner extension once lock crossed
    if (isRunner && !runnerExtended) {
      const lockPts = (smartTrail.lockTriggerPct || 0.5) * targetPts;
      if (peakLtp - entryLtp >= lockPts) {
        effectiveMaxHoldSec = Math.max(maxHoldSec, maxHoldSec * 3);
        runnerExtended = true;
      }
    }

    // Use runner exit engine when smart-trail configured
    if (smartTrail) {
      const er = runnerExit.decideRunnerExit({
        entry: entryLtp, current: ltp, peak: peakLtp,
        targetPts, slPts, smartTrail, volState,
        momentum: {}, heldSec: t - entryEpoch, maxHoldSec,
      });
      if (er.action === 'EXIT') {
        const code = er.reason.startsWith('SL hit')        ? 'SL'
                   : er.reason.startsWith('Target hit')    ? 'TARGET'
                   : er.reason.startsWith('Smart-lock')    ? 'SMART_LOCK'
                   : er.reason.startsWith('Adaptive')      ? 'SMART_TRAIL'
                   : er.reason.startsWith('Runner end')    ? 'RUNNER_END'
                   :                                          'EXIT';
        return _close(code, entryLtp, ltp, t - entryEpoch, decision, peakLtp);
      }
    } else {
      // Fallback fixed exits
      if (ltp <= entryLtp - slPts)     return _close('SL',     entryLtp, ltp, t - entryEpoch, decision, peakLtp);
      if (ltp >= entryLtp + targetPts) return _close('TARGET', entryLtp, ltp, t - entryEpoch, decision, peakLtp);
    }

    // No-progress (skipped for runner mode)
    if (!isRunner && t >= noProgressDeadline) {
      const peakPts = peakLtp - entryLtp;
      const curPts = ltp - entryLtp;
      const peakPctTarget = (peakPts / Math.max(1, targetPts)) * 100;
      if (peakPctTarget < 30 && curPts <= 1) {
        return _close('NO_PROGRESS', entryLtp, ltp, t - entryEpoch, decision, peakLtp);
      }
    }
    t += 30;
  }
  const finalLtp = getLtpAt(day, strike, side, entryEpoch + effectiveMaxHoldSec);
  return _close('TIMEOUT', entryLtp, finalLtp ?? entryLtp, effectiveMaxHoldSec, decision, peakLtp);
}

function _close(reason, entry, exit, heldSec, decision, peakLtp) {
  const pts = exit - entry;
  const peakPts = (peakLtp || entry) - entry;
  const qty = LOTS_PER_TRADE * NIFTY_LOT_SIZE;
  const grossPnl = pts * qty;
  const netPnl   = grossPnl - ROUND_TRIP_BROKERAGE;
  const result = netPnl > 0 ? 'WIN' : netPnl < 0 ? 'LOSS' : 'BE';
  return {
    reason, entry, exit,
    pts: +pts.toFixed(2), peakPts: +peakPts.toFixed(2),
    qty,
    grossPnl: +grossPnl.toFixed(2),
    netPnl: +netPnl.toFixed(2),
    heldSec, result,
    signal: decision.signal,
    strike: decision.strike, optionType: decision.option_type,
    moneyness: decision.moneyness,
    confidence: decision.confidence,
    consensusScore: decision.consensusScore,
    confluenceTier: decision.confluenceTier,
    triggerTf: decision.timeframe,
    smartTrailMode: decision.smartTrail?.mode,
    runnerExtended: decision.smartTrail?.mode === 'runner' || decision.smartTrail?.mode === 'hybrid_runner_continuation',
  };
}

// ────────────────────────────────────────────────────────────────────────
// Day backtest loop
// ────────────────────────────────────────────────────────────────────────
async function backtestDay(dayLabel) {
  const folder = path.join(ROOT, dayLabel + '_NIFTY_50');
  const meta = readJson(path.join(folder, 'metadata.json'));
  if (!meta) return { dayLabel, skipped: true, reason: 'no metadata' };

  const candles1m  = readJsonl(path.join(folder, 'candles-1m.jsonl')).map(normCandle);
  const candles5m  = readJsonl(path.join(folder, 'candles-5m.jsonl')).map(normCandle);
  const candles15m = readJsonl(path.join(folder, 'candles-15m.jsonl')).map(normCandle);
  const optionChain = readJsonl(path.join(folder, 'option-chain.jsonl'));
  if (!candles5m.length || !optionChain.length) {
    return { dayLabel, skipped: true, reason: 'insufficient data' };
  }
  const day = { dayLabel, meta, candles1m, candles5m, candles15m, optionChain };

  // Build cycles every cycleStepSec from windowStart to windowEnd
  const firstEpoch = candles1m[0]?.t || candles5m[0].t;
  const lastEpoch  = candles1m[candles1m.length - 1]?.t || candles5m[candles5m.length - 1].t;
  const trades = [];
  let cooldownUntil = 0;
  const cycles = [];
  for (let t = firstEpoch; t <= lastEpoch; t += SETTINGS.cycleStepSec) cycles.push(t);

  let signalsGenerated = 0;
  let cyclesWithDecision = 0;

  _log('info', 'day_start', `${dayLabel}: ${cycles.length} cycles, candles1m=${candles1m.length} candles5m=${candles5m.length} candles15m=${candles15m.length} chain=${optionChain.length}`,
    { dayLabel, cycles: cycles.length, candles1m: candles1m.length, candles5m: candles5m.length, candles15m: candles15m.length, chain: optionChain.length });

  for (const cycleEpoch of cycles) {
    if (trades.length >= SETTINGS.maxTradesPerDay) break;
    if (cycleEpoch < cooldownUntil) continue;
    const hhmm = epochSecToIstHhmm(cycleEpoch);
    if (hhmm < SETTINGS.windowStartHhmm || hhmm > SETTINGS.windowEndHhmm) continue;

    const ctx = buildContext(day, cycleEpoch);
    if (!ctx) continue;
    cyclesWithDecision++;

    const ultra = ultraScalpEngine.decide({
      candles1m: ctx.candles1m,
      candles3m: ctx.candles3m,
      candles5m: ctx.candles5m,
      candles15m: ctx.candles15m,
      vwap: ctx.vwap,
      volumeAnalysis: ctx.volumeAnalysis,
      volatilityRegime: ctx.volatilityRegime,
      spotPrice: ctx.spotPrice,
      atr: { atr_5m: ctx.volatilityRegime.atr5m },
      settings: { ultraScalp: SETTINGS.ultraScalp },
    });

    if (!ultra.fired) {
      _log('debug', 'no_fire', `[${dayLabel} ${hhmm}] ${ultra.reasoning}`,
        { dayLabel, hhmm, spot: ctx.spotPrice, vol: ctx.volatilityRegime.state, reasoning: ultra.reasoning });
      continue;
    }

    // Find previous chain snapshot for OI delta
    const prevTimeMs = cycleEpoch * 1000 - 5 * 60 * 1000;
    let prevOc = null;
    for (let i = day.optionChain.length - 1; i >= 0; i--) {
      if (day.optionChain[i].t <= prevTimeMs) { prevOc = day.optionChain[i]; break; }
    }
    const primaryStrikes = buildPrimaryStrikes(ctx.optionChain, prevOc);

    // Pick strike
    const strikeRes = strikeSelector.select({
      direction: ultra.direction,
      atmStrike: ctx.atmStrike,
      primaryStrikes,
      tier: ultra.confluenceTier,
      openingStrike: meta.openingAtm || meta.openingStrikes?.[Math.floor((meta.openingStrikes?.length || 1) / 2)] || ctx.atmStrike,
      maxPain: ctx.optionChain.maxPain || null,
      windowHalf: 4,
      hhmm,
    });
    if (!strikeRes.ok) {
      _log('warn', 'ultra', `strike selection failed @ ${hhmm}: ${strikeRes.reason}`, strikeRes);
      continue;
    }

    signalsGenerated++;

    // Decision payload to feed simulator
    const decision = {
      signal: ultra.direction === 'bullish' ? 'BUY_CE' : 'BUY_PE',
      strike: strikeRes.strike,
      option_type: strikeRes.optionType,
      moneyness: strikeRes.moneyness,
      entry_premium_estimate: strikeRes.ltp,
      sl_points: ultra.sl_pts,
      target_points: ultra.target_pts,
      max_hold_seconds: ultra.maxHoldSec,
      confidence: ultra.confidence,
      consensusScore: ultra.consensusScore,
      confluenceTier: ultra.confluenceTier,
      timeframe: ultra.timeframe,
      smartTrail: ultra.smartTrail,
      volState: ctx.volatilityRegime.state,
      reasoning: ultra.reasoning,
    };

    _log('info', 'ultra', `entry @ ${hhmm}: ${decision.signal} ${decision.strike}${decision.option_type} @ ${decision.entry_premium_estimate} ${ultra.confluenceTier} score=${ultra.consensusScore}`, decision);

    const result = simulateTrade(day, decision, cycleEpoch);
    if (!result) continue;
    result.entryHhmm = hhmm;
    result.exitHhmm  = epochSecToIstHhmm(cycleEpoch + result.heldSec);
    trades.push(result);

    _log('info', 'ultra', `exit @ ${result.exitHhmm}: ${result.reason} ${result.result} pts=${result.pts} peak=${result.peakPts} netPnl=${result.netPnl}`, result);

    cooldownUntil = cycleEpoch + result.heldSec + SETTINGS.cooldownSec;
  }

  const wins = trades.filter(t => t.result === 'WIN').length;
  const losses = trades.filter(t => t.result === 'LOSS').length;
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
  const totalCycles = cycles.length;

  _log('info', 'day_summary',
    `${dayLabel}: cycles=${totalCycles} active=${cyclesWithDecision} signals=${signalsGenerated} trades=${trades.length} W=${wins} L=${losses} netPnl=Rs.${netPnl.toFixed(0)}`,
    { dayLabel, totalCycles, cyclesWithDecision, signalsGenerated, trades: trades.length, wins, losses, netPnl, grossPnl,
      tradeRows: trades.map(t => ({
        entryHhmm: t.entryHhmm, exitHhmm: t.exitHhmm, signal: t.signal, strike: t.strike, optionType: t.optionType,
        entry: t.entry, exit: t.exit, pts: t.pts, peakPts: t.peakPts, heldSec: t.heldSec, reason: t.reason, result: t.result,
        netPnl: t.netPnl, tier: t.confluenceTier, score: t.consensusScore, triggerTf: t.triggerTf, smartTrailMode: t.smartTrailMode,
      })),
    });

  return {
    dayLabel,
    cycles: totalCycles,
    signalsGenerated,
    trades: trades.length,
    wins, losses,
    grossPnl, netPnl,
    rows: trades,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────
(async () => {
  const days = listDays(dayFilter);
  if (!days.length) {
    console.log(`No days found for filter ${dayFilter}`);
    process.exit(1);
  }

  console.log(`\nULTRA SCALP backtest — ${days.length} day(s)`);
  console.log(`Settings: preset=${SETTINGS.ultraScalp.preset}  minScore=${SETTINGS.ultraScalp.minScore}  flips=${SETTINGS.ultraScalp.flipLimit}/${SETTINGS.ultraScalp.flipWindowMin}m  slope≥${SETTINGS.ultraScalp.slopeMin}  atrExp≥${SETTINGS.ultraScalp.atrExpansionMin}`);
  console.log(`Window: ${SETTINGS.windowStartHhmm}-${SETTINGS.windowEndHhmm} IST  cooldown=${SETTINGS.cooldownSec}s  maxTrades/day=${SETTINGS.maxTradesPerDay}\n`);

  const results = [];
  for (const day of days) {
    process.stdout.write(`  ${day}: `);
    const r = await backtestDay(day);
    results.push(r);
    if (r.skipped) {
      console.log(`skipped (${r.reason})`);
    } else {
      console.log(`${r.trades} trades, ${r.wins}W/${r.losses}L, P&L Rs.${r.netPnl.toFixed(0)}`);
    }
  }

  // ── Aggregate ───────────────────────────────────────────────────────
  const all = results.filter(r => !r.skipped);
  const allTrades = all.flatMap(r => r.rows);
  const totalDays = all.length;
  const profitableDays = all.filter(r => r.netPnl > 0).length;
  const totalCycles = all.reduce((s, r) => s + r.cycles, 0);
  const totalSignals = all.reduce((s, r) => s + r.signalsGenerated, 0);
  const wins = allTrades.filter(t => t.result === 'WIN').length;
  const losses = allTrades.filter(t => t.result === 'LOSS').length;
  const totalTrades = allTrades.length;
  const grossPnl = allTrades.reduce((s, t) => s + t.grossPnl, 0);
  const netPnl = allTrades.reduce((s, t) => s + t.netPnl, 0);
  const avgWin = wins > 0 ? allTrades.filter(t => t.result === 'WIN').reduce((s, t) => s + t.netPnl, 0) / wins : 0;
  const avgLoss = losses > 0 ? allTrades.filter(t => t.result === 'LOSS').reduce((s, t) => s + t.netPnl, 0) / losses : 0;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const expectancy = totalTrades > 0 ? netPnl / totalTrades : 0;
  const avgHold = totalTrades > 0 ? allTrades.reduce((s, t) => s + t.heldSec, 0) / totalTrades : 0;
  const grossWins = allTrades.filter(t => t.result === 'WIN').reduce((s, t) => s + t.netPnl, 0);
  const grossLosses = Math.abs(allTrades.filter(t => t.result === 'LOSS').reduce((s, t) => s + t.netPnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  console.log('\n' + '='.repeat(78));
  console.log('  ULTRA SCALP BACKTEST RESULTS');
  console.log('='.repeat(78));
  console.log('\nPER-DAY BREAKDOWN');
  console.log('-'.repeat(78));
  console.log('Date         Cycles  Signals  Trades   W   L   WinRate    Net P&L');
  console.log('-'.repeat(78));
  for (const r of all) {
    const wr = r.trades > 0 ? `${((r.wins / r.trades) * 100).toFixed(1)}%` : '   - %';
    console.log(`${r.dayLabel}    ${String(r.cycles).padStart(4)}     ${String(r.signalsGenerated).padStart(3)}     ${String(r.trades).padStart(3)}  ${String(r.wins).padStart(2)}  ${String(r.losses).padStart(2)}  ${wr.padStart(7)}   Rs.${String(r.netPnl.toFixed(0)).padStart(7)}`);
  }
  console.log('-'.repeat(78));
  console.log('\nAGGREGATE');
  console.log('-'.repeat(78));
  console.log(`  Days backtested              ${totalDays}`);
  console.log(`  Profitable days              ${profitableDays}/${totalDays} (${(profitableDays/Math.max(1,totalDays)*100).toFixed(1)}%)`);
  console.log(`  Total cycles                 ${totalCycles}`);
  console.log(`  Signals generated            ${totalSignals}`);
  console.log(`  Trades taken                 ${totalTrades}`);
  console.log(`  Wins                         ${wins}`);
  console.log(`  Losses                       ${losses}`);
  console.log(`  Win rate                     ${winRate.toFixed(2)}%`);
  console.log(`  Gross P&L (Rs.)              ${grossPnl.toFixed(2)}`);
  console.log(`  Net P&L (Rs.)                ${netPnl.toFixed(2)}`);
  console.log(`  Average win (Rs.)            ${avgWin.toFixed(2)}`);
  console.log(`  Average loss (Rs.)           ${avgLoss.toFixed(2)}`);
  console.log(`  Expectancy / trade (Rs.)     ${expectancy.toFixed(2)}`);
  console.log(`  Avg hold time (sec)          ${avgHold.toFixed(0)}`);
  console.log(`  Profit factor                ${profitFactor.toFixed(2)}`);

  // ── Tier breakdown ──────────────────────────────────────────────────
  console.log('\nTIER BREAKDOWN');
  console.log('-'.repeat(78));
  for (const tier of ['elite', 'standard', 'weak']) {
    const sub = allTrades.filter(t => t.confluenceTier === tier);
    if (!sub.length) continue;
    const w = sub.filter(t => t.result === 'WIN').length;
    const l = sub.filter(t => t.result === 'LOSS').length;
    const np = sub.reduce((s, t) => s + t.netPnl, 0);
    console.log(`  ${tier.padEnd(10)} trades=${String(sub.length).padStart(3)}  W=${String(w).padStart(2)} L=${String(l).padStart(2)}  WR=${(w/sub.length*100).toFixed(1)}%  Net=Rs.${np.toFixed(0)}`);
  }

  // ── Exit reason breakdown ───────────────────────────────────────────
  console.log('\nEXIT REASON BREAKDOWN');
  console.log('-'.repeat(78));
  const reasonGroups = {};
  for (const t of allTrades) {
    if (!reasonGroups[t.reason]) reasonGroups[t.reason] = [];
    reasonGroups[t.reason].push(t);
  }
  for (const r of Object.keys(reasonGroups).sort()) {
    const sub = reasonGroups[r];
    const w = sub.filter(t => t.result === 'WIN').length;
    const l = sub.filter(t => t.result === 'LOSS').length;
    const np = sub.reduce((s, t) => s + t.netPnl, 0);
    console.log(`  ${r.padEnd(15)} count=${String(sub.length).padStart(3)}  W=${String(w).padStart(2)} L=${String(l).padStart(2)}  Net=Rs.${np.toFixed(0)}`);
  }

  // ── Direction breakdown ─────────────────────────────────────────────
  console.log('\nDIRECTION BREAKDOWN');
  console.log('-'.repeat(78));
  for (const sig of ['BUY_CE', 'BUY_PE']) {
    const sub = allTrades.filter(t => t.signal === sig);
    if (!sub.length) continue;
    const w = sub.filter(t => t.result === 'WIN').length;
    const l = sub.filter(t => t.result === 'LOSS').length;
    const np = sub.reduce((s, t) => s + t.netPnl, 0);
    console.log(`  ${sig}    trades=${String(sub.length).padStart(3)}  W=${String(w).padStart(2)} L=${String(l).padStart(2)}  WR=${(w/sub.length*100).toFixed(1)}%  Net=Rs.${np.toFixed(0)}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`FINAL: ${wins}/${totalTrades} wins (${winRate.toFixed(2)}%) -- Net Rs.${netPnl.toFixed(2)} over ${totalDays} days`);
  console.log('='.repeat(78));
  console.log(`\nFull debug log: ${LOG_FILE}`);

  // Persist the aggregate summary at the end of the log file
  _log('info', 'aggregate_summary', `FINAL ${wins}/${totalTrades} (${winRate.toFixed(2)}%) Net=Rs.${netPnl.toFixed(2)} PF=${profitFactor.toFixed(2)}`, {
    totalDays, profitableDays, totalCycles, totalSignals, totalTrades, wins, losses,
    winRate, grossPnl, netPnl, avgWin, avgLoss, expectancy, avgHold, profitFactor,
    settings: SETTINGS,
  });

  process.exit(0);
})().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
