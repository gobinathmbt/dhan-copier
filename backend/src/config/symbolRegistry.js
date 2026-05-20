/**
 * Symbol Registry
 * ===============
 * Central source of truth for all index/futures metadata used by the
 * engine pipeline. When `settings.tradingSymbols` includes a symbol,
 * the engine routes calls to the correct security id, exchange segment,
 * scrip master and lot size.
 *
 * Adding a new symbol → add an entry here; downstream code reads from
 * this map rather than hard-coding security IDs.
 *
 * Hot spots to update when wiring a NEW symbol end-to-end:
 *   1. backend/src/services/feedRecorder.service.js
 *      → currently records NIFTY_50 only. Iterate over `getEnabledSymbols()`
 *        and create per-symbol folders.
 *   2. backend/src/services/liveFeedDataProvider.service.js
 *      → `getCandles` is hard-coded to NIFTY 50 spot. Switch on `symbol`.
 *   3. backend/src/services/dhanLiveFeedProd.service.js subscribe block
 *      → currently only subscribes IDX_I/13 (NIFTY) + IDX_I/25 (BANKNIFTY).
 *        Add ASTI for SENSEX (security id 51, segment IDX_I in BSE).
 *   4. backend/src/services/scalpingEngine.service.js prediction cycle
 *      → currently builds aggregator for NIFTY 50 only. Loop over enabled
 *        symbols and run per-symbol cycles.
 */

// Dhan exchange-segment enums:
//   IDX_I    — NSE indices (NIFTY, BANKNIFTY, FINNIFTY, etc.)
//   BSE_I    — BSE indices (SENSEX, BANKEX)
//   NSE_FNO  — NSE F&O (futures + options)
//   BSE_FNO  — BSE F&O (SENSEX/BANKEX options)

const SYMBOLS = {
  NIFTY_50: {
    key: 'NIFTY_50',
    displayName: 'NIFTY 50',
    exchange: 'NSE',
    indexSegment: 'IDX_I',
    indexSecurityId: 13,
    optionsSegment: 'NSE_FNO',
    futuresSegment: 'NSE_FNO',
    futuresUnderlying: 'NIFTY',
    expiryWeekday: 4,                     // Thursday
    lotSize: 65,                          // current contract spec
    strikeStep: 50,
    optionStrikeWindow: 6,
    feedRecorderEnabled: true,
  },
  SENSEX: {
    key: 'SENSEX',
    displayName: 'SENSEX',
    exchange: 'BSE',
    // SENSEX SPOT is exposed by Dhan under the IDX_I (Index Value) segment,
    // NOT BSE_I — the Annexure only defines IDX_I (0), NSE_EQ (1), NSE_FNO (2),
    // BSE_EQ (4), MCX_COMM (5), BSE_FNO (8). All Indian index spots
    // (NIFTY 50, BANKNIFTY, SENSEX) live on IDX_I.
    indexSegment: 'IDX_I',
    indexSecurityId: 51,                  // Dhan SENSEX index security id
    optionsSegment: 'BSE_FNO',
    futuresSegment: 'BSE_FNO',
    futuresUnderlying: 'SENSEX',
    expiryWeekday: 4,                     // Thursday on BSE
    lotSize: 20,                          // current SENSEX contract spec
    strikeStep: 100,
    optionStrikeWindow: 6,
    feedRecorderEnabled: true,            // recorder is now symbol-aware
  },
  BANKNIFTY: {
    key: 'BANKNIFTY',
    displayName: 'BANK NIFTY',
    exchange: 'NSE',
    indexSegment: 'IDX_I',
    indexSecurityId: 25,
    optionsSegment: 'NSE_FNO',
    futuresSegment: 'NSE_FNO',
    futuresUnderlying: 'BANKNIFTY',
    expiryWeekday: 3,                     // Wednesday for BNF
    lotSize: 35,
    strikeStep: 100,
    optionStrikeWindow: 6,
    feedRecorderEnabled: false,
  },
};

/**
 * Resolve a symbol entry. Returns NIFTY_50 if the requested symbol
 * isn't registered (defensive fallback).
 */
function getSymbol(key) {
  if (!key) return SYMBOLS.NIFTY_50;
  return SYMBOLS[String(key).toUpperCase()] || SYMBOLS.NIFTY_50;
}

/**
 * Get all symbols currently enabled for live trading. Reads from
 * `settings.tradingSymbols`. Defaults to ['NIFTY_50'] when absent.
 */
function getEnabledSymbols(settings) {
  const list = Array.isArray(settings?.tradingSymbols) && settings.tradingSymbols.length
    ? settings.tradingSymbols
    : ['NIFTY_50'];
  return list.map(k => getSymbol(k)).filter(Boolean);
}

/**
 * Quick check whether a symbol is currently enabled.
 */
function isSymbolEnabled(key, settings) {
  return getEnabledSymbols(settings).some(s => s.key === String(key).toUpperCase());
}

// ──────────────────────────────────────────────────────────────────────
// ACTIVE SYMBOL — runtime singleton
// ──────────────────────────────────────────────────────────────────────
// Many services (feedRecorder, candleSynthesizer, historicalContextLoader,
// liveFeedIntegrity, multiDayContextEngine, historicalBackfill) used to
// hardcode `const UNDERLYING = 'NIFTY_50'` at module load. We now expose
// the active symbol as a runtime value driven by the session settings.
//
// scalpingEngine.start() calls `setActiveSymbols(settings)` once when a
// session begins; downstream services read the active symbol via
// `getActiveSymbol()`. Defaults to NIFTY_50 so anything that runs before
// a session is started (server boot prune, controller list, etc.) still
// behaves identically to the previous hardcoded value.
let _activeSymbols = ['NIFTY_50'];
let _activeKey = 'NIFTY_50';

function setActiveSymbols(settings) {
  const list = Array.isArray(settings?.tradingSymbols) && settings.tradingSymbols.length
    ? settings.tradingSymbols.map(s => String(s).toUpperCase()).filter(k => SYMBOLS[k])
    : ['NIFTY_50'];
  _activeSymbols = list.length ? list : ['NIFTY_50'];
  _activeKey = _activeSymbols[0];
  return { active: _activeKey, all: [..._activeSymbols] };
}

function getActiveSymbol() {
  return _activeKey;
}

function getActiveSymbols() {
  return [..._activeSymbols];
}

function resetActiveSymbols() {
  _activeSymbols = ['NIFTY_50'];
  _activeKey = 'NIFTY_50';
}

module.exports = {
  SYMBOLS,
  getSymbol,
  getEnabledSymbols,
  isSymbolEnabled,
  setActiveSymbols,
  getActiveSymbol,
  getActiveSymbols,
  resetActiveSymbols,
};
