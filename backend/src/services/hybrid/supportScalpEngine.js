/**
 * Support Scalp Engine
 * ====================
 * 5-confluence intraday scalper for NIFTY (and SENSEX). Combines five
 * widely-used scalping indicators and only fires when ALL agree.
 *
 *   1. UT Bot Alerts        — main BUY/SELL trigger (Key=1.5, ATR=10)
 *   2. Supertrend (ATR 10, multiplier 2.5)  — trend filter
 *   3. VWAP                 — institutional bias (price above/below)
 *   4. EMA 9 / EMA 20       — momentum alignment
 *   5. RSI(14)              — long ≥ 55, short ≤ 45 (avoid bad entries)
 *
 * BUY entry:
 *   ✅ Price above VWAP
 *   ✅ EMA 9 > EMA 20
 *   ✅ Supertrend GREEN (uptrend)
 *   ✅ UT Bot gives BUY (cross within ≤ 1 bar)
 *   ✅ RSI ≥ 55
 *
 * SELL entry: mirror.
 *
 * Higher timeframe confirmation (15m): the same Supertrend + EMA + RSI
 * checks must agree on the 15m timeframe. This reduces fake trades by
 * filtering out 3m-only counter-trend entries.
 *
 * Returns the same shape as ultraScalpEngine.decide() so it's a drop-in
 * for the master scalping entry router.
 */

const { calculateUTBot } = require('../algorithms/multiTimeframe.service');

// ────────────────────────────────────────────────────────────────────────
// Math primitives
// ────────────────────────────────────────────────────────────────────────
function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

function _ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function _atrSeq(candles, period) {
  const out = [];
  if (candles.length < 2) return out;
  let prevAtr = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { out.push(0); prevAtr = 0; continue; }
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    if (i < period) prevAtr = ((prevAtr * (i - 1)) + tr) / Math.max(1, i);
    else if (i === period) prevAtr = tr;
    else prevAtr = ((prevAtr * (period - 1)) + tr) / period;
    out.push(prevAtr);
  }
  return out;
}

/**
 * Standard Supertrend. Returns { trend: 'green'|'red', value, flipped }.
 * trend = 'green' (long bias) when price > Supertrend line.
 */
function _supertrend(candles, atrPeriod = 10, multiplier = 2.5) {
  if (!Array.isArray(candles) || candles.length < atrPeriod + 5) {
    return { trend: 'neutral', value: null, flipped: false, warmupShort: true };
  }
  const atrSeq = _atrSeq(candles, atrPeriod);
  let upperBand = 0, lowerBand = 0, st = 0, dir = 1;
  let prevDir = 1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const mid = (c.h + c.l) / 2;
    const atr = atrSeq[i] || 0;
    const upper = mid + multiplier * atr;
    const lower = mid - multiplier * atr;
    if (i === 0) {
      upperBand = upper; lowerBand = lower;
      st = upper; dir = -1;
      continue;
    }
    upperBand = (upper < upperBand || candles[i - 1].c > upperBand) ? upper : upperBand;
    lowerBand = (lower > lowerBand || candles[i - 1].c < lowerBand) ? lower : lowerBand;
    prevDir = dir;
    if (st === upperBand) dir = c.c > upperBand ? 1 : -1;
    else                  dir = c.c < lowerBand ? -1 : 1;
    st = dir === 1 ? lowerBand : upperBand;
  }
  return {
    trend: dir === 1 ? 'green' : 'red',
    value: st,
    flipped: dir !== prevDir,
    warmupShort: false,
  };
}

/** RSI(14) using Wilder's smoothing. Returns the latest RSI value. */
function _rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = ((avgG * (period - 1)) + Math.max(d, 0)) / period;
    avgL = ((avgL * (period - 1)) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}

