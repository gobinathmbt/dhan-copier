/**
 * Ultra Scalp Engine (v5 — multi-layer UT Bot confluence + asymmetric)
 * ====================================================================
 * Dedicated 5-20 point scalping signal generator that mirrors the user's
 * TradingView "UT Bot Alerts" indicator with full institutional confluence.
 *
 * v5 ARCHITECTURE (2026-05-19):
 *
 * FOUR-LAYER UT BOT STACK:
 *   Layer 1 — TRIGGER       (1m)  — fast, sensitive, fires the entry bar
 *   Layer 2 — CONFIRMATION  (3m)  — must agree with trigger direction
 *   Layer 3 — TREND BIAS    (5m)  — primary trend layer
 *   Layer 4 — REGIME FILTER (15m) — macro filter; trades only with regime
 *
 * ASYMMETRIC BUY/SELL CONFIGS:
 *   Markets fall faster than they rise. Each layer runs TWO UT Bot streams:
 *     • SELL stream — sensitive ATR, lower Key (catches fast crashes)
 *     • BUY  stream — smoother ATR, higher Key (only strong reversals)
 *
 * WEIGHTED CONSENSUS SCORING:
 *   Each layer's UT Bot trend agreement contributes a weight:
 *     1m=15, 3m=25, 5m=30, 15m=30  (configurable)
 *   Trade fires when weighted score >= settings.ultraScalp.minScore (default 70)
 *
 * FLIP VELOCITY FILTER:
 *   Tracks recent UT Bot flips per TF. If the trigger TF has flipped > N
 *   times in the last K minutes, the engine treats the market as choppy
 *   and refuses to trade. Default: skip if 1m flipped >3x in 10 minutes.
 *
 * ATR EXPANSION CONFIRMATION:
 *   ATR-rising bias — current ATR(5m) must be >= avg of last K bars × 1.0.
 *   Filters dead-volume false breaks.
 *
 * SLOPE STRENGTH:
 *   Distance from price to trailing stop is normalised by ATR. A larger
 *   `slopeStrength` = stronger move; small slope = weak/late entry.
 *
 * The whole point: catch the EXACT signals the user sees on the chart with
 * institutional-grade noise filters.
 */

const { calculateUTBot } = require('../algorithms/multiTimeframe.service');

