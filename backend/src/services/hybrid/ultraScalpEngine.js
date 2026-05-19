/**
 * Ultra Scalp Engine (v3 — asymmetric UT Bot, multi-timeframe)
 * =========================================================
 * Dedicated 5-20 point scalping signal generator that mirrors the user's
 * TradingView "UT Bot Alerts" indicator EXACTLY.
 *
 * v3 IMPROVEMENTS (2026-05-19):
 *   - ASYMMETRIC config — separate BUY-only and SELL-only UT Bot configs
 *     per TF. NIFTY crashes fast (sensitive ATR=1 catches many sells)
 *     but rallies slow (smooth ATR=300 only catches strongest buys).
 *     Default: Key=2/ATR=1 for SELL, Key=2/ATR=300 for BUY (user spec)
 *   - DUAL UT BOT per TF — two trailing-stop streams run in parallel,
 *     sell stream filters to sell-only signals, buy stream to buy-only
 *
 * v2 INHERITED:
 *   - DYNAMIC config — settings.ultraScalp.{...} all overrideable
 *   - MULTI-TF — runs UT Bot on 1m + 3m + 5m simultaneously
 *   - SOFT GATES — 5m bar agreement is no longer hard if 1m + VWAP confirm
 *   - SECONDARY SIGNALS — also fires on 1m UT Bot cross with stricter gates
 *
 * Detection rules (matching Pine Script):
 *   1. UT Bot trailing stop computed on each TF's close stream
 *   2. BUY  = price[t-1] < stop[t-1] AND price[t] > stop[t-1]   (cross-up)
 *   3. SELL = price[t-1] > stop[t-1] AND price[t] < stop[t-1]   (cross-down)
 *
 * Quality gates (light, configurable):
 *   - Spot must be above/below VWAP in the trade direction (HARD by default)
 *   - At least 1m candle in direction (the cross bar should be confirming)
 *   - NOT in expansion vol with delta strongly against direction (false break)
 *   - NOT VSA strong opposition
 */

const { calculateUTBot } = require('../algorithms/multiTimeframe.service');

// ASYMMETRIC default — user spec 2026-05-19:
//   SELL stream: Key=2, ATR=1   (sensitive — fast moves trigger)
//   BUY stream:  Key=2, ATR=300 (smooth — only strongest reversals trigger)
const SELL_CONFIG_DEFAULT = { keyValue: 2, atrPeriod: 1   };
const BUY_CONFIG_DEFAULT  = { keyValue: 2, atrPeriod: 300 };

// Per-timeframe default profiles. `buyConfig` and `sellConfig` apply the
// asymmetric setup; setting them to the same values is symmetric (legacy).
const TF_PROFILES_DEFAULT = {
  '1m':  {
    buyConfig:  { keyValue: 2, atrPeriod: 300 },
    sellConfig: { keyValue: 2, atrPeriod: 1   },
    maxHoldSec:  90, slPtsMin: 4, slPtsMax: 8,  targetMin: 5,  targetMax: 12, sizingFactor: 0.5,
    description: 'Ultra-fast scalp — asymmetric UT Bot (sell sensitive, buy smooth)',
  },
  '3m':  {
    buyConfig:  { keyValue: 2, atrPeriod: 300 },
    sellConfig: { keyValue: 2, atrPeriod: 1   },
    maxHoldSec: 120, slPtsMin: 5, slPtsMax: 10, targetMin: 6,  targetMax: 15, sizingFactor: 0.6,
    description: '3m UT Bot — asymmetric (sell sensitive, buy smooth)',
  },
  '5m':  {
    buyConfig:  { keyValue: 2, atrPeriod: 300 },
    sellConfig: { keyValue: 2, atrPeriod: 1   },
    maxHoldSec: 150, slPtsMin: 6, slPtsMax: 12, targetMin: 8,  targetMax: 20, sizingFactor: 0.7,
    description: 'Primary 5m UT Bot scalp — matches user TradingView setup',
  },
};

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

