/**
 * Session Regime Adapter
 * ======================
 * Returns time-of-day-conditioned overrides for the support scalp engine
 * thresholds. Different IST session windows behave differently:
 *
 *   09:15-09:45  Opening volatility expansion — fade is risky, follow trend
 *   09:45-11:30  Trend continuation phase — best window for 15pt scalps
 *   11:30-13:30  Midday chop / dead zone — disable entries by default
 *   13:30-14:30  Afternoon reversal phase — short-coverings + retests
 *   14:30-15:30  Close chaos — disable entries by default
 *
 * The adapter is opt-in via `settings.sessionRegimeAdapter.enabled`. It only
 * adjusts:
 *   • allowEntries     — hard gate on whether to even score
 *   • minScoreOverride — raises/lowers the score threshold
 *   • targetMinOverride / targetMaxOverride
 *   • sizingFactorMul  — multiplier on default sizingFactor
 *
 * Default regime table is conservative (chop hours OFF). Anything left
 * undefined falls through to algoSettings defaults.
 */

const DEFAULT_REGIME_TABLE = [
  // mins-since-IST-midnight start, end, regime
  { startMin: 9*60+15, endMin: 9*60+45,  name: 'opening_volatility',
    minScoreOverride: 60, targetMinOverride: 18, sizingFactorMul: 0.7 },
  { startMin: 9*60+45, endMin: 11*60+30, name: 'trend_continuation',
    minScoreOverride: null, targetMinOverride: null, sizingFactorMul: 1.0 },
  { startMin: 11*60+30, endMin: 13*60+30, name: 'midday_chop',
    allowEntries: false, sizingFactorMul: 0 },
  { startMin: 13*60+30, endMin: 14*60+30, name: 'afternoon_reversal',
    minScoreOverride: 60, targetMinOverride: 15, sizingFactorMul: 0.7 },
  { startMin: 14*60+30, endMin: 15*60+30, name: 'close_chaos',
    allowEntries: false, sizingFactorMul: 0 },
];

function _istMinutesNow() {
  const ms = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Returns the regime override block for the current time, or a no-op
 * passthrough when disabled / no matching window.
 *
 * @param {object} settings — full settings object (looks up `sessionRegimeAdapter`)
 * @returns {{
 *   enabled: boolean,
 *   regime:  string,
 *   allowEntries: boolean,
 *   minScoreOverride: number|null,
 *   targetMinOverride: number|null,
 *   targetMaxOverride: number|null,
 *   sizingFactorMul: number,
 *   reasoning: string
 * }}
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
  const hit = table.find(r => m >= r.startMin && m < r.endMin);
  if (!hit) {
    return {
      enabled: true, regime: 'outside_session',
      allowEntries: false, minScoreOverride: null,
      targetMinOverride: null, targetMaxOverride: null,
      sizingFactorMul: 0, reasoning: 'outside trading session',
    };
  }
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return {
    enabled: true,
    regime: hit.name,
    allowEntries: hit.allowEntries !== false,
    minScoreOverride: hit.minScoreOverride ?? null,
    targetMinOverride: hit.targetMinOverride ?? null,
    targetMaxOverride: hit.targetMaxOverride ?? null,
    sizingFactorMul: Number.isFinite(hit.sizingFactorMul) ? hit.sizingFactorMul : 1.0,
    reasoning: `${hit.name} @ ${hh}:${mm} IST`,
  };
}

module.exports = { getRegime, _DEFAULT_REGIME_TABLE: DEFAULT_REGIME_TABLE };
