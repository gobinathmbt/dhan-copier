/**
 * Position State Machine
 * ----------------------
 * Lightweight FSM that tags every open trade with a lifecycle stage. Used by
 * the monitor engine to decide what *kind* of action is allowed next.
 *
 *   PENDING       — order placed, fill not yet confirmed (we mostly skip this
 *                   today since fills are synchronous)
 *   ENTERED       — fresh fill, < 30s elapsed, hold to let trade develop
 *   MANAGING      — normal monitoring window (post 30s, pre 2min)
 *   TRAILING      — target ≥ 80% achieved, ride trailing SL
 *   PARTIAL_EXIT  — partial booking done (future use, not active yet)
 *   FULL_EXIT     — closed
 *   COOLDOWN      — recently closed, prevent rapid re-entry on same strike
 */

const STATES = {
  PENDING:      'PENDING',
  ENTERED:      'ENTERED',
  MANAGING:     'MANAGING',
  TRAILING:     'TRAILING',
  PARTIAL_EXIT: 'PARTIAL_EXIT',
  FULL_EXIT:    'FULL_EXIT',
  COOLDOWN:     'COOLDOWN',
};

/**
 * Compute the current state for an open trade.
 *
 * @param {Object} trade - ScalpingTrade document (lean or hydrated)
 * @param {Object} settings
 * @returns {string} state from STATES
 */
function computeState(trade, settings = {}) {
  if (!trade) return STATES.PENDING;
  if (trade.status === 'closed') return STATES.FULL_EXIT;

  const targetPoints = Number(settings.targetPoints) || 10;
  const entry = Number(trade.entryPrice) || 0;
  const cur   = Number(trade.currentPrice) || entry;
  const pnlPts = cur - entry;
  const pctOfTarget = (pnlPts / Math.max(1, targetPoints)) * 100;

  const elapsedMs = Date.now() - new Date(trade.openedAt || trade.createdAt || Date.now()).getTime();
  const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));

  if (elapsedSec < 30) return STATES.ENTERED;
  if (pctOfTarget >= 80) return STATES.TRAILING;
  return STATES.MANAGING;
}

/**
 * Decide what kinds of actions are allowed in the current state.
 */
function allowedActions(state) {
  switch (state) {
    case STATES.PENDING:
    case STATES.ENTERED:
      return ['HOLD'];                                      // do not exit early
    case STATES.MANAGING:
      return ['HOLD', 'EXIT', 'TRAIL_SL'];
    case STATES.TRAILING:
      return ['HOLD', 'EXIT', 'TRAIL_SL', 'ADD_QUANTITY'];  // pyramid only after 80% target
    case STATES.PARTIAL_EXIT:
      return ['HOLD', 'EXIT', 'TRAIL_SL'];
    default:
      return ['HOLD'];
  }
}

module.exports = { STATES, computeState, allowedActions };
