/* ─────────────────────────────────────────────────────────────────────
 * ORDER FLOW INTEL ENGINE — Standalone Service
 * ========================================================================
 * "Side-View Logic Dashboard" — answers: WHO IS ATTACKING · WHO IS
 * ABSORBING · WHO IS TRAPPED · WHO IS WINNING — and forecasts reversal
 * probability per strike.
 *
 * Inputs (all derived from V2 + raw option chain · ATM ± 6 round strikes):
 *   1. Aggression       — buy vs sell volume share (V2 delta block)
 *   2. Delta            — net delta (totalBuy − totalSell)
 *   3. Absorption       — Δ↑ + price flat = SELLER absorption (top)
 *                          Δ↓ + price flat = BUYER  absorption (bottom)
 *   4. Exhaustion       — new HH with falling Δ = buyer exhaustion
 *   5. Trap             — failed break above VAH / below VAL + reversal
 *   6. Premium Accept   — spot Δ vs ATM CE/PE premium move agreement
 *   7. Flow Alignment   — Spot vs CE vs PE side matrix
 *   8. Inst Footprint   — FRVP zone + Δ + absorption
 *
 * Endpoint:  GET /api/order-flow?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelV2 = require('./intelV2.service');
const symbolRegistry = require('../config/symbolRegistry');

function _safe(n, d = 0) { const x = Number(n); return Number.isFinite(x) ? x : d; }
function _round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function _clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* ─── Per-symbol rolling history ──────────────────────────────────────
 * Used to detect divergence (price up, delta down → bearish absorption),
 * exhaustion (new HH with weaker delta), and per-strike CE/PE premium
 * acceptance over the prior ~6 minutes. */
const _flowHistory = new Map(); // symbol → [{ t, spot, deltaPct, netDelta, cumDelta, ceLtpAtm, peLtpAtm, strikes:{[strike]:{ceLtp,peLtp,ceOi,peOi}} }]
const FLOW_HISTORY_MAX = 80;
const FLOW_TTL_MS = 30 * 60_000;

/* ═════════════════════════════════════════════════════════════════════
 *  Helpers
 * ═════════════════════════════════════════════════════════════════════ */

/**
 * Build a candle-direction × volume "delta" series, mirroring V2's
 * _deltaFromCandles but operating on the candles we already have.
 */
function _deltaFromCandles(candles) {
  if (!Array.isArray(candles) || !candles.length) {
    return { totalBuy: 0, totalSell: 0, netDelta: 0, deltaPct: 0, cvd: 0 };
  }
  let buyV = 0, sellV = 0, cum = 0;
  const series = [];
  for (const c of candles) {
    const v = _safe(c.volume);
    const dir = (_safe(c.close) >= _safe(c.open)) ? 1 : -1;
    if (dir > 0) buyV += v; else sellV += v;
    cum += dir * v;
    series.push({ t: _safe(c.time ?? c.timestamp), cvd: cum });
  }
  const total = buyV + sellV || 1;
  const deltaPct = ((buyV - sellV) / total) * 100;
  return {
    totalBuy: buyV,
    totalSell: sellV,
    netDelta: buyV - sellV,
    deltaPct: _round(deltaPct, 2),
    cvd: cum,
    series,
  };
}

/* ═════════════════════════════════════════════════════════════════════
 *  GET /api/order-flow
 * ═════════════════════════════════════════════════════════════════════ */
