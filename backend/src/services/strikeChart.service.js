/* ─────────────────────────────────────────────────────────────────────
 * STRIKE CHART SERVICE
 * ========================================================================
 * Returns intraday 5-min candle series for the day's PRIMARY (ATM) CE and
 * PE legs, plus marker price levels:
 *
 *   • CE chart marker = first-5-min HIGH of the PE leg at offset N strikes
 *   • PE chart marker = first-5-min HIGH of the CE leg at offset N strikes
 *
 * Data sources (priority):
 *   1. Live Dhan intraday API (`/v2/charts/intraday`) for any date.
 *   2. Future fallback: live-feed folder option-chain.jsonl (best-effort
 *      for primary leg). Marker prices already use the strikeTable
 *      service which has its own folder/buffer fallback.
 *
 * Endpoint shape:
 *   GET /api/strike-chart?symbol=NIFTY_50[&date=YYYY-MM-DD][&offset=4][&interval=5]
 * ───────────────────────────────────────────────────────────────────── */

const intelV2 = require('./intelV2.service');
const dhanProd = require('./dhanProd.service');
const strikeTable = require('./strikeTable.service');
const symbolRegistry = require('../config/symbolRegistry');

function _safe(n, d = 0) { const x = Number(n); return Number.isFinite(x) ? x : d; }
function _round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

const VALID_INTERVALS = new Set(['1', '5', '15', '25', '30']);

/**
 * Fetch day-long intraday candles for one option leg.
 */
async function _fetchLegCandles({ authKey, secId, exchange, date, interval }) {
  if (!secId) return [];
  try {
    const I = intelV2.__internals || {};
    const { start, end } = I._sessionUtcRange(date);
    // Same workaround used in the strikeTable service: start ~5min earlier
    // so Dhan can't drop the 09:15 bar.
    const safeStart = start - 5 * 60;
    const res = await dhanProd.getDhanProdData(authKey, {
      securityId: secId,
      exchange,
      segment: 'D',
      instrument: 'OPTIDX',
      startTime: safeStart,
      endTime: end,
      interval,
    });
    if (!res?.ok || !Array.isArray(res.data?.candles)) return [];
    // Filter to in-session candles only (>=09:15 IST).
    return res.data.candles
      .map((c) => ({
        time: _safe(c.time ?? c.timestamp),
        open: _round(_safe(c.open), 2),
        high: _round(_safe(c.high), 2),
        low:  _round(_safe(c.low),  2),
        close: _round(_safe(c.close), 2),
        volume: _safe(c.volume),
      }))
      .filter((c) => c.time >= start && c.time < end);
  } catch (_) {
    return [];
  }
}

/**
 * GET /api/strike-chart
 */