// ────────────────────────────────────────────────────────────────────────
// PROFILE LIBRARY — pre-canned stacks the user can select via
// `settings.ultraScalp.preset`. Each profile has BUY and SELL configs.
// ────────────────────────────────────────────────────────────────────────
//
// 'best_practical'  — recommended user spec: 1m/3m/5m/15m layered, asymmetric
// 'high_accuracy'   — slower/cleaner — fewer trades, sharper edges
// 'aggressive'      — more trades, lower thresholds, accepts more noise
//
// Each TF profile carries:
//   buyConfig, sellConfig         — UT Bot params per direction
//   role                          — 'trigger' | 'confirmation' | 'trend' | 'regime'
//   weight                        — consensus scoring weight (only on confirmation/trend/regime layers)
//   maxHoldSec, slPtsMin/Max,
//   targetMin/Max, sizingFactor   — sizing & exit parameters (used when this TF is the trigger)
// ────────────────────────────────────────────────────────────────────────
const PRESETS = {
  best_practical: {
    '1m':  { buyConfig:  { keyValue: 1.25, atrPeriod: 7  },
             sellConfig: { keyValue: 0.8,  atrPeriod: 3  },
             role: 'trigger',      weight: 15,
             maxHoldSec: 90,  slPtsMin: 4, slPtsMax: 8,  targetMin: 5,  targetMax: 12, sizingFactor: 0.5 },
    '3m':  { buyConfig:  { keyValue: 1.5,  atrPeriod: 7  },
             sellConfig: { keyValue: 1.0,  atrPeriod: 5  },
             role: 'confirmation', weight: 25,
             maxHoldSec: 120, slPtsMin: 5, slPtsMax: 10, targetMin: 6,  targetMax: 15, sizingFactor: 0.6 },
    '5m':  { buyConfig:  { keyValue: 2.0,  atrPeriod: 10 },
             sellConfig: { keyValue: 1.5,  atrPeriod: 7  },
             role: 'trend',        weight: 30,
             maxHoldSec: 150, slPtsMin: 6, slPtsMax: 12, targetMin: 8,  targetMax: 20, sizingFactor: 0.7 },
    '15m': { buyConfig:  { keyValue: 3.0,  atrPeriod: 14 },
             sellConfig: { keyValue: 2.5,  atrPeriod: 10 },
             role: 'regime',       weight: 30,
             maxHoldSec: 180, slPtsMin: 8, slPtsMax: 14, targetMin: 10, targetMax: 20, sizingFactor: 0.7 },
  },
  high_accuracy: {
    '1m':  { buyConfig:  { keyValue: 1.5,  atrPeriod: 7  },
             sellConfig: { keyValue: 1.2,  atrPeriod: 5  },
             role: 'trigger',      weight: 15,
             maxHoldSec: 120, slPtsMin: 5, slPtsMax: 9,  targetMin: 7,  targetMax: 14, sizingFactor: 0.5 },
    '3m':  { buyConfig:  { keyValue: 2.0,  atrPeriod: 10 },
             sellConfig: { keyValue: 1.5,  atrPeriod: 7  },
             role: 'confirmation', weight: 25,
             maxHoldSec: 180, slPtsMin: 6, slPtsMax: 12, targetMin: 8,  targetMax: 18, sizingFactor: 0.6 },
    '5m':  { buyConfig:  { keyValue: 2.5,  atrPeriod: 14 },
             sellConfig: { keyValue: 2.0,  atrPeriod: 10 },
             role: 'trend',        weight: 30,
             maxHoldSec: 240, slPtsMin: 8, slPtsMax: 14, targetMin: 10, targetMax: 20, sizingFactor: 0.7 },
    '15m': { buyConfig:  { keyValue: 3.0,  atrPeriod: 14 },
             sellConfig: { keyValue: 2.5,  atrPeriod: 10 },
             role: 'regime',       weight: 30,
             maxHoldSec: 240, slPtsMin: 10, slPtsMax: 16, targetMin: 12, targetMax: 20, sizingFactor: 0.7 },
  },
  aggressive: {
    '1m':  { buyConfig:  { keyValue: 1.0,  atrPeriod: 3  },
             sellConfig: { keyValue: 0.8,  atrPeriod: 3  },
             role: 'trigger',      weight: 20,
             maxHoldSec: 60,  slPtsMin: 3, slPtsMax: 7,  targetMin: 4,  targetMax: 10, sizingFactor: 0.4 },
    '3m':  { buyConfig:  { keyValue: 1.0,  atrPeriod: 5  },
             sellConfig: { keyValue: 1.0,  atrPeriod: 5  },
             role: 'confirmation', weight: 30,
             maxHoldSec: 90,  slPtsMin: 4, slPtsMax: 9,  targetMin: 5,  targetMax: 12, sizingFactor: 0.5 },
    '5m':  { buyConfig:  { keyValue: 1.5,  atrPeriod: 7  },
             sellConfig: { keyValue: 1.5,  atrPeriod: 7  },
             role: 'trend',        weight: 50,
             maxHoldSec: 120, slPtsMin: 5, slPtsMax: 11, targetMin: 7,  targetMax: 16, sizingFactor: 0.6 },
    // 15m disabled in aggressive preset (more trades, less filtering)
  },
};

const DEFAULT_PRESET = 'best_practical';
const DEFAULT_MIN_SCORE = 70;
const DEFAULT_FLIP_WINDOW_MIN = 10;
const DEFAULT_FLIP_LIMIT = 3;

// ────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────
function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }
function _toUtBotCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.map(c => ({
    open:   c.open  ?? c.o,
    high:   c.high  ?? c.h,
    low:    c.low   ?? c.l,
    close:  c.close ?? c.c,
    volume: c.volume ?? c.v ?? 0,
    t:      c.t ?? c.time ?? null,
  })).filter(c => Number.isFinite(c.close));
}
function _atrSeq(candles, period) {
  const out = [];
  if (candles.length < 2) return out;
  let prevAtr = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { out.push(0); prevAtr = 0; continue; }
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i < period) prevAtr = ((prevAtr * (i - 1)) + tr) / Math.max(1, i);
    else if (i === period) prevAtr = tr;
    else prevAtr = ((prevAtr * (period - 1)) + tr) / period;
    out.push(prevAtr);
  }
  return out;
}

