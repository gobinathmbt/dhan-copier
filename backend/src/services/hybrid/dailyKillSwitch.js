/**
 * Daily Kill Switch
 * =================
 * Operational-safety gate that prevents new entries after a day has gone
 * badly. Two triggers:
 *
 *   1. Consecutive-loss count (default 3)
 *   2. Net session P&L vs starting capital (default −2%)
 *
 * The first protects against trade-clustering bleed (chop sessions where
 * the engine fires 5 setups, all lose). The second protects against any
 * single bad trade or compound bleed exceeding daily loss budget.
 *
 * State is in-memory and resets on session start. Wires from
 * scalpingEngine.closeTrade() (records loss) and is consulted in
 * masterScalpingEntryEngine.decide() (blocks new fires).
 *
 * Opt-in via settings.dailyKillSwitch.enabled.
 */

let _state = {
  consecutiveLosses: 0,
  totalRealisedPnl: 0,
  startingCapital: 0,
  killed: false,
  killedReason: null,
  killedAt: null,
};

function reset(startingCapital = 0) {
  _state = {
    consecutiveLosses: 0,
    totalRealisedPnl: 0,
    startingCapital: Number(startingCapital) || 0,
    killed: false,
    killedReason: null,
    killedAt: null,
  };
}

function _evalThresholds(cfg) {
  const maxConsecLosses  = Number(cfg.maxConsecutiveLosses ?? 3);
  const maxDailyLossPct  = Number(cfg.maxDailyLossPct ?? 2.0);  // 2%
  const lossPctNow = _state.startingCapital > 0
    ? Math.max(0, -_state.totalRealisedPnl) / _state.startingCapital * 100
    : 0;

  if (_state.consecutiveLosses >= maxConsecLosses) {
    return { kill: true, reason: `${_state.consecutiveLosses} consecutive losses ≥ limit ${maxConsecLosses}` };
  }
  if (lossPctNow >= maxDailyLossPct) {
    return { kill: true,
      reason: `daily loss ${lossPctNow.toFixed(2)}% ≥ limit ${maxDailyLossPct.toFixed(2)}% ` +
              `(realised ₹${_state.totalRealisedPnl.toFixed(0)} of ₹${_state.startingCapital.toFixed(0)})` };
  }
  return { kill: false };
}

/**
 * Called from closeTrade() when a SUPPORT_SCALP trade closes.
 * Updates loss counter, then checks thresholds. If a threshold is hit,
 * `killed` flag is set and subsequent isKilled() calls return true.
 */
function recordTradeClose({ result, pnl, settings = {} } = {}) {
  const cfg = settings?.dailyKillSwitch || {};
  if (cfg.enabled === false) return { killed: false };

  _state.totalRealisedPnl += Number(pnl) || 0;
  if (result === 'LOSS') _state.consecutiveLosses += 1;
  else if (result === 'WIN') _state.consecutiveLosses = 0;
  // BREAKEVEN doesn't change the streak

  const r = _evalThresholds(cfg);
  if (r.kill && !_state.killed) {
    _state.killed = true;
    _state.killedReason = r.reason;
    _state.killedAt = new Date().toISOString();
  }
  return { killed: _state.killed, reason: _state.killedReason };
}

/**
 * Consulted by master entry engine before letting a new fire through.
 * Returns true if no new entries are allowed for the rest of the day.
 */
function isKilled(settings = {}) {
  const cfg = settings?.dailyKillSwitch || {};
  if (cfg.enabled === false) return false;
  return _state.killed;
}

function getState() {
  return { ..._state };
}

module.exports = { reset, recordTradeClose, isKilled, getState };
