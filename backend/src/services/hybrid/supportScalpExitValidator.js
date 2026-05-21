/**
 * Support Scalp Exit Validator
 * ============================
 * Mirror of the 15-point entry validator, used INSIDE THE TRADE to
 * continuously re-verify the conditions that fired the entry. The
 * support entry only fires when 9 microstructure factors align;
 * if even 2-3 of them flip mid-trade, we cut the position before
 * the rolling premium turns into a loss.
 *
 * Philosophy: ZERO-LOSS TOLERANCE.
 *   - Entry approval was earned by 9 factors agreeing.
 *   - Exit approval is granted when ANY 2 of 6 critical factors flip.
 *   - SL is the absolute hard floor (10pts), but we want to exit BEFORE
 *     SL by reading microstructure deterioration.
 *
 * Decision priority (checked in order):
 *
 *   E1. Hard SL hit                             → EXIT immediate
 *   E2. Hard target hit (after min hold)        → EXIT take-profit
 *   E3. Multi-TF UT Bot reversal                → EXIT immediate
 *       Same direction had ≥3 of 4 TFs at entry. If now <2 TFs agree,
 *       the trend is broken.
 *   E4. Premium reversal — peak gave back ≥50%  → EXIT immediate
 *       Lock profit when price fell halfway from peak back to entry.
 *   E5. Microstructure deterioration ≥2 factors → EXIT
 *       Among: VWAP flip, Supertrend flip, RSI cross opposite, OI flow
 *       reversal, IV crashing, volume drying. Any 2 → exit.
 *   E6. Time decay — past 60% of maxHold without target → EXIT
 *       Theta is winning. Cut and re-deploy.
 *   E7. Adaptive trail — for ≥10pt profit, lock breakeven floor       → TRAIL_SL
 *   E8. None of the above                       → HOLD
 *
 * Returns:
 *   { action: 'EXIT'|'HOLD'|'TRAIL_SL', new_sl?, reasoning, source, factors }
 */

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
function _utBotTrend(candles, keyValue = 1, atrPeriod = 5) {
  if (!candles || candles.length < (atrPeriod + 5)) return 'neutral';
  const norm = candles.map(c => ({
    h: _safe(c.h ?? c.high),
    l: _safe(c.l ?? c.low),
    c: _safe(c.c ?? c.close),
  })).filter(c => Number.isFinite(c.c) && c.c > 0);
  if (norm.length < (atrPeriod + 5)) return 'neutral';
  const atr = _atrSeq(norm, atrPeriod);
  let stop = norm[0].c - keyValue * (atr[0] || 0);
  let pos = 0;
  for (let i = 1; i < norm.length; i++) {
    const nLoss = keyValue * (atr[i] || atr[atr.length - 1] || 0);
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
function _ema(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [values.slice(0, period).reduce((s, v) => s + v, 0) / period];
  for (let i = period; i < values.length; i++) {
    out.push(values[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}
function _rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}
function _findATMRow(strikes, strike) {
  if (!Array.isArray(strikes) || !strikes.length || !Number.isFinite(strike)) return null;
  let row = strikes.find(s => s.strike === strike);
  if (row) return row;
  return strikes.reduce((best, s) => {
    if (!best) return s;
    return Math.abs(s.strike - strike) < Math.abs(best.strike - strike) ? s : best;
  }, null);
}

/**
 * Decide exit/hold/trail for an open SUPPORT_SCALP trade.
 *
 * @param {object} args
 * @param {object} args.trade            ScalpingTrade record
 * @param {object} args.aggregator       { payload, optionChain }
 * @param {Array}  args.candles1m
 * @param {Array}  args.candles3m
 * @param {Array}  args.candles5m
 * @param {Array}  args.candles15m
 * @param {object} args.settings
 * @returns {{ action, reasoning, new_sl?, source, factors }}
 */
function decide({
  trade,
  aggregator = {},
  candles1m  = [],
  candles3m  = [],
  candles5m  = [],
  candles15m = [],
  settings   = {},
} = {}) {
  const now = Date.now();
  const openedAt = new Date(trade?.openedAt || trade?.createdAt || now).getTime();
  const elapsed = Math.floor((now - openedAt) / 1000);

  const entry = _safe(trade?.entryPrice);
  const cur   = _safe(trade?.currentPrice) || entry;
  const peak  = _safe(trade?.maxPriceReached) || entry;
  const slPrice = _safe(trade?.sl);
  const targetPrice = _safe(trade?.target);
  const pnlPts = cur - entry;
  const peakPts = peak - entry;
  const isCE = (trade?.signal === 'BUY_CE') || (trade?.optionType === 'CE');
  const direction = isCE ? 'bullish' : 'bearish';

  const cfg = settings?.supportScalpExit || {};
  const minHoldSec     = _safe(cfg.minHoldSec, 30);
  const maxHoldSec     = _safe(trade?.maxHoldSeconds, _safe(cfg.maxHoldSec, 300));
  const peakGiveBackPct = _safe(cfg.peakGiveBackPct, 0.50);
  const minProfitToTrail = _safe(cfg.minProfitToTrail, 10);
  const minTfsAligned    = _safe(cfg.minTfsAligned, 2); // entry needed 3, exit needs <2
  const maxFailedFactors = _safe(cfg.maxFailedFactors, 2); // 2/6 microstructure flips → exit

  const factors = { elapsed, pnlPts, peakPts };

  // ── E1. Hard SL ──────────────────────────────────────────────────────
  if (slPrice && cur <= slPrice) {
    return {
      action: 'EXIT',
      reasoning: `[SUPPORT-EXIT] SL hit: ${cur.toFixed(2)} ≤ ${slPrice.toFixed(2)} (P&L ${pnlPts.toFixed(2)}pts at ${elapsed}s)`,
      source: 'support_exit:hard_sl',
      factors,
    };
  }

  // ── E2. Hard target hit (only after min hold) ────────────────────────
  if (elapsed >= minHoldSec && targetPrice && cur >= targetPrice) {
    return {
      action: 'EXIT',
      reasoning: `[SUPPORT-EXIT] Target hit: ${cur.toFixed(2)} ≥ ${targetPrice.toFixed(2)} (P&L +${pnlPts.toFixed(2)}pts at ${elapsed}s)`,
      source: 'support_exit:target',
      factors,
    };
  }

  // Below min-hold guard — only SL exits allowed (above)
  if (elapsed < minHoldSec) {
    return {
      action: 'HOLD',
      reasoning: `[SUPPORT-EXIT] Min hold ${elapsed}s/${minHoldSec}s — only SL allowed`,
      source: 'support_exit:min_hold',
      factors,
    };
  }

  // ── E3. Multi-TF UT Bot reversal ─────────────────────────────────────
  // Re-run the same UT Bot reads the entry validator used.
  // Treat 'neutral' as insufficient data — only count ACTIVE reversal
  // (TFs that returned the OPPOSITE direction) as evidence of trend break.
  const t1m  = _utBotTrend(candles1m,  1,   5);
  const t3m  = _utBotTrend(candles3m,  1.5, 10);
  const t5m  = _utBotTrend(candles5m,  2,   10);
  const t15m = _utBotTrend(candles15m, 2.5, 14);
  const opposite = direction === 'bullish' ? 'bearish' : 'bullish';
  const trends = [t1m, t3m, t5m, t15m];
  const aligned     = trends.filter(t => t === direction).length;
  const reversed    = trends.filter(t => t === opposite).length;
  const determined  = trends.filter(t => t !== 'neutral').length;
  factors.mtfUtBot = { '1m': t1m, '3m': t3m, '5m': t5m, '15m': t15m, aligned, reversed };
  // Only exit when we have hard evidence of reversal:
  //   • At least 2 TFs have determined readings (not warmup)
  //   • AND aligned-count is below the threshold
  //   • AND reversed-count meets/exceeds (4 - minTfsAligned) — i.e. the
  //     missing alignment is actually OPPOSITE direction, not neutral.
  const reversalThreshold = 4 - minTfsAligned; // default 2
  if (determined >= 2 && aligned < minTfsAligned && reversed >= reversalThreshold) {
    return {
      action: 'EXIT',
      reasoning: `[SUPPORT-EXIT] MTF UT Bot reversal — only ${aligned}/4 TFs still ${direction}, ` +
                 `${reversed}/4 reversed (1m=${t1m} 3m=${t3m} 5m=${t5m} 15m=${t15m}); ` +
                 `P&L ${pnlPts.toFixed(2)}pts at ${elapsed}s`,
      source: 'support_exit:mtf_reversal',
      factors,
    };
  }

  // ── E4. Premium reversal — peak gave back ≥ peakGiveBackPct ──────────
  if (peakPts > 4 && pnlPts > 0) {
    const giveBack = peak - cur;
    const giveBackRatio = peakPts > 0 ? giveBack / peakPts : 0;
    factors.peakGiveBackRatio = Number(giveBackRatio.toFixed(2));
    if (giveBackRatio >= peakGiveBackPct) {
      return {
        action: 'EXIT',
        reasoning: `[SUPPORT-EXIT] Peak giveback ${(giveBackRatio * 100).toFixed(0)}% ` +
                   `(peak +${peakPts.toFixed(2)}pts → now ${pnlPts.toFixed(2)}pts) at ${elapsed}s`,
        source: 'support_exit:peak_reversal',
        factors,
      };
    }
  }

  // ── E5. Microstructure deterioration check (6 factors) ───────────────
  // Any 2 of these reversing = trend conviction lost.
  const payload = aggregator?.payload || {};
  const optionChain = aggregator?.optionChain || payload?.options_chain || {};
  const strikes = optionChain?.strikes || [];
  const atmRow = _findATMRow(strikes, _safe(trade?.strike));
  const opt = isCE ? atmRow?.call : atmRow?.put;
  const oppOpt = isCE ? atmRow?.put : atmRow?.call;

  const microFlips = [];

  // 5a. VWAP flip
  const vwapPos = payload?.vwap_analysis?.position || payload?.vwap_analysis?.price_vs_vwap;
  factors.vwapPos = vwapPos;
  const wantVwap = direction === 'bullish' ? 'above' : 'below';
  if (vwapPos && vwapPos !== wantVwap) microFlips.push(`VWAP ${vwapPos} (need ${wantVwap})`);

  // 5b. RSI cross opposite (RSI < 50 for bullish, > 50 for bearish)
  const closes3m = candles3m.map(c => c.c ?? c.close).filter(Number.isFinite);
  const rsi3m = _rsi(closes3m, 14);
  factors.rsi3m = rsi3m != null ? Number(rsi3m.toFixed(1)) : null;
  if (rsi3m != null) {
    if (direction === 'bullish' && rsi3m < 45) microFlips.push(`RSI ${rsi3m.toFixed(1)} < 45 (bullish lost)`);
    else if (direction === 'bearish' && rsi3m > 55) microFlips.push(`RSI ${rsi3m.toFixed(1)} > 55 (bearish lost)`);
  }

  // 5c. EMA cross opposite — EMA9 vs EMA20 on 3m
  const ema9 = _ema(closes3m, 9);
  const ema20 = _ema(closes3m, 20);
  if (ema9.length && ema20.length) {
    const last9 = ema9[ema9.length - 1];
    const last20 = ema20[ema20.length - 1];
    const ok = direction === 'bullish' ? last9 >= last20 : last9 <= last20;
    factors.emaCrossOk = ok;
    if (!ok) microFlips.push(`EMA9(${last9.toFixed(1)}) vs EMA20(${last20.toFixed(1)}) flipped against`);
  }

  // 5d. OI flow reversal — same-side OI dropping AND opposite-side OI rising
  const sameOiChg = _safe(opt?.oiChange);
  const oppOiChg  = _safe(oppOpt?.oiChange);
  factors.oiFlow = { sameOiChg, oppOiChg };
  if (sameOiChg < 0 && oppOiChg > 0) {
    microFlips.push(`OI reversed: same ${sameOiChg.toFixed(0)} (down), opposite ${oppOiChg.toFixed(0)} (up)`);
  }

  // 5e. IV crashing (> 30% drop from entry IV would be catastrophic)
  // Best-effort — we may not have entry IV stored. Skip if not available.
  const ivNow = _safe(opt?.iv);
  factors.ivNow = Number(ivNow.toFixed(1));
  if (ivNow > 0 && ivNow < 25) {
    microFlips.push(`IV crashed to ${ivNow.toFixed(1)}% (option dying)`);
  }

  // 5f. Volume drying (5m current vol < 0.5× of 20-bar avg)
  const vols5m = candles5m.map(c => _safe(c.v ?? c.volume));
  const avgVol5m = _avg(vols5m, 20);
  const lastVol5m = vols5m[vols5m.length - 1] || 0;
  const volRatio = avgVol5m > 0 ? lastVol5m / avgVol5m : 1;
  factors.volRatio5m = Number(volRatio.toFixed(2));
  if (volRatio < 0.5 && pnlPts < 5) {
    microFlips.push(`5m volume drying ${volRatio.toFixed(2)}× (no participation)`);
  }

  factors.microFlips = microFlips;
  if (microFlips.length >= maxFailedFactors) {
    return {
      action: 'EXIT',
      reasoning: `[SUPPORT-EXIT] ${microFlips.length}/6 microstructure factors flipped: ${microFlips.join(' | ')}; P&L ${pnlPts.toFixed(2)}pts at ${elapsed}s`,
      source: 'support_exit:microstructure_flip',
      factors,
    };
  }

  // ── E6. Time decay — past 60% of max hold without target ─────────────
  const timeFraction = elapsed / Math.max(1, maxHoldSec);
  if (timeFraction >= 0.6 && pnlPts < (targetPrice - entry) * 0.5) {
    return {
      action: 'EXIT',
      reasoning: `[SUPPORT-EXIT] Time decay — ${(timeFraction * 100).toFixed(0)}% of maxHold elapsed, ` +
                 `P&L only ${pnlPts.toFixed(2)}pts (target ${(targetPrice - entry).toFixed(0)}pts) at ${elapsed}s`,
      source: 'support_exit:time_decay',
      factors,
    };
  }

  // ── E7. Adaptive trail — for ≥10pt profit, raise SL to breakeven ─────
  if (pnlPts >= minProfitToTrail) {
    const newSlCandidate = entry + 1; // breakeven + 1pt buffer
    if (newSlCandidate > slPrice) {
      return {
        action: 'TRAIL_SL',
        new_sl: Number(newSlCandidate.toFixed(2)),
        reasoning: `[SUPPORT-EXIT] Profit ≥${minProfitToTrail}pts — trailing SL to ${newSlCandidate.toFixed(2)} (breakeven+1)`,
        source: 'support_exit:trail_to_breakeven',
        factors,
      };
    }
    // Already trailed; if profit is 60%+ of target, lock 50% of peak
    if (peakPts >= 12) {
      const lockPrice = entry + Math.floor(peakPts * 0.5);
      if (lockPrice > slPrice) {
        return {
          action: 'TRAIL_SL',
          new_sl: Number(lockPrice.toFixed(2)),
          reasoning: `[SUPPORT-EXIT] Locking 50% of peak (+${peakPts.toFixed(0)}pts) — SL → ${lockPrice.toFixed(2)}`,
          source: 'support_exit:trail_lock_50',
          factors,
        };
      }
    }
  }

  // ── E8. Hold — all checks pass ───────────────────────────────────────
  return {
    action: 'HOLD',
    reasoning: `[SUPPORT-HOLD] ${aligned}/4 MTF aligned (${reversed} reversed), ${microFlips.length}/6 micro flips, ` +
               `P&L ${pnlPts.toFixed(2)}pts (peak +${peakPts.toFixed(2)}) at ${elapsed}s`,
    source: 'support_exit:hold',
    factors,
  };
}

module.exports = { decide };
