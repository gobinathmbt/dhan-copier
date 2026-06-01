/* ─────────────────────────────────────────────────────────────────────
 * INTEL V4 — Pure Buyers/Sellers Decision Engine
 * ========================================================================
 *
 * Goal: One clean institutional verdict driven by:
 *   • per-strike CE/PE buyer/seller domination (ATM ± 5)
 *   • overall market control (BUYERS / SELLERS / NEUTRAL)
 *   • likely market direction (UP / DOWN / RANGE)
 *
 * Design: zero-cost composition over the existing V2 snapshot. We don't
 * make any extra Dhan calls; we just project the V2 dashboard fields
 * into a minimal "who-is-pressing-where" view that an option buyer can
 * read in 2 seconds.
 *
 * Endpoint: GET /api/intel-v4/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]
 *
 * Output shape — every number is final (already classified) so the
 * frontend can render plain text rows without re-computing anything.
 *
 *   {
 *     ok, version: 'v4', symbol, atm, spotPrice, vwap, time,
 *     primaryStrike,                       // = ATM rounded to step
 *     overall: {
 *       control: 'BUYERS' | 'SELLERS' | 'NEUTRAL',
 *       directionLikely: 'UP' | 'DOWN' | 'RANGE',
 *       cePct, pePct, score, confidence,
 *       grade: 'A+' | 'A' | 'B' | 'C' | 'D',
 *       conviction: 'HIGH' | 'MEDIUM' | 'LOW' | 'AVOID',
 *       verdict: 'BUY CE' | 'BUY PE' | 'WAIT',
 *       reasons: string[],
 *     },
 *     bestStrike: { strike, side, score, reason },
 *     mostVolume: { strike, volume },
 *     strikes: [
 *       {
 *         strike, isAtm, offset,
 *         ce: { oi, oiChg, ltp, iv, delta, vol, buyersPct, sellersPct,
 *               buildup, dominance: 'BUYERS'|'SELLERS'|'BALANCED', score },
 *         pe: { ...same },
 *         dominantSide: 'CE' | 'PE' | 'BALANCED',
 *         strength: 'WEAK' | 'MODERATE' | 'STRONG' | 'DOMINANT',
 *         marketImpact: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
 *         note: string,
 *       },
 *     ],
 *   }
 * ───────────────────────────────────────────────────────────────────── */

const intelV2 = require('./intelV2.service');

/* ─────────────────────────────────────────────────────────────────────
 * Per-symbol history ring buffer.
 * Stores up to last 240 snapshots (~12 min @ 3s polling) per symbol.
 * Used by:
 *   • OI velocity              (Δ OI per minute)
 *   • Volume velocity          (vs trailing average)
 *   • Wall stability           (how long the top wall has held)
 *   • Strike migration         (top wall drift over time)
 *   • IV trend                 (ATM IV expansion / contraction)
 *   • Time above/below VWAP    (acceptance duration)
 *   • Absorption detection     (price moves with no OI confirmation)
 *   • Trend exhaustion         (price keeps going but volume / OI fading)
 * ───────────────────────────────────────────────────────────────────── */
const HISTORY_MAX = 240;
const HISTORY_TTL_MS = 60 * 60_000;
const _history = new Map(); // symbol → [{ t, atm, spot, vwap, atmIv, oiByStrike: Map, volByStrike: Map, topR, topS }]

function _pushHistory(symbol, snap) {
  const list = _history.get(symbol) || [];
  list.push(snap);
  const cutoff = Date.now() - HISTORY_TTL_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  while (list.length > HISTORY_MAX) list.shift();
  _history.set(symbol, list);
}

function _historyAt(symbol, ageMs) {
  const list = _history.get(symbol) || [];
  if (!list.length) return null;
  const targetT = Date.now() - ageMs;
  let best = null;
  let bestDist = Infinity;
  for (const s of list) {
    const d = Math.abs(s.t - targetT);
    if (d < bestDist) { best = s; bestDist = d; }
  }
  return best;
}

const STRIKE_WINDOW = 5; // ATM ± 5

function _safe(n) { return Number.isFinite(n) ? n : 0; }
function _round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/* ─────────────────────────────────────────────────────────────────────
 * Buyer/Seller weighting per buildup tag.
 *  • Long Buildup    → 80% buyers / 20% sellers  (institutional longs adding)
 *  • Short Buildup   → 20% buyers / 80% sellers  (writers stacking)
 *  • Short Covering  → 65% buyers / 35% sellers  (writers exiting)
 *  • Long Unwinding  → 35% buyers / 65% sellers  (longs exiting)
 *  • Balanced        → 50 / 50
 * These mirror the FRVP engine's weights so V4 stays consistent.
 * ───────────────────────────────────────────────────────────────────── */
const TAG_WEIGHTS = {
  'Long Buildup':   { buy: 0.80, sell: 0.20 },
  'Short Covering': { buy: 0.65, sell: 0.35 },
  'Balanced':       { buy: 0.50, sell: 0.50 },
  'Long Unwinding': { buy: 0.35, sell: 0.65 },
  'Short Buildup':  { buy: 0.20, sell: 0.80 },
};

function classifyBuildup(side, oiChg, priceChg, ltpChg) {
  const oiUp = oiChg > 0;
  const oiDown = oiChg < 0;
  const premUp = ltpChg != null && ltpChg > 0;
  const premDown = ltpChg != null && ltpChg < 0;

  if (premUp || premDown) {
    if (oiUp && premUp)   return 'Long Buildup';
    if (oiUp && premDown) return 'Short Buildup';
    if (oiDown && premUp) return 'Short Covering';
    if (oiDown && premDown) return 'Long Unwinding';
  }
  // fallback: spot direction + side
  const spotUp = (priceChg ?? 0) >= 0;
  if (side === 'CE') {
    if (oiUp && spotUp) return 'Long Buildup';
    if (oiUp && !spotUp) return 'Short Buildup';
    if (oiDown && spotUp) return 'Short Covering';
    if (oiDown && !spotUp) return 'Long Unwinding';
  } else {
    if (oiUp && !spotUp) return 'Long Buildup';
    if (oiUp && spotUp) return 'Short Buildup';
    if (oiDown && !spotUp) return 'Short Covering';
    if (oiDown && spotUp) return 'Long Unwinding';
  }
  return 'Balanced';
}

/* ─────────────────────────────────────────────────────────────────────
 * Per-strike scoring.
 *
 * For each side (CE/PE):
 *   buyersPct  = Σ (vol × tag.buy) / total
 *   sellersPct = 100 − buyersPct
 *   score      = (buyersPct − 50) × 2          // -100..+100
 *
 * dominance:
 *   buyersPct ≥ 65  → BUYERS
 *   buyersPct ≤ 35  → SELLERS
 *   else            → BALANCED
 * ───────────────────────────────────────────────────────────────────── */
