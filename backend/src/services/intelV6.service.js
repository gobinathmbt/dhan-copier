/* ─────────────────────────────────────────────────────────────────────
 * INTEL V6 — NIFTY MASTER ENGINE DASHBOARD
 * ========================================================================
 *   GREEKS + CPR + BREADTH + IT ENGINE  →  ONE master verdict.
 *
 *   GOLDEN RULE:
 *     Breadth tells the truth · CPR tells the location · Greeks confirm strength
 *
 *   Engines & institutional weights (directional vote, normalised to ±100):
 *     0. AUCTION (FRVP)          18  — POC/VAH/VAL location + acceptance
 *     1. MARKET BREADTH          20  — Advance/Decline + heavyweight leadership
 *     2. CPR (loc+migration+align)18  — location + value migration + FRVP alignment
 *     3. FLOW                    10  — Delta + Futures Premium + Buyer/Seller flow
 *     4. STRIKE MOMENTUM         15  — ATM±2 premium/OI/vol/delta/vega buying (NEW)
 *     5. GREEKS (ATM)            12  — CE vs PE dominance + Premium Expansion Score
 *     6. IT SECTOR                8  — NIFTY IT tilt → Support / Drag
 *     7. VIX                      7  — Falling = Risk On, Spiking = Risk Off
 *     8. DEALER GAMMA REGIME     10  — Neg gamma (expansion) amplifies prevailing side (NEW)
 *
 *   Non-weighted modifiers:
 *     • TIME-OF-DAY ENGINE — phase multiplier on confidence (expansion vs theta zone) (NEW)
 *     • MARKET CHARACTER   — Breadth + CPR Width + VIX → Trend/Range/Expansion/Panic/Short-Cover
 *     • MARKET TREND VIEW  — majority vote of Breadth + IT + CPR Location
 *
 *   Layer stack (location → participation → premium):
 *     L0 Auction · L1 Breadth(+Leadership) · L2 IT · L3 CPR(+FRVP align) · L4 Flow
 *     L5 Greeks(+Premium Expansion) · L5.5 Strike Momentum · L6 VIX · L6.5 Dealer Gamma
 *     L7 ALIGNMENT (0..7) · L8 Logic Matrix · L9 Final Verdict (greeks-gated · align-graded · time-aware)
 *
 *   Final Verdict is GREEKS-GATED + ALIGNMENT-GRADED + TIME/GAMMA-AWARE.
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

/* ─── Strike-momentum history (ATM±2 premium/OI snapshots) ─── */
const _strikeHistory = new Map(); // symbol → [{ t, strikes:{strike:{ceLtp,peLtp,ceOi,peOi,...}} }]
const STRIKE_HISTORY_MAX = 80;
const STRIKE_TTL_MS = 30 * 60_000;

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

/* Institutional engine weights for the WEIGHTED net score (directional vote).
 * Premium-behaviour layers (Strike Momentum + Greeks + Flow) now carry ~37
 * combined, reflecting that option buyers are paid by premium expansion. */
const WEIGHTS = {
  frvp: 18, breadth: 20, cpr: 18, flow: 10,
  strikeMomentum: 15, greeks: 12, it: 8, vix: 7, gamma: 10,
};
const WEIGHT_SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

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

/* ─────────────────────────────────────────────────────────────────────
 * STRIKE MOMENTUM ENGINE (ATM ± 2) — weight 15
 * Institutional buyers move to ATM / ATM+1 / ATM+2 before the move is
 * obvious. This tracks per-strike premium %Δ, OI %Δ, volume burst, delta
 * and vega change across the ATM±2 band over a rolling window, then scores
 * CE-side vs PE-side buying. Returns a 0..100 momentum score + side.
 *   80+ Institutional Buying · 60+ Momentum Building · 40+ Neutral · <40 Decay
 * ───────────────────────────────────────────────────────────────────── */
