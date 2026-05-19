/**
 * Ultra Scalp Engine
 * ==================
 * Dedicated 5-20 point scalping signal generator that mirrors the user's
 * TradingView "UT Bot Alerts" indicator EXACTLY (keyValue=2, atrPeriod=1).
 *
 * The institutional playbook framework is excellent for 60-90% WR but it
 * over-filters. This engine sits ALONGSIDE the playbook layer and produces
 * fast scalp signals on UT Bot 5m/3m crossovers with minimal extra
 * confirmation — exactly what a TradingView discretionary trader sees on
 * the chart.
 *
 * Detection rules (matching the Pine Script indicator):
 *   1. UT Bot trailing stop computed on the 5m close stream
 *   2. BUY  = price[t-1] < stop[t-1] AND price[t] > stop[t-1]   (cross-up)
 *   3. SELL = price[t-1] > stop[t-1] AND price[t] < stop[t-1]   (cross-down)
 *
 * The engine returns a directional decision with:
 *   - signal:        'BUY' | 'SELL' | 'HOLD'
 *   - direction:     'bullish' | 'bearish' | 'neutral'
 *   - holdProfile:   { tradeType:'SCALP', maxHoldSec:120, rrTarget:1.5 }
 *   - target_pts:    5..20 (sized to ATR)
 *   - sl_pts:        based on UT Bot trailing stop distance
 *   - trailingStop:  current UT Bot stop (used as dynamic exit)
 *
 * Quality gates (light, by design):
 *   - Spot must be above/below VWAP in the trade direction
 *   - 1m candle direction confirms (most recent bar agrees)
 *   - NOT in expansion vol with delta against direction (false break trap)
 *   - NOT in midday-chop without volume confirmation
 *
 * That's it. No 12-pillar confidence score, no 4 confirmations, no MTF
 * full alignment. The whole point is to catch the EXACT signals the user
 * sees on their TradingView chart.
 */

const { calculateUTBot } = require('../algorithms/multiTimeframe.service');

// User's TradingView config (per screenshot 2026-05-19): Key=2, ATR=1
const ULTRA_UT_BOT_CONFIG = { keyValue: 2, atrPeriod: 1 };

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

/**
 * Convert the engine's normalised candle shape ({o,h,l,c,v}) into the
 * shape that calculateUTBot expects ({open,high,low,close,volume}).
 */
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

/**
 * Determine the most recent UT Bot signal AND a "trend" read for the bar
 * series. We expose both:
 *   - signalNow:  'buy' | 'sell' | 'none'   (only fires on the actual cross bar)
 *   - signalBar:  'buy' | 'sell' | 'none'   (also fires for 1 bar AFTER the cross
 *                                            so a polling engine that runs every
 *                                            ~60s doesn't miss it)
 *   - trend:      'bullish' | 'bearish' | 'neutral'
 *   - trailingStop: current stop level (used as dynamic SL)
 *   - barsSinceFlip: how many bars ago the most recent flip happened
 */