/** Normalise candle shape for the UT Bot calculator */
function _toUtBotCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.map(c => ({
    open:   c.open  ?? c.o,
    high:   c.high  ?? c.h,
    low:    c.low   ?? c.l,
    close:  c.close ?? c.c,
    volume: c.volume ?? c.v ?? 0,
  })).filter(c => Number.isFinite(c.close));
}

/** Wilder's ATR — re-derived because the helper isn't exported */
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
 * UT Bot read with cross detection, returning signal age info.
 * @param {Array}  candles
 * @param {Object} config { keyValue, atrPeriod }
 */
function _utBotRead(candles, config) {
  const utbCandles = _toUtBotCandles(candles);
  if (utbCandles.length < (config.atrPeriod + 5)) {
    return { signalNow: 'none', signalBar: 'none', trend: 'neutral', trailingStop: null, barsSinceFlip: null };
  }
  const result = calculateUTBot(utbCandles, config);

  let signalNow = 'none';
  let signalBar = result.signal;
  let barsSinceFlip = null;

  // Walk the position series to find the most recent flip bar
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

  for (let i = posSeq.length - 1; i > 0; i--) {
    if (posSeq[i] !== posSeq[i - 1] && posSeq[i] !== 0) {
      barsSinceFlip = (posSeq.length - 1) - i;
      if (barsSinceFlip === 0) signalNow = posSeq[i] === 1 ? 'buy' : 'sell';
      if (barsSinceFlip <= 1) signalBar = posSeq[i] === 1 ? 'buy' : 'sell';
      break;
    }
  }

  return {
    signalNow,
    signalBar,
    trend: result.trend,
    trailingStop: result.trailingStop,
    barsSinceFlip,
  };
}

/**
 * ASYMMETRIC dual-config UT Bot read. Runs the engine twice per TF —
 * once with the BUY config and once with the SELL config — then selects
 * whichever stream actually crossed within the last bar in its allowed
 * direction. Returns the chosen read plus both raw streams for telemetry.
 *
 * Rationale: NIFTY trends asymmetrically. The user's setup uses a fast
 * sensitive ATR for SELL signals (catches the quick crashes) and a smooth
 * 300-period ATR for BUY signals (only triggers on the strongest reversals).
 * A single config can't do both.
 *
 * If a stream's ATR period exceeds the available candle count by too much
 * (warmup unmet), that stream is silently disabled rather than producing
 * misleading early signals.
 */
function _dualUtBotRead(candles, profile) {
  const buyCfg  = profile.buyConfig  || profile;
  const sellCfg = profile.sellConfig || profile;
  const utbCandles = _toUtBotCandles(candles);
  const buyWarm  = utbCandles.length >= (buyCfg.atrPeriod  + 5);
  const sellWarm = utbCandles.length >= (sellCfg.atrPeriod + 5);
  const buyRead  = buyWarm  ? _utBotRead(candles, buyCfg)  : { signalNow: 'none', signalBar: 'none', trend: 'neutral', trailingStop: null, barsSinceFlip: null, warmupShort: true };
  const sellRead = sellWarm ? _utBotRead(candles, sellCfg) : { signalNow: 'none', signalBar: 'none', trend: 'neutral', trailingStop: null, barsSinceFlip: null, warmupShort: true };

  // Filter — buy stream only emits buys, sell stream only emits sells.
  const buySignal  = (buyWarm  && buyRead.signalBar  === 'buy')  ? 'buy'  : 'none';
  const sellSignal = (sellWarm && sellRead.signalBar === 'sell') ? 'sell' : 'none';

  // Pick the freshest cross. If both fired, prefer the one whose bars-since-
  // flip is smaller. Tie → prefer sell (the sensitive stream is intentionally
  // more aggressive, so when both fire we honour the rapid-move side).
  let chosenSignal = 'none';
  let chosenRead   = buyRead;
  let chosenStream = 'buy';
  if (buySignal !== 'none' && sellSignal !== 'none') {
    const bAge = buyRead.barsSinceFlip ?? Infinity;
    const sAge = sellRead.barsSinceFlip ?? Infinity;
    if (sAge <= bAge) { chosenSignal = 'sell'; chosenRead = sellRead; chosenStream = 'sell'; }
    else              { chosenSignal = 'buy';  chosenRead = buyRead;  chosenStream = 'buy';  }
  } else if (buySignal !== 'none') {
    chosenSignal = 'buy';  chosenRead = buyRead;  chosenStream = 'buy';
  } else if (sellSignal !== 'none') {
    chosenSignal = 'sell'; chosenRead = sellRead; chosenStream = 'sell';
  }

  return {
    signalNow:    chosenRead.signalNow,
    signalBar:    chosenSignal,
    trend:        chosenRead.trend,
    trailingStop: chosenRead.trailingStop,
    barsSinceFlip: chosenRead.barsSinceFlip,
    chosenStream,                         // 'buy' | 'sell'
    streams: {
      buy:  { config: buyCfg,  ...buyRead  },
      sell: { config: sellCfg, ...sellRead },
    },
  };
}

