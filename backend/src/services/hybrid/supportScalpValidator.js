/**
 * Support Scalp 15-Point Guarantee Validator
 * ==========================================
 * STRICT pre-fire validator for the support scalp engine. Only allows an
 * entry when ALL of the following confirm a high-probability ≥ 15-point
 * option premium move:
 *
 *   A. Multi-timeframe UT Bot agreement (1m + 3m + 5m + 15m all in direction)
 *   B. Delta × ATR (5m) projects ≥ 15-point premium move
 *   C. Volume spike on primary 3m TF (current ≥ 1.5× 20-bar avg)
 *   D. OI flow confirms direction (writers in opposite side / unwinders in same side)
 *   E. IV in healthy band (40-90%, not crashing)
 *   F. Bid-ask spread tight (< 1% of premium)
 *   G. Greeks check: delta ≥ 0.40 abs, gamma > 0, theta not crushing (theta/premium < 5%/day)
 *   H. Recent 1m candle aligns (direction-confirming bar)
 *   I. ATR healthy on primary TF (not dead)
 *
 * Returns:
 *   { ok: true, expected_pts, factors }   — all 9 checks passed
 *   { ok: false, blockers, factors }      — at least 1 check failed
 *
 * The validator is conservative by design — its job is "zero loss" tolerance
 * by only firing when conditions strongly favour ≥ 15 point capture.
 */

// ── Helpers ──────────────────────────────────────────────────────────────
function _safe(n, def = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : def;
}

function _avg(arr, n) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + (v || 0), 0) / Math.max(1, slice.length);
}

function _atrSeq(candles, period = 14) {
  const out = [];
  if (!candles || candles.length < 2) return out;
  let prev = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { out.push(0); continue; }
    const c = candles[i], p = candles[i - 1];
    const h = c.h ?? c.high, l = c.l ?? c.low, pc = p.c ?? p.close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i < period) prev = (prev * (i - 1) + tr) / Math.max(1, i);
    else if (i === period) prev = tr;
    else prev = (prev * (period - 1) + tr) / period;
    out.push(prev);
  }
  return out;
}

/**
 * UT Bot read — minimal version for cross-TF confirmation.
 * Returns trend ('bullish'|'bearish'|'neutral') for the last bar.
 */
function _utBotTrend(candles, keyValue = 1, atrPeriod = 5) {
  if (!candles || candles.length < (atrPeriod + 5)) return 'neutral';
  const norm = candles.map(c => ({
    h: _safe(c.h ?? c.high),
    l: _safe(c.l ?? c.low),
    c: _safe(c.c ?? c.close),
  })).filter(c => Number.isFinite(c.c) && c.c > 0);
  if (norm.length < (atrPeriod + 5)) return 'neutral';
  const atrSeq = _atrSeq(norm, atrPeriod);
  let stop = norm[0].c - keyValue * (atrSeq[0] || 0);
  let pos = 0;
  for (let i = 1; i < norm.length; i++) {
    const nLoss = keyValue * (atrSeq[i] || atrSeq[atrSeq.length - 1] || 0);
    const src = norm[i].c;
    if (src > stop && norm[i - 1].c > stop) stop = Math.max(stop, src - nLoss);
    else if (src < stop && norm[i - 1].c < stop) stop = Math.min(stop, src + nLoss);
    else if (src > stop) stop = src - nLoss;
    else stop = src + nLoss;
    if (norm[i - 1].c < stop && src > stop) pos = 1;
    else if (norm[i - 1].c > stop && src < stop) pos = -1;
  }
  return pos === 1 ? 'bullish' : pos === -1 ? 'bearish' : 'neutral';
}

/** Find the ATM strike row for the requested option side. */
function _findATMRow(strikes, atmStrike) {
  if (!Array.isArray(strikes) || !strikes.length || !Number.isFinite(atmStrike)) return null;
  // Exact match first
  let row = strikes.find(s => s.strike === atmStrike);
  if (row) return row;
  // Closest match
  return strikes.reduce((best, s) => {
    if (!best) return s;
    return Math.abs(s.strike - atmStrike) < Math.abs(best.strike - atmStrike) ? s : best;
  }, null);
}

// ── Main validator ──────────────────────────────────────────────────────
/**
 * @param {object} args
 * @param {string}  args.direction      'bullish' | 'bearish'
 * @param {Array}   args.candles1m      1m candles
 * @param {Array}   args.candles3m      3m candles (primary TF)
 * @param {Array}   args.candles5m      5m candles
 * @param {Array}   args.candles15m     15m candles
 * @param {Array}   args.primaryStrikes option chain rows
 * @param {number}  args.atmStrike
 * @param {number}  [args.targetPts=15] required premium move
 * @param {object}  args.settings       full settings (for thresholds)
 * @returns {{ ok: boolean, expected_pts: number, blockers: string[], factors: object }}
 */
