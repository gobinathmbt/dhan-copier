/**
 * Market Auction Engine
 * =====================
 * Classifies the day's auction state per institutional Market Profile theory.
 * This is what tells us whether we're seeing:
 *   - acceptance above/below prior value (continuation)
 *   - rejection back into prior value (reversal)
 *   - balanced rotation (mean reversion preferred)
 *   - trending auction (momentum preferred)
 *
 * Inputs:
 *   - candles1m / candles5m (today)
 *   - priorDay              (from multiDayContextEngine)
 *   - currentSpot
 *   - sessionPhase          (from sessionEngine)
 *
 * Outputs:
 *   - openType              gap_up / gap_down / open_inside / open_outside
 *   - acceptance            above_pva / below_pva / inside_pva / unknown
 *   - valueMigration        higher / lower / overlapping
 *   - dayType               trend_up / trend_down / balanced / neutral /
 *                           short_covering / long_liquidation /
 *                           double_distribution / undeveloped
 *   - excessHigh / excessLow (true if large rejection wicks at extremes)
 *   - poorHigh / poorLow    (flat extreme — likely to be revisited)
 *   - ibProgress            'inside' | 'extending_up' | 'extending_down' | 'failed'
 *   - tradingImplication    'momentum_continuation' | 'mean_reversion' |
 *                           'reversal_setup' | 'wait'
 *   - reasoning
 *
 * Pure deterministic — no AI.
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : null; }

function _max(arr, key) { return arr.reduce((m, c) => Math.max(m, key(c)), -Infinity); }
function _min(arr, key) { return arr.reduce((m, c) => Math.min(m, key(c)), +Infinity); }

function _classifyOpen(open, priorDay) {
  if (!priorDay) return 'unknown';
  const pdh = priorDay.high, pdl = priorDay.low, pvah = priorDay.vah, pval = priorDay.val;
  if (open > pdh) return 'gap_up';
  if (open < pdl) return 'gap_down';
  // Inside prior range
  if (pvah && pval) {
    if (open > pvah) return 'open_above_value';
    if (open < pval) return 'open_below_value';
    return 'open_inside_value';
  }
  return 'open_inside';
}

function _acceptance(currentSpot, priorDay) {
  if (!priorDay?.vah || !priorDay?.val) return 'unknown';
  if (currentSpot > priorDay.vah) return 'above_pva';
  if (currentSpot < priorDay.val) return 'below_pva';
  return 'inside_pva';
}

function _valueMigration({ candles5m, priorDay }) {
  if (!candles5m?.length || !priorDay?.vah) return 'overlapping';
  // Compute today's developing VAH/VAL using volume distribution
  const minP = Math.min(...candles5m.map(c => c.l));
  const maxP = Math.max(...candles5m.map(c => c.h));
  if (maxP <= minP) return 'overlapping';
  const buckets = 30;
  const bs = (maxP - minP) / buckets;
  const bins = new Array(buckets).fill(0);
  for (const c of candles5m) {
    const range = Math.max(0.01, c.h - c.l);
    const start = Math.max(0, Math.floor((c.l - minP) / bs));
    const end   = Math.min(buckets - 1, Math.floor((c.h - minP) / bs));
    const span = Math.max(1, end - start + 1);
    const per = (c.v || 0) / span;
    for (let i = start; i <= end; i++) bins[i] += per;
  }
  const total = bins.reduce((a, b) => a + b, 0);
  if (total <= 0) return 'overlapping';
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[pocIdx]) pocIdx = i;
  let vol = bins[pocIdx], lo = pocIdx, hi = pocIdx;
  const target = total * 0.7;
  while (vol < target && (lo > 0 || hi < bins.length - 1)) {
    const lv = lo > 0 ? bins[lo - 1] : -1;
    const hv = hi < bins.length - 1 ? bins[hi + 1] : -1;
    if (lv >= hv) { lo--; vol += Math.max(0, lv); } else { hi++; vol += Math.max(0, hv); }
  }
  const todayVal = minP + lo * bs;
  const todayVah = minP + (hi + 1) * bs;
  // Compare to prior
  const overlap = todayVah > priorDay.val && todayVal < priorDay.vah;
  if (todayVal > priorDay.vah) return 'higher';
  if (todayVah < priorDay.val) return 'lower';
  if (overlap) return 'overlapping';
  return 'overlapping';
}

function _initialBalance(candles1m) {
  if (!candles1m || candles1m.length < 20) return null;
  // First 60 1m bars
  const ib = candles1m.slice(0, 60);
  if (!ib.length) return null;
  const high = Math.max(...ib.map(c => c.h));
  const low  = Math.min(...ib.map(c => c.l));
  return { high, low, range: high - low };
}

function _ibProgress({ candles1m, ib, currentSpot }) {
  if (!ib || !candles1m?.length) return 'inside';
  // Are we still inside, or have we extended beyond IB?
  const sinceIb = candles1m.slice(60);
  if (!sinceIb.length) return 'inside';
  const dayHigh = Math.max(...sinceIb.map(c => c.h), ib.high);
  const dayLow  = Math.min(...sinceIb.map(c => c.l), ib.low);
  if (dayHigh > ib.high * 1.0005 && dayLow >= ib.low * 0.9995) return 'extending_up';
  if (dayLow  < ib.low  * 0.9995 && dayHigh <= ib.high * 1.0005) return 'extending_down';
  if (dayHigh > ib.high * 1.0005 && dayLow < ib.low * 0.9995) return 'failed';     // both sides — chop
  return 'inside';
}

function _wickAnalysis(candles5m) {
  // Excess vs poor highs/lows — institutional auction signature.
  // Excess high = strong rejection wick at the top
  // Poor high   = flat top, no rejection — likely to be revisited
  if (!candles5m?.length) return { excessHigh: false, excessLow: false, poorHigh: false, poorLow: false };
  const last10 = candles5m.slice(-10);
  const dayHigh = Math.max(...candles5m.map(c => c.h));
  const dayLow  = Math.min(...candles5m.map(c => c.l));
  const highBars = candles5m.filter(c => c.h >= dayHigh * 0.9998).slice(-3);
  const lowBars  = candles5m.filter(c => c.l <= dayLow * 1.0002).slice(-3);

  const excessHigh = highBars.some(c => (c.h - Math.max(c.o, c.c)) > 0.6 * (c.h - c.l));
  const excessLow  = lowBars.some(c => (Math.min(c.o, c.c) - c.l) > 0.6 * (c.h - c.l));
  const poorHigh   = highBars.length >= 2 && !excessHigh;
  const poorLow    = lowBars.length >= 2 && !excessLow;
  return { excessHigh, excessLow, poorHigh, poorLow };
}

function _classifyDayType({ candles1m, candles5m, ib, currentSpot, ibProgress, valueMigration }) {
  if (!candles5m?.length) return 'undeveloped';
  const open  = candles5m[0].o;
  const close = candles5m[candles5m.length - 1].c;
  const high  = Math.max(...candles5m.map(c => c.h));
  const low   = Math.min(...candles5m.map(c => c.l));
  const range = high - low;
  if (range <= 0) return 'undeveloped';

  const closeFrac = (close - low) / range;

  // Trend day — closes near extreme + IB extended in same direction
  if (closeFrac > 0.78 && ibProgress === 'extending_up') return 'trend_up';
  if (closeFrac < 0.22 && ibProgress === 'extending_down') return 'trend_down';

  // Short covering — opened below IB low, closes above IB high
  if (ib && open < ib.low * 1.0005 && close > ib.high * 0.9995) return 'short_covering';
  // Long liquidation — opposite
  if (ib && open > ib.high * 0.9995 && close < ib.low * 1.0005) return 'long_liquidation';

  // Double distribution — bimodal price action
  const mid = (high + low) / 2;
  const above = candles5m.filter(c => c.c > mid).length;
  const below = candles5m.filter(c => c.c < mid).length;
  if (Math.min(above, below) / candles5m.length > 0.32 && ibProgress === 'failed') {
    return 'double_distribution';
  }

  // Neutral — wide range that closes near mid
  if (Math.abs(closeFrac - 0.5) < 0.18 && range > (ib?.range || 0) * 1.4) return 'neutral';

  // Balanced — narrow range, IB-bound
  if (ibProgress === 'inside') return 'balanced';

  return 'balanced';
}

function _tradingImplication({ dayType, acceptance, valueMigration, openType, excess }) {
  // Map auction state → preferred entry style
  if (dayType === 'trend_up' || dayType === 'short_covering')   return 'momentum_continuation';
  if (dayType === 'trend_down' || dayType === 'long_liquidation') return 'momentum_continuation';
  if (dayType === 'double_distribution')                          return 'breakout_continuation';
  if (dayType === 'neutral' || dayType === 'balanced')            return 'mean_reversion';
  if (excess.excessHigh && acceptance === 'above_pva')            return 'reversal_setup';
  if (excess.excessLow  && acceptance === 'below_pva')            return 'reversal_setup';
  return 'wait';
}

/**
 * @param {Object} args
 * @param {Array}  args.candles1m
 * @param {Array}  args.candles5m
 * @param {Object} args.priorDay  - multiDayContextEngine.priorDay
 * @param {number} args.currentSpot
 * @returns {Object}
 */
