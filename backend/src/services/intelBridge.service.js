/* ─────────────────────────────────────────────────────────────────────
 * INTEL BRIDGE — INSTITUTIONAL INTENT CONVERTER (V2 → V6)
 * ========================================================================
 *   V2 = WHAT IS HAPPENING (positioning)
 *   V6 = SHOULD I BUY IT   (decision)
 *   BRIDGE = the brain that connects them:
 *
 *      Positioning → Conviction → Premium Expansion → Trade Decision
 *
 *   It reads V2's institutional positioning (OI shift, OI buildup, flow,
 *   breadth, FRVP auction, CPR) and V6's premium-behaviour layers (greeks,
 *   strike momentum, gamma regime), then produces:
 *
 *     1. INSTITUTIONAL CONVICTION METER  (Bull% / Bear% 0..100)
 *     2. PREMIUM EXPANSION PROBABILITY   (will premium actually pay?)
 *     3. EXPECTED PREMIUM BEHAVIOR       (EXPLOSIVE / HEALTHY / DECAY)
 *     4. DRIVERS list                    (the ✓ reasons behind it)
 *     5. BRIDGE VERDICT                  (BUY CE | BUY PE | WAIT | AVOID)
 *
 * Endpoint: GET /api/intel-bridge/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelV2 = require('./intelV2.service');
const intelV6 = require('./intelV6.service');

function _safe(n, d = 0) { const x = Number(n); return Number.isFinite(x) ? x : d; }
function _round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function _clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* ═════════════════════════════════════════════════════════════════════ */
async function getDecision({ symbol = 'NIFTY_50', date = null } = {}) {
  // Run V2 + V6 together. V6 internally calls V2 (cached), so this is cheap.
  const [v2, v6] = await Promise.all([
    intelV2.getSnapshot({ symbol, date }),
    intelV6.getDecision({ symbol, date }),
  ]);
  if (!v2 || !v2.ok) return { ok: false, error: 'V2 snapshot unavailable', version: 'bridge' };
  if (!v6 || !v6.ok) return { ok: false, error: 'V6 decision unavailable', version: 'bridge' };

  const d = v2.dashboard || {};
  const spot = _safe(v2.spot?.ltp);

  /* ═══ MARKET READINESS ENGINE (the gatekeeper) ══════════════════════
   * Runs BEFORE conviction/premium. Answers: "is today's ENVIRONMENT
   * healthy enough for option buying at all?" — independent of direction.
   *   Structure 30 + Flow 30 + Participation 20 + Risk 20 = 100. */
  const vwapBlk = d.vwapAvwapIntraday || {};
  const auctionInt = d.auctionIntensity || {};
  const heavyAlignMr = d.heavyweightsAlignment || {};
  const regimeC = d.regimeClassification || {};
  const trapBlk = v2.trap || {};
  const mrDeltaPct = _safe(v2.flow?.delta?.deltaPct);
  const mrFutPremium = _safe(v2.futures?.premium);
  const mrBreadthPct = _safe(d.breadth?.advancePct, 50);
  const cprWidthClass = v2.cpr?.widthClass || 'normal';

  // ── Structure (30) ──
  const aboveVwap = vwapBlk.priceVsVwap === 'Above'
    || (Number.isFinite(v2.spot?.vwap) && spot >= _safe(v2.spot?.vwap));
  const sessionAvwap = _safe(v2.avwap?.session, _safe(v2.spot?.sessionAvwap));
  const aboveAvwap = Number.isFinite(sessionAvwap) && sessionAvwap > 0 ? spot >= sessionAvwap : aboveVwap;
  const outsideValue = !!d.frvpInstitutional?.outsideValue
    && d.frvpInstitutional.outsideValue === 'YES';
  const structureItems = [
    { ok: aboveVwap,    pts: 10, label: 'Above VWAP' },
    { ok: aboveAvwap,   pts: 10, label: 'Above AVWAP' },
    { ok: outsideValue, pts: 10, label: 'Outside Value (trending)' },
  ];
  const structureScore = structureItems.filter(x => x.ok).reduce((s, x) => s + x.pts, 0);

  // ── Flow (30) ──
  const deltaStrong = Math.abs(mrDeltaPct) >= 8;
  // CVD aligned with delta direction (rising CVD when delta+, falling when delta−)
  const cvdSeries = Array.isArray(d.cvdSeries) ? d.cvdSeries : [];
  const cvdAligned = (() => {
    if (cvdSeries.length < 4) return deltaStrong; // fallback to delta
    const first = _safe(cvdSeries[0]?.cvd);
    const last = _safe(cvdSeries[cvdSeries.length - 1]?.cvd);
    const slope = last - first;
    return mrDeltaPct >= 0 ? slope > 0 : slope < 0;
  })();
  const futPremiumOk = Math.abs(mrFutPremium) > 5;
  const flowItems = [
    { ok: deltaStrong,   pts: 10, label: 'Delta Strong (|Δ| ≥ 8)' },
    { ok: cvdAligned,    pts: 10, label: 'CVD Aligned with Delta' },
    { ok: futPremiumOk,  pts: 10, label: 'Futures Premium Present' },
  ];
  const flowScore = flowItems.filter(x => x.ok).reduce((s, x) => s + x.pts, 0);

  // ── Participation (20) ──
  const breadthStrong = mrBreadthPct >= 60 || mrBreadthPct <= 40; // one-sided either way = participation
  const heavyAligned = /Aligned/i.test(heavyAlignMr.label || '')
    || (() => { const [a, t] = String(heavyAlignMr.score || '0/1').split('/').map(Number); return t > 0 && a / t >= 0.6; })();
  const partItems = [
    { ok: breadthStrong, pts: 10, label: 'Breadth Decisive (>60% or <40%)' },
    { ok: heavyAligned,  pts: 10, label: 'Heavyweights Aligned' },
  ];
  const participationScore = partItems.filter(x => x.ok).reduce((s, x) => s + x.pts, 0);

  // ── Risk (20) ──
  const lowTrap = (trapBlk.risk || 'low') === 'low';
  const trendDay = (regimeC.dayType || '').includes('TREND');
  const riskItems = [
    { ok: lowTrap,  pts: 10, label: 'Low Trap Risk' },
    { ok: trendDay, pts: 10, label: 'Trend Day' },
  ];
  const riskScore = riskItems.filter(x => x.ok).reduce((s, x) => s + x.pts, 0);

  const readinessScore = structureScore + flowScore + participationScore + riskScore;
  const readinessStatus =
    readinessScore >= 80 ? { label: 'EXCELLENT', tone: 'strongbull' } :
    readinessScore >= 60 ? { label: 'GOOD', tone: 'bull' } :
    readinessScore >= 40 ? { label: 'FAIR', tone: 'neutral' } :
    { label: 'POOR', tone: 'bear' };
  const readinessOk = readinessScore >= 50; // gate threshold

  const marketReadiness = {
    score: readinessScore,
    status: readinessStatus.label,
    tone: readinessStatus.tone,
    ok: readinessOk,
    sections: [
      { key: 'STRUCTURE',     score: structureScore,     max: 30, items: structureItems },
      { key: 'FLOW',          score: flowScore,          max: 30, items: flowItems },
      { key: 'PARTICIPATION', score: participationScore, max: 20, items: partItems },
      { key: 'RISK',          score: riskScore,          max: 20, items: riskItems },
    ],
    interpretation: readinessScore >= 80
      ? 'Institutional participation present. Trend structure healthy. Premium expansion environment favorable. Proceed to Option Buyer Engine.'
      : readinessScore >= 60
        ? 'Environment suitable for option buying. Confirm premium response before entry.'
        : readinessScore >= 40
          ? 'Mixed environment — selective only. Wait for cleaner participation.'
          : 'Weak / low-participation environment. Option buying unfavourable — stand aside.',
  };

  /* ─── Source signals from V2 positioning ──────────────────────────── */
  const oiShift     = d.oiShiftBias || null;                 // bullishPct/bearishPct/side
  const oiBuildup   = d.oiBuildupAnalysis || null;           // marketView, totals
  const flowOi      = v2.flow?.oi || {};                     // ceWriting/peWriting/unwinding/pcr
  const deltaPct    = _safe(v2.flow?.delta?.deltaPct);
  const breadthPct  = _safe(d.breadth?.advancePct, 50);
  const pcr         = _safe(flowOi.pcr);
  const futPremium  = _safe(v2.futures?.premium);

  /* ─── Source signals from V6 premium-behaviour ────────────────────── */
  const auction     = v6.auctionEngine || {};               // zone, bias
  const cprLoc      = v6.cprEngine?.locationBias || 'NEUTRAL';
  const cprAlign    = v6.cprEngine?.alignment || {};         // STRONG/WEAK bull/bear
  const greeks      = v6.greeksEngine || {};                 // side, premiumExpansion
  const strikeMom   = v6.strikeMomentum || {};               // side, score, state
  const gammaReg    = v6.gammaRegime || {};                  // regime, premium
  const premiumExp  = greeks.premiumExpansion || {};         // score, state

  /* ═══ INSTITUTIONAL CONVICTION METER ════════════════════════════════
   * Build a signed conviction by summing weighted institutional drivers.
   * Each driver contributes points toward BULL or BEAR. We list every
   * driver so the card can show the ✓ reasons. */
  const drivers = [];          // { label, side: 'BULL'|'BEAR', pts, active }
  const addDriver = (cond, side, pts, label) => {
    drivers.push({ label, side, pts, active: !!cond });
  };

  // ── OI SHIFT (fresh-money direction) — weight up to 18 ──
  const oiSide = oiShift?.side;                 // CALL | PUT | BALANCED
  const oiBullPct = _safe(oiShift?.bullishPct, 50);
  addDriver(oiBullPct >= 60, 'BULL', 18, 'OI Shift Bullish (PE writing / CE unwinding)');
  addDriver(oiBullPct <= 40, 'BEAR', 18, 'OI Shift Bearish (CE writing / PE unwinding)');

  // ── OI BUILDUP tags — weight up to 16 ──
  addDriver(!!flowOi.peWriting, 'BULL', 8, 'PE Writing (support building)');
  addDriver(!!flowOi.ceUnwinding, 'BULL', 8, 'CE Unwinding (short covering)');
  addDriver(!!flowOi.ceWriting, 'BEAR', 8, 'CE Writing (resistance building)');
  addDriver(!!flowOi.peUnwinding, 'BEAR', 8, 'PE Unwinding (support erosion)');

  // ── FLOW (delta) — weight up to 14 ──
  addDriver(deltaPct > 8, 'BULL', 14, 'Positive Delta Flow (real buying)');
  addDriver(deltaPct < -8, 'BEAR', 14, 'Negative Delta Flow (real selling)');

  // ── FUTURES premium — weight up to 8 ──
  addDriver(futPremium > 5, 'BULL', 8, 'Futures Premium (institutions paying up)');
  addDriver(futPremium < -5, 'BEAR', 8, 'Futures Discount (institutions selling)');

  // ── BREADTH — weight up to 14 ──
  addDriver(breadthPct >= 58, 'BULL', 14, 'Breadth Expansion (broad participation)');
  addDriver(breadthPct <= 42, 'BEAR', 14, 'Breadth Contraction (broad weakness)');

  // ── FRVP auction location — weight up to 16 ──
  addDriver(auction.zone === 'ABOVE VALUE' && auction.bias === 'BULLISH', 'BULL', 16, 'Acceptance Above VAH');
  addDriver(auction.zone === 'BELOW VALUE' && auction.bias === 'BEARISH', 'BEAR', 16, 'Acceptance Below VAL');

  // ── CPR location — weight up to 10 ──
  addDriver(cprLoc === 'BULLISH', 'BULL', 10, 'Above CPR TC (bull territory)');
  addDriver(cprLoc === 'BEARISH', 'BEAR', 10, 'Below CPR BC (bear territory)');

  // ── PCR sentiment — weight up to 6 ──
  addDriver(pcr >= 1.15, 'BULL', 6, 'PCR > 1.15 (put-heavy → bullish)');
  addDriver(pcr > 0 && pcr <= 0.85, 'BEAR', 6, 'PCR < 0.85 (call-heavy → bearish)');

  // Sum sides
  const bullPts = drivers.filter(x => x.active && x.side === 'BULL').reduce((s, x) => s + x.pts, 0);
  const bearPts = drivers.filter(x => x.active && x.side === 'BEAR').reduce((s, x) => s + x.pts, 0);
  // Max possible per side (for normalisation)
  const maxBull = drivers.filter(x => x.side === 'BULL').reduce((s, x) => s + x.pts, 0) || 1;
  const maxBear = drivers.filter(x => x.side === 'BEAR').reduce((s, x) => s + x.pts, 0) || 1;
  const bullConviction = Math.round((bullPts / maxBull) * 100);
  const bearConviction = Math.round((bearPts / maxBear) * 100);

  // Dominant conviction
  const convictionSide = bullConviction > bearConviction + 5 ? 'BULL'
    : bearConviction > bullConviction + 5 ? 'BEAR' : 'NEUTRAL';
  const conviction = convictionSide === 'BULL' ? bullConviction
    : convictionSide === 'BEAR' ? bearConviction
    : Math.max(bullConviction, bearConviction);

  const convictionTier =
    conviction >= 80 ? { label: 'AGGRESSIVE', tone: convictionSide === 'BEAR' ? 'strongbear' : 'strongbull' } :
    conviction >= 60 ? { label: 'STRONG', tone: convictionSide === 'BEAR' ? 'bear' : 'bull' } :
    conviction >= 40 ? { label: 'BUILDING', tone: 'neutral' } :
    conviction >= 20 ? { label: 'WEAK', tone: 'neutral' } :
    { label: 'NO CONVICTION', tone: 'neutral' };

  /* ═══ PREMIUM EXPANSION PROBABILITY ═════════════════════════════════
   * Conviction says WHERE positioning leans. Premium expansion says whether
   * the option will actually PAY. Combine V6 premium-expansion score, greeks
   * side agreement, strike momentum, and dealer gamma regime. */
  const greeksAgree = (convictionSide === 'BULL' && greeks.side === 'CE')
    || (convictionSide === 'BEAR' && greeks.side === 'PE');
  const strikeAgree = (convictionSide === 'BULL' && strikeMom.side === 'CE')
    || (convictionSide === 'BEAR' && strikeMom.side === 'PE');
  const gammaExpansion = gammaReg.premium === 'EXPANSION';
  const gammaDecay = gammaReg.premium === 'DECAY';

  let pep = 0;                                   // 0..100 premium-expansion probability
  pep += (conviction / 100) * 35;                // positioning conviction (0..35)
  pep += _clamp(_safe(premiumExp.score) * 0.30, 0, 30); // V6 premium-expansion score (0..30)
  pep += greeksAgree ? 15 : (greeks.side === 'NEUTRAL' ? 6 : 0); // greeks confirm side
  pep += strikeAgree ? 12 : (strikeMom.ready ? 0 : 6);  // strike momentum confirm
  pep += gammaExpansion ? 8 : gammaDecay ? 0 : 4;       // gamma regime tailwind
  pep = Math.round(_clamp(pep, 0, 100));

  // Expected premium behavior — fuse PEP with the V6 premium state.
  let expectedBehavior, behaviorTone;
  const sideWord = convictionSide === 'BEAR' ? 'PE' : 'CE';
  if (pep >= 80 && premiumExp.state !== 'DECAYING') {
    expectedBehavior = `EXPLOSIVE ${sideWord} EXPANSION`; behaviorTone = convictionSide === 'BEAR' ? 'strongbear' : 'strongbull';
  } else if (pep >= 60) {
    expectedBehavior = `HEALTHY ${sideWord} EXPANSION`; behaviorTone = convictionSide === 'BEAR' ? 'bear' : 'bull';
  } else if (pep >= 40) {
    expectedBehavior = 'SLOW / CHOPPY PREMIUM'; behaviorTone = 'neutral';
  } else {
    expectedBehavior = gammaDecay ? 'PREMIUM DECAY (IV CRUSH RISK)' : 'WEAK / DEAD PREMIUM'; behaviorTone = 'bear';
  }

  /* ═══ BRIDGE VERDICT — readiness gate + conviction + premium + V6 gate ══
   * Decision tree:
   *   Market Readiness < 50            → NO TRADE (environment unfit)
   *   Readiness ok, Buyer Quality < 60 → WAIT
   *   Readiness ok, Quality ok, no conviction/premium → WATCH
   *   Readiness ok, Quality ok, conviction + premium + V6 gate → BUY CE/PE */
  const v6Gate = v6.finalVerdict?.greeksGate;     // CONFIRMED | PENDING | ALIGN-PENDING | N/A
  const v6Setup = v6.finalVerdict?.setup;
  const buyerQuality = _safe(d.optionBuyerQuality?.score, 0);
  const buyerQualityOk = buyerQuality >= 60;

  let verdict, verdictTone, action, rationale;
  if (!readinessOk) {
    verdict = 'NO TRADE'; verdictTone = 'bear'; action = 'NO TRADE';
    rationale = `Market Readiness ${readinessScore}/100 (${readinessStatus.label}) — environment unfit for option buying.`;
  } else if (convictionSide === 'NEUTRAL' || conviction < 40) {
    verdict = 'WAIT'; verdictTone = 'neutral'; action = 'WAIT';
    rationale = 'Environment ready, but institutional positioning not yet committed.';
  } else if (pep < 40) {
    verdict = 'AVOID'; verdictTone = 'bear'; action = 'AVOID';
    rationale = 'Positioning leans ' + convictionSide.toLowerCase() + ' but premium will not expand — trap risk.';
  } else if (conviction >= 60 && pep >= 60 && v6Gate === 'CONFIRMED' && buyerQualityOk) {
    verdict = convictionSide === 'BULL' ? 'BUY CE' : 'BUY PE';
    verdictTone = convictionSide === 'BEAR' ? 'bear' : 'bull'; action = verdict;
    rationale = 'Readiness + conviction + premium expansion + V6 greeks confirmed — full alignment.';
  } else if (conviction >= 60 && pep >= 60 && !buyerQualityOk) {
    verdict = 'WAIT'; verdictTone = 'neutral'; action = 'WAIT';
    rationale = `Conviction strong but Option Buyer Quality ${buyerQuality}/100 < 60 — premium not responding yet.`;
  } else if (conviction >= 60 && pep >= 60) {
    verdict = convictionSide === 'BULL' ? 'BUY CE (await V6)' : 'BUY PE (await V6)';
    verdictTone = convictionSide === 'BEAR' ? 'bear' : 'bull'; action = 'PREP';
    rationale = 'Strong conviction + premium edge, but V6 greeks gate is ' + (v6Gate || 'pending') + '.';
  } else {
    verdict = convictionSide === 'BULL' ? 'BUILDING CE' : 'BUILDING PE';
    verdictTone = 'neutral'; action = 'WATCH';
    rationale = 'Conviction building — wait for premium confirmation.';
  }

  // Active drivers for the side that won (for the ✓ list)
  const activeDrivers = drivers
    .filter(x => x.active && (convictionSide === 'NEUTRAL' || x.side === convictionSide))
    .map(x => ({ label: x.label, side: x.side }));

  /* ═══ FLOW DIAGRAM stages (Readiness → Positioning → Conviction → Premium → Action) */
  const flowStages = [
    {
      stage: 'READINESS',
      source: 'BRIDGE',
      value: `${readinessScore}/100 · ${readinessStatus.label}`,
      tone: readinessStatus.tone,
    },
    {
      stage: 'POSITIONING',
      source: 'V2',
      value: oiSide === 'CALL' ? 'PE WRITING / CE UNWIND' : oiSide === 'PUT' ? 'CE WRITING / PE UNWIND' : 'BALANCED OI',
      tone: oiSide === 'CALL' ? 'bull' : oiSide === 'PUT' ? 'bear' : 'neutral',
    },
    {
      stage: 'CONVICTION',
      source: 'BRIDGE',
      value: `${convictionSide} ${conviction}% · ${convictionTier.label}`,
      tone: convictionTier.tone,
    },
    {
      stage: 'PREMIUM',
      source: 'BRIDGE',
      value: `${pep}% · ${expectedBehavior}`,
      tone: behaviorTone,
    },
    {
      stage: 'DECISION',
      source: 'V6',
      value: verdict,
      tone: verdictTone,
    },
  ];

  return {
    ok: true,
    version: 'bridge',
    symbol: v2.symbol,
    displayName: v2.displayName || v2.symbol,
    date: v2.date,
    isToday: v2.isToday,
    at: Date.now(),

    header: {
      spot: _round(spot, 2),
      change: _round(_safe(v2.spot?.change), 2),
      changePct: _round(_safe(v2.spot?.changePct), 2),
      vix: _round(_safe(v6.header?.vix), 2),
    },

    // 0. Market readiness gatekeeper (runs before everything)
    marketReadiness,

    // 1. Conviction meter
    conviction: {
      side: convictionSide,                       // BULL | BEAR | NEUTRAL
      value: conviction,
      bull: bullConviction,
      bear: bearConviction,
      tier: convictionTier.label,
      tone: convictionTier.tone,
    },

    // 2. Premium expansion probability + 3. expected behavior
    premium: {
      probability: pep,
      expectedBehavior,
      tone: behaviorTone,
      pexScore: _safe(premiumExp.score),
      pexState: premiumExp.state || 'NEUTRAL',
      gammaRegime: gammaReg.regime || 'NEUTRAL GAMMA',
      gammaPremium: gammaReg.premium || 'MIXED',
      greeksAgree, strikeAgree, gammaExpansion,
    },

    // 4. Drivers (✓ reasons)
    drivers: activeDrivers,
    allDrivers: drivers,                          // full list incl. inactive (debug/expand)

    // 5. Bridge verdict
    verdict: {
      action,                                     // BUY CE | BUY PE | PREP | WATCH | WAIT | AVOID
      label: verdict,
      tone: verdictTone,
      rationale,
      v6Gate, v6Setup,
    },

    // Flow diagram
    flowStages,

    // Cross-engine reference (so the UI can deep-link / show source verdicts)
    sources: {
      v2: {
        oiShiftSide: oiSide,
        oiShiftBullPct: oiBullPct,
        marketView: oiBuildup?.marketView?.label || null,
        pcr, deltaPct: _round(deltaPct, 2), breadthPct, futPremium: _round(futPremium, 2),
      },
      v6: {
        setup: v6Setup,
        netScore: _safe(v6.logicMatrix?.netScore),
        alignment: v6.alignmentEngine?.text || null,
        grade: v6.alignmentEngine?.grade || null,
        greeksSide: greeks.side,
        strikeMomentum: strikeMom.state,
        auctionZone: auction.zone,
        buyerQuality,
      },
    },

    goldenRule: 'READINESS → POSITIONING → CONVICTION → PREMIUM EXPANSION → DECISION',
  };
}

module.exports = { getDecision };
