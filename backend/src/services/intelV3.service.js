/**
 * Intel V3 — Ultimate Institutional Console
 * ==========================================
 * Self-contained orchestrator that REUSES the v2 raw data layer (candles,
 * option chain, futures, breadth, regime, FRVP) and reorganizes it into the
 * screenshot's institutional card structure.
 *
 * Core focus:
 *   • Primary strike + ±6 strikes deep scoring (13 strikes around ATM)
 *   • 7-pillar confluence scoring on every strike
 *   • Strong CE wall ladder (resistance)
 *   • Strong PE wall ladder (support)
 *   • BUY CE / BUY PE recommendation with probability + targets + SL
 *   • Bull-trap / Bear-trap zone detection
 *   • Alternate-scenario plan if reversal
 *   • Smart-money flow attribution
 *   • Trend + Momentum gauge
 *   • Confidence meter (weighted across 7 pillars)
 *
 * v3 is additive — does NOT modify v1 or v2 endpoints.
 *
 *   GET /api/intel-v3/snapshot?symbol=NIFTY_50&date=YYYY-MM-DD
 */

const intelV2 = require('./intelV2.service');
const symbolRegistry = require('../config/symbolRegistry');

// Step sizes per symbol — used for ±6 window around ATM.
const STRIKE_STEP = {
  NIFTY_50:  50,
  BANKNIFTY: 100,
  SENSEX:    100,
};

const _cache = new Map();
const TTL_LIVE = 1500;
const TTL_HIST = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function _safe(n, fb = 0) { const x = Number(n); return Number.isFinite(x) ? x : fb; }
function _round(n, d = 2) {
  const x = Number(n); if (!Number.isFinite(x)) return 0;
  const f = 10 ** d; return Math.round(x * f) / f;
}
function _clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function _fmtL(n) {
  // → "20.44 L"
  return `${(n / 1e5).toFixed(2)} L`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Primary strike + ±6 window
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build the 13-strike window around ATM (ATM ± 6 × step) and score each.
 * Returns { atm, primaryStrike, window: [{strike, ce: {...}, pe: {...}, score, ...}], ... }
 */
function _buildPrimaryWindow(snap) {
  const atm = snap.options?.atm;
  const step = STRIKE_STEP[snap.symbol] || 50;
  if (!atm || !Array.isArray(snap.ladder) || !snap.ladder.length) {
    return { atm: null, step, primaryStrike: null, window: [], ceWalls: [], peWalls: [] };
  }

  // Build 13-strike window from the FULL option chain (snap.ladder is already
  // ATM±4; we need wider). Pull from ladder by strike map and synthesize gaps.
  const byStrike = new Map(snap.ladder.map(r => [r.strike, r]));
  const window = [];
  for (let i = -6; i <= 6; i++) {
    const k = atm + i * step;
    const row = byStrike.get(k);
    if (row) {
      window.push(row);
    } else {
      // Synth row when we don't have it (outside ATM±4 ladder window)
      window.push({
        strike: k, isAtm: i === 0,
        ce: { ltp: 0, oi: 0, oiChange: 0, iv: 0, delta: 0, gamma: 0, theta: 0,
              vega: 0, volume: 0, health: { state: 'unknown', score: 0 }, buildup: null },
        pe: { ltp: 0, oi: 0, oiChange: 0, iv: 0, delta: 0, gamma: 0, theta: 0,
              vega: 0, volume: 0, health: { state: 'unknown', score: 0 }, buildup: null },
      });
    }
  }

  // CE walls (resistance) — strikes at/above ATM ranked by absolute OI.
  // Per the screenshot: top 5 strikes shown, label = Extreme/Very Strong/Strong/Moderate.
  const ceWalls = window
    .filter(r => r.strike >= atm)
    .map(r => ({
      strike: r.strike,
      oi: r.ce.oi,
      oiChange: r.ce.oiChange,
      oiChangePct: _pctChange(r.ce.oi, r.ce.oiChange),
      ltp: r.ce.ltp, iv: r.ce.iv, delta: r.ce.delta,
      isAtm: r.strike === atm,
    }))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 5)
    .sort((a, b) => a.strike - b.strike); // ascending for ladder display

  const peWalls = window
    .filter(r => r.strike <= atm)
    .map(r => ({
      strike: r.strike,
      oi: r.pe.oi,
      oiChange: r.pe.oiChange,
      oiChangePct: _pctChange(r.pe.oi, r.pe.oiChange),
      ltp: r.pe.ltp, iv: r.pe.iv, delta: r.pe.delta,
      isAtm: r.strike === atm,
    }))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 5)
    .sort((a, b) => b.strike - a.strike); // descending so spot is at top

  // Tag wall strength based on OI rank within ladder
  function tagStrength(walls) {
    const max = walls[0]?.oi || 0;
    return walls.map((w, idx) => {
      const ratio = max > 0 ? w.oi / max : 0;
      let tag;
      if (idx === 0) tag = 'Extreme';
      else if (ratio >= 0.85) tag = 'Very Strong';
      else if (ratio >= 0.65) tag = 'Strong';
      else if (ratio >= 0.45) tag = 'Major';
      else tag = 'Moderate';
      // For PE walls — alternative tags
      return { ...w, strengthTag: tag, strengthPct: _round(ratio * 100, 0) };
    });
  }

  return {
    atm, step, primaryStrike: atm,
    window,
    ceWalls: tagStrength([...ceWalls].sort((a, b) => b.oi - a.oi)),
    peWalls: tagStrength([...peWalls].sort((a, b) => b.oi - a.oi)),
  };
}