function analyze({ candles1m = [], candles5m = [], priorDay = null, currentSpot = null } = {}) {
  if (!candles5m.length) return null;

  const ib = _initialBalance(candles1m);
  const open = candles5m[0].o;
  const openType = _classifyOpen(open, priorDay);
  const acceptance = _acceptance(currentSpot, priorDay);
  const valueMigration = _valueMigration({ candles5m, priorDay });
  const ibProgress = _ibProgress({ candles1m, ib, currentSpot });
  const excess = _wickAnalysis(candles5m);
  const dayType = _classifyDayType({ candles1m, candles5m, ib, currentSpot, ibProgress, valueMigration });
  const tradingImplication = _tradingImplication({ dayType, acceptance, valueMigration, openType, excess });

  return {
    openType,
    acceptance,
    valueMigration,
    dayType,
    ibProgress,
    excessHigh: excess.excessHigh,
    excessLow:  excess.excessLow,
    poorHigh:   excess.poorHigh,
    poorLow:    excess.poorLow,
    ibHigh: ib?.high ?? null,
    ibLow:  ib?.low  ?? null,
    ibRange:ib?.range ?? null,
    tradingImplication,
    reasoning: `${dayType} | ${openType} | acceptance=${acceptance} | migration=${valueMigration} | ib=${ibProgress} → ${tradingImplication}`,
  };
}

module.exports = { analyze };