function scoreSide(buildup, vol) {
  const w = TAG_WEIGHTS[buildup] || TAG_WEIGHTS.Balanced;
  const buyersPct = w.buy * 100;
  const sellersPct = w.sell * 100;
  return {
    buyersPct: _round(buyersPct, 0),
    sellersPct: _round(sellersPct, 0),
    score: _round((buyersPct - 50) * 2, 0),
    dominance: buyersPct >= 65 ? 'BUYERS' : buyersPct <= 35 ? 'SELLERS' : 'BALANCED',
    weightedVol: _round(vol * w.buy, 0),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Per-strike market impact.
 *
 * Each strike contributes to overall directional bias as follows:
 *   • CE Long Buildup        → BULLISH (call buyers expect upside)
 *   • CE Short Buildup       → BEARISH (writers cap upside)
 *   • CE Short Covering      → BULLISH (writers exiting → squeeze)
 *   • CE Long Unwinding      → BEARISH (longs giving up)
 *   • PE Long Buildup        → BEARISH (put buyers expect downside)
 *   • PE Short Buildup       → BULLISH (writers floor downside)
 *   • PE Short Covering      → BEARISH (writers exiting → flush)
 *   • PE Long Unwinding      → BULLISH (puts giving up)
 * ───────────────────────────────────────────────────────────────────── */
const IMPACT_MAP = {
  'CE|Long Buildup':    'BULLISH',
  'CE|Short Buildup':   'BEARISH',
  'CE|Short Covering':  'BULLISH',
  'CE|Long Unwinding':  'BEARISH',
  'PE|Long Buildup':    'BEARISH',
  'PE|Short Buildup':   'BULLISH',
  'PE|Short Covering':  'BEARISH',
  'PE|Long Unwinding':  'BULLISH',
};

function pickStrengthLabel(score) {
  const a = Math.abs(score);
  if (a >= 75) return 'DOMINANT';
  if (a >= 50) return 'STRONG';
  if (a >= 25) return 'MODERATE';
  return 'WEAK';
}

/**
 * Build the V4 decision payload from a V2 snapshot.
 */
async function getDecision({ symbol = 'NIFTY_50', date = null } = {}) {
  const v2 = await intelV2.getSnapshot({ symbol, date });
  if (!v2 || !v2.ok) {
    return { ok: false, error: 'V2 snapshot unavailable', version: 'v4' };
  }

  const atm = v2.options?.atm ?? null;
  const spot = v2.spot?.ltp ?? 0;
  const spotChange = v2.spot?.changePct ?? 0;
  const vwap = v2.spot?.vwap ?? 0;
  const ladder = Array.isArray(v2.ladder) ? v2.ladder : [];
  const breadth = v2.dashboard?.breadth || {};
  const fEngine = v2.dashboard?.frvpInstitutional?.engine;
  const flowDelta = v2.flow?.delta;
  const futPremium = v2.futures?.premium ?? 0;
  const vix = v2.macro?.vix?.changePct ?? 0;
  const md = v2.dashboard?.marketDirection || null;
  const oiBuildup = v2.dashboard?.oiBuildupAnalysis || null;
  const atmIv = v2.options?.atmIv ?? 0;
  const lotSize = v2.tradingDay?.lotSize || 50;
  const dte = Math.max(0.5, v2.tradingDay?.daysToExpiry ?? 1);

  if (atm == null) {
    return { ok: false, error: 'ATM unresolved', version: 'v4' };
  }

  // Force 100-step grid regardless of the chain's native step. NIFTY ships
  // 50-step strikes but the dashboard shows 100-step only (per project rule),
  // so V4 always picks ATM ± 5 × 100 strikes.
  const step = 100;

  const primaryStrike = Math.round(atm / step) * step;

  // ── Build wall maps from V2's marketDirection (rounded to 100-step) ──
  // Walls = strikes ranked by OI on each side. We map each strike to its
  // tier label ("Immediate Resistance", "Major Support", etc.) and OI.
  const wallMap = new Map();
  const resistances = (md?.resistances || []).slice(0, 6);
  const supports    = (md?.supports || []).slice(0, 6);
  resistances.forEach((r, i) => {
    const k = Math.round(r.strike / step) * step;
    wallMap.set(k, {
      type: 'RESISTANCE',
      tier: r.tier,
      tierIdx: i,
      oi: r.oi,
      oiChange: r.oiChange,
      strength: i === 0 ? 'STRONG' : i <= 2 ? 'MODERATE' : 'WEAK',
    });
  });
  supports.forEach((r, i) => {
    const k = Math.round(r.strike / step) * step;
    if (!wallMap.has(k)) {
      wallMap.set(k, {
        type: 'SUPPORT',
        tier: r.tier,
        tierIdx: i,
        oi: r.oi,
        oiChange: r.oiChange,
        strength: i === 0 ? 'STRONG' : i <= 2 ? 'MODERATE' : 'WEAK',
      });
    }
  });

  // ── Dynamic window — if a major wall sits beyond ATM ± 5, extend up to ±8 ──
  let windowAbove = STRIKE_WINDOW;
  let windowBelow = STRIKE_WINDOW;
  const MAX_WINDOW = 8;
  for (const [k, w] of wallMap.entries()) {
    const offset = Math.round((k - primaryStrike) / step);
    if (w.tierIdx <= 1) { // only top-2 walls trigger expansion
      if (offset > windowAbove)  windowAbove = Math.min(MAX_WINDOW, offset);
      if (offset < -windowBelow) windowBelow = Math.min(MAX_WINDOW, -offset);
    }
  }

  // Build a strike map from the ladder for O(1) lookup.
  const byStrike = new Map(ladder.map(r => [r.strike, r]));

  // ── Per-strike rows for ATM ± dynamic window ────────────────────────
  const strikes = [];
  for (let i = windowAbove; i >= -windowBelow; i--) {
    const strike = primaryStrike + i * step;
    const row = byStrike.get(strike);
    const wall = wallMap.get(strike) || null;
    if (!row) {
      strikes.push({
        strike,
        isAtm: i === 0,
        offset: i,
        ce: { oi: 0, oiChg: 0, ltp: 0, iv: 0, delta: 0, vol: 0, buyersPct: 50, sellersPct: 50, buildup: '—', oiState: '—', dominance: 'BALANCED', score: 0 },
        pe: { oi: 0, oiChg: 0, ltp: 0, iv: 0, delta: 0, vol: 0, buyersPct: 50, sellersPct: 50, buildup: '—', oiState: '—', dominance: 'BALANCED', score: 0 },
        dominantSide: 'BALANCED',
        strength: 'WEAK',
        marketImpact: 'NEUTRAL',
        wall,
        note: wall ? `${wall.type} wall — ${wall.tier}` : 'No data',
      });
      continue;
    }
    const ceBuildup = row.ce?.buildup || classifyBuildup('CE', row.ce?.oiChange, spotChange, null);
    const peBuildup = row.pe?.buildup || classifyBuildup('PE', row.pe?.oiChange, spotChange, null);
    const ceScored = scoreSide(ceBuildup, row.ce?.volume || 0);
    const peScored = scoreSide(peBuildup, row.pe?.volume || 0);

    // OI state — concise label for the change-in-OI direction
    const oiStateOf = (oi, oiChg) => {
      if (!oi || !Number.isFinite(oiChg)) return '—';
      const pct = (oiChg / oi) * 100;
      if (pct >= 50) return 'STRONG ADD';
      if (pct >= 15) return 'ADDING';
      if (pct >= 5) return 'BUILDING';
      if (pct <= -50) return 'STRONG UNWIND';
      if (pct <= -15) return 'UNWINDING';
      if (pct <= -5) return 'EASING';
      return 'STABLE';
    };
    const ceOiState = oiStateOf(row.ce?.oi, row.ce?.oiChange);
    const peOiState = oiStateOf(row.pe?.oi, row.pe?.oiChange);

    // Per-strike market impact: combine CE + PE impact directions.
    const ceImpact = IMPACT_MAP[`CE|${ceBuildup}`] ?? 'NEUTRAL';
    const peImpact = IMPACT_MAP[`PE|${peBuildup}`] ?? 'NEUTRAL';
    const ceScore = ceImpact === 'BULLISH' ? +1 : ceImpact === 'BEARISH' ? -1 : 0;
    const peScore = peImpact === 'BULLISH' ? +1 : peImpact === 'BEARISH' ? -1 : 0;
    const combinedImpact = ceScore + peScore;
    const marketImpact = combinedImpact > 0 ? 'BULLISH' : combinedImpact < 0 ? 'BEARISH' : 'NEUTRAL';

    // Strike-level dominance: which SIDE is dominant
    const ceVol = row.ce?.volume || 0;
    const peVol = row.pe?.volume || 0;
    const ceBuyVol = ceVol * (TAG_WEIGHTS[ceBuildup]?.buy ?? 0.5);
    const peBuyVol = peVol * (TAG_WEIGHTS[peBuildup]?.buy ?? 0.5);
    const totalBuyVol = ceBuyVol + peBuyVol;
    const cePct = totalBuyVol > 0 ? Math.round((ceBuyVol / totalBuyVol) * 100) : 50;
    const dominantSide = cePct >= 60 ? 'CE' : cePct <= 40 ? 'PE' : 'BALANCED';
    const dominanceMagnitude = Math.abs(cePct - 50) * 2;

    // Note — short institutional summary
    const note = (() => {
      if (wall && wall.tierIdx === 0) return `★ ${wall.type === 'RESISTANCE' ? 'TOP RESISTANCE' : 'TOP SUPPORT'}`;
      if (wall) return `${wall.tier}`;
      if (i === 0) return `ATM @ ${primaryStrike}`;
      if (ceBuildup === 'Long Buildup' && peBuildup === 'Short Buildup') return 'Institutions long this strike';
      if (ceBuildup === 'Short Buildup' && peBuildup === 'Long Buildup') return 'Institutions short this strike';
      if (ceBuildup === 'Short Buildup') return 'CE writers active — resistance';
      if (peBuildup === 'Short Buildup') return 'PE writers active — support';
      if (ceBuildup === 'Long Buildup') return 'CE buyers expect upside';
      if (peBuildup === 'Long Buildup') return 'PE buyers expect downside';
      return '—';
    })();

    strikes.push({
      strike,
      isAtm: i === 0,
      offset: i,
      ce: {
        oi: _safe(row.ce?.oi),
        oiChg: _safe(row.ce?.oiChange),
        ltp: _safe(row.ce?.ltp),
        iv: _round(_safe(row.ce?.iv), 2),
        delta: _round(_safe(row.ce?.delta), 3),
        vol: _safe(ceVol),
        buyersPct: ceScored.buyersPct,
        sellersPct: ceScored.sellersPct,
        buildup: ceBuildup,
        oiState: ceOiState,
        dominance: ceScored.dominance,
        score: ceScored.score,
      },
      pe: {
        oi: _safe(row.pe?.oi),
        oiChg: _safe(row.pe?.oiChange),
        ltp: _safe(row.pe?.ltp),
        iv: _round(_safe(row.pe?.iv), 2),
        delta: _round(_safe(row.pe?.delta), 3),
        vol: _safe(peVol),
        buyersPct: peScored.buyersPct,
        sellersPct: peScored.sellersPct,
        buildup: peBuildup,
        oiState: peOiState,
        dominance: peScored.dominance,
        score: peScored.score,
      },
      dominantSide,
      strength: pickStrengthLabel(dominanceMagnitude),
      marketImpact,
      wall,
      note,
    });
  }

  // ── Aggregate overall control ─────────────────────────────────────────
  // Sum directional impact across all 11 strikes (ATM ± 5).
  // BULLISH strike = +1, BEARISH = -1, NEUTRAL = 0
  let bullVotes = 0;
  let bearVotes = 0;
  let bullImpactWeighted = 0;
  let bearImpactWeighted = 0;
  for (const s of strikes) {
    if (s.marketImpact === 'BULLISH') bullVotes++;
    else if (s.marketImpact === 'BEARISH') bearVotes++;
    // Weight by combined CE+PE volume so high-activity strikes count more
    const w = (s.ce.vol + s.pe.vol) || 1;
    if (s.marketImpact === 'BULLISH') bullImpactWeighted += w;
    else if (s.marketImpact === 'BEARISH') bearImpactWeighted += w;
  }
  const totalImpactWeighted = bullImpactWeighted + bearImpactWeighted || 1;
  const cePct = Math.round((bullImpactWeighted / totalImpactWeighted) * 100);
  const pePct = 100 - cePct;
  const score = bullVotes - bearVotes; // -11..+11

  // Direction
  let directionLikely;
  if (score >= 4) directionLikely = 'UP';
  else if (score <= -4) directionLikely = 'DOWN';
  else directionLikely = 'RANGE';

  // Control (overall buyers vs sellers across ALL strikes)
  // sum CE.weightedBuyVol + PE.weightedSellVol (bullish flow) vs the inverse
  let bullishFlow = 0;
  let bearishFlow = 0;
  for (const s of strikes) {
    const ceBuy  = (s.ce.vol * s.ce.buyersPct) / 100;
    const ceSell = (s.ce.vol * s.ce.sellersPct) / 100;
    const peBuy  = (s.pe.vol * s.pe.buyersPct) / 100;
    const peSell = (s.pe.vol * s.pe.sellersPct) / 100;
    bullishFlow += ceBuy + peSell;   // bull = call buyers + put writers
    bearishFlow += ceSell + peBuy;   // bear = call writers + put buyers
  }
  const totalFlow = bullishFlow + bearishFlow || 1;
  const bullishFlowPct = Math.round((bullishFlow / totalFlow) * 100);
  let control;
  if (bullishFlowPct >= 60) control = 'BUYERS';
  else if (bullishFlowPct <= 40) control = 'SELLERS';
  else control = 'NEUTRAL';

  // ─────────────────────────────────────────────────────────────────────
  // V5-GRADE INSTITUTIONAL ENGINES (8 layers, weighted scoring)
  // ─────────────────────────────────────────────────────────────────────
  // Push current snapshot into history BEFORE computing velocities so we
  // can read prev/now consistently from the buffer.
  const oiByStrikeNow = new Map();
  const volByStrikeNow = new Map();
  for (const s of strikes) {
    oiByStrikeNow.set(s.strike, { ce: s.ce.oi, pe: s.pe.oi });
    volByStrikeNow.set(s.strike, { ce: s.ce.vol, pe: s.pe.vol });
  }
  const topRStrike = md?.resistances?.[0]?.strike ?? null;
  const topSStrike = md?.supports?.[0]?.strike ?? null;
  _pushHistory(symbol, {
    t: Date.now(),
    atm, spot, vwap, atmIv,
    oiByStrike: oiByStrikeNow,
    volByStrike: volByStrikeNow,
    topR: topRStrike, topS: topSStrike,
    aboveVwap: spot > vwap,
  });
  const histList = _history.get(symbol) || [];

  // ── Engine 1: OI Velocity (lots / minute) ──────────────────────────
  // Aggregate OI added across the visible window over the last ~5 min.
  const ENG_oiVelocity = (() => {
    const fiveMinAgo = _historyAt(symbol, 5 * 60_000);
    if (!fiveMinAgo) return { value: 0, label: 'NORMAL', score: 0, ageMin: 0 };
    const ageMin = Math.max(1, (Date.now() - fiveMinAgo.t) / 60_000);
    let totalDeltaOi = 0;
    for (const s of strikes) {
      const prev = fiveMinAgo.oiByStrike.get(s.strike);
      if (prev) {
        totalDeltaOi += Math.abs(s.ce.oi - prev.ce) + Math.abs(s.pe.oi - prev.pe);
      }
    }
    const oiPerMin = totalDeltaOi / ageMin;
    // Calibration: 5L/min = aggressive on NIFTY
    const label =
      oiPerMin >= 500_000 ? 'AGGRESSIVE' :
      oiPerMin >= 250_000 ? 'STRONG' :
      oiPerMin >= 100_000 ? 'NORMAL' :
      'QUIET';
    const score =
      label === 'AGGRESSIVE' ? 100 :
      label === 'STRONG'     ? 70 :
      label === 'NORMAL'     ? 40 :
      10;
    return { value: Math.round(oiPerMin), label, score, ageMin: _round(ageMin, 1) };
  })();

  // ── Engine 2: Volume Velocity (current vs trailing average) ────────
  const ENG_volumeVelocity = (() => {
    const totalVolNow = strikes.reduce((s, x) => s + x.ce.vol + x.pe.vol, 0);
    if (histList.length < 5) return { ratio: 1, label: 'NORMAL', score: 40, totalNow: totalVolNow };
    // Sample baseline: median of the prior 20 snapshots in history.
    const baseList = histList.slice(0, -1).slice(-20);
    const baselineVols = baseList.map(h => {
      let t = 0;
      for (const v of h.volByStrike.values()) t += v.ce + v.pe;
      return t;
    }).filter(v => v > 0).sort((a, b) => a - b);
    const median = baselineVols[Math.floor(baselineVols.length / 2)] || 1;
    const ratio = totalVolNow / median;
    const label =
      ratio >= 5 ? 'AGGRESSIVE' :
      ratio >= 3 ? 'INSTITUTIONAL' :
      ratio >= 2 ? 'STRONG' :
      ratio >= 1 ? 'NORMAL' :
      'QUIET';
    const score =
      label === 'AGGRESSIVE'    ? 100 :
      label === 'INSTITUTIONAL' ? 80 :
      label === 'STRONG'        ? 60 :
      label === 'NORMAL'        ? 40 :
      15;
    return { ratio: _round(ratio, 2), label, score, totalNow: totalVolNow };
  })();

  // ── Engine 3: VWAP Acceptance Duration (consecutive minutes) ───────
  const ENG_vwapAcceptance = (() => {
    if (histList.length < 2) return { sideMin: 0, side: spot > vwap ? 'ABOVE' : 'BELOW', score: 30 };
    const aboveNow = spot > vwap;
    let sustainedMin = 0;
    // Walk history backwards while the side stays the same.
    for (let i = histList.length - 1; i >= 0; i--) {
      if (histList[i].aboveVwap === aboveNow) {
        sustainedMin = (Date.now() - histList[i].t) / 60_000;
      } else break;
    }
    const score =
      sustainedMin >= 30 ? 100 :
      sustainedMin >= 15 ? 80 :
      sustainedMin >= 5  ? 50 :
      sustainedMin >= 1  ? 30 :
      10;
    return {
      sideMin: _round(sustainedMin, 1),
      side: aboveNow ? 'ABOVE' : 'BELOW',
      score,
      label:
        sustainedMin >= 30 ? 'STRONG ACCEPTANCE' :
        sustainedMin >= 15 ? 'MODERATE ACCEPTANCE' :
        sustainedMin >= 5  ? 'EARLY ACCEPTANCE' :
        'TESTING',
    };
  })();

  // ── Engine 4: Wall Stability (top resistance + top support persistence) ──
  const ENG_wallStability = (() => {
    let resAge = 0, supAge = 0;
    if (histList.length >= 2 && topRStrike != null) {
      for (let i = histList.length - 1; i >= 0; i--) {
        if (histList[i].topR === topRStrike) {
          resAge = (Date.now() - histList[i].t) / 60_000;
        } else break;
      }
    }
    if (histList.length >= 2 && topSStrike != null) {
      for (let i = histList.length - 1; i >= 0; i--) {
        if (histList[i].topS === topSStrike) {
          supAge = (Date.now() - histList[i].t) / 60_000;
        } else break;
      }
    }
    const avgAge = (resAge + supAge) / 2;
    const score =
      avgAge >= 60 ? 100 :
      avgAge >= 30 ? 80 :
      avgAge >= 15 ? 60 :
      avgAge >= 5  ? 40 :
      20;
    return {
      resistanceAgeMin: _round(resAge, 1),
      supportAgeMin:    _round(supAge, 1),
      avgAgeMin:        _round(avgAge, 1),
      score,
      label:
        avgAge >= 30 ? 'ROCK SOLID' :
        avgAge >= 15 ? 'STABLE' :
        avgAge >= 5  ? 'FORMING' :
        'NEW',
    };
  })();

  // ── Engine 5: Strike Migration (top wall drift) ────────────────────
  const ENG_strikeMigration = (() => {
    const old = _historyAt(symbol, 15 * 60_000);
    if (!old) return { resDirection: 'STABLE', supDirection: 'STABLE', bias: 'NEUTRAL', score: 30 };
    const resDelta = (topRStrike ?? 0) - (old.topR ?? topRStrike ?? 0);
    const supDelta = (topSStrike ?? 0) - (old.topS ?? topSStrike ?? 0);
    // Resistance moving UP = bullish. Support moving UP = bullish.
    // Resistance moving DOWN = bearish. Support moving DOWN = bearish.
    const resDirection = resDelta > 0 ? 'RISING' : resDelta < 0 ? 'FALLING' : 'STABLE';
    const supDirection = supDelta > 0 ? 'RISING' : supDelta < 0 ? 'FALLING' : 'STABLE';
    let bias = 'NEUTRAL', score = 30;
    if (resDelta > 0 && supDelta > 0) { bias = 'BULLISH'; score = 100; }
    else if (resDelta < 0 && supDelta < 0) { bias = 'BEARISH'; score = 100; }
    else if (resDelta > 0 || supDelta > 0) { bias = 'BULLISH'; score = 60; }
    else if (resDelta < 0 || supDelta < 0) { bias = 'BEARISH'; score = 60; }
    return { resDirection, supDirection, bias, score, resDelta, supDelta };
  })();

  // ── Engine 6: IV Trend (expansion vs contraction) ──────────────────
  const ENG_ivTrend = (() => {
    const old = _historyAt(symbol, 10 * 60_000);
    if (!old || !old.atmIv || atmIv === 0) return { ivChangePct: 0, label: 'FLAT', score: 30 };
    const ivChangePct = ((atmIv - old.atmIv) / old.atmIv) * 100;
    const expanding = ivChangePct >= 2;
    const contracting = ivChangePct <= -2;
    // Bullish move + IV expanding = strong; bearish + IV expanding = strong;
    // either + IV contracting = weak (fake move).
    const trendValid = (spot > vwap && expanding) || (spot < vwap && expanding);
    const score =
      trendValid && Math.abs(ivChangePct) >= 5 ? 90 :
      trendValid ? 65 :
      contracting ? 20 :
      40;
    return {
      ivChangePct: _round(ivChangePct, 2),
      label: expanding ? 'EXPANDING' : contracting ? 'CONTRACTING' : 'FLAT',
      score,
    };
  })();

  // ── Engine 7: Gamma Exposure (GEX) ─────────────────────────────────
  // Net GEX = Σ (CE_OI × CE_gamma × LotSize) − Σ (PE_OI × PE_gamma × LotSize)
  // Positive GEX = dealers long gamma → pinning / range bound
  // Negative GEX = dealers short gamma → trending / explosive moves
  // We approximate gamma using delta proxy when greek isn't available.
  const ENG_gex = (() => {
    let netGex = 0;
    let topGexStrike = null;
    let topGexAbs = 0;
    for (const s of strikes) {
      // Approximate gamma from delta — gamma peaks at ATM where |delta| ≈ 0.5.
      // gammaProxy = max(0, 0.5 − |delta − 0.5|)
      const ceGamma = Math.max(0, 0.5 - Math.abs(Math.abs(s.ce.delta) - 0.5));
      const peGamma = Math.max(0, 0.5 - Math.abs(Math.abs(s.pe.delta) - 0.5));
      const ceGex = s.ce.oi * ceGamma * lotSize;
      const peGex = s.pe.oi * peGamma * lotSize;
      const strikeGex = ceGex - peGex;
      netGex += strikeGex;
      if (Math.abs(strikeGex) > topGexAbs) {
        topGexAbs = Math.abs(strikeGex);
        topGexStrike = s.strike;
      }
    }
    const regime = netGex > 0 ? 'POSITIVE_GAMMA' : 'NEGATIVE_GAMMA';
    const interpretation = netGex > 0
      ? 'Dealer gamma long — market pinned / range-bound'
      : 'Dealer gamma short — explosive / trending moves likely';
    // Score: high |GEX| with NEGATIVE_GAMMA = trend-confirming for directional verdicts.
    const absGexNorm = Math.min(1, Math.abs(netGex) / 1e9);
    const score = regime === 'NEGATIVE_GAMMA' ? 50 + absGexNorm * 50 : 50 - absGexNorm * 30;
    return {
      netGex: Math.round(netGex),
      regime,
      topGexStrike,
      score: Math.round(score),
      interpretation,
    };
  })();

  // ── Engine 8: Delta Exposure (DEX) ─────────────────────────────────
  // Σ (OI × Delta × LotSize). Tells you net directional exposure.
  const ENG_dex = (() => {
    let ceDex = 0, peDex = 0;
    for (const s of strikes) {
      ceDex += s.ce.oi * Math.abs(s.ce.delta) * lotSize;
      peDex += s.pe.oi * Math.abs(s.pe.delta) * lotSize;
    }
    const netDex = ceDex - peDex;
    const skew = (ceDex + peDex) > 0 ? (netDex / (ceDex + peDex)) * 100 : 0;
    const bias = skew > 10 ? 'CE_HEAVY' : skew < -10 ? 'PE_HEAVY' : 'BALANCED';
    return {
      ceDex: Math.round(ceDex),
      peDex: Math.round(peDex),
      netDex: Math.round(netDex),
      skewPct: _round(skew, 1),
      bias,
    };
  })();

  // ── Absorption — price moved but OI didn't follow ──────────────────
  const ENG_absorption = (() => {
    const old = _historyAt(symbol, 5 * 60_000);
    if (!old) return { detected: false, score: 0, label: 'NONE' };
    const priceChgPct = old.spot > 0 ? ((spot - old.spot) / old.spot) * 100 : 0;
    let oiChgTotal = 0, volTotal = 0;
    for (const s of strikes) {
      const prev = old.oiByStrike.get(s.strike);
      if (prev) oiChgTotal += Math.abs(s.ce.oi - prev.ce) + Math.abs(s.pe.oi - prev.pe);
      volTotal += s.ce.vol + s.pe.vol;
    }
    // High volume + significant price move + low OI change = absorption
    const significantMove = Math.abs(priceChgPct) >= 0.15;
    const lowOiChange = oiChgTotal / Math.max(1, strikes.reduce((a, s) => a + s.ce.oi + s.pe.oi, 0)) < 0.02;
    const detected = significantMove && volTotal > 0 && lowOiChange;
    return {
      detected,
      priceChgPct: _round(priceChgPct, 2),
      label: detected
        ? (priceChgPct > 0 ? 'SELLER ABSORPTION (caps upside)' : 'BUYER ABSORPTION (floors downside)')
        : 'NONE',
      score: detected ? 75 : 30,
    };
  })();

  // ── Trend Exhaustion ───────────────────────────────────────────────
  const ENG_exhaustion = (() => {
    const old = _historyAt(symbol, 10 * 60_000);
    if (!old) return { detected: false, label: 'NONE', score: 30 };
    const priceUp = spot > old.spot;
    const oldTotalVol = (() => {
      let t = 0;
      for (const v of old.volByStrike.values()) t += v.ce + v.pe;
      return t;
    })();
    const totalVolNow = strikes.reduce((s, x) => s + x.ce.vol + x.pe.vol, 0);
    const volFading = oldTotalVol > 0 && totalVolNow < oldTotalVol * 0.7;
    let oiDirection = 0;
    for (const s of strikes) {
      const prev = old.oiByStrike.get(s.strike);
      if (prev) oiDirection += (s.ce.oi - prev.ce) + (s.pe.oi - prev.pe);
    }
    const oiContracting = oiDirection < 0;
    // Exhaustion: price still going but volume fading OR OI contracting
    const detected = (priceUp && (volFading || oiContracting)) || (!priceUp && (volFading || oiContracting));
    return {
      detected,
      label: detected ? 'WARNING — trend losing fuel' : 'NONE',
      score: detected ? 70 : 25,
      volFading, oiContracting,
    };
  })();

  // ── Put/Call Wall Ratio (top-3 walls by side) ──────────────────────
  const ENG_pcWallRatio = (() => {
    const top3PE = (md?.supports || []).slice(0, 3).reduce((s, r) => s + r.oi, 0);
    const top3CE = (md?.resistances || []).slice(0, 3).reduce((s, r) => s + r.oi, 0);
    const ratio = top3CE > 0 ? top3PE / top3CE : 0;
    return {
      pe: top3PE,
      ce: top3CE,
      ratio: _round(ratio, 2),
      bias:
        ratio >= 1.5 ? 'BULLISH FLOOR' :
        ratio <= 0.66 ? 'BEARISH CEILING' :
        'BALANCED',
    };
  })();

  // ── Expected Move (1 σ from ATM IV) ────────────────────────────────
  const ENG_expectedMove = (() => {
    if (atmIv <= 0 || spot <= 0) return null;
    const sigma = spot * (atmIv / 100) * Math.sqrt(dte / 365);
    const upperBand = spot + sigma;
    const lowerBand = spot - sigma;
    let location = 'WITHIN';
    if (spot >= upperBand) location = 'ABOVE_UPPER';
    else if (spot <= lowerBand) location = 'BELOW_LOWER';
    else if (spot >= upperBand - sigma * 0.2) location = 'NEAR_UPPER';
    else if (spot <= lowerBand + sigma * 0.2) location = 'NEAR_LOWER';
    return {
      sigma: _round(sigma, 1),
      upperBand: _round(upperBand, 1),
      lowerBand: _round(lowerBand, 1),
      location,
    };
  })();

  // ── Multi-Timeframe Confirmation ────────────────────────────────────
  // Check spot vs VWAP at 5/15/30/60-min historical anchor points.
  const ENG_mtfConfirm = (() => {
    const tfs = [5, 15, 30, 60];
    const reads = tfs.map(min => {
      const old = _historyAt(symbol, min * 60_000);
      if (!old) return { tf: min, valid: false, bias: 'NONE' };
      const wasAbove = old.spot > old.vwap;
      const nowAbove = spot > vwap;
      const bias =
        wasAbove && nowAbove ? 'BULLISH' :
        !wasAbove && !nowAbove ? 'BEARISH' :
        'CHANGING';
      return { tf: min, valid: true, bias };
    });
    const bull = reads.filter(r => r.bias === 'BULLISH').length;
    const bear = reads.filter(r => r.bias === 'BEARISH').length;
    const aligned = Math.max(bull, bear);
    return {
      reads,
      bull, bear,
      aligned,
      score: aligned * 25, // 4 aligned = 100, 3 = 75, …
      label:
        aligned === 4 ? 'ALL ALIGNED' :
        aligned === 3 ? 'STRONGLY ALIGNED' :
        aligned === 2 ? 'PARTIAL ALIGNMENT' :
        'CONFLICTING',
    };
  })();

  // ── Institutional Participation (composite of velocity/walls/IV) ──
  const ENG_instParticipation = (() => {
    const composite = (
      ENG_oiVelocity.score   * 0.30 +
      ENG_volumeVelocity.score * 0.30 +
      ENG_wallStability.score  * 0.20 +
      ENG_ivTrend.score        * 0.20
    );
    return {
      score: Math.round(composite),
      label:
        composite >= 80 ? 'EXTREME' :
        composite >= 60 ? 'HIGH' :
        composite >= 40 ? 'MODERATE' :
        'LOW',
    };
  })();

  // ─────────────────────────────────────────────────────────────────────
  // WEIGHTED SCORING — replaces simple confirms++ counter.
  // Each engine outputs a 0..100 directional/aligned score, then we
  // multiply by its institutional weight to get the final confidence.
  // ─────────────────────────────────────────────────────────────────────
  const accAbove = !!fEngine?.acceptance?.acceptedAboveVAH;
  const accBelow = !!fEngine?.acceptance?.acceptedBelowVAL;

  // Direction-aligned helper — flips engine's score sign based on whether
  // the engine's bias matches the current control. Returns +ve when aligned.
  const aligned = (engineBias, control) => {
    if (control === 'NEUTRAL') return 0;
    const bullish = engineBias === 'BULLISH' || engineBias === 'BUYERS' || engineBias === 'CE_HEAVY' || engineBias === 'BULLISH FLOOR';
    const bearish = engineBias === 'BEARISH' || engineBias === 'SELLERS' || engineBias === 'PE_HEAVY' || engineBias === 'BEARISH CEILING';
    if (control === 'BUYERS' && bullish) return 1;
    if (control === 'SELLERS' && bearish) return 1;
    if (control === 'BUYERS' && bearish) return -0.5;
    if (control === 'SELLERS' && bullish) return -0.5;
    return 0;
  };

  // First pass — compute control / direction the same way we always have
  // (using flow vol + vote tally), then refine confidence using engines.

  // Confidence components (each weighted, total 100) — we'll multiply each
  // by an alignment factor so misaligned engines penalise the score.
  const components = {
    gex:           { weight: 20, score: ENG_gex.score, aligned: 1 }, // GEX is regime-agnostic
    oiVelocity:    { weight: 15, score: ENG_oiVelocity.score, aligned: 1 },
    volumeVel:     { weight: 15, score: ENG_volumeVelocity.score, aligned: 1 },
    vwapAccept:    { weight: 10, score: ENG_vwapAcceptance.score, aligned: aligned(ENG_vwapAcceptance.side === 'ABOVE' ? 'BULLISH' : 'BEARISH', control) },
    strikeMig:     { weight: 10, score: ENG_strikeMigration.score, aligned: aligned(ENG_strikeMigration.bias, control) },
    wallStability: { weight: 10, score: ENG_wallStability.score, aligned: 1 },
    ivExpansion:   { weight: 10, score: ENG_ivTrend.score, aligned: 1 },
    frvpAccept:    { weight: 10, score: (accAbove || accBelow) ? 80 : 30,
      aligned: (control === 'BUYERS' && accAbove) || (control === 'SELLERS' && accBelow) ? 1 : 0 },
  };

  // Composite: Σ (component.score × weight × aligned-factor) / Σ weights
  let weightedNum = 0;
  let weightedDen = 0;
  for (const k of Object.keys(components)) {
    const c = components[k];
    const factor = Math.max(0.3, c.aligned); // never zero out a high-weight engine entirely
    weightedNum += c.score * c.weight * factor;
    weightedDen += c.weight * 100;
  }
  const compositeConfidence = Math.min(95, Math.max(20, Math.round((weightedNum / weightedDen) * 100)));

  // Trap penalties — if absorption or exhaustion detected, dock 10-15 pts
  let confidence = compositeConfidence;
  const trapBlockers = [];
  if (ENG_absorption.detected) { confidence -= 12; trapBlockers.push(ENG_absorption.label); }
  if (ENG_exhaustion.detected) { confidence -= 8; trapBlockers.push(ENG_exhaustion.label); }
  // Multi-TF disagreement penalty
  if (ENG_mtfConfirm.aligned <= 1) { confidence -= 10; trapBlockers.push(`MTF conflicting (${ENG_mtfConfirm.bull}↑/${ENG_mtfConfirm.bear}↓)`); }
  confidence = Math.max(15, Math.min(95, confidence));
  const grade =
    confidence >= 90 ? 'A+' :
    confidence >= 80 ? 'A' :
    confidence >= 70 ? 'B' :
    confidence >= 55 ? 'C' :
    'D';
  const conviction =
    confidence >= 80 ? 'HIGH' :
    confidence >= 60 ? 'MEDIUM' :
    confidence >= 45 ? 'LOW' :
    'AVOID';

  // Verdict
  let verdict;
  if (control === 'BUYERS' && directionLikely !== 'RANGE' && conviction !== 'AVOID') verdict = 'BUY CE';
  else if (control === 'SELLERS' && directionLikely !== 'RANGE' && conviction !== 'AVOID') verdict = 'BUY PE';
  else verdict = 'WAIT';

  // Reasons
  const reasons = [];
  reasons.push(`${bullVotes} bullish strikes vs ${bearVotes} bearish (out of ${strikes.length})`);
  reasons.push(spot > vwap ? `Spot above VWAP (+${(spot - vwap).toFixed(1)})` : `Spot below VWAP (${(spot - vwap).toFixed(1)})`);
  // V5 engine highlights — surface the loudest engine results
  if (ENG_oiVelocity.label !== 'NORMAL' && ENG_oiVelocity.label !== 'QUIET') {
    reasons.push(`OI velocity ${ENG_oiVelocity.label.toLowerCase()} (${ENG_oiVelocity.value}/min)`);
  }
  if (ENG_volumeVelocity.label === 'INSTITUTIONAL' || ENG_volumeVelocity.label === 'AGGRESSIVE') {
    reasons.push(`Volume ${ENG_volumeVelocity.ratio}× baseline (${ENG_volumeVelocity.label.toLowerCase()})`);
  }
  if (ENG_vwapAcceptance.sideMin >= 15) {
    reasons.push(`${ENG_vwapAcceptance.sideMin}m ${ENG_vwapAcceptance.side.toLowerCase()} VWAP — ${ENG_vwapAcceptance.label.toLowerCase()}`);
  }
  if (ENG_strikeMigration.bias !== 'NEUTRAL') {
    reasons.push(`Walls migrating ${ENG_strikeMigration.bias.toLowerCase()} (R ${ENG_strikeMigration.resDirection.toLowerCase()}, S ${ENG_strikeMigration.supDirection.toLowerCase()})`);
  }
  if (ENG_gex.regime === 'NEGATIVE_GAMMA') {
    reasons.push('Negative gamma regime — trending moves likely');
  } else {
    reasons.push('Positive gamma regime — pinning likely');
  }
  if (ENG_mtfConfirm.aligned >= 3) {
    reasons.push(`MTF ${ENG_mtfConfirm.label.toLowerCase()} (${ENG_mtfConfirm.bull}↑/${ENG_mtfConfirm.bear}↓)`);
  }
  if (flowDelta?.deltaPct != null) {
    reasons.push(`Delta ${flowDelta.deltaPct >= 0 ? '+' : ''}${flowDelta.deltaPct.toFixed(1)}%`);
  }
  if (futPremium != null) {
    reasons.push(`Futures ${futPremium >= 0 ? 'premium +' : 'discount '}${futPremium.toFixed(1)}`);
  }
  if (accAbove) reasons.push('Accepted above VAH');
  if (accBelow) reasons.push('Accepted below VAL');
  if (breadth.advancePct != null) {
    reasons.push(`Breadth ${breadth.advancePct}% advancing`);
  }

  // Best strike — strike with strongest aligned dominance + matching market impact
  const bestStrike = (() => {
    const candidates = strikes
      .filter(s => {
        if (verdict === 'BUY CE') return s.marketImpact === 'BULLISH';
        if (verdict === 'BUY PE') return s.marketImpact === 'BEARISH';
        return s.dominantSide !== 'BALANCED';
      })
      .map(s => {
        const score = (s.ce.vol + s.pe.vol) * (1 + (s.dominantSide !== 'BALANCED' ? 0.3 : 0));
        const side = verdict === 'BUY CE' ? 'CE' : verdict === 'BUY PE' ? 'PE' : s.dominantSide;
        return { strike: s.strike, side, score: Math.round(score), reason: s.note };
      })
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  })();

  // Most-volume strike across the window
  const mostVolume = (() => {
    let best = null;
    for (const s of strikes) {
      const tot = s.ce.vol + s.pe.vol;
      if (!best || tot > best.volume) best = { strike: s.strike, volume: tot };
    }
    return best;
  })();

  // ── CE / PE PRESSURE GAUGE ─────────────────────────────────────────
  // Aggregate gauge from 0..100 on each side. 100 = max bullish (CE) /
  // bearish (PE) push. Both can be high simultaneously when volatility
  // expands on both sides.
  //
  //   cePressure = bullishFlow / totalFlow * 100
  //   pePressure = bearishFlow / totalFlow * 100
  //   tilt       = cePressure - pePressure  (-100..+100)
  //
  // Plus an "intensity" reading driven by total OI change in the window
  // — high intensity = institutions actively positioning, low = quiet.
  const cePressure = bullishFlowPct;
  const pePressure = 100 - bullishFlowPct;
  const tilt = cePressure - pePressure;
  const totalOiChg = strikes.reduce((s, x) => s + Math.abs(x.ce.oiChg) + Math.abs(x.pe.oiChg), 0);
  const totalOi = strikes.reduce((s, x) => s + x.ce.oi + x.pe.oi, 0);
  const oiActivity = totalOi > 0 ? (totalOiChg / totalOi) * 100 : 0;
  const intensity =
    oiActivity >= 30 ? 'EXTREME' :
    oiActivity >= 15 ? 'HIGH' :
    oiActivity >= 7  ? 'MODERATE' :
    'LOW';

  // ── OI TREND ANALYSIS — separate from per-strike buildup ──────────
  // Aggregate change-in-OI across CE vs PE within the visible window.
  //   ceOiAdded  = sum of CE oiChg where oiChg > 0
  //   peOiAdded  = sum of PE oiChg where oiChg > 0
  //   bias       = whichever side added more OI today
  //
  // Combined with price direction (vs prior close) this maps cleanly to
  // the four-quadrant institutional narrative:
  //   • CE OI ↑ + Price ↓ = CE WRITERS DOMINANT  (bearish)
  //   • PE OI ↑ + Price ↑ = PE WRITERS DOMINANT  (bullish)
  //   • CE OI ↑ + Price ↑ = CE BUYERS DOMINANT   (bullish)
  //   • PE OI ↑ + Price ↓ = PE BUYERS DOMINANT   (bearish)
  let ceOiAdded = 0, ceOiUnwind = 0;
  let peOiAdded = 0, peOiUnwind = 0;
  for (const s of strikes) {
    if (s.ce.oiChg > 0) ceOiAdded += s.ce.oiChg; else ceOiUnwind += -s.ce.oiChg;
    if (s.pe.oiChg > 0) peOiAdded += s.pe.oiChg; else peOiUnwind += -s.pe.oiChg;
  }
  const priceUp = (v2.spot?.changePct ?? 0) >= 0;
  const oiTrendNarrative = (() => {
    if (ceOiAdded > peOiAdded * 1.2) {
      return priceUp ? 'CE BUYERS DOMINANT' : 'CE WRITERS DOMINANT';
    }
    if (peOiAdded > ceOiAdded * 1.2) {
      return priceUp ? 'PE WRITERS DOMINANT' : 'PE BUYERS DOMINANT';
    }
    return 'BALANCED OI BUILD';
  })();
  const oiTrendBias = (() => {
    if (oiTrendNarrative.includes('CE BUYERS') || oiTrendNarrative.includes('PE WRITERS')) return 'BULLISH';
    if (oiTrendNarrative.includes('CE WRITERS') || oiTrendNarrative.includes('PE BUYERS')) return 'BEARISH';
    return 'NEUTRAL';
  })();

  // ── SUPPORT / RESISTANCE summary (top wall on each side, within window) ──
  const inWindow = new Set(strikes.map(s => s.strike));
  const topResistance = (() => {
    for (const r of resistances) {
      const k = Math.round(r.strike / step) * step;
      if (inWindow.has(k)) {
        return {
          strike: k, tier: r.tier, oi: r.oi, oiChange: r.oiChange,
          strength: r.tier.toLowerCase().includes('immediate') ? 'STRONG'
            : r.tier.toLowerCase().includes('strong') || r.tier.toLowerCase().includes('major') ? 'MODERATE'
            : 'WEAK',
        };
      }
    }
    return null;
  })();
  const topSupport = (() => {
    for (const r of supports) {
      const k = Math.round(r.strike / step) * step;
      if (inWindow.has(k)) {
        return {
          strike: k, tier: r.tier, oi: r.oi, oiChange: r.oiChange,
          strength: r.tier.toLowerCase().includes('immediate') ? 'STRONG'
            : r.tier.toLowerCase().includes('strong') || r.tier.toLowerCase().includes('major') ? 'MODERATE'
            : 'WEAK',
        };
      }
    }
    return null;
  })();

  return {
    ok: true,
    version: 'v4',
    symbol: v2.symbol,
    date: v2.date,
    isToday: v2.isToday,
    at: Date.now(),
    spotPrice: _round(spot, 2),
    vwap: _round(vwap, 2),
    futPremium: _round(futPremium, 2),
    vix: v2.macro?.vix?.price ?? null,
    atm,
    primaryStrike,
    step,
    window: { above: windowAbove, below: windowBelow, expanded: windowAbove > STRIKE_WINDOW || windowBelow > STRIKE_WINDOW },
    overall: {
      control,
      directionLikely,
      bullVotes,
      bearVotes,
      cePct,
      pePct,
      bullishFlowPct,
      score,
      confidence,
      grade,
      conviction,
      verdict,
      reasons: reasons.slice(0, 8),
    },
    pressure: {
      cePressure,                                  // 0..100
      pePressure,                                  // 0..100
      tilt,                                        // -100..+100 (positive = bullish)
      tiltLabel:
        tilt >= 40 ? 'STRONG BULLISH' :
        tilt >= 15 ? 'BULLISH' :
        tilt <= -40 ? 'STRONG BEARISH' :
        tilt <= -15 ? 'BEARISH' :
        'BALANCED',
      intensity,                                   // LOW | MODERATE | HIGH | EXTREME
      intensityPct: _round(oiActivity, 1),
    },
    oiTrend: {
      ceOiAdded:  _round(ceOiAdded, 0),
      ceOiUnwind: _round(ceOiUnwind, 0),
      peOiAdded:  _round(peOiAdded, 0),
      peOiUnwind: _round(peOiUnwind, 0),
      ceShare:    Math.round((ceOiAdded / Math.max(1, ceOiAdded + peOiAdded)) * 100),
      peShare:    Math.round((peOiAdded / Math.max(1, ceOiAdded + peOiAdded)) * 100),
      narrative:  oiTrendNarrative,
      bias:       oiTrendBias,
      priceDirection: priceUp ? 'UP' : 'DOWN',
    },
    supportResistance: {
      topResistance,
      topSupport,
      walls: Array.from(wallMap.entries()).map(([k, w]) => ({ strike: k, ...w })),
    },
    breadth: {
      advancing: breadth?.advancing ?? null,
      declining: breadth?.declining ?? null,
      advancePct: breadth?.advancePct ?? null,
    },
    // ── V5-grade institutional engines ────────────────────────────────
    engines: {
      oiVelocity:        ENG_oiVelocity,
      volumeVelocity:    ENG_volumeVelocity,
      vwapAcceptance:    ENG_vwapAcceptance,
      wallStability:     ENG_wallStability,
      strikeMigration:   ENG_strikeMigration,
      ivTrend:           ENG_ivTrend,
      gex:               ENG_gex,
      dex:               ENG_dex,
      absorption:        ENG_absorption,
      exhaustion:        ENG_exhaustion,
      pcWallRatio:       ENG_pcWallRatio,
      expectedMove:      ENG_expectedMove,
      mtfConfirm:        ENG_mtfConfirm,
      instParticipation: ENG_instParticipation,
    },
    weights: components,
    trapBlockers,
    bestStrike,
    mostVolume,
    strikes,
  };
}

module.exports = { getDecision };