/**
 * Compute UT Bot stop+pos series. Returns { stopSeq, posSeq, atrSeq }.
 * Used both for read-out and for flip-velocity counting.
 */
function _utSeries(utbCandles, config) {
  const closes = utbCandles.map(c => c.close);
  const atrSeq = _atrSeq(utbCandles, config.atrPeriod);
  const stopSeq = [];
  const posSeq = [];
  for (let i = 0; i < closes.length; i++) {
    const nLoss = config.keyValue * (atrSeq[i] || atrSeq[atrSeq.length - 1] || 0);
    const src = closes[i];
    let stop;
    if (i === 0) stop = src - nLoss;
    else {
      const prev = stopSeq[i - 1];
      if (src > prev && closes[i - 1] > prev) stop = Math.max(prev, src - nLoss);
      else if (src < prev && closes[i - 1] < prev) stop = Math.min(prev, src + nLoss);
      else if (src > prev) stop = src - nLoss;
      else stop = src + nLoss;
    }
    stopSeq.push(stop);
    let p = 0;
    if (i > 0) {
      if (closes[i - 1] < stopSeq[i - 1] && src > stopSeq[i - 1]) p = 1;
      else if (closes[i - 1] > stopSeq[i - 1] && src < stopSeq[i - 1]) p = -1;
      else p = posSeq[i - 1];
    }
    posSeq.push(p);
  }
  return { stopSeq, posSeq, atrSeq, closes };
}

function _utBotRead(candles, config) {
  const utbCandles = _toUtBotCandles(candles);
  const need = (config.atrPeriod || 1) + 5;
  if (utbCandles.length < need) {
    return {
      signalNow: 'none', signalBar: 'none', trend: 'neutral',
      trailingStop: null, barsSinceFlip: null, warmupShort: true, config,
    };
  }
  const result = calculateUTBot(utbCandles, config);
  const { stopSeq, posSeq } = _utSeries(utbCandles, config);

  let signalNow = 'none';
  let signalBar = result.signal;
  let barsSinceFlip = null;
  for (let i = posSeq.length - 1; i > 0; i--) {
    if (posSeq[i] !== posSeq[i - 1] && posSeq[i] !== 0) {
      barsSinceFlip = (posSeq.length - 1) - i;
      if (barsSinceFlip === 0) signalNow = posSeq[i] === 1 ? 'buy' : 'sell';
      if (barsSinceFlip <= 1) signalBar = posSeq[i] === 1 ? 'buy' : 'sell';
      break;
    }
  }
  const lastPos = posSeq[posSeq.length - 1];
  const trend = lastPos === 1 ? 'bullish' : lastPos === -1 ? 'bearish' : 'neutral';

  // Slope strength — distance from price to trailing stop, normalised by ATR.
  // Larger = stronger directional momentum.
  const lastClose = utbCandles[utbCandles.length - 1].close;
  const lastStop  = stopSeq[stopSeq.length - 1];
  const lastAtr   = result.atr || 1;
  const slopeStrength = Math.abs(lastClose - lastStop) / Math.max(0.0001, lastAtr);

  return {
    signalNow, signalBar, trend,
    trailingStop: lastStop,
    atr: lastAtr,
    barsSinceFlip,
    warmupShort: false,
    slopeStrength,
    posSeq, stopSeq,                      // exposed for flip-velocity / debug
    config,
  };
}

/**
 * ASYMMETRIC dual-config UT Bot read. Runs BUY config + SELL config in
 * parallel, then selects whichever stream has the freshest cross in its
 * allowed direction.
 */