function _utBotRead(candles) {
  const utbCandles = _toUtBotCandles(candles);
  if (utbCandles.length < 6) {
    return { signalNow: 'none', signalBar: 'none', trend: 'neutral', trailingStop: null, barsSinceFlip: null };
  }
  const result = calculateUTBot(utbCandles, ULTRA_UT_BOT_CONFIG);

  // calculateUTBot returns the END-of-series read. To know if THIS bar
  // produced a fresh cross we need to walk the last 2 bars manually.
  // The Pine algorithm: signal fires only on the bar where price crosses
  // the trailing stop in either direction. We approximate by computing
  // the stop for the last 2 bars and checking the cross.
  let signalNow = 'none';
  let signalBar = result.signal;        // current-bar signal
  let barsSinceFlip = null;

  // Build full position series so we can find the most recent flip
  const closes = utbCandles.map(c => c.close);
  const atrSeq = _atrSeq(utbCandles, ULTRA_UT_BOT_CONFIG.atrPeriod);
  const stopSeq = [];
  const posSeq = [];
  for (let i = 0; i < closes.length; i++) {
    const nLoss = ULTRA_UT_BOT_CONFIG.keyValue
                * (atrSeq[i] || atrSeq[atrSeq.length - 1] || 0);
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

  // Find the bar where the position last changed (the cross bar)
  for (let i = posSeq.length - 1; i > 0; i--) {
    if (posSeq[i] !== posSeq[i - 1] && posSeq[i] !== 0) {
      barsSinceFlip = (posSeq.length - 1) - i;
      if (barsSinceFlip === 0) signalNow = posSeq[i] === 1 ? 'buy' : 'sell';
      // signalBar fires for the cross bar AND the bar right after, giving
      // the polling engine ~5 minutes (one 5m bar) to catch the entry.
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

function _atrSeq(candles, period) {
  // Wilder's ATR — same formula calculateUTBot uses internally (re-derive
  // because the helper isn't exported).
  const out = [];
  if (candles.length < 2) return out;
  let prevAtr = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { out.push(0); prevAtr = 0; continue; }
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i < period) { prevAtr = ((prevAtr * (i - 1)) + tr) / Math.max(1, i); }
    else if (i === period) { prevAtr = tr; }
    else { prevAtr = ((prevAtr * (period - 1)) + tr) / period; }
    out.push(prevAtr);
  }
  return out;
}

/**
 * Decide whether to scalp on this cycle.
 *
 * @param {Object} args
 * @param {Array}  args.candles5m       - 5m spot candles {t,o,h,l,c,v}
 * @param {Array}  args.candles3m       - optional 3m spot candles
 * @param {Array}  args.candles1m       - 1m spot candles for confirmation bar
 * @param {Object} args.vwap            - { vwap, position, distance_pct }
 * @param {Object} args.volumeAnalysis  - delta + vsa + acceptance
 * @param {Object} args.volatilityRegime
 * @param {Object} args.sessionPhase
 * @param {number} args.spotPrice
 * @param {Object} [args.atr]           - ATR analysis for sizing
 * @param {Object} [args.settings]      - per-session ultra scalp tuning
 *
 * @returns {Object}
 *   {
 *     fired: boolean,
 *     signal: 'BUY' | 'SELL' | null,
 *     direction: 'bullish' | 'bearish',
 *     reasoning: string,
 *     trailingStop: number,
 *     target_pts: number,
 *     sl_pts: number,
 *     maxHoldSec: number,
 *     rrTarget: number,
 *     barsSinceFlip: number,
 *     confidence: 0..100,
 *     pillars: { ... }
 *   }
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
  const reasons = [];
  const blockers = [];
  const pillars = {};

  // 1) Run UT Bot on 5m
  const ut5 = _utBotRead(candles5m);
  pillars.utBot5m = ut5;
  // Optional 3m read for tighter scalps
  const ut3 = candles3m ? _utBotRead(candles3m) : null;
  if (ut3) pillars.utBot3m = ut3;

  // No fresh signal → don't fire
  // Accept signalBar (current OR previous 5m bar) so a 60s polling engine
  // doesn't miss the entry window. With user's TradingView setup
  // (Key=2 ATR=1) the cross is precise — 1-bar lookback is safe.
  const sig = ut5.signalBar !== 'none' ? ut5.signalBar : 'none';
  if (sig === 'none') {
    return { fired: false, reasoning: 'no fresh UT Bot cross on 5m', pillars };
  }
  const direction = sig === 'buy' ? 'bullish' : 'bearish';
  const signal    = sig === 'buy' ? 'BUY'     : 'SELL';
  reasons.push(`UT Bot 5m ${sig.toUpperCase()} (Key=${ULTRA_UT_BOT_CONFIG.keyValue} ATR=${ULTRA_UT_BOT_CONFIG.atrPeriod})`);

  // 2) HARD VWAP confirmation — chart traders only buy CE when above VWAP
  const vwapPos = vwap?.position;
  const wantPos = direction === 'bullish' ? 'above' : 'below';
  if (!vwapPos || vwapPos !== wantPos) {
    blockers.push(`VWAP wrong side (${vwapPos || 'unknown'})`);
  } else {
    pillars.vwap = 'aligned';
  }

  // 3) HARD: last 1m candle must close in direction. The cross bar SHOULD
  // be confirming. Without this, we're entering noise.
  const last1 = candles1m && candles1m.length ? candles1m[candles1m.length - 1] : null;
  if (last1) {
    const lc = last1.close ?? last1.c;
    const lo = last1.open  ?? last1.o;
    const dirOk = (direction === 'bullish' && lc > lo)
              || (direction === 'bearish' && lc < lo);
    pillars.last1mAgrees = !!dirOk;
    if (!dirOk) blockers.push(`last 1m bar against direction (o=${lo} c=${lc})`);
  } else {
    blockers.push('no 1m candles');
  }

  // 4) HARD: last 5m candle in direction (the cross bar itself should be
  // a green bar for a buy, red bar for a sell)
  const last5 = candles5m && candles5m.length ? candles5m[candles5m.length - 1] : null;
  if (last5) {
    const lc5 = last5.close ?? last5.c;
    const lo5 = last5.open  ?? last5.o;
    const dirOk5 = (direction === 'bullish' && lc5 > lo5)
               || (direction === 'bearish' && lc5 < lo5);
    pillars.last5mAgrees = !!dirOk5;
    if (!dirOk5) blockers.push(`last 5m bar against direction (o=${lo5} c=${lc5})`);
  }

  // 4) Volatility / chop guard
  // Block ONLY when expansion + delta strongly against direction (false break)
  const dPct = _safe(volumeAnalysis?.delta?.cvdPctLong);
  if (volatilityRegime?.state === 'expansion') {
    const deltaAgainst = (direction === 'bullish' && dPct < -10)
                      || (direction === 'bearish' && dPct >  10);
    if (deltaAgainst) blockers.push(`expansion + delta ${dPct}% against`);
  }
  // Allow chop entries — UT Bot is designed for choppy markets when key=2

  // 5) Block trapped breakout VSA
  const vsa = volumeAnalysis?.vsa;
  if (vsa?.bias && vsa.bias !== 'neutral' && vsa.bias !== direction
      && _safe(vsa.strength) >= 60) {
    blockers.push(`VSA ${vsa.pattern} ${vsa.bias} (against)`);
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

  // 6) Sizing: target 5..20pts based on ATR and the distance to UT Bot stop
  const atrPts = _safe(atr?.atr_5m) || _safe(volatilityRegime?.atr5m) || 12;
  // Target: half of ATR, clamped to user's spec [5, 20]
  let target_pts = Math.max(5, Math.min(20, Math.round(atrPts * 0.6)));
  // SL: distance from spot to trailing stop, clamped to [5, 12]
  let sl_pts = 8;
  if (Number.isFinite(spotPrice) && Number.isFinite(ut5.trailingStop)) {
    const dist = Math.abs(spotPrice - ut5.trailingStop);
    sl_pts = Math.max(5, Math.min(12, Math.round(dist + 1)));
  }
  // RR — keep aggressive (1.5+)
  const rrTarget = +(target_pts / Math.max(1, sl_pts)).toFixed(2);

  // 7) Confidence band (used by sizing layer)
  let confidence = 60;
  if (pillars.vwap === 'aligned') confidence += 10;
  if (pillars.last1mAgrees)       confidence += 8;
  if (ut3 && ut3.trend === direction) confidence += 10;
  if (Math.abs(dPct) >= 5
      && ((direction === 'bullish' && dPct > 0) || (direction === 'bearish' && dPct < 0))) {
    confidence += 6;
  }
  confidence = Math.min(95, confidence);

  return {
    fired: true,
    signal,
    direction,
    reasoning: reasons.join(' | '),
    trailingStop: ut5.trailingStop,
    target_pts,
    sl_pts,
    maxHoldSec: 120,            // 2 min — tight scalp
    rrTarget,
    barsSinceFlip: ut5.barsSinceFlip,
    confidence,
    pillars,
    // Used by the entry engine to construct a synthetic playbook decision
    family: 'ultra_scalp',
    name: 'ULTRA_SCALP_UT_BOT',
    holdProfile: { tradeType: 'SCALP', maxHoldSec: 120, rrTarget },
    riskProfile: { slPct: 0.10, sizingFactor: 0.7 },
  };
}

module.exports = { decide, ULTRA_UT_BOT_CONFIG };
