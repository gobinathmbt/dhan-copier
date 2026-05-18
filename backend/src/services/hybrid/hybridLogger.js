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
 *
 * Session log files
 * -----------------
 * When a sessionId is present, each hybrid event is ALSO appended to
 * backend/logs/session-{sessionId}.log in JSONL format. This mirrors the
 * backtest log format so the same analyze-log.js tool can be used for
 * post-session calibration.
 */
const engineLogger = require('../engineLogger.service');
const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');

const PREFIX = '[hybrid]';

// Resolve the logs directory relative to this file's location.
// __dirname = backend/src/services/hybrid  →  ../../.. = backend
const LOGS_DIR = path.resolve(__dirname, '..', '..', '..', 'logs');

function _safeSessionId(sessionId) {
  if (!sessionId) return null;
  try { return String(sessionId); } catch (_) { return null; }
}

/**
 * Append a JSONL line to the session-specific log file.
 * Creates the file (and logs directory) if they don't exist.
 */
function _appendSessionFile(sid, record) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const filePath = path.join(LOGS_DIR, `session-${sid}.log`);
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    // Non-fatal — don't let file I/O break the trading pipeline.
    logger.warn({ err: e.message, sid }, '[hybrid] failed to write session log file');
  }
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

  // Warn early if sessionId is missing — hybrid events won't be queryable.
  if (!sid) {
    logger.warn({ event }, '[hybrid] sessionId missing — hybrid event will not be persisted to DB or session log file');
  }

  // Always log to console first — useful even before a session exists.
  const consoleData = { sessionId: sid, tradeId, ...data };
  if (level === 'error') logger.error(consoleData, `${PREFIX} ${message}`);
  else if (level === 'warn') logger.warn(consoleData, `${PREFIX} ${message}`);
  else logger.info(consoleData, `${PREFIX} ${message}`);

  if (!sid) return;

  // Persist to engineLogger (MongoDB + daily engine log file).
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

  // Also write to session-specific JSONL file for post-session calibration
  // using the same analyze-log.js tool that processes backtest logs.
  _appendSessionFile(sid, {
    ts: new Date().toISOString(),
    sessionId: sid,
    eventType,
    level,
    message: `${PREFIX} ${message}`,
    tradeId,
    ...data,
  });
}

/** Convenience helpers — mirror the engineLogger style. */
function info(args)  { return log({ ...args, level: 'info' }); }
function warn(args)  { return log({ ...args, level: 'warn' }); }
function error(args) { return log({ ...args, level: 'error' }); }

module.exports = { log, info, warn, error };
