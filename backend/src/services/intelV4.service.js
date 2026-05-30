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

  // Confidence — # of confirming dimensions
  let confirms = 0;
  if (control !== 'NEUTRAL') confirms++;
  if (directionLikely !== 'RANGE') confirms++;
  // VWAP confirmation
  if (control === 'BUYERS' && spot > vwap) confirms++;
  if (control === 'SELLERS' && spot < vwap) confirms++;
  // FRVP acceptance confirmation
  const accAbove = !!fEngine?.acceptance?.acceptedAboveVAH;
  const accBelow = !!fEngine?.acceptance?.acceptedBelowVAL;
  if (control === 'BUYERS' && accAbove) confirms++;
  if (control === 'SELLERS' && accBelow) confirms++;
  // Delta alignment
  if (flowDelta?.bias === 'bullish' && control === 'BUYERS') confirms++;
  if (flowDelta?.bias === 'bearish' && control === 'SELLERS') confirms++;
  // Futures basis
  if (futPremium >= 10 && control === 'BUYERS') confirms++;
  if (futPremium <= -10 && control === 'SELLERS') confirms++;
  // VIX
  if (vix < -1 && control === 'BUYERS') confirms++;
  if (vix > 1 && control === 'SELLERS') confirms++;

  const confidence = Math.min(95, Math.round(50 + confirms * 8));
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
      reasons: reasons.slice(0, 6),
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
    bestStrike,
    mostVolume,
    strikes,
  };
}

module.exports = { getDecision };
