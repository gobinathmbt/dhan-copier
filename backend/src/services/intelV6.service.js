/* ─────────────────────────────────────────────────────────────────────
 * INTEL V6 — NIFTY MASTER ENGINE DASHBOARD
 * ========================================================================
 *   GREEKS + CPR + BREADTH + IT ENGINE  →  ONE master verdict.
 *
 *   GOLDEN RULE:
 *     Breadth tells the truth · CPR tells the location · Greeks confirm strength
 *
 *   Engines & institutional weights:
 *     1. MARKET BREADTH ENGINE   30%  — Advance/Decline → Extreme Bull … Extreme Bear
 *     2. CPR LOCATION            25%  — Above TC / Inside / Below BC
 *     3. CPR RELATIONSHIP        15%  — Today TC&BC vs Yesterday TC&BC (value migration)
 *     4. IT SECTOR STRENGTH      10%  — NIFTY IT tilt → Support / Drag
 *     5. GREEKS ENGINE (ATM)     10%  — CE vs PE dominance (Delta·Gamma·Vega·IV)
 *     6. VIX                     10%  — Falling = Risk On, Spiking = Risk Off
 *
 *   Extra engines:
 *     • MARKET CHARACTER  — Breadth + CPR Width + VIX → Trend/Range/Expansion/Panic/Short-Cover
 *     • MARKET TREND VIEW — majority vote of Breadth + IT + CPR Location
 *
 *   Final Verdict is GREEKS-GATED: a directional BIAS upgrades to a BUY SETUP
 *   only when the Greeks engine confirms the same side.
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

/* ─── Per-symbol Greeks history for RISING / FALLING trend detection ─── */
const _greekHistory = new Map(); // symbol → [{ t, ceDelta, peDelta, ... }]
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
function _trend(list, key, eps, useAbs = false) {
  if (!Array.isArray(list) || list.length < 4) return 'FLAT';
  const vals = list.map(s => (useAbs ? Math.abs(_safe(s[key])) : _safe(s[key]))).filter(Number.isFinite);
  if (vals.length < 4) return 'FLAT';
  const seg = Math.max(1, Math.floor(vals.length / 3));
  const oldAvg = vals.slice(0, seg).reduce((a, b) => a + b, 0) / seg;
  const newAvg = vals.slice(-seg).reduce((a, b) => a + b, 0) / seg;
  const drift = newAvg - oldAvg;
  if (drift >= eps) return 'RISING';
  if (drift <= -eps) return 'FALLING';
  return 'FLAT';
}

/* IT sector members per index (used to compute NIFTY IT tilt from breadth). */
const IT_MEMBERS = {
  NIFTY_50: ['INFY', 'TCS', 'HCLTECH', 'WIPRO', 'TECHM'],
  SENSEX:   ['INFY', 'TCS', 'HCLTECH', 'TECHM'],
};

/* Institutional engine weights (must sum to 100). */
const WEIGHTS = { breadth: 30, cprLocation: 25, cprRelation: 15, it: 10, greeks: 10, vix: 10 };

/**
 * Compute YESTERDAY's CPR (TC/BC) so we can detect true value migration.
 * Today's CPR is built from the PRIOR trading day's OHLC; yesterday's CPR is
 * built from the day-before-prior OHLC. Reads the live-feed folder via the
 * V2 internals; returns null if that history isn't available.
 */
function _yesterdayCpr(symbolKey, usedDate) {
  try {
    const I = intelV2.__internals;
    if (!I || !I._previousTradingDay || !I._readCandlesFile || !I._cprFromOHLC) return null;
    const prevDay = I._previousTradingDay(usedDate);      // made TODAY's CPR
    const prevPrevDay = I._previousTradingDay(prevDay);   // made YESTERDAY's CPR
    const c5 = I._readCandlesFile(prevPrevDay, symbolKey, 'candles', '5m');
    if (!Array.isArray(c5) || c5.length < 3) return null;
    const ohlc = {
      open: c5[0].open,
      high: Math.max(...c5.map(c => c.high)),
      low: Math.min(...c5.map(c => c.low)),
      close: c5[c5.length - 1].close,
    };
    return I._cprFromOHLC(ohlc);
  } catch (_) { return null; }
}

