/**
 * Session Engine — IST trading session phase classifier.
 *
 * The phase label and aggression factor are still emitted for telemetry
 * and downstream sizing, but ENTRIES are no longer time-gated except for
 * a single hard cutoff:
 *
 *   • 09:15 IST → 15:00 IST   allowEntries = true
 *   • 15:00 IST → 15:30 IST   allowEntries = false (square-off only)
 *   • outside trading day     allowEntries = false
 *
 * Whether a candle-warmup or data-readiness gate is satisfied is decided
 * by the support / ultra / core engines themselves (e.g. "insufficient 3m
 * candles") — not by this clock.
 */

const TZ = 'Asia/Kolkata';

const ENTRY_CUTOFF_HHMM = 1500;          // hard stop for new entries
const SQUARE_OFF_END    = 1530;          // exchange close

function _istParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return {
    weekday: parts.weekday,                   // e.g. "Thu"
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    hhmm: parseInt(parts.hour, 10) * 100 + parseInt(parts.minute, 10),
  };
}

/**
 * Classify the current trading session phase.
 *
 * Phase labels (kept for telemetry / strategy hints):
 *   09:15–09:45  opening_drive
 *   09:45–11:30  morning
 *   11:30–13:30  midday_chop
 *   13:30–14:15  afternoon
 *   14:15–15:00  power_hour
 *   15:00–15:30  closing
 *   else         pre_market / closed
 *
 * `allowEntries` is true for the whole 09:15–15:00 band. Phase only
 * influences strategy hints, aggression sizing, and expiry-window guards.
 */
function classifySession(now = new Date(), opts = {}) {
  const { weekday, hhmm } = _istParts(now);
  const restrictHQ = opts.restrictToHighQualityPhases === true;

  let phase = 'pre_market';
  let aggressionFactor = 0;
  const allowedStrategies = new Set();

  // Inside the trading window (09:15 – 15:30 IST)?
  const inSession = hhmm >= 915 && hhmm < SQUARE_OFF_END;
  // Are new entries allowed? Yes for 09:15 – 15:00, no for 15:00–15:30.
  let allowEntries = hhmm >= 915 && hhmm < ENTRY_CUTOFF_HHMM;

  if (hhmm >= 915 && hhmm < 945) {
    phase = 'opening_drive';
    aggressionFactor = 0.7;
    allowedStrategies.add('momentum');
    allowedStrategies.add('breakout');
  } else if (hhmm >= 945 && hhmm < 1130) {
    phase = 'morning';
    aggressionFactor = 1.0;
    allowedStrategies.add('momentum');
    allowedStrategies.add('breakout');
    allowedStrategies.add('trend_continuation');
    allowedStrategies.add('scalp');
  } else if (hhmm >= 1130 && hhmm < 1330) {
    phase = 'midday_chop';
    aggressionFactor = 0.7;          // size still allowed, just smaller
    allowedStrategies.add('mean_reversion');
    allowedStrategies.add('scalp');
  } else if (hhmm >= 1330 && hhmm < 1415) {
    phase = 'afternoon';
    aggressionFactor = 0.85;
    allowedStrategies.add('momentum');
    allowedStrategies.add('trend_continuation');
    allowedStrategies.add('scalp');
  } else if (hhmm >= 1415 && hhmm < ENTRY_CUTOFF_HHMM) {
    phase = 'power_hour';
    aggressionFactor = 1.0;
    allowedStrategies.add('momentum');
    allowedStrategies.add('breakout');
    allowedStrategies.add('trend_continuation');
    allowedStrategies.add('scalp');
  } else if (hhmm >= ENTRY_CUTOFF_HHMM && hhmm < SQUARE_OFF_END) {
    phase = 'closing';
    aggressionFactor = 0;
    // allowEntries already false from above
  } else {
    phase = 'closed';
    aggressionFactor = 0;
  }

  // ── Expiry window: Thu/Wed last 90 minutes (institutional manipulation zone)
  const isExpiryDay = (weekday === 'Thu');
  const isExpiryWindow = isExpiryDay && hhmm >= 1400;
  if (isExpiryWindow) {
    aggressionFactor = Math.min(aggressionFactor, 0.6);
  }

  // ── High-quality-phase restriction (live-only opt-in) ────────────────
  // Only takes effect when explicitly enabled via settings.
  let restrictedByPhaseFilter = false;
  if (restrictHQ && allowEntries && phase !== 'morning' && phase !== 'power_hour') {
    allowEntries = false;
    restrictedByPhaseFilter = true;
  }

  return {
    phase,
    hhmm,
    weekday,
    aggressionFactor: Number(aggressionFactor.toFixed(2)),
    allowEntries,
    inSession,
    isMarketOpen: inSession,
    allowedStrategies: Array.from(allowedStrategies),
    isExpiryDay,
    isExpiryWindow,
    isMiddayChop: phase === 'midday_chop',
    isPowerHour: phase === 'power_hour',
    isOpeningDrive: phase === 'opening_drive',
    restrictedByPhaseFilter,
    entryCutoffHhmm: ENTRY_CUTOFF_HHMM,
    squareOffEndHhmm: SQUARE_OFF_END,
  };
}

/** Convenience: should we even attempt a new entry in this session phase? */
function isEntryAllowed(now = new Date(), opts = {}) {
  return classifySession(now, opts).allowEntries;
}

module.exports = {
  classifySession,
  isEntryAllowed,
  ENTRY_CUTOFF_HHMM,
  SQUARE_OFF_END,
};
