/**
 * Premium Swing Confirmation Engine
 * =================================
 * Multi-layer institutional-grade confirmation for Premium Swing entries.
 * Goes WAY beyond "candle broke range high". Implements the modern-market
 * professional checklist:
 *
 *   1. Premium Expansion vs Spot Move    — biggest tell, "is the option
 *                                          actually moving with the spot?"
 *                                          Detects gamma-pinning traps.
 *   2. Futures Leadership (uses existing futuresLeadershipEngine)
 *   3. VWAP Sustain                       — count crossings; whipsaw = bad
 *   4. Multi-TF Structure                 — HH/HL on 5m/15m/30m
 *   5. Volatility Regime                  — ATR expanding vs compressing,
 *                                          IV trend
 *   6. OI Flow                            — long buildup vs short covering
 *                                          (real positioning vs noise)
 *   7. Trap Risk Detection                — failed breakouts, range
 *                                          narrowing, repeated VWAP cross
 *   8. Gamma Regime                       — distance from max pain;
 *                                          pinning zones penalised
 *   9. Cross-Market Alignment             — NIFTY/SENSEX divergence check
 *
 * Each layer returns {score, reasoning, raw} where score is signed:
 *   POSITIVE  — confirmation, raises confidence
 *   NEGATIVE  — disconfirmation, lowers confidence
 *   ZERO      — neutral / data not available
 *
 * Total score range roughly -50 to +85. Tier mapping:
 *
 *   ≥ 65  ELITE     — full size, fire immediately
 *   50-64 STANDARD  — fire at 60% size
 *   35-49 PROBE     — fire at 35% size (only after 10:30 IST)
 *   < 35  NO_TRADE  — too many factors disagree; skip
 *
 * The same engine is called continuously during trade hold. If score
 * drops below `exitOnScoreBelow` (default 25) the swing exit validator
 * exits the trade because the confirmation thesis has broken.
 */

const futuresLeadershipEngine = require('./futuresLeadershipEngine');

function _safe(n, def = 0) { const x = Number(n); return Number.isFinite(x) ? x : def; }

const NEUTRAL = { score: 0, reasoning: 'data unavailable', raw: null };

