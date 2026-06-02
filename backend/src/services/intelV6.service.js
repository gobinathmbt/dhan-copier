/* ─────────────────────────────────────────────────────────────────────
 * INTEL V6 — PREMIUM INTELLIGENCE ENGINE (Option Greeks Engine)
 * ========================================================================
 *
 * Sits one layer BELOW the V5 Option-Buyer Verdict.
 *
 *   V5 (Market Structure)  →  WHERE is the market leaning?
 *   V6 (Premium Behaviour) →  WILL the premium actually EXPAND or DECAY?
 *
 * Direction ≠ Profit.  Premium Expansion = Profit.
 *
 * Five engines feed ONE Premium Power Score and an Option-Buyer Action Plan:
 *
 *   1. DELTA  ENGINE — direction conviction      (Real Bull / Real Bear / Fake)
 *   2. GAMMA  ENGINE — acceleration detector     (Explosive / Normal / Slow)
 *   3. THETA  ENGINE — time-decay killer         (Decay Fast / Medium / Slow)
 *   4. VEGA   ENGINE — IV expansion detector     (IV Expanding / Stable / Crush)
 *   5. STRIKE DOMINANCE — ATM ± 5 buyer-favour map
 *
 * Plus context: Futures Premium, Breadth, Session, Risk/Reward.
 *
 *   PEP Score = (DeltaScore × 35%) + (GammaScore × 30%)
 *             + (VegaScore × 20%)  + (ThetaScore × 15%)
 *
 * Endpoint: GET /api/intel-v6/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelV2 = require('./intelV2.service');

function _safe(n, d = 0) { const x = Number(n); return Number.isFinite(x) ? x : d; }
function _round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function _clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* ─── Per-symbol Greeks history — drives RISING / FALLING / EXPANDING ─── */
const _greekHistory = new Map(); // symbol → [{ t, delta, gamma, theta, vega, iv, spot }]
const GREEK_HISTORY_MAX = 80;
const GREEK_TTL_MS = 30 * 60_000;

function _pushGreekHistory(symbol, sample) {
  const list = _greekHistory.get(symbol) || [];
  list.push({ t: Date.now(), ...sample });
  const cutoff = Date.now() - GREEK_TTL_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  while (list.length > GREEK_HISTORY_MAX) list.shift();
  _greekHistory.set(symbol, list);
  return list;
}

/**
 * Trend of a numeric series: compares the average of the oldest third to
 * the newest third. `eps` is the minimum absolute drift that counts as a
 * real move (otherwise FLAT). `useAbs` compares magnitudes (for gamma/vega).
 */
function _trend(list, key, eps, useAbs = false) {
  if (!Array.isArray(list) || list.length < 4) return { dir: 'FLAT', drift: 0 };
  const vals = list.map(s => (useAbs ? Math.abs(_safe(s[key])) : _safe(s[key]))).filter(Number.isFinite);
  if (vals.length < 4) return { dir: 'FLAT', drift: 0 };
  const n = vals.length;
  const seg = Math.max(1, Math.floor(n / 3));
  const oldAvg = vals.slice(0, seg).reduce((a, b) => a + b, 0) / seg;
  const newAvg = vals.slice(-seg).reduce((a, b) => a + b, 0) / seg;
  const drift = newAvg - oldAvg;
  if (drift >= eps) return { dir: 'RISING', drift: _round(drift, 5) };
  if (drift <= -eps) return { dir: 'FALLING', drift: _round(drift, 5) };
  return { dir: 'FLAT', drift: _round(drift, 5) };
}

/* ═════════════════════════════════════════════════════════════════════
 * MAIN DECISION
 * ═════════════════════════════════════════════════════════════════════ */
