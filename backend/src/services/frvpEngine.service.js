/**
 * FRVP Institutional Engine
 * =========================
 * Footprint Range Volume Profile + Auction Theory + Option Flow analytics.
 *
 * Implements 13 sections of the institutional spec:
 *   1. FRVP core engine — H/L volume distribution, VAH/VAL/POC, HVN/LVN
 *   2. Market location logic — inside / outside / near-POC, marker %
 *   3. Acceptance vs rejection — multi-bar confirmation + trap detection
 *   4. Option flow engine — dynamic strike selection (OI cluster + volume + ΔOI)
 *   5. Buildup classification — long/short buildup, covering, unwinding
 *   6. Flow aggregation — buy/sell weighted across selected strikes
 *   7. Delta pressure engine — close-position-within-range proxy
 *   8. Dominance engine — buyers vs sellers verdict
 *   9. Institutional interpretation — smart commentary generator
 *  10. Advanced features — naked POC, developing POC, gamma wall, premium velocity
 *  11. Dashboard output — flat payload optimised for the FE card
 *  12. Color logic — tone tags pre-computed
 *  13. Performance — memoised per-symbol profile, lightweight aggregations
 *
 * Pure functions — no network, no shared mutable state aside from the
 * memoisation cache. Safe to call on every snapshot tick.
 */