// ═══════════════════════════════════════════════════════════════════════
// LAYER 1: Premium Expansion vs Spot Move
// "If spot moves +30pts in our direction but premium only moved +5pts,
//  the option is being suppressed by market makers. This is THE classic
//  institutional trap."
// ═══════════════════════════════════════════════════════════════════════
function _premiumExpansion({ side, primaryStrikes, strike, spotPrice, candles3m, range, delta }) {
  if (!range || !candles3m || candles3m.length < 4) return NEUTRAL;
  const row = (primaryStrikes || []).find(s => Number(s?.strike) === Number(strike));
  if (!row) return NEUTRAL;
  const leg = side === 'CE' ? (row.ce ?? row.call) : (row.pe ?? row.put);
  if (!leg) return NEUTRAL;

  const curPremium = _safe(leg.ltp);
  if (!curPremium) return NEUTRAL;

  // Compare premium to range open and spot to range open
  const premiumOpen = side === 'CE' ? range.ce.openLtp ?? range.ce.low : range.pe.openLtp ?? range.pe.low;
  if (!premiumOpen) return NEUTRAL;
  const premiumDelta = curPremium - premiumOpen;

  // Spot move from 3m start (3m before now)
  const closes = candles3m.map(c => c.c ?? c.close).filter(Number.isFinite);
  if (closes.length < 4) return NEUTRAL;
  const spotMove3m = closes[closes.length - 1] - closes[closes.length - 4];

  // Direction-aligned spot move
  const dirSpotMove = side === 'CE' ? spotMove3m : -spotMove3m;
  if (Math.abs(dirSpotMove) < 5) {
    // Spot hasn't moved — can't measure expansion
    return { score: 0, reasoning: `spot quiet (${dirSpotMove.toFixed(1)}pt move in 3m)`, raw: { dirSpotMove, premiumDelta } };
  }

  // Expected premium move = spot × |delta|
  const absDelta = Math.abs(_safe(delta, 0.5));
  const expectedPremiumMove = dirSpotMove * absDelta;
  // Capture ratio: how much of the expected move is the premium actually capturing?
  const captureRatio = expectedPremiumMove !== 0 ? premiumDelta / expectedPremiumMove : 0;

  // Score
  // > 1.0  = premium expanding faster than spot×delta = INSTITUTIONAL BUYING (+15)
  // 0.7-1.0 = normal trend (+8)
  // 0.4-0.7 = weak (+0)
  // 0.0-0.4 = suppressed (-10)
  // < 0     = premium falling while spot moves with us = TRAP (-20)
  let score, label;
  if (captureRatio >= 1.0) { score = 15; label = 'aggressive expansion'; }
  else if (captureRatio >= 0.7) { score = 8; label = 'normal expansion'; }
  else if (captureRatio >= 0.4) { score = 0; label = 'weak expansion'; }
  else if (captureRatio >= 0) { score = -10; label = 'premium suppressed'; }
  else { score = -20; label = 'premium FALLING despite favourable spot — TRAP'; }

  return {
    score,
    reasoning: `${label}: spot ${dirSpotMove.toFixed(1)}pt × delta ${absDelta.toFixed(2)} = expected +${expectedPremiumMove.toFixed(1)}, actual +${premiumDelta.toFixed(1)} (${(captureRatio * 100).toFixed(0)}%)`,
    raw: { dirSpotMove, expectedPremiumMove, premiumDelta, captureRatio },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 2: Futures Leadership (delegates to existing engine)
// ═══════════════════════════════════════════════════════════════════════
function _futuresLeadership({ direction, futuresData, futuresCandles1m, futuresCandles5m, candles1m, candles5m, spotPrice }) {
  if (!Array.isArray(futuresCandles1m) || futuresCandles1m.length === 0) return NEUTRAL;
  try {
    const r = futuresLeadershipEngine.analyze({
      futuresData,
      futuresCandles1m: futuresCandles1m.map(c => ({
        o: c.o ?? c.open, h: c.h ?? c.high, l: c.l ?? c.low,
        c: c.c ?? c.close, v: c.v ?? c.volume ?? 0,
      })),
      futuresCandles5m: futuresCandles5m.map(c => ({
        o: c.o ?? c.open, h: c.h ?? c.high, l: c.l ?? c.low,
        c: c.c ?? c.close, v: c.v ?? c.volume ?? 0,
      })),
      candles1m: candles1m.map(c => ({
        c: c.c ?? c.close, h: c.h ?? c.high, l: c.l ?? c.low,
      })),
      candles5m,
      spotPrice,
      direction,
    });
    if (!r?.available) return NEUTRAL;

    // Map 0-100 lead-lag into -10..+15
    const lead = _safe(r.leadLagScore, 50);
    let score;
    if (lead >= 70) score = 15;
    else if (lead >= 60) score = 10;
    else if (lead >= 50) score = 3;
    else if (lead >= 40) score = -3;
    else if (lead >= 30) score = -8;
    else score = -15;

    return {
      score,
      reasoning: `futures lead-lag ${lead}/100, dir=${r.futuresDirection}`,
      raw: r,
    };
  } catch (_) { return NEUTRAL; }
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 3: VWAP Sustain
// "Repeated VWAP crossing = whipsaw = no trend = avoid directional buying"
// ═══════════════════════════════════════════════════════════════════════
function _vwapSustain({ candles1m, vwap, direction }) {
  if (!Array.isArray(candles1m) || candles1m.length < 15 || !vwap) return NEUTRAL;
  const want = direction === 'bullish' ? 'above' : 'below';
  const lookback = 30;
  const recent = candles1m.slice(-lookback);

  // VWAP crossings: count sign changes of (close - vwap.vwap)
  const vwapVal = _safe(vwap.vwap);
  if (!vwapVal) {
    // Use position only
    const ok = vwap.position === want;
    return {
      score: ok ? 5 : -5,
      reasoning: `spot ${vwap.position} VWAP (${ok ? 'aligned' : 'opposite'})`,
      raw: { vwapPos: vwap.position },
    };
  }
  let crossings = 0, lastSign = 0, sustainedSide = 0;
  for (const c of recent) {
    const cl = _safe(c.c ?? c.close);
    if (!cl) continue;
    const sign = cl > vwapVal ? 1 : (cl < vwapVal ? -1 : 0);
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) crossings++;
    if (sign !== 0) lastSign = sign;
    sustainedSide += sign;
  }

  // Direction alignment of net side
  const wantSign = direction === 'bullish' ? 1 : -1;
  const dirAligned = (sustainedSide * wantSign) > 0;

  let score;
  if (dirAligned && crossings <= 1) score = 12;
  else if (dirAligned && crossings <= 3) score = 6;
  else if (!dirAligned && crossings <= 1) score = -8;
  else if (crossings >= 5) score = -12;
  else score = 0;

  return {
    score,
    reasoning: `VWAP crossings=${crossings}/${lookback}m, net side=${sustainedSide > 0 ? 'above' : sustainedSide < 0 ? 'below' : 'neutral'}, want=${want}`,
    raw: { crossings, sustainedSide },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 4: Multi-TF Structure
// HH/HL detection across 5m / 15m / 30m. All 3 aligned = strong.
// ═══════════════════════════════════════════════════════════════════════
function _structureCheck(candles, direction, lookback) {
  if (!Array.isArray(candles) || candles.length < lookback + 2) return null;
  const recent = candles.slice(-lookback);
  let highs = 0, lows = 0;
  for (let i = 1; i < recent.length; i++) {
    const cur = recent[i], prev = recent[i - 1];
    const ch = cur.h ?? cur.high, cl = cur.l ?? cur.low;
    const ph = prev.h ?? prev.high, pl = prev.l ?? prev.low;
    if (ch > ph) highs++;
    if (cl < pl) lows++;
  }
  // For bullish: HHs > LLs; for bearish: LLs > HHs
  if (direction === 'bullish') return highs > lows ? 'aligned' : highs === lows ? 'neutral' : 'against';
  return lows > highs ? 'aligned' : lows === highs ? 'neutral' : 'against';
}

function _mtfStructure({ candles5m, candles15m, candles3m, direction }) {
  const s5  = _structureCheck(candles5m, direction, 6);
  const s15 = _structureCheck(candles15m, direction, 5);
  const s3  = _structureCheck(candles3m, direction, 8);
  const reads = [s3, s5, s15].filter(Boolean);
  if (reads.length === 0) return NEUTRAL;
  const aligned = reads.filter(r => r === 'aligned').length;
  const against = reads.filter(r => r === 'against').length;
  let score;
  if (aligned === 3) score = 12;
  else if (aligned === 2 && against === 0) score = 8;
  else if (aligned === 1 && against === 0) score = 3;
  else if (against >= 2) score = -10;
  else score = -3;
  return {
    score,
    reasoning: `MTF: 3m=${s3}, 5m=${s5}, 15m=${s15} (${aligned}A/${against}X)`,
    raw: { s3, s5, s15 },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 5: Volatility Regime
// Real trends NEED volatility expansion. Compression + low IV = chop.
// ═══════════════════════════════════════════════════════════════════════
function _atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    const ch = cur.h ?? cur.high, cl = cur.l ?? cur.low;
    const pc = prev.c ?? prev.close;
    trs.push(Math.max(ch - cl, Math.abs(ch - pc), Math.abs(cl - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function _volatilityRegime({ candles5m, candles15m, primaryStrikes, atmStrike }) {
  const atr5 = _atr(candles5m, 14);
  const atr15 = _atr(candles15m, 14);
  if (!atr5 || !atr15) return NEUTRAL;
  // Expansion ratio: 5m ATR vs 15m ATR average per-bar
  // 15m ATR is per-15min, so per-min equivalent = atr15 / 15
  // 5m ATR per-min = atr5 / 5
  const ratio = (atr5 / 5) / Math.max(0.01, atr15 / 15);
  // Use ATM IV from chain as a quick IV proxy
  const atmRow = (primaryStrikes || []).find(s => Number(s?.strike) === Number(atmStrike));
  const ivCe = _safe(atmRow?.ce?.iv);
  const ivPe = _safe(atmRow?.pe?.iv);
  const avgIv = (ivCe + ivPe) / 2;
  // Score: ratio > 1.2 = expanding (+8), 0.9-1.2 = normal (+3), 0.6-0.9 = weak (-3), <0.6 = compression (-8)
  let score, label;
  if (ratio >= 1.2) { score = 8; label = 'expanding'; }
  else if (ratio >= 0.9) { score = 3; label = 'normal'; }
  else if (ratio >= 0.6) { score = -3; label = 'weak'; }
  else { score = -8; label = 'compression'; }
  // IV gate: avgIV < 11 = low-VIX trap zone (-3)
  if (avgIv > 0 && avgIv < 11) score -= 3;
  return {
    score,
    reasoning: `vol ${label}: 5m_atr/min ${(atr5/5).toFixed(2)} vs 15m ${(atr15/15).toFixed(2)} (ratio ${ratio.toFixed(2)}), avg IV ${avgIv.toFixed(1)}%`,
    raw: { atr5, atr15, ratio, avgIv },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 6: OI Flow (real positioning, not just OI level)
// "Long buildup vs short covering" — distinguishes real direction from
// noise.
// ═══════════════════════════════════════════════════════════════════════
function _oiFlow({ side, strike, primaryStrikes, candles5m }) {
  const row = (primaryStrikes || []).find(s => Number(s?.strike) === Number(strike));
  if (!row) return NEUTRAL;
  const ce = row.ce ?? row.call ?? {};
  const pe = row.pe ?? row.put  ?? {};
  const sameSide = side === 'CE' ? ce : pe;
  const oppSide  = side === 'CE' ? pe : ce;

  const sameOiChg = _safe(sameSide.oiChg ?? sameSide.oiChange);
  const oppOiChg  = _safe(oppSide.oiChg  ?? oppSide.oiChange);

  // For BUY_CE we want: same-side (CE) OI rising = call buying / writers under-defended;
  // BUT a more nuanced read: if PE OI rising (writers selling puts) while CE OI also rising = neutral
  // The cleanest bullish read: PE OI dropping (puts unwinding) AND CE OI rising = directional
  if (sameOiChg === 0 && oppOiChg === 0) return NEUTRAL;

  // Score logic — for BUY_CE (direction=bullish):
  //   PE writers piling in (PE oiChg ≫ 0)         = bullish     +6
  //   CE writers offloading (CE oiChg < 0)         = bullish     +4 extra
  //   Same direction OI both rising heavily       = noise         0
  //   PE writers covering (PE oiChg < 0)          = bearish     -8
  // For BUY_PE flip the math.

  // Use net OI flow signal: oppOiChg - sameOiChg (relative pressure)
  // For bullish: positive PE oiChg (writers selling puts) = bullish
  //              negative CE oiChg (call writers covering) = bullish
  // Signal = oppOiChg - sameOiChg, BIGGER = more bullish (for CE direction)
  const signal = (side === 'CE') ? (oppOiChg - sameOiChg) : (oppOiChg - sameOiChg);
  // (Same formula works because for PE side: oppSide=CE, so signal = ceOiChg - peOiChg,
  //  positive when call writers add OI = bearish for CE / bullish for PE BUY)

  let score, label;
  if (signal > 200_000) { score = 10; label = 'strong opposing-side writing'; }
  else if (signal > 50_000) { score = 6; label = 'opposing-side writing'; }
  else if (signal > -50_000) { score = 0; label = 'mixed OI flow'; }
  else if (signal > -200_000) { score = -5; label = 'opposing-side covering (bearish for our trade)'; }
  else { score = -10; label = 'heavy opposing-side covering — thesis weak'; }

  return {
    score,
    reasoning: `${label}: oppOiChg=${oppOiChg.toLocaleString()} sameOiChg=${sameOiChg.toLocaleString()} signal=${signal.toLocaleString()}`,
    raw: { sameOiChg, oppOiChg, signal },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 7: Trap Risk Detection (penalty only)
// Detects: failed breakouts, range narrowing, repeated VWAP crossings,
// premium-decay traps where both sides are bleeding.
// ═══════════════════════════════════════════════════════════════════════
function _trapRisk({ candles1m, candles5m, range, primaryStrikes, atmStrike }) {
  const reasons = [];
  let penalty = 0;

  // Check 1: Failed breakout pattern in last 10 1m candles
  // A "failed breakout" is a candle that pokes above prev high and closes back inside
  if (Array.isArray(candles1m) && candles1m.length >= 10) {
    const recent = candles1m.slice(-10);
    let failedHighs = 0, failedLows = 0;
    for (let i = 1; i < recent.length; i++) {
      const c = recent[i], p = recent[i - 1];
      const ch = c.h ?? c.high, cl = c.l ?? c.low, cc = c.c ?? c.close;
      const ph = p.h ?? p.high, pl = p.l ?? p.low;
      if (ch > ph && cc < ph) failedHighs++;
      if (cl < pl && cc > pl) failedLows++;
    }
    if (failedHighs >= 2) { penalty -= 5; reasons.push(`${failedHighs} failed highs in last 10m`); }
    if (failedLows >= 2)  { penalty -= 5; reasons.push(`${failedLows} failed lows in last 10m`); }
  }

  // Check 2: Both-side premium decay (gamma-pinning)
  if (range && primaryStrikes) {
    const row = (primaryStrikes || []).find(s => Number(s?.strike) === Number(range.primaryStrike));
    if (row) {
      const curCe = _safe(row.ce?.ltp ?? row.call?.ltp);
      const curPe = _safe(row.pe?.ltp ?? row.put?.ltp);
      const ceDecay = curCe < range.ce.low - 2;
      const peDecay = curPe < range.pe.low - 2;
      if (ceDecay && peDecay) {
        penalty -= 10;
        reasons.push(`both CE+PE below opening lows — gamma pinning detected`);
      }
    }
  }

  // Check 3: Range compression — last 20 1m bars range vs prior 20
  if (Array.isArray(candles1m) && candles1m.length >= 40) {
    const recent20  = candles1m.slice(-20);
    const earlier20 = candles1m.slice(-40, -20);
    const recentRange  = Math.max(...recent20.map(c  => c.h ?? c.high)) - Math.min(...recent20.map(c  => c.l ?? c.low));
    const earlierRange = Math.max(...earlier20.map(c => c.h ?? c.high)) - Math.min(...earlier20.map(c => c.l ?? c.low));
    if (earlierRange > 0 && recentRange / earlierRange < 0.6) {
      penalty -= 4;
      reasons.push(`range compression: ${recentRange.toFixed(1)}pt vs prior ${earlierRange.toFixed(1)}pt`);
    }
  }

  if (penalty === 0) return { score: 0, reasoning: 'no trap signals detected', raw: {} };
  return { score: penalty, reasoning: `TRAP: ${reasons.join('; ')}`, raw: { reasons } };
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 8: Gamma Regime (max-pain proximity)
// Near max-pain = pinning regime = avoid directional buying.
// ═══════════════════════════════════════════════════════════════════════
function _gammaRegime({ primaryStrikes, spotPrice, atmStrike }) {
  if (!Array.isArray(primaryStrikes) || primaryStrikes.length === 0) return NEUTRAL;

  // Compute max pain: strike that minimises total OI×|strike-K| pain
  let minPain = Infinity, maxPainStrike = atmStrike;
  for (const s of primaryStrikes) {
    if (!Number.isFinite(s.strike)) continue;
    let pain = 0;
    for (const r of primaryStrikes) {
      if (!Number.isFinite(r.strike)) continue;
      const ceOi = _safe(r.ce?.oi);
      const peOi = _safe(r.pe?.oi);
      // CE pain at expiry K is max(0, S-K) × ce_oi
      // PE pain at expiry K is max(0, K-S) × pe_oi
      pain += Math.max(0, s.strike - r.strike) * ceOi;
      pain += Math.max(0, r.strike - s.strike) * peOi;
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = s.strike; }
  }
  const distFromMaxPain = Math.abs(spotPrice - maxPainStrike);
  // Score: spot far from max pain = breakout regime, +5; near max pain = pinning, -5
  let score, label;
  if (distFromMaxPain >= 100) { score = 5; label = 'spot far from max pain'; }
  else if (distFromMaxPain >= 50) { score = 0; label = 'spot moderately distanced from max pain'; }
  else if (distFromMaxPain >= 25) { score = -3; label = 'spot near max pain (pinning risk)'; }
  else { score = -8; label = 'spot AT max pain — institutional pinning regime'; }
  return {
    score,
    reasoning: `${label}: max pain=${maxPainStrike}, spot=${spotPrice?.toFixed(0)}, dist=${distFromMaxPain.toFixed(0)}`,
    raw: { maxPainStrike, distFromMaxPain },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 9: Cross-Market Alignment (optional, opt-in)
// Compares NIFTY ↔ SENSEX. Divergence = fragile move.
// Only used if cross-market candles are passed in.
// ═══════════════════════════════════════════════════════════════════════
function _crossMarket({ direction, crossMarketCandles5m }) {
  if (!Array.isArray(crossMarketCandles5m) || crossMarketCandles5m.length < 5) return NEUTRAL;
  const closes = crossMarketCandles5m.slice(-5).map(c => _safe(c.c ?? c.close)).filter(Number.isFinite);
  if (closes.length < 3) return NEUTRAL;
  const move = closes[closes.length - 1] - closes[0];
  const moveDir = move > 5 ? 'bullish' : move < -5 ? 'bearish' : 'neutral';
  if (moveDir === 'neutral') {
    return { score: 0, reasoning: `cross-market flat (${move.toFixed(1)}pt)`, raw: { move } };
  }
  if (moveDir === direction) {
    return { score: 7, reasoning: `cross-market ${moveDir} aligned`, raw: { move } };
  }
  return { score: -10, reasoning: `cross-market DIVERGENCE: ${moveDir} vs our ${direction}`, raw: { move } };
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC: analyze()
// ═══════════════════════════════════════════════════════════════════════
function analyze(args = {}) {
  const cfg = args.settings?.premiumSwingConfirmation || {};

  const factors = {
    premiumExpansion:  _premiumExpansion(args),
    futuresLeadership: _futuresLeadership(args),
    vwapSustain:       _vwapSustain(args),
    mtfStructure:      _mtfStructure(args),
    volatilityRegime:  _volatilityRegime(args),
    oiFlow:            _oiFlow(args),
    trapRisk:          _trapRisk(args),
    gammaRegime:       _gammaRegime(args),
    crossMarket:       _crossMarket(args),
  };

  // Apply per-factor weights from config (default 1.0 each)
  const weights = cfg.weights || {};
  let total = 0;
  const lines = [];
  const breakdown = {};
  for (const [name, f] of Object.entries(factors)) {
    const w = _safe(weights[name], 1.0);
    const weighted = Math.round(f.score * w);
    total += weighted;
    breakdown[name] = { ...f, weighted };
    if (f.score !== 0 || f.reasoning !== 'data unavailable') {
      const sign = weighted >= 0 ? '+' : '';
      lines.push(`${name}=${sign}${weighted} (${f.reasoning})`);
    }
  }

  // Tier mapping
  // Calibrated 2026-05-23 against historical replay:
  // Score range observed: -30 to +35 in normal markets.
  // ELITE >= 25 (clean confirmation across 5+ factors)
  // STANDARD >= 15 (most factors positive)
  // PROBE >= 5 (mild positive signal)
  // NO_TRADE < 5 (factors against or absent)
  const eliteAt    = _safe(cfg.eliteScore,    25);
  const standardAt = _safe(cfg.standardScore, 15);
  const probeAt    = _safe(cfg.probeScore,    5);
  let tier;
  if (total >= eliteAt) tier = 'ELITE';
  else if (total >= standardAt) tier = 'STANDARD';
  else if (total >= probeAt) tier = 'PROBE';
  else tier = 'NO_TRADE';

  return {
    score: total,
    tier,
    factors: breakdown,
    reasoning: lines.join(' | '),
  };
}

module.exports = { analyze };