function _dualUtBotRead(candles, profile) {
  const buyCfg  = profile.buyConfig  || profile;
  const sellCfg = profile.sellConfig || profile;
  const utb = _toUtBotCandles(candles);
  const buyWarm  = utb.length >= ((buyCfg.atrPeriod  || 1) + 5);
  const sellWarm = utb.length >= ((sellCfg.atrPeriod || 1) + 5);
  const buyRead  = buyWarm  ? _utBotRead(candles, buyCfg)
                            : { signalNow: 'none', signalBar: 'none', trend: 'neutral', trailingStop: null, barsSinceFlip: null, warmupShort: true, config: buyCfg };
  const sellRead = sellWarm ? _utBotRead(candles, sellCfg)
                            : { signalNow: 'none', signalBar: 'none', trend: 'neutral', trailingStop: null, barsSinceFlip: null, warmupShort: true, config: sellCfg };
  const buySignal  = (buyWarm  && buyRead.signalBar  === 'buy')  ? 'buy'  : 'none';
  const sellSignal = (sellWarm && sellRead.signalBar === 'sell') ? 'sell' : 'none';

  let chosen = 'none';
  let read = buyRead;
  if (buySignal !== 'none' && sellSignal !== 'none') {
    const bAge = buyRead.barsSinceFlip ?? Infinity;
    const sAge = sellRead.barsSinceFlip ?? Infinity;
    if (sAge <= bAge) { chosen = 'sell'; read = sellRead; }
    else              { chosen = 'buy';  read = buyRead;  }
  } else if (buySignal !== 'none')  { chosen = 'buy';  read = buyRead;  }
  else if (sellSignal !== 'none')   { chosen = 'sell'; read = sellRead; }

  // For trend agreement / scoring, we want both streams' trends — buy
  // stream's trend describes the smooth bullish bias, sell stream's trend
  // describes the sensitive bearish bias.
  return {
    chosenSignal: chosen,
    chosenRead: read,
    signalBar: chosen,
    trend: read.trend,
    trailingStop: read.trailingStop,
    atr: read.atr,
    barsSinceFlip: read.barsSinceFlip,
    slopeStrength: read.slopeStrength,
    warmupShort: read.warmupShort,
    streams: { buy: buyRead, sell: sellRead },
  };
}

/**
 * Count UT Bot flips inside a time window. We count from the chosen
 * direction's stream (whichever was used to identify the trigger).
 *
 * @param {Array} utbCandles  candles_used_by_engine (have .t epoch seconds)
 * @param {Array} posSeq      position series from _utSeries
 * @param {number} windowMin
 * @returns {number} flip count within `windowMin` minutes of last bar
 */
function _flipsInWindow(utbCandles, posSeq, windowMin) {
  if (!Array.isArray(posSeq) || posSeq.length < 2) return 0;
  const lastT = utbCandles[utbCandles.length - 1]?.t;
  if (!Number.isFinite(lastT)) return 0;
  const cutoff = lastT - (windowMin * 60);
  let flips = 0;
  for (let i = 1; i < posSeq.length; i++) {
    if (posSeq[i] !== posSeq[i - 1] && posSeq[i] !== 0) {
      const t = utbCandles[i]?.t;
      if (Number.isFinite(t) && t >= cutoff) flips++;
    }
  }
  return flips;
}

