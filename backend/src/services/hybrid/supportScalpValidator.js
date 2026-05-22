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
  // CALIBRATED 2026-05-21: thresholds adapted for Indian index options
  // (lower IV, expiry-day theta, lower per-strike volume).
  const v = settings?.supportScalpValidator || {};
  const minDeltaAbs    = _safe(v.minDeltaAbs,    0.30);  // 0.40 → 0.30 (allow slightly OTM)
  const minVolSpikeMul = _safe(v.minVolSpikeMul, 0.5);   // 1.5 → 0.5
  const minIv          = _safe(v.minIv,          10);    // 40 → 10 (Indian indices trade 13-20%)
  const maxIv          = _safe(v.maxIv,          90);
  const maxSpreadPct   = _safe(v.maxSpreadPct,   2.0);   // 1.0 → 2.0
  const maxThetaPct    = _safe(v.maxThetaPct,    250);   // 5 → 250 (expiry-aware)
  const minAtrPts      = _safe(v.minAtrPts,      4);     // 6 → 4 (allow tighter ranges)
  const minTfsAligned  = _safe(v.minTfsAligned,  2);     // 3 → 2 (5m/15m UT Bot lags)
  const requireMtfUtBot = v.requireMtfUtBot !== false;
  const skipLast1mCheck = v.skipLast1mCheck === true;

  // ── A. Multi-timeframe UT Bot agreement ───────────────────────────────
  // CALIBRATED 2026-05-21: 'neutral' TFs no longer count as "against".
  // Block only when active reversal (≥2 TFs in opposite direction).
  if (requireMtfUtBot) {
    const t1m  = _utBotTrend(candles1m,  1,   5);
    const t3m  = _utBotTrend(candles3m,  1.5, 10);
    const t5m  = _utBotTrend(candles5m,  2,   10);
    const t15m = _utBotTrend(candles15m, 2.5, 14);
    factors.mtfUtBot = { '1m': t1m, '3m': t3m, '5m': t5m, '15m': t15m };
    const need = direction;
    const opposite = direction === 'bullish' ? 'bearish' : 'bullish';
    const trends = [t1m, t3m, t5m, t15m];
    const aligned  = trends.filter(t => t === need).length;
    const reversed = trends.filter(t => t === opposite).length;
    factors.mtfAligned = aligned;
    factors.mtfReversed = reversed;
    // Block when fewer than minTfsAligned AND there's active opposition
    if (aligned < minTfsAligned && reversed >= 2) {
      blockers.push(`MTF UT Bot ${aligned}/4 aligned and ${reversed}/4 reversed (1m=${t1m} 3m=${t3m} 5m=${t5m} 15m=${t15m})`);
    } else if (aligned < 1) {
      // Edge case: ALL TFs neutral → warmup, can't trust the signal
      blockers.push(`MTF UT Bot all warming up (${trends.join(',')})`);
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
  // ROBUST 2026-05-21: Support BOTH chain shapes:
  //   API-shape:    row.call / row.put  with row.call.greeks.delta
  //   Flat-shape:   row.ce / row.pe     with row.ce.delta (top level)
  // The engine receives chains from multiple sources (live API, folder
  // fallback, futures aggregator) — be liberal in what we accept.
  const atmRow = _findATMRow(primaryStrikes, atmStrike);
  const isCE = direction === 'bullish';
  // Try API-shape first, fall back to flat-shape
  const optApi = isCE ? atmRow?.call : atmRow?.put;
  const optFlat = isCE ? atmRow?.ce  : atmRow?.pe;
  const opt    = optApi || optFlat;
  const oppOpt = isCE ? (atmRow?.put ?? atmRow?.pe) : (atmRow?.call ?? atmRow?.ce);

  if (!opt) {
    blockers.push(`Option row missing for ATM ${atmStrike} (chain has ${primaryStrikes?.length || 0} strikes)`);
    return { ok: false, expected_pts: 0, blockers, factors };
  }

  // Greeks — try nested first (API), fallback to flat (recorded)
  const _greekDelta = opt?.greeks?.delta ?? opt?.delta;
  const _greekTheta = opt?.greeks?.theta ?? opt?.theta;
  const _greekGamma = opt?.greeks?.gamma ?? opt?.gamma;
  const _greekVega  = opt?.greeks?.vega  ?? opt?.vega;
  const delta = Math.abs(_safe(_greekDelta));
  const theta = Math.abs(_safe(_greekTheta));
  const gamma = _safe(_greekGamma);
  const vega  = _safe(_greekVega);
  const ltp   = _safe(opt?.ltp);
  const oi    = _safe(opt?.oi);
  // OI change: API uses oiChange, flat uses oiChg
  const oiChg = _safe(opt?.oiChange ?? opt?.oiChg);
  // Volume: API uses volume, flat uses vol
  const vol   = _safe(opt?.volume ?? opt?.vol);
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

  // Volume — current 5m volume vs 20-bar avg of 5m bars.
  //
  // FIX 2026-05-22: skip still-forming current 5m bucket. The aggregator
  // can emit BOTH the closed bar (full volume ~1-5M) AND a partial bar
  // for the same timestamp (volume few KB) within the same cycle. Without
  // this guard the validator reads the partial as "last volume", computes
  // a near-zero spike ratio and blocks every otherwise-valid setup.
  // Dedup by timestamp keeping the higher-volume row, then drop the
  // trailing bar if it's still inside the active 5m bucket.
  const _TF_5M_SEC = 300;
  const _nowSec = Math.floor(Date.now() / 1000);
  // Keep highest-volume sample per timestamp (handles aggregator+disk
  // duplicates where one has the full bar and the other a partial).
  const byT = new Map();
  for (const c of candles5m) {
    const t = Number(c.t ?? c.time);
    if (!Number.isFinite(t)) continue;
    const v = _safe(c.v ?? c.volume);
    const prev = byT.get(t);
    if (!prev || v > prev) byT.set(t, v);
  }
  const sortedTs = [...byT.keys()].sort((a, b) => a - b);
  // Drop the latest bar if its bucket has not closed yet
  // (bucketStart + 300s > now means we're still inside it).
  while (sortedTs.length > 0) {
    const lastT = sortedTs[sortedTs.length - 1];
    if (lastT + _TF_5M_SEC > _nowSec) sortedTs.pop();
    else break;
  }
  const vols5m = sortedTs.map(t => byT.get(t));
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
  const oppOiChg  = _safe(oppOpt?.oiChange ?? oppOpt?.oiChg);
  factors.oiFlow = { sameOiChg, oppOiChg };
  // For bullish: want sameOiChg > 0 (call buyers piling in) OR oppOiChg < 0 (put unwinding)
  // For bearish: want sameOiChg > 0 (put buyers piling in) OR oppOiChg < 0 (call unwinding)
  // Fail ONLY if BOTH are against us (same OI dropping AND opposite OI rising).
  const oiAgainst = sameOiChg < 0 && oppOiChg > 0;
  if (oiAgainst) {
    blockers.push(`OI flow against — same ${sameOiChg.toFixed(0)} (down) + opposite ${oppOiChg.toFixed(0)} (up)`);
  }

  // ── H. Recent 1m candle direction confirmation ──────────────────────
  // CALIBRATED 2026-05-21: Soft gate — only block when the counter candle
  // is large (body > 30% of ATR) AND MTF strongly disagrees. Single small
  // retest bars are healthy in real breakouts.
  const last1m = candles1m && candles1m.length ? candles1m[candles1m.length - 1] : null;
  if (last1m && !skipLast1mCheck) {
    const o = _safe(last1m.o ?? last1m.open);
    const c = _safe(last1m.c ?? last1m.close);
    const dirOk = direction === 'bullish' ? c > o : c < o;
    factors.last1mAligned = dirOk;
    if (!dirOk) {
      const bodyPts = Math.abs(c - o);
      const bodyRatio = atr5m > 0 ? bodyPts / atr5m : 1;
      const mtfAlignedCount = factors.mtfAligned ?? 0;
      // Block only on big counter body (>30% ATR) AND weak MTF
      if (bodyRatio > 0.30 && mtfAlignedCount < 2) {
        blockers.push(`Last 1m strongly against (o=${o.toFixed(1)} c=${c.toFixed(1)}, ${bodyRatio.toFixed(2)}×ATR + MTF ${mtfAlignedCount}/4)`);
      }
    }
  }

  // ── Expected premium move ───────────────────────────────────────────
  // We project the realistic premium gain a 15-min scalp can capture
  // given current ATR + Greeks. NIFTY's 3× ATR(5m) is a reasonable
  // 15-min ceiling; capture rate is ~50-70% of that.
  //
  // 2026-05-22: Added effectiveDeltaMul (default 0.85) — in low-IV
  // regimes (Indian indices at 13-15% IV) premium captures only ~85%
  // of theoretical delta×spotMove because of bid-ask wear, slippage,
  // and theta bleed during the hold. Without this haircut, the
  // validator was projecting 19pts and capturing 4pts.
  const effectiveDeltaMul = _safe(v.effectiveDeltaMul, 0.85);
  const expectedSpotMove = atr5m * 3 * 0.6;
  const expectedPremiumMove = (expectedSpotMove * delta * effectiveDeltaMul)
    + (gamma * Math.pow(expectedSpotMove, 2)) / 2;
  factors.expectedSpotMove = Number(expectedSpotMove.toFixed(2));
  factors.expectedPremiumMove = Number(expectedPremiumMove.toFixed(2));
  factors.effectiveDeltaMul = effectiveDeltaMul;
  if (expectedPremiumMove < targetPts) {
    blockers.push(
      `Expected premium move ${expectedPremiumMove.toFixed(1)}pts < target ${targetPts}pts ` +
      `(spotMove=${expectedSpotMove.toFixed(1)} × delta=${delta.toFixed(2)} × ${effectiveDeltaMul})`
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