/* ═════════════════════════════════════════════════════════════════════ */
async function getDecision({ symbol = 'NIFTY_50', date = null } = {}) {
  const v2 = await intelV2.getSnapshot({ symbol, date });
  if (!v2 || !v2.ok) {
    return { ok: false, error: 'V2 snapshot unavailable', version: 'v6' };
  }

  const spot = _safe(v2.spot?.ltp);
  const spotChange = _safe(v2.spot?.change);
  const spotChangePct = _safe(v2.spot?.changePct);
  const vix = _safe(v2.macro?.vix?.price, v2.dashboard?.ivAnalytics?.vix);
  const vixChangePct = _safe(v2.macro?.vix?.changePct, v2.dashboard?.ivAnalytics?.vixChangePct);
  const cprRaw = v2.cpr || null;
  const breadth = v2.dashboard?.breadth || {};
  const atmCall = v2.options?.atmCall || null;
  const atmPut = v2.options?.atmPut || null;
  const atm = v2.options?.atm ?? null;
  const ladder = Array.isArray(v2.ladder) ? v2.ladder : [];

  /* ═══ 1. MARKET BREADTH ENGINE (30%) ═════════════════════════════════ */
  const advancing = _safe(breadth.advancing);
  const declining = _safe(breadth.declining);
  const unchanged = _safe(breadth.unchanged);
  const totalStocks = _safe(breadth.total, advancing + declining + unchanged) || (advancing + declining + unchanged);
  const breadthPct = totalStocks > 0 ? Math.round((advancing / totalStocks) * 100) : 50;

  // Finer institutional tiers — 56% is MILD BULL, not Neutral.
  const breadthZone =
    breadthPct >= 75 ? { label: 'EXTREME BULL', tone: 'strongbull' } :
    breadthPct >= 65 ? { label: 'STRONG BULL',  tone: 'strongbull' } :
    breadthPct >= 55 ? { label: 'MILD BULL',    tone: 'bull' } :
    breadthPct >= 45 ? { label: 'NEUTRAL',      tone: 'neutral' } :
    breadthPct >= 35 ? { label: 'MILD BEAR',    tone: 'bear' } :
    breadthPct >= 25 ? { label: 'STRONG BEAR',  tone: 'strongbear' } :
    { label: 'EXTREME BEAR', tone: 'strongbear' };
  const breadthBias = breadthPct >= 55 ? 'BULLISH' : breadthPct < 45 ? 'BEARISH' : 'NEUTRAL';

  const breadthEngine = {
    advancing, declining, unchanged,
    total: totalStocks,
    pct: breadthPct,
    formula: `${advancing} / ${totalStocks} × 100 = ${breadthPct}%`,
    zone: breadthZone.label,
    tone: breadthZone.tone,
    bias: breadthBias,
    scale: [
      { range: '≥ 75%',    label: 'EXTREME BULL', tone: 'strongbull', active: breadthZone.label === 'EXTREME BULL' },
      { range: '65 - 75%', label: 'STRONG BULL',  tone: 'strongbull', active: breadthZone.label === 'STRONG BULL' },
      { range: '55 - 65%', label: 'MILD BULL',    tone: 'bull',       active: breadthZone.label === 'MILD BULL' },
      { range: '45 - 55%', label: 'NEUTRAL',      tone: 'neutral',    active: breadthZone.label === 'NEUTRAL' },
      { range: '35 - 45%', label: 'MILD BEAR',    tone: 'bear',       active: breadthZone.label === 'MILD BEAR' },
      { range: '25 - 35%', label: 'STRONG BEAR',  tone: 'strongbear', active: breadthZone.label === 'STRONG BEAR' },
      { range: '< 25%',    label: 'EXTREME BEAR', tone: 'strongbear', active: breadthZone.label === 'EXTREME BEAR' },
    ],
  };

  /* ═══ 2. IT SECTOR STRENGTH ENGINE (10%) ═════════════════════════════ */
  const allStocks = Array.isArray(breadth.allStocks) ? breadth.allStocks : [];
  const members = IT_MEMBERS[symbol] || IT_MEMBERS.NIFTY_50;
  const itStocks = allStocks.filter(s => members.includes(String(s.symbol).toUpperCase()));
  const itChangePct = itStocks.length
    ? _round(itStocks.reduce((a, s) => a + _safe(s.changePct), 0) / itStocks.length, 2)
    : 0;
  const itZone =
    itChangePct > 1.5 ? { label: 'STRONG SUPPORT', tone: 'strongbull' } :
    itChangePct >= 0.5 ? { label: 'SUPPORT', tone: 'bull' } :
    itChangePct >= -0.5 ? { label: 'NEUTRAL', tone: 'neutral' } :
    itChangePct >= -1.5 ? { label: 'DRAG', tone: 'bear' } :
    { label: 'HEAVY DRAG', tone: 'strongbear' };
  const itBias = itChangePct >= 0.5 ? 'BULLISH' : itChangePct <= -0.5 ? 'BEARISH' : 'NEUTRAL';
  const itEngine = {
    changePct: itChangePct,
    members: itStocks.map(s => ({ symbol: s.symbol, changePct: _round(_safe(s.changePct), 2) })),
    zone: itZone.label,
    tone: itZone.tone,
    bias: itBias,
    summary: itBias === 'BULLISH' ? 'IT SUPPORTING INDEX'
      : itBias === 'BEARISH' ? 'IT DRAGGING INDEX'
      : 'IT NEUTRAL ON INDEX',
    scale: [
      { range: '> +1.5%',         label: 'STRONG SUPPORT', tone: 'strongbull', active: itZone.tone === 'strongbull' },
      { range: '+0.5% to +1.5%',  label: 'SUPPORT',        tone: 'bull',       active: itZone.tone === 'bull' },
      { range: '-0.5% to +0.5%',  label: 'NEUTRAL',        tone: 'neutral',    active: itZone.tone === 'neutral' },
      { range: '-0.5% to -1.5%',  label: 'DRAG',           tone: 'bear',       active: itZone.tone === 'bear' },
      { range: '< -1.5%',         label: 'HEAVY DRAG',     tone: 'strongbear', active: itZone.tone === 'strongbear' },
    ],
  };

  /* ═══ 3. CPR ENGINE (Location 25% · Relationship 15%) ════════════════ */
  const cpr = cprRaw || {};
  const pivot = _safe(cpr.pivot);
  const tc = _safe(cpr.tc);
  const bc = _safe(cpr.bc);
  const widthClass = cpr.widthClass || 'normal';
  const cprWidth =
    widthClass === 'narrow' ? { label: 'NARROW', headline: 'Compression Energy Building', sub: 'Big Move Expected', tone: 'bull' } :
    widthClass === 'wide' ? { label: 'WIDE', headline: 'Range / Sideways Bias', sub: 'Trend Day Less Likely', tone: 'bear' } :
    { label: 'NORMAL', headline: 'Balanced Structure', sub: 'Standard Day Expected', tone: 'neutral' };

  // 3a. Price location vs CPR (25%)
  let priceLocation, locationTerritory, locationSub, locationBias;
  if (Number.isFinite(tc) && spot > tc) {
    priceLocation = 'ABOVE TC'; locationTerritory = 'BULL TERRITORY'; locationSub = 'Trend CE Favorable'; locationBias = 'BULLISH';
  } else if (Number.isFinite(bc) && spot < bc) {
    priceLocation = 'BELOW BC'; locationTerritory = 'BEAR TERRITORY'; locationSub = 'Trend PE Favorable'; locationBias = 'BEARISH';
  } else {
    priceLocation = 'INSIDE CPR'; locationTerritory = 'NEUTRAL ZONE'; locationSub = 'Wait For Direction'; locationBias = 'NEUTRAL';
  }
  const locationBanner =
    locationBias === 'BULLISH' ? 'PRICE ABOVE TC — BULL TERRITORY' :
    locationBias === 'BEARISH' ? 'PRICE BELOW BC — BEAR TERRITORY' :
    'PRICE INSIDE CPR — NEUTRAL ZONE';

  // 3b. CPR RELATIONSHIP (15%) — TRUE value migration: today TC&BC vs yesterday TC&BC.
  const yCpr = _yesterdayCpr(v2.symbol, v2.date);
  const priorClose = _safe(v2.spot?.priorClose);
  let cprRelation;
  if (yCpr && Number.isFinite(yCpr.tc) && Number.isFinite(yCpr.bc) && Number.isFinite(tc) && Number.isFinite(bc)) {
    if (tc > yCpr.tc && bc > yCpr.bc) {
      cprRelation = { label: 'HIGHER VALUE CPR', l1: 'Bullish Structure', l2: 'Higher High Probability', bias: 'BULLISH', method: 'tc-bc' };
    } else if (tc < yCpr.tc && bc < yCpr.bc) {
      cprRelation = { label: 'LOWER VALUE CPR', l1: 'Bearish Structure', l2: 'Lower Low Probability', bias: 'BEARISH', method: 'tc-bc' };
    } else {
      cprRelation = { label: 'OVERLAPPING CPR', l1: 'Neutral Structure', l2: 'Range / Indecision', bias: 'NEUTRAL', method: 'tc-bc' };
    }
  } else {
    // Fallback when yesterday's CPR is unavailable (e.g. no recorded history).
    if (pivot > priorClose) {
      cprRelation = { label: 'HIGHER VALUE CPR', l1: 'Bullish Structure', l2: 'Higher High Probability', bias: 'BULLISH', method: 'pivot-fallback' };
    } else if (pivot < priorClose) {
      cprRelation = { label: 'LOWER VALUE CPR', l1: 'Bearish Structure', l2: 'Lower Low Probability', bias: 'BEARISH', method: 'pivot-fallback' };
    } else {
      cprRelation = { label: 'UNCHANGED CPR', l1: 'Neutral Structure', l2: 'Range Probable', bias: 'NEUTRAL', method: 'pivot-fallback' };
    }
  }

  const cprEngine = {
    width: cprWidth,
    widthPct: _safe(cpr.widthPct),
    levels: {
      r3: _safe(cpr.r3), tc, pivot, bc, s3: _safe(cpr.s3),
      r1: _safe(cpr.r1), r2: _safe(cpr.r2), s1: _safe(cpr.s1), s2: _safe(cpr.s2),
    },
    yesterday: yCpr ? { tc: _safe(yCpr.tc), bc: _safe(yCpr.bc), pivot: _safe(yCpr.pivot) } : null,
    priceLocation, territory: locationTerritory, locationSub, locationBias, locationBanner,
    relation: cprRelation,
    opening: {
      gapUp: [
        { cond: 'Above TC', verdict: 'Strong Bullish', sub: 'No Need CPR Touch', tone: 'bull', active: locationBias === 'BULLISH' },
        { cond: 'Inside CPR', verdict: 'Gap Failed / Neutral', sub: 'Wait for Direction', tone: 'neutral', active: false },
      ],
      flat: [
        { cond: 'Inside CPR', verdict: 'Neutral Zone', sub: 'Wait for break', tone: 'neutral', active: locationBias === 'NEUTRAL' },
      ],
      gapDown: [
        { cond: 'Below BC', verdict: 'Strong Bearish', sub: 'No Need CPR Touch', tone: 'bear', active: locationBias === 'BEARISH' },
        { cond: 'Inside CPR', verdict: 'Gap Failed / Neutral', sub: 'Wait for Direction', tone: 'neutral', active: false },
      ],
    },
  };

  /* ═══ 4. GREEKS ENGINE (ATM) — CE vs PE dominance (10%) ══════════════ */
  const atmRow = ladder.find(r => r.isAtm) || ladder.find(r => r.strike === atm) || null;
  const ceLeg = atmRow?.ce || {};
  const peLeg = atmRow?.pe || {};
  const atmIv = _safe(v2.options?.atmIv, _safe(ceLeg.iv));

  // Per-side ATM greeks
  const ceDelta = _safe(ceLeg.delta, _safe(atmCall?.delta));    // ~ +0.5
  const peDelta = _safe(peLeg.delta, _safe(atmPut?.delta));     // ~ -0.5
  const ceGamma = _safe(ceLeg.gamma);
  const peGamma = _safe(peLeg.gamma);
  const ceVega = _safe(ceLeg.vega);
  const peVega = _safe(peLeg.vega);
  const ceTheta = _safe(ceLeg.theta);
  const peTheta = _safe(peLeg.theta);
  const ceIv = _safe(ceLeg.iv, atmIv);
  const peIv = _safe(peLeg.iv, atmIv);

  const hist = _pushGreekHistory(symbol, {
    ceDelta, peDelta, ceGamma, peGamma, ceVega, peVega, ceTheta, peTheta, ceIv, peIv,
  });

  // Per-side trends (magnitude-based for gamma/vega; IV signed)
  const ceDeltaTrend = _trend(hist, 'ceDelta', 0.01, true);
  const peDeltaTrend = _trend(hist, 'peDelta', 0.01, true);
  const ceVegaTrend  = _trend(hist, 'ceVega', 0.1, true);
  const peVegaTrend  = _trend(hist, 'peVega', 0.1, true);
  const ceGammaTrend = _trend(hist, 'ceGamma', 0.00003, true);
  const peGammaTrend = _trend(hist, 'peGamma', 0.00003, true);
  const ceIvTrend    = _trend(hist, 'ceIv', 0.1);
  const peIvTrend    = _trend(hist, 'peIv', 0.1);

  // Dominance score per side (0..100): delta magnitude + rising delta/vega/gamma/IV
  const sideScore = (deltaAbs, dRise, vRise, gRise, ivRise) => _clamp(Math.round(
    _clamp(deltaAbs * 60, 0, 35) +   // ~0.5 delta → ~30
    (dRise ? 25 : 0) +
    (vRise ? 20 : 0) +
    (gRise ? 12 : 0) +
    (ivRise ? 8 : 0)
  ), 0, 100);
  const ceScore = sideScore(Math.abs(ceDelta), ceDeltaTrend === 'RISING', ceVegaTrend === 'RISING', ceGammaTrend === 'RISING', ceIvTrend === 'RISING');
  const peScore = sideScore(Math.abs(peDelta), peDeltaTrend === 'RISING', peVegaTrend === 'RISING', peGammaTrend === 'RISING', peIvTrend === 'RISING');

  const greeksSide = ceScore > peScore + 8 ? 'CE' : peScore > ceScore + 8 ? 'PE' : 'NEUTRAL';
  const greeksBias = greeksSide === 'CE' ? 'BULLISH' : greeksSide === 'PE' ? 'BEARISH' : 'NEUTRAL';

  // Display cards reflect the ACTIVE (dominant) side; default to CE when balanced.
  const showSide = greeksSide === 'PE' ? 'PE' : 'CE';
  const dDelta = showSide === 'PE' ? peDelta : ceDelta;
  const dGamma = showSide === 'PE' ? peGamma : ceGamma;
  const dVega  = showSide === 'PE' ? peVega  : ceVega;
  const dTheta = showSide === 'PE' ? peTheta : ceTheta;
  const dDeltaTrend = showSide === 'PE' ? peDeltaTrend : ceDeltaTrend;
  const dGammaTrend = showSide === 'PE' ? peGammaTrend : ceGammaTrend;
  const dVegaTrend  = showSide === 'PE' ? peVegaTrend  : ceVegaTrend;
  const dThetaAbs = Math.abs(dTheta);

  // DELTA card
  const deltaBias = greeksBias; // direction comes from dominance
  const deltaEngine = {
    value: _round(dDelta, 3),
    trend: dDeltaTrend,
    bias: deltaBias,
    control: greeksSide === 'CE' ? 'CALL BUYERS ACTIVE' : greeksSide === 'PE' ? 'PUT BUYERS ACTIVE' : 'BALANCED',
    scale: [
      { range: 'CE DOMINANT', label: 'BULLISH', tone: 'bull',    active: greeksSide === 'CE' },
      { range: 'BALANCED',    label: 'NEUTRAL', tone: 'neutral', active: greeksSide === 'NEUTRAL' },
      { range: 'PE DOMINANT', label: 'BEARISH', tone: 'bear',    active: greeksSide === 'PE' },
    ],
  };
  // GAMMA card
  const gammaEngine = {
    value: _round(dGamma, 4),
    trend: dGammaTrend,
    state: dGammaTrend === 'RISING' ? 'ACCELERATION' : dGammaTrend === 'FALLING' ? 'DECELERATION' : 'STEADY',
    scale: [
      { range: 'RISING FAST', label: 'STRONG MOVE', tone: 'bull',    active: dGammaTrend === 'RISING' },
      { range: 'RISING SLOW', label: 'MODERATE',    tone: 'neutral', active: dGammaTrend === 'FLAT' },
      { range: 'FALLING',     label: 'WEAK MOVE',   tone: 'bear',    active: dGammaTrend === 'FALLING' },
    ],
  };
  // VEGA card
  const vegaEngine = {
    value: _round(dVega, 3),
    iv: _round(showSide === 'PE' ? peIv : ceIv, 2),
    trend: dVegaTrend,
    state: dVegaTrend === 'RISING' ? 'PREMIUM EXPANSION' : dVegaTrend === 'FALLING' ? 'IV CRUSH RISK' : 'NEUTRAL',
    scale: [
      { range: 'RISING',  label: 'BUYER FRIENDLY',  tone: 'bull',    active: dVegaTrend === 'RISING' },
      { range: 'FLAT',    label: 'NEUTRAL',         tone: 'neutral', active: dVegaTrend === 'FLAT' },
      { range: 'FALLING', label: 'SELLER FRIENDLY', tone: 'bear',    active: dVegaTrend === 'FALLING' },
    ],
  };
  // THETA card (|x| matters)
  const thetaDecay = dThetaAbs > 15 ? 'HIGH DECAY' : dThetaAbs >= 8 ? 'MEDIUM DECAY' : 'LOW DECAY';
  const thetaFriendly = dThetaAbs <= 8 ? 'BUYER FRIENDLY' : dThetaAbs <= 15 ? 'NEUTRAL' : 'SELLER EDGE';
  const thetaEngine = {
    value: _round(dTheta, 3),
    trend: _trend(hist, showSide === 'PE' ? 'peTheta' : 'ceTheta', 0.4, true),
    decay: thetaDecay,
    friendly: thetaFriendly,
    scale: [
      { range: 'MORE NEGATIVE', label: 'SELLER EDGE', tone: 'bear',    active: dThetaAbs > 15 },
      { range: 'STABLE',        label: 'NEUTRAL',     tone: 'neutral', active: dThetaAbs >= 8 && dThetaAbs <= 15 },
      { range: 'LESS NEGATIVE', label: 'BUYER EDGE',  tone: 'bull',    active: dThetaAbs < 8 },
    ],
  };

  // Buyer-aligned confluence for the dominant side
  const greeksPositive = greeksSide === 'CE' && dGammaTrend !== 'FALLING' && dVegaTrend !== 'FALLING' && dThetaAbs <= 15;
  const greeksNegative = greeksSide === 'PE' && dGammaTrend !== 'FALLING' && dVegaTrend !== 'FALLING' && dThetaAbs <= 15;
  const greeksConfirm = greeksPositive || greeksNegative; // greeks are taking a clear, healthy side

  const greeksReading = [
    { text: 'CE DOMINANCE > PE = CALL BUYERS ACTIVE', tone: 'bull', active: greeksSide === 'CE' },
    { text: 'PE DOMINANCE > CE = PUT BUYERS ACTIVE', tone: 'bear', active: greeksSide === 'PE' },
    { text: 'GAMMA RISING = MOVE ACCELERATING', tone: 'bull', active: dGammaTrend === 'RISING' },
    { text: 'VEGA RISING = PREMIUM EXPANDING', tone: 'bull', active: dVegaTrend === 'RISING' },
    { text: 'THETA LOW = OPTION BUYER FRIENDLY', tone: 'bull', active: dThetaAbs < 8 },
  ];

  const greeksEngine = {
    side: greeksSide,                 // CE | PE | NEUTRAL
    bias: greeksBias,
    confirm: greeksConfirm,
    dominance: {
      ceScore, peScore,
      ce: { delta: _round(ceDelta, 3), gamma: _round(ceGamma, 4), vega: _round(ceVega, 3), iv: _round(ceIv, 2),
            deltaTrend: ceDeltaTrend, vegaTrend: ceVegaTrend, gammaTrend: ceGammaTrend },
      pe: { delta: _round(peDelta, 3), gamma: _round(peGamma, 4), vega: _round(peVega, 3), iv: _round(peIv, 2),
            deltaTrend: peDeltaTrend, vegaTrend: peVegaTrend, gammaTrend: peGammaTrend },
    },
    delta: deltaEngine,
    gamma: gammaEngine,
    vega: vegaEngine,
    theta: thetaEngine,
    allPositive: greeksPositive,
    reading: greeksReading,
  };

  /* ═══ 6. VIX ENGINE (10%) ════════════════════════════════════════════ */
  // VIX falling = risk-on (bullish for index buyers); spiking = risk-off.
  const vixBias = vixChangePct <= -1 ? 'BULLISH' : vixChangePct >= 4 ? 'BEARISH' : 'NEUTRAL';
  const vixTrend = vixChangePct <= -2 ? 'FALLING' : vixChangePct >= 4 ? 'RISING' : 'FLAT';

  /* ═══ MARKET TREND VIEW (Breadth + IT + CPR Location vote) ═══════════ */
  const trendBias = (() => {
    const bullVotes = (breadthBias === 'BULLISH' ? 1 : 0) + (itBias === 'BULLISH' ? 1 : 0) + (locationBias === 'BULLISH' ? 1 : 0);
    const bearVotes = (breadthBias === 'BEARISH' ? 1 : 0) + (itBias === 'BEARISH' ? 1 : 0) + (locationBias === 'BEARISH' ? 1 : 0);
    if (bullVotes >= 2 && bullVotes > bearVotes) return 'BULLISH';
    if (bearVotes >= 2 && bearVotes > bullVotes) return 'BEARISH';
    return 'NEUTRAL';
  })();
  const trendView = {
    active: trendBias,
    rows: [
      { dir: 'UP',   label: 'TREND BULLISH', l1: 'Trend Continuation', l2: 'Higher High Likely', tone: 'bull',    active: trendBias === 'BULLISH' },
      { dir: 'FLAT', label: 'RANGE / NEUTRAL', l1: 'Wait for Breakout', l2: 'In CPR', tone: 'neutral',           active: trendBias === 'NEUTRAL' },
      { dir: 'DOWN', label: 'TREND BEARISH', l1: 'Trend Continuation', l2: 'Lower Low Likely', tone: 'bear',     active: trendBias === 'BEARISH' },
    ],
  };

  /* ═══ MARKET CHARACTER ENGINE (Breadth + CPR Width + VIX) ════════════ */
  const breadthStrong = breadthPct >= 65 || breadthPct <= 35;
  const character = (() => {
    if (vixChangePct >= 8 && breadthPct < 40) {
      return { label: 'PANIC DAY', desc: 'VIX spiking · breadth collapsing', tone: 'strongbear' };
    }
    if (cprWidth.label === 'NARROW' && breadthStrong) {
      return { label: 'EXPANSION DAY', desc: 'Compression + strong breadth — big move loading', tone: breadthPct >= 65 ? 'strongbull' : 'strongbear' };
    }
    if (breadthStrong && locationBias !== 'NEUTRAL') {
      return { label: 'TREND DAY', desc: 'One-sided breadth with trend location', tone: breadthPct >= 65 ? 'bull' : 'bear' };
    }
    if (breadthPct >= 55 && vixTrend === 'FALLING' && locationBias === 'BULLISH') {
      return { label: 'SHORT COVERING DAY', desc: 'Breadth improving · VIX cooling · reclaim', tone: 'bull' };
    }
    if (cprWidth.label === 'WIDE' || (breadthPct > 45 && breadthPct < 55) || locationBias === 'NEUTRAL') {
      return { label: 'RANGE DAY', desc: 'Wide CPR / neutral breadth — expect chop', tone: 'neutral' };
    }
    return { label: 'NORMAL DAY', desc: 'No dominant character yet', tone: 'neutral' };
  })();
  const marketCharacter = {
    label: character.label,
    desc: character.desc,
    tone: character.tone,
    inputs: {
      breadthPct,
      cprWidth: cprWidth.label,
      vix: _round(vix, 2),
      vixChangePct: _round(vixChangePct, 2),
      vixTrend,
    },
  };

  /* ═══ MARKET MODE ════════════════════════════════════════════════════ */
  const riskOn = (breadthBias === 'BULLISH' || trendBias === 'BULLISH') && vixChangePct <= 5;
  const marketMode = {
    label: 'INSTITUTIONAL',
    state: riskOn ? 'RISK ON' : (breadthBias === 'BEARISH' ? 'RISK OFF' : 'NEUTRAL'),
    bias: trendBias,
  };

  /* ═══ 5. WEIGHTED VERDICT + LOGIC MATRIX ═════════════════════════════ */
  const contrib = (bias, w) => (bias === 'BULLISH' ? w : bias === 'BEARISH' ? -w : 0);
  const netScore = _round(
    contrib(breadthBias, WEIGHTS.breadth) +
    contrib(locationBias, WEIGHTS.cprLocation) +
    contrib(cprRelation.bias, WEIGHTS.cprRelation) +
    contrib(itBias, WEIGHTS.it) +
    contrib(greeksBias, WEIGHTS.greeks) +
    contrib(vixBias, WEIGHTS.vix), 0
  ); // range -100..+100
  const absNet = Math.abs(netScore);

  const conditionBias = netScore >= 20 ? 'BULLISH' : netScore <= -20 ? 'BEARISH' : 'NEUTRAL';

  let marketCondition;
  if (conditionBias === 'BULLISH') {
    marketCondition = absNet >= 60 ? 'BULLS IN CONTROL — HIGH CONVICTION'
      : absNet >= 35 ? 'BULLISH TILT — CE SETUP FORMING'
      : 'MILD BULLISH — WATCH FOR CONFIRMATION';
  } else if (conditionBias === 'BEARISH') {
    marketCondition = absNet >= 60 ? 'BEARS IN CONTROL — HIGH CONVICTION'
      : absNet >= 35 ? 'BEARISH TILT — PE SETUP FORMING'
      : 'MILD BEARISH — WATCH FOR CONFIRMATION';
  } else {
    marketCondition = 'MIXED SIGNALS — WAIT FOR ALIGNMENT';
  }

  // Bull / bear checklist (display + alignment)
  const engineBiases = [
    { key: 'BREADTH',      bias: breadthBias },
    { key: 'CPR LOCATION', bias: locationBias },
    { key: 'CPR RELATION', bias: cprRelation.bias },
    { key: 'IT SECTOR',    bias: itBias },
    { key: 'GREEKS',       bias: greeksBias },
    { key: 'VIX',          bias: vixBias },
  ];
  const bullCount = engineBiases.filter(e => e.bias === 'BULLISH').length;
  const bearCount = engineBiases.filter(e => e.bias === 'BEARISH').length;
  const allBull = bullCount === engineBiases.length;
  const allBear = bearCount === engineBiases.length;

  const logicMatrix = {
    netScore,
    weights: WEIGHTS,
    rows: [
      { engine: 'BREADTH',      weight: WEIGHTS.breadth,     value: `${breadthPct}%`, verdict: breadthZone.label, tone: breadthZone.tone },
      { engine: 'CPR LOCATION', weight: WEIGHTS.cprLocation, value: priceLocation, verdict: locationTerritory, tone: locationBias === 'BULLISH' ? 'bull' : locationBias === 'BEARISH' ? 'bear' : 'neutral' },
      { engine: 'CPR RELATION', weight: WEIGHTS.cprRelation, value: cprRelation.label.replace(' CPR', ''), verdict: cprRelation.bias === 'BULLISH' ? 'BULLISH STRUCTURE' : cprRelation.bias === 'BEARISH' ? 'BEARISH STRUCTURE' : 'NEUTRAL', tone: cprRelation.bias === 'BULLISH' ? 'bull' : cprRelation.bias === 'BEARISH' ? 'bear' : 'neutral' },
      { engine: 'IT SECTOR',    weight: WEIGHTS.it,          value: `${itChangePct >= 0 ? '+' : ''}${itChangePct}%`, verdict: itBias === 'BULLISH' ? 'SUPPORTING' : itBias === 'BEARISH' ? 'DRAGGING' : 'NEUTRAL', tone: itZone.tone },
      { engine: 'GREEKS (ATM)', weight: WEIGHTS.greeks,      value: `CE ${ceScore} / PE ${peScore}`, verdict: greeksSide === 'CE' ? 'CE DOMINANT' : greeksSide === 'PE' ? 'PE DOMINANT' : 'BALANCED', tone: greeksBias === 'BULLISH' ? 'bull' : greeksBias === 'BEARISH' ? 'bear' : 'neutral', greeks: true },
      { engine: 'VIX',          weight: WEIGHTS.vix,         value: `${_round(vix, 2)} (${vixChangePct >= 0 ? '+' : ''}${_round(vixChangePct, 2)}%)`, verdict: vixBias === 'BULLISH' ? 'RISK ON' : vixBias === 'BEARISH' ? 'RISK OFF' : 'STABLE', tone: vixBias === 'BULLISH' ? 'bull' : vixBias === 'BEARISH' ? 'bear' : 'neutral' },
    ],
    condition: marketCondition,
    conditionBias,
    summary: [
      { label: 'BREADTH ALIGNED',   ok: breadthBias !== 'NEUTRAL' },
      { label: 'CPR LOCATION SET',  ok: locationBias !== 'NEUTRAL' },
      { label: 'VALUE MIGRATING',   ok: cprRelation.bias !== 'NEUTRAL' },
      { label: 'IT CONFIRMING',     ok: itBias !== 'NEUTRAL' },
      { label: 'GREEKS CONFIRMING', ok: greeksConfirm },
    ],
    allAlign: allBull || allBear,
    alignText: allBull || allBear ? 'ALL SYSTEMS ALIGN' : `${Math.max(bullCount, bearCount)} / ${engineBiases.length} ALIGNED`,
  };

  /* ═══ FINAL VERDICT — GREEKS-GATED ═══════════════════════════════════ */
  // Direction confidence from the weighted net score; only call a BUY SETUP
  // when the Greeks engine confirms the same side.
  const confidence10 = _clamp(Math.round(3 + (absNet / 100) * 6 + (vix < 14 ? 0.5 : 0)), 1, 10);
  const stars = _clamp(Math.round(absNet / 20), 1, 5);
  const strengthLabel = absNet >= 60 ? 'STRONG' : absNet >= 35 ? 'MODERATE' : absNet >= 20 ? 'MILD' : 'WEAK';

  let setup, setupBias, tradePlan, greeksGate;
  if (conditionBias === 'BULLISH') {
    setupBias = 'BULLISH';
    if (greeksBias === 'BULLISH') {
      setup = 'CE BUY SETUP';
      tradePlan = absNet >= 60 ? 'BUY CE ON DIP' : 'BUY CE ON CONFIRMATION';
      greeksGate = 'CONFIRMED';
    } else {
      setup = 'BULLISH BIAS';
      tradePlan = 'AWAIT GREEKS CONFIRMATION';
      greeksGate = 'PENDING';
    }
  } else if (conditionBias === 'BEARISH') {
    setupBias = 'BEARISH';
    if (greeksBias === 'BEARISH') {
      setup = 'PE BUY SETUP';
      tradePlan = absNet >= 60 ? 'BUY PE ON RISE' : 'BUY PE ON CONFIRMATION';
      greeksGate = 'CONFIRMED';
    } else {
      setup = 'BEARISH BIAS';
      tradePlan = 'AWAIT GREEKS CONFIRMATION';
      greeksGate = 'PENDING';
    }
  } else {
    setupBias = 'NEUTRAL';
    setup = 'NO TRADE SETUP';
    tradePlan = 'WAIT FOR ALIGNMENT';
    greeksGate = 'N/A';
  }

  const finalVerdict = {
    setup,
    bias: setupBias,
    greeksGate,                       // CONFIRMED | PENDING | N/A
    netScore,
    stars,
    confidence: confidence10,
    confidenceText: `${confidence10} / 10`,
    cells: [
      { label: 'TREND',       value: trendBias === 'BULLISH' ? 'UP' : trendBias === 'BEARISH' ? 'DOWN' : 'FLAT', icon: trendBias === 'BULLISH' ? 'up' : trendBias === 'BEARISH' ? 'down' : 'flat', tone: trendBias === 'BULLISH' ? 'bull' : trendBias === 'BEARISH' ? 'bear' : 'neutral' },
      { label: 'STRENGTH',    value: strengthLabel, tone: absNet >= 60 ? 'bull' : absNet >= 35 ? 'neutral' : 'bear' },
      { label: 'MOMENTUM',    value: dGammaTrend === 'RISING' ? 'RISING' : dGammaTrend === 'FALLING' ? 'FADING' : 'STEADY', tone: dGammaTrend === 'RISING' ? 'bull' : dGammaTrend === 'FALLING' ? 'bear' : 'neutral' },
      { label: 'CHARACTER',   value: marketCharacter.label.replace(' DAY', ''), tone: marketCharacter.tone },
    ],
    tradePlan,
  };

  /* ═══ Header / session ═══════════════════════════════════════════════ */
  const ses = _session(v2.isToday, v2.date);

  return {
    ok: true,
    version: 'v6',
    symbol: v2.symbol,
    displayName: v2.displayName || v2.symbol,
    date: v2.date,
    isToday: v2.isToday,
    at: Date.now(),

    header: {
      date: ses.dateLabel,
      time: ses.time,
      indexName: symbol === 'SENSEX' ? 'SENSEX' : 'NIFTY 50',
      spot: _round(spot, 2),
      change: _round(spotChange, 2),
      changePct: _round(spotChangePct, 2),
      vix: _round(vix, 2),
      vixChangePct: _round(vixChangePct, 2),
      marketMode,
    },

    breadthEngine,
    itEngine,
    cprEngine,
    trendView,
    greeksEngine,
    marketCharacter,
    logicMatrix,
    finalVerdict,

    goldenRule: 'BREADTH TELLS THE TRUTH · CPR TELLS THE LOCATION · GREEKS CONFIRM THE STRENGTH',

    debug: {
      netScore, bullCount, bearCount, conditionBias, greeksGate,
      greeksSide, ceScore, peScore,
      cprRelationMethod: cprRelation.method,
      trendBias, character: marketCharacter.label,
      itMembersFound: itStocks.length,
      historySamples: hist.length,
    },
  };
}

/** Session block — date label + IST HH:MM AM/PM. */
function _session(isToday, dateStr) {
  const istMs = Date.now() + 5.5 * 3600 * 1000;
  const d = new Date(istMs);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  let dateLabel;
  if (isToday) {
    dateLabel = `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  } else if (dateStr) {
    const [y, m, da] = dateStr.split('-').map(Number);
    dateLabel = `${String(da).padStart(2, '0')} ${months[(m - 1) % 12]} ${y}`;
  } else {
    dateLabel = `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  let h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  const time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} ${ampm}`;
  return { dateLabel, time };
}

module.exports = { getDecision };