function _pctChange(oiToday, oiChange) {
  const prev = Math.max(1, oiToday - oiChange);
  return _round((oiChange / prev) * 100, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Per-strike confluence score (7 pillars)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Score every strike on its CE-side and PE-side for option buying.
 * Returns a per-strike score 0..100 used to rank candidates.
 *
 *   Pillar weights (sum = 100):
 *     Verdict / Bias       25
 *     OI structure         15
 *     Delta range          15
 *     Premium / liquidity  12
 *     Health / IV          10
 *     Distance from spot   13
 *     Trap penalty         10
 */
function _scoreStrike({ row, side, atm, spot, verdict, deltaBias, atmBlk, trapScore }) {
  const leg = side === 'CE' ? row.ce : row.pe;
  if (!leg || !leg.ltp || leg.ltp < 0.5) {
    return { score: 0, factors: {}, reason: 'illiquid premium' };
  }
  const factors = {};
  let score = 35;

  // 1. Verdict alignment
  const sidePct = side === 'CE' ? verdict.cePct : verdict.pePct;
  const vAlign = Math.max(0, sidePct - 50) * 0.5;
  factors.verdict = _round(vAlign, 1); score += vAlign;

  // 2. OI structure
  let oi = 0;
  if (atmBlk) {
    if (side === 'CE') {
      if (atmBlk.peWriting) oi += 8;
      if (atmBlk.ceUnwinding) oi += 5;
      if (atmBlk.ceWriting) oi -= 8;
    } else {
      if (atmBlk.ceWriting) oi += 8;
      if (atmBlk.peUnwinding) oi += 5;
      if (atmBlk.peWriting) oi -= 8;
    }
  }
  factors.oi = oi; score += oi;

  // 3. Delta in sweet spot (0.30–0.55 = +12; 0.20–0.65 = +6)
  const dAbs = Math.abs(leg.delta || 0);
  let dScore = 0;
  if (dAbs >= 0.30 && dAbs <= 0.55) dScore = 12;
  else if (dAbs >= 0.20 && dAbs <= 0.65) dScore = 6;
  else if (dAbs < 0.15) dScore = -8; // too far OTM, no sensitivity
  factors.delta = dScore; score += dScore;

  // 4. Premium / liquidity
  let pScore = 0;
  if (leg.ltp >= 20 && leg.ltp <= 250) pScore = 8;
  else if (leg.ltp >= 5 && leg.ltp < 20) pScore = 2;
  else if (leg.ltp < 5) pScore = -10;
  if (leg.oi >= 1_000_000) pScore += 4;
  else if (leg.oi >= 100_000) pScore += 2;
  else if (leg.oi < 50_000) pScore -= 6;
  factors.liquidity = pScore; score += pScore;

  // 5. Health / IV
  const hScore = ((leg.health?.score ?? 50) - 50) * 0.16;
  factors.health = _round(hScore, 1); score += hScore;

  // 6. Distance from spot
  const dist = Math.abs(row.strike - atm);
  let distScore = 0;
  if (dist === 0) distScore = 6;
  else if (dist <= 50) distScore = 8;
  else if (dist <= 100) distScore = 6;
  else if (dist <= 150) distScore = 2;
  else distScore = -4;
  // Penalty if direction is opposite to side (CE wants strike >= spot bias)
  if (side === 'CE' && row.strike < atm - 50) distScore -= 3;
  if (side === 'PE' && row.strike > atm + 50) distScore -= 3;
  factors.distance = distScore; score += distScore;

  // 7. Smart money / delta bias alignment
  let smScore = 0;
  if (deltaBias === 'bullish') smScore = side === 'CE' ? 6 : -6;
  else if (deltaBias === 'bearish') smScore = side === 'PE' ? 6 : -6;
  factors.smartMoney = smScore; score += smScore;

  // 8. Trap penalty
  const tPenalty = (trapScore || 0) * -0.4;
  factors.trap = _round(tPenalty, 1); score += tPenalty;

  // Final clamp 0..100
  score = _clamp(Math.round(score), 0, 100);
  return { score, factors };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Best CE / PE picks
// ─────────────────────────────────────────────────────────────────────────────
function _pickBestSide(window, side, ctx) {
  let best = null;
  for (const row of window) {
    const s = _scoreStrike({ row, side, ...ctx });
    if (!best || s.score > best.score) {
      best = { row, side, ...s };
    }
  }
  if (!best || best.score === 0) return null;
  const leg = side === 'CE' ? best.row.ce : best.row.pe;

  // Probability — score directly maps to probability (clamp 25..92).
  const probability = _clamp(Math.round(best.score), 25, 92);

  // Action label
  const action =
    probability >= 72 ? 'STRONG BUY' :
    probability >= 60 ? 'BUY' :
    probability >= 50 ? 'CAUTIOUS BUY' :
    probability >= 40 ? 'WAIT' : 'AVOID';

  // Targets — Target 1/2/3 for the underlying (not premium), based on ATR-step
  // For an option buy we propose 3 underlying targets at +X/+1.5X/+2X step where X = step.
  const step = STRIKE_STEP[ctx.symbol] || 50;
  const dir = side === 'CE' ? 1 : -1;
  // Targets are aimed at the wall ladder — for CE buy: targets = nearest wall above
  // For PE: targets = walls below.
  const t1 = best.row.strike + dir * step * 2;
  const t2 = best.row.strike + dir * step * 4;
  const t3 = best.row.strike + dir * step * 6;
  // SL — trigger if spot moves opposite by 1 step beyond an opposite wall
  const sl = best.row.strike + (-dir) * step * 1.5;

  // Top 2 contributing factors → reasoning
  const topFactors = Object.entries(best.factors)
    .map(([k, v]) => ({ k, v }))
    .filter(f => Math.abs(f.v) >= 3)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, 3);
  const reasonMap = {
    verdict: 'verdict alignment',
    oi: 'OI structure',
    delta: 'delta in sweet spot',
    liquidity: 'premium liquidity',
    health: 'leg health',
    distance: 'strike distance',
    smartMoney: 'smart money flow',
    trap: 'trap risk',
  };
  const reasoning = topFactors.length
    ? topFactors.map(f => `${f.v >= 0 ? '+' : ''}${Math.round(Number(f.v))} ${reasonMap[f.k]}`).join(' · ')
    : 'no clear edge';

  return {
    side,
    strike: best.row.strike,
    ltp: _round(leg.ltp, 2),
    oi: leg.oi,
    delta: _round(leg.delta, 3),
    iv: _round(leg.iv, 1),
    gamma: _round(leg.gamma, 4),
    theta: _round(leg.theta, 2),
    health: leg.health,
    moneyness: best.row.strike === ctx.atm ? 'ATM'
      : (best.row.strike - ctx.atm) * dir > 0 ? `OTM+${Math.abs(best.row.strike - ctx.atm)}`
      : `ITM${best.row.strike - ctx.atm}`,
    score: best.score,
    probability,
    action,
    label: `BUY ${side} ${best.row.strike}`,
    reasoning,
    factors: best.factors,
    targets: { t1, t2, t3 },
    stopLoss: sl,
    riskReward: _round(Math.abs(t2 - best.row.strike) / Math.abs(sl - best.row.strike), 2),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Trap zones
// ─────────────────────────────────────────────────────────────────────────────
function _trapZones({ window, atm, ceWalls, peWalls, vwap, spot, trapBlk, frvpEngine }) {
  // Bull Trap Zone — band where price could fakeout up before dropping.
  //   Defined as range from current spot to nearest 2 CE walls above.
  const top2Ce = [...ceWalls].sort((a, b) => a.strike - b.strike).slice(0, 2);
  const bullTrapLo = top2Ce[0]?.strike ?? null;
  const bullTrapHi = top2Ce[1]?.strike ?? top2Ce[0]?.strike ?? null;
  const bullTrapHint = vwap && spot < vwap
    ? `High CE Writing + Price Under VWAP`
    : `High CE Writing zone — fade rallies`;

  // Bear Trap Zone — band where price could fakeout down before bouncing.
  //   Defined as range from spot down through nearest 2 PE walls.
  const top2Pe = [...peWalls].sort((a, b) => b.strike - a.strike).slice(0, 2);
  const bearTrapHi = top2Pe[0]?.strike ?? null;
  const bearTrapLo = top2Pe[1]?.strike ?? top2Pe[0]?.strike ?? null;
  const bearTrapHint = `Strong PE Defense Zone — fade dips`;

  return {
    bullTrap: bullTrapLo != null ? {
      lo: bullTrapLo, hi: bullTrapHi,
      label: 'BULL TRAP ZONE',
      hint: bullTrapHint,
      avoidSide: 'CE',  // avoid buying CE in this zone
      severity: trapBlk?.risk === 'high' ? 'HIGH' : trapBlk?.risk === 'medium' ? 'MED' : 'LOW',
    } : null,
    bearTrap: bearTrapHi != null ? {
      lo: bearTrapLo, hi: bearTrapHi,
      label: 'BEAR TRAP ZONE',
      hint: bearTrapHint,
      avoidSide: 'PE',
      severity: trapBlk?.risk === 'high' ? 'HIGH' : trapBlk?.risk === 'medium' ? 'MED' : 'LOW',
    } : null,
    overallScore: trapBlk?.score ?? 0,
    detected: trapBlk?.detected ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Alternate scenario (if reversal)
// ─────────────────────────────────────────────────────────────────────────────
function _alternateScenario({ primaryPick, ceWalls, peWalls, atm, spot, step }) {
  if (!primaryPick) return null;
  const reverseSide = primaryPick.side === 'CE' ? 'PE' : 'CE';
  // Pick a strike further than primary on the reverse side
  let reverseStrike;
  if (reverseSide === 'CE') {
    // Reversal up — use first CE wall above ATM
    reverseStrike = ceWalls[0]?.strike ?? atm + step * 2;
  } else {
    reverseStrike = peWalls[0]?.strike ?? atm - step * 2;
  }
  const dir = reverseSide === 'CE' ? 1 : -1;
  return {
    side: reverseSide,
    strike: reverseStrike,
    label: `BUY ${reverseSide}`,
    condition: reverseSide === 'CE'
      ? `Spot Reclaims ${atm + step * 2} & CE Unwinding`
      : `Spot Loses ${atm - step * 2} & PE Unwinding`,
    targets: {
      t1: reverseStrike + dir * step * 2,
      t2: reverseStrike + dir * step * 4,
      t3: reverseStrike + dir * step * 6,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Smart money flow attribution
// ─────────────────────────────────────────────────────────────────────────────
function _smartMoneyFlow({ window, atm, step }) {
  // Classify each strike's CE & PE leg as one of:
  //   Long Buildup / Short Buildup / Short Covering / Long Unwinding
  // Then aggregate counts.
  let longBuildup = 0, shortBuildup = 0, shortCovering = 0, longUnwinding = 0;
  const longBuildupStrikes  = [];
  const shortBuildupStrikes = [];
  for (const r of window) {
    if (r.ce.buildup === 'Long Buildup') {
      longBuildup++; longBuildupStrikes.push(r.strike);
    }
    if (r.ce.buildup === 'Short Buildup') {
      shortBuildup++; shortBuildupStrikes.push(r.strike);
    }
    if (r.ce.buildup === 'Short Covering') shortCovering++;
    if (r.ce.buildup === 'Long Unwinding') longUnwinding++;
  }

  const writersZoneLo = atm - step * 2;
  const writersZoneHi = atm + step * 4;
  const buyersZoneLo = atm - step * 4;
  const buyersZoneHi = atm + step * 2;

  return {
    metrics: [
      { label: 'Fresh Short Build-up', level: shortBuildup >= 3 ? 'High' : shortBuildup >= 1 ? 'Moderate' : 'Low', count: shortBuildup },
      { label: 'Short Covering',       level: shortCovering >= 3 ? 'High' : shortCovering >= 1 ? 'Moderate' : 'Low', count: shortCovering },
      { label: 'Long Build-up',        level: longBuildup >= 3 ? 'High' : longBuildup >= 1 ? 'Moderate' : 'Low', count: longBuildup },
      { label: 'Long Unwinding',       level: longUnwinding >= 3 ? 'High' : longUnwinding >= 1 ? 'Moderate' : 'Low', count: longUnwinding },
    ],
    writersActiveZone: { lo: writersZoneLo, hi: writersZoneHi, label: `${writersZoneLo} – ${writersZoneHi}` },
    buyersActiveZone:  { lo: buyersZoneLo, hi: buyersZoneHi,  label: `${buyersZoneLo} – ${buyersZoneHi}` },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Trend & momentum gauge
// ─────────────────────────────────────────────────────────────────────────────
function _trendMomentumGauge(snap) {
  const v = snap.verdict;
  const trendStrength = snap.regime?.trendStrength || 'NORMAL';
  const cePct = v.cePct;
  const pePct = v.pePct;
  // -100 fully bearish, 0 neutral, +100 fully bullish
  const score = _round((cePct - pePct), 0);
  const direction = score >= 30 ? 'BULLISH' : score <= -30 ? 'BEARISH' : 'NEUTRAL';
  const momentum = snap.bias?.smartMoney === 'buyers' ? 'Up'
    : snap.bias?.smartMoney === 'sellers' ? 'Down' : 'Flat';
  return {
    score, direction, momentum, trendStrength,
    needleAngle: _clamp(score, -100, 100), // -100..+100 mapped to gauge
    label: direction,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Confidence meter (7-pillar weighted)
// ─────────────────────────────────────────────────────────────────────────────
function _confidence({ verdict, frvpEngine, deltaBias, breadth, trapBlk, atmBlk, futPremium }) {
  const pillars = {};
  let total = 0;
  let weight = 0;

  // 1. Verdict (w=20)
  pillars.verdict = { score: Math.max(verdict.cePct, verdict.pePct), weight: 20 };
  total += pillars.verdict.score * pillars.verdict.weight;
  weight += pillars.verdict.weight;

  // 2. FRVP / acceptance (w=15)
  if (frvpEngine?.dominance) {
    pillars.frvp = { score: frvpEngine.dominance.pctFavour, weight: 15 };
    total += pillars.frvp.score * pillars.frvp.weight;
    weight += pillars.frvp.weight;
  }

  // 3. Delta / smart money (w=15)
  pillars.delta = { score: deltaBias === 'bullish' || deltaBias === 'bearish' ? 70 : 45, weight: 15 };
  total += pillars.delta.score * pillars.delta.weight;
  weight += pillars.delta.weight;

  // 4. Breadth (w=10)
  if (breadth) {
    const adv = Number(breadth.advancePct ?? 50);
    const breadthScore = Math.abs(adv - 50) * 1.6 + 40;
    pillars.breadth = { score: _clamp(breadthScore, 0, 100), weight: 10 };
    total += pillars.breadth.score * pillars.breadth.weight;
    weight += pillars.breadth.weight;
  }

  // 5. OI / structure (w=15)
  let oiScore = 50;
  if (atmBlk?.pcr >= 1.15) oiScore = 70;
  else if (atmBlk?.pcr <= 0.85) oiScore = 70;
  pillars.oi = { score: oiScore, weight: 15 };
  total += pillars.oi.score * pillars.oi.weight;
  weight += pillars.oi.weight;

  // 6. Futures (w=10)
  if (futPremium != null) {
    const fScore = Math.abs(futPremium) > 5 ? 70 : 50;
    pillars.futures = { score: fScore, weight: 10 };
    total += pillars.futures.score * pillars.futures.weight;
    weight += pillars.futures.weight;
  }

  // 7. Trap penalty (w=15) — inverted (low trap = high confidence)
  const trapScore = 100 - (trapBlk?.score ?? 0);
  pillars.trap = { score: trapScore, weight: 15 };
  total += pillars.trap.score * pillars.trap.weight;
  weight += pillars.trap.weight;

  const final = weight > 0 ? Math.round(total / weight) : 50;
  const label =
    final >= 75 ? 'High Probability' :
    final >= 60 ? 'Above Average' :
    final >= 45 ? 'Moderate' :
    final >= 30 ? 'Low' : 'Very Low';

  return {
    score: final,
    label,
    pillars,
    side: verdict.cePct >= verdict.pePct ? 'CE' : 'PE',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Top status header tiles
// ─────────────────────────────────────────────────────────────────────────────
function _statusBar(snap) {
  const v = snap.verdict;
  const downside = _round(v.pePct, 0);
  const upside = _round(v.cePct, 0);
  const cePctLbl = v.verdict === 'STRONG_BEARISH' ? 'STRONGLY BEARISH'
    : v.verdict === 'BEARISH' ? 'SLIGHTLY BEARISH'
    : v.verdict === 'STRONG_BULLISH' ? 'STRONGLY BULLISH'
    : v.verdict === 'BULLISH' ? 'SLIGHTLY BULLISH'
    : 'NEUTRAL';
  const biasSubtitle = v.verdict?.startsWith('STRONG_BEAR') ? 'Sell on Rise · Avoid CE'
    : v.verdict?.startsWith('BEAR') ? 'Sell on Rise · Prefer PE'
    : v.verdict?.startsWith('STRONG_BULL') ? 'Buy on Dip · Strong CE'
    : v.verdict?.startsWith('BULL') ? 'Buy on Dip · Prefer CE'
    : 'Range-bound · Wait';
  const trendStrength = snap.regime?.trendStrength || 'Moderate';
  const vwap = snap.spot?.vwap;
  const spot = snap.spot?.ltp;
  const vwapBias = vwap && spot
    ? (spot >= vwap ? 'Above VWAP' : 'Below VWAP')
    : 'Unknown';
  return {
    spot: {
      ltp: spot,
      change: snap.spot?.change ?? 0,
      changePct: snap.spot?.changePct ?? 0,
    },
    bias: {
      label: cePctLbl,
      tone: v.verdict?.includes('BEAR') ? 'bear' : v.verdict?.includes('BULL') ? 'bull' : 'warn',
      subtitle: biasSubtitle,
    },
    pcr: {
      value: snap.flow?.oi?.pcr ?? 0,
      label: snap.flow?.oi?.pcr >= 1.05 ? 'Bullish'
        : snap.flow?.oi?.pcr <= 0.95 ? 'Bearish' : 'Neutral',
    },
    trendStrength: {
      label: trendStrength,
      barFill: trendStrength === 'STRONG' ? 80 : trendStrength === 'WEAK' ? 30 : 55,
    },
    vwap: {
      label: vwapBias,
      value: vwap,
      tone: vwap && spot && spot >= vwap ? 'bull' : 'bear',
    },
    downsideUpside: {
      downside, upside,
    },
    live: snap.isToday && snap.market?.isOpen,
    clock: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Market intent snapshot (left panel)
// ─────────────────────────────────────────────────────────────────────────────
function _marketIntent(snap, primaryWindow) {
  // CE writers activity = total CE OI change across window
  const ceActivity = primaryWindow.window.reduce((s, r) => s + Math.max(0, r.ce.oiChange), 0);
  const peActivity = primaryWindow.window.reduce((s, r) => s + Math.max(0, r.pe.oiChange), 0);
  const ceLevel =
    ceActivity > 5e6 ? 'Aggressive'
    : ceActivity > 2e6 ? 'Active'
    : ceActivity > 5e5 ? 'Moderate' : 'Light';
  const peLevel =
    peActivity > 5e6 ? 'Aggressive'
    : peActivity > 2e6 ? 'Active'
    : peActivity > 5e5 ? 'Moderate' : 'Light';

  const oiShift = ceActivity > peActivity * 1.1 ? 'DOWNWARD'
    : peActivity > ceActivity * 1.1 ? 'UPWARD' : 'BALANCED';
  const trend = snap.bias?.overallBias === 'bullish' ? 'BULLISH'
    : snap.bias?.overallBias === 'bearish' ? 'BEARISH' : 'NEUTRAL';

  // IV trend — compare recent to median (proxy via ivRank trend)
  const ivTrend = snap.dashboard?.ivAnalytics?.atmIvChangePct ?? 0;
  const ivLabel = ivTrend > 1 ? 'Rising' : ivTrend < -1 ? 'Falling' : 'Stable';

  return {
    smartMoneySide: snap.bias?.smartMoney?.toUpperCase() || 'NEUTRAL',
    ceWritersActivity: { level: ceLevel, score: ceActivity },
    peWritersActivity: { level: peLevel, score: peActivity },
    oiShift: oiShift,
    trend: trend,
    ivTrend: ivLabel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — Best Option Buy CTA tile
// ─────────────────────────────────────────────────────────────────────────────
function _bestOptionBuyCta({ primaryPick, snap, trapInfo }) {
  if (!primaryPick) return null;
  const setupTag =
    primaryPick.probability >= 75 ? 'Strong Setup'
    : primaryPick.probability >= 60 ? 'Solid Setup'
    : primaryPick.probability >= 50 ? 'Cautious Setup'
    : 'Wait Setup';
  const conditions = [];
  // Add 4 confirmation chips like in screenshot:
  //   1. CE Writing Strong / 2. PCR < 1 / 3. Price Below VWAP / 4. Resistance band
  if (primaryPick.side === 'PE') {
    conditions.push({ label: 'CE Writing', value: snap.dashboard?.frvpInstitutional ? 'Strong' : 'Active', tone: 'bear' });
    conditions.push({ label: 'PCR', value: `< 1 (${snap.flow?.oi?.pcr?.toFixed(2)})`, tone: 'bear' });
    conditions.push({ label: 'Price', value: snap.spot?.vwap && snap.spot?.ltp < snap.spot.vwap ? 'Below VWAP' : 'Above VWAP',
                     tone: snap.spot?.vwap && snap.spot?.ltp < snap.spot.vwap ? 'bear' : 'bull' });
    conditions.push({ label: 'Resistance', value: trapInfo?.bullTrap ? `${trapInfo.bullTrap.lo}-${trapInfo.bullTrap.hi}` : '—', tone: 'bear' });
  } else {
    conditions.push({ label: 'PE Writing', value: 'Active', tone: 'bull' });
    conditions.push({ label: 'PCR', value: `> 1 (${snap.flow?.oi?.pcr?.toFixed(2)})`, tone: 'bull' });
    conditions.push({ label: 'Price', value: snap.spot?.vwap && snap.spot?.ltp >= snap.spot.vwap ? 'Above VWAP' : 'Below VWAP',
                     tone: snap.spot?.vwap && snap.spot?.ltp >= snap.spot.vwap ? 'bull' : 'bear' });
    conditions.push({ label: 'Support', value: trapInfo?.bearTrap ? `${trapInfo.bearTrap.lo}-${trapInfo.bearTrap.hi}` : '—', tone: 'bull' });
  }
  return {
    side: primaryPick.side,
    strike: primaryPick.strike,
    ltp: primaryPick.ltp,
    setupTag,
    setupTone: primaryPick.probability >= 60 ? 'bull' : 'warn',
    label: `BUY ${primaryPick.side}`,
    conditions,
    targets: primaryPick.targets,
    stopLoss: primaryPick.stopLoss,
    riskReward: primaryPick.riskReward,
    probability: primaryPick.probability,
    action: primaryPick.action,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — Shift & Flow card
// ─────────────────────────────────────────────────────────────────────────────
function _shiftFlow(snap, primaryWindow) {
  // Aggregate CE / PE OI change across the window (in Cr for display)
  const ceChange = primaryWindow.window.reduce((s, r) => s + r.ce.oiChange, 0);
  const peChange = primaryWindow.window.reduce((s, r) => s + r.pe.oiChange, 0);
  const netShift = peChange - ceChange; // +ve = bullish (PE adding more)

  const ceTrend = ceChange > 0 ? 'Increasing' : 'Decreasing';
  const peTrend = peChange > 0 ? 'Increasing' : 'Decreasing';
  const netLabel = netShift > 0 ? 'To Upside' : netShift < 0 ? 'To Downside' : 'Balanced';

  const pcr = snap.flow?.oi?.pcr ?? 0;
  // PCR trend — we proxy as direction of the net shift
  const pcrTrend = netShift > 0 ? 'Increasing' : netShift < 0 ? 'Decreasing' : 'Stable';

  return {
    ceOiChange: { value: ceChange, label: _fmtCr(ceChange), trend: ceTrend, tone: ceChange > 0 ? 'bear' : 'bull' },
    peOiChange: { value: peChange, label: _fmtCr(peChange), trend: peTrend, tone: peChange > 0 ? 'bull' : 'bear' },
    netShift:   { value: netShift, label: _fmtCr(netShift), label2: netLabel, tone: netShift > 0 ? 'bull' : 'bear' },
    pcrTrend:   { value: pcr, label: pcrTrend, tone: pcrTrend === 'Increasing' ? 'bull' : pcrTrend === 'Decreasing' ? 'bear' : 'warn' },
  };
}

function _fmtCr(n) {
  // → "+1.32 Cr" or "-0.04 Cr"
  const cr = n / 1e7;
  return `${cr >= 0 ? '+' : ''}${cr.toFixed(2)} Cr`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13 — SR Quick View (compact CE+PE strikes view)
// ─────────────────────────────────────────────────────────────────────────────
function _srQuickView({ ceWalls, peWalls, spot }) {
  // Show top 4 CE walls (resistance) and top 4 PE walls (support) compact
  const ce = [...ceWalls].sort((a, b) => a.strike - b.strike).slice(0, 4);
  const pe = [...peWalls].sort((a, b) => b.strike - a.strike).slice(0, 4);
  return {
    ce: ce.map(w => ({ strike: w.strike, tag: w.strengthTag })),
    pe: pe.map(w => ({ strike: w.strike, tag: w.strengthTag })),
    spot,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 14 — Key Levels
// ─────────────────────────────────────────────────────────────────────────────
function _keyLevels(snap) {
  const out = [];
  const spot = snap.spot?.ltp;
  if (snap.spot?.vwap) {
    out.push({ label: 'VWAP', value: _round(snap.spot.vwap, 2), kind: 'pivot',
               relation: spot >= snap.spot.vwap ? 'Above' : 'Below' });
  }
  if (snap.cpr?.pivot) {
    out.push({ label: 'PIVOT', value: _round(snap.cpr.pivot, 2), kind: 'pivot',
               relation: spot >= snap.cpr.pivot ? 'Above' : 'Below' });
  }
  if (snap.spot?.dayLow) {
    out.push({ label: 'DAY LOW',  value: _round(snap.spot.dayLow, 2), kind: 'support',
               relation: spot >= snap.spot.dayLow ? 'Above' : 'At' });
  }
  if (snap.spot?.dayHigh) {
    out.push({ label: 'DAY HIGH', value: _round(snap.spot.dayHigh, 2), kind: 'resistance',
               relation: spot >= snap.spot.dayHigh ? 'At' : 'Below' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — getSnapshot (v3)
// ─────────────────────────────────────────────────────────────────────────────
async function getSnapshot({ symbol = 'NIFTY_50', date = null } = {}) {
  const SYMBOL = String(symbol).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const isToday = !date || date === today;
  const cacheKey = `v3|${SYMBOL}|${date || today}`;
  const cached = _cache.get(cacheKey);
  const ttl = isToday ? TTL_LIVE : TTL_HIST;
  if (cached && Date.now() - cached.at < ttl) return cached.payload;

  // Reuse v2's robust data layer.
  const snap = await intelV2.getSnapshot({ symbol: SYMBOL, date });
  if (!snap?.ok) {
    return { ok: false, version: 'v3', symbol: SYMBOL, error: snap?.error || 'snapshot failed' };
  }

  const sym = symbolRegistry.getSymbol(SYMBOL);
  const step = STRIKE_STEP[SYMBOL] || sym.step || 50;

  // Build primary strike + ±6 window
  const primaryWindow = _buildPrimaryWindow(snap);

  // Score every strike (CE & PE) for option buying
  const scoreCtx = {
    atm: primaryWindow.atm,
    spot: snap.spot.ltp,
    verdict: snap.verdict,
    deltaBias: snap.flow?.delta?.bias,
    atmBlk: {
      ceWriting: snap.flow?.oi?.ceWriting,
      peWriting: snap.flow?.oi?.peWriting,
      ceUnwinding: snap.flow?.oi?.ceUnwinding,
      peUnwinding: snap.flow?.oi?.peUnwinding,
      pcr: snap.flow?.oi?.pcr,
    },
    trapScore: snap.trap?.score ?? 0,
    symbol: SYMBOL,
  };

  // Score per-strike per-side (used by ladder)
  const scoredWindow = primaryWindow.window.map(row => {
    const ceScore = _scoreStrike({ row, side: 'CE', ...scoreCtx });
    const peScore = _scoreStrike({ row, side: 'PE', ...scoreCtx });
    return { ...row, ceScore: ceScore.score, ceFactors: ceScore.factors,
                     peScore: peScore.score, peFactors: peScore.factors };
  });

  // Pick best CE & PE
  const cePick = _pickBestSide(primaryWindow.window, 'CE', scoreCtx);
  const pePick = _pickBestSide(primaryWindow.window, 'PE', scoreCtx);
  // Primary pick = highest probability
  let primaryPick = null;
  if (cePick && pePick) primaryPick = cePick.probability >= pePick.probability ? cePick : pePick;
  else primaryPick = cePick || pePick;

  // Trap zones
  const trapInfo = _trapZones({
    window: scoredWindow, atm: primaryWindow.atm,
    ceWalls: primaryWindow.ceWalls, peWalls: primaryWindow.peWalls,
    vwap: snap.spot?.vwap, spot: snap.spot?.ltp,
    trapBlk: snap.trap, frvpEngine: snap.dashboard?.frvpInstitutional?.engine,
  });

  // Alternate scenario
  const alternateScenario = _alternateScenario({
    primaryPick, ceWalls: primaryWindow.ceWalls, peWalls: primaryWindow.peWalls,
    atm: primaryWindow.atm, spot: snap.spot.ltp, step,
  });

  // Smart money flow
  const smartMoneyFlow = _smartMoneyFlow({
    window: scoredWindow, atm: primaryWindow.atm, step,
  });

  // Trend & momentum gauge
  const trendMomentum = _trendMomentumGauge(snap);

  // Confidence
  const confidence = _confidence({
    verdict: snap.verdict,
    frvpEngine: snap.dashboard?.frvpInstitutional?.engine,
    deltaBias: snap.flow?.delta?.bias,
    breadth: snap.dashboard?.breadth,
    trapBlk: snap.trap,
    atmBlk: scoreCtx.atmBlk,
    futPremium: snap.futures?.premium,
  });

  // Status header
  const statusBar = _statusBar(snap);

  // Market intent snapshot
  const marketIntent = _marketIntent(snap, primaryWindow);

  // Best option buy CTA tile
  const bestOptionBuy = _bestOptionBuyCta({ primaryPick, snap, trapInfo });

  // Shift & flow card
  const shiftFlow = _shiftFlow(snap, primaryWindow);

  // SR quick view
  const srQuickView = _srQuickView({
    ceWalls: primaryWindow.ceWalls, peWalls: primaryWindow.peWalls,
    spot: snap.spot.ltp,
  });

  // Key levels
  const keyLevels = _keyLevels(snap);

  const payload = {
    ok: true,
    version: 'v3',
    symbol: SYMBOL,
    displayName: sym.displayName,
    requestedDate: snap.requestedDate,
    date: snap.date,
    isToday: snap.isToday,
    fallbackUsed: snap.fallbackUsed,
    at: Date.now(),
    market: snap.market,

    // ── Status header tiles ────────────────────────────────────────────
    statusBar,

    // ── Market intent snapshot (left card) ────────────────────────────
    marketIntent,

    // ── Best option buy (BIG center CTA) ──────────────────────────────
    bestOptionBuy,

    // ── Shift & flow (top right) ──────────────────────────────────────
    shiftFlow,

    // ── Strike ladders ────────────────────────────────────────────────
    primary: {
      atm: primaryWindow.atm,
      step,
      window: scoredWindow,    // ATM ± 6 strikes with scores
      ceWalls: primaryWindow.ceWalls,
      peWalls: primaryWindow.peWalls,
    },

    // ── Picks ──────────────────────────────────────────────────────────
    picks: {
      ce: cePick,
      pe: pePick,
      primary: primaryPick,
    },

    // ── Trap & risk zones ─────────────────────────────────────────────
    trapZones: trapInfo,

    // ── Alternate scenario ────────────────────────────────────────────
    alternateScenario,

    // ── Smart money flow ──────────────────────────────────────────────
    smartMoneyFlow,

    // ── SR quick view ─────────────────────────────────────────────────
    srQuickView,

    // ── Trend & momentum gauge ────────────────────────────────────────
    trendMomentum,

    // ── Key levels ────────────────────────────────────────────────────
    keyLevels,

    // ── Confidence meter ──────────────────────────────────────────────
    confidence,

    // Pass-through context
    spot: snap.spot,
    futures: snap.futures,
    regime: snap.regime,
    bias: snap.bias,

    debug: {
      v2: {
        candleSource: snap.debug?.candleSource,
        strikeCount: snap.debug?.strikeCount,
      },
      windowSize: scoredWindow.length,
    },
  };

  _cache.set(cacheKey, { at: Date.now(), payload });
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Available dates (delegates to v2)
// ─────────────────────────────────────────────────────────────────────────────
function getAvailableDates(symbol) {
  return intelV2.getAvailableDates(symbol);
}

module.exports = { getSnapshot, getAvailableDates };
