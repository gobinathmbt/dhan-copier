/**
 * OI Analytics Engine
 * -------------------
 * Institutional-grade Open-Interest reading. Goes beyond "OI up = bullish":
 *
 *   1. Change-in-OI per strike    (Δ vs previous snapshot)
 *   2. OI velocity                (Δ per second)
 *   3. OI acceleration            (velocity change)
 *   4. Strike migration           (where new OI is being added)
 *   5. OI concentration           (which strikes hold the most positioning)
 *   6. OI absorption              (huge OI added but price didn't move)
 *   7. OI quality score           (composite 0..100, direction-aware)
 *
 * The engine is stateful — it caches the previous snapshot per session so
 * the next call can compute velocity / acceleration. Snapshots are evicted
 * automatically after 10 minutes of inactivity.
 *
 * Pure deterministic — no AI.
 */

// ─────────────────────────────────────────────────────────────────────────────
// State store (in-memory, session-scoped)
// ─────────────────────────────────────────────────────────────────────────────
//   key = sessionId (string) → { snapshots: [{ t, byStrike, atmStrike, spotPrice }] }
//   snapshots[] kept in chronological order, capped to MAX_SNAPSHOTS.
const STATE = new Map();
const MAX_SNAPSHOTS = 6;             // enough for velocity (Δ) and acceleration (Δ²)
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function _getState(sessionId) {
  const id = String(sessionId || 'global');
  let s = STATE.get(id);
  if (!s) {
    s = { snapshots: [], lastTouchedAt: Date.now() };
    STATE.set(id, s);
  }
  s.lastTouchedAt = Date.now();
  return s;
}

function _evictStale() {
  const now = Date.now();
  for (const [k, v] of STATE.entries()) {
    if (now - v.lastTouchedAt > STATE_TTL_MS) STATE.delete(k);
  }
}

function _safeNum(x, fb = 0) { const n = Number(x); return Number.isFinite(n) ? n : fb; }