/** UT Bot read with cross detection (compatible with ultraScalpEngine logic). */
function _utBotRead(candles, config) {
  const utbCandles = candles.map(c => ({
    open: c.o ?? c.open, high: c.h ?? c.high, low: c.l ?? c.low,
    close: c.c ?? c.close, volume: c.v ?? c.volume ?? 0, t: c.t ?? c.time,
  })).filter(c => Number.isFinite(c.close));
  const need = (config.atrPeriod || 1) + 5;
  if (utbCandles.length < need) {
    return { signalBar: 'none', trend: 'neutral', warmupShort: true, barsSinceFlip: null, trailingStop: null };
  }
  const result = calculateUTBot(utbCandles, config);
  // Walk position series to find barsSinceFlip
  const closes = utbCandles.map(c => c.close);
  const atrSeq = _atrSeq(utbCandles.map(c => ({ h: c.high, l: c.low, c: c.close })), config.atrPeriod);
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
  let signalBar = result.signal;
  let barsSinceFlip = null;
  for (let i = posSeq.length - 1; i > 0; i--) {
    if (posSeq[i] !== posSeq[i - 1] && posSeq[i] !== 0) {
      barsSinceFlip = (posSeq.length - 1) - i;
      if (barsSinceFlip <= 1) signalBar = posSeq[i] === 1 ? 'buy' : 'sell';
      break;
    }
  }
  const lastPos = posSeq[posSeq.length - 1];
  return {
    signalBar,
    trend: lastPos === 1 ? 'bullish' : lastPos === -1 ? 'bearish' : 'neutral',
    barsSinceFlip,
    trailingStop: stopSeq[stopSeq.length - 1],
    warmupShort: false,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Public: decide()
// ────────────────────────────────────────────────────────────────────────
function decide({
  candles3m  = null,             // primary TF (built from 1m by caller)
  candles5m  = [],
  candles15m = [],               // confirmation TF
  candles1m  = [],
  vwap       = null,
  spotPrice  = null,
  atr        = null,
  // NEW (2026-05-20) — extras for the 15-point pre-fire validator
  primaryStrikes = null,         // option chain rows
  atmStrike  = null,             // current ATM strike
  futuresData = null,            // futures premium / lead-lag (best-effort)
  market     = null,             // active symbol key (NIFTY_50 / SENSEX)
  settings   = {},
} = {}) {
  const cfg = settings?.supportScalp || {};
  const utCfg     = cfg.utBot      || { keyValue: 1.5, atrPeriod: 10 };
  const stCfg     = cfg.supertrend || { atrPeriod: 10, multiplier: 2.5 };
  const emaCfg    = cfg.ema        || { fastPeriod: 9, slowPeriod: 20 };
  const rsiCfg    = cfg.rsi        || { period: 14, longMin: 55, shortMax: 45 };
  const requireVwap        = cfg.requireVwap        !== false;
  const requireSupertrend  = cfg.requireSupertrend  !== false;
  const requireEmaAlign    = cfg.requireEmaAlignment !== false;
  const requireRsiFilter   = cfg.requireRsiFilter   !== false;
  const primaryTf = cfg.primaryTf || '3m';
  const confirmTf = cfg.confirmationTf || '15m';

  // Pick the primary candle stream
  const primary = primaryTf === '5m' ? candles5m
                : primaryTf === '15m' ? candles15m
                : primaryTf === '1m'  ? candles1m
                : (candles3m || []);
  if (!Array.isArray(primary) || primary.length < (utCfg.atrPeriod + 5)) {
    return { fired: false, reasoning: `support: insufficient ${primaryTf} candles (${primary?.length || 0})`, pillars: {} };
  }

  // 1) UT Bot trigger
  const utRead = _utBotRead(primary, utCfg);
  if (utRead.warmupShort || (utRead.signalBar !== 'buy' && utRead.signalBar !== 'sell')) {
    return { fired: false, reasoning: `support: no UT Bot cross on ${primaryTf}`, pillars: { utBot: utRead } };
  }
  const direction = utRead.signalBar === 'buy' ? 'bullish' : 'bearish';

  const blockers = [];
  const reasons = [
    `UT Bot ${primaryTf} ${utRead.signalBar.toUpperCase()} (Key=${utCfg.keyValue} ATR=${utCfg.atrPeriod})`,
  ];

  // 2) VWAP alignment
  const vwapPos = vwap?.position;
  if (requireVwap) {
    const want = direction === 'bullish' ? 'above' : 'below';
    if (vwapPos !== want) blockers.push(`VWAP ${vwapPos || 'unknown'} (need ${want})`);
    else reasons.push('VWAP aligned');
  }

  // 3) Supertrend on primary TF
  const stPrimary = _supertrend(primary.map(c => ({ h: c.h ?? c.high, l: c.l ?? c.low, c: c.c ?? c.close })), stCfg.atrPeriod, stCfg.multiplier);
  if (requireSupertrend) {
    const wantTrend = direction === 'bullish' ? 'green' : 'red';
    if (stPrimary.warmupShort) blockers.push('Supertrend warmup short');
    else if (stPrimary.trend !== wantTrend) blockers.push(`Supertrend ${stPrimary.trend} (need ${wantTrend})`);
    else reasons.push(`Supertrend ${stPrimary.trend} aligned`);
  }

  // 4) EMA 9 vs EMA 20 on primary TF
  // CALIBRATED 2026-05-20: pure ">" check rejected close-call setups where
  // EMAs were within 0.01% (e.g. 23595.4 vs 23595.6 — 0.2 points apart).
  // Now uses a small directional tolerance: "aligned" if EMA9 is on the
  // RIGHT side of EMA20 by at least `emaTolerancePct` (default 0.01%) OR
  // they're within tolerance AND VWAP+Supertrend already agree (consensus
  // takes over from a tied EMA cross). Configurable via cfg.ema.tolerancePct.
  const emaTolerancePct = Number(emaCfg.tolerancePct);
  const tolFrac = Number.isFinite(emaTolerancePct) ? emaTolerancePct / 100 : 0.0001; // 0.01% default
  const closesPrimary = primary.map(c => c.c ?? c.close);
  const ema9  = _ema(closesPrimary, emaCfg.fastPeriod);
  const ema20 = _ema(closesPrimary, emaCfg.slowPeriod);
  let emaAligned = false;
  let lastEma9, lastEma20;
  if (ema9.length && ema20.length) {
    lastEma9 = ema9[ema9.length - 1];
    lastEma20 = ema20[ema20.length - 1];
    const diffPct = Math.abs(lastEma9 - lastEma20) / Math.max(1, lastEma20);
    if (direction === 'bullish') {
      // Aligned if EMA9 is above EMA20 by any amount, OR EMAs are tied
      // within tolerance (price action will resolve which side wins).
      emaAligned = lastEma9 > lastEma20 || diffPct <= tolFrac;
    } else {
      emaAligned = lastEma9 < lastEma20 || diffPct <= tolFrac;
    }
  }
  if (requireEmaAlign) {
    if (!ema9.length || !ema20.length) blockers.push('EMA warmup short');
    else if (!emaAligned) blockers.push(`EMA${emaCfg.fastPeriod}=${lastEma9?.toFixed(1)} vs EMA${emaCfg.slowPeriod}=${lastEma20?.toFixed(1)} not aligned`);
    else reasons.push(`EMA aligned (${lastEma9.toFixed(1)} vs ${lastEma20.toFixed(1)})`);
  }

  // 5) RSI filter on primary TF
  const rsiVal = _rsi(closesPrimary, rsiCfg.period);
  if (requireRsiFilter) {
    if (rsiVal == null) blockers.push('RSI warmup short');
    else if (direction === 'bullish' && rsiVal < rsiCfg.longMin) {
      blockers.push(`RSI ${rsiVal.toFixed(1)} < ${rsiCfg.longMin} (long min)`);
    } else if (direction === 'bearish' && rsiVal > rsiCfg.shortMax) {
      blockers.push(`RSI ${rsiVal.toFixed(1)} > ${rsiCfg.shortMax} (short max)`);
    } else {
      reasons.push(`RSI ${rsiVal.toFixed(1)}`);
    }
  }

  // 6) Confirmation TF — Supertrend + EMA must agree on 15m too
  if (Array.isArray(candles15m) && candles15m.length >= (stCfg.atrPeriod + 5)) {
    const stConf = _supertrend(
      candles15m.map(c => ({ h: c.h ?? c.high, l: c.l ?? c.low, c: c.c ?? c.close })),
      stCfg.atrPeriod, stCfg.multiplier
    );
    const want = direction === 'bullish' ? 'green' : 'red';
    if (!stConf.warmupShort && stConf.trend !== want) {
      blockers.push(`${confirmTf} Supertrend ${stConf.trend} (need ${want})`);
    } else if (stConf.trend === want) {
      reasons.push(`${confirmTf} Supertrend ${stConf.trend} aligned`);
    }
    const closesConf = candles15m.map(c => c.c ?? c.close);
    const ema9c  = _ema(closesConf, emaCfg.fastPeriod);
    const ema20c = _ema(closesConf, emaCfg.slowPeriod);
    if (ema9c.length && ema20c.length) {
      const lc9 = ema9c[ema9c.length - 1];
      const lc20 = ema20c[ema20c.length - 1];
      const ok = direction === 'bullish' ? lc9 > lc20 : lc9 < lc20;
      if (!ok) blockers.push(`${confirmTf} EMA not aligned`);
    }
  }

  if (blockers.length) {
    return {
      fired: false, signal: null, direction,
      reasoning: `support: ${reasons.join(' | ')} BLOCKED: ${blockers.join(', ')}`,
      pillars: { utBot: utRead, supertrend: stPrimary, ema9: lastEma9, ema20: lastEma20, rsi: rsiVal, vwap: vwapPos },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 15-POINT GUARANTEE VALIDATOR (2026-05-20)
  // ════════════════════════════════════════════════════════════════════
  // The 5 confluence factors above (UT Bot + VWAP + Supertrend + EMA + RSI)
  // confirm DIRECTION quality. The validator below confirms TARGET quality —
  // can we realistically capture ≥ 15 points of premium given current ATR,
  // delta, gamma, IV, OI flow, volume, bid-ask spread?
  //
  // Settings:
  //   settings.supportScalp.targetMin (default 15) → required premium move
  //   settings.supportScalpValidator.* → per-check thresholds (delta, IV, etc.)
  // ────────────────────────────────────────────────────────────────────
  const target15 = Number(cfg.targetMin) || 15;
  const validator = require('./supportScalpValidator');
  const v = validator.validate({
    direction,
    candles1m, candles3m: primary, candles5m, candles15m,
    primaryStrikes: Array.isArray(primaryStrikes) ? primaryStrikes : [],
    atmStrike,
    targetPts: target15,
    settings,
  });
  if (!v.ok) {
    return {
      fired: false, signal: null, direction,
      reasoning: `support: ${reasons.join(' | ')} BLOCKED by 15pt validator: ${v.blockers.join('; ')}`,
      pillars: {
        utBot: utRead, supertrend: stPrimary, ema9: lastEma9, ema20: lastEma20,
        rsi: rsiVal, vwap: vwapPos,
        validator: { ok: false, expected_pts: v.expected_pts, factors: v.factors },
      },
    };
  }
  // Validator passed — record the expected premium move + factor breakdown.
  reasons.push(`✓15pt-validator (expected ${v.expected_pts}pts, atr5m=${v.factors.atr5m}, delta=${v.factors.greeks?.delta?.toFixed(2)}, vol=${v.factors.volSpike5m}×, spread=${v.factors.spreadPct}%)`);

  // ── Sizing ───────────────────────────────────────────────────────────
  const atrPts = _safe(atr?.atr_5m) || 12;
  const targetMin = cfg.targetMin || 8;
  const targetMax = cfg.targetMax || 20;
  const slPtsMin = cfg.slPtsMin || 6;
  const slPtsMax = cfg.slPtsMax || 14;
  const target_pts = Math.max(targetMin, Math.min(targetMax, Math.round(atrPts * 0.5)));
  let sl_pts = slPtsMin + 2;
  if (Number.isFinite(spotPrice) && Number.isFinite(utRead.trailingStop)) {
    const dist = Math.abs(spotPrice - utRead.trailingStop);
    sl_pts = Math.max(slPtsMin, Math.min(slPtsMax, Math.round(dist + 1)));
  }
  const rrTarget = +(target_pts / Math.max(1, sl_pts)).toFixed(2);
  const maxHoldSec = cfg.maxHoldSec || 240;
  const sizingFactor = cfg.sizingFactor || 0.7;

  // ── Confidence ───────────────────────────────────────────────────────
  // Each confirmation adds points. 5/5 confirmations → 90, 4/5 → 75, 3/5 → 60.
  let confidence = 60;
  if (requireVwap)        confidence += 6;
  if (requireSupertrend)  confidence += 6;
  if (requireEmaAlign)    confidence += 6;
  if (requireRsiFilter)   confidence += 6;
  if (rsiVal && Math.abs(rsiVal - 50) > 15) confidence += 4;
  confidence = Math.min(95, confidence);

  return {
    fired: true,
    signal: direction === 'bullish' ? 'BUY' : 'SELL',
    direction,
    reasoning: reasons.join(' | '),
    trailingStop: utRead.trailingStop,
    target_pts,
    sl_pts,
    maxHoldSec,
    rrTarget,
    barsSinceFlip: utRead.barsSinceFlip,
    confidence,
    pillars: {
      utBot: utRead, supertrend: stPrimary,
      ema9: lastEma9, ema20: lastEma20, rsi: rsiVal,
      vwap: vwapPos, primaryTf, confirmTf,
    },
    timeframe: primaryTf,
    family: 'support_scalp',
    name: 'SUPPORT_SCALP_CONFLUENCE',
    holdProfile: { tradeType: 'SCALP', maxHoldSec, rrTarget },
    riskProfile: { slPct: 0.10, sizingFactor },
    confluenceTier: 'standard',
    consensusScore: Math.min(100, 20 * [requireVwap, requireSupertrend, requireEmaAlign, requireRsiFilter, true].filter(Boolean).length),
    smartTrail: {
      mode: 'hybrid',
      lockTriggerPct:   0.50,
      peakGivebackPct:  null,
      slopeExitMin:     0.30,
      earlyFailureCheck: true,
    },
  };
}

module.exports = { decide };
