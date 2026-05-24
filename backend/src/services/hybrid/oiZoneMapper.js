/**
 * OI Zone Mapper
 * ==============
 * Computes intraday support / resistance levels from option-chain OI:
 *
 *   • Support levels      — strikes with maximum PE OI BELOW spot
 *                           (put writers defend → price tends to bounce)
 *   • Resistance levels   — strikes with maximum CE OI ABOVE spot
 *                           (call writers defend → price tends to fade)
 *
 * Used by the Premium Swing engine for cascading reversals: when the
 * primary-strike trade SLs, we don't blindly re-fire — we look at the
 * NEAREST OI-defended zone in the prevailing direction and re-arm
 * there. That's what "if it goes opposite, take next support strike"
 * means in OI terms.
 *
 * Public:
 *   • computeZones({ primaryStrikes, spot, count })
 *
 * Returns:
 *   {
 *     supports:    [{ strike, peOi, peOiChg, distance, ... }, ...],  // descending by distance
 *     resistances: [{ strike, ceOi, ceOiChg, distance, ... }, ...],  // ascending by distance
 *   }
 *
 * `count` is how many of each side to return (default 3). Strikes are
 * filtered: minimum OI of 25,000 contracts (otherwise the level is too
 * thinly-defended to mean-revert price).
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

const MIN_DEFENDED_OI = 25_000;

function computeZones({ primaryStrikes = [], spot = null, count = 3 } = {}) {
  if (!Array.isArray(primaryStrikes) || primaryStrikes.length === 0 || !spot) {
    return { supports: [], resistances: [] };
  }

  const rows = primaryStrikes
    .filter(s => s && Number.isFinite(s.strike))
    .map(s => {
      const ceOi    = _safe(s.ce?.oi    ?? s.call?.oi);
      const peOi    = _safe(s.pe?.oi    ?? s.put?.oi);
      const ceOiChg = _safe(s.ce?.oiChg ?? s.call?.oiChange);
      const peOiChg = _safe(s.pe?.oiChg ?? s.put?.oiChange);
      const ceLtp   = _safe(s.ce?.ltp   ?? s.call?.ltp);
      const peLtp   = _safe(s.pe?.ltp   ?? s.put?.ltp);
      return {
        strike: Number(s.strike),
        ceOi, peOi, ceOiChg, peOiChg,
        ceLtp, peLtp,
        distance: s.strike - spot,
      };
    });

  // Supports: PE OI walls BELOW spot
  const supports = rows
    .filter(r => r.strike < spot)
    .filter(r => r.peOi >= MIN_DEFENDED_OI)
    .sort((a, b) => b.peOi - a.peOi)        // strongest defence first
    .slice(0, count * 2)                     // take top 2× then re-sort by distance
    .sort((a, b) => b.strike - a.strike)     // nearest support first (largest strike < spot)
    .slice(0, count);

  // Resistances: CE OI walls ABOVE spot
  const resistances = rows
    .filter(r => r.strike > spot)
    .filter(r => r.ceOi >= MIN_DEFENDED_OI)
    .sort((a, b) => b.ceOi - a.ceOi)
    .slice(0, count * 2)
    .sort((a, b) => a.strike - b.strike)     // nearest resistance first (smallest strike > spot)
    .slice(0, count);

  return { supports, resistances };
}

/**
 * Given the failing direction (e.g. CE trade SLed = market went down),
 * pick the nearest OI zone in the *new* direction the engine should
 * re-arm at.
 *
 * @param {{
 *   failedDirection: 'bullish'|'bearish',  // the direction that just failed
 *   zones: ReturnType<typeof computeZones>,
 *   skip: number[],                        // strikes already used (don't repeat)
 * }} args
 * @returns {{ strike: number, side: 'CE'|'PE', oi: number } | null}
 */
function nextReversalZone({ failedDirection, zones, skip = [] } = {}) {
  const skipSet = new Set(skip.map(Number));
  if (failedDirection === 'bullish') {
    // CE trade failed → market went DOWN, look for PE max-OI support
    // below spot to play a bounce (BUY CE again at support) OR fade
    // continuation (BUY PE on break of support).
    const sup = (zones?.supports || []).find(s => !skipSet.has(s.strike));
    if (sup) return { strike: sup.strike, side: 'PE', oi: sup.peOi, kind: 'support' };
  } else if (failedDirection === 'bearish') {
    // PE trade failed → market went UP, look for CE max-OI resistance
    // above spot.
    const res = (zones?.resistances || []).find(r => !skipSet.has(r.strike));
    if (res) return { strike: res.strike, side: 'CE', oi: res.ceOi, kind: 'resistance' };
  }
  return null;
}

module.exports = { computeZones, nextReversalZone, MIN_DEFENDED_OI };
