/**
 * Structural Target Engine
 * ========================
 * Replaces the static `targetPoints` / `slPoints` with dynamic levels derived
 * from real market structure. Institutions don't aim at "+10 points" — they
 * aim at the next HVN, the IB extension, the prior-day VAH, or the gamma wall.
 *
 * Inputs (everything optional — engine degrades gracefully):
 *   - spotPrice                   : current spot
 *   - direction                   : 'bullish' | 'bearish'
 *   - tradeType                   : 'SCALP' | 'SWING'
 *   - volumeAnalysis              : current FRVP (intraday HVN/LVN/POC/VA)
 *   - multiDayContext             : multiDayContextEngine output
 *   - todayStats                  : { dayHigh, dayLow, ibHigh, ibLow }
 *   - atr                         : current 5m ATR (for fallback target)
 *   - entryPrice                  : option premium at entry
 *   - settings                    : ScalpingSession.settings (for floors / caps)
 *
 * Output:
 *   {
 *     spotTargetPrice,            // where we expect spot to head
 *     spotStopPrice,              // structural invalidation level for spot
 *     spotTargetPts, spotSlPts,   // distance in points
 *     optionTargetPts, optionSlPts, // translated to option premium pts (delta-aware)
 *     rrSpot, rrOption,           // risk/reward both sides
 *     targetSource, stopSource,   // which level was used (e.g. "PDH", "HVN-23850")
 *     levelsUsed,                 // every candidate level considered
 *     reasoning,
 *   }
 *
 * Floors / caps:
 *   - Min target: max(settings.targetPoints, atr × 0.4)
 *   - Min SL    : max(settings.slPoints,     atr × 0.5)
 *   - Max RR    : 5 (anything beyond is unrealistic)
 *
 * The engine also returns the raw structural target so the caller can decide
 * whether to honor it (high-conviction setups) or fall back to a static
 * scalp target (low-conviction or tight time horizon).
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : null; }

// Build the candidate level list (price + name + source)
function _candidates({
  spotPrice, direction,
  volumeAnalysis,
  multiDayContext,
  todayStats,
}) {
  const out = [];

  // Intraday FRVP
  if (volumeAnalysis?.frvp) {
    const f = volumeAnalysis.frvp;
    if (f.poc) out.push({ price: f.poc, name: 'IntraPOC', source: 'intraday', kind: 'magnet' });
    if (f.vah) out.push({ price: f.vah, name: 'IntraVAH', source: 'intraday', kind: 'edge' });
    if (f.val) out.push({ price: f.val, name: 'IntraVAL', source: 'intraday', kind: 'edge' });
    for (const n of (f.hvn || []).slice(0, 4)) {
      out.push({ price: n.price, name: `IntraHVN-${Math.round(n.price)}`, source: 'intraday', kind: 'support_resistance' });
    }
    for (const n of (f.lvn || []).slice(0, 3)) {
      out.push({ price: n.price, name: `IntraLVN-${Math.round(n.price)}`, source: 'intraday', kind: 'fast_through' });
    }
  }

  // Today's session H/L and IB
  if (todayStats?.dayHigh) out.push({ price: todayStats.dayHigh, name: 'DayHigh', source: 'today', kind: 'edge' });
  if (todayStats?.dayLow)  out.push({ price: todayStats.dayLow,  name: 'DayLow',  source: 'today', kind: 'edge' });
  if (todayStats?.ibHigh)  out.push({ price: todayStats.ibHigh,  name: 'IBH',     source: 'today', kind: 'breakout' });
  if (todayStats?.ibLow)   out.push({ price: todayStats.ibLow,   name: 'IBL',     source: 'today', kind: 'breakout' });
  // IB extensions — institutional measured moves
  if (todayStats?.ibHigh && todayStats?.ibLow) {
    const ibRange = todayStats.ibHigh - todayStats.ibLow;
    out.push({ price: todayStats.ibHigh + ibRange, name: 'IB+1.0', source: 'today', kind: 'extension' });
    out.push({ price: todayStats.ibLow  - ibRange, name: 'IB-1.0', source: 'today', kind: 'extension' });
    out.push({ price: todayStats.ibHigh + ibRange * 0.5, name: 'IB+0.5', source: 'today', kind: 'extension' });
    out.push({ price: todayStats.ibLow  - ibRange * 0.5, name: 'IB-0.5', source: 'today', kind: 'extension' });
  }

  // Multi-day context
  if (multiDayContext?.levels?.length) {
    for (const lvl of multiDayContext.levels) {
      out.push({ price: lvl.price, name: lvl.name, source: lvl.source, kind: 'historical' });
    }
  }
  if (multiDayContext?.compositeProfile?.hvn) {
    for (const n of multiDayContext.compositeProfile.hvn.slice(0, 4)) {
      out.push({ price: n.price, name: `CompHVN-${Math.round(n.price)}`, source: 'composite', kind: 'support_resistance' });
    }
  }

  // De-duplicate by 5pt price bucket
  const uniq = [];
  const seen = new Map();
  for (const lvl of out) {
    if (!Number.isFinite(lvl.price)) continue;
    const key = Math.round(lvl.price / 5) * 5;
    if (seen.has(key)) {
      // prefer historical / composite over intraday for stability
      const prev = seen.get(key);
      const rank = (l) => (l.source === 'composite' || l.source === 'prior_day' ? 2 : l.source === 'today' ? 1 : 0);
      if (rank(lvl) > rank(prev)) seen.set(key, lvl);
      continue;
    }
    seen.set(key, lvl);
  }
  for (const lvl of seen.values()) uniq.push(lvl);

  return uniq;
}

// Pick the nearest level above (for bullish target) or below (for bearish target)
function _pickTarget(spotPrice, direction, candidates, atr) {
  const minDistance = Math.max(8, (atr || 0) * 0.4);   // don't pick a target inches away
  const maxDistance = Math.max(60, (atr || 0) * 4);    // don't pick a target a mile away

  const filtered = candidates.filter(c => {
    const d = c.price - spotPrice;
    if (direction === 'bullish') return d > minDistance && d <= maxDistance;
    if (direction === 'bearish') return d < -minDistance && d >= -maxDistance;
    return false;
  });

  if (!filtered.length) return null;

  // Sort by distance from spot
  filtered.sort((a, b) => Math.abs(a.price - spotPrice) - Math.abs(b.price - spotPrice));
  return filtered[0];
}

// Pick the nearest level on the OPPOSITE side as the structural stop
function _pickStop(spotPrice, direction, candidates, atr) {
  const minDistance = Math.max(6, (atr || 0) * 0.5);
  const maxDistance = Math.max(40, (atr || 0) * 2);

  const filtered = candidates.filter(c => {
    const d = c.price - spotPrice;
    if (direction === 'bullish') return d < -minDistance && d >= -maxDistance;
    if (direction === 'bearish') return d > minDistance && d <= maxDistance;
    return false;
  });

  if (!filtered.length) return null;
  filtered.sort((a, b) => Math.abs(a.price - spotPrice) - Math.abs(b.price - spotPrice));
  return filtered[0];
}

// Translate spot points → option premium points using the strike's delta.
// If delta unknown, fall back to 0.5 (ATM-like).
function _spotPtsToOptionPts(spotPts, optionDelta) {
  const d = Math.abs(Number(optionDelta) || 0.5);
  return Math.max(2, spotPts * d);
}

/**
 * Resolve dynamic targets/stops.
 *
 * @returns {Object}
 */