async function getStrikeChart({ symbol = 'NIFTY_50', date = null, offset = 3, interval = '5' } = {}) {
  const SYMBOL = String(symbol).toUpperCase();
  const sym = symbolRegistry.getSymbol(SYMBOL);
  if (!sym) return { ok: false, error: `Unsupported symbol: ${SYMBOL}` };
  const intv = VALID_INTERVALS.has(String(interval)) ? String(interval) : '5';

  // 1. Pull the strike table — gives us ATM, primary CE/PE secIds, and
  //    the first-5-min HIGH for every strike in the visible window.
  //    Request a generous range so the offset strike is always inside it.
  // Strike-table needs to span the round-strike offsets. The farthest round
  // strike from ATM is offN*100 above/below the nearest-round-ATM, which is
  // up to (offN*100 + step/2) absolute distance → (2*offN + 1) step-units
  // for NIFTY (step 50), (offN + 1) for SENSEX (step 100). Pick the larger.
  const stepUnitsNeeded = Math.ceil((Math.abs(Math.round(_safe(offset, 3))) * 100 + (sym.strikeStep || 50)) / (sym.strikeStep || 50));
  const tableRange = Math.max(8, stepUnitsNeeded + 2);
  const table = await strikeTable.getStrikeTable({ symbol: SYMBOL, date, range: tableRange });
  if (!table?.ok) return { ok: false, error: table?.error || 'strike table unavailable' };

  const usedDate = table.date;
  const isToday = !!table.isToday;
  const atm = _safe(table.atm);
  const step = _safe(table.step, sym.strikeStep || 50);

  const offN = Math.max(1, Math.min(20, Math.abs(Math.round(_safe(offset, 3)))));
  // Build the cross-leg marker strikes: walk outward from ATM in multiples
  // of ROUND_STEP (100) and pick offN round strikes on each side.
  // For ATM=23400, offN=3 → below=[23100,23200,23300] above=[23500,23600,23700]
  // → 6 lines per chart, all on round strikes.

  // 2. Pick the primary CE/PE legs from the table → look up their secIds
  //    via the v2 internals.
  //    For TODAY: load chain live from Dhan API.
  //    For HISTORICAL: try the date's folder first; if that's empty (the
  //    common case — option-chain.jsonl is rarely recorded), fall back to
  //    loading the live chain and use those secIds to fetch the chosen
  //    date's intraday candles. Dhan's intraday endpoint accepts any date
  //    in the past 90 days regardless of when you ask, so as long as the
  //    contract still exists this returns the correct historical candles.
  const I = intelV2.__internals || {};
  const authKey = I._activeAuthKey ? I._activeAuthKey() : null;
  let chain = null;
  try {
    if (typeof I._loadOptionChain === 'function') {
      chain = await I._loadOptionChain(authKey, sym, usedDate, isToday);
    }
  } catch (_) { /* best effort */ }
  // Historical fallback: load TODAY's chain to harvest the secIds.
  const hasUsableChain = chain && Array.isArray(chain.strikes) && chain.strikes.length > 0
    && chain.strikes.some((s) => (s?.call?.securityId ?? s?.ce?.securityId) || (s?.put?.securityId ?? s?.pe?.securityId));
  if (!hasUsableChain && !isToday) {
    try {
      if (typeof I._loadOptionChain === 'function') {
        const liveChain = await I._loadOptionChain(authKey, sym, /*date*/ null, /*isToday*/ true);
        if (liveChain && Array.isArray(liveChain.strikes) && liveChain.strikes.length) {
          chain = { ...liveChain, source: `${liveChain.source}:fallback-for-historical` };
        }
      }
    } catch (_) { /* best effort */ }
  }

  const strikeMap = new Map();
  if (chain && Array.isArray(chain.strikes)) {
    for (const s of chain.strikes) strikeMap.set(Number(s.strike), s);
  }
  const primary = strikeMap.get(atm) || null;
  const primaryCeSecId = primary?.call?.securityId || primary?.ce?.securityId || null;
  const primaryPeSecId = primary?.put?.securityId  || primary?.pe?.securityId  || null;

  // 3. Build the marker arrays from the strike-table rows.
  //    Only round strikes (multiples of 100) are kept. We walk N strikes
  //    above and below the ATM (skipping ATM itself when ATM is round).
  //    • CE chart shows PE first-5-min HIGHs of each round offset strike.
  //    • PE chart shows CE first-5-min HIGHs of each round offset strike.
  const findRow = (strike) => (table.rows || []).find((r) => Number(r.strike) === Number(strike));
  const ROUND_STEP = 100;
  const atmRound = Math.round(atm / ROUND_STEP) * ROUND_STEP;
  const roundStrikes = [];
  // Below ATM
  for (let i = 1; i <= offN; i++) {
    const s = atmRound - i * ROUND_STEP;
    if (s > 0) roundStrikes.push(s);
  }
  // Above ATM
  for (let i = 1; i <= offN; i++) {
    roundStrikes.push(atmRound + i * ROUND_STEP);
  }

  const ceMarkers = [];
  const peMarkers = [];
  for (const strike of roundStrikes) {
    const offSteps = Math.round((strike - atm) / step); // signed offset in step units
    const row = findRow(strike);
    const peHigh = _safe(row?.pe?.firstFiveHigh, 0); // PE high → drawn on CE chart
    const ceHigh = _safe(row?.ce?.firstFiveHigh, 0); // CE high → drawn on PE chart
    const sign = offSteps > 0 ? '+' : '';
    if (peHigh > 0) {
      ceMarkers.push({
        sourceStrike: strike,
        sourceSide: 'PE',
        sourceOffset: offSteps,
        price: peHigh,
        label: `PE ${strike} ${sign}${offSteps}`,
      });
    }
    if (ceHigh > 0) {
      peMarkers.push({
        sourceStrike: strike,
        sourceSide: 'CE',
        sourceOffset: offSteps,
        price: ceHigh,
        label: `CE ${strike} ${sign}${offSteps}`,
      });
    }
  }

  // 4. Fetch primary CE / PE candles in parallel.
  const exchange = sym.exchange || (SYMBOL === 'SENSEX' ? 'BSE' : 'NSE');
  const [ceCandles, peCandles] = await Promise.all([
    _fetchLegCandles({ authKey, secId: primaryCeSecId, exchange, date: usedDate, interval: intv }),
    _fetchLegCandles({ authKey, secId: primaryPeSecId, exchange, date: usedDate, interval: intv }),
  ]);

  return {
    ok: true,
    version: 'strike-chart-v1',
    symbol: table.symbol,
    displayName: table.displayName,
    date: usedDate,
    isToday,
    at: Date.now(),
    spot: table.spot,
    atm,
    step,
    offset: offN,
    interval: intv,
    source: isToday ? 'live' : 'folder',
    chainSource: chain?.source || null,
    primary: {
      ce: {
        strike: atm,
        securityId: primaryCeSecId,
        candles: ceCandles,
        firstFiveHigh: _safe(findRow(atm)?.ce?.firstFiveHigh, 0),
        firstFiveLow:  _safe(findRow(atm)?.ce?.firstFiveLow,  0),
        ltp: _safe(findRow(atm)?.ce?.ltp, 0),
      },
      pe: {
        strike: atm,
        securityId: primaryPeSecId,
        candles: peCandles,
        firstFiveHigh: _safe(findRow(atm)?.pe?.firstFiveHigh, 0),
        firstFiveLow:  _safe(findRow(atm)?.pe?.firstFiveLow,  0),
        ltp: _safe(findRow(atm)?.pe?.ltp, 0),
      },
    },
    markers: {
      // Drawn on the CE chart of the primary strike — PE first-5-min HIGHs
      // of the 2N offset strikes (default 6 lines).
      ceChart: ceMarkers,
      // Drawn on the PE chart of the primary strike — CE first-5-min HIGHs
      // of the 2N offset strikes (default 6 lines).
      peChart: peMarkers,
    },
  };
}

module.exports = { getStrikeChart };
