/**
 * Session Engine — IST trading session phase classifier.
 *
 * NIFTY behaves differently across the day. The institutional blueprint
 * demands aggression be modulated by session phase, so we expose:
 *   - phase             — opening_drive | morning | midday_chop | afternoon | power_hour | closing
 *   - aggressionFactor  — 0.0 .. 1.0 multiplier for position sizing
 *   - allowedStrategies — set of strategy types that make sense in this phase
 *   - isExpiryWindow    — Thu/Wed last 90 minutes (manipulation zone)
 *
 * Everything is computed locally from `Asia/Kolkata`. No network calls, no
 * dependencies — this must always succeed.
 */

const TZ = 'Asia/Kolkata';

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
 * Phases (IST):
 *   09:15–09:45  opening_drive   — high vol, trend formation, careful with chop
 *   09:45–11:30  morning         — best trading window, full aggression
 *   11:30–13:30  midday_chop     — sideways, fake breakouts, reduce aggression
 *   13:30–14:15  afternoon       — directional pickups, normal aggression
 *   14:15–15:15  power_hour      — trend resolution, full aggression
 *   15:15–15:30  closing         — square-off, no new entries
 *   else         pre_market / post_market — no trading
 */
function classifySession(now = new Date()) {
  const { weekday, hhmm } = _istParts(now);

  // Default
  let phase = 'pre_market';
  let aggressionFactor = 0;
  let allowEntries = false;
  const allowedStrategies = new Set();

  if (hhmm >= 915 && hhmm < 945) {
    phase = 'opening_drive';
    aggressionFactor = 0.6;
    allowEntries = true;
    allowedStrategies.add('momentum');
    allowedStrategies.add('breakout');
  } else if (hhmm >= 945 && hhmm < 1130) {
    phase = 'morning';
    aggressionFactor = 1.0;
    allowEntries = true;
    allowedStrategies.add('momentum');
    allowedStrategies.add('breakout');
    allowedStrategies.add('trend_continuation');
    allowedStrategies.add('scalp');
  } else if (hhmm >= 1130 && hhmm < 1330) {
    phase = 'midday_chop';
    aggressionFactor = 0.5;
    allowEntries = true;        // calibrated: was permitted but heavily filtered — same now
    allowedStrategies.add('mean_reversion');
    allowedStrategies.add('scalp');           // allow scalps with smaller size
  } else if (hhmm >= 1330 && hhmm < 1415) {
    phase = 'afternoon';
    aggressionFactor = 0.8;
    allowEntries = true;
    allowedStrategies.add('momentum');
    allowedStrategies.add('trend_continuation');
    allowedStrategies.add('scalp');
  } else if (hhmm >= 1415 && hhmm < 1515) {
    phase = 'power_hour';
    aggressionFactor = 1.0;
    allowEntries = true;
    allowedStrategies.add('momentum');
    allowedStrategies.add('breakout');
    allowedStrategies.add('trend_continuation');
    allowedStrategies.add('scalp');
  } else if (hhmm >= 1515 && hhmm < 1530) {
    phase = 'closing';
    aggressionFactor = 0;
    allowEntries = false;       // square-off only, no new entries
  } else {
    phase = 'closed';
    aggressionFactor = 0;
    allowEntries = false;
  }

  // ── Expiry window: Thu/Wed last 90 minutes (institutional manipulation zone)
  // NSE NIFTY weekly expiry is currently Thursday. We treat the final 90 mins
  // as a high-risk window where size must drop and gates must tighten.
  const isExpiryDay = (weekday === 'Thu');               // tweak when NSE changes
  const isExpiryWindow = isExpiryDay && hhmm >= 1400;    // 14:00 – 15:30 IST
  if (isExpiryWindow) {
    aggressionFactor = Math.min(aggressionFactor, 0.5);
  }

  return {
    phase,
    hhmm,
    weekday,
    aggressionFactor: Number(aggressionFactor.toFixed(2)),
    allowEntries,
    allowedStrategies: Array.from(allowedStrategies),
    isExpiryDay,
    isExpiryWindow,
    isMiddayChop: phase === 'midday_chop',
    isPowerHour: phase === 'power_hour',
    isOpeningDrive: phase === 'opening_drive',
  };
}

/**
 * Convenience: should we even attempt a new entry in this session phase?
 */
function isEntryAllowed(now = new Date()) {
  return classifySession(now).allowEntries;
}

module.exports = {
  classifySession,
  isEntryAllowed,
};
