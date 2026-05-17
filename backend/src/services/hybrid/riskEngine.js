/**
 * Risk Engine
 * -----------
 * Survival-first checks. Decides:
 *   - is the kill-switch engaged?
 *   - have we hit the daily DD ceiling?
 *   - have we hit the consecutive-loss limit?
 *   - capital protection mode  (Aggressive / Normal / Defensive / Survival)
 *   - per-trade lot count       (combines all sizing factors)
 *
 * Inputs are read from a snapshot the caller assembles, not from the DB.
 * That way the same logic works in unit tests and in the live cycle.
 */

function _capitalMode({ ddPctToday, consecutiveLosses, killSwitch }) {
  if (killSwitch) return 'survival';
  if (ddPctToday >= 2.5 || consecutiveLosses >= 3) return 'survival';
  if (ddPctToday >= 1.5 || consecutiveLosses >= 2) return 'defensive';
  if (ddPctToday >= 0.5 || consecutiveLosses >= 1) return 'normal';
  return 'aggressive';
}

const MODE_FACTOR = {
  aggressive: 1.0,
  normal:     1.0,
  defensive:  0.5,
  survival:   0.25,
};

/**
 * @param {Object} ctx
 * @param {Object} ctx.session            - { initialCapital, currentCapital, settings }
 * @param {number} ctx.consecutiveLosses
 * @param {number} ctx.openTradesCount
 * @param {number} ctx.openTradesInLossPts - sum of points in loss across open trades
 * @param {boolean} [ctx.killSwitch]      - external kill switch
 * @returns {Object}
 */
function evaluate(ctx) {
  const settings = ctx.session?.settings || {};
  const initialCap = Number(ctx.session?.initialCapital) || 0;
  const currentCap = Number(ctx.session?.currentCapital) || 0;
  const realizedPnL = Number(ctx.session?.realizedPnL) || (currentCap - initialCap);

  // Daily DD
  const ddPctToday = initialCap > 0 ? Math.max(0, ((initialCap - currentCap) / initialCap) * 100) : 0;
  const maxDailyLossPct = Number(settings.maxDailyLossPct) || 3;

  const killSwitch = !!ctx.killSwitch || ddPctToday >= maxDailyLossPct;

  // Consecutive losses
  const consecLosses = Number(ctx.consecutiveLosses) || 0;
  const consecLossLimit = Number(settings.consecutiveLossStop) || 3;

  // Concurrent positions
  const maxConcurrent = Number(settings.maxConcurrentTrades) || 2;
  const openCount = Number(ctx.openTradesCount) || 0;
  const concurrencyOK = openCount < maxConcurrent;

  // Trades currently in loss — block additional adds when accumulated loss is bad
  const lossInOpenPts = Number(ctx.openTradesInLossPts) || 0;
  const lossInOpenBlocked = lossInOpenPts <= -8;

  const blocks = [];
  if (killSwitch) blocks.push(`kill_switch (DD ${ddPctToday.toFixed(2)}% / ceiling ${maxDailyLossPct}%)`);
  if (consecLosses >= consecLossLimit) blocks.push(`consecutive_loss ${consecLosses}/${consecLossLimit}`);
  if (!concurrencyOK) blocks.push(`max_concurrent ${openCount}/${maxConcurrent}`);
  if (lossInOpenBlocked) blocks.push(`open_trades_in_loss ${lossInOpenPts.toFixed(1)}pts`);

  // Capital protection mode
  const mode = _capitalMode({ ddPctToday, consecutiveLosses: consecLosses, killSwitch });
  const modeFactor = MODE_FACTOR[mode];

  return {
    allowEntries: blocks.length === 0,
    blocks,
    killSwitch,
    ddPctToday: Number(ddPctToday.toFixed(2)),
    realizedPnL: Number(realizedPnL.toFixed(2)),
    maxDailyLossPct,
    consecutiveLosses: consecLosses,
    consecutiveLossLimit: consecLossLimit,
    openTradesCount: openCount,
    maxConcurrentTrades: maxConcurrent,
    capitalMode: mode,
    capitalModeFactor: modeFactor,
    reasoning: blocks.length ? `risk blocked: ${blocks.join('; ')}` : `risk OK (mode ${mode}, DD ${ddPctToday.toFixed(2)}%)`,
  };
}

/**
 * Combine all sizing factors → final lot count.
 *
 * Layered multipliers (multiplicative, clamped to [minLots, maxLots]):
 *   base lots × session.aggressionFactor × volatility.sizingFactor
 *           × marketRegime.sizingFactor × liquidity.sizingFactor
 *           × risk.capitalModeFactor
 */
function computeLots({
  settings,
  session,
  volatility,
  marketRegime,
  liquidity,
  risk,
}) {
  const minLots = Math.max(1, Number(settings?.minLots) || 1);
  const maxLots = Math.max(minLots, Number(settings?.maxLots) || minLots);

  const base = minLots; // start conservative — we never auto-pyramid in entry
  const factors = [
    Number(session?.aggressionFactor)         || 1,
    Number(volatility?.sizingFactor)          || 1,
    Number(marketRegime?.sizingFactor)        || 1,
    Number(liquidity?.sizingFactor)           || 1,
    Number(risk?.capitalModeFactor)           || 1,
  ];
  const product = factors.reduce((a, b) => a * b, 1);
  const lots = Math.max(minLots, Math.min(maxLots, Math.round(base * Math.max(product, 0))));

  return { lots, base, factors, product: Number(product.toFixed(3)) };
}

module.exports = { evaluate, computeLots };
