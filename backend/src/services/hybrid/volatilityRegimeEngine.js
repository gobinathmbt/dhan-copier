/**
 * Volatility Regime Engine
 * ------------------------
 * Classifies the current volatility state into:
 *   dead | normal | expansion | panic | event_driven
 *
 * Inputs
 *   - candles1m : recent NIFTY 1-min OHLCV candles (≥ 30 preferred)
 *   - candles5m : recent NIFTY 5-min OHLCV candles (≥ 30 preferred)
 *   - vix       : optional India VIX number
 *   - atrCtx    : optional pre-computed ATR analysis from atr.service
 *
 * Outputs (all numbers are rounded for stability):
 *   {
 *     state, atr1m, atr5m, atrPct1m, atrPct5m,
 *     atrPercentile, rangeCompression, expansionScore,
 *     allowEntries, sizingFactor, reasoning
 *   }
 *
 * Sizing factor is multiplicative. Engine combines this with session
 * aggressionFactor to derive final lot count.
 */

const atrService = require('../atr.service');

function _percentileRank(values, target) {
  if (!values || !values.length || !Number.isFinite(target)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let below = 0;
  for (const v of sorted) {
    if (v <= target) below++;
    else break;
  }
  return Math.round((below / sorted.length) * 100);
}

function _trueRanges(candles) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const h = c.h ?? c.high;
    const l = c.l ?? c.low;
    const pc = p.c ?? p.close;
    if (![h, l, pc].every(Number.isFinite)) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs;
}

function _normalize(c) {
  if (!c) return null;
  const o = c.o ?? c.open;
  const h = c.h ?? c.high;
  const l = c.l ?? c.low;
  const cl = c.c ?? c.close;
  if (![o, h, l, cl].every(Number.isFinite)) return null;
  return { o, h, l, c: cl, v: c.v ?? c.volume ?? 0 };
}

/**
 * Detect volatility regime.
 *
 * @param {Object} params
 * @param {Array}  params.candles1m
 * @param {Array}  params.candles5m
 * @param {number} [params.vix]
 * @returns {Object} regime
 */
function classify({ candles1m = [], candles5m = [], vix = null } = {}) {
  const c1 = (candles1m || []).map(_normalize).filter(Boolean);
  const c5 = (candles5m || []).map(_normalize).filter(Boolean);

  // ATR via shared service for consistency with the rest of the codebase
  const atr1mObj = atrService.calculateATR(c1, 14);
  const atr5mObj = atrService.calculateATR(c5, 14);

  const atr1m = atr1mObj?.atr ?? null;
  const atr5m = atr5mObj?.atr ?? null;
  const atrPct1m = atr1mObj?.atrPct ?? null;
  const atrPct5m = atr5mObj?.atrPct ?? null;

  // ── ATR percentile across the recent window ───────────────────────────────
  // Compares current TR to the recent population — quick proxy for percentile.
  const trs5 = _trueRanges(c5);
  const lastTr5 = trs5.length ? trs5[trs5.length - 1] : null;
  const atrPercentile = (lastTr5 != null) ? _percentileRank(trs5, lastTr5) : null;

  // ── Range compression: current 5-bar range vs the prior 20-bar range ─────
  let rangeCompression = null;
  if (c5.length >= 25) {
    const recent = c5.slice(-5);
    const prior  = c5.slice(-25, -5);
    const recentRange = Math.max(...recent.map(x => x.h)) - Math.min(...recent.map(x => x.l));
    const priorRange  = Math.max(...prior.map(x => x.h))  - Math.min(...prior.map(x => x.l));
    if (priorRange > 0) {
      rangeCompression = Number((recentRange / priorRange).toFixed(2));
    }
  }

  // ── Expansion score: TR ratio of last bar vs SMA(TR, 14) ─────────────────
  let expansionScore = null;
  if (trs5.length >= 14) {
    const last = trs5[trs5.length - 1];
    const avg = trs5.slice(-14).reduce((a, b) => a + b, 0) / 14;
    expansionScore = avg > 0 ? Number((last / avg).toFixed(2)) : null;
  }

  // ── State classification ─────────────────────────────────────────────────
  let state = 'normal';
  const reasons = [];

  // Dead market — very low volatility, avoid trading
  if ((atrPct5m != null && atrPct5m < 0.05) ||
      (rangeCompression != null && rangeCompression < 0.3) ||
      (atrPercentile != null && atrPercentile < 15)) {
    state = 'dead';
    reasons.push('atrPct very low / range compressed / low ATR percentile');
  }
  // Panic — extreme volatility, news/event driven, reduce aggression
  else if ((atrPercentile != null && atrPercentile >= 95) ||
           (expansionScore != null && expansionScore >= 3.0) ||
           (vix != null && vix >= 22)) {
    state = 'panic';
    reasons.push('extreme expansion / very high percentile / VIX spike');
  }
  // Event-driven — high VIX without obvious panic — special handling
  else if (vix != null && vix >= 18 && vix < 22) {
    state = 'event_driven';
    reasons.push('elevated VIX 18-22');
  }
  // Expansion — healthy momentum environment
  else if ((atrPercentile != null && atrPercentile >= 70) ||
           (expansionScore != null && expansionScore >= 1.5)) {
    state = 'expansion';
    reasons.push('above-average TR / high ATR percentile');
  }
  // Otherwise normal
  else {
    state = 'normal';
    reasons.push('range normal');
  }

  // ── Trading permission per regime ───────────────────────────────────────
  // Calibrated 2026-05-18 (institutional spec): dead vol allows
  // mean-revert / vwap-reclaim / reversal scalps at 0.65 size (was 0.45).
  // Real edge in dead vol comes from pin rotations and IV decay fades —
  // sizing was too punishing. Breakouts/momentum are still downgraded
  // by meta-regime, not hard-blocked here. Only `panic` hard-blocks.
  const policy = {
    dead:         { allowEntries: true,  sizingFactor: 0.65, allowedFamilies: ['mean_reversion','vwap_reclaim','reversal'] },
    normal:       { allowEntries: true,  sizingFactor: 1.0  },
    expansion:    { allowEntries: true,  sizingFactor: 1.0  },
    panic:        { allowEntries: false, sizingFactor: 0    },
    event_driven: { allowEntries: true,  sizingFactor: 0.5  },
  }[state];

  return {
    state,
    atr1m,
    atr5m,
    atrPct1m,
    atrPct5m,
    atrPercentile,
    rangeCompression,
    expansionScore,
    vix: vix ?? null,
    allowEntries: policy.allowEntries,
    sizingFactor: policy.sizingFactor,
    reasoning: reasons.join(' | '),
  };
}

module.exports = { classify };