async function getOrderFlow({ symbol = 'NIFTY_50', date = null } = {}) {
  const SYMBOL = String(symbol).toUpperCase();
  const sym = symbolRegistry.getSymbol(SYMBOL);
  if (!sym) return { ok: false, error: `Unsupported symbol: ${SYMBOL}` };

  const v2 = await intelV2.getSnapshot({ symbol: SYMBOL, date });
  if (!v2 || !v2.ok) return { ok: false, error: 'V2 snapshot unavailable' };

  const usedDate = v2.date;
  const isToday = !!v2.isToday;
  const spot = _safe(v2.spot?.ltp);
  const spotChange = _safe(v2.spot?.change);
  const spotChangePct = _safe(v2.spot?.changePct);
  const dayHigh = _safe(v2.spot?.dayHigh);
  const dayLow  = _safe(v2.spot?.dayLow);
  const vwap = _safe(v2.spot?.vwap);
  const atm = _safe(v2.options?.atm);
  const step = sym.strikeStep || 50;

  // FRVP / acceptance
  const vol = v2.flow?.volume || null;
  const poc = _safe(vol?.poc);
  const vah = _safe(vol?.vah);
  const val = _safe(vol?.val);
  const frvpEng = v2.dashboard?.frvpInstitutional?.engine || null;
  const acc = frvpEng?.acceptance || {};
  const acceptedAboveVah = !!acc.acceptedAboveVAH;
  const acceptedBelowVal = !!acc.acceptedBelowVAL;
  const rejectedAboveVah = !!acc.rejectedAboveVAH;
  const rejectedBelowVal = !!acc.rejectedBelowVAL;
  let auctionZone = 'UNKNOWN';
  if (vah && val && spot > vah) auctionZone = 'ABOVE VALUE';
  else if (vah && val && spot < val) auctionZone = 'BELOW VALUE';
  else if (poc) auctionZone = 'INSIDE VALUE';

  // Flow / delta from V2
  const flowDelta = v2.flow?.delta || {};
  const buyerSellerFlow = v2.dashboard?.buyerSellerFlow || null;
  const cprBlk = v2.cpr || {};
  const cprTc = _safe(cprBlk.tc);
  const cprBc = _safe(cprBlk.bc);

  // Re-load the option chain so we can access the FULL strikes list.
  // V2 only surfaces atmCall / atmPut / walls / atm via `v2.options`, not the
  // raw chain. The `__internals._loadOptionChain` helper handles the live
  // vs folder fallback automatically.
  const I = intelV2.__internals || {};
  const authKey = I._activeAuthKey ? I._activeAuthKey() : null;
  let chain = null;
  try {
    if (typeof I._loadOptionChain === 'function') {
      chain = await I._loadOptionChain(authKey, sym, usedDate, isToday);
    }
  } catch (_) { /* best effort */ }
  // Historical fallback: try TODAY's chain if the date's folder is empty.
  const _hasUsable = (c) => c && Array.isArray(c.strikes) && c.strikes.length > 0
    && c.strikes.some((s) => (s?.call?.securityId ?? s?.ce?.securityId) || (s?.put?.securityId ?? s?.pe?.securityId));
  if (!_hasUsable(chain) && !isToday) {
    try {
      const live = await I._loadOptionChain(authKey, sym, null, true);
      if (_hasUsable(live)) chain = live;
    } catch (_) { /* noop */ }
  }
  const rawStrikes = chain && Array.isArray(chain.strikes) ? chain.strikes : [];

  // Build a wider ATM ± 6 ladder so each round-100 strike has CE/PE legs.
  // Falls back to V2's ATM ± 4 ladder if _strikeLadder isn't exported.
  const overallBias = (v2.bias?.overallBias === 'bullish' || v2.bias?.overallBias === 'bearish') ? v2.bias.overallBias : 'neutral';
  let wideLadder = Array.isArray(v2.ladder) ? v2.ladder : [];
  try {
    if (typeof I._strikeLadder === 'function' && rawStrikes.length && atm) {
      const wider = I._strikeLadder(rawStrikes, atm, 6, overallBias);
      if (Array.isArray(wider) && wider.length) wideLadder = wider;
    }
  } catch (_) { /* noop */ }

  // Round-step (100) anchor for the strike grid. Walk symmetrically so the
  // grid always lands on round-100 strikes (matches strike-table / chart).
  const ROUND_STEP = 100;
  const anchor = atm ? Math.round(atm / ROUND_STEP) * ROUND_STEP : 0;
  const ladderByStrike = new Map();
  for (const r of wideLadder) ladderByStrike.set(Number(r.strike), r);
  const targetStrikes = [];
  for (let i = -6; i <= 6; i++) {
    const k = anchor + i * ROUND_STEP;
    if (k > 0) targetStrikes.push(k);
  }

  /* ── 1. AGGRESSION CARD ─────────────────────────────────────────── */
  const totalBuy = _safe(flowDelta.totalBuy);
  const totalSell = _safe(flowDelta.totalSell);
  const totalVol = totalBuy + totalSell || 1;
  const buyDomPct  = Math.round((totalBuy  / totalVol) * 100);
  const sellDomPct = 100 - buyDomPct;
  const aggression = {
    buyVol: Math.round(totalBuy),
    sellVol: Math.round(totalSell),
    buyDomPct,
    sellDomPct,
    side: buyDomPct >= 58 ? 'BUYERS' : sellDomPct >= 58 ? 'SELLERS' : 'BALANCED',
    verdict: buyDomPct >= 58 ? 'BUYERS ATTACKING'
      : sellDomPct >= 58 ? 'SELLERS ATTACKING' : 'NEUTRAL FLOW',
    tone: buyDomPct >= 58 ? 'bull' : sellDomPct >= 58 ? 'bear' : 'neutral',
  };

  /* ── 2. DELTA CARD ──────────────────────────────────────────────── */
  const netDelta = _safe(flowDelta.netDelta, totalBuy - totalSell);
  const deltaPct = _safe(flowDelta.deltaPct);
  const delta = {
    value: Math.round(netDelta),
    pct: _round(deltaPct, 1),
    buyVol: Math.round(totalBuy),
    sellVol: Math.round(totalSell),
    side: deltaPct > 8 ? 'BUYERS' : deltaPct < -8 ? 'SELLERS' : 'BALANCED',
    verdict: deltaPct > 20 ? 'STRONG BULLISH' : deltaPct > 5 ? 'AGGRESSIVE BUYERS'
      : deltaPct < -20 ? 'STRONG BEARISH' : deltaPct < -5 ? 'AGGRESSIVE SELLERS' : 'NEUTRAL',
    tone: deltaPct > 20 ? 'strongbull' : deltaPct > 5 ? 'bull'
      : deltaPct < -20 ? 'strongbear' : deltaPct < -5 ? 'bear' : 'neutral',
  };

  /* ── Push history snapshot ──────────────────────────────────────── */
  const now = Date.now();
  const atmRow = wideLadder.find((r) => r.isAtm) || ladderByStrike.get(atm) || null;
  const ceLtpAtm = _safe(atmRow?.ce?.ltp);
  const peLtpAtm = _safe(atmRow?.pe?.ltp);
  const strikeSnap = {};
  for (const r of wideLadder) {
    strikeSnap[r.strike] = {
      ceLtp: _safe(r.ce?.ltp), peLtp: _safe(r.pe?.ltp),
      ceOi:  _safe(r.ce?.oi),  peOi:  _safe(r.pe?.oi),
    };
  }
  const trail = _flowHistory.get(SYMBOL) || [];
  trail.push({ t: now, spot, deltaPct, netDelta, cumDelta: _safe(flowDelta.cvd), ceLtpAtm, peLtpAtm, strikes: strikeSnap });
  while (trail.length && (now - trail[0].t) > FLOW_TTL_MS) trail.shift();
  while (trail.length > FLOW_HISTORY_MAX) trail.shift();
  _flowHistory.set(SYMBOL, trail);

  // Baseline ~6 min back
  let base = null;
  if (trail.length >= 3) {
    const target = now - 6 * 60_000;
    let best = trail[0], bestDist = Math.abs(best.t - target);
    for (let i = 1; i < trail.length - 1; i++) {
      const d = Math.abs(trail[i].t - target);
      if (d < bestDist) { bestDist = d; best = trail[i]; }
    }
    base = best;
  }
  const cumDelta = _safe(flowDelta.cvd);
  const cumDeltaTrend = (() => {
    if (!base) return 'FLAT';
    const drift = cumDelta - _safe(base.cumDelta);
    if (drift > 1) return 'RISING';
    if (drift < -1) return 'FALLING';
    return 'FLAT';
  })();

  /* ── 3. ABSORPTION DETECTOR ─────────────────────────────────────── */
  const priceMovePct = base && base.spot > 0 ? ((spot - base.spot) / base.spot) * 100 : 0;
  let absorption;
  if (deltaPct > 12 && priceMovePct < 0.05) {
    absorption = { state: 'SELLER ABSORPTION', side: 'PE', tone: 'bear', score: 30,
      verdict: 'HIDDEN SELLER FOUND',
      desc: 'Buyers aggressive but price not rising — institutional selling into strength.' };
  } else if (deltaPct < -12 && priceMovePct > -0.05) {
    absorption = { state: 'BUYER ABSORPTION', side: 'CE', tone: 'bull', score: 30,
      verdict: 'HIDDEN BUYER FOUND',
      desc: 'Sellers aggressive but price not falling — institutional buying into weakness.' };
  } else {
    absorption = { state: 'NONE', side: 'NEUTRAL', tone: 'neutral', score: 0,
      verdict: 'NO ABSORPTION',
      desc: 'Price and delta moving together — no hidden interest.' };
  }

  /* ── 4. EXHAUSTION DETECTOR ─────────────────────────────────────── */
  const nearDayHigh = dayHigh > 0 && Math.abs(spot - dayHigh) <= dayHigh * 0.0008;
  const nearDayLow  = dayLow  > 0 && Math.abs(spot - dayLow)  <= dayLow  * 0.0008;
  const baseDeltaAbs = base ? Math.abs(_safe(base.deltaPct)) : 0;
  const deltaWeakening = base && (Math.abs(deltaPct) + 5 < baseDeltaAbs);
  let exhaustion;
  if (nearDayHigh && deltaPct > 0 && deltaWeakening) {
    exhaustion = { state: 'BUYER EXHAUSTION', side: 'PE', tone: 'bear', score: 25,
      verdict: 'BUY EXHAUSTION',
      desc: 'New high but delta fading — long unwinding likely.' };
  } else if (nearDayLow && deltaPct < 0 && deltaWeakening) {
    exhaustion = { state: 'SELLER EXHAUSTION', side: 'CE', tone: 'bull', score: 25,
      verdict: 'SELL EXHAUSTION',
      desc: 'New low but delta improving — short covering likely.' };
  } else {
    exhaustion = { state: 'NONE', side: 'NEUTRAL', tone: 'neutral', score: 0,
      verdict: 'MOMENTUM INTACT',
      desc: 'No exhaustion footprint.' };
  }

  /* ── 5. TRAP DETECTOR ───────────────────────────────────────────── */
  let trap;
  if (rejectedAboveVah || (nearDayHigh && deltaPct < 0)) {
    trap = { side: 'BUYERS_TRAPPED', label: 'BUYER TRAP', tone: 'bear', score: 25,
      probabilityBuyer: 72, probabilitySeller: 28,
      verdict: 'BUYER TRAP HIGH',
      desc: 'Price failed above breakout — aggressive buyers trapped, bearish reversal risk.' };
  } else if (rejectedBelowVal || (nearDayLow && deltaPct > 0)) {
    trap = { side: 'SELLERS_TRAPPED', label: 'SELLER TRAP', tone: 'bull', score: 25,
      probabilityBuyer: 28, probabilitySeller: 72,
      verdict: 'SELLER TRAP LOW',
      desc: 'Price failed below breakdown — aggressive sellers trapped, bullish reversal risk.' };
  } else {
    trap = { side: 'NONE', label: 'NO TRAP', tone: 'neutral', score: 0,
      probabilityBuyer: 50, probabilitySeller: 50,
      verdict: 'NO TRAP DETECTED',
      desc: 'No failed-breakout structure.' };
  }

  /* ── 6. PREMIUM ACCEPTANCE ──────────────────────────────────────── */
  const cePctMove = (base && base.ceLtpAtm > 0) ? ((ceLtpAtm - base.ceLtpAtm) / base.ceLtpAtm) * 100 : 0;
  const pePctMove = (base && base.peLtpAtm > 0) ? ((peLtpAtm - base.peLtpAtm) / base.peLtpAtm) * 100 : 0;
  let premiumAccept;
  if (deltaPct > 5 && cePctMove > 2) {
    premiumAccept = { state: 'OPTION ACCEPTANCE', side: 'CE', tone: 'bull', score: 15,
      verdict: 'CE PREMIUM RISING', desc: 'Spot buying confirmed by CE premium expansion.' };
  } else if (deltaPct < -5 && pePctMove > 2) {
    premiumAccept = { state: 'OPTION ACCEPTANCE', side: 'PE', tone: 'bear', score: 15,
      verdict: 'PE PREMIUM RISING', desc: 'Spot selling confirmed by PE premium expansion.' };
  } else if (deltaPct > 5 && cePctMove < 0) {
    premiumAccept = { state: 'NO ACCEPTANCE', side: 'NEUTRAL', tone: 'bear', score: 0,
      verdict: 'CE PREMIUM FALLING', desc: 'Spot up but CE fading — weak rally.' };
  } else if (deltaPct < -5 && pePctMove < 0) {
    premiumAccept = { state: 'NO ACCEPTANCE', side: 'NEUTRAL', tone: 'bull', score: 0,
      verdict: 'PE PREMIUM FALLING', desc: 'Spot down but PE fading — weak decline.' };
  } else {
    premiumAccept = { state: 'WAITING', side: 'NEUTRAL', tone: 'neutral', score: 5,
      verdict: 'PREMIUM FLAT', desc: 'No clear premium acceptance yet.' };
  }
  const spotDeltaCard = {
    spotDelta:    Math.round(netDelta),
    atmCeDelta:   Math.round(ceLtpAtm * 1_000),  // illustrative rupee×qty proxy
    atmPeDelta:   Math.round(peLtpAtm * 1_000),
    cePctMove: _round(cePctMove, 2),
    pePctMove: _round(pePctMove, 2),
  };

  /* ── 7. FLOW ALIGNMENT MATRIX ───────────────────────────────────── */
  const spotSide = deltaPct > 5 ? 'BUY' : deltaPct < -5 ? 'SELL' : 'FLAT';
  const ceBuyersPct = _safe(buyerSellerFlow?.ce?.buyersPct, 50);
  const peBuyersPct = _safe(buyerSellerFlow?.pe?.buyersPct, 50);
  const ceSide = ceBuyersPct >= 58 ? 'BUY' : ceBuyersPct <= 42 ? 'SELL' : 'FLAT';
  const peSide = peBuyersPct >= 58 ? 'BUY' : peBuyersPct <= 42 ? 'SELL' : 'FLAT';
  let flowVerdict, flowTone, flowScore;
  if (spotSide === 'BUY' && ceSide === 'BUY' && peSide === 'SELL')      { flowVerdict = 'STRONG BULL'; flowTone = 'strongbull'; flowScore = 10; }
  else if (spotSide === 'SELL' && ceSide === 'SELL' && peSide === 'BUY'){ flowVerdict = 'STRONG BEAR'; flowTone = 'strongbear'; flowScore = 10; }
  else if (spotSide === 'BUY' && (ceSide === 'BUY' || peSide === 'SELL')) { flowVerdict = 'WEAK BULL'; flowTone = 'bull'; flowScore = 6; }
  else if (spotSide === 'SELL' && (ceSide === 'SELL' || peSide === 'BUY')) { flowVerdict = 'WEAK BEAR'; flowTone = 'bear'; flowScore = 6; }
  else { flowVerdict = 'NEUTRAL'; flowTone = 'neutral'; flowScore = 0; }
  const flowAlignment = {
    spot: spotSide, ce: ceSide, pe: peSide,
    ceBuyersPct, peBuyersPct,
    verdict: flowVerdict, tone: flowTone, score: flowScore,
    desc: `Spot ${spotSide} · CE ${ceSide} · PE ${peSide}`,
    rows: [
      { spot: 'BUY',  ce: 'BUY',  pe: 'SELL', verdict: 'STRONG BULL', tone: 'strongbull', active: spotSide === 'BUY'  && ceSide === 'BUY'  && peSide === 'SELL' },
      { spot: 'SELL', ce: 'SELL', pe: 'BUY',  verdict: 'STRONG BEAR', tone: 'strongbear', active: spotSide === 'SELL' && ceSide === 'SELL' && peSide === 'BUY'  },
      { spot: 'BUY',  ce: 'BUY',  pe: 'FLAT', verdict: 'WEAK BULL',   tone: 'bull',       active: spotSide === 'BUY'  && ceSide === 'BUY'  && peSide === 'FLAT' },
      { spot: 'SELL', ce: 'SELL', pe: 'FLAT', verdict: 'WEAK BEAR',   tone: 'bear',       active: spotSide === 'SELL' && ceSide === 'SELL' && peSide === 'FLAT' },
      { spot: 'FLAT', ce: 'FLAT', pe: 'FLAT', verdict: 'NEUTRAL',     tone: 'neutral',    active: spotSide === 'FLAT' && ceSide === 'FLAT' && peSide === 'FLAT' },
    ],
  };

  /* ── 8. INSTITUTIONAL FOOTPRINT ─────────────────────────────────── */
  let footprint;
  if (auctionZone === 'BELOW VALUE' && absorption.state === 'BUYER ABSORPTION') {
    footprint = { signal: 'INSTITUTIONAL BUYER ACTIVE', tone: 'strongbull', score: 10,
      desc: 'Spot at VAL + buyer absorption — accumulation footprint.' };
  } else if (auctionZone === 'ABOVE VALUE' && absorption.state === 'SELLER ABSORPTION') {
    footprint = { signal: 'INSTITUTIONAL SELLER ACTIVE', tone: 'strongbear', score: 10,
      desc: 'Spot at VAH + seller absorption — distribution footprint.' };
  } else if (auctionZone === 'ABOVE VALUE' && deltaPct > 5) {
    footprint = { signal: 'INITIATIVE BUYERS', tone: 'bull', score: 6,
      desc: 'Buyers driving above value.' };
  } else if (auctionZone === 'BELOW VALUE' && deltaPct < -5) {
    footprint = { signal: 'INITIATIVE SELLERS', tone: 'bear', score: 6,
      desc: 'Sellers driving below value.' };
  } else {
    footprint = { signal: 'NO INSTITUTIONAL EDGE', tone: 'neutral', score: 0,
      desc: 'Two-sided auction inside value.' };
  }
  // Normalised "delta trend" sparkline label for the institutional footprint
  // mini-sparkline.
  const footprintExtra = {
    frvpZone: auctionZone,
    deltaTrend: cumDeltaTrend,
    absorptionSignal: absorption.state,
    activity: footprint.signal,
  };

  /* ── COMPOSITE BUYER / SELLER POWER ─────────────────────────────── */
  // Each card pushes points toward buyers or sellers based on tone.
  const cards = [
    { tone: aggression.tone,     points: 15 },
    { tone: delta.tone,           points: 30 },
    { tone: absorption.tone,      points: absorption.score },
    { tone: exhaustion.tone,      points: exhaustion.score },
    { tone: trap.tone,            points: trap.score },
    { tone: premiumAccept.tone,   points: premiumAccept.score },
    { tone: flowAlignment.tone,   points: flowAlignment.score },
    { tone: footprint.tone,       points: footprint.score },
  ];
  let buyerPts = 50, sellerPts = 50;
  for (const c of cards) {
    if (!c.points) continue;
    if (c.tone === 'strongbull')      { buyerPts += c.points;       sellerPts -= c.points * 0.6; }
    else if (c.tone === 'bull')        { buyerPts += c.points * 0.7; sellerPts -= c.points * 0.4; }
    else if (c.tone === 'strongbear')  { sellerPts += c.points;      buyerPts  -= c.points * 0.6; }
    else if (c.tone === 'bear')        { sellerPts += c.points * 0.7; buyerPts -= c.points * 0.4; }
  }
  const buyerPower  = _clamp(Math.round(buyerPts),  0, 100);
  const sellerPower = _clamp(Math.round(sellerPts), 0, 100);
  const score = _clamp(Math.round(50 + (buyerPower - sellerPower) * 0.5), 0, 100);

  let bias, side, state, tone, verdict;
  if (score >= 80)      { bias = 'BULLISH'; side = 'CE'; state = 'STRONG BULL';   tone = 'strongbull'; verdict = 'BUY CE'; }
  else if (score >= 60) { bias = 'BULLISH'; side = 'CE'; state = 'BULL';           tone = 'bull';       verdict = 'BUY CE'; }
  else if (score > 40)  { bias = 'NEUTRAL'; side = 'NEUTRAL'; state = 'NEUTRAL';   tone = 'neutral';    verdict = 'WAIT'; }
  else if (score >= 20) { bias = 'BEARISH'; side = 'PE'; state = 'BEAR';           tone = 'bear';       verdict = 'BUY PE'; }
  else                  { bias = 'BEARISH'; side = 'PE'; state = 'STRONG BEAR';   tone = 'strongbear'; verdict = 'BUY PE'; }

  /* ── ORDER FLOW SCORE ENGINE — weighted breakdown for the donut ── */
  // Mirrors the reference image: Buyer Aggression 25 · Seller Absorption 25 ·
  // Premium Acceptance 25 · Flow Alignment 25.
  const buyerAggressionScore  = _clamp(Math.round(50 + deltaPct * 1.5 + (aggression.tone === 'bull' || aggression.tone === 'strongbull' ? 20 : aggression.tone === 'bear' || aggression.tone === 'strongbear' ? -20 : 0)), 0, 100);
  const sellerAbsorptionScore = absorption.state === 'BUYER ABSORPTION' ? 80
    : absorption.state === 'SELLER ABSORPTION' ? 25
    : 50;
  const premiumAcceptanceScore = premiumAccept.state === 'OPTION ACCEPTANCE' && (premiumAccept.side === side) ? 80
    : premiumAccept.state === 'NO ACCEPTANCE' ? 30
    : 60;
  const flowAlignmentScore = flowAlignment.tone === 'strongbull' ? 90
    : flowAlignment.tone === 'bull' ? 70
    : flowAlignment.tone === 'strongbear' ? 10
    : flowAlignment.tone === 'bear' ? 30
    : 50;
  const scoreBreakdown = {
    buyerAggression:    { score: buyerAggressionScore,    weight: 25 },
    sellerAbsorption:   { score: sellerAbsorptionScore,   weight: 25 },
    premiumAcceptance:  { score: premiumAcceptanceScore,  weight: 25 },
    flowAlignment:      { score: flowAlignmentScore,      weight: 25 },
  };
  const weightedScore = _clamp(Math.round(
    (buyerAggressionScore * 25 + sellerAbsorptionScore * 25 + premiumAcceptanceScore * 25 + flowAlignmentScore * 25) / 100
  ), 0, 100);

  /* ── REVERSAL PROBABILITY (per side) ────────────────────────────── */
  // Combines absorption + exhaustion + trap + delta divergence + FRVP rejection
  // into a single 0..100 reversal probability for each side.
  function reversalProb(towardSide) {
    let p = 0;
    if (absorption.side === towardSide) p += 25;
    if (exhaustion.side === towardSide) p += 20;
    if (trap.tone === (towardSide === 'CE' ? 'bull' : 'bear')) p += 25;
    // Hidden-direction tag (price up, delta falling = hidden weakness for CE-long → reversal toward PE)
    if (base) {
      const priceUp = (spot > base.spot);
      const cumFalling = cumDeltaTrend === 'FALLING';
      const cumRising  = cumDeltaTrend === 'RISING';
      if (towardSide === 'PE' && priceUp && cumFalling) p += 15;
      if (towardSide === 'CE' && !priceUp && cumRising) p += 15;
    }
    if (towardSide === 'PE' && rejectedAboveVah) p += 15;
    if (towardSide === 'CE' && rejectedBelowVal) p += 15;
    return _clamp(p, 0, 100);
  }
  const reversal = {
    bullishProb: reversalProb('CE'),     // probability of UPSIDE reversal
    bearishProb: reversalProb('PE'),     // probability of DOWNSIDE reversal
    bias: 'NEUTRAL',
    label: 'NO REVERSAL SIGNAL',
    tone: 'neutral',
    desc: 'No strong reversal footprint detected.',
  };
  if (reversal.bullishProb >= 60 && reversal.bullishProb > reversal.bearishProb + 15) {
    reversal.bias = 'BULLISH'; reversal.label = 'BULLISH REVERSAL LOADING'; reversal.tone = 'bull';
    reversal.desc = 'Absorption + exhaustion + traps stacking on the buy side.';
  } else if (reversal.bearishProb >= 60 && reversal.bearishProb > reversal.bullishProb + 15) {
    reversal.bias = 'BEARISH'; reversal.label = 'BEARISH REVERSAL LOADING'; reversal.tone = 'bear';
    reversal.desc = 'Absorption + exhaustion + traps stacking on the sell side.';
  }

  /* ── PER-STRIKE CE/PE BUY OR PE BUY DECISION (ATM ± 6 round-100) ── */
  // For each of the 13 round strikes, fuse OI Δ + premium Δ + own buildup
  // tag into a single CE BUY / PE BUY / WAIT verdict + per-strike score.
  // Reversal probability is computed per row using the strike's OI shift
  // (writers being unwound is the strongest reversal signal for buyers).
  const baseStrikes = base?.strikes || {};
  const strikes = targetStrikes.map((k) => {
    const r = ladderByStrike.get(k);
    const ce = r?.ce || {};
    const pe = r?.pe || {};
    const prev = baseStrikes[k] || null;
    const ceLtp = _safe(ce.ltp);
    const peLtp = _safe(pe.ltp);
    const ceOi = _safe(ce.oi);
    const peOi = _safe(pe.oi);
    const ceVol = _safe(ce.volume);
    const peVol = _safe(pe.volume);
    const ceOiChg = _safe(ce.oiChange);
    const peOiChg = _safe(pe.oiChange);
    const cePremPct = (prev && prev.ceLtp > 0) ? ((ceLtp - prev.ceLtp) / prev.ceLtp) * 100 : 0;
    const pePremPct = (prev && prev.peLtp > 0) ? ((peLtp - prev.peLtp) / prev.peLtp) * 100 : 0;
    const ceOiPct   = (prev && prev.ceOi  > 0) ? ((ceOi  - prev.ceOi ) / prev.ceOi ) * 100 : 0;
    const peOiPct   = (prev && prev.peOi  > 0) ? ((peOi  - prev.peOi ) / prev.peOi ) * 100 : 0;

    // CE BUY score (0..100):
    //   • CE premium rising — 30
    //   • CE OI falling (call writers covering)        — 25
    //   • PE OI rising (put writers entering)          — 20
    //   • PE premium falling                           — 15
    //   • Volume burst                                 — 10
    let ceScore = 0;
    if (cePremPct >= 4) ceScore += 30; else if (cePremPct >= 1) ceScore += 18;
    if (ceOiChg < 0)    ceScore += 25; else if (ceOiPct < -1) ceScore += 12;
    if (peOiChg > 0)    ceScore += 20; else if (peOiPct > 1) ceScore += 10;
    if (pePremPct < -2) ceScore += 15; else if (pePremPct < 0) ceScore += 7;
    if (ceVol > 100_000) ceScore += 10; else if (ceVol > 20_000) ceScore += 5;
    ceScore = _clamp(ceScore, 0, 100);

    // PE BUY score (mirror).
    let peScore = 0;
    if (pePremPct >= 4) peScore += 30; else if (pePremPct >= 1) peScore += 18;
    if (peOiChg < 0)    peScore += 25; else if (peOiPct < -1) peScore += 12;
    if (ceOiChg > 0)    peScore += 20; else if (ceOiPct > 1) peScore += 10;
    if (cePremPct < -2) peScore += 15; else if (cePremPct < 0) peScore += 7;
    if (peVol > 100_000) peScore += 10; else if (peVol > 20_000) peScore += 5;
    peScore = _clamp(peScore, 0, 100);

    // Per-strike reversal probability — compares signed OI flips on either
    // side. Big PE OI add + spot near low = high upside reversal probability.
    let reversalProbPct = 0;
    if (k <= spot && peOiChg > 0 && cePremPct > 0) reversalProbPct = Math.min(85, 50 + ceScore / 4);
    else if (k >= spot && ceOiChg > 0 && pePremPct > 0) reversalProbPct = Math.min(85, 50 + peScore / 4);
    else reversalProbPct = Math.max(15, Math.round(((Math.abs(ceScore - peScore)) / 2)));

    let action, actionTone;
    if (ceScore >= 60 && ceScore > peScore + 12) { action = 'BUY CE'; actionTone = 'bull'; }
    else if (peScore >= 60 && peScore > ceScore + 12) { action = 'BUY PE'; actionTone = 'bear'; }
    else { action = 'WAIT'; actionTone = 'neutral'; }

    const moneynessCe = k < spot ? 'ITM' : k > spot ? 'OTM' : 'ATM';
    const moneynessPe = k > spot ? 'ITM' : k < spot ? 'OTM' : 'ATM';

    return {
      strike: k,
      isAtm: k === atm,
      isAtmRound: Math.abs(k - anchor) < 1,
      offset: Math.round((k - anchor) / ROUND_STEP),
      moneynessCe,
      moneynessPe,
      ce: {
        ltp: _round(ceLtp, 2), oi: ceOi, oiChange: ceOiChg, volume: ceVol,
        premPct: _round(cePremPct, 2), oiPct: _round(ceOiPct, 2),
        score: ceScore,
      },
      pe: {
        ltp: _round(peLtp, 2), oi: peOi, oiChange: peOiChg, volume: peVol,
        premPct: _round(pePremPct, 2), oiPct: _round(peOiPct, 2),
        score: peScore,
      },
      action,
      actionTone,
      reversalProb: Math.round(reversalProbPct),
      reasoning: action === 'BUY CE'
        ? 'CE premium expanding + writers covering → call buyers active'
        : action === 'BUY PE'
        ? 'PE premium expanding + writers covering → put buyers active'
        : 'No clear directional edge — wait for one side to dominate',
    };
  });

  /* ── WHO IS WINNING (aggregate verdict) ─────────────────────────── */
  const decision = (() => {
    const ceWinners = strikes.filter((s) => s.action === 'BUY CE').length;
    const peWinners = strikes.filter((s) => s.action === 'BUY PE').length;
    const total = strikes.length || 1;
    const ceShare = Math.round((ceWinners / total) * 100);
    const peShare = Math.round((peWinners / total) * 100);
    let action, tone;
    if (score >= 70 && ceShare >= peShare) { action = 'BUY CE'; tone = 'bull'; }
    else if (score <= 30 && peShare >= ceShare) { action = 'BUY PE'; tone = 'bear'; }
    else { action = 'WAIT'; tone = 'neutral'; }
    return {
      action,
      tone,
      ceWinners, peWinners, ceShare, peShare,
      summary: action === 'BUY CE' ? 'BUYERS in control across most strikes'
        : action === 'BUY PE' ? 'SELLERS in control across most strikes'
        : 'Two-sided auction — no clear dominance',
    };
  })();

  return {
    ok: true,
    version: 'order-flow-v1',
    symbol: SYMBOL,
    displayName: sym.displayName,
    date: usedDate,
    isToday,
    at: now,
    source: isToday ? 'live' : 'folder',
    spot: _round(spot, 2),
    spotChange: _round(spotChange, 2),
    spotChangePct: _round(spotChangePct, 2),
    vwap: _round(vwap, 2),
    cprTc: _round(cprTc, 2),
    cprBc: _round(cprBc, 2),
    atm,
    anchor,
    step,
    auctionZone,
    poc: _round(poc, 2), vah: _round(vah, 2), val: _round(val, 2),
    score,
    weightedScore,
    buyerPower,
    sellerPower,
    bias,
    side,
    state,
    tone,
    verdict,
    cumDelta: _round(cumDelta, 2),
    cumDeltaTrend,
    aggression,
    delta,
    absorption,
    exhaustion,
    trap,
    premiumAccept: { ...premiumAccept, ...spotDeltaCard },
    flowAlignment,
    footprint: { ...footprint, ...footprintExtra },
    scoreBreakdown,
    reversal,
    strikes,
    decision,
    ready: trail.length >= 2,
    historyDepth: trail.length,
    baselineAgeSec: base ? Math.round((now - base.t) / 1000) : 0,
    desc: state === 'STRONG BULL' ? 'Buyers in control — institutional support active.'
      : state === 'BULL' ? 'Buyers attacking — bullish setup forming.'
      : state === 'NEUTRAL' ? 'Two-sided auction — no clear control.'
      : state === 'BEAR' ? 'Sellers attacking — bearish tilt.'
      : 'Sellers in control — institutional distribution active.',
    scale: [
      { range: '80 - 100', label: 'STRONG BULL', tone: 'strongbull', active: score >= 80 },
      { range: '60 - 80',  label: 'BULL',         tone: 'bull',       active: score >= 60 && score < 80 },
      { range: '40 - 60',  label: 'NEUTRAL',      tone: 'neutral',    active: score > 40 && score < 60 },
      { range: '20 - 40',  label: 'BEAR',         tone: 'bear',       active: score >= 20 && score <= 40 },
      { range: '0 - 20',   label: 'STRONG BEAR',  tone: 'strongbear', active: score < 20 },
    ],
  };
}

module.exports = { getOrderFlow, _deltaFromCandles };