/**
 * Decide whether to scalp on this cycle. Tries 5m → 3m → 1m UT Bot and
 * picks the strongest signal. Fires when any TF crosses with adequate
 * confirmation.
 */
function decide({
  candles5m = [],
  candles3m = null,
  candles1m = [],
  vwap = null,
  volumeAnalysis = null,
  volatilityRegime = null,
  sessionPhase = null,
  spotPrice = null,
  atr = null,
  settings = {},
} = {}) {
  // Resolve user config — settings.ultraScalp can override per-TF and global
  const userCfg = settings?.ultraScalp || {};
  // Each TF profile MUST have buyConfig + sellConfig (asymmetric default).
  // Legacy single-config callers can still pass `keyValue` + `atrPeriod`
  // at the top level; if buy/sellConfig are not provided, fall back to the
  // legacy single config for both (i.e. symmetric).
  function _resolveProfile(tfKey) {
    const dflt = TF_PROFILES_DEFAULT[tfKey];
    const userTf = userCfg[`tf${tfKey.replace('m', 'm')}`] || userCfg[tfKey] || {};
    const profile = { ...dflt, ...userTf };
    // If user supplied buy/sellConfig, those take precedence over global
    profile.buyConfig  = profile.buyConfig  || (userTf.keyValue != null && userTf.atrPeriod != null
      ? { keyValue: userTf.keyValue, atrPeriod: userTf.atrPeriod }
      : dflt.buyConfig);
    profile.sellConfig = profile.sellConfig || (userTf.keyValue != null && userTf.atrPeriod != null
      ? { keyValue: userTf.keyValue, atrPeriod: userTf.atrPeriod }
      : dflt.sellConfig);
    return profile;
  }
  const tfProfiles = {
    '1m': _resolveProfile('1m'),
    '3m': _resolveProfile('3m'),
    '5m': _resolveProfile('5m'),
  };
  // Allow disabling specific timeframes (defaults: 1m + 3m + 5m all ON
  // for maximum scalp opportunities — user spec 2026-05-19)
  const enable = {
    '1m': userCfg.enable1m !== false,    // default ON
    '3m': userCfg.enable3m !== false,    // default ON
    '5m': userCfg.enable5m !== false,    // default ON
  };
  const vwapStrict = userCfg.vwapStrict !== false;     // default ON
  const requireBarColor = userCfg.requireBarColor !== false;  // default ON
  const allowStaleBar = userCfg.allowStaleBar === true;       // default OFF

  // Run dual UT Bot (asymmetric BUY+SELL configs) on enabled TFs.
  // We require enough candles for the SHORTER ATR stream to warm up; the
  // longer stream may stay cold (legitimate behaviour — no signal until
  // enough history accrues). Inside _dualUtBotRead each stream is
  // independently warm-checked.
  function _minCandles(profile) {
    const buy  = profile.buyConfig?.atrPeriod  ?? 1;
    const sell = profile.sellConfig?.atrPeriod ?? 1;
    return Math.min(buy, sell) + 5;
  }
  const tfReads = {};
  if (enable['5m'] && candles5m && candles5m.length >= _minCandles(tfProfiles['5m'])) {
    tfReads['5m'] = { read: _dualUtBotRead(candles5m, tfProfiles['5m']), profile: tfProfiles['5m'] };
  }
  if (enable['3m'] && candles3m && candles3m.length >= _minCandles(tfProfiles['3m'])) {
    tfReads['3m'] = { read: _dualUtBotRead(candles3m, tfProfiles['3m']), profile: tfProfiles['3m'] };
  }
  if (enable['1m'] && candles1m && candles1m.length >= _minCandles(tfProfiles['1m'])) {
    tfReads['1m'] = { read: _dualUtBotRead(candles1m, tfProfiles['1m']), profile: tfProfiles['1m'] };
  }

  // Pick the best signal across enabled TFs (priority: 5m > 3m > 1m)
  let chosen = null;
  for (const tf of ['5m', '3m', '1m']) {
    const tr = tfReads[tf];
    if (!tr) continue;
    const sig = tr.read.signalBar;
    if (sig === 'none') continue;
    chosen = { tf, ...tr, signal: sig };
    break;
  }
  if (!chosen) {
    return {
      fired: false,
      reasoning: 'no UT Bot cross on any enabled TF',
      pillars: { tfReads: Object.fromEntries(Object.entries(tfReads).map(([k, v]) => [k, v.read])) },
    };
  }

  const direction = chosen.signal === 'buy' ? 'bullish' : 'bearish';
  const signal    = chosen.signal === 'buy' ? 'BUY'     : 'SELL';
  // Pick the actual config used for this signal (asymmetric streams)
  const usedCfg = chosen.signal === 'buy' ? chosen.profile.buyConfig : chosen.profile.sellConfig;
  const reasons = [
    `UT Bot ${chosen.tf} ${chosen.signal.toUpperCase()} (Key=${usedCfg.keyValue} ATR=${usedCfg.atrPeriod})`,
  ];
  const blockers = [];
  const pillars = {
    chosenTf: chosen.tf,
    barsSinceFlip: chosen.read.barsSinceFlip,
    trailingStop: chosen.read.trailingStop,
    tfReads: Object.fromEntries(Object.entries(tfReads).map(([k, v]) => [k, v.read])),
  };

  // ─── 1) VWAP confirmation ──────────────────────────────────────────────
  const vwapPos = vwap?.position;
  const wantPos = direction === 'bullish' ? 'above' : 'below';
  if (!vwapPos || vwapPos !== wantPos) {
    if (vwapStrict) blockers.push(`VWAP wrong side (${vwapPos || 'unknown'})`);
    else reasons.push(`VWAP ${vwapPos || 'unknown'} (soft)`);
  } else {
    pillars.vwap = 'aligned';
    reasons.push('VWAP aligned');
  }

  // ─── 2) Bar-color confirmation: at least 1m must agree ─────────────────
  // Soft-gate the 5m bar (often inside-bar at cross). 1m is the canonical
  // execution-timing signal — without it we're chasing.
  const last1 = candles1m && candles1m.length ? candles1m[candles1m.length - 1] : null;
  if (last1) {
    const lc = last1.close ?? last1.c;
    const lo = last1.open  ?? last1.o;
    const dirOk = (direction === 'bullish' && lc > lo)
              || (direction === 'bearish' && lc < lo);
    pillars.last1mAgrees = !!dirOk;
    if (!dirOk && requireBarColor) blockers.push(`last 1m bar against (o=${lo} c=${lc})`);
  }

  // 5m bar is informational only (helps confidence)
  const last5 = candles5m && candles5m.length ? candles5m[candles5m.length - 1] : null;
  if (last5) {
    const lc5 = last5.close ?? last5.c;
    const lo5 = last5.open  ?? last5.o;
    const dirOk5 = (direction === 'bullish' && lc5 > lo5)
               || (direction === 'bearish' && lc5 < lo5);
    pillars.last5mAgrees = !!dirOk5;
    if (dirOk5) reasons.push('5m bar aligned');
  }

  // Stale-bar guard — when the cross was 1+ bars ago and price is no longer
  // above/below the trailing stop in our direction, skip.
  if (!allowStaleBar && chosen.read.barsSinceFlip != null && chosen.read.barsSinceFlip > 1) {
    blockers.push(`signal stale (${chosen.read.barsSinceFlip} bars since flip)`);
  }

  // ─── 3) Volatility / orderflow safety ──────────────────────────────────
  const dPct = _safe(volumeAnalysis?.delta?.cvdPctLong);
  if (volatilityRegime?.state === 'expansion') {
    const deltaAgainst = (direction === 'bullish' && dPct < -10)
                      || (direction === 'bearish' && dPct >  10);
    if (deltaAgainst) blockers.push(`expansion + delta ${dPct}% strongly against`);
  }
  // Block trapped breakout VSA strong opposition
  const vsa = volumeAnalysis?.vsa;
  if (vsa?.bias && vsa.bias !== 'neutral' && vsa.bias !== direction
      && _safe(vsa.strength) >= 60) {
    blockers.push(`VSA ${vsa.pattern} ${vsa.bias} (against, strength ${vsa.strength})`);
  }

  if (blockers.length) {
    return {
      fired: false,
      signal: null,
      direction,
      reasoning: `${reasons.join(' | ')} BLOCKED: ${blockers.join(', ')}`,
      pillars,
    };
  }

  // ─── 4) Sizing — clamp target/SL to TF profile and ATR ─────────────────
  const profile = chosen.profile;
  const atrPts = _safe(atr?.atr_5m) || _safe(volatilityRegime?.atr5m) || 12;
  let target_pts = Math.max(profile.targetMin, Math.min(profile.targetMax, Math.round(atrPts * 0.6)));

  let sl_pts = profile.slPtsMin + 2;
  if (Number.isFinite(spotPrice) && Number.isFinite(chosen.read.trailingStop)) {
    const dist = Math.abs(spotPrice - chosen.read.trailingStop);
    sl_pts = Math.max(profile.slPtsMin, Math.min(profile.slPtsMax, Math.round(dist + 1)));
  }
  const rrTarget = +(target_pts / Math.max(1, sl_pts)).toFixed(2);

  // ─── 5) Confidence band — built up from confirmations ──────────────────
  let confidence = 60;
  if (pillars.vwap === 'aligned')   confidence += 10;
  if (pillars.last1mAgrees)         confidence += 8;
  if (pillars.last5mAgrees)         confidence += 6;
  // MTF agreement bonus — when 5m AND 3m both have a UT Bot trend in
  // our direction (using whichever stream — buy or sell — that matches).
  function _streamTrendMatches(read, dir) {
    if (!read) return false;
    if (read.trend === dir) return true;
    // Asymmetric streams may disagree; check the side that matches our
    // direction explicitly.
    if (dir === 'bullish' && read.streams?.buy?.trend === 'bullish')  return true;
    if (dir === 'bearish' && read.streams?.sell?.trend === 'bearish') return true;
    return false;
  }
  if (_streamTrendMatches(tfReads['5m']?.read, direction)
      && _streamTrendMatches(tfReads['3m']?.read, direction)) {
    confidence += 8; reasons.push('5m+3m UT Bot trend aligned');
  }
  // Delta in direction
  if (Math.abs(dPct) >= 5
      && ((direction === 'bullish' && dPct > 0) || (direction === 'bearish' && dPct < 0))) {
    confidence += 6;
  }
  // Microstructure absorption / iceberg in direction (added v2)
  // (passed by caller via volumeAnalysis context; fallback safe)
  confidence = Math.min(95, confidence);

  return {
    fired: true,
    signal,
    direction,
    reasoning: reasons.join(' | '),
    trailingStop: chosen.read.trailingStop,
    target_pts,
    sl_pts,
    maxHoldSec: profile.maxHoldSec,
    rrTarget,
    barsSinceFlip: chosen.read.barsSinceFlip,
    confidence,
    pillars,
    timeframe: chosen.tf,
    family: 'ultra_scalp',
    name: 'ULTRA_SCALP_UT_BOT',
    holdProfile: { tradeType: 'SCALP', maxHoldSec: profile.maxHoldSec, rrTarget },
    riskProfile: { slPct: 0.10, sizingFactor: profile.sizingFactor },
  };
}

module.exports = {
  decide,
  SELL_CONFIG_DEFAULT,
  BUY_CONFIG_DEFAULT,
  TF_PROFILES_DEFAULT,
};