function _strikeMomentum(symbol, atm, ladder) {
  const now = Date.now();
  if (!atm || !Array.isArray(ladder) || !ladder.length) {
    return { ready: false, score: 50, side: 'NEUTRAL', bias: 'NEUTRAL', state: 'NO DATA',
      tone: 'neutral', strikes: [], desc: 'Strike data unavailable' };
  }
  // ATM ± 2 band (ladder rows are strike-spaced)
  const sorted = [...ladder].sort((a, b) => a.strike - b.strike);
  const atmIdx = sorted.findIndex(r => r.isAtm) >= 0 ? sorted.findIndex(r => r.isAtm)
    : sorted.findIndex(r => r.strike === atm);
  const lo = Math.max(0, atmIdx - 2);
  const hi = Math.min(sorted.length, atmIdx + 3);
  const band = atmIdx >= 0 ? sorted.slice(lo, hi) : sorted.slice(0, 5);

  // Snapshot current band into history
  const snap = {};
  for (const r of band) {
    snap[r.strike] = {
      ceLtp: _safe(r.ce?.ltp), peLtp: _safe(r.pe?.ltp),
      ceOi: _safe(r.ce?.oi), peOi: _safe(r.pe?.oi),
      ceVol: _safe(r.ce?.volume), peVol: _safe(r.pe?.volume),
      ceVega: _safe(r.ce?.vega), peVega: _safe(r.pe?.vega),
    };
  }
  const trail = _strikeHistory.get(symbol) || [];
  trail.push({ t: now, strikes: snap });
  while (trail.length && (now - trail[0].t) > STRIKE_TTL_MS) trail.shift();
  while (trail.length > STRIKE_HISTORY_MAX) trail.shift();
  _strikeHistory.set(symbol, trail);

  // Baseline ~6 min back
  let base = null;
  if (trail.length >= 3) {
    const targetT = now - 6 * 60_000;
    let best = trail[0], bestDist = Math.abs(best.t - targetT);
    for (let i = 1; i < trail.length - 1; i++) {
      const d = Math.abs(trail[i].t - targetT);
      if (d < bestDist) { bestDist = d; best = trail[i]; }
    }
    base = best;
  }

  // Per-strike CE/PE buying score
  const rows = [];
  let ceTotal = 0, peTotal = 0, scored = 0;
  for (const r of band) {
    const cur = snap[r.strike];
    const prev = base?.strikes?.[r.strike] || null;
    const pct = (now, was) => (was > 0 ? ((now - was) / was) * 100 : 0);

    const cePremPct = prev ? pct(cur.ceLtp, prev.ceLtp) : 0;
    const pePremPct = prev ? pct(cur.peLtp, prev.peLtp) : 0;
    const ceOiPct   = prev ? pct(cur.ceOi, prev.ceOi) : 0;
    const peOiPct   = prev ? pct(cur.peOi, prev.peOi) : 0;
    // OI-change% on the row vs prior-day already in the row
    const ceOiChg = _safe(r.ce?.oiChange);
    const peOiChg = _safe(r.pe?.oiChange);

    // CE buying score (0..100): rising premium + rising OI (long buildup) +
    // volume + positive premium velocity. Mirror for PE.
    const ceMom = _clamp(
      (cePremPct >= 15 ? 40 : cePremPct >= 6 ? 26 : cePremPct >= 0 ? 12 : 0) +
      (ceOiPct >= 5 ? 25 : ceOiPct >= 1 ? 14 : 0) +
      (ceOiChg > 0 ? 15 : 0) +
      (cur.ceVol > 100000 ? 20 : cur.ceVol > 20000 ? 10 : 4), 0, 100);
    const peMom = _clamp(
      (pePremPct >= 15 ? 40 : pePremPct >= 6 ? 26 : pePremPct >= 0 ? 12 : 0) +
      (peOiPct >= 5 ? 25 : peOiPct >= 1 ? 14 : 0) +
      (peOiChg > 0 ? 15 : 0) +
      (cur.peVol > 100000 ? 20 : cur.peVol > 20000 ? 10 : 4), 0, 100);

    if (prev) { ceTotal += ceMom; peTotal += peMom; scored++; }
    rows.push({
      strike: r.strike, isAtm: !!r.isAtm,
      cePremPct: _round(cePremPct, 0), pePremPct: _round(pePremPct, 0),
      ceMom, peMom,
      side: ceMom > peMom + 8 ? 'CE' : peMom > ceMom + 8 ? 'PE' : 'NEU',
    });
  }

  if (!base || scored === 0) {
    return { ready: false, score: 50, side: 'NEUTRAL', bias: 'NEUTRAL',
      state: 'WARMING UP', tone: 'neutral', strikes: rows,
      desc: 'Collecting ATM±2 premium history…',
      ceScore: 0, peScore: 0, baselineAgeSec: base ? Math.round((now - base.t) / 1000) : 0 };
  }

  const ceAvg = Math.round(ceTotal / scored);
  const peAvg = Math.round(peTotal / scored);
  const side = ceAvg > peAvg + 8 ? 'CE' : peAvg > ceAvg + 8 ? 'PE' : 'NEUTRAL';
  const score = Math.max(ceAvg, peAvg);
  const bias = side === 'CE' ? 'BULLISH' : side === 'PE' ? 'BEARISH' : 'NEUTRAL';
  const state = score >= 80 ? 'INSTITUTIONAL BUYING'
    : score >= 60 ? 'MOMENTUM BUILDING'
    : score >= 40 ? 'NEUTRAL'
    : 'DECAY ZONE';
  const tone = bias === 'BULLISH' ? (score >= 80 ? 'strongbull' : 'bull')
    : bias === 'BEARISH' ? (score >= 80 ? 'strongbear' : 'bear') : 'neutral';

  return {
    ready: true,
    score, ceScore: ceAvg, peScore: peAvg,
    side, bias, state, tone,
    strikes: rows,
    baselineAgeSec: Math.round((now - base.t) / 1000),
    historyDepth: trail.length,
    desc: side === 'CE' ? `CE buying across ATM±2 (${score})`
      : side === 'PE' ? `PE buying across ATM±2 (${score})`
      : 'Balanced strike activity',
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * DEALER GAMMA REGIME — weight 10
 * Classifies whether option dealers are net long or short gamma. Long-gamma
 * dealers hedge AGAINST the move → range / premium decay. Short-gamma dealers
 * hedge WITH the move → trend / premium expansion (great for buyers).
 *
 * We don't have dealer positioning directly, so infer it from observable
 * proxies already in V2: realised move vs CPR width (trending vs ranging),
 * VIX direction, and ATM gamma magnitude.
 * ───────────────────────────────────────────────────────────────────── */
function _dealerGammaRegime({ cprWidthClass, spotChangePct, vixChangePct, atmGamma, marketCharacter, conditionBias }) {
  // Score positive = negative-gamma (expansion) tendencies, negative = positive-gamma (range).
  let s = 0;
  const big = Math.abs(spotChangePct) >= 0.5;
  if (big) s += 2;                                    // wide realised move → dealers chasing
  if (cprWidthClass === 'narrow') s += 1;             // compression → break likely
  if (cprWidthClass === 'wide') s -= 1;               // already wide → mean-revert
  if (vixChangePct >= 3) s += 2;                      // VIX rising → short-gamma stress
  if (vixChangePct <= -3) s -= 1;                     // VIX collapsing → vol selling / long gamma
  if (marketCharacter === 'TREND DAY' || marketCharacter === 'EXPANSION DAY' || marketCharacter === 'PANIC DAY') s += 2;
  if (marketCharacter === 'RANGE DAY') s -= 2;

  let regime, premium, tone, desc;
  if (s >= 2) {
    regime = 'NEGATIVE GAMMA'; premium = 'EXPANSION'; tone = 'bull';
    desc = 'Dealers short gamma — hedging amplifies the move. Premium expansion favoured.';
  } else if (s <= -2) {
    regime = 'POSITIVE GAMMA'; premium = 'DECAY'; tone = 'bear';
    desc = 'Dealers long gamma — hedging dampens the move. Range / premium decay.';
  } else {
    regime = 'NEUTRAL GAMMA'; premium = 'MIXED'; tone = 'neutral';
    desc = 'Mixed gamma regime — no strong dealer-flow edge.';
  }

  // The regime AMPLIFIES the prevailing directional bias (it is not directional
  // by itself). In expansion it votes WITH conditionBias; in decay it votes
  // AGAINST (range fades the move).
  let bias = 'NEUTRAL';
  if (regime === 'NEGATIVE GAMMA' && conditionBias !== 'NEUTRAL') bias = conditionBias;
  else if (regime === 'POSITIVE GAMMA' && conditionBias !== 'NEUTRAL') bias = conditionBias === 'BULLISH' ? 'BEARISH' : 'BULLISH';

  return { regime, premium, bias, tone, score: s, atmGamma: _round(atmGamma, 4), desc };
}

/* ─────────────────────────────────────────────────────────────────────
 * TIME-OF-DAY ENGINE — confidence multiplier (not a directional vote)
 * Option buying behaves differently by session phase. A setup scoring 80 at
 * 12:30 (theta zone) is not the same as 80 at 09:25 (expansion).
 *   09:15–10:15 EXPANSION   ×1.15
 *   10:15–12:00 CONTINUATION ×1.00
 *   12:00–14:00 THETA ZONE  ×0.80
 *   14:00–15:30 EXPANSION   ×1.10
 * ───────────────────────────────────────────────────────────────────── */
function _timeOfDay(isToday) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Historical replay has no meaningful "now" phase → neutral multiplier.
  if (!isToday) {
    return { phase: 'HISTORICAL', label: 'Historical Replay', multiplier: 1.0, tone: 'neutral',
      buyerFriendly: true, desc: 'Replay — time-of-day neutralised.' };
  }
  let phase, label, multiplier, tone, buyerFriendly, desc;
  if (mins < 9 * 60 + 15) {
    phase = 'PRE_MARKET'; label = 'Pre-Market'; multiplier = 0.7; tone = 'neutral'; buyerFriendly = false;
    desc = 'Before open — no live auction yet.';
  } else if (mins < 10 * 60 + 15) {
    phase = 'OPENING_EXPANSION'; label = 'Opening Expansion'; multiplier = 1.15; tone = 'bull'; buyerFriendly = true;
    desc = '09:15–10:15 — highest expansion, best for buyers.';
  } else if (mins < 12 * 60) {
    phase = 'CONTINUATION'; label = 'Continuation'; multiplier = 1.0; tone = 'neutral'; buyerFriendly = true;
    desc = '10:15–12:00 — trend continuation window.';
  } else if (mins < 14 * 60) {
    phase = 'THETA_ZONE'; label = 'Theta Zone'; multiplier = 0.8; tone = 'bear'; buyerFriendly = false;
    desc = '12:00–14:00 — lunch lull, theta bleeds buyers. Trim conviction.';
  } else if (mins <= 15 * 60 + 30) {
    phase = 'CLOSING_EXPANSION'; label = 'Closing Expansion'; multiplier = 1.1; tone = 'bull'; buyerFriendly = true;
    desc = '14:00–15:30 — expansion / trend resolution window.';
  } else {
    phase = 'POST_MARKET'; label = 'Post-Market'; multiplier = 0.7; tone = 'neutral'; buyerFriendly = false;
    desc = 'After close — no live trading.';
  }
  return { phase, label, multiplier, tone, buyerFriendly, desc };
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

  // Flow / auction sources from V2
  const flowDelta = v2.flow?.delta || {};
  const futPremium = _safe(v2.futures?.premium);
  const buyerSellerFlow = v2.dashboard?.buyerSellerFlow || null;
  const frvpInst = v2.dashboard?.frvpInstitutional || null;
  const frvpEng = frvpInst?.engine || null;
  const vol = v2.flow?.volume || null;           // { poc, vah, val, hvns, lvns }
  const priceAbovePoc = _safe(v2.dashboard?.priceAbovePoc, 50);
  const heavyAlign = v2.dashboard?.heavyweightsAlignment || null;
  const heavyTotalImpact = _safe(v2.dashboard?.heavyweightsTotalImpact);

  /* ═══ L0. AUCTION STRUCTURE ENGINE (FRVP) — 20% ══════════════════════ */
  // "Where is price?" answered first. POC / VAH / VAL + acceptance/rejection.
  const poc = _safe(vol?.poc, _safe(frvpEng?.profile?.poc));
  const vah = _safe(vol?.vah, _safe(frvpEng?.profile?.vah));
  const val = _safe(vol?.val, _safe(frvpEng?.profile?.val));
  const acc = frvpEng?.acceptance || {};
  const acceptedAboveVah = !!acc.acceptedAboveVAH;
  const acceptedBelowVal = !!acc.acceptedBelowVAL;
  const rejectedAboveVah = !!acc.rejectedAboveVAH;   // bull trap
  const rejectedBelowVal = !!acc.rejectedBelowVAL;   // bear trap

  let auctionZone, auctionBias, auctionDesc;
  if (vah && val && spot > vah) {
    auctionZone = 'ABOVE VALUE';
    auctionBias = rejectedAboveVah ? 'NEUTRAL' : 'BULLISH';
    auctionDesc = acceptedAboveVah ? 'Accepted above value — initiative buyers'
      : rejectedAboveVah ? 'Rejected above VAH — bull trap risk'
      : 'Trading above value area';
  } else if (vah && val && spot < val) {
    auctionZone = 'BELOW VALUE';
    auctionBias = rejectedBelowVal ? 'NEUTRAL' : 'BEARISH';
    auctionDesc = acceptedBelowVal ? 'Accepted below value — initiative sellers'
      : rejectedBelowVal ? 'Rejected below VAL — bear trap risk'
      : 'Trading below value area';
  } else if (poc && Number.isFinite(spot)) {
    auctionZone = 'INSIDE VALUE';
    // inside value: lean by which half of the value area price sits in
    auctionBias = spot > poc ? 'BULLISH' : spot < poc ? 'BEARISH' : 'NEUTRAL';
    auctionDesc = 'Inside value area — rotational / range conditions';
  } else {
    auctionZone = 'UNKNOWN';
    auctionBias = 'NEUTRAL';
    auctionDesc = 'Auction profile unavailable';
  }
  // Inside-value bias is weak — treat as neutral for the weighted vote to
  // avoid over-counting rotational conditions.
  const auctionVoteBias = auctionZone === 'INSIDE VALUE' ? 'NEUTRAL' : auctionBias;

  const auctionEngine = {
    poc: _round(poc, 2),
    vah: _round(vah, 2),
    val: _round(val, 2),
    spot: _round(spot, 2),
    zone: auctionZone,                       // ABOVE / INSIDE / BELOW VALUE
    bias: auctionBias,
    desc: auctionDesc,
    priceAbovePocPct: priceAbovePoc,
    acceptance: {
      acceptedAboveVah, acceptedBelowVal, rejectedAboveVah, rejectedBelowVal,
    },
    scale: [
      { range: 'ABOVE VAH',   label: 'BULLISH', tone: 'bull',    active: auctionZone === 'ABOVE VALUE' },
      { range: 'INSIDE VALUE', label: 'NEUTRAL', tone: 'neutral', active: auctionZone === 'INSIDE VALUE' },
      { range: 'BELOW VAL',   label: 'BEARISH', tone: 'bear',    active: auctionZone === 'BELOW VALUE' },
    ],
  };

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

  // Heavyweight LEADERSHIP — participation (breadth) can disagree with the
  // heavyweights actually moving the index. Track both.
  const leadershipBias = heavyTotalImpact > 0.05 ? 'BULLISH' : heavyTotalImpact < -0.05 ? 'BEARISH' : 'NEUTRAL';
  const leadershipLabel = leadershipBias === 'BULLISH' ? 'LEADERS BULLISH'
    : leadershipBias === 'BEARISH' ? 'LEADERS BEARISH' : 'LEADERS MIXED';
  const participationVsLeadership = breadthBias === leadershipBias ? 'CONFIRMED'
    : leadershipBias === 'NEUTRAL' || breadthBias === 'NEUTRAL' ? 'PARTIAL' : 'DIVERGENT';

  const breadthEngine = {
    advancing, declining, unchanged,
    total: totalStocks,
    pct: breadthPct,
    formula: `${advancing} / ${totalStocks} × 100 = ${breadthPct}%`,
    zone: breadthZone.label,
    tone: breadthZone.tone,
    bias: breadthBias,
    leadership: {
      bias: leadershipBias,
      label: leadershipLabel,
      totalImpact: _round(heavyTotalImpact, 2),
      alignment: heavyAlign?.score || null,        // e.g. "6/8"
      alignLabel: heavyAlign?.label || null,
      status: participationVsLeadership,           // CONFIRMED | PARTIAL | DIVERGENT
    },
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

  // 3c. CPR + FRVP ALIGNMENT — removes fake breakouts.
  //   Above TC + Above VAH  = Strong Bull
  //   Above TC + Inside     = Weak Bull
  //   Below BC + Below VAL  = Strong Bear
  //   Below BC + Inside     = Weak Bear
  let cprFrvpAlignment;
  if (locationBias === 'BULLISH' && auctionZone === 'ABOVE VALUE') {
    cprFrvpAlignment = { label: 'STRONG BULL', strength: 'STRONG', bias: 'BULLISH', desc: 'Above TC + Above Value' };
  } else if (locationBias === 'BULLISH') {
    cprFrvpAlignment = { label: 'WEAK BULL', strength: 'WEAK', bias: 'BULLISH', desc: auctionZone === 'BELOW VALUE' ? 'Above TC but below value — divergent' : 'Above TC, inside value' };
  } else if (locationBias === 'BEARISH' && auctionZone === 'BELOW VALUE') {
    cprFrvpAlignment = { label: 'STRONG BEAR', strength: 'STRONG', bias: 'BEARISH', desc: 'Below BC + Below Value' };
  } else if (locationBias === 'BEARISH') {
    cprFrvpAlignment = { label: 'WEAK BEAR', strength: 'WEAK', bias: 'BEARISH', desc: auctionZone === 'ABOVE VALUE' ? 'Below BC but above value — divergent' : 'Below BC, inside value' };
  } else {
    cprFrvpAlignment = { label: 'NO EDGE', strength: 'NONE', bias: 'NEUTRAL', desc: 'Inside CPR — wait for direction' };
  }

  // Combined CPR layer bias (location + relation + FRVP alignment). Used for
  // the weighted vote so the 20% CPR weight reflects all three reads.
  const cprVotes = [locationBias, cprRelation.bias, cprFrvpAlignment.bias].filter(b => b !== 'NEUTRAL');
  const cprBullVotes = cprVotes.filter(b => b === 'BULLISH').length;
  const cprBearVotes = cprVotes.filter(b => b === 'BEARISH').length;
  const cprBias = cprBullVotes > cprBearVotes ? 'BULLISH' : cprBearVotes > cprBullVotes ? 'BEARISH' : 'NEUTRAL';

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
    alignment: cprFrvpAlignment,
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

  // ── PREMIUM EXPANSION SCORE (0..100) — easier to read than raw greeks ──
  //   Delta rising (35) + Gamma rising (25) + Vega rising (25) + Theta low (15)
  //   computed for the DOMINANT side.
  const pexDeltaRise = dDeltaTrend === 'RISING';
  const pexGammaRise = dGammaTrend === 'RISING';
  const pexVegaRise = dVegaTrend === 'RISING';
  const pexThetaLow = dThetaAbs <= 8;
  const premiumScore = _clamp(Math.round(
    (pexDeltaRise ? 35 : dDeltaTrend === 'FLAT' ? 15 : 0) +
    (pexGammaRise ? 25 : dGammaTrend === 'FLAT' ? 10 : 0) +
    (pexVegaRise ? 25 : dVegaTrend === 'FLAT' ? 10 : 0) +
    (pexThetaLow ? 15 : dThetaAbs <= 15 ? 7 : 0)
  ), 0, 100);
  const premiumState = premiumScore >= 65 ? 'EXPANDING' : premiumScore >= 40 ? 'NEUTRAL' : 'DECAYING';
  const premiumExpansion = {
    score: premiumScore,
    state: premiumState,                         // EXPANDING | NEUTRAL | DECAYING
    side: showSide,
    components: {
      delta: pexDeltaRise ? 'RISING' : dDeltaTrend,
      gamma: pexGammaRise ? 'RISING' : dGammaTrend,
      vega: pexVegaRise ? 'RISING' : dVegaTrend,
      theta: pexThetaLow ? 'LOW' : dThetaAbs <= 15 ? 'MEDIUM' : 'HIGH',
    },
  };

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
    premiumExpansion,
    allPositive: greeksPositive,
    reading: greeksReading,
  };

  /* ═══ L5.5 STRIKE MOMENTUM ENGINE (ATM±2) — 15 ══════════════════════ */
  const strikeMomentum = _strikeMomentum(symbol, atm, ladder);
  const strikeMomentumBias = strikeMomentum.bias;

  /* ═══ 6. VIX ENGINE (10%) ════════════════════════════════════════════ */
  // VIX falling = risk-on (bullish for index buyers); spiking = risk-off.
  const vixBias = vixChangePct <= -1 ? 'BULLISH' : vixChangePct >= 4 ? 'BEARISH' : 'NEUTRAL';
  const vixTrend = vixChangePct <= -2 ? 'FALLING' : vixChangePct >= 4 ? 'RISING' : 'FLAT';

  /* ═══ L4. FLOW CONFIRMATION ENGINE (10%) ═════════════════════════════ */
  // Delta + Futures Premium + Buyer/Seller Flow → one flow verdict.
  const deltaPct = _safe(flowDelta.deltaPct);
  const deltaFlowBias = deltaPct > 8 ? 'BULLISH' : deltaPct < -8 ? 'BEARISH' : 'NEUTRAL';
  const futFlowBias = futPremium > 5 ? 'BULLISH' : futPremium < -5 ? 'BEARISH' : 'NEUTRAL';
  // Buyer/Seller flow — average CE+PE buyers% from V2 (buyers entering both legs).
  const bsBuyersPct = buyerSellerFlow
    ? Math.round((_safe(buyerSellerFlow.ce?.buyersPct, 50) + _safe(buyerSellerFlow.pe?.buyersPct, 50)) / 2)
    : 50;
  const bsFlowBias = bsBuyersPct >= 58 ? 'BULLISH' : bsBuyersPct <= 42 ? 'BEARISH' : 'NEUTRAL';

  const flowBullVotes = [deltaFlowBias, futFlowBias, bsFlowBias].filter(b => b === 'BULLISH').length;
  const flowBearVotes = [deltaFlowBias, futFlowBias, bsFlowBias].filter(b => b === 'BEARISH').length;
  const flowBias = flowBullVotes >= 2 && flowBullVotes > flowBearVotes ? 'BULLISH'
    : flowBearVotes >= 2 && flowBearVotes > flowBullVotes ? 'BEARISH'
    : 'NEUTRAL';
  const flowLabel = flowBias === 'BULLISH' ? 'FLOW BULLISH'
    : flowBias === 'BEARISH' ? 'FLOW BEARISH' : 'FLOW NEUTRAL';
  const flowEngine = {
    bias: flowBias,
    label: flowLabel,
    deltaPct: _round(deltaPct, 2),
    futPremium: _round(futPremium, 2),
    buyersPct: bsBuyersPct,
    components: [
      { key: 'DELTA',    value: `${deltaPct >= 0 ? '+' : ''}${_round(deltaPct, 1)}%`, bias: deltaFlowBias, tone: deltaFlowBias === 'BULLISH' ? 'bull' : deltaFlowBias === 'BEARISH' ? 'bear' : 'neutral' },
      { key: 'FUT PREM',  value: `${futPremium >= 0 ? '+' : ''}${_round(futPremium, 1)}`, bias: futFlowBias, tone: futFlowBias === 'BULLISH' ? 'bull' : futFlowBias === 'BEARISH' ? 'bear' : 'neutral' },
      { key: 'BUYERS',   value: `${bsBuyersPct}%`, bias: bsFlowBias, tone: bsFlowBias === 'BULLISH' ? 'bull' : bsFlowBias === 'BEARISH' ? 'bear' : 'neutral' },
    ],
    desc: flowBias === 'BULLISH' ? 'Buyers in control — delta+, premium+, buyers dominant'
      : flowBias === 'BEARISH' ? 'Sellers in control — delta-, discount, sellers dominant'
      : 'Two-sided flow — no clear initiative',
  };

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

  /* ═══ L5/WEIGHTED VERDICT + L7 ALIGNMENT + L8 LOGIC MATRIX ═══════════ */
  const contrib = (bias, w) => (bias === 'BULLISH' ? w : bias === 'BEARISH' ? -w : 0);
  // Pass 1 — net WITHOUT gamma (gamma needs the prevailing bias to amplify).
  const baseNet =
    contrib(auctionVoteBias, WEIGHTS.frvp) +
    contrib(breadthBias, WEIGHTS.breadth) +
    contrib(cprBias, WEIGHTS.cpr) +
    contrib(flowBias, WEIGHTS.flow) +
    contrib(strikeMomentumBias, WEIGHTS.strikeMomentum) +
    contrib(greeksBias, WEIGHTS.greeks) +
    contrib(itBias, WEIGHTS.it) +
    contrib(vixBias, WEIGHTS.vix);
  const prelimBias = baseNet > 0 ? 'BULLISH' : baseNet < 0 ? 'BEARISH' : 'NEUTRAL';

  /* ═══ L6.5 DEALER GAMMA REGIME — 10 ═════════════════════════════════ */
  const gammaRegime = _dealerGammaRegime({
    cprWidthClass: widthClass,
    spotChangePct,
    vixChangePct,
    atmGamma: _safe(ceLeg.gamma),
    marketCharacter: marketCharacter.label,
    conditionBias: prelimBias,
  });
  const gammaBias = gammaRegime.bias;

  // Pass 2 — full net with gamma's amplification contribution.
  const rawNet = baseNet + contrib(gammaBias, WEIGHTS.gamma);
  // Normalise to ±100 (weights nominal-sum may differ from 100).
  const netScore = _round((rawNet / WEIGHT_SUM) * 100, 0);
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

  /* ═══ L7. ALIGNMENT ENGINE — 0..7 engines agreeing ══════════════════ */
  // How many of the directional engines agree with the dominant side.
  const alignEngines = [
    { key: 'FRVP',     bias: auctionVoteBias },
    { key: 'BREADTH',  bias: breadthBias },
    { key: 'CPR',      bias: cprBias },
    { key: 'FLOW',     bias: flowBias },
    { key: 'STRIKE',   bias: strikeMomentumBias },
    { key: 'GREEKS',   bias: greeksBias },
    { key: 'VIX',      bias: vixBias },
  ];
  const alignBull = alignEngines.filter(e => e.bias === 'BULLISH').length;
  const alignBear = alignEngines.filter(e => e.bias === 'BEARISH').length;
  const dominantSide = alignBull > alignBear ? 'BULLISH' : alignBear > alignBull ? 'BEARISH' : 'NEUTRAL';
  const alignCount = dominantSide === 'BULLISH' ? alignBull : dominantSide === 'BEARISH' ? alignBear : Math.max(alignBull, alignBear);
  const alignTotal = alignEngines.length; // 7
  const alignGrade =
    alignCount >= 7 ? { label: 'INSTITUTIONAL SETUP', tier: 'A+', tone: dominantSide === 'BEARISH' ? 'strongbear' : 'strongbull' } :
    alignCount === 6 ? { label: 'HIGH CONVICTION', tier: 'A', tone: dominantSide === 'BEARISH' ? 'bear' : 'bull' } :
    alignCount === 5 ? { label: 'TRADABLE', tier: 'B', tone: dominantSide === 'BEARISH' ? 'bear' : 'bull' } :
    alignCount === 4 ? { label: 'WATCH', tier: 'C', tone: 'neutral' } :
    { label: 'NO TRADE', tier: 'D', tone: 'neutral' };
  const alignmentEngine = {
    count: alignCount,
    total: alignTotal,
    dominantSide,
    grade: alignGrade.tier,
    gradeLabel: alignGrade.label,
    tone: alignGrade.tone,
    text: `${alignCount} / ${alignTotal} ALIGNED`,
    rows: alignEngines.map(e => ({
      engine: e.key,
      bias: e.bias,
      aligned: dominantSide !== 'NEUTRAL' && e.bias === dominantSide,
      tone: e.bias === 'BULLISH' ? 'bull' : e.bias === 'BEARISH' ? 'bear' : 'neutral',
    })),
  };

  const allBull = alignBull === alignTotal;
  const allBear = alignBear === alignTotal;

  const logicMatrix = {
    netScore,
    weights: WEIGHTS,
    rows: [
      { engine: 'AUCTION (FRVP)', weight: WEIGHTS.frvp,    value: auctionZone, verdict: auctionBias === 'BULLISH' ? 'ABOVE VALUE' : auctionBias === 'BEARISH' ? 'BELOW VALUE' : 'INSIDE', tone: auctionBias === 'BULLISH' ? 'bull' : auctionBias === 'BEARISH' ? 'bear' : 'neutral' },
      { engine: 'BREADTH',        weight: WEIGHTS.breadth, value: `${breadthPct}%`, verdict: breadthZone.label, tone: breadthZone.tone },
      { engine: 'CPR',            weight: WEIGHTS.cpr,     value: `${priceLocation} · ${cprFrvpAlignment.label}`, verdict: cprBias === 'BULLISH' ? 'BULLISH' : cprBias === 'BEARISH' ? 'BEARISH' : 'NEUTRAL', tone: cprBias === 'BULLISH' ? 'bull' : cprBias === 'BEARISH' ? 'bear' : 'neutral' },
      { engine: 'FLOW',           weight: WEIGHTS.flow,    value: `Δ ${deltaPct >= 0 ? '+' : ''}${_round(deltaPct, 1)} · Buy ${bsBuyersPct}%`, verdict: flowLabel.replace('FLOW ', ''), tone: flowBias === 'BULLISH' ? 'bull' : flowBias === 'BEARISH' ? 'bear' : 'neutral' },
      { engine: 'STRIKE MOMENTUM', weight: WEIGHTS.strikeMomentum, value: `CE ${strikeMomentum.ceScore} / PE ${strikeMomentum.peScore}`, verdict: strikeMomentum.state, tone: strikeMomentum.tone, greeks: true },
      { engine: 'GREEKS (ATM)',   weight: WEIGHTS.greeks,  value: `CE ${ceScore} / PE ${peScore} · PEX ${premiumScore}`, verdict: greeksSide === 'CE' ? 'CE DOMINANT' : greeksSide === 'PE' ? 'PE DOMINANT' : 'BALANCED', tone: greeksBias === 'BULLISH' ? 'bull' : greeksBias === 'BEARISH' ? 'bear' : 'neutral', greeks: true },
      { engine: 'IT SECTOR',      weight: WEIGHTS.it,      value: `${itChangePct >= 0 ? '+' : ''}${itChangePct}%`, verdict: itBias === 'BULLISH' ? 'SUPPORTING' : itBias === 'BEARISH' ? 'DRAGGING' : 'NEUTRAL', tone: itZone.tone },
      { engine: 'VIX',            weight: WEIGHTS.vix,     value: `${_round(vix, 2)} (${vixChangePct >= 0 ? '+' : ''}${_round(vixChangePct, 2)}%)`, verdict: vixBias === 'BULLISH' ? 'RISK ON' : vixBias === 'BEARISH' ? 'RISK OFF' : 'STABLE', tone: vixBias === 'BULLISH' ? 'bull' : vixBias === 'BEARISH' ? 'bear' : 'neutral' },
      { engine: 'DEALER GAMMA',   weight: WEIGHTS.gamma,   value: `${gammaRegime.regime} · ${gammaRegime.premium}`, verdict: gammaBias === 'BULLISH' ? 'AMPLIFY ↑' : gammaBias === 'BEARISH' ? 'AMPLIFY ↓' : 'NEUTRAL', tone: gammaRegime.tone },
    ],
    condition: marketCondition,
    conditionBias,
    summary: [
      { label: 'AUCTION LOCATED',   ok: auctionVoteBias !== 'NEUTRAL' },
      { label: 'BREADTH ALIGNED',   ok: breadthBias !== 'NEUTRAL' },
      { label: 'CPR + FRVP ALIGN',  ok: cprFrvpAlignment.strength === 'STRONG' },
      { label: 'FLOW CONFIRMING',   ok: flowBias !== 'NEUTRAL' },
      { label: 'STRIKE MOMENTUM',   ok: strikeMomentum.ready && strikeMomentum.score >= 60 },
      { label: 'GREEKS CONFIRMING', ok: greeksConfirm },
      { label: 'PREMIUM EXPANDING', ok: premiumState === 'EXPANDING' || gammaRegime.premium === 'EXPANSION' },
    ],
    allAlign: allBull || allBear,
    alignText: alignmentEngine.text,
  };

  /* ═══ L9. FINAL VERDICT — GREEKS-GATED + ALIGNMENT-GRADED + TIME-AWARE ═ */
  // Time-of-day phase multiplier (expansion windows boost, theta zone trims).
  const timeOfDay = _timeOfDay(v2.isToday);
  // Confidence blends net-score strength with alignment depth, then scaled by
  // the time-of-day multiplier.
  const baseConfidence = 3 + (absNet / 100) * 4 + (alignCount / alignTotal) * 2.5 + (vix < 14 ? 0.5 : 0);
  const confidence10 = _clamp(_round(baseConfidence * timeOfDay.multiplier, 1), 1, 10);
  const stars = _clamp(Math.round((alignCount / alignTotal) * 5), 1, 5);
  const strengthLabel = absNet >= 60 ? 'STRONG' : absNet >= 35 ? 'MODERATE' : absNet >= 20 ? 'MILD' : 'WEAK';

  // A BUY SETUP requires: directional condition + greeks confirm the side +
  // at least 4/7 engines aligned. Theta-zone (non-buyer-friendly time) blocks
  // fresh buy setups → downgraded to a BIAS.
  const alignmentOk = alignCount >= 4;
  let setup, setupBias, tradePlan, greeksGate;
  if (conditionBias === 'BULLISH') {
    setupBias = 'BULLISH';
    if (greeksBias === 'BULLISH' && alignmentOk && timeOfDay.buyerFriendly) {
      setup = 'CE BUY SETUP';
      tradePlan = (alignCount >= 6 && absNet >= 55) ? 'BUY CE ON DIP' : 'BUY CE ON CONFIRMATION';
      greeksGate = 'CONFIRMED';
    } else {
      setup = 'BULLISH BIAS';
      tradePlan = !timeOfDay.buyerFriendly ? `WAIT — ${timeOfDay.label.toUpperCase()}`
        : greeksBias !== 'BULLISH' ? 'AWAIT GREEKS CONFIRMATION' : 'AWAIT ALIGNMENT';
      greeksGate = greeksBias === 'BULLISH' ? 'ALIGN-PENDING' : 'PENDING';
    }
  } else if (conditionBias === 'BEARISH') {
    setupBias = 'BEARISH';
    if (greeksBias === 'BEARISH' && alignmentOk && timeOfDay.buyerFriendly) {
      setup = 'PE BUY SETUP';
      tradePlan = (alignCount >= 6 && absNet >= 55) ? 'BUY PE ON RISE' : 'BUY PE ON CONFIRMATION';
      greeksGate = 'CONFIRMED';
    } else {
      setup = 'BEARISH BIAS';
      tradePlan = !timeOfDay.buyerFriendly ? `WAIT — ${timeOfDay.label.toUpperCase()}`
        : greeksBias !== 'BEARISH' ? 'AWAIT GREEKS CONFIRMATION' : 'AWAIT ALIGNMENT';
      greeksGate = greeksBias === 'BEARISH' ? 'ALIGN-PENDING' : 'PENDING';
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
    greeksGate,                       // CONFIRMED | ALIGN-PENDING | PENDING | N/A
    netScore,
    stars,
    confidence: confidence10,
    confidenceText: `${confidence10} / 10`,
    // Quality grade block (alignment + premium + flow) per institutional feedback
    quality: {
      alignment: `${alignCount}/${alignTotal}`,
      grade: alignGrade.tier,
      gradeLabel: alignGrade.label,
      premiumState,                   // EXPANDING | NEUTRAL | DECAYING
      flowState: flowBias === 'BULLISH' ? 'BUYERS ACTIVE' : flowBias === 'BEARISH' ? 'SELLERS ACTIVE' : 'TWO-SIDED',
      auctionZone,
      strikeMomentum: strikeMomentum.state,
      gammaRegime: gammaRegime.regime,
      timePhase: timeOfDay.label,
      timeMultiplier: timeOfDay.multiplier,
    },
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
    auctionEngine,
    flowEngine,
    strikeMomentum,
    gammaRegime,
    timeOfDay,
    trendView,
    greeksEngine,
    marketCharacter,
    alignmentEngine,
    logicMatrix,
    finalVerdict,

    goldenRule: 'AUCTION TELLS LOCATION · BREADTH TELLS TRUTH · FLOW + GREEKS + STRIKE MOMENTUM CONFIRM STRENGTH',

    debug: {
      netScore, rawNet, baseNet, weightSum: WEIGHT_SUM,
      alignBull, alignBear, alignCount, dominantSide,
      conditionBias, prelimBias, greeksGate,
      greeksSide, ceScore, peScore, premiumScore, premiumState,
      strikeMomentumScore: strikeMomentum.score, strikeMomentumSide: strikeMomentum.side,
      gammaRegime: gammaRegime.regime, gammaBias,
      timePhase: timeOfDay.phase, timeMultiplier: timeOfDay.multiplier,
      auctionZone, auctionBias, flowBias, cprBias,
      leadershipBias, participationVsLeadership,
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
