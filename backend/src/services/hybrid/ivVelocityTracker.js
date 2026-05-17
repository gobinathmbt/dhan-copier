/**
 * IV Velocity Tracker
 * ===================
 * Lightweight intraday ATM-IV history per session.
 *
 * Purpose: detect IV crushes (rapid IV drops post-event / post-expiry-open)
 * which create asymmetric premium decay — a high-WR setup for the side
 * benefiting from the IV crush direction.
 *
 * State: a rolling Map of last N IV samples per (sessionId, date).
 * Eviction: keep only last 24 samples (~120 minutes of 5-min cycles).
 */

const STATE = new Map();         // key = `${sessionId}|${date}` → array of {ts, iv}
const MAX_SAMPLES = 24;

function _key(sessionId, date) { return `${sessionId || 'live'}|${date || 'today'}`; }

/**
 * Record the current ATM IV sample.
 * @param {Object} args
 * @param {string} args.sessionId
 * @param {string} args.date          - 'YYYY-MM-DD'
 * @param {number} args.atmIv         - current ATM IV (CE or PE; we average)
 * @param {number} args.ts            - epoch seconds
 */
function record({ sessionId, date, atmIv, ts } = {}) {
  if (!Number.isFinite(atmIv) || atmIv <= 0) return null;
  const k = _key(sessionId, date);
  let arr = STATE.get(k);
  if (!arr) { arr = []; STATE.set(k, arr); }
  arr.push({ ts: Number(ts) || Math.floor(Date.now() / 1000), iv: atmIv });
  if (arr.length > MAX_SAMPLES) arr.shift();
  return arr.length;
}

/**
 * Compute IV velocity stats:
 *   - currentIv
 *   - dayHighIv    — highest IV seen this session
 *   - dayLowIv     — lowest IV seen this session
 *   - dropFromHigh — currentIv − dayHighIv (negative = crushed)
 *   - dropPctFromHigh — % drop
 *   - vel30        — IV change vs 30 minutes ago (6 samples)
 *   - vel15        — IV change vs 15 minutes ago (3 samples)
 *   - state        — 'crushing' | 'rising' | 'stable'
 */
function getStats({ sessionId, date } = {}) {
  const k = _key(sessionId, date);
  const arr = STATE.get(k);
  if (!arr || arr.length < 2) return null;
  const currentIv = arr[arr.length - 1].iv;
  const dayHighIv = Math.max(...arr.map(x => x.iv));
  const dayLowIv  = Math.min(...arr.map(x => x.iv));
  const dropFromHigh = currentIv - dayHighIv;
  const dropPctFromHigh = dayHighIv > 0 ? (dropFromHigh / dayHighIv) * 100 : 0;

  const sample30 = arr[Math.max(0, arr.length - 7)]?.iv ?? null;
  const sample15 = arr[Math.max(0, arr.length - 4)]?.iv ?? null;
  const vel30 = Number.isFinite(sample30) ? currentIv - sample30 : null;
  const vel15 = Number.isFinite(sample15) ? currentIv - sample15 : null;

  let state = 'stable';
  if (vel30 !== null && vel30 < -1.5) state = 'crushing';        // IV down >1.5pts in 30m
  else if (vel30 !== null && vel30 > 1.5) state = 'rising';

  return {
    samples: arr.length,
    currentIv: Number(currentIv.toFixed(2)),
    dayHighIv: Number(dayHighIv.toFixed(2)),
    dayLowIv:  Number(dayLowIv.toFixed(2)),
    dropFromHigh:    Number(dropFromHigh.toFixed(2)),
    dropPctFromHigh: Number(dropPctFromHigh.toFixed(2)),
    vel30: vel30 !== null ? Number(vel30.toFixed(2)) : null,
    vel15: vel15 !== null ? Number(vel15.toFixed(2)) : null,
    state,
  };
}

/** Clear stored state for a session/date (testing or rollover). */
function clear({ sessionId, date } = {}) {
  if (sessionId == null && date == null) {
    STATE.clear();
    return;
  }
  STATE.delete(_key(sessionId, date));
}

module.exports = { record, getStats, clear };