// ────────────────────────────────────────────────────────────────────────
// PUBLIC: decide()
// ────────────────────────────────────────────────────────────────────────
function decide({
  candles5m = [],
  candles3m = null,
  candles1m = [],
  candles15m = [],
  vwap = null,
  volumeAnalysis = null,
  volatilityRegime = null,
  spotPrice = null,
  atr = null,
  settings = {},
} = {}) {
  const userCfg = settings?.ultraScalp || {};
  const presetKey = userCfg.preset || DEFAULT_PRESET;
  const baseProfiles = PRESETS[presetKey] || PRESETS[DEFAULT_PRESET];
  function _resolveProfile(tf) {
    const dflt = baseProfiles[tf];
    if (!dflt) return null;
    return { ...dflt, ...(userCfg[`tf${tf}`] || userCfg[tf] || {}) };
  }
  const tfProfiles = {};
  for (const tf of ['1m', '3m', '5m', '15m']) {
    const p = _resolveProfile(tf);
    if (p) tfProfiles[tf] = p;
  }

  const enable = {
    '1m':  userCfg.enable1m  !== false && !!tfProfiles['1m'],
    '3m':  userCfg.enable3m  !== false && !!tfProfiles['3m'],
    '5m':  userCfg.enable5m  !== false && !!tfProfiles['5m'],
    '15m': userCfg.enable15m !== false && !!tfProfiles['15m'],
  };
  const vwapStrict       = userCfg.vwapStrict !== false;
  const requireBarColor  = userCfg.requireBarColor !== false;
  const allowStaleBar    = userCfg.allowStaleBar === true;
  const minScore         = Number(userCfg.minScore) || DEFAULT_MIN_SCORE;
  const triggerTf        = userCfg.triggerTf || '1m';
  const flipWindowMin    = Number(userCfg.flipWindowMin) || DEFAULT_FLIP_WINDOW_MIN;
  const flipLimit        = Number(userCfg.flipLimit)     || DEFAULT_FLIP_LIMIT;
  const requireRegime    = userCfg.requireRegime !== false;     // 15m must agree if enabled
  const atrExpansionMin  = Number(userCfg.atrExpansionMin) || 0.85; // current ATR ≥ 0.85× recent avg
  const slopeMin         = Number(userCfg.slopeMin) || 0.5;      // trigger slope ≥ 0.5×ATR

  // ── Run dual UT Bot per enabled TF ───────────────────────────────────
  const tfReads = {};
  const candleMap = { '1m': candles1m, '3m': candles3m || [], '5m': candles5m, '15m': candles15m };
  for (const tf of ['1m', '3m', '5m', '15m']) {
    if (!enable[tf]) continue;
    const cs = candleMap[tf];
    if (!Array.isArray(cs) || !cs.length) continue;
    tfReads[tf] = { read: _dualUtBotRead(cs, tfProfiles[tf]), profile: tfProfiles[tf], candles: cs };
  }
  const exposedReads = Object.fromEntries(
    Object.entries(tfReads).map(([k, v]) => [k, {
      chosenSignal: v.read.chosenSignal,
      trend: v.read.trend,
      trailingStop: v.read.trailingStop,
      barsSinceFlip: v.read.barsSinceFlip,
      slopeStrength: v.read.slopeStrength,
      warmupShort: v.read.warmupShort,
      streams: {
        buy:  { trend: v.read.streams?.buy?.trend,  signalBar: v.read.streams?.buy?.signalBar  },
        sell: { trend: v.read.streams?.sell?.trend, signalBar: v.read.streams?.sell?.signalBar },
      },
    }])
  );

  // ── Find trigger flip ────────────────────────────────────────────────
  const tfPriority = [triggerTf, '1m', '3m', '5m'].filter(
    (v, i, a) => a.indexOf(v) === i && tfReads[v]
  );
  let trigger = null;
  for (const tf of tfPriority) {
    const r = tfReads[tf]?.read;
    if (!r || r.warmupShort) continue;
    if (r.signalBar === 'buy' || r.signalBar === 'sell') {
      if (!allowStaleBar && r.barsSinceFlip != null && r.barsSinceFlip > 1) continue;
      trigger = { tf, signal: r.signalBar, read: r, profile: tfReads[tf].profile, candles: tfReads[tf].candles };
      break;
    }
  }
  if (!trigger) {
    return {
      fired: false,
      reasoning: `no UT Bot cross within 1 bar on trigger TFs [${tfPriority.join('/')}]`,
      pillars: { tfReads: exposedReads, preset: presetKey },
    };
  }

  const direction = trigger.signal === 'buy' ? 'bullish' : 'bearish';
  const signal    = trigger.signal === 'buy' ? 'BUY'     : 'SELL';

  // ── 15m REGIME FILTER ────────────────────────────────────────────────
  // The 15m UT Bot trend (using whichever stream matches our direction)
  // must already be in our direction. This is the macro filter the user
  // requested — only BUY when 15m bullish, only SELL when 15m bearish.
  //
  // Fail-soft when the 15m stream is warmupShort (insufficient history) —
  // happens early in a session before enough 15m candles have accumulated.
  // The integrity service backfills multi-day data so live sessions will
  // typically have enough 15m history within minutes; backtest day-by-day
  // replay won't.
  const regimeRead = tfReads['15m']?.read;
  const regimeStream = direction === 'bullish'
    ? regimeRead?.streams?.buy
    : regimeRead?.streams?.sell;
  const regimeWarmupShort = !regimeRead
                         || !!regimeRead.warmupShort
                         || !!regimeStream?.warmupShort;
  const regimeAgrees = !!regimeStream
                    && regimeStream.trend === direction
                    && !regimeStream.warmupShort;
  if (requireRegime && enable['15m'] && tfProfiles['15m']
      && !regimeWarmupShort                                       // skip filter when not warm
      && !regimeAgrees) {
    return {
      fired: false, signal: null, direction,
      reasoning: `15m regime against ${direction} ` +
        `(buy.trend=${regimeRead?.streams?.buy?.trend} sell.trend=${regimeRead?.streams?.sell?.trend})`,
      pillars: { tfReads: exposedReads, preset: presetKey, triggerTf: trigger.tf, regimeAgrees: false },
    };
  }

  // ── FLIP VELOCITY FILTER ─────────────────────────────────────────────
  // Count flips in the trigger TF's stream over the last K minutes.
  // High flip count = chop = skip.
  const triggerCfg = trigger.signal === 'buy' ? trigger.profile.buyConfig : trigger.profile.sellConfig;
  const triggerUtb = _toUtBotCandles(trigger.candles);
  const triggerSeries = _utSeries(triggerUtb, triggerCfg);
  const flipsRecent = _flipsInWindow(triggerUtb, triggerSeries.posSeq, flipWindowMin);
  if (flipsRecent > flipLimit) {
    return {
      fired: false, signal: null, direction,
      reasoning: `flip velocity ${flipsRecent}/${flipLimit} in ${flipWindowMin}min — chop detected`,
      pillars: { tfReads: exposedReads, preset: presetKey, triggerTf: trigger.tf, flipsRecent },
    };
  }

  // ── SLOPE STRENGTH ───────────────────────────────────────────────────
  if (Number.isFinite(trigger.read.slopeStrength) && trigger.read.slopeStrength < slopeMin) {
    return {
      fired: false, signal: null, direction,
      reasoning: `slope ${trigger.read.slopeStrength.toFixed(2)} < ${slopeMin} — weak/late entry`,
      pillars: { tfReads: exposedReads, preset: presetKey, triggerTf: trigger.tf, slope: trigger.read.slopeStrength },
    };
  }

  // ── ATR EXPANSION CONFIRMATION ───────────────────────────────────────
  // Use 5m candles to compute current ATR vs recent avg. ATR must be
  // expanding (current >= avg × atrExpansionMin) for the move to have legs.
  const atrExpansion = (() => {
    const u = _toUtBotCandles(candles5m);
    if (u.length < 20) return { ok: true, reason: 'insufficient bars (skip filter)' };
    const seq = _atrSeq(u, 14);
    const cur = seq[seq.length - 1] || 0;
    const avg = seq.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
    const ratio = avg > 0 ? cur / avg : 1;
    return { ok: ratio >= atrExpansionMin, ratio, cur, avg };
  })();
  if (!atrExpansion.ok) {
    return {
      fired: false, signal: null, direction,
      reasoning: `ATR contracting ${atrExpansion.ratio?.toFixed(2)}× < ${atrExpansionMin}× — dead market`,
      pillars: { tfReads: exposedReads, preset: presetKey, triggerTf: trigger.tf, atrExpansion },
    };
  }

  // ── WEIGHTED CONSENSUS SCORE ─────────────────────────────────────────
  // For each enabled TF that is warm, add its weight to the score if its
  // trend (in the matching directional stream) agrees with our direction.
  // The trigger TF is always included (it just flipped). Layers that are
  // warmupShort are EXCLUDED from totalWeight so a small-history backtest
  // doesn't drag the score below threshold automatically.
  let score = 0;
  let totalWeight = 0;
  const layerResults = [];
  for (const tf of ['1m', '3m', '5m', '15m']) {
    if (!enable[tf] || !tfReads[tf]) continue;
    const r = tfReads[tf].read;
    const w = tfProfiles[tf].weight || 0;
    let agrees = false;
    let warmupShort = false;
    if (tf === trigger.tf) {
      agrees = true;
    } else {
      const stream = direction === 'bullish' ? r?.streams?.buy : r?.streams?.sell;
      warmupShort = !stream || !!stream.warmupShort;
      agrees = !warmupShort && stream.trend === direction;
    }
    if (warmupShort) {
      // Don't count cold layers in either numerator or denominator
      layerResults.push({ tf, role: tfProfiles[tf].role, weight: w, agrees: false, warmupShort: true });
      continue;
    }
    totalWeight += w;
    if (agrees) score += w;
    layerResults.push({ tf, role: tfProfiles[tf].role, weight: w, agrees });
  }
  // Normalise to 0-100 in case weights don't sum exactly
  const scorePct = totalWeight > 0 ? Math.round((score / totalWeight) * 100) : 0;
  if (scorePct < minScore) {
    return {
      fired: false, signal: null, direction,
      reasoning: `consensus score ${scorePct}/100 < ${minScore} (layers: ${layerResults.map(l => `${l.tf}:${l.agrees ? 'OK' : 'X'}`).join(',')})`,
      pillars: { tfReads: exposedReads, preset: presetKey, triggerTf: trigger.tf, score, scorePct, layerResults },
    };
  }

  // ── CONFIRMATION GATES ───────────────────────────────────────────────
  const reasons = [
    `[preset=${presetKey}] UT Bot ${trigger.tf} ${trigger.signal.toUpperCase()} ` +
    `(Key=${triggerCfg.keyValue} ATR=${triggerCfg.atrPeriod}, ${trigger.profile.role || 'trigger'})`,
    `consensus ${scorePct}/100 (${layerResults.filter(l => l.agrees).map(l => l.tf).join('+')})`,
    `slope=${trigger.read.slopeStrength?.toFixed(2)}`,
    `flips=${flipsRecent}/${flipLimit} in ${flipWindowMin}m`,
  ];
  if (atrExpansion.ratio) reasons.push(`atrExp=${atrExpansion.ratio.toFixed(2)}×`);
  if (regimeAgrees) reasons.push('15m regime aligned');

  const blockers = [];
  const pillars = {
    preset: presetKey,
    triggerTf: trigger.tf, triggerCfg,
    barsSinceFlip: trigger.read.barsSinceFlip,
    trailingStop: trigger.read.trailingStop,
    slopeStrength: trigger.read.slopeStrength,
    flipsRecent, atrExpansion, regimeAgrees,
    score, scorePct, layerResults,
    tfReads: exposedReads,
  };

  // VWAP
  const vwapPos = vwap?.position;
  const wantPos = direction === 'bullish' ? 'above' : 'below';
  if (!vwapPos || vwapPos !== wantPos) {
    if (vwapStrict) blockers.push(`VWAP wrong side (${vwapPos || 'unknown'})`);
    else reasons.push(`VWAP ${vwapPos || 'unknown'} (soft)`);
  } else {
    pillars.vwap = 'aligned'; reasons.push('VWAP aligned');
  }

  // 1m bar color
  const last1 = candles1m && candles1m.length ? candles1m[candles1m.length - 1] : null;
  if (last1) {
    const lc = last1.close ?? last1.c;
    const lo = last1.open  ?? last1.o;
    const dirOk = (direction === 'bullish' && lc > lo) || (direction === 'bearish' && lc < lo);
    pillars.last1mAgrees = !!dirOk;
    if (!dirOk && requireBarColor) blockers.push(`last 1m bar against (o=${lo} c=${lc})`);
  }

  // 5m bar color (informational)
  const last5 = candles5m && candles5m.length ? candles5m[candles5m.length - 1] : null;
  if (last5) {
    const lc5 = last5.close ?? last5.c;
    const lo5 = last5.open  ?? last5.o;
    const dirOk5 = (direction === 'bullish' && lc5 > lo5) || (direction === 'bearish' && lc5 < lo5);
    pillars.last5mAgrees = !!dirOk5;
    if (dirOk5) reasons.push('5m bar aligned');
  }

  // Volatility / orderflow safety
  const dPct = _safe(volumeAnalysis?.delta?.cvdPctLong);
  if (volatilityRegime?.state === 'expansion') {
    const deltaAgainst = (direction === 'bullish' && dPct < -10)
                      || (direction === 'bearish' && dPct >  10);
    if (deltaAgainst) blockers.push(`expansion + delta ${dPct}% strongly against`);
  }
  const vsa = volumeAnalysis?.vsa;
  if (vsa?.bias && vsa.bias !== 'neutral' && vsa.bias !== direction
      && _safe(vsa.strength) >= 60) {
    blockers.push(`VSA ${vsa.pattern} ${vsa.bias} (against, strength ${vsa.strength})`);
  }

  if (blockers.length) {
    return {
      fired: false, signal: null, direction,
      reasoning: `${reasons.join(' | ')} BLOCKED: ${blockers.join(', ')}`,
      pillars,
    };
  }

  // ── SIZING ───────────────────────────────────────────────────────────
  const profile = trigger.profile;
  const atrPts = _safe(atr?.atr_5m) || _safe(volatilityRegime?.atr5m) || 12;
  let target_pts = Math.max(profile.targetMin, Math.min(profile.targetMax, Math.round(atrPts * 0.6)));
  let sl_pts = profile.slPtsMin + 2;
  if (Number.isFinite(spotPrice) && Number.isFinite(trigger.read.trailingStop)) {
    const dist = Math.abs(spotPrice - trigger.read.trailingStop);
    sl_pts = Math.max(profile.slPtsMin, Math.min(profile.slPtsMax, Math.round(dist + 1)));
  }
  const rrTarget = +(target_pts / Math.max(1, sl_pts)).toFixed(2);

  // ── CONFIDENCE ───────────────────────────────────────────────────────
  // Baseline tracks the consensus score, scaled into 60-95 band.
  // 70 → 60, 85 → 75, 100 → 90 (then bonuses on top up to 95)
  let confidence = 60 + (scorePct - 70) * 0.6;
  confidence = Math.max(60, Math.min(90, confidence));
  if (pillars.vwap === 'aligned')   confidence += 3;
  if (pillars.last1mAgrees)         confidence += 2;
  if (pillars.last5mAgrees)         confidence += 2;
  if (Math.abs(dPct) >= 5
      && ((direction === 'bullish' && dPct > 0) || (direction === 'bearish' && dPct < 0))) {
    confidence += 3; reasons.push(`delta ${dPct}% in direction`);
  }
  if (atrExpansion.ratio && atrExpansion.ratio >= 1.1) {
    confidence += 2; reasons.push(`ATR expanding (${atrExpansion.ratio.toFixed(2)}×)`);
  }
  if (regimeAgrees) confidence += 2;
  confidence = Math.min(95, Math.round(confidence));

  // Tier classification — for downstream sizing
  const tier = scorePct >= 90 ? 'elite' : scorePct >= 75 ? 'standard' : 'weak';
  const tierSizing = { elite: 1.0, standard: 0.85, weak: 0.65 }[tier] || 0.65;
  const sizingFactor = (profile.sizingFactor || 0.6) * tierSizing;

  // ── DYNAMIC EXIT MODE ────────────────────────────────────────────────
  // ELITE     (score ≥ 90, all 4 layers + ATR expansion + regime)
  //           → 'hybrid_runner_continuation' — fixed target IGNORED once
  //             peak crosses target; ride momentum until 1m flips, slope
  //             collapses, or volatility-adaptive giveback fires.
  // STANDARD  (score ≥ 75)
  //           → 'hybrid' — standard target + smart-lock + adaptive trail.
  // WEAK      (score < 75)
  //           → 'fixed' — classic hard target/SL only (legacy behaviour).
  const exitMode = userCfg.forceExitMode
    || (tier === 'elite'    ? 'hybrid_runner_continuation'
      : tier === 'standard' ? 'hybrid'
      :                       'fixed');

  // Volatility-adaptive giveback override is handled in runnerExitEngine
  // by reading the live volState — but if user wants a hard override per
  // entry, smartTrail.peakGivebackPct will be honoured.
  const smartTrail = {
    mode:             exitMode,
    lockTriggerPct:   userCfg.lockTriggerPct  ?? 0.50,    // lock at 50% of target
    peakGivebackPct:  userCfg.peakGivebackPct ?? null,    // null → use vol-adaptive table
    slopeExitMin:     userCfg.slopeExitMin    ?? 0.30,    // runner exits if slope drops below
  };

  return {
    fired: true,
    signal,
    direction,
    reasoning: reasons.join(' | '),
    trailingStop: trigger.read.trailingStop,
    target_pts,
    sl_pts,
    maxHoldSec: profile.maxHoldSec,
    rrTarget,
    barsSinceFlip: trigger.read.barsSinceFlip,
    confidence,
    pillars,
    timeframe: trigger.tf,
    family: 'ultra_scalp',
    name: 'ULTRA_SCALP_UT_BOT',
    holdProfile: { tradeType: 'SCALP', maxHoldSec: profile.maxHoldSec, rrTarget },
    riskProfile: { slPct: 0.10, sizingFactor },
    confluenceTier: tier,
    consensusScore: scorePct,
    preset: presetKey,
    // Smart-trail metadata used by runner exit engine in monitor + backtest:
    smartTrail,
  };
}

module.exports = {
  decide,
  PRESETS,
  DEFAULT_PRESET,
};
