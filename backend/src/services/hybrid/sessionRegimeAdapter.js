/**
 * Session Regime Adapter
 * ======================
 * Returns time-of-day-conditioned overrides for the support scalp engine
 * thresholds — but DOES NOT block entries based on the clock.
 *
 * Design (CALIBRATED 2026-05-27):
 *   • Engine starts when data + candles are ready (handled by support
 *     scalp's "insufficient 3m candles" warmup gate, not here).
 *   • Engine runs continuously until 15:00 IST. After 15:00 IST → blocked
 *     so existing positions can square-off cleanly into 15:30 close.
 *   • Score-override calibrations stay (size goes down in chop windows,
 *     score floor goes up around opening volatility) but no window
 *     ever sets allowEntries=false purely on the clock between 09:15–15:00.
 *
 * Public shape unchanged:
 *   { enabled, regime, allowEntries, minScoreOverride,
 *     targetMinOverride, targetMaxOverride, sizingFactorMul, reasoning }
 */

const ENTRY_CUTOFF_MIN = 15 * 60;          // 15:00 IST — no new entries after this

const DEFAULT_REGIME_TABLE = [
  // Opening 30 min — high vol, expand stops, smaller size
  { startMin:  9*60+15, endMin:  9*60+45, name: 'opening_volatility',
    minScoreOverride: 60, targetMinOverride: 18, sizingFactorMul: 0.7 },
  // Prime morning trend window — full size, default score floor
  { startMin:  9*60+45, endMin: 11*60+30, name: 'trend_continuation',
    minScoreOverride: null, targetMinOverride: null, sizingFactorMul: 1.0 },
  // Midday chop — was hard-blocked, now LET THROUGH with reduced size
  // and a higher score floor so only the cleanest setups pass.
  { startMin: 11*60+30, endMin: 13*60+30, name: 'midday_chop',
    minScoreOverride: 65, targetMinOverride: 12, sizingFactorMul: 0.6 },
  // Afternoon reversal — moderate filtering
  { startMin: 13*60+30, endMin: 14*60+30, name: 'afternoon_reversal',
    minScoreOverride: 60, targetMinOverride: 15, sizingFactorMul: 0.7 },
  // Pre-close (14:30 → 15:00) — was hard-blocked, now LET THROUGH at
  // reduced size so we can still ride the close push.
  { startMin: 14*60+30, endMin: ENTRY_CUTOFF_MIN, name: 'pre_close_push',
    minScoreOverride: 65, targetMinOverride: 12, sizingFactorMul: 0.5 },
];

function _istMinutesNow() {
  const ms = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Returns the regime override block for the current time, or a no-op
 * passthrough when disabled. Hard cutoff: no new entries after 15:00 IST.
 */
function getRegime(settings = {}) {
  const cfg = settings?.sessionRegimeAdapter || {};
  if (cfg.enabled === false) {
    return {
      enabled: false, regime: 'unconditioned',
      allowEntries: true, minScoreOverride: null,
      targetMinOverride: null, targetMaxOverride: null,
      sizingFactorMul: 1.0, reasoning: 'session regime adapter disabled',
    };
  }
  const table = Array.isArray(cfg.regimeTable) ? cfg.regimeTable : DEFAULT_REGIME_TABLE;
  const m = _istMinutesNow();

  // Hard cutoff: 15:00 IST stops new entries. Existing positions exit via
  // their own monitor logic (square-off honoured by exchange close at 15:30).
  if (m >= ENTRY_CUTOFF_MIN) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return {
      enabled: true, regime: 'after_entry_cutoff',
      allowEntries: false, minScoreOverride: null,
      targetMinOverride: null, targetMaxOverride: null,
      sizingFactorMul: 0,
      reasoning: `entry cutoff 15:00 IST reached @ ${hh}:${mm}`,
    };
  }

  const hit = table.find(r => m >= r.startMin && m < r.endMin);
  if (!hit) {
    // Outside the regime table windows but still inside the trading day
    // (e.g. between 09:00 and 09:15 when the recorder is warming up). Allow
    // entries — the support engine's data-readiness gates ("insufficient
    // 3m candles") will hold trades back until candles exist.
    return {
      enabled: true, regime: 'pre_session_warmup',
      allowEntries: true, minScoreOverride: null,
      targetMinOverride: null, targetMaxOverride: null,
      sizingFactorMul: 1.0, reasoning: 'outside regime table — defer to data-readiness',
    };
  }
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return {
    enabled: true,
    regime: hit.name,
    // Honour explicit allowEntries=false in custom tables (lets users opt
    // back into hard-blocking via their own regimeTable).
    allowEntries: hit.allowEntries !== false,
    minScoreOverride: hit.minScoreOverride ?? null,
    targetMinOverride: hit.targetMinOverride ?? null,
    targetMaxOverride: hit.targetMaxOverride ?? null,
    sizingFactorMul: Number.isFinite(hit.sizingFactorMul) ? hit.sizingFactorMul : 1.0,
    reasoning: `${hit.name} @ ${hh}:${mm} IST`,
  };
}

module.exports = { getRegime, _DEFAULT_REGIME_TABLE: DEFAULT_REGIME_TABLE, ENTRY_CUTOFF_MIN };