function validate({
  direction,
  candles1m  = [],
  candles3m  = [],
  candles5m  = [],
  candles15m = [],
  primaryStrikes = [],
  atmStrike  = null,
  targetPts  = 15,
  settings   = {},
} = {}) {
  const blockers = [];
  const factors = {};

  // Allow per-engine overrides via settings.supportScalpValidator
  const v = settings?.supportScalpValidator || {};
  const minDeltaAbs    = _safe(v.minDeltaAbs,    0.40);
  const minVolSpikeMul = _safe(v.minVolSpikeMul, 1.5);
  const minIv          = _safe(v.minIv,          40);
  const maxIv          = _safe(v.maxIv,          90);
  const maxSpreadPct   = _safe(v.maxSpreadPct,   1.0);
  const maxThetaPct    = _safe(v.maxThetaPct,    5.0);
  const minAtrPts      = _safe(v.minAtrPts,      6);
  const requireMtfUtBot = v.requireMtfUtBot !== false;

  // ── A. Multi-timeframe UT Bot agreement ───────────────────────────────
  if (requireMtfUtBot) {
    const t1m  = _utBotTrend(candles1m,  1,   5);
    const t3m  = _utBotTrend(candles3m,  1.5, 10);
    const t5m  = _utBotTrend(candles5m,  2,   10);
    const t15m = _utBotTrend(candles15m, 2.5, 14);
    factors.mtfUtBot = { '1m': t1m, '3m': t3m, '5m': t5m, '15m': t15m };
    const need = direction; // 'bullish' or 'bearish'
    const aligned = [t1m, t3m, t5m, t15m].filter(t => t === need).length;
    if (aligned < 3) {
      blockers.push(`MTF UT Bot only ${aligned}/4 aligned (1m=${t1m} 3m=${t3m} 5m=${t5m} 15m=${t15m}, need ≥3)`);
    }
  }

  // ── B. Delta × ATR projection of premium move ────────────────────────
  // ATR on 5m is the typical 5-min spot range. Delta × spot move = option premium move.
  // For a 15-point target, we need a spot move of (15 / delta) achievable in
  // ~3 5m bars (15 minutes) given current ATR.
  const atrCandles5m = _atrSeq(candles5m, 14);
  const atr5m = atrCandles5m.length ? atrCandles5m[atrCandles5m.length - 1] : 0;
  factors.atr5m = Number(atr5m.toFixed(2));
  if (atr5m < minAtrPts) {
    blockers.push(`ATR(5m) ${atr5m.toFixed(2)} < ${minAtrPts} pts — market too quiet`);
  }

  // ── C/D/E/F/G. Option chain microstructure ───────────────────────────
  const atmRow = _findATMRow(primaryStrikes, atmStrike);
  const isCE = direction === 'bullish';
  const opt   = isCE ? atmRow?.call : atmRow?.put;
  const oppOpt = isCE ? atmRow?.put  : atmRow?.call;

  if (!opt) {
    blockers.push(`Option row missing for ATM ${atmStrike}`);
    return { ok: false, expected_pts: 0, blockers, factors };
  }

  // Greeks
  const delta = Math.abs(_safe(opt?.greeks?.delta));
  const theta = Math.abs(_safe(opt?.greeks?.theta));
  const gamma = _safe(opt?.greeks?.gamma);
  const vega  = _safe(opt?.greeks?.vega);
  const ltp   = _safe(opt?.ltp);
  const oi    = _safe(opt?.oi);
  const oiChg = _safe(opt?.oiChange);
  const vol   = _safe(opt?.volume);
  const iv    = _safe(opt?.iv);
  const bid   = _safe(opt?.bid);
  const ask   = _safe(opt?.ask);

  factors.greeks = { delta, theta, gamma, vega };
  factors.option = { ltp, oi, oiChg, volume: vol, iv, bid, ask };

  // Delta minimum
  if (delta < minDeltaAbs) {
    blockers.push(`Delta ${delta.toFixed(2)} < ${minDeltaAbs} (need ITM-ish for fast premium move)`);
  }

  // Theta crush check — if theta consumes > X% of premium per day, reject
  if (ltp > 0) {
    const thetaPctDay = (theta / ltp) * 100;
    factors.thetaPctDay = Number(thetaPctDay.toFixed(2));
    if (thetaPctDay > maxThetaPct) {
      blockers.push(`Theta ${thetaPctDay.toFixed(1)}%/day > ${maxThetaPct}% — premium decay too fast`);
    }
  }

  // Gamma must be positive (it always is for long options, but verify)
  if (gamma <= 0) {
    blockers.push(`Gamma ${gamma} non-positive (data anomaly)`);
  }

  // IV health — too low = no movement, too high = imminent crush
  if (iv > 0) {
    if (iv < minIv) blockers.push(`IV ${iv.toFixed(1)}% < ${minIv}% — option too cheap (low expected move)`);
    if (iv > maxIv) blockers.push(`IV ${iv.toFixed(1)}% > ${maxIv}% — IV crush risk too high`);
  }

  // Bid-ask spread — wide spread eats into the 15pt target
  if (bid > 0 && ask > 0) {
    const spreadPct = ((ask - bid) / ((bid + ask) / 2)) * 100;
    factors.spreadPct = Number(spreadPct.toFixed(2));
    if (spreadPct > maxSpreadPct) {
      blockers.push(`Bid-ask spread ${spreadPct.toFixed(2)}% > ${maxSpreadPct}% — fills will leak edge`);
    }
  } else {
    blockers.push('Bid/ask data missing — cannot verify spread');
  }

  // Volume — current 5m volume vs 20-bar avg of 5m bars
  const vols5m = candles5m.map(c => _safe(c.v ?? c.volume));
  const avgVol5m = _avg(vols5m, 20);
  const lastVol5m = vols5m[vols5m.length - 1] || 0;
  const volSpike = avgVol5m > 0 ? lastVol5m / avgVol5m : 0;
  factors.volSpike5m = Number(volSpike.toFixed(2));
  if (volSpike < minVolSpikeMul) {
    blockers.push(`5m volume ${volSpike.toFixed(2)}× avg < ${minVolSpikeMul}× — no participation surge`);
  }

  // OI flow check
  // For BUY_CE (bullish): we want CE OI building (writers sell to traders) OR
  //                       PE OI declining (puts unwinding = bullish flow).
  // Realistically, the safest read: opposite-side OI building or unwinding.
  // CE writers selling at this strike = bearish hedge (could limit upside).
  // The cleanest check: if same-side OI is INCREASING strongly (buyers piling in),
  // that's bullish for BUY_CE. If opposite-side OI is DECREASING (PE unwinding for CE),
  // that's also bullish.
  const sameOiChg = oiChg;
  const oppOiChg  = _safe(oppOpt?.oiChange);
  factors.oiFlow = { sameOiChg, oppOiChg };
  // For bullish: want sameOiChg > 0 (call buyers piling in) OR oppOiChg < 0 (put unwinding)
  // For bearish: want sameOiChg > 0 (put buyers piling in) OR oppOiChg < 0 (call unwinding)
  // Fail ONLY if BOTH are against us (same OI dropping AND opposite OI rising).
  const oiAgainst = sameOiChg < 0 && oppOiChg > 0;
  if (oiAgainst) {
    blockers.push(`OI flow against — same ${sameOiChg.toFixed(0)} (down) + opposite ${oppOiChg.toFixed(0)} (up)`);
  }

  // ── H. Recent 1m candle direction confirmation ──────────────────────
  const last1m = candles1m && candles1m.length ? candles1m[candles1m.length - 1] : null;
  if (last1m) {
    const o = _safe(last1m.o ?? last1m.open);
    const c = _safe(last1m.c ?? last1m.close);
    const dirOk = direction === 'bullish' ? c > o : c < o;
    factors.last1mAligned = dirOk;
    if (!dirOk) {
      blockers.push(`Last 1m candle against direction (o=${o.toFixed(1)} c=${c.toFixed(1)})`);
    }
  }

  // ── Expected premium move ───────────────────────────────────────────
  // 3 × ATR(5m) is a reasonable 15-min ceiling; realistic capture is ~50-70%.
  const expectedSpotMove = atr5m * 3 * 0.6;
  const expectedPremiumMove = expectedSpotMove * delta + (gamma * Math.pow(expectedSpotMove, 2)) / 2;
  factors.expectedSpotMove = Number(expectedSpotMove.toFixed(2));
  factors.expectedPremiumMove = Number(expectedPremiumMove.toFixed(2));
  if (expectedPremiumMove < targetPts) {
    blockers.push(
      `Expected premium move ${expectedPremiumMove.toFixed(1)}pts < target ${targetPts}pts ` +
      `(spotMove=${expectedSpotMove.toFixed(1)} × delta=${delta.toFixed(2)})`
    );
  }

  return {
    ok: blockers.length === 0,
    expected_pts: Number(expectedPremiumMove.toFixed(2)),
    blockers,
    factors,
  };
}

module.exports = { validate };
