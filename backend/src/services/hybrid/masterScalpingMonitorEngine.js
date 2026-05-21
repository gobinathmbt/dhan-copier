/**
 * Master Scalping Monitor Engine
 * ==============================
 * Routes the per-trade exit decision to the correct sub-engine based on
 * the trade's `engineType` field (stamped at entry by the master entry).
 *
 *   trade.engineType === 'ULTRA_SCALP'   → ultraScalp + runnerExitEngine
 *   trade.engineType === 'SUPPORT_SCALP' → supportScalpExitValidator
 *                                          (full microstructure re-check —
 *                                           same data depth as entry)
 *   trade.engineType === 'CORE'          → hybridMonitorEngine (full
 *                                          institutional decay + adaptive
 *                                          + state machine)
 *
 * This keeps engine-specific exit behaviour encapsulated. A trade entered
 * by the ULTRA engine will NEVER exit on a CORE rule and vice-versa.
 */

const runnerExitEngine = require('./runnerExitEngine');
const supportScalpExitValidator = require('./supportScalpExitValidator');

// Lazy-required heavy deps
let _coreMonitor = null;
function _getCoreMonitor() {
  if (!_coreMonitor) _coreMonitor = require('./hybridMonitorEngine');
  return _coreMonitor;
}

const hybridLogger = require('./hybridLogger');

