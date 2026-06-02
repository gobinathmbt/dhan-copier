/* ─────────────────────────────────────────────────────────────────────
 * INTEL V6 — NIFTY MASTER ENGINE DASHBOARD
 * ========================================================================
 *   GREEKS + CPR + BREADTH + IT ENGINE  →  ONE master verdict.
 *
 *   GOLDEN RULE:
 *     Breadth tells the truth · CPR tells the location · Greeks confirm strength
 *
 *   Engines:
 *     1. MARKET BREADTH ENGINE   — Advancing/Declining → Strong Bull … Strong Bear
 *     2. IT SECTOR STRENGTH      — NIFTY IT tilt → Support / Drag
 *     3. CPR ENGINE              — Width · Levels · Price Location · Opening map
 *     4. GREEKS ENGINE (ATM)     — Delta · Gamma · Vega · Theta + market reading
 *     5. COMPLETE LOGIC MATRIX   — every engine on one row
 *     6. FINAL VERDICT           — CE/PE/NO-TRADE setup + confidence /10
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
const _greekHistory = new Map(); // symbol → [{ t, delta, gamma, theta, vega }]
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

  /* ═══ 1. MARKET BREADTH ENGINE ═══════════════════════════════════════ */
  const advancing = _safe(breadth.advancing);
  const declining = _safe(breadth.declining);
  const unchanged = _safe(breadth.unchanged);
  const totalStocks = _safe(breadth.total, advancing + declining + unchanged) || (advancing + declining + unchanged);
  const breadthPct = totalStocks > 0 ? Math.round((advancing / totalStocks) * 100) : 50;
  const breadthZone =
    breadthPct >= 70 ? { label: 'STRONG BULL', tone: 'strongbull' } :
    breadthPct >= 60 ? { label: 'BULL', tone: 'bull' } :
    breadthPct >= 40 ? { label: 'NEUTRAL', tone: 'neutral' } :
    breadthPct >= 30 ? { label: 'BEAR', tone: 'bear' } :
    { label: 'STRONG BEAR', tone: 'strongbear' };
  const breadthBias = breadthPct >= 60 ? 'BULLISH' : breadthPct <= 40 ? 'BEARISH' : 'NEUTRAL';

  const breadthEngine = {
    advancing, declining, unchanged,
    total: totalStocks,
    pct: breadthPct,
    formula: `${advancing} / ${totalStocks} × 100 = ${breadthPct}%`,
    zone: breadthZone.label,
    tone: breadthZone.tone,
    bias: breadthBias,
    scale: [
      { range: '> 70%',   label: 'STRONG BULL',  tone: 'strongbull', active: breadthZone.tone === 'strongbull' },
      { range: '60 - 70%', label: 'BULL',         tone: 'bull',       active: breadthZone.tone === 'bull' },
      { range: '40 - 60%', label: 'NEUTRAL',      tone: 'neutral',    active: breadthZone.tone === 'neutral' },
      { range: '30 - 40%', label: 'BEAR',         tone: 'bear',       active: breadthZone.tone === 'bear' },
      { range: '< 30%',   label: 'STRONG BEAR',  tone: 'strongbear', active: breadthZone.tone === 'strongbear' },
    ],
  };

  /* ═══ 2. IT SECTOR STRENGTH ENGINE ═══════════════════════════════════ */
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

  /* ═══ 3. CPR ENGINE ══════════════════════════════════════════════════ */
  const cpr = cprRaw || {};
  const pivot = _safe(cpr.pivot);
  const tc = _safe(cpr.tc);
  const bc = _safe(cpr.bc);
  const widthClass = cpr.widthClass || 'normal';
  const cprWidth =
    widthClass === 'narrow' ? { label: 'NARROW', headline: 'Compression Energy Building', sub: 'Big Move Expected', tone: 'bull' } :
    widthClass === 'wide' ? { label: 'WIDE', headline: 'Range / Sideways Bias', sub: 'Trend Day Less Likely', tone: 'bear' } :
    { label: 'NORMAL', headline: 'Balanced Structure', sub: 'Standard Day Expected', tone: 'neutral' };

  // price location vs CPR
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

  // CPR relationship vs previous day (rising value = bullish)
  // Compare today's pivot to spot reference: if pivot > priorClose proxy → higher value.
  const priorClose = _safe(v2.spot?.priorClose);
  const cprRelation =
    pivot > priorClose ? { label: 'HIGHER VALUE CPR', l1: 'Bullish Structure', l2: 'Higher High Probability', bias: 'BULLISH' } :
    pivot < priorClose ? { label: 'LOWER VALUE CPR', l1: 'Bearish Structure', l2: 'Lower Low Probability', bias: 'BEARISH' } :
    { label: 'UNCHANGED CPR', l1: 'Neutral Structure', l2: 'Range Probable', bias: 'NEUTRAL' };

  const cprEngine = {
    width: cprWidth,
    widthPct: _safe(cpr.widthPct),
    levels: {
      r3: _safe(cpr.r3), tc, pivot, bc, s3: _safe(cpr.s3),
      r1: _safe(cpr.r1), r2: _safe(cpr.r2), s1: _safe(cpr.s1), s2: _safe(cpr.s2),
    },
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

  /* ═══ MARKET TREND VIEW ══════════════════════════════════════════════ */
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

  /* ═══ MARKET MODE ════════════════════════════════════════════════════ */
  const riskOn = (breadthBias === 'BULLISH' || trendBias === 'BULLISH') && vixChangePct <= 5;
  const marketMode = {
    label: 'INSTITUTIONAL',
    state: riskOn ? 'RISK ON' : (breadthBias === 'BEARISH' ? 'RISK OFF' : 'NEUTRAL'),
    bias: trendBias,
  };

  /* ═══ 4. GREEKS ENGINE (ATM) ═════════════════════════════════════════ */
  // Use ATM CE greeks as the directional reference (matches the image's
  // positive-delta CE view); fall back to ladder ATM CE leg for full greeks.
  const atmRow = ladder.find(r => r.isAtm) || ladder.find(r => r.strike === atm) || null;
  const ceLeg = atmRow?.ce || {};
  const peLeg = atmRow?.pe || {};
  const deltaVal = _safe(ceLeg.delta, _safe(atmCall?.delta));
  const gammaVal = _safe(ceLeg.gamma);
  const vegaVal = _safe(ceLeg.vega);
  const thetaVal = _safe(ceLeg.theta);
  const atmIv = _safe(v2.options?.atmIv, _safe(ceLeg.iv));

  const hist = _pushGreekHistory(symbol, { delta: deltaVal, gamma: gammaVal, vega: vegaVal, theta: thetaVal });
  const deltaTrend = _trend(hist, 'delta', 0.01);
  const gammaTrend = _trend(hist, 'gamma', 0.00003, true);
  const vegaTrend = _trend(hist, 'vega', 0.1, true);
  const thetaTrend = _trend(hist, 'theta', 0.4, true);

  // DELTA
  const deltaBias = deltaVal > 0.25 ? 'BULLISH' : deltaVal < -0.25 ? 'BEARISH' : 'NEUTRAL';
  const deltaEngine = {
    value: _round(deltaVal, 3),
    trend: deltaTrend,
    bias: deltaBias,
    control: deltaBias === 'BULLISH' ? 'BULL CONTROL' : deltaBias === 'BEARISH' ? 'BEAR CONTROL' : 'NEUTRAL',
    scale: [
      { range: '> +0.25',        label: 'BULLISH', tone: 'bull',    active: deltaBias === 'BULLISH' },
      { range: '-0.25 to +0.25', label: 'NEUTRAL', tone: 'neutral', active: deltaBias === 'NEUTRAL' },
      { range: '< -0.25',        label: 'BEARISH', tone: 'bear',    active: deltaBias === 'BEARISH' },
    ],
  };
  // GAMMA
  const gammaState = gammaTrend === 'RISING' ? 'RISING' : gammaTrend === 'FALLING' ? 'FALLING' : 'RISING SLOW';
  const gammaEngine = {
    value: _round(gammaVal, 4),
    trend: gammaTrend,
    state: gammaTrend === 'RISING' ? 'ACCELERATION' : gammaTrend === 'FALLING' ? 'DECELERATION' : 'STEADY',
    scale: [
      { range: 'RISING FAST', label: 'STRONG MOVE',   tone: 'bull',    active: gammaTrend === 'RISING' },
      { range: 'RISING SLOW', label: 'MODERATE',      tone: 'neutral', active: gammaTrend === 'FLAT' },
      { range: 'FALLING',     label: 'WEAK MOVE',     tone: 'bear',    active: gammaTrend === 'FALLING' },
    ],
  };
  // VEGA
  const vegaEngine = {
    value: _round(vegaVal, 3),
    iv: _round(atmIv, 2),
    trend: vegaTrend,
    state: vegaTrend === 'RISING' ? 'PREMIUM EXPANSION' : vegaTrend === 'FALLING' ? 'IV CRUSH RISK' : 'NEUTRAL',
    scale: [
      { range: 'RISING',  label: 'BUYER FRIENDLY',  tone: 'bull',    active: vegaTrend === 'RISING' },
      { range: 'FLAT',    label: 'NEUTRAL',         tone: 'neutral', active: vegaTrend === 'FLAT' },
      { range: 'FALLING', label: 'SELLER FRIENDLY', tone: 'bear',    active: vegaTrend === 'FALLING' },
    ],
  };
  // THETA  (less negative = buyer friendly)
  const thetaAbs = Math.abs(thetaVal);
  const thetaDecay = thetaAbs > 15 ? 'HIGH DECAY' : thetaAbs >= 8 ? 'MEDIUM DECAY' : 'LOW DECAY';
  const thetaFriendly = thetaAbs <= 8 ? 'BUYER FRIENDLY' : thetaAbs <= 15 ? 'NEUTRAL' : 'SELLER EDGE';
  const thetaEngine = {
    value: _round(thetaVal, 3),
    trend: thetaTrend,
    decay: thetaDecay,
    friendly: thetaFriendly,
    scale: [
      { range: 'MORE NEGATIVE', label: 'SELLER EDGE', tone: 'bear',    active: thetaAbs > 15 },
      { range: 'STABLE',        label: 'NEUTRAL',     tone: 'neutral', active: thetaAbs >= 8 && thetaAbs <= 15 },
      { range: 'LESS NEGATIVE', label: 'BUYER EDGE',  tone: 'bull',    active: thetaAbs < 8 },
    ],
  };

  // Greeks all-positive (buyer-aligned) check
  const greeksPositive =
    deltaBias === 'BULLISH' && gammaTrend !== 'FALLING' && vegaTrend !== 'FALLING' && thetaAbs <= 15;

  const greeksReading = [
    { text: 'DELTA POSITIVE + PRICE ABOVE TC = BULLS IN CONTROL', tone: 'bull', active: deltaBias === 'BULLISH' && locationBias === 'BULLISH' },
    { text: 'DELTA NEGATIVE + PRICE BELOW BC = BEARS IN CONTROL', tone: 'bear', active: deltaBias === 'BEARISH' && locationBias === 'BEARISH' },
    { text: 'GAMMA RISING = MOVE ACCELERATING', tone: 'bull', active: gammaTrend === 'RISING' },
    { text: 'VEGA RISING = PREMIUM EXPANDING', tone: 'bull', active: vegaTrend === 'RISING' },
    { text: 'THETA LOW = OPTION BUYER FRIENDLY', tone: 'bull', active: thetaAbs < 8 },
  ];

  const greeksEngine = {
    delta: deltaEngine,
    gamma: gammaEngine,
    vega: vegaEngine,
    theta: thetaEngine,
    allPositive: greeksPositive,
    reading: greeksReading,
  };

  /* ═══ 5. COMPLETE LOGIC MATRIX ═══════════════════════════════════════ */
  const checks = {
    breadthStrong: breadthBias === 'BULLISH',
    itSupporting: itBias === 'BULLISH',
    priceAboveTc: locationBias === 'BULLISH',
    cprHigherValue: cprRelation.bias === 'BULLISH',
    greeksPositive: greeksPositive,
  };
  // bearish mirror
  const bearChecks = {
    breadthWeak: breadthBias === 'BEARISH',
    itDragging: itBias === 'BEARISH',
    priceBelowBc: locationBias === 'BEARISH',
    cprLowerValue: cprRelation.bias === 'BEARISH',
    greeksNegative: deltaBias === 'BEARISH',
  };
  const bullScore = Object.values(checks).filter(Boolean).length;
  const bearScore = Object.values(bearChecks).filter(Boolean).length;
  const allBull = bullScore === 5;
  const allBear = bearScore === 5;

  let marketCondition, conditionBias;
  if (allBull) { marketCondition = 'BULLS IN CONTROL — HIGH CONVICTION CE SETUP'; conditionBias = 'BULLISH'; }
  else if (allBear) { marketCondition = 'BEARS IN CONTROL — HIGH CONVICTION PE SETUP'; conditionBias = 'BEARISH'; }
  else if (bullScore >= 3 && bullScore > bearScore) { marketCondition = 'BULLISH TILT — CE SETUP FORMING'; conditionBias = 'BULLISH'; }
  else if (bearScore >= 3 && bearScore > bullScore) { marketCondition = 'BEARISH TILT — PE SETUP FORMING'; conditionBias = 'BEARISH'; }
  else { marketCondition = 'MIXED SIGNALS — WAIT FOR ALIGNMENT'; conditionBias = 'NEUTRAL'; }

  const logicMatrix = {
    rows: [
      { engine: 'BREADTH',      value: `${breadthPct}%`, verdict: breadthZone.label, tone: breadthZone.tone },
      { engine: 'IT SECTOR',    value: `${itChangePct >= 0 ? '+' : ''}${itChangePct}%`, verdict: itBias === 'BULLISH' ? 'SUPPORTING' : itBias === 'BEARISH' ? 'DRAGGING' : 'NEUTRAL', tone: itZone.tone },
      { engine: 'CPR LOCATION', value: priceLocation, verdict: locationTerritory, tone: locationBias === 'BULLISH' ? 'bull' : locationBias === 'BEARISH' ? 'bear' : 'neutral' },
      { engine: 'CPR WIDTH',    value: cprWidth.label, verdict: cprWidth.label === 'NARROW' ? 'EXPANSION LIKELY' : cprWidth.label === 'WIDE' ? 'RANGE LIKELY' : 'STANDARD', tone: cprWidth.tone },
      { engine: 'CPR RELATION', value: cprRelation.label.replace(' CPR', ''), verdict: cprRelation.bias === 'BULLISH' ? 'BULLISH STRUCTURE' : cprRelation.bias === 'BEARISH' ? 'BEARISH STRUCTURE' : 'NEUTRAL', tone: cprRelation.bias === 'BULLISH' ? 'bull' : cprRelation.bias === 'BEARISH' ? 'bear' : 'neutral' },
      { engine: 'GREEKS (ATM)', value: `Δ ${_fmtSigned(deltaVal, 2)}  Γ ${_fmtSigned(gammaVal, 3)}  V ${_fmtSigned(vegaVal, 3)}  Θ ${_fmtSigned(thetaVal, 3)}`, verdict: greeksPositive ? 'ALL POSITIVE' : deltaBias === 'BEARISH' ? 'NEGATIVE' : 'MIXED', tone: greeksPositive ? 'bull' : deltaBias === 'BEARISH' ? 'bear' : 'neutral', greeks: true },
    ],
    condition: marketCondition,
    conditionBias,
    summary: [
      { label: 'BREADTH STRONG',     ok: checks.breadthStrong || bearChecks.breadthWeak },
      { label: 'IT SUPPORTING INDEX', ok: checks.itSupporting || bearChecks.itDragging },
      { label: 'PRICE ABOVE TC',     ok: checks.priceAboveTc || bearChecks.priceBelowBc },
      { label: 'CPR HIGHER VALUE',   ok: checks.cprHigherValue || bearChecks.cprLowerValue },
      { label: 'GREEKS ALL POSITIVE', ok: checks.greeksPositive || bearChecks.greeksNegative },
    ],
    allAlign: allBull || allBear,
    alignText: allBull ? 'ALL SYSTEMS ALIGN' : allBear ? 'ALL SYSTEMS ALIGN' : `${Math.max(bullScore, bearScore)} / 5 ALIGNED`,
  };

  /* ═══ 6. FINAL VERDICT ═══════════════════════════════════════════════ */
  const dominantScore = Math.max(bullScore, bearScore);
  const confidence10 = _clamp(Math.round(4 + dominantScore * 1.1 + (vix < 14 ? 0.5 : 0)), 1, 10);
  const stars = _clamp(Math.round(dominantScore), 1, 5);

  let setup, setupBias, tradePlan;
  if (conditionBias === 'BULLISH') {
    setup = 'CE BUY SETUP'; setupBias = 'BULLISH';
    tradePlan = allBull ? 'BUY CE ON DIP' : 'BUY CE ON CONFIRMATION';
  } else if (conditionBias === 'BEARISH') {
    setup = 'PE BUY SETUP'; setupBias = 'BEARISH';
    tradePlan = allBear ? 'BUY PE ON RISE' : 'BUY PE ON CONFIRMATION';
  } else {
    setup = 'NO TRADE SETUP'; setupBias = 'NEUTRAL';
    tradePlan = 'WAIT FOR ALIGNMENT';
  }

  const finalVerdict = {
    setup,
    bias: setupBias,
    stars,
    confidence: confidence10,
    confidenceText: `${confidence10} / 10`,
    cells: [
      { label: 'TREND',       value: trendBias === 'BULLISH' ? 'UP' : trendBias === 'BEARISH' ? 'DOWN' : 'FLAT', icon: trendBias === 'BULLISH' ? 'up' : trendBias === 'BEARISH' ? 'down' : 'flat', tone: trendBias === 'BULLISH' ? 'bull' : trendBias === 'BEARISH' ? 'bear' : 'neutral' },
      { label: 'STRENGTH',    value: dominantScore >= 4 ? 'STRONG' : dominantScore >= 3 ? 'MODERATE' : 'WEAK', tone: dominantScore >= 4 ? 'bull' : dominantScore >= 3 ? 'neutral' : 'bear' },
      { label: 'MOMENTUM',    value: gammaTrend === 'RISING' ? 'RISING' : gammaTrend === 'FALLING' ? 'FADING' : 'STEADY', tone: gammaTrend === 'RISING' ? 'bull' : gammaTrend === 'FALLING' ? 'bear' : 'neutral' },
      { label: 'MARKET MODE', value: marketMode.state, tone: marketMode.state === 'RISK ON' ? 'bull' : marketMode.state === 'RISK OFF' ? 'bear' : 'neutral' },
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
    logicMatrix,
    finalVerdict,

    goldenRule: 'BREADTH TELLS THE TRUTH · CPR TELLS THE LOCATION · GREEKS CONFIRM THE STRENGTH',

    debug: {
      bullScore, bearScore, trendBias, conditionBias,
      itMembersFound: itStocks.length,
      historySamples: hist.length,
    },
  };
}

function _fmtSigned(n, d) {
  const v = _round(n, d);
  return `${v >= 0 ? '+' : ''}${v}`;
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
