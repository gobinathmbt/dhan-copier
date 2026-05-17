/**
 * Hybrid Logger
 * -------------
 * Thin wrapper around the existing session engineLogger so every hybrid
 * decision (gate fire, score, regime, exit reason, etc.) lands in the same
 * session log stream the rest of the engine writes to.
 *
 * Why a wrapper? The hybrid pipeline emits a LOT of structured signals and we
 * want them all tagged with `hybrid_*` event types and a stable shape. That
 * keeps the database queryable later when we want to back-test our gates.
 */
const engineLogger = require('../engineLogger.service');
const logger = require('../../utils/logger');

const PREFIX = '[hybrid]';

function _safeSessionId(sessionId) {
  if (!sessionId) return null;
  try { return String(sessionId); } catch (_) { return null; }
}

/**
 * Log a hybrid pipeline event.
 *
 * @param {Object}  params
 * @param {string=} params.sessionId    - ScalpingSession _id (optional but recommended)
 * @param {string}  params.event        - subtype, e.g. 'tier1_fail', 'score', 'regime'
 * @param {string=} params.level        - 'info' | 'warn' | 'error' (default 'info')
 * @param {string}  params.message      - human readable summary
 * @param {Object=} params.data         - structured payload
 * @param {string=} params.tradeId      - related trade _id (optional)
 */
async function log({ sessionId, event, level = 'info', message, data = {}, tradeId = null }) {
  const eventType = `hybrid_${event}`;
  const sid = _safeSessionId(sessionId);

  // Always log to console first — useful even before a session exists.
  const consoleData = { sessionId: sid, tradeId, ...data };
  if (level === 'error') logger.error(consoleData, `${PREFIX} ${message}`);
  else if (level === 'warn') logger.warn(consoleData, `${PREFIX} ${message}`);
  else logger.info(consoleData, `${PREFIX} ${message}`);

  // Persist to engineLogger only when we have a sessionId.
  if (!sid) return;
  try {
    await engineLogger.logEvent({
      sessionId: sid,
      eventType,
      level,
      message: `${PREFIX} ${message}`,
      data,
      tradeId,
    });
  } catch (e) {
    logger.warn({ err: e.message, eventType }, '[hybrid] failed to persist hybrid log entry');
  }
}

/** Convenience helpers — mirror the engineLogger style. */
function info(args)  { return log({ ...args, level: 'info' }); }
function warn(args)  { return log({ ...args, level: 'warn' }); }
function error(args) { return log({ ...args, level: 'error' }); }

module.exports = { log, info, warn, error };