function _elapsedSec(trade) {
  const t = new Date(trade.openedAt || trade.createdAt || Date.now()).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function _exit(reason, source) {
  return { action: 'EXIT', new_sl: null, add_lots: null, confidence: 10,
           reasoning: reason, exit_urgency: 'immediate', source };
}
function _hold(reason, source) {
  return { action: 'HOLD', new_sl: null, add_lots: null, confidence: 10,
           reasoning: reason, exit_urgency: 'soft', source };
}
function _trail(newSl, reason, source) {
  return { action: 'TRAIL_SL', new_sl: newSl, add_lots: null, confidence: 9,
           reasoning: reason, exit_urgency: 'soft', source };
}

/** Build 3m candles from 1m, IST-aligned, only closed bars. Mirrors the
 *  entry path's _build3m so the exit validator sees the same buckets. */
const _IST_OFFSET_SEC = 5 * 3600 + 30 * 60;
function _build3m(c1m) {
  if (!Array.isArray(c1m) || c1m.length < 3) return [];
  const intervalSec = 180;
  const groups = new Map();
  for (const c of c1m) {
    const t = Number(c.t ?? c.time);
    if (!Number.isFinite(t)) continue;
    const tIst = t + _IST_OFFSET_SEC;
    const bucketIst = Math.floor(tIst / intervalSec) * intervalSec;
    const bucketUtc = bucketIst - _IST_OFFSET_SEC;
    if (!groups.has(bucketUtc)) groups.set(bucketUtc, []);
    groups.get(bucketUtc).push(c);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const out = [];
  for (const [bucketStart, bars] of groups) {
    const bucketEnd = bucketStart + intervalSec;
    if (bucketEnd > nowSec) continue;
    bars.sort((a, b) => Number(a.t ?? a.time) - Number(b.t ?? b.time));
    const o = bars[0].o ?? bars[0].open;
    const cl = bars[bars.length - 1].c ?? bars[bars.length - 1].close;
    let h = -Infinity, l = Infinity, v = 0;
    for (const b of bars) {
      const bh = b.h ?? b.high, bl = b.l ?? b.low, bv = b.v ?? b.volume ?? 0;
      if (Number.isFinite(bh) && bh > h) h = bh;
      if (Number.isFinite(bl) && bl < l) l = bl;
      v += bv;
    }
    out.push({ o, h, l, c: cl, v, t: bucketStart });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Decide what to do with an open trade.
 *
 * Returns one of:
 *   { action: 'EXIT', reasoning, source }
 *   { action: 'HOLD', reasoning, source }
 *   { action: 'TRAIL_SL', new_sl, reasoning, source }
 *
 * The caller (scalpingEngine.service.js) handles the actual execution.
 */
async function decide(args) {
  const trade = args?.trade;
  const settings = args?.settings || {};
  if (!trade) return _hold('no trade', 'master:noop');

  const engineType = trade.engineType || 'CORE';

  // ── CORE engine — delegate to the institutional monitor ─────────────
  if (engineType === 'CORE') {
    try {
      return await _getCoreMonitor().decide(args);
    } catch (e) {
      hybridLogger.warn({
        sessionId: trade.sessionId, tradeId: trade._id,
        event: 'master_monitor_core_error',
        message: e.message, data: { err: e.message },
      });
      return _hold(`core monitor error: ${e.message}`, 'master:core_error');
    }
  }

  // ── SUPPORT_SCALP — dedicated microstructure-aware exit validator ────
  // The entry was earned by 9 microstructure factors agreeing. Now we
  // continuously re-verify those factors. If 2+ flip, exit fast.
  if (engineType === 'SUPPORT_SCALP') {
    try {
      // Build per-TF candle arrays from the aggregator payload.
      const payload = args?.aggregator?.payload || {};
      const candles = payload?.candles || {};
      const candles1m  = candles['1m']  || [];
      const candles5m  = candles['5m']  || [];
      const candles15m = candles['15m'] || [];
      // 3m built from 1m on the fly (same as entry side)
      const candles3m  = _build3m(candles1m);

      const exitDecision = supportScalpExitValidator.decide({
        trade,
        aggregator: args.aggregator,
        candles1m, candles3m, candles5m, candles15m,
        settings,
      });

      // Hybrid logger for visibility — same shape as entry events
      hybridLogger.info({
        sessionId: trade.sessionId, tradeId: trade._id,
        event: 'master_support_exit',
        message: exitDecision.reasoning,
        data: {
          action: exitDecision.action,
          source: exitDecision.source,
          factors: exitDecision.factors,
        },
      });

      // Translate to the action shape master monitor returns
      if (exitDecision.action === 'EXIT') {
        return _exit(exitDecision.reasoning, exitDecision.source);
      }
      if (exitDecision.action === 'TRAIL_SL') {
        return _trail(exitDecision.new_sl, exitDecision.reasoning, exitDecision.source);
      }
      return _hold(exitDecision.reasoning, exitDecision.source);
    } catch (e) {
      hybridLogger.warn({
        sessionId: trade.sessionId, tradeId: trade._id,
        event: 'master_support_exit_error',
        message: e.message, data: { err: e.message, stack: e.stack?.slice(0, 400) },
      });
      // Fall through to generic runner exit as safety net
    }
  }

  // ── ULTRA / SUPPORT scalp — runner exit engine ──────────────────────
  // Both ultra and support scalps use the same runnerExitEngine. The
  // difference is in target_pts / sl_pts / smartTrail (stamped at entry).
  const elapsed = _elapsedSec(trade);
  const entry  = Number(trade.entryPrice);
  const cur    = Number(trade.currentPrice) || entry;
  const peak   = Number(trade.maxPriceReached) || entry;
  const targetPts = Math.max(1, Number(trade.target) - entry || (settings?.targetPoints || 10));
  const slPts     = Math.max(1, entry - Number(trade.sl)    || (settings?.slPoints     || 15));
  const maxHoldSec = Number(trade.maxHoldSeconds)
                  || Number(settings?.maxHoldTimeSeconds)
                  || 180;

  // 1. Hard SL — always honoured
  if (trade.sl && cur <= trade.sl) {
    return _exit(`SL hit (${cur} ≤ ${trade.sl}) at ${elapsed}s`,
      `master:${engineType.toLowerCase()}_sl`);
  }
  // 2. Hard target — engine-aware: when smartTrail.mode is runner, allow override
  const smartTrail = trade.aiEntryDecision?.hybridSnapshot?.entryType?.playbook?.smartTrail
                  || trade.hybridEntrySnapshot?.entryType?.playbook?.smartTrail
                  || null;
  const isRunner = smartTrail?.mode === 'runner'
                || smartTrail?.mode === 'hybrid_runner_continuation';
  const targetPrice = entry + targetPts;
  if (cur >= targetPrice && !isRunner) {
    return _exit(`Target hit (${cur} ≥ ${targetPrice})`,
      `master:${engineType.toLowerCase()}_target`);
  }

  // 3. Min hold — only SL is allowed before this
  const minHold = 30;
  if (elapsed < minHold) {
    return _hold(`Min hold ${elapsed}s/${minHold}s`,
      `master:${engineType.toLowerCase()}_min_hold`);
  }

  // 4. Severe quick-loss safety net (30-60s, ≤ -10pts)
  const pnlPts = cur - entry;
  if (elapsed >= 30 && elapsed < 60 && pnlPts <= -10) {
    return _exit(`Severe quick loss ${pnlPts.toFixed(2)}pts at ${elapsed}s`,
      `master:${engineType.toLowerCase()}_fast_loss`);
  }

  // 5. Runner exit engine (smart-lock, anti-mediocre, velocity decay,
  //    momentum-decay, peak giveback)
  if (smartTrail) {
    const exitRes = runnerExitEngine.decideRunnerExit({
      entry, current: cur, peak,
      targetPts, slPts, smartTrail,
      volState: trade.aiEntryDecision?.hybridSnapshot?.volatilityState
             || trade.hybridEntrySnapshot?.volatilityState
             || 'normal',
      momentum: {},
      heldSec: elapsed, maxHoldSec,
    });
    if (exitRes.action === 'EXIT') {
      const src = exitRes.reason.startsWith('SL hit')          ? `master:${engineType.toLowerCase()}_sl`
                : exitRes.reason.startsWith('Target hit')      ? `master:${engineType.toLowerCase()}_target`
                : exitRes.reason.startsWith('Smart-lock')      ? `master:${engineType.toLowerCase()}_smart_lock`
                : exitRes.reason.startsWith('Adaptive')        ? `master:${engineType.toLowerCase()}_smart_trail`
                : exitRes.reason.startsWith('Runner end')      ? `master:${engineType.toLowerCase()}_runner_end`
                : exitRes.reason.startsWith('Anti-mediocre')   ? `master:${engineType.toLowerCase()}_anti_mediocre`
                : exitRes.reason.startsWith('Early failure')   ? `master:${engineType.toLowerCase()}_early_fail`
                : exitRes.reason.startsWith('Velocity')        ? `master:${engineType.toLowerCase()}_velocity_decay`
                :                                                 `master:${engineType.toLowerCase()}_runner_exit`;
      return _exit(exitRes.reason, src);
    }
  }

  // 6. Max hold time
  if (elapsed >= maxHoldSec) {
    return _exit(`Max hold reached ${elapsed}s ≥ ${maxHoldSec}s, P&L ${pnlPts.toFixed(2)}pts`,
      `master:${engineType.toLowerCase()}_max_hold`);
  }

  return _hold(`elapsed=${elapsed}s peak=${(peak - entry).toFixed(2)}pts pnl=${pnlPts.toFixed(2)}pts`,
    `master:${engineType.toLowerCase()}_hold`);
}

module.exports = { decide };