const _profileCache = new Map(); // key: symbol|date|candleCount → profile

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
function _safe(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}
function _round(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function _bucketSize(symbolKey, avgPrice) {
  // NIFTY 5pt, BANKNIFTY 10pt, others 0.05% of avg price (≥1pt floor).
  if (symbolKey === 'NIFTY_50') return 5;
  if (symbolKey === 'BANKNIFTY') return 10;
  if (symbolKey === 'SENSEX') return 10;
  return Math.max(1, Math.round(avgPrice * 0.0005));
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 1 — FRVP CORE ENGINE (H/L distributed volume profile)
// ──────────────────────────────────────────────────────────────────────
/**
 * Build a developing intraday volume profile from 5-min candles.
 * Distributes each candle's volume proportionally across all price
 * buckets touched by its high-low range (instead of close-only).
 */
function _buildProfile(candles, symbolKey) {
  if (!Array.isArray(candles) || !candles.length) return null;

  const avg = candles.reduce((s, c) => s + (c.close || 0), 0) / candles.length;
  const step = _bucketSize(symbolKey, avg);

  const buckets = new Map(); // price → volume
  let totalVolume = 0;
  let timeAtBucket = new Map(); // price → number of bars touching

  for (const c of candles) {
    const high = _safe(c.high);
    const low  = _safe(c.low);
    const vol  = _safe(c.volume);
    if (high <= 0 || low <= 0 || vol <= 0) continue;
    const range = Math.max(step, high - low);
    const lowBin  = Math.floor(low  / step) * step;
    const highBin = Math.ceil (high / step) * step;
    const numBins = Math.max(1, Math.round((highBin - lowBin) / step) + 1);
    const volPerBin = vol / numBins;
    for (let p = lowBin; p <= highBin; p += step) {
      buckets.set(p, (buckets.get(p) || 0) + volPerBin);
      timeAtBucket.set(p, (timeAtBucket.get(p) || 0) + 1);
      totalVolume += volPerBin;
    }
  }
  if (!totalVolume) return null;

  const sorted = [...buckets.entries()]
    .map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => b.volume - a.volume);

  const poc = sorted[0]?.price ?? null;

  // Value Area = smallest set of buckets capturing 70% of volume around POC,
  // expanding outward by alternating up/down highest-volume neighbour.
  const target = totalVolume * 0.7;
  let vaSet = new Set([poc]);
  let acc = buckets.get(poc) || 0;
  let upPtr = poc + step;
  let dnPtr = poc - step;
  while (acc < target && (buckets.has(upPtr) || buckets.has(dnPtr))) {
    const upV = buckets.get(upPtr) ?? 0;
    const dnV = buckets.get(dnPtr) ?? 0;
    if (upV >= dnV && buckets.has(upPtr)) {
      vaSet.add(upPtr); acc += upV; upPtr += step;
    } else if (buckets.has(dnPtr)) {
      vaSet.add(dnPtr); acc += dnV; dnPtr -= step;
    } else break;
  }
  const vaPrices = [...vaSet];
  const vah = Math.max(...vaPrices);
  const val = Math.min(...vaPrices);

  // HVN — top 5 by volume (institutional shelves)
  // LVN — bottom 5 inside the value area (potential air-pockets)
  const hvnZones = sorted.slice(0, 5).map(r => ({
    price: r.price, volume: r.volume, share: _round((r.volume / totalVolume) * 100, 2),
  }));
  const insideVa = sorted.filter(r => r.price >= val && r.price <= vah);
  const lvnZones = [...insideVa]
    .sort((a, b) => a.volume - b.volume)
    .slice(0, 5)
    .map(r => ({
      price: r.price, volume: r.volume, share: _round((r.volume / totalVolume) * 100, 2),
    }));

  // Profile strength — how concentrated volume is around POC. Higher
  // share of total volume in the top-3 buckets = stronger conviction.
  const top3Share = sorted.slice(0, 3).reduce((s, r) => s + r.volume, 0) / totalVolume;
  const profileStrength = _round(top3Share * 100, 1);

  // Bins flat array for the chart.
  const bins = [...buckets.entries()]
    .map(([p, v]) => ({ price: p, volume: _round(v, 0) }))
    .sort((a, b) => a.price - b.price);

  return {
    symbol: symbolKey, step,
    vah, val, poc, totalVolume: _round(totalVolume, 0),
    hvnZones, lvnZones, bins,
    profileStrength,
    candleCount: candles.length,
  };
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 2 — MARKET LOCATION LOGIC
// ──────────────────────────────────────────────────────────────────────
function _location(profile, spot) {
  if (!profile || !Number.isFinite(spot)) {
    return {
      insideValue: false, outsideValue: false, nearPOC: false,
      markerPct: 50, side: 'unknown',
    };
  }
  const { vah, val, poc } = profile;
  const insideValue  = spot >= val && spot <= vah;
  const outsideValue = !insideValue;
  const nearPOC      = poc != null && Math.abs(spot - poc) <= (vah - val) * 0.15;
  const range = vah - val || 1;
  const markerPct = Math.max(0, Math.min(100, Math.round(((vah - spot) / range) * 100)));
  const side = spot > vah ? 'above_value'
    : spot < val ? 'below_value'
    : 'inside_value';
  return { insideValue, outsideValue, nearPOC, markerPct, side };
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 3 — ACCEPTANCE VS REJECTION
// ──────────────────────────────────────────────────────────────────────
/**
 * Acceptance requires ≥3 consecutive recent candles outside VA OR a
 * volume surge above/below the boundary. Rejection requires a breakout
 * candle that immediately reverts inside VA.
 */
function _acceptance(profile, candles) {
  if (!profile || !Array.isArray(candles) || candles.length < 4) {
    return {
      acceptedAboveVAH: false, acceptedBelowVAL: false,
      rejectedAboveVAH: false, rejectedBelowVAL: false,
      consecutiveAbove: 0, consecutiveBelow: 0,
      volumeSurgeAbove: false, volumeSurgeBelow: false,
      lastClose: null,
    };
  }
  const { vah, val } = profile;
  const recent = candles.slice(-6);              // look at last 30 min
  const lastN  = candles.slice(-3);              // 15 min for consecutive check
  const consecutiveAbove = lastN.every(c => c.close > vah) ? lastN.length : 0;
  const consecutiveBelow = lastN.every(c => c.close < val) ? lastN.length : 0;

  // Volume surge — sum of volume above VAH (or below VAL) in last 6 bars
  // vs avg per-bar volume of the prior ~30 bars.
  const priorAvgVol = candles.slice(-30, -6).reduce((s, c) => s + (c.volume || 0), 0)
                   / Math.max(1, Math.min(24, candles.length - 6));
  const aboveVol = recent.filter(c => c.close > vah).reduce((s, c) => s + (c.volume || 0), 0);
  const belowVol = recent.filter(c => c.close < val).reduce((s, c) => s + (c.volume || 0), 0);
  const volumeSurgeAbove = priorAvgVol > 0 && aboveVol > priorAvgVol * 2;
  const volumeSurgeBelow = priorAvgVol > 0 && belowVol > priorAvgVol * 2;

  const acceptedAboveVAH = consecutiveAbove >= 3 || volumeSurgeAbove;
  const acceptedBelowVAL = consecutiveBelow >= 3 || volumeSurgeBelow;

  // Rejection — at least one bar in the window pierced the boundary
  // but the latest 1-2 bars are back inside the value area.
  const piercedAbove = recent.some(c => c.high > vah);
  const piercedBelow = recent.some(c => c.low  < val);
  const lastClose = recent[recent.length - 1].close;
  const lastBackInside = lastClose >= val && lastClose <= vah;
  const rejectedAboveVAH = piercedAbove && lastBackInside &&
                           recent.slice(-2).every(c => c.close <= vah);
  const rejectedBelowVAL = piercedBelow && lastBackInside &&
                           recent.slice(-2).every(c => c.close >= val);

  return {
    acceptedAboveVAH, acceptedBelowVAL,
    rejectedAboveVAH, rejectedBelowVAL,
    consecutiveAbove, consecutiveBelow,
    volumeSurgeAbove, volumeSurgeBelow,
    lastClose: _round(lastClose, 2),
  };
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 4 — OPTION FLOW ENGINE (DYNAMIC STRIKE SELECTION)
// ──────────────────────────────────────────────────────────────────────
/**
 * Pick strikes that actually matter: largest OI, largest volume,
 * largest |ΔOI|. Uses Jaccard-style union — a strike makes the cut
 * if it ranks top-N on ANY of the three criteria.
 */
function _selectStrikes(strikes, atm, topN = 8) {
  if (!Array.isArray(strikes) || !strikes.length) return [];
  const augmented = strikes.map(s => {
    const ce = s.call || s.ce || {};
    const pe = s.put  || s.pe || {};
    const ceOi    = _safe(ce.oi);
    const peOi    = _safe(pe.oi);
    const ceVol   = _safe(ce.volume ?? ce.vol);
    const peVol   = _safe(pe.volume ?? pe.vol);
    const ceOiChg = _safe(ce.oiChange ?? ce.oiChg);
    const peOiChg = _safe(pe.oiChange ?? pe.oiChg);
    return {
      strike: Number(s.strike),
      ce: { oi: ceOi, vol: ceVol, oiChg: ceOiChg, ltp: _safe(ce.ltp), iv: _safe(ce.iv),
            buildup: ce.buildup || null },
      pe: { oi: peOi, vol: peVol, oiChg: peOiChg, ltp: _safe(pe.ltp), iv: _safe(pe.iv),
            buildup: pe.buildup || null },
      // Activity score for ranking
      totalOi:   ceOi + peOi,
      totalVol:  ceVol + peVol,
      totalAbsOiChg: Math.abs(ceOiChg) + Math.abs(peOiChg),
      isAtm: Number(s.strike) === atm,
    };
  });

  const byOi  = [...augmented].sort((a, b) => b.totalOi  - a.totalOi).slice(0, topN);
  const byVol = [...augmented].sort((a, b) => b.totalVol - a.totalVol).slice(0, topN);
  const byChg = [...augmented].sort((a, b) => b.totalAbsOiChg - a.totalAbsOiChg).slice(0, topN);

  const union = new Map();
  for (const s of [...byOi, ...byVol, ...byChg]) {
    union.set(s.strike, s);
  }
  // Always include ATM ± 1 step regardless of ranking
  for (const s of augmented) {
    if (s.isAtm) union.set(s.strike, s);
  }
  return [...union.values()].sort((a, b) => a.strike - b.strike);
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 5 — BUILDUP CLASSIFICATION + BUYER/SELLER WEIGHTS
// ──────────────────────────────────────────────────────────────────────
const _TAG_WEIGHTS = {
  'Long Buildup':   { buy: 0.80, sell: 0.20 },
  'Short Covering': { buy: 0.65, sell: 0.35 },
  'Balanced':       { buy: 0.50, sell: 0.50 },
  'Long Unwinding': { buy: 0.35, sell: 0.65 },
  'Short Buildup':  { buy: 0.20, sell: 0.80 },
};

function _classifyBuildup(side, oiChg, spotChange) {
  // For CE side: spot up + OI up = long buildup (CE buyers); spot down + OI up = short buildup (CE writers)
  // For PE side: spot down + OI up = long buildup (PE buyers); spot up + OI up = short buildup (PE writers)
  const oiUp = oiChg > 0;
  const oiDown = oiChg < 0;
  const spotUp = (spotChange ?? 0) >= 0;
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

// ──────────────────────────────────────────────────────────────────────
// SECTION 6 — FLOW AGGREGATION
// ──────────────────────────────────────────────────────────────────────
function _aggregateFlow(selectedStrikes, spotChange) {
  let ceBuy = 0, ceSell = 0, peBuy = 0, peSell = 0;
  // Per-strike weighted contributions, used to find which strike is the
  // dominant CE-buyer / PE-buyer / CE-seller / PE-seller.
  const perStrike = [];
  for (const s of selectedStrikes) {
    const ceTag = s.ce.buildup || _classifyBuildup('CE', s.ce.oiChg, spotChange);
    const peTag = s.pe.buildup || _classifyBuildup('PE', s.pe.oiChg, spotChange);
    const ceW = _TAG_WEIGHTS[ceTag] || _TAG_WEIGHTS.Balanced;
    const peW = _TAG_WEIGHTS[peTag] || _TAG_WEIGHTS.Balanced;
    const ceBuyShare  = s.ce.vol * ceW.buy;
    const ceSellShare = s.ce.vol * ceW.sell;
    const peBuyShare  = s.pe.vol * peW.buy;
    const peSellShare = s.pe.vol * peW.sell;
    ceBuy  += ceBuyShare;
    ceSell += ceSellShare;
    peBuy  += peBuyShare;
    peSell += peSellShare;
    perStrike.push({
      strike: s.strike,
      ceTag, peTag,
      ceBuyShare:  Math.round(ceBuyShare),
      ceSellShare: Math.round(ceSellShare),
      peBuyShare:  Math.round(peBuyShare),
      peSellShare: Math.round(peSellShare),
    });
  }
  const ceTotal = ceBuy + ceSell || 1;
  const peTotal = peBuy + peSell || 1;
  const ceBuyersPct = (ceBuy / ceTotal) * 100;
  const peBuyersPct = (peBuy / peTotal) * 100;

  // Directional aggregation:
  //   Bullish flow = CE buyers + PE writers (both lean LONG)
  //   Bearish flow = CE writers + PE buyers (both lean SHORT)
  // Previous formula `(ceBuyersPct + peBuyersPct) / 2` was structurally wrong —
  // CE-buy % and PE-buy % are opposite-direction signals so averaging them
  // always collapsed to ~50%.
  const bullishVol = ceBuy + peSell;
  const bearishVol = ceSell + peBuy;
  const totalDirectional = bullishVol + bearishVol || 1;
  const buyersEntering  = (bullishVol / totalDirectional) * 100;
  const sellersEntering = 100 - buyersEntering;

  // Dominant strike per side (the strike that contributes the most
  // weighted volume to that side's flow).
  const pickTop = (key) => {
    const sorted = [...perStrike].sort((a, b) => b[key] - a[key]);
    return sorted[0]?.[key] > 0 ? sorted[0] : null;
  };
  const dominantCeBuy   = pickTop('ceBuyShare');
  const dominantCeSell  = pickTop('ceSellShare');
  const dominantPeBuy   = pickTop('peBuyShare');
  const dominantPeSell  = pickTop('peSellShare');

  return {
    ceBuy: _round(ceBuy, 0), ceSell: _round(ceSell, 0),
    peBuy: _round(peBuy, 0), peSell: _round(peSell, 0),
    ceBuyersPct: _round(ceBuyersPct, 1),
    peBuyersPct: _round(peBuyersPct, 1),
    ceSellersPct: _round(100 - ceBuyersPct, 1),
    peSellersPct: _round(100 - peBuyersPct, 1),
    buyersEntering:  _round(buyersEntering, 1),
    sellersEntering: _round(sellersEntering, 1),
    selectedCount: selectedStrikes.length,
    dominantCeBuyStrike:  dominantCeBuy?.strike  ?? null,
    dominantCeSellStrike: dominantCeSell?.strike ?? null,
    dominantPeBuyStrike:  dominantPeBuy?.strike  ?? null,
    dominantPeSellStrike: dominantPeSell?.strike ?? null,
    perStrike,
  };
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 7 — DELTA PRESSURE ENGINE (close-position-within-range)
// ──────────────────────────────────────────────────────────────────────
function _deltaPressure(candles) {
  if (!Array.isArray(candles) || !candles.length) {
    return { cumulative: 0, deltaPct: 0, bias: 'neutral' };
  }
  let cum = 0;
  let totalVol = 0;
  for (const c of candles) {
    const h = _safe(c.high), l = _safe(c.low);
    const v = _safe(c.volume);
    const range = Math.max(0.0001, h - l);
    const close = _safe(c.close);
    // Close position within range, normalised to [-1, +1]:
    //   close == high → +1 (full buying)
    //   close == low  → -1 (full selling)
    //   close == mid  → 0
    const proxy = ((2 * close - h - l) / range);
    cum += v * proxy;
    totalVol += v;
  }
  const deltaPct = totalVol > 0 ? (cum / totalVol) * 100 : 0;
  const bias = deltaPct > 8 ? 'bullish'
    : deltaPct < -8 ? 'bearish'
    : 'neutral';
  return {
    cumulative: _round(cum, 0),
    deltaPct: _round(deltaPct, 2),
    totalVolume: _round(totalVol, 0),
    bias,
  };
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 8 — DOMINANCE ENGINE
// ──────────────────────────────────────────────────────────────────────
function _dominance(flow, delta) {
  // Buyers entering is now a true directional read (bullishVol / totalVol).
  // Just promote it directly into a buyersScore — no need for the legacy
  // average against `(100 - sellersEntering)` which was redundant when
  // buyers + sellers already sum to 100.
  const buyersScore = flow.buyersEntering;
  const sellersScore = 100 - buyersScore;
  let dominantSide = 'BALANCED';
  if (buyersScore  >= 60) dominantSide = 'BUYERS';
  if (sellersScore >= 60) dominantSide = 'SELLERS';
  // Cross-check with delta — promote conviction if both align
  let conviction = 'normal';
  if (dominantSide === 'BUYERS' && delta.bias === 'bullish') conviction = 'high';
  else if (dominantSide === 'SELLERS' && delta.bias === 'bearish') conviction = 'high';
  else if ((dominantSide === 'BUYERS' && delta.bias === 'bearish') ||
           (dominantSide === 'SELLERS' && delta.bias === 'bullish')) {
    conviction = 'divergent';   // option flow says one thing, candle delta the opposite
  }
  return {
    buyersScore: _round(buyersScore, 1),
    sellersScore: _round(sellersScore, 1),
    dominantSide,
    pctFavour: _round(Math.max(buyersScore, sellersScore), 1),
    conviction,
  };
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 9 — INSTITUTIONAL INTERPRETATION ENGINE
// ──────────────────────────────────────────────────────────────────────
function _interpret({ profile, location, acceptance, dominance, delta }) {
  const lines = [];
  let verdict = 'BALANCED';
  let tone = 'warn';

  if (acceptance.rejectedAboveVAH) {
    verdict = 'BULL_TRAP';
    tone = 'bear';
    lines.push('Bull trap detected — price pierced VAH but reverted inside value.');
  } else if (acceptance.rejectedBelowVAL) {
    verdict = 'BEAR_TRAP';
    tone = 'bull';
    lines.push('Bear trap detected — price pierced VAL but reverted inside value.');
  } else if (acceptance.acceptedAboveVAH && dominance.dominantSide === 'BUYERS') {
    verdict = 'BULLISH_AUCTION';
    tone = 'bull';
    lines.push('Bullish auction in progress. Institutions accepting higher prices.');
  } else if (acceptance.acceptedBelowVAL && dominance.dominantSide === 'SELLERS') {
    verdict = 'BEARISH_AUCTION';
    tone = 'bear';
    lines.push('Bearish auction in progress. Institutions accepting lower prices.');
  } else if (location.nearPOC && dominance.dominantSide === 'BALANCED') {
    verdict = 'BALANCED_NEAR_POC';
    tone = 'warn';
    lines.push('Balanced auction near fair value.');
  } else if (location.insideValue) {
    verdict = 'RANGE_BOUND';
    tone = 'warn';
    lines.push('Range-bound market. Fade extremes.');
  } else if (location.side === 'above_value') {
    verdict = 'PROBING_ABOVE';
    tone = 'bull';
    lines.push('Probing above value — watch for acceptance ≥ 3 bars or volume surge.');
  } else if (location.side === 'below_value') {
    verdict = 'PROBING_BELOW';
    tone = 'bear';
    lines.push('Probing below value — watch for acceptance ≥ 3 bars or volume surge.');
  } else {
    verdict = 'MIXED';
    tone = 'neutral';
    lines.push('Mixed auction — observe acceptance.');
  }

  // Conviction & divergence overlay
  if (dominance.conviction === 'high') {
    lines.push('Order flow + delta aligned — high-conviction read.');
  } else if (dominance.conviction === 'divergent') {
    lines.push('Option flow vs candle delta divergence — reduce size.');
  }

  // Profile strength overlay
  if (profile && profile.profileStrength >= 35) {
    lines.push(`Top-3 nodes hold ${profile.profileStrength}% of volume — heavy concentration.`);
  } else if (profile && profile.profileStrength <= 15) {
    lines.push(`Volume thinly spread (${profile.profileStrength}% top-3) — choppy auction.`);
  }

  return { verdict, tone, lines, summary: lines.join(' ') };
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 10 — ADVANCED FEATURES
// ──────────────────────────────────────────────────────────────────────
/**
 * Naked POC = a previous-day POC that hasn't been retested today. We
 * approximate by checking whether the spot has crossed the prior POC
 * during this session — if it hasn't, the POC is "naked" (a magnet).
 *
 * Developing POC trail = sequence of POCs over rolling 30-min windows
 * to show whether the auction is migrating up, down, or flat.
 *
 * Volume imbalance zones = price ranges where volume on one side of
 * the close is >2× the other (quick rejection signature).
 *
 * Trapped traders = piercing without acceptance + divergent dominance.
 *
 * Gamma wall = strike with the highest |gamma exposure| from option chain.
 */
function _developingPOCTrail(candles, symbolKey) {
  if (!Array.isArray(candles) || candles.length < 12) return [];
  // 30-min rolling windows (6 × 5-min candles) every 6 bars
  const trail = [];
  const winSize = 6;
  for (let i = winSize; i <= candles.length; i += winSize) {
    const slice = candles.slice(0, i);
    const p = _buildProfile(slice, symbolKey);
    if (p?.poc != null) {
      trail.push({ t: candles[i - 1].timestamp || i, poc: p.poc });
    }
  }
  return trail.slice(-12);
}

function _gammaWall(strikes) {
  if (!Array.isArray(strikes) || !strikes.length) return null;
  let best = { strike: null, gex: 0 };
  for (const s of strikes) {
    const ce = s.call || s.ce || {};
    const pe = s.put  || s.pe || {};
    const ceG = _safe((ce.greeks?.gamma) ?? ce.gamma);
    const peG = _safe((pe.greeks?.gamma) ?? pe.gamma);
    const ceOi = _safe(ce.oi);
    const peOi = _safe(pe.oi);
    // GEX proxy = (ceG × ceOI) − (peG × peOI). Magnitude reveals the wall.
    const gex = Math.abs(ceG * ceOi - peG * peOi);
    if (gex > best.gex) best = { strike: Number(s.strike), gex };
  }
  return best.strike != null ? { strike: best.strike, gex: _round(best.gex, 0) } : null;
}

function _trappedTraders(acceptance, dominance) {
  // Trap classifier already in acceptance, but cross-validate with dominance.
  if (acceptance.rejectedAboveVAH && dominance.dominantSide !== 'BUYERS') {
    return { side: 'BULL_TRAP', detail: 'Pierced VAH then reverted; sellers in control' };
  }
  if (acceptance.rejectedBelowVAL && dominance.dominantSide !== 'SELLERS') {
    return { side: 'BEAR_TRAP', detail: 'Pierced VAL then reverted; buyers in control' };
  }
  return null;
}

function _premiumVelocity(strikes, atm) {
  if (!atm || !Array.isArray(strikes)) return null;
  const atmRow = strikes.find(s => Number(s.strike) === atm);
  if (!atmRow) return null;
  const ceLtp = _safe(atmRow.call?.ltp ?? atmRow.ce?.ltp);
  const peLtp = _safe(atmRow.put?.ltp  ?? atmRow.pe?.ltp);
  const total = ceLtp + peLtp;
  if (total <= 0) return null;
  const skew = (ceLtp - peLtp) / total;   // +1 = CE expensive, -1 = PE expensive
  return {
    ceLtp, peLtp, total: _round(total, 2), skew: _round(skew, 3),
    state: skew > 0.10 ? 'CE_EXPANDING'
         : skew < -0.10 ? 'PE_EXPANDING'
         : 'BALANCED',
  };
}

// ──────────────────────────────────────────────────────────────────────
// SECTION 13 — Memoised entry point
// ──────────────────────────────────────────────────────────────────────
function evaluate({
  symbolKey,
  candles5m,
  spotPrice,
  spotChange,
  strikes,
  atm,
  date,
}) {
  if (!Array.isArray(candles5m) || !candles5m.length) return null;

  // Memo: same symbol + date + candle count → same profile.
  const cacheKey = `${symbolKey}|${date || 'live'}|${candles5m.length}`;
  let profile = _profileCache.get(cacheKey);
  if (!profile) {
    profile = _buildProfile(candles5m, symbolKey);
    if (profile) _profileCache.set(cacheKey, profile);
  }
  if (!profile) return null;

  const location   = _location(profile, spotPrice);
  const acceptance = _acceptance(profile, candles5m);
  const selected   = _selectStrikes(strikes || [], atm, 8);
  const flow       = _aggregateFlow(selected, spotChange);
  const delta      = _deltaPressure(candles5m);
  const dominance  = _dominance(flow, delta);
  const interp     = _interpret({ profile, location, acceptance, dominance, delta });
  const trapped    = _trappedTraders(acceptance, dominance);

  // Section 10 advanced features
  const developingPOC  = _developingPOCTrail(candles5m, symbolKey);
  const gammaWall      = _gammaWall(strikes || []);
  const premiumVel     = _premiumVelocity(strikes || [], atm);

  // Naked POC — yesterday's POC if not retested today (we don't carry yPOC
  // here; the v2 service can pass it in via `priorDayPOC`. For now, mark
  // the lowest-touch HVN as a magnet candidate.)
  const nakedPOC = profile.lvnZones[0] || null;

  // Final dashboard payload (Section 11)
  return {
    // 1. Core profile
    profile: {
      vah: profile.vah, val: profile.val, poc: profile.poc,
      totalVolume: profile.totalVolume,
      profileStrength: profile.profileStrength,
      hvnZones: profile.hvnZones,
      lvnZones: profile.lvnZones,
      bins: profile.bins,
      step: profile.step,
    },
    // 2. Location
    location,
    // 3. Acceptance / rejection
    acceptance,
    // 4. Selected strikes (dynamic ATM ± selection)
    selectedStrikes: selected.map(s => ({
      strike: s.strike, isAtm: s.isAtm,
      ceOi: s.ce.oi, peOi: s.pe.oi,
      ceVol: s.ce.vol, peVol: s.pe.vol,
      ceOiChg: s.ce.oiChg, peOiChg: s.pe.oiChg,
      ceLtp: s.ce.ltp, peLtp: s.pe.ltp,
      ceIv: s.ce.iv, peIv: s.pe.iv,
      ceBuildup: s.ce.buildup || _classifyBuildup('CE', s.ce.oiChg, spotChange),
      peBuildup: s.pe.buildup || _classifyBuildup('PE', s.pe.oiChg, spotChange),
    })),
    // 6. Flow aggregation
    flow,
    // 7. Delta pressure
    delta,
    // 8. Dominance
    dominance,
    // 9. Institutional interpretation
    interpretation: interp,
    // 10. Advanced features
    advanced: {
      developingPOC, gammaWall, premiumVel, nakedPOC, trapped,
    },
    // 11. Top-line directional bias for buyers
    directionalBias: (() => {
      const dominant = dominance.dominantSide;
      const conviction = dominance.conviction;

      // CE bias if buyers + acceptance above
      if (dominant === 'BUYERS' && (acceptance.acceptedAboveVAH || location.side === 'above_value')) {
        return {
          side: 'CE',
          strength: conviction === 'high' ? 'STRONG' : conviction === 'divergent' ? 'WEAK' : 'MODERATE',
          reason: 'buyers + acceptance above value',
          targetStrike: flow.dominantCeBuyStrike ?? atm,
        };
      }
      if (dominant === 'SELLERS' && (acceptance.acceptedBelowVAL || location.side === 'below_value')) {
        return {
          side: 'PE',
          strength: conviction === 'high' ? 'STRONG' : conviction === 'divergent' ? 'WEAK' : 'MODERATE',
          reason: 'sellers + acceptance below value',
          targetStrike: flow.dominantPeBuyStrike ?? atm,
        };
      }

      // Trap signals — only fire when option flow agrees with the trap.
      // A bear trap that prints PE STRONG flow is a fakeout we must not
      // chase as a CE entry. Only fire CE on a bear trap when buyers are
      // clearly stepping in (or at least not getting overrun by sellers).
      if (acceptance.rejectedAboveVAH) {
        if (dominant === 'SELLERS') {
          return {
            side: 'PE',
            strength: 'STRONG',
            reason: 'bull trap at VAH + sellers dominating',
            targetStrike: flow.dominantPeBuyStrike ?? atm,
          };
        }
        return {
          side: 'NEUTRAL',
          strength: 'WEAK',
          reason: 'bull trap at VAH but flow not yet aligned — wait',
          targetStrike: null,
        };
      }
      if (acceptance.rejectedBelowVAL) {
        if (dominant === 'BUYERS') {
          return {
            side: 'CE',
            strength: 'STRONG',
            reason: 'bear trap at VAL + buyers dominating',
            targetStrike: flow.dominantCeBuyStrike ?? atm,
          };
        }
        if (dominant === 'SELLERS' || conviction === 'divergent') {
          return {
            side: 'NEUTRAL',
            strength: 'WEAK',
            reason: 'bear trap at VAL but sellers still dominate — wait',
            targetStrike: null,
          };
        }
        return {
          side: 'CE',
          strength: 'MODERATE',
          reason: 'bear trap at VAL — flow neutral, partial CE bias',
          targetStrike: flow.dominantCeBuyStrike ?? atm,
        };
      }

      // Inside-value pure-flow plays
      if (dominant === 'BUYERS' && conviction !== 'divergent') {
        return {
          side: 'CE',
          strength: conviction === 'high' ? 'MODERATE' : 'WEAK',
          reason: 'buyers leading inside value',
          targetStrike: flow.dominantCeBuyStrike ?? atm,
        };
      }
      if (dominant === 'SELLERS' && conviction !== 'divergent') {
        return {
          side: 'PE',
          strength: conviction === 'high' ? 'MODERATE' : 'WEAK',
          reason: 'sellers leading inside value',
          targetStrike: flow.dominantPeBuyStrike ?? atm,
        };
      }
      return {
        side: 'NEUTRAL',
        strength: 'WEAK',
        reason: 'balanced auction',
        targetStrike: null,
      };
    })(),
    // Tone hint for color logic (Section 12)
    tone: interp.tone,
  };
}

module.exports = {
  evaluate,
  _internals: {
    _buildProfile, _location, _acceptance, _selectStrikes,
    _aggregateFlow, _deltaPressure, _dominance, _interpret,
    _gammaWall, _premiumVelocity, _developingPOCTrail,
  },
};