async function getDecision({ symbol = 'NIFTY_50', date = null } = {}) {
  const v2 = await intelV2.getSnapshot({ symbol, date });
  if (!v2 || !v2.ok) {
    return { ok: false, error: 'V2 snapshot unavailable', version: 'v6' };
  }

  const spot = _safe(v2.spot?.ltp);
  const vwap = _safe(v2.spot?.vwap);
  const atm = v2.options?.atm ?? null;
  const futPremium = _safe(v2.futures?.premium);
  const overallBias = v2.bias?.overallBias || 'neutral';     // bullish | bearish | neutral
  const cePct = _safe(v2.verdict?.cePct, 50);
  const ladder = Array.isArray(v2.ladder) ? v2.ladder : [];
  const oiHistogram = v2.dashboard?.oiHistogram || [];
  const breadth = v2.dashboard?.breadth || {};
  const ivAnalytics = v2.dashboard?.ivAnalytics || {};
  const atmCall = v2.options?.atmCall || null;
  const atmPut = v2.options?.atmPut || null;
  const atmIv = _safe(v2.options?.atmIv);

  // ── Active side: option buyers play the side structure favours ───────
  const structureBias =
    overallBias === 'bullish' ? 'BULLISH' :
    overallBias === 'bearish' ? 'BEARISH' :
    cePct >= 55 ? 'BULLISH' : cePct <= 45 ? 'BEARISH' : 'NEUTRAL';
  const activeSide = structureBias === 'BEARISH' ? 'PE' : 'CE'; // neutral defaults to CE view

  // ── Pull ATM greeks for the active side from the ladder (richest src) ─
  const atmRow = ladder.find(r => r.isAtm) || ladder.find(r => r.strike === atm) || null;
  const legFor = (row, side) => (side === 'CE' ? row?.ce : row?.pe) || {};
  const atmLeg = legFor(atmRow, activeSide);

  // Aggregate greeks across ATM ± 3 strikes on the active side (more stable
  // than a single strike, and reflects the tradeable band).
  const band = ladder.filter(r => atm != null && Math.abs(r.strike - atm) <= 200);
  const agg = { delta: [], gamma: [], theta: [], vega: [], iv: [] };
  for (const r of band) {
    const leg = legFor(r, activeSide);
    if (Number.isFinite(leg.delta)) agg.delta.push(leg.delta);
    if (Number.isFinite(leg.gamma)) agg.gamma.push(leg.gamma);
    if (Number.isFinite(leg.theta)) agg.theta.push(leg.theta);
    if (Number.isFinite(leg.vega)) agg.vega.push(leg.vega);
    if (Number.isFinite(leg.iv) && leg.iv > 0) agg.iv.push(leg.iv);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  // Primary numeric readings (prefer ATM leg, fall back to band averages)
  const deltaVal = Math.abs(_safe(atmLeg.delta, avg(agg.delta)));
  const gammaVal = _safe(atmLeg.gamma, avg(agg.gamma));
  const thetaVal = _safe(atmLeg.theta, avg(agg.theta));            // negative
  const vegaVal = _safe(atmLeg.vega, avg(agg.vega));
  const ivVal = _safe(atmLeg.iv, atmIv || avg(agg.iv));

  // ── Push history & derive trends ─────────────────────────────────────
  const hist = _pushGreekHistory(symbol, {
    delta: deltaVal, gamma: gammaVal, theta: thetaVal, vega: vegaVal, iv: ivVal, spot,
  });
  const deltaTrend = _trend(hist, 'delta', 0.01);
  const gammaTrend = _trend(hist, 'gamma', 0.00005, true);
  const thetaTrend = _trend(hist, 'theta', 0.5, true);            // magnitude of decay
  const vegaTrend = _trend(hist, 'vega', 0.15, true);
  const ivTrend = _trend(hist, 'iv', 0.15);
  const spotTrend = _trend(hist, 'spot', Math.max(2, spot * 0.0003));

  // ═══════════════ 1. DELTA ENGINE ═══════════════════════════════════
  // Direction conviction.  >0.60 strong · 0.40-0.60 moderate · <0.40 weak.
  const deltaLevel = deltaVal >= 0.60 ? 'STRONG' : deltaVal >= 0.40 ? 'MODERATE' : 'WEAK';
  const deltaRising = deltaTrend.dir === 'RISING';
  const spotRising = spotTrend.dir === 'RISING';
  const spotFalling = spotTrend.dir === 'FALLING';
  // Real vs fake move (delta vs spot agreement on the active side)
  let deltaVerdict, deltaQuality;
  if (activeSide === 'CE') {
    if (deltaRising && (spotRising || spotTrend.dir === 'FLAT')) { deltaVerdict = 'REAL BULL MOVE'; deltaQuality = 'REAL'; }
    else if (!deltaRising && spotRising) { deltaVerdict = 'FAKE RALLY'; deltaQuality = 'FAKE'; }
    else { deltaVerdict = deltaLevel === 'STRONG' ? 'REAL BULL MOVE' : 'BULL BUILDING'; deltaQuality = deltaLevel === 'STRONG' ? 'REAL' : 'BUILDING'; }
  } else {
    if (deltaRising && (spotFalling || spotTrend.dir === 'FLAT')) { deltaVerdict = 'REAL BEAR MOVE'; deltaQuality = 'REAL'; }
    else if (!deltaRising && spotFalling) { deltaVerdict = 'FAKE SELLOFF'; deltaQuality = 'FAKE'; }
    else { deltaVerdict = deltaLevel === 'STRONG' ? 'REAL BEAR MOVE' : 'BEAR BUILDING'; deltaQuality = deltaLevel === 'STRONG' ? 'REAL' : 'BUILDING'; }
  }
  const deltaScore = _clamp(
    (deltaVal >= 0.60 ? 85 : deltaVal >= 0.50 ? 72 : deltaVal >= 0.40 ? 58 : deltaVal >= 0.30 ? 42 : 28)
    + (deltaRising ? 12 : deltaTrend.dir === 'FALLING' ? -12 : 0)
    + (deltaQuality === 'REAL' ? 5 : deltaQuality === 'FAKE' ? -15 : 0),
    0, 100);

  // ═══════════════ 2. GAMMA ENGINE ═══════════════════════════════════
  // Acceleration.  Gamma scales inversely with price; normalise by spot so
  // NIFTY (~0.001) and SENSEX (~0.0003) share thresholds.  γ-index = γ·spot.
  const gammaIndex = _round(Math.abs(gammaVal) * (spot || 1), 3);
  const gammaLevel = gammaIndex >= 20 ? 'HIGH' : gammaIndex >= 8 ? 'MEDIUM' : 'LOW';
  const gammaVerdict = gammaLevel === 'HIGH' ? 'EXPLOSIVE MOVE' : gammaLevel === 'MEDIUM' ? 'NORMAL MOVE' : 'SLOW MOVE';
  const gammaScore = _clamp(
    (gammaLevel === 'HIGH' ? 85 : gammaLevel === 'MEDIUM' ? 60 : 35)
    + (gammaTrend.dir === 'RISING' ? 10 : gammaTrend.dir === 'FALLING' ? -8 : 0),
    0, 100);

  // ═══════════════ 3. THETA ENGINE ═══════════════════════════════════
  // Time decay.  |theta| > 15 fast · 8-15 medium · < 8 slow.  Buyers want LOW.
  const thetaAbs = Math.abs(thetaVal);
  const thetaLevel = thetaAbs > 15 ? 'FAST' : thetaAbs >= 8 ? 'MEDIUM' : 'SLOW';
  const thetaVerdict = thetaLevel === 'FAST' ? 'DECAY FAST' : thetaLevel === 'MEDIUM' ? 'DECAY MEDIUM' : 'DECAY SLOW';
  // Is delta gain beating theta loss?  (Real edge for buyers.)
  const decayWinning = deltaQuality === 'REAL' && (deltaRising || deltaLevel === 'STRONG') && thetaLevel !== 'FAST';
  // Score: low decay = high score (it's a cost), but expansion offsets it.
  const thetaScore = _clamp(
    (thetaLevel === 'SLOW' ? 80 : thetaLevel === 'MEDIUM' ? 58 : 32)
    + (decayWinning ? 12 : 0)
    + (thetaTrend.dir === 'RISING' ? -6 : 0),
    0, 100);

  // ═══════════════ 4. VEGA ENGINE ════════════════════════════════════
  // IV expansion.  Use vega magnitude + IV trend.  Rising IV = premium expand.
  const vegaState = ivTrend.dir === 'RISING' ? 'EXPANDING' : ivTrend.dir === 'FALLING' ? 'CRUSH' : 'STABLE';
  const vegaLevel = vegaState === 'EXPANDING' ? 'RISING' : vegaState === 'CRUSH' ? 'FALLING' : 'FLAT';
  const vegaVerdict = vegaState === 'EXPANDING' ? 'IV EXPANDING' : vegaState === 'CRUSH' ? 'IV CRUSH RISK' : 'IV STABLE';
  const vegaScore = _clamp(
    (vegaState === 'EXPANDING' ? 82 : vegaState === 'STABLE' ? 55 : 28)
    + (ivVal >= 12 && ivVal <= 30 ? 8 : ivVal < 8 ? -12 : 0),
    0, 100);

  // ═══════════════ PREMIUM POWER SCORE (PEP) ═════════════════════════
  const pepScore = Math.round(
    deltaScore * 0.35 + gammaScore * 0.30 + vegaScore * 0.20 + thetaScore * 0.15
  );
  const premiumState =
    pepScore >= 90 ? 'NUCLEAR EXPANSION' :
    pepScore >= 75 ? 'STRONG EXPANSION' :
    pepScore >= 60 ? 'TRADEABLE' :
    pepScore >= 40 ? 'LOW EDGE' :
    'AVOID';
  const buyerEdge = pepScore >= 60 ? 'YES' : pepScore >= 45 ? 'WEAK' : 'NO';
  const premiumBehaviour = pepScore >= 60 ? 'EXPANDING' : pepScore >= 45 ? 'NEUTRAL' : 'DECAYING';

  // ═══════════════ GREEKS MOMENTUM MATRIX ════════════════════════════
  // Second weighting (Delta 40 · Gamma 30 · Vega 20 · Theta 10) — the
  // "matrix" momentum bar shown above strike dominance.
  const momentumScore = Math.round(
    deltaScore * 0.40 + gammaScore * 0.30 + vegaScore * 0.20 + thetaScore * 0.10
  );

  // ═══════════════ 5. STRIKE DOMINANCE — ATM ± 5 ═════════════════════
  const dominance = _strikeDominance(ladder, oiHistogram, atm, spot, 5);

  // ═══════════════ FUTURES & BREADTH ═════════════════════════════════
  const advancing = _safe(breadth.advancing);
  const declining = _safe(breadth.declining);
  const advPct = _safe(breadth.advancePct, advancing + declining > 0 ? Math.round((advancing / (advancing + declining)) * 100) : 50);
  const decPct = _safe(breadth.declinePct, 100 - advPct);
  const breadthLabel = advPct >= 58 ? 'BULLISH BREADTH' : advPct <= 42 ? 'BEARISH BREADTH' : 'MIXED BREADTH';
  const premiumState_fut = futPremium > 5 ? 'PREMIUM POSITIVE' : futPremium < -5 ? 'PREMIUM NEGATIVE' : 'PREMIUM FLAT';
  const sentiment =
    (futPremium > 0 && advPct >= 55) || advPct >= 62 ? 'BULLISH' :
    (futPremium < 0 && advPct <= 45) || advPct <= 38 ? 'BEARISH' :
    'NEUTRAL';

  // ═══════════════ SESSION & RISK ════════════════════════════════════
  const session = _session(v2.isToday);
  const volatility =
    (ivAnalytics?.ivRank?.label) ? String(ivAnalytics.ivRank.label) :
    ivVal > 28 ? 'HIGH' : ivVal >= 14 ? 'MEDIUM' : 'LOW';
  const riskLevel =
    structureBias === 'NEUTRAL' ? 'HIGH' :
    pepScore < 45 ? 'HIGH' :
    pepScore < 60 ? 'MEDIUM' :
    deltaQuality === 'FAKE' ? 'MEDIUM' :
    'LOW';
  const rewardPotential =
    pepScore >= 75 && deltaQuality === 'REAL' ? 'HIGH' :
    pepScore >= 60 ? 'MEDIUM' :
    'LOW';

  // ═══════════════ FINAL VERDICT + ACTION PLAN ═══════════════════════
  const dominanceBias = dominance.bias;          // BULLISH | BEARISH | NEUTRAL
  const aligned =
    structureBias !== 'NEUTRAL' &&
    structureBias === dominanceBias &&
    premiumBehaviour === 'EXPANDING';

  let action, marketBias, headline;
  if (structureBias === 'BULLISH' && premiumBehaviour !== 'DECAYING' && dominanceBias !== 'BEARISH') {
    action = 'BUY CE'; marketBias = 'BULLISH';
    headline = aligned ? 'HIGH PROBABILITY UPSIDE MOVE' : 'UPSIDE BIAS — CONFIRM PREMIUM';
  } else if (structureBias === 'BEARISH' && premiumBehaviour !== 'DECAYING' && dominanceBias !== 'BULLISH') {
    action = 'BUY PE'; marketBias = 'BEARISH';
    headline = aligned ? 'HIGH PROBABILITY DOWNSIDE MOVE' : 'DOWNSIDE BIAS — CONFIRM PREMIUM';
  } else {
    action = 'WAIT'; marketBias = structureBias;
    headline = premiumBehaviour === 'DECAYING' ? 'PREMIUM DECAYING — STAND ASIDE' : 'MIXED SIGNALS — WAIT';
  }

  // Confidence (0..5 stars) — structure + premium + dominance alignment
  let confidence100 = Math.round(
    (structureBias === 'NEUTRAL' ? 35 : 55) * 0.35 +
    pepScore * 0.40 +
    (dominance.dominantPct) * 0.25
  );
  if (aligned) confidence100 += 10;
  if (deltaQuality === 'FAKE') confidence100 -= 12;
  if (action === 'WAIT') confidence100 = Math.min(confidence100, 55);
  confidence100 = _clamp(confidence100, 20, 96);
  const stars = _round(_clamp(confidence100 / 20, 1, 5), 1);

  const tradeEdge =
    confidence100 >= 78 && aligned ? 'STRONG' :
    confidence100 >= 60 ? 'MODERATE' :
    'WEAK';

  // Verdict line ("STRUCTURE BULLISH + PREMIUM EXPANDING + STRIKE DOMINANCE BULLISH")
  const verdictLine = [
    `STRUCTURE ${structureBias}`,
    `PREMIUM ${premiumBehaviour}`,
    `STRIKE DOMINANCE ${dominanceBias}`,
  ].join(' + ');

  return {
    ok: true,
    version: 'v6',
    symbol: v2.symbol,
    date: v2.date,
    isToday: v2.isToday,
    at: Date.now(),

    spotPrice: _round(spot, 2),
    vwap: _round(vwap, 2),
    atm,
    futPremium: _round(futPremium, 2),
    activeSide,

    // ── 4 GREEK ENGINES ────────────────────────────────────────────
    greeks: {
      delta: {
        value: _round(deltaVal, 2),
        level: deltaLevel,                              // STRONG | MODERATE | WEAK
        trend: deltaTrend.dir,                          // RISING | FALLING | FLAT
        bias: activeSide === 'CE' ? 'BULLISH' : 'BEARISH',
        quality: deltaQuality,                          // REAL | FAKE | BUILDING
        verdict: deltaVerdict,                          // REAL BULL MOVE | FAKE RALLY | …
        score: Math.round(deltaScore),
        narrative: deltaQuality === 'REAL'
          ? 'Delta rising with price — genuine directional conviction.'
          : deltaQuality === 'FAKE'
            ? 'Price moving without delta support — fade the move.'
            : 'Direction building — needs confirmation.',
      },
      gamma: {
        value: _round(gammaVal, 5),
        index: gammaIndex,                              // γ · spot (display number)
        level: gammaLevel,                              // HIGH | MEDIUM | LOW
        trend: gammaTrend.dir,
        verdict: gammaVerdict,                          // EXPLOSIVE MOVE | NORMAL | SLOW
        score: Math.round(gammaScore),
        narrative: gammaLevel === 'HIGH'
          ? 'High gamma — premium can move violently and fast.'
          : gammaLevel === 'MEDIUM'
            ? 'Normal acceleration — steady premium movement.'
            : 'Low gamma — premium will crawl, avoid fast scalps.',
      },
      theta: {
        value: _round(thetaVal, 2),                     // negative
        level: thetaLevel,                              // FAST | MEDIUM | SLOW
        trend: thetaTrend.dir,
        verdict: thetaVerdict,                          // DECAY FAST | MEDIUM | SLOW
        decayWinning,
        score: Math.round(thetaScore),
        narrative: decayWinning
          ? 'Delta gain is beating theta loss — trade valid.'
          : thetaLevel === 'FAST'
            ? 'Heavy decay — only quick momentum trades survive.'
            : 'Moderate decay — manage time in trade.',
      },
      vega: {
        value: _round(vegaVal, 2),
        iv: _round(ivVal, 2),
        level: vegaLevel,                               // RISING | FALLING | FLAT
        state: vegaState,                               // EXPANDING | CRUSH | STABLE
        trend: ivTrend.dir,
        verdict: vegaVerdict,                           // IV EXPANDING | IV CRUSH RISK | IV STABLE
        score: Math.round(vegaScore),
        narrative: vegaState === 'EXPANDING'
          ? 'IV rising — premium expansion tailwind for buyers.'
          : vegaState === 'CRUSH'
            ? 'IV falling — crush risk, premium bleeds even if right.'
            : 'IV stable — neutral volatility backdrop.',
      },
    },

    // ── PREMIUM POWER SCORE ────────────────────────────────────────
    premiumPower: {
      score: pepScore,
      state: premiumState,                              // NUCLEAR EXPANSION … AVOID
      buyerEdge,                                        // YES | WEAK | NO
      behaviour: premiumBehaviour,                      // EXPANDING | NEUTRAL | DECAYING
      components: {
        delta: Math.round(deltaScore),
        gamma: Math.round(gammaScore),
        vega: Math.round(vegaScore),
        theta: Math.round(thetaScore),
      },
      weights: { delta: 35, gamma: 30, vega: 20, theta: 15 },
    },

    // ── GREEKS MOMENTUM MATRIX ─────────────────────────────────────
    momentumMatrix: {
      score: momentumScore,
      delta: { label: deltaLevel, trend: deltaTrend.dir },
      gamma: { label: gammaLevel, trend: gammaTrend.dir },
      theta: { label: thetaLevel, trend: thetaTrend.dir === 'RISING' ? 'RISING' : 'DECAY' },
      vega: { label: vegaState, trend: ivTrend.dir },
    },

    // ── GREEKS SUMMARY (right rail) ────────────────────────────────
    greeksSummary: {
      deltaTrend: deltaTrend.dir,                       // RISING | FALLING | FLAT
      gammaLevel,                                       // HIGH | MEDIUM | LOW
      thetaImpact: thetaLevel === 'FAST' ? 'HIGH' : thetaLevel === 'MEDIUM' ? 'MEDIUM' : 'LOW',
      vegaTrend: vegaState,                             // EXPANDING | CRUSH | STABLE
      premiumEdge: buyerEdge === 'YES' ? 'HIGH' : buyerEdge === 'WEAK' ? 'MEDIUM' : 'LOW',
    },

    // ── STRIKE DOMINANCE — ATM ± 5 ─────────────────────────────────
    strikeDominance: dominance,

    // ── FUTURES & BREADTH ──────────────────────────────────────────
    futuresBreadth: {
      futPremium: _round(futPremium, 2),
      premiumState: premiumState_fut,                   // PREMIUM POSITIVE | NEGATIVE | FLAT
      advDec: {
        adv: advancing,
        dec: declining,
        advPct,
        decPct,
        label: breadthLabel,
      },
      sentiment,                                        // BULLISH | BEARISH | NEUTRAL
    },

    // ── SESSION & RISK ─────────────────────────────────────────────
    session: { ...session, volatility },                // day, time, volatility
    risk: { level: riskLevel, reward: rewardPotential },

    // ── STRUCTURE SUMMARY ──────────────────────────────────────────
    structure: {
      bias: structureBias,                              // BULLISH | BEARISH | NEUTRAL
      premium: premiumBehaviour,                        // EXPANDING | NEUTRAL | DECAYING
      dominance: dominanceBias,                         // BULLISH | BEARISH | NEUTRAL
    },

    // ── FINAL VERDICT ──────────────────────────────────────────────
    verdict: {
      line: verdictLine,
      headline,
      tradeEdge,                                        // STRONG | MODERATE | WEAK
    },

    // ── OPTION BUYER ACTION PLAN ───────────────────────────────────
    actionPlan: {
      setup: aligned ? 'HIGH PROBABILITY SETUP' : action === 'WAIT' ? 'NO TRADE SETUP' : 'STANDARD SETUP',
      action,                                           // BUY CE | BUY PE | WAIT
      marketBias,                                       // BULLISH | BEARISH | NEUTRAL
      confidence: stars,                                // 1.0 … 5.0 (stars)
      confidencePct: confidence100,
      stars: Math.round(stars),
    },

    debug: {
      structureBias, activeSide, cePct,
      spotTrend: spotTrend.dir,
      ivTrend: ivTrend.dir,
      historySamples: hist.length,
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * STRIKE DOMINANCE — ATM ± N buyer-favour map.
 * Prefers the V2 oiHistogram (already carries ceFavorPct / peFavorPct);
 * falls back to the ladder. Builds a clean 100-step window centred on ATM.
 * ───────────────────────────────────────────────────────────────────── */
function _strikeDominance(ladder, oiHistogram, atm, spot, range = 5) {
  const step = _detectStep(ladder, oiHistogram, atm);
  if (!atm || !step) {
    return { step: step || 0, count: 0, atm, strikes: [], bias: 'NEUTRAL', dominantPct: 50 };
  }
  const anchor = Math.round(atm / step) * step;
  const histByStrike = new Map();
  for (const h of oiHistogram) histByStrike.set(Number(h.strike), h);
  const ladByStrike = new Map();
  for (const r of ladder) ladByStrike.set(Number(r.strike), r);

  const fmtPct = (chg, base) => (base > 0 ? _round((chg / base) * 100, 1) : 0);
  const strikes = [];
  let ceFavorCount = 0, peFavorCount = 0, dominantSum = 0;

  for (let i = -range; i <= range; i++) {
    const strikeVal = anchor + i * step;
    const h = histByStrike.get(strikeVal);
    const lad = ladByStrike.get(strikeVal);
    if (!h && !lad) continue;

    const isAtm = strikeVal === atm || strikeVal === anchor;
    let ceFavorPct, peFavorPct;
    if (h) {
      ceFavorPct = _safe(h.ceFavorPct, 50);
      peFavorPct = _safe(h.peFavorPct, 50);
    } else {
      // derive from ladder health/oiChange as a fallback
      const ceChg = _safe(lad?.ce?.oiChange);
      const peChg = _safe(lad?.pe?.oiChange);
      const tot = Math.abs(ceChg) + Math.abs(peChg) || 1;
      // PE writing (support) favours CE buyers; CE writing favours PE buyers
      const ceFav = 50 + ((Math.max(0, peChg) - Math.max(0, ceChg)) / tot) * 50;
      ceFavorPct = _round(_clamp(ceFav, 0, 100), 0);
      peFavorPct = 100 - ceFavorPct;
    }

    const ceOi = h ? _safe(h.ceOi) : _safe(lad?.ce?.oi);
    const peOi = h ? _safe(h.peOi) : _safe(lad?.pe?.oi);
    const ceOiChg = h ? _safe(h.ceOiChg) : _safe(lad?.ce?.oiChange);
    const peOiChg = h ? _safe(h.peOiChg) : _safe(lad?.pe?.oiChange);

    // Dominant side of this strike (which option buyer is favoured here)
    let side, dominantPct, oi, oiChangePct, label;
    if (isAtm) {
      side = 'ATM';
      dominantPct = Math.max(ceFavorPct, peFavorPct);
      oi = ceOi + peOi;
      const totPrev = (ceOi - ceOiChg) + (peOi - peOiChg);
      oiChangePct = fmtPct(ceOiChg + peOiChg, totPrev);
      label = 'ATM ZONE';
    } else if (ceFavorPct >= peFavorPct) {
      side = 'CE';
      dominantPct = ceFavorPct;
      oi = ceOi;
      oiChangePct = fmtPct(ceOiChg, ceOi - ceOiChg);
      label = ceFavorPct >= 65 ? 'STRONG CE' : 'CE BUILDUP';
      ceFavorCount++;
    } else {
      side = 'PE';
      dominantPct = peFavorPct;
      oi = peOi;
      oiChangePct = fmtPct(peOiChg, peOi - peOiChg);
      label = peFavorPct >= 65 ? 'STRONG PE' : 'PE BUILDUP';
      peFavorCount++;
    }
    if (!isAtm) dominantSum += dominantPct;

    strikes.push({
      strike: strikeVal,
      isAtm,
      side,
      dominantPct: Math.round(dominantPct),
      ceFavorPct: Math.round(ceFavorPct),
      peFavorPct: Math.round(peFavorPct),
      oi,
      oiChangePct,
      label,
    });
  }

  const directional = ceFavorCount + peFavorCount;
  const bias =
    ceFavorCount > peFavorCount + 1 ? 'BULLISH' :
    peFavorCount > ceFavorCount + 1 ? 'BEARISH' :
    'NEUTRAL';
  const dominantPct = directional ? Math.round(dominantSum / directional) : 50;

  return {
    step,
    count: strikes.length,
    atm,
    strikes,
    bias,
    dominantPct,
    ceFavorCount,
    peFavorCount,
  };
}

/** Detect the display strike step (100 for NIFTY, 100 for SENSEX index OC). */
function _detectStep(ladder, oiHistogram, atm) {
  const strikesArr = (oiHistogram && oiHistogram.length ? oiHistogram : ladder)
    .map(s => Number(s.strike))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (strikesArr.length >= 2) {
    let minDiff = Infinity;
    for (let i = 1; i < strikesArr.length; i++) {
      const d = strikesArr[i] - strikesArr[i - 1];
      if (d > 0 && d < minDiff) minDiff = d;
    }
    if (Number.isFinite(minDiff)) {
      // round display step up to 50/100 grid
      return minDiff <= 50 ? 100 : minDiff;
    }
  }
  return 100;
}

/** Session block — IST day name + HH:MM AM/PM. */
function _session(isToday) {
  const istMs = Date.now() + 5.5 * 3600 * 1000;
  const d = new Date(istMs);
  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const day = days[d.getUTCDay()];
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
  return { day, time, live: !!isToday };
}

module.exports = { getDecision };