function resolve({
  spotPrice,
  direction,
  tradeType = 'SCALP',
  volumeAnalysis = null,
  multiDayContext = null,
  todayStats = null,
  atr = null,
  entryPrice = null,
  optionDelta = null,
  settings = {},
} = {}) {
  if (!Number.isFinite(spotPrice) || (direction !== 'bullish' && direction !== 'bearish')) {
    return _staticFallback({ tradeType, settings, reason: 'no spot/direction' });
  }

  const candidates = _candidates({ spotPrice, direction, volumeAnalysis, multiDayContext, todayStats });
  const target = _pickTarget(spotPrice, direction, candidates, atr);
  const stop   = _pickStop  (spotPrice, direction, candidates, atr);

  if (!target || !stop) {
    return _staticFallback({
      tradeType, settings, atr,
      reason: !target && !stop ? 'no candidate levels'
            : !target ? 'no target candidate' : 'no stop candidate',
      candidates,
    });
  }

  const spotTargetPts = Math.abs(target.price - spotPrice);
  const spotSlPts     = Math.abs(stop.price   - spotPrice);
  const rrSpot = spotSlPts > 0 ? spotTargetPts / spotSlPts : 0;

  // Risk/reward sanity caps
  const rrMax = 5;
  const rrMin = tradeType === 'SWING' ? 1.5 : 1.0;
  if (rrSpot < rrMin || rrSpot > rrMax) {
    return _staticFallback({
      tradeType, settings, atr,
      reason: `RR ${rrSpot.toFixed(2)} outside [${rrMin}, ${rrMax}]`,
      candidates,
    });
  }

  // Translate to option-premium space (delta-adjusted)
  const optionTargetPts = _spotPtsToOptionPts(spotTargetPts, optionDelta);
  const optionSlPts     = _spotPtsToOptionPts(spotSlPts,     optionDelta);

  // Apply settings floors so we never go absurdly tight
  const floorTarget = Math.max(Number(settings.targetPoints) || 8, (atr || 0) * 0.4);
  const floorSl     = Math.max(Number(settings.slPoints)     || 12, (atr || 0) * 0.5);

  const finalTarget = Math.max(optionTargetPts, floorTarget);
  const finalSl     = Math.max(optionSlPts,     floorSl);
  const rrOption    = finalSl > 0 ? finalTarget / finalSl : 0;

  return {
    spotTargetPrice: Number(target.price.toFixed(2)),
    spotStopPrice:   Number(stop.price.toFixed(2)),
    spotTargetPts:   Number(spotTargetPts.toFixed(2)),
    spotSlPts:       Number(spotSlPts.toFixed(2)),
    optionTargetPts: Math.round(finalTarget),
    optionSlPts:     Math.round(finalSl),
    rrSpot:          Number(rrSpot.toFixed(2)),
    rrOption:        Number(rrOption.toFixed(2)),
    targetSource:    target.name,
    stopSource:      stop.name,
    targetKind:      target.kind,
    stopKind:        stop.kind,
    levelsUsed:      candidates.slice(0, 12),
    fallback: false,
    reasoning: `target ${target.name}@${target.price.toFixed(2)} (${spotTargetPts.toFixed(1)}pts), ` +
               `stop ${stop.name}@${stop.price.toFixed(2)} (${spotSlPts.toFixed(1)}pts), RR ${rrSpot.toFixed(2)}`,
  };
}

function _staticFallback({ tradeType, settings, atr = null, reason = 'static fallback', candidates = [] }) {
  const baseTarget = Number(settings?.targetPoints) || 10;
  const baseSl     = Number(settings?.slPoints)     || 15;
  const targetPts  = tradeType === 'SWING' ? baseTarget * 3 : baseTarget;
  const slPts      = tradeType === 'SWING' ? baseSl * 1.5   : baseSl;
  return {
    spotTargetPrice: null,
    spotStopPrice:   null,
    spotTargetPts:   null,
    spotSlPts:       null,
    optionTargetPts: Math.round(targetPts),
    optionSlPts:     Math.round(slPts),
    rrSpot:          null,
    rrOption:        Number((targetPts / slPts).toFixed(2)),
    targetSource:    'static',
    stopSource:      'static',
    targetKind:      'static',
    stopKind:        'static',
    levelsUsed:      candidates.slice(0, 12),
    fallback:        true,
    reasoning:       `static fallback (${reason}) — target ${targetPts}pts, SL ${slPts}pts`,
  };
}

module.exports = { resolve };