// ─────────────────────────────────────────────────────────────────────────────
// Build a compact OI snapshot from primary strikes (ATM ± N)
// ─────────────────────────────────────────────────────────────────────────────
//   primaryStrikes is the ATM±N block produced by hybridEntryEngine — every
//   element has { strike, ce: { oi, oiChg, ... }, pe: { oi, oiChg, ... } }.
function _buildSnapshot(primaryStrikes, atmStrike, spotPrice) {
  const byStrike = new Map();
  let totalCeOi = 0, totalPeOi = 0;
  for (const s of primaryStrikes || []) {
    if (!s || !Number.isFinite(s.strike)) continue;
    const ceOi = _safeNum(s.ce?.oi ?? s.call?.oi);
    const peOi = _safeNum(s.pe?.oi ?? s.put?.oi);
    byStrike.set(s.strike, { ceOi, peOi });
    totalCeOi += ceOi;
    totalPeOi += peOi;
  }
  return {
    t: Date.now(),
    atmStrike: Number.isFinite(atmStrike) ? atmStrike : null,
    spotPrice: _safeNum(spotPrice),
    byStrike,
    totalCeOi,
    totalPeOi,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute change vectors between two snapshots
// ─────────────────────────────────────────────────────────────────────────────
function _diff(prev, cur) {
  if (!prev || !cur) return null;
  const dtSec = Math.max(1, (cur.t - prev.t) / 1000);
  const perStrike = [];
  let ceAdd = 0, ceCut = 0, peAdd = 0, peCut = 0;

  for (const [strike, curRow] of cur.byStrike.entries()) {
    const prevRow = prev.byStrike.get(strike);
    if (!prevRow) continue;
    const ceΔ = curRow.ceOi - prevRow.ceOi;
    const peΔ = curRow.peOi - prevRow.peOi;
    perStrike.push({ strike, ceΔ, peΔ, ceOi: curRow.ceOi, peOi: curRow.peOi });
    if (ceΔ > 0) ceAdd += ceΔ; else ceCut += -ceΔ;
    if (peΔ > 0) peAdd += peΔ; else peCut += -peΔ;
  }

  // Velocity in OI units / second (positive = building)
  const ceNetΔ = ceAdd - ceCut;
  const peNetΔ = peAdd - peCut;
  const ceVelocity = ceNetΔ / dtSec;
  const peVelocity = peNetΔ / dtSec;

  return {
    dtSec,
    ceAdd, ceCut, peAdd, peCut,
    ceNetΔ, peNetΔ,
    ceVelocity, peVelocity,
    perStrike,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strike migration — track where the max-OI strike has moved
// ─────────────────────────────────────────────────────────────────────────────
function _strikeMigration(history) {
  if (!history || history.length < 2) return { ce: 'flat', pe: 'flat' };

  const peakStrike = (snapshot, side) => {
    let best = null, bestOi = -Infinity;
    for (const [strike, row] of snapshot.byStrike.entries()) {
      const oi = side === 'ce' ? row.ceOi : row.peOi;
      if (oi > bestOi) { bestOi = oi; best = strike; }
    }
    return best;
  };

  const first = history[0];
  const last  = history[history.length - 1];
  const fCe = peakStrike(first, 'ce');
  const lCe = peakStrike(last,  'ce');
  const fPe = peakStrike(first, 'pe');
  const lPe = peakStrike(last,  'pe');

  const move = (a, b) => (a == null || b == null) ? 'flat'
                       : b > a ? 'up'
                       : b < a ? 'down'
                       : 'flat';

  return {
    ce: move(fCe, lCe),                // CE peak rising = resistance moving up = bullish
    pe: move(fPe, lPe),                // PE peak rising = support moving up = bullish
    cePeakStrikeStart: fCe, cePeakStrikeNow: lCe,
    pePeakStrikeStart: fPe, pePeakStrikeNow: lPe,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Concentration — Herfindahl-style index over primary strikes
// ─────────────────────────────────────────────────────────────────────────────
function _concentration(snapshot) {
  if (!snapshot) return { ce: 0, pe: 0, ceTopStrike: null, peTopStrike: null };
  const ceTotal = snapshot.totalCeOi || 1;
  const peTotal = snapshot.totalPeOi || 1;
  let ceHHI = 0, peHHI = 0;
  let ceTop = null, ceTopOi = -Infinity;
  let peTop = null, peTopOi = -Infinity;
  for (const [strike, row] of snapshot.byStrike.entries()) {
    const ceShare = row.ceOi / ceTotal;
    const peShare = row.peOi / peTotal;
    ceHHI += ceShare * ceShare;
    peHHI += peShare * peShare;
    if (row.ceOi > ceTopOi) { ceTopOi = row.ceOi; ceTop = strike; }
    if (row.peOi > peTopOi) { peTopOi = row.peOi; peTop = strike; }
  }
  // HHI of 1.0 = single strike has 100% of OI; 0.0 = perfectly distributed
  return {
    ce: Number(ceHHI.toFixed(3)),
    pe: Number(peHHI.toFixed(3)),
    ceTopStrike: ceTop,
    peTopStrike: peTop,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Absorption detection — huge OI added but price didn't move much
// ─────────────────────────────────────────────────────────────────────────────
function _absorption(diff, prev, cur) {
  if (!diff || !prev || !cur) return { detected: false, side: null, reason: '' };
  const priceΔ = Math.abs(cur.spotPrice - prev.spotPrice);
  const totalNetOiΔ = Math.abs(diff.ceNetΔ) + Math.abs(diff.peNetΔ);
  const meaningfulOiBuild = totalNetOiΔ > 25_000;          // tunable, NIFTY contract level
  const tinyMove = priceΔ < 5;                              // tunable, NIFTY pts
  if (!meaningfulOiBuild || !tinyMove) return { detected: false, side: null, reason: '' };

  // Which side absorbed?
  if (diff.peNetΔ > diff.ceNetΔ * 1.3 && diff.peNetΔ > 0) {
    return { detected: true, side: 'pe',
      reason: `PE OI built ${Math.round(diff.peNetΔ)} contracts but spot moved ${priceΔ.toFixed(1)}pts — PE absorption (bullish floor)` };
  }
  if (diff.ceNetΔ > diff.peNetΔ * 1.3 && diff.ceNetΔ > 0) {
    return { detected: true, side: 'ce',
      reason: `CE OI built ${Math.round(diff.ceNetΔ)} contracts but spot moved ${priceΔ.toFixed(1)}pts — CE absorption (bearish ceiling)` };
  }
  return { detected: false, side: null, reason: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification grid:
//   Price ↑ + OI ↑ + high velocity → Aggressive Long Buildup (CE writers losing)
//   Price ↓ + OI ↑ + high velocity → Aggressive Short Buildup
//   Price ↑ + OI ↓ + high velocity → Violent Short Covering
//   Price ↓ + OI ↓ + high velocity → Long Unwinding Collapse
// ─────────────────────────────────────────────────────────────────────────────
function _classify(prev, cur, diff) {
  if (!prev || !cur || !diff) return 'unknown';
  const priceΔ = cur.spotPrice - prev.spotPrice;
  const oiΔ = (cur.totalCeOi + cur.totalPeOi) - (prev.totalCeOi + prev.totalPeOi);
  const high = Math.abs(diff.ceVelocity) + Math.abs(diff.peVelocity);
  const fast = high > 200; // ~contracts / sec, tunable

  if (priceΔ > 0 && oiΔ > 0 && fast) return 'aggressive_long_buildup';
  if (priceΔ < 0 && oiΔ > 0 && fast) return 'aggressive_short_buildup';
  if (priceΔ > 0 && oiΔ < 0 && fast) return 'violent_short_covering';
  if (priceΔ < 0 && oiΔ < 0 && fast) return 'long_unwinding_collapse';
  return 'normal';
}

// ─────────────────────────────────────────────────────────────────────────────
// OI Quality Score — direction-aware composite (0..100, 50 = neutral)
//   Weights (per spec): change 30 / velocity 25 / accel 20 / migration 15 / concentration 10
// ─────────────────────────────────────────────────────────────────────────────
function _qualityScore({ diff, accel, migration, concentration }, direction) {
  if (!diff) return { score: 50, reasons: ['no oi diff'] };
  const reasons = [];
  let s = 50;

  // 1) Change in OI (30 weight)
  //    bullish: PE building > CE building
  //    bearish: CE building > PE building
  const peDom = diff.peAdd > diff.ceAdd * 1.3;
  const ceDom = diff.ceAdd > diff.peAdd * 1.3;
  if (direction === 'bullish' && peDom)     { s += 18; reasons.push('PE OI build > CE OI build'); }
  else if (direction === 'bullish' && ceDom){ s -= 18; reasons.push('CE OI build > PE OI build (against long)'); }
  if (direction === 'bearish' && ceDom)     { s += 18; reasons.push('CE OI build > PE OI build'); }
  else if (direction === 'bearish' && peDom){ s -= 18; reasons.push('PE OI build > CE OI build (against short)'); }

  // 2) Velocity (25 weight)
  //    For bullish: PE velocity strong positive OR CE velocity strong negative (covering)
  if (direction === 'bullish') {
    if (diff.peVelocity > 200) { s += 12; reasons.push(`PE velocity ${diff.peVelocity.toFixed(0)}/s`); }
    if (diff.ceVelocity < -200){ s += 8;  reasons.push(`CE covering velocity ${diff.ceVelocity.toFixed(0)}/s`); }
    if (diff.ceVelocity > 200) { s -= 10; reasons.push(`CE writing velocity ${diff.ceVelocity.toFixed(0)}/s (against)`); }
  } else if (direction === 'bearish') {
    if (diff.ceVelocity > 200) { s += 12; reasons.push(`CE velocity ${diff.ceVelocity.toFixed(0)}/s`); }
    if (diff.peVelocity < -200){ s += 8;  reasons.push(`PE unwinding velocity ${diff.peVelocity.toFixed(0)}/s`); }
    if (diff.peVelocity > 200) { s -= 10; reasons.push(`PE writing velocity ${diff.peVelocity.toFixed(0)}/s (against)`); }
  }

  // 3) Acceleration (20 weight) — momentum ignition
  if (accel) {
    if (direction === 'bullish' && accel.peAccel > 0)  { s += 8; reasons.push('PE OI accelerating'); }
    if (direction === 'bullish' && accel.ceAccel > 0)  { s -= 6; reasons.push('CE OI accelerating (against)'); }
    if (direction === 'bearish' && accel.ceAccel > 0)  { s += 8; reasons.push('CE OI accelerating'); }
    if (direction === 'bearish' && accel.peAccel > 0)  { s -= 6; reasons.push('PE OI accelerating (against)'); }
  }

  // 4) Strike migration (15 weight)
  if (migration) {
    if (direction === 'bullish' && migration.pe === 'up')   { s += 8; reasons.push('PE peak migrating up'); }
    if (direction === 'bullish' && migration.ce === 'up')   { s += 4; reasons.push('CE peak migrating up'); }
    if (direction === 'bullish' && migration.pe === 'down') { s -= 6; reasons.push('PE support falling'); }
    if (direction === 'bearish' && migration.ce === 'down') { s += 8; reasons.push('CE peak migrating down'); }
    if (direction === 'bearish' && migration.pe === 'down') { s += 4; reasons.push('PE peak migrating down'); }
    if (direction === 'bearish' && migration.ce === 'up')   { s -= 6; reasons.push('CE resistance rising'); }
  }

  // 5) Concentration (10 weight) — high concentration = strong defense at level
  if (concentration) {
    if (direction === 'bullish' && concentration.pe > 0.4) { s += 5; reasons.push(`PE concentrated at ${concentration.peTopStrike}`); }
    if (direction === 'bearish' && concentration.ce > 0.4) { s += 5; reasons.push(`CE concentrated at ${concentration.ceTopStrike}`); }
  }

  return { score: Math.max(0, Math.min(100, Math.round(s))), reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public — analyze
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {Object} args
 * @param {Array}  args.primaryStrikes - ATM±N block from hybridEntryEngine
 * @param {number} args.atmStrike
 * @param {number} args.spotPrice
 * @param {string|object} [args.sessionId]
 * @param {string} [args.direction] - if given, returns directional score
 * @returns {Object|null}
 */
function analyze({ primaryStrikes, atmStrike, spotPrice, sessionId, direction = null } = {}) {
  _evictStale();
  if (!primaryStrikes?.length) return null;

  const cur = _buildSnapshot(primaryStrikes, atmStrike, spotPrice);
  const state = _getState(sessionId);
  state.snapshots.push(cur);
  if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots.shift();

  const history = state.snapshots;
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const diff = _diff(prev, cur);

  // Acceleration = Δvelocity / Δt
  let accel = null;
  if (history.length >= 3) {
    const prev2 = history[history.length - 3];
    const prevDiff = _diff(prev2, prev);
    if (prevDiff && diff) {
      const dtSec = Math.max(1, (cur.t - prev.t) / 1000);
      accel = {
        ceAccel: (diff.ceVelocity - prevDiff.ceVelocity) / dtSec,
        peAccel: (diff.peVelocity - prevDiff.peVelocity) / dtSec,
      };
    }
  }

  const migration     = _strikeMigration(history);
  const concentration = _concentration(cur);
  const absorption    = _absorption(diff, prev, cur);
  const regime        = _classify(prev, cur, diff);

  const out = {
    snapshotsHeld: history.length,
    diff,                 // null on first call (no prior snapshot)
    accel,                // null until 3 snapshots collected
    migration,
    concentration,
    absorption,
    regime,               // aggressive_long_buildup | aggressive_short_buildup | violent_short_covering | long_unwinding_collapse | normal | unknown
  };

  if (direction === 'bullish' || direction === 'bearish') {
    const scored = _qualityScore({ diff, accel, migration, concentration }, direction);
    out.qualityScore   = scored.score;
    out.qualityReasons = scored.reasons;
  }

  return out;
}

/** Reset all state — call between sessions / on tests. */
function reset(sessionId = null) {
  if (sessionId) STATE.delete(String(sessionId));
  else STATE.clear();
}

module.exports = { analyze, reset };
