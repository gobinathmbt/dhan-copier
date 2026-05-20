/**
 * Scalping Engine — orchestrates 1-min prediction loop + 30-sec monitor loop.
 * Single-session at a time (one engine per process).
 */
const ScalpingSession = require('../models/ScalpingSession');
const ScalpingTrade = require('../models/ScalpingTrade');
const aggregator = require('./scalpingDataAggregator.service');
const { isMarketOpen } = require('./marketHours.service');
// CALIBRATED 2026-05-19: live-feed integrity guardian — runs every 60s
// while the session is live, dedupes candle JSONLs and synthesises any
// missing 5m/15m/30m candles from 1m. Prevents the duplicate-candle and
// missing-bar issues observed in earlier live sessions.
const liveFeedIntegrity = require('./liveFeedIntegrity.service');
const logger = require('../utils/logger');
const engineLogger = require('./engineLogger.service');
const jsonEventLogger = require('../utils/jsonEventLogger');
const professionalTrader = require('./professionalTrader.service');
const scalpingSocket = require('../utils/scalpingSocket');

// ============================================================
// HYBRID ENGINE — sole decision-maker
// ============================================================
// The hybrid entry/monitor engines (services/hybrid/*) make every trading
// decision. The scalping engine here only:
//   1. Builds the aggregator payload (spot + option chain + candles)
//   2. Runs the 8 algorithms the hybrid engine consumes
//   3. Calls entryEngine.decide() → hybrid.entry.decide() (no AI fallback)
//   4. Calls monitorEngine.decide() → hybrid.monitor.decide() (no AI fallback)
//   5. Persists trades, emits sockets, manages session state
//
// Legacy AI/master-algorithm imports remain for backwards-compat with code
// paths that haven't been pruned yet, but the hybrid engine is the sole
// authority on entry/exit decisions. The legacy paths are unreachable at
// runtime (entryEngine/monitorEngine throw if hybrid throws — no fallback).
const masterAlgorithm = require('./masterAlgorithm.service');
const aiAnalysis = require('./aiAnalysis.service');
const gammaExposure = require('./algorithms/gammaExposure.service');
const orderFlow = require('./algorithms/orderFlow.service');
const multiTimeframe = require('./algorithms/multiTimeframe.service');
const liquidityAnalysis = require('./algorithms/liquidityAnalysis.service');
const smartMoneyConcepts = require('./algorithms/smartMoneyConcepts.service');
const marketInternals = require('./algorithms/marketInternals.service');
const globalMarkets = require('./algorithms/globalMarkets.service');
const professionalScalping = require('./algorithms/professionalScalping.service');

// ─── Daily-cap helpers (institutional spec, 2026-05-18) ───────────────────
// Backtest evidence shows 3-9 trades/day = +60% WR & +₹158k net,
// while 15+ trades/day = 43% WR & -₹41k net. Cap entries at 8/day and
// halt after 3 losses today.
function _istDayBoundsUtc(now = new Date()) {
  // IST = UTC+5:30. Day starts 00:00 IST = 18:30 UTC previous day.
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  // Convert IST midnight back to UTC for the query
  const startUtc = new Date(Date.UTC(y, m, d) - 5.5 * 3600 * 1000);
  const endUtc   = new Date(startUtc.getTime() + 24 * 3600 * 1000);
  return { startUtc, endUtc };
}
async function _countTodayTrades(sessionId, market = null) {
  if (!sessionId) return 0;
  try {
    const { startUtc, endUtc } = _istDayBoundsUtc();
    const q = {
      sessionId,
      createdAt: { $gte: startUtc, $lt: endUtc },
    };
    if (market) q.market = market;
    return await ScalpingTrade.countDocuments(q);
  } catch (_) { return 0; }
}
async function _countTodayLosses(sessionId, market = null) {
  if (!sessionId) return 0;
  try {
    const { startUtc, endUtc } = _istDayBoundsUtc();
    const q = {
      sessionId,
      status: 'closed',
      result: 'LOSS',
      closedAt: { $gte: startUtc, $lt: endUtc },
    };
    if (market) q.market = market;
    return await ScalpingTrade.countDocuments(q);
  } catch (_) { return 0; }
}
const sectorRotation = require('./algorithms/sectorRotation.service');
const behavioralAnalysis = require('./algorithms/behavioralAnalysis.service');
const demaIndicator = require('./algorithms/demaIndicator.service'); // NEW - DEMA
const rsiIndicator = require('../algorithms/rsi.indicator'); // PHASE 2 - RSI
const macdIndicator = require('../algorithms/macd.indicator'); // PHASE 2 - MACD
const stochasticIndicator = require('../algorithms/stochastic.indicator'); // PHASE 2 - Stochastic
const bollingerBandsIndicator = require('../algorithms/bollingerBands.indicator'); // PHASE 2 - Bollinger Bands
const volumeProfileIndicator = require('../algorithms/volumeProfile.indicator'); // PHASE 3 - Volume Profile
const orderBookImbalanceIndicator = require('../algorithms/orderBookImbalance.indicator'); // PHASE 3 - Order Book
const tickVolumeIndicator = require('../algorithms/tickVolume.indicator'); // PHASE 3 - Tick Volume
const dhanProd = require('./dhanProd.service'); // PRODUCTION Dhan API (replaces dhanBypass)
const institutionalAI = require('./institutionalAI.service'); // INSTITUTIONAL AI - ENRICHED PAYLOADS
const entryEngine = require('./entryEngine.service');         // NEW centralised entry decision
const monitorEngine = require('./monitorEngine.service');     // NEW centralised monitor decision

// Feature flag — when true, the new engines handle entry/monitor.
// Can be overridden per-session via settings.useNewEngines. Default false for safety.
const DEFAULT_USE_NEW_ENGINES = process.env.USE_NEW_ENGINES === '1';

// ─── Active-symbol option-segment helpers ──────────────────────────────
// Resolve the F&O segment ('NSE_FNO' or 'BSE_FNO') for a trade. We store
// `trade.market` at entry; for in-flight legacy trades without a market
// field we fall back to the registry's active symbol.
const _symbolRegistryForEngine = require('../config/symbolRegistry');
function _optionSegmentForTrade(trade) {
  let key = trade?.market;
  if (!key) key = _symbolRegistryForEngine.getActiveSymbol();
  const sym = _symbolRegistryForEngine.getSymbol(key);
  return sym?.optionsSegment || 'NSE_FNO';
}
function _optionSegmentForActive() {
  const sym = _symbolRegistryForEngine.getSymbol(_symbolRegistryForEngine.getActiveSymbol());
  return sym?.optionsSegment || 'NSE_FNO';
}

// ============================================================
// AGGRESSIVE SCALPING ENHANCEMENTS
// ============================================================
const brokerageCalculator = require('../utils/brokerageCalculator');
const niftyFutures = require('./niftyFutures.service');

// ============================================================
// NEWS & SENTIMENT ANALYSIS
// ============================================================
const sentimentAnalyzer = require('./sentimentAnalyzer.service');

const state = {
  session: null,
  authKey: null,
  predictionTimer: null,
  monitorTimer: null,
  priceUpdateTimer: null, // NEW: Dedicated real-time price updater
  // ── Active per-symbol slot (alias) ───────────────────────────────────
  // These mirror the active symbol's slot in `state.bySymbol`. Existing
  // code reads/writes `state.cooldownUntil`, `state.busy`, etc. without
  // knowing about per-symbol slots. _useSymbolSlot(symbolKey) repoints
  // every alias to that symbol's bag for the duration of one cycle.
  cooldownUntil: 0,
  busy: false,
  previousLiquidityData: null,
  previousSMCAnalysis: null,
  previousMarketInternalsData: null,
  previousSectorRotationData: null,
  previousGlobalData: null,
  previousBehavioralData: null,
  previousDEMAData: null,
  // Direction lock — prevents flip-flopping every 60s
  lastDirection: null,
  lastDirectionAt: 0,
  directionLockMs: 120_000,
  // Circuit breaker for futures API 401
  futuresAuthFailed: false,
  // Last prediction cycle outputs (for monitor to use)
  lastAlgorithmOutputs: null,
  lastMasterDecision: null,
  lastFuturesData: null,
  // ── Per-symbol state bag — populated by _ensureSymbolSlots() ─────────
  // Each entry is the same shape as the alias fields above. Used to
  // run NIFTY_50 and SENSEX entry/monitor cycles in parallel without
  // them stepping on each other's cooldowns / direction locks / caches.
  bySymbol: {},
  activeSymbolKey: 'NIFTY_50',
};

// ─── Per-symbol state helpers ────────────────────────────────────────────
// Each enabled trading symbol gets its own slot in `state.bySymbol`. The
// engine code reads/writes `state.cooldownUntil`, `state.busy`, etc. via
// the alias fields above. `_useSymbolSlot(key)` flushes any pending writes
// from the previous symbol back into its slot, then loads the new symbol's
// slot into the alias fields. This lets us run the same cycle code for
// each symbol sequentially without needing to thread a symbol parameter
// through hundreds of lines of pipeline code.
const _SYMBOL_SLOT_FIELDS = [
  'cooldownUntil', 'busy',
  'previousLiquidityData', 'previousSMCAnalysis',
  'previousMarketInternalsData', 'previousSectorRotationData',
  'previousGlobalData', 'previousBehavioralData', 'previousDEMAData',
  'lastDirection', 'lastDirectionAt',
  'futuresAuthFailed',
  'lastAlgorithmOutputs', 'lastMasterDecision', 'lastFuturesData',
];

function _newSymbolSlot() {
  return {
    cooldownUntil: 0,
    busy: false,
    previousLiquidityData: null,
    previousSMCAnalysis: null,
    previousMarketInternalsData: null,
    previousSectorRotationData: null,
    previousGlobalData: null,
    previousBehavioralData: null,
    previousDEMAData: null,
    lastDirection: null,
    lastDirectionAt: 0,
    futuresAuthFailed: false,
    lastAlgorithmOutputs: null,
    lastMasterDecision: null,
    lastFuturesData: null,
  };
}

function _ensureSymbolSlots(keys) {
  for (const k of keys) {
    if (!state.bySymbol[k]) state.bySymbol[k] = _newSymbolSlot();
  }
}

function _flushAliasToSlot() {
  const cur = state.bySymbol[state.activeSymbolKey];
  if (!cur) return;
  for (const f of _SYMBOL_SLOT_FIELDS) cur[f] = state[f];
}

function _loadSlotToAlias(key) {
  const slot = state.bySymbol[key];
  if (!slot) return;
  state.activeSymbolKey = key;
  for (const f of _SYMBOL_SLOT_FIELDS) state[f] = slot[f];
}

/**
 * Activate a symbol slot for the duration of one cycle. Saves whatever
 * is currently in the alias fields back to the previous symbol's slot,
 * then loads the new symbol's slot. Also flips symbolRegistry so all
 * downstream services key folders/feeds on the same symbol.
 */
function _useSymbolSlot(key) {
  if (state.activeSymbolKey === key) {
    // Already active — but make sure registry is in sync
    try { require('../config/symbolRegistry').setActiveSymbols({ tradingSymbols: [key] }); } catch (_) {}
    return;
  }
  _flushAliasToSlot();
  _loadSlotToAlias(key);
  try { require('../config/symbolRegistry').setActiveSymbols({ tradingSymbols: [key] }); } catch (_) {}
}

// ============================================================
// OPTIMIZATION: Sentiment Cache (saves 2-4 seconds per cycle)
// ============================================================
const sentimentCache = {
  data: null,
  timestamp: 0,
  ttl: 5 * 60 * 1000 // 5 minutes (news doesn't change that fast)
};

function isRunning() {
  return !!state.session && state.session.status === 'running';
}

async function start({ authKey, settings, aiModel }) {
  if (isRunning()) throw new Error('A scalping session is already running');
  if (!authKey) throw new Error('Dhan Bypass auth key is required');

  const market = isMarketOpen();
  if (!market.open) {
    const err = new Error(`Market is not live: ${market.reason}`);
    err.status = 400;
    throw err;
  }

  // ── Wire trading symbols ──────────────────────────────────────────
  // settings.tradingSymbols is the source of truth for which underlying(s)
  // the engine pipeline runs against. Set BEFORE any service is touched
  // so feedRecorder, candleSynthesizer, historicalContextLoader,
  // liveFeedIntegrity, multiDayContextEngine all key their folders on
  // the right symbol.
  let activeSymbolMeta = null;
  let enabledSymbols = ['NIFTY_50'];
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    const active = symbolRegistry.setActiveSymbols(settings);
    enabledSymbols = active.all && active.all.length ? active.all : ['NIFTY_50'];
    activeSymbolMeta = symbolRegistry.getSymbol(active.active);
    // Seed per-symbol state slots so each enabled symbol has its own
    // cooldown / direction lock / algorithm cache.
    _ensureSymbolSlots(enabledSymbols);
    state.activeSymbolKey = active.active;
    logger.info({
      active: active.active,
      all: enabledSymbols,
      lotSize: activeSymbolMeta.lotSize,
      strikeStep: activeSymbolMeta.strikeStep,
      indexSegment: activeSymbolMeta.indexSegment,
      indexSecurityId: activeSymbolMeta.indexSecurityId,
    }, '[engine] active trading symbols');
    // Auto-fill lotSize from the symbol metadata if user didn't supply one.
    // NIFTY=65, SENSEX=20, BANKNIFTY=35 etc. NOTE: when running multiple
    // symbols, lotSize on the session is symbolic only — each trade is
    // sized using the symbol-specific lot size from symbolRegistry at
    // entry time (see entry path below). The session-level value is kept
    // for legacy code that reads `settings.lotSize` directly.
    if (!Number.isFinite(Number(settings.lotSize)) || Number(settings.lotSize) <= 0) {
      settings.lotSize = activeSymbolMeta.lotSize;
      logger.info({ lotSize: settings.lotSize }, '[engine] lotSize auto-filled from symbol metadata');
    }
  } catch (e) {
    logger.warn({ err: e.message }, '[engine] failed to set active symbols (using NIFTY_50 default)');
  }

  // ── Refresh live-feed subscription for ALL enabled symbols ────────
  // The boot block subscribed NIFTY+BANKNIFTY+SENSEX index spots in QUOTE
  // mode. We re-subscribe defensively for the active set so any reconnect
  // loop that lost subscriptions gets the right indices back.
  // Also resets the futures cache so SENSEX runs reparse the scrip
  // master for BSE FUTIDX rows on the next ensureResolved() call.
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');
    const { instance: feedRecorder } = require('./feedRecorder.service');
    const subs = enabledSymbols
      .map(k => symbolRegistry.getSymbol(k))
      .filter(Boolean)
      .map(s => ({ exchangeSegment: s.indexSegment, securityId: s.indexSecurityId }));
    if (subs.length) liveFeedProd.subscribe(subs, 'QUOTE');
    // Pre-create each enabled symbol's per-day folder + streams. Without
    // this, the SENSEX folder only appears once the first SENSEX tick
    // arrives — which delays visibility on disk.
    for (const k of enabledSymbols) {
      try { feedRecorder._ensureSymbolState(k); } catch (_) {}
    }
    const niftyFuturesProd = require('./niftyFuturesProd.service');
    niftyFuturesProd.resetCache();
    // Best-effort futures subscribe for the FIRST enabled symbol. NIFTY
    // futures live wiring is full; SENSEX futures gracefully no-ops until
    // BSE FUTIDX scrip-master coverage is added.
    try { await niftyFuturesProd.subscribeLiveFeed('FULL'); } catch (_) {}
  } catch (e) {
    logger.warn({ err: e.message }, '[engine] live-feed re-subscribe failed (non-fatal)');
  }

  // ── Pre-load historical context for ALL enabled symbols ──────────
  // Triggers an async backfill (NIFTY uses the institutional path,
  // SENSEX uses the lightweight spot-only path). Doesn't block start —
  // any data fetched lands in live-feed/ before the first prediction
  // cycle finishes (60s) so the engines see real candle history.
  try {
    if (enabledSymbols.includes('SENSEX')) {
      const { backfillSensexRange } = require('./sensexBackfill.service');
      // Fire-and-forget — the integrity guardian will also keep up later
      backfillSensexRange({ days: 5, overwrite: false })
        .then(r => logger.info({ days: r.days?.length }, '[engine] SENSEX backfill complete'))
        .catch(err => logger.warn({ err: err.message }, '[engine] SENSEX backfill failed'));
    }
  } catch (e) {
    logger.warn({ err: e.message }, '[engine] backfill bootstrap failed');
  }

  // Initialize professional trader session (market opening strike as anchor)
  try {
    await professionalTrader.initializeMarketSession(authKey);
    logger.info('[engine] Professional trader session initialized');
  } catch (e) {
    logger.warn({ err: e.message }, '[engine] Failed to initialize professional session, will retry');
  }

  const session = await ScalpingSession.create({
    status: 'running',
    aiModel: aiModel || 'gpt-4o-mini',
    settings,
    initialCapital: settings.capital,
    currentCapital: settings.capital,
  });

  state.session = session;
  state.authKey = authKey;
  state.cooldownUntil = 0;

  // Set session ID for JSON logger
  jsonEventLogger.setSessionId(session._id.toString());

  // CALIBRATED 2026-05-19: start the live-feed integrity guardian — runs
  // an immediate sweep (dedupe + synth missing higher-TF candles) and
  // then every 60s while the session is live. Solves the duplicate-candle
  // and missing-5m/15m issues observed in earlier live sessions.
  try {
    liveFeedIntegrity.start({ intervalMs: 60_000 });
  } catch (e) {
    logger.warn({ err: e.message }, '[engine] liveFeedIntegrity start failed');
  }

  logger.info({ sessionId: session._id }, '[engine] started');
  
  // Log engine start event
  await engineLogger.logEvent({
    sessionId: session._id,
    eventType: 'engine_started',
    level: 'info',
    message: `Engine started with capital ₹${settings.capital} (Professional Mode)`,
    data: { settings, aiModel, mode: 'professional_trader' },
  });
  
  // Emit WebSocket event for real-time updates
  scalpingSocket.emitEngineStarted(session);

  // Professional mode: slower, more deliberate cycles
  const predictionInterval = 60_000; // 60 seconds - quality over quantity
  const monitorInterval = 10_000; // 10 seconds - faster monitoring for quick exits

  logger.info({ 
    predictionInterval: predictionInterval / 1000, 
    monitorInterval: monitorInterval / 1000,
    priceUpdateInterval: 3,
    mode: 'professional_trader'
  }, '[engine] cycle timings configured');

  // Kick first cycle immediately, then at intervals
  runPredictionCycle().catch((e) => logger.error({ err: e.message }, 'cycle error'));
  state.predictionTimer = setInterval(() => {
    runPredictionCycle().catch((e) => logger.error({ err: e.message }, 'cycle error'));
  }, predictionInterval);

  // Monitor open positions
  state.monitorTimer = setInterval(() => {
    runMonitorCycle().catch((e) => logger.error({ err: e.message }, 'monitor error'));
  }, monitorInterval);

  // Real-time price updater — runs every 3 seconds to keep UI fresh
  // This is separate from monitor cycle (which makes exit decisions)
  // and only updates prices + emits WebSocket events
  state.priceUpdateTimer = setInterval(() => {
    runPriceUpdateCycle().catch((e) => logger.error({ err: e.message }, 'price update error'));
  }, 3000); // 3 seconds — fast enough for real-time feel, light enough to not overload

  return session;
}

async function stop({ reason = 'Stopped by user' } = {}) {
  if (state.predictionTimer) clearInterval(state.predictionTimer);
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  if (state.priceUpdateTimer) clearInterval(state.priceUpdateTimer);
  state.predictionTimer = null;
  state.monitorTimer = null;
  state.priceUpdateTimer = null;

  // CALIBRATED 2026-05-19: stop the live-feed integrity guardian when
  // the session ends.
  try { liveFeedIntegrity.stop(); } catch (_) {}

  if (state.session) {
    // Close any open trades at last known price
    const open = await ScalpingTrade.find({ sessionId: state.session._id, status: 'open' });
    for (const t of open) {
      await closeTrade(t, t.currentPrice || t.entryPrice, `Session ended: ${reason}`);
    }
    state.session.status = 'stopped';
    state.session.endedAt = new Date();
    state.session.notes = reason;
    await state.session.save();
    logger.info({ sessionId: state.session._id, reason }, '[engine] stopped');
    
    // Emit WebSocket event
    scalpingSocket.emitEngineStopped(state.session, reason);
    
    // Log engine stop event
    await engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'engine_stopped',
      level: 'info',
      message: `Engine stopped: ${reason}`,
      data: {
        totalTrades: state.session.totalTrades,
        realizedPnL: state.session.realizedPnL,
        wins: state.session.wins,
        losses: state.session.losses,
      },
    });
  }

  state.session = null;
  state.authKey = null;
}

async function getStatus() {
  if (!state.session) {
    const last = await ScalpingSession.findOne().sort({ createdAt: -1 });
    return { running: false, session: last };
  }
  const fresh = await ScalpingSession.findById(state.session._id);
  const openTrades = await ScalpingTrade.countDocuments({
    sessionId: state.session._id,
    status: 'open',
  });
  return { running: true, session: fresh, openTrades };
}

async function runPredictionCycle() {
  if (!state.session) return;
  // Iterate every enabled symbol. Each symbol has its own busy/cooldown/
  // direction-lock slot, so NIFTY's prediction can't block SENSEX's.
  let symbols = [];
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    symbols = symbolRegistry.getEnabledSymbols(state.session.settings).map(s => s.key);
  } catch (_) { symbols = ['NIFTY_50']; }
  if (!symbols.length) symbols = ['NIFTY_50'];
  _ensureSymbolSlots(symbols);

  for (const key of symbols) {
    if (!state.session) return;
    _useSymbolSlot(key);
    try {
      await _runPredictionCycleForActiveSymbol();
    } catch (e) {
      logger.error({ err: e.message, symbol: key }, '[engine] prediction cycle error for symbol');
      // Make sure busy is cleared so this symbol isn't permanently locked
      state.busy = false;
    }
  }
  // Persist the last symbol's slot back so it doesn't get overwritten
  _flushAliasToSlot();
}

async function _runPredictionCycleForActiveSymbol() {
  if (!state.session || state.busy) return;
  state.busy = true;
  try {
    const market = isMarketOpen();
    if (!market.open) {
      await stop({ reason: `Market closed: ${market.reason}` });
      return; // session is now null — don't continue
    }
    // Re-check session after potential stop() call
    if (!state.session){;
      return;
    }

    state.session.cycleCount += 1;
    state.session.lastCycleAt = new Date();
    await state.session.save();

    const settings = { ...state.session.settings };
    // CRITICAL: shallow-copy settings so that lot-size reductions by advisory
    // validators don't permanently mutate the session's stored settings.
    // Without this, lotSize gets halved to 1 and stays there forever.

    // Always professional scalping mode — declared here so it's available
    // throughout the entire cycle (used at multiple points before line 500).
    const ultraScalping = true;

    // ── ENTRY GATES ───────────────────────────────────────────────────────────

    // 1. Max concurrent trades — applied PER SYMBOL so NIFTY trades don't
    //    block SENSEX entries (and vice versa). The session-level limit
    //    is interpreted as a per-market limit when running multiple symbols.
    const openCount = await ScalpingTrade.countDocuments({
      sessionId: state.session._id,
      status: 'open',
      market: state.activeSymbolKey,
    });
    if (openCount >= (settings.maxConcurrentTrades || 1)) return;

    // 2. Cooldown gate
    if (Date.now() < state.cooldownUntil) return;

    // 3. Daily loss circuit breaker
    const lossPct =
      ((state.session.initialCapital - state.session.currentCapital) /
        state.session.initialCapital) *
      100;
    if (lossPct >= settings.maxDailyLossPct) {
      await stop({ reason: `Max daily loss reached (${lossPct.toFixed(2)}%)` });
      return;
    }

    // 4. Open trades in loss gate — don't add new trades when existing ones are losing
    // If any open trade is down more than 3pts, pause new entries until it resolves
    if (openCount > 0) {
      const openTrades = await ScalpingTrade.find({
        sessionId: state.session._id,
        status: 'open',
      }).lean();
      const losingTrades = openTrades.filter(t => {
        const pnlPts = (t.currentPrice || t.entryPrice) - t.entryPrice;
        return pnlPts <= -3;
      });
      if (losingTrades.length > 0) {
        logger.warn({
          losingTrades: losingTrades.length,
          openCount,
        }, '[engine] Open trades in loss (>-3pts) — pausing new entries until resolved');
        return;
      }
    }

    // 5. DUPLICATE STRIKE PREVENTION — Don't open same strike+side if already open
    // This prevents opening both CE and PE at same strike, or multiple of same side
    if (openCount > 0) {
      const openTrades = await ScalpingTrade.find({
        sessionId: state.session._id,
        status: 'open',
      }).lean();
      
      // Check if we already have an open trade at any nearby strike (±50 points)
      const hasNearbyTrade = openTrades.some(t => {
        return Math.abs(t.strike - atmStrike) <= 50;
      });
      
      if (hasNearbyTrade) {
        logger.warn({
          atmStrike,
          openStrikes: openTrades.map(t => ({ strike: t.strike, signal: t.signal })),
        }, '[engine] Already have open trade at nearby strike — preventing duplicate entry');
        return;
      }
    }

    // Get current market data
    const { payload, atmStrike, atmCallLtp, atmPutLtp, atmCallSymbol, atmPutSymbol, expiry } =
      await aggregator.buildPayload(state.authKey);

    // ════════════════════════════════════════════════════════════════════
    // ENGINE ROUTING — _ultraOnly fast path
    // ════════════════════════════════════════════════════════════════════
    // When CORE engine is OFF and only ultra/support are running, the
    // master scalping engine drives entries entirely from raw candles.
    // We bypass the legacy 17-algo + master + AI pipeline and go straight
    // to entryEngine.decide(). On NO_TRADE we return; on fired we set up
    // the legacy locals (masterDecision, tradeDecision, marketSession,
    // etc.) with safe defaults so the trade-creation block downstream
    // works without re-running the legacy gates.
    const _ultraOnly = settings.coreEngine === false &&
      (settings.ultraScalpingEngine !== false || settings.supportScalpEngine === true);

    let __fastPathFired = false;
    let __fastPathDecision = null;
    if (_ultraOnly) {
      try {
        const aggBundle = {
          payload,
          atmStrike: payload?.actual_atm_strike || payload?.options_chain?.atm_strike || atmStrike,
          atmCallLtp, atmPutLtp,
          optionChain: payload?.options_chain || null,
        };
        const decision = await entryEngine.decide({
          aggregator: aggBundle,
          algorithmOutputs: {},
          masterDecision: null,
          settings,
          session: state.session,
          openTradesCount: openCount,
          futuresData: state.lastFuturesData || null,
          market: state.activeSymbolKey,
          tradesToday: await _countTodayTrades(state.session?._id, state.activeSymbolKey),
          lossesToday: await _countTodayLosses(state.session?._id, state.activeSymbolKey),
        });
        if (!decision || decision.signal === 'NO_TRADE') {
          return; // No entry — skip legacy pipeline.
        }
        // Trade fired — execute trade creation in self-contained helper
        // and return. Bypasses the legacy 17-algo pipeline entirely.
        await _executeFastPathTrade({
          decision,
          payload,
          atmCallLtp, atmPutLtp,
          atmCallSymbol, atmPutSymbol,
          expiry,
          settings,
        });
        return;
      } catch (e) {
        logger.warn({ err: e.message, stack: e.stack?.slice(0, 300) }, '[engine] fast-path threw — bailing this cycle');
        return;
      }
    }

    // ============================================================
    // STEP 0.5: MARKET SENTIMENT ANALYSIS (OPTIMIZED WITH CACHING)
    // OPTIMIZATION: Cache sentiment for 5 minutes (saves 2-4 seconds)
    // News doesn't change every 60 seconds
    // ============================================================
    let marketSentiment;
    
    if (Date.now() - sentimentCache.timestamp > sentimentCache.ttl) {
      logger.info('[engine] Fetching fresh market sentiment (cache expired)');
      
      marketSentiment = await sentimentAnalyzer.analyzeCurrentMarketSentiment(
        new Date().toISOString(),
        state.session.aiModel
      );
      
      sentimentCache.data = marketSentiment;
      sentimentCache.timestamp = Date.now();
    } else {
      logger.info('[engine] Using cached market sentiment (saves 2-4s)');
      marketSentiment = sentimentCache.data;
    }
    
    logger.info({
      marketBias: marketSentiment.market_bias,
      sentimentScore: marketSentiment.sentiment_score,
      riskLevel: marketSentiment.risk_level,
      breakingNews: marketSentiment.breaking_news,
      immediateAction: marketSentiment.immediate_action,
      crudeOil: marketSentiment.crude_oil_status,
      rupee: marketSentiment.rupee_status,
      cached: Date.now() - sentimentCache.timestamp < sentimentCache.ttl
    }, '[engine] Market sentiment analysis completed');
    
    await engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'market_sentiment',
      level: marketSentiment.risk_level === 'critical' ? 'warn' : 'info',
      message: `Sentiment: ${marketSentiment.market_bias} (${marketSentiment.sentiment_score}), Risk: ${marketSentiment.risk_level}`,
      data: marketSentiment,
    });
    
    // IMMEDIATE ACTION CHECK - Breaking news or critical risk
    if (marketSentiment.immediate_action === 'PAUSE' || marketSentiment.immediate_action === 'CLOSE_POSITIONS') {
      logger.warn({
        immediateAction: marketSentiment.immediate_action,
        reasoning: marketSentiment.reasoning,
        breakingNews: marketSentiment.breaking_news
      }, '[engine] Market sentiment requires immediate action - pausing trading');
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'sentiment_pause',
        level: 'warn',
        message: `Trading paused due to: ${marketSentiment.reasoning}`,
        data: { action: marketSentiment.immediate_action, sentiment: marketSentiment },
      });
      
      return; // Skip this cycle
    }

    // ============================================================
    // STEP 1: ALGORITHM SUITE (gated by engine routing)
    // ============================================================
    // When CORE engine is OFF and only ultra/support are running, skip
    // the 8 hybrid-input algorithm calls — ultra/support engines read
    // raw candle arrays from the aggregator payload and don't consume
    // these algorithm outputs.
    if (_ultraOnly) {
      logger.info('[engine] Skipping algorithm suite — only ultra/support engines active (core engine OFF)');
    } else {
      logger.info('[engine] Running 8 hybrid-input algorithms (CORE engine path)');
    }
    
    // Get option chain for algorithms (CORE engine path only — ultra/support
    // engines read the chain from the aggregator payload directly).
    let optionChain = null;
    if (!_ultraOnly) {
      try {
        const symbolRegistry = require('../config/symbolRegistry');
        const active = symbolRegistry.getSymbol(state.activeSymbolKey);
        const optionChainRes = await dhanProd.getOptionChainBypass(state.authKey, {
          segment: 0,
          expiry: expiry,
          securityId: active?.indexSecurityId || 13,
          underlyingSeg: active?.indexSegment || 'IDX_I',
        });
        optionChain = optionChainRes.ok ? optionChainRes.data : null;
      } catch (e) {
        logger.warn({ err: e.message }, '[engine] option chain fetch threw');
      }
    } else {
      // Ultra/support path — reuse the chain the aggregator already fetched
      optionChain = payload?.options_chain ? { strikes: payload.options_chain.strikes || [] } : null;
    }

    const spotPrice = payload.spot_data?.ltp || payload.actual_spot_price || 23800;

    // Log option chain status — if null, algorithms will use fallback values
    // but we still proceed (AI will use ATM data from aggregator payload)
    if (!optionChain && !_ultraOnly) {
      logger.warn('[engine] Option chain fetch failed — algorithms will use fallback values, AI will use aggregator ATM data');
    }

    // Fetch 1-minute candles for SMC & Behavioral analysis (CORE engine only)
    const now = Math.floor(Date.now() / 1000);
    const sixtyMinAgo = now - (60 * 60);
    let candles = [];
    if (!_ultraOnly) {
      try {
        const symbolRegistry = require('../config/symbolRegistry');
        const active = symbolRegistry.getSymbol(state.activeSymbolKey);
        const candlesRes = await dhanProd.getDhanBypassData(state.authKey, {
          securityId: active?.indexSecurityId || 13,
          exchange: 'IDX', segment: 'I', instrument: 'IDX',
          startTime: sixtyMinAgo, endTime: now, interval: '1',
        });
        candles = candlesRes.ok ? candlesRes.data.candles : [];
      } catch (e) {
        logger.warn({ err: e.message }, '[engine] 1m candles fetch threw');
      }
    }
    
    // Store previous data for analysis
    const previousLiquidityData = state.previousLiquidityData || null;
    const previousSMCAnalysis = state.previousSMCAnalysis || null;
    const previousMarketInternalsData = state.previousMarketInternalsData || null;
    const previousGlobalData = state.previousGlobalData || null;

    // ============================================================
    // ALGORITHMS — only the 8 the hybrid CORE engine actually consumes.
    // When _ultraOnly (ultra/support only, no CORE), skip all 8 calls
    // since ultra/support engines work purely from raw candle arrays.
    // ============================================================
    let algorithmOutputs;
    if (_ultraOnly) {
      // Empty bag — ultra/support entry path doesn't read these
      algorithmOutputs = {
        gammaExposure: null, orderFlow: null, multiTimeframe: null,
        liquidityAnalysis: null, smartMoneyConcepts: null,
        marketInternals: null, globalMarkets: null, professionalScalping: null,
      };
    } else {
      algorithmOutputs = {
        gammaExposure: optionChain ? gammaExposure.calculateGammaExposure(optionChain, spotPrice) : null,
      orderFlow: optionChain ? orderFlow.analyzeOrderFlow(optionChain, payload.spot_data, null) : null,
      multiTimeframe: await multiTimeframe.analyzeMultiTimeframe(state.authKey, spotPrice),
      liquidityAnalysis: optionChain ? liquidityAnalysis.analyzeLiquidity(
        optionChain, spotPrice, null, previousLiquidityData
      ) : null,
      smartMoneyConcepts: candles.length > 10 ? smartMoneyConcepts.analyzeSmartMoneyConcepts(
        candles, optionChain, spotPrice, previousSMCAnalysis
      ) : null,
      marketInternals: await marketInternals.analyzeMarketInternals(
        state.authKey, spotPrice, previousMarketInternalsData
      ),
      globalMarkets: await globalMarkets.analyzeGlobalMarkets(previousGlobalData),
      // Reads 5m candles from live-feed folder (no API call) — works even
      // when Dhan API is rate-limited.
      professionalScalping: await (async () => {
        try {
          const liveFeedProvider = require('./liveFeedDataProvider.service');
          const now = Math.floor(Date.now() / 1000);
          const res = await liveFeedProvider.getCandles(state.authKey, {
            securityId: 13, exchange: 'IDX', segment: 'I', instrument: 'IDX',
            startTime: now - 60 * 60, endTime: now, interval: '5',
          });
          const candles5m = res.ok ? (res.data.candles || []) : [];
          if (candles5m.length >= 30) {
            return professionalScalping.analyzeScalpingIndicators(
              candles5m, spotPrice, payload.spot_data, '5m'
            );
          }
          return null;
        } catch (e) {
          logger.warn({ err: e.message }, '[engine] professional scalping skipped');
          return null;
        }
      })(),
      };
    } // end if (_ultraOnly) else { ... }

    // Persist previous-cycle state for diff-based algorithms
    state.previousLiquidityData = { optionChain, spotPrice, timestamp: Date.now() };
    state.previousSMCAnalysis = algorithmOutputs.smartMoneyConcepts;
    state.previousMarketInternalsData = algorithmOutputs.marketInternals;
    state.previousGlobalData = algorithmOutputs.globalMarkets;

    // Store for monitor cycle to use
    state.lastAlgorithmOutputs = algorithmOutputs;

    if (!_ultraOnly) {
      logger.info({
        gamma: !!algorithmOutputs.gammaExposure,
        orderFlow: !!algorithmOutputs.orderFlow,
        multiTimeframe: !!algorithmOutputs.multiTimeframe,
        liquidity: algorithmOutputs.liquidityAnalysis?.liquidity_score ?? 'null',
        smc: algorithmOutputs.smartMoneyConcepts?.smc_score ?? 'null',
        marketInternals: algorithmOutputs.marketInternals?.market_internals_score ?? 'null',
        globalMarkets: algorithmOutputs.globalMarkets?.global_score ?? 'null',
        professionalScalping: !!algorithmOutputs.professionalScalping,
      }, '[engine] hybrid-required algorithms completed (8 inputs)');
    }

    // ============================================================
    // OPTIMIZATION 1: PARALLEL AI EXECUTION (Save 10-15 seconds)
    // Run Professional Trader analysis in parallel with algorithms
    // ============================================================
    logger.info('[engine] Running professional trade analysis (OPTIMIZED - parallel with algorithms)');

    let tradeDecision;
    try {
      tradeDecision = await professionalTrader.analyzeTrade(
        state.authKey,
        payload,
        state.session.aiModel
      );
    } catch (proErr) {
      // Pro trader call failed (AI timeout, etc.) — don't abandon the cycle.
      logger.warn({ err: proErr.message }, '[engine] Professional trader call failed; continuing with algorithm-driven direction');
      const openingStrike = professionalTrader.getMarketSession().openingStrike
        || (Math.round((payload.spot_data?.ltp || 23800) / 50) * 50);
      tradeDecision = {
        market_character: 'unknown',
        dominant_direction: 'neutral',
        trade_decision: 'WAIT',
        selected_strike: openingStrike,
        option_type: 'CE',
        confidence: 0,
        risk_reward_ratio: 1.5,
        entry_rationale: 'Fallback (pro trader unavailable)',
        max_hold_time_seconds: 120,
        exit_conditions: [],
      };
    }

    // ── ULTRA-SCALPING: Override pro trader WAIT when market is "quiet" ──────
    // "Quiet" just means low volatility — it still has directional moves.
    // In ultra-scalping we let the master algorithm and institutional AI decide.
    if (ultraScalping && tradeDecision.trade_decision === 'WAIT' &&
        (tradeDecision.market_character === 'quiet' || tradeDecision.market_character === 'ranging' || tradeDecision.market_character === 'unknown')) {
      logger.info({
        marketCharacter: tradeDecision.market_character,
        dominantDirection: tradeDecision.dominant_direction,
      }, '[engine] Ultra-scalping: overriding pro trader WAIT (quiet/ranging) — letting master algo decide direction');
      // Keep trade_decision as WAIT so direction resolution uses master fallback
      // but don't return early — the master algorithm will pick a direction
    }

    // Log professional decision (async - don't wait)
    engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'professional_analysis',
      level: 'info',
      message: `Professional Decision: ${tradeDecision.trade_decision}`,
      data: {
        marketCharacter: tradeDecision.market_character,
        dominantDirection: tradeDecision.dominant_direction,
        selectedStrike: tradeDecision.selected_strike,
        optionType: tradeDecision.option_type,
        confidence: tradeDecision.confidence,
        riskReward: tradeDecision.risk_reward_ratio,
        rationale: tradeDecision.entry_rationale,
      },
    });

    // ============================================================
    // STEP 2.5: DIRECTION RESOLUTION
    // ============================================================
    // Previous behaviour: if the pro trader said WAIT we aborted the whole
    // cycle, so the 17-algorithm stack + AI ensemble never got a say. That
    // is why zero entries were happening in quiet/ranging markets.
    //
    // New behaviour (ultra-scalping friendly):
    //   1. If pro trader picks LONG/SHORT -> use it.
    //   2. Else compute master score for BOTH bullish and bearish and pick
    //      the direction whose master_signal is actionable (BUY/STRONG_BUY
    //      or SELL/STRONG_SELL).
    //   3. If NEITHER direction is actionable, genuinely wait.
    //
    // Settings gate: settings.useMasterSignalWhenNeutral (default true).
    // Set to false to restore the old strict behaviour.
    // ============================================================
    const proDirection = tradeDecision.trade_decision === 'ENTER_LONG' ? 'bullish'
      : tradeDecision.trade_decision === 'ENTER_SHORT' ? 'bearish'
      : 'neutral';
    const useMasterFallback = settings.useMasterSignalWhenNeutral !== false;

    // Ultra-scalping is always ON — declared at top of cycle, not here.
    // const ultraScalping = true; // ← moved to top of runPredictionCycle

    // Master algorithm thresholds — configurable per session.
    // Defaults are scalping-tuned so entries actually happen in normal markets.
    const masterThresholds = {
      minMasterScore: Number(settings.masterMinScore) || (ultraScalping ? 55 : 60),
      minConfidence: Number(settings.masterMinConfidence) || (ultraScalping ? 5 : 6),
      minAgreement: Number(settings.masterMinAgreement) || (ultraScalping ? 7 : 9),
    };

    // Minimum bull/bear spread (in master-score points) to consider a
    // direction decisive when the pro trader is neutral.
    // Ultra-scalping: 5 — need some lean, AI will validate the entry.
    // Conservative: 10 — need clear separation.
    const minDirectionSpread = Number(settings.minDirectionSpread) || (ultraScalping ? 5 : 10);

    let direction = proDirection;
    let masterDecision = null;

    if (proDirection !== 'neutral') {
      masterDecision = masterAlgorithm.calculateMasterScore(payload, algorithmOutputs, proDirection, masterThresholds);
    } else if (useMasterFallback) {
      logger.info({ masterThresholds, ultraScalping }, '[engine] Pro trader neutral — asking master algorithm to pick a direction');
      const bullDecision = masterAlgorithm.calculateMasterScore(payload, algorithmOutputs, 'bullish', masterThresholds);
      const bearDecision = masterAlgorithm.calculateMasterScore(payload, algorithmOutputs, 'bearish', masterThresholds);

      const bullScore = bullDecision?.master_score || 0;
      const bearScore = bearDecision?.master_score || 0;
      // In ultra-scalping we care about entry_recommended (settings-driven).
      // In conservative mode we also require master_signal to be actionable.
      const bullActionable = bullDecision && (bullDecision.entry_recommended ||
        (!ultraScalping && ['BUY', 'STRONG_BUY'].includes(bullDecision.master_signal)));
      const bearActionable = bearDecision && (bearDecision.entry_recommended ||
        (!ultraScalping && ['SELL', 'STRONG_SELL'].includes(bearDecision.master_signal)));

      const spread = Math.abs(bullScore - bearScore);

      logger.info({
        bullScore, bearScore, spread,
        bullSignal: bullDecision?.master_signal,
        bearSignal: bearDecision?.master_signal,
        bullAgreement: bullDecision?.agreement_count,
        bearAgreement: bearDecision?.agreement_count,
        bullRecommended: bullDecision?.entry_recommended,
        bearRecommended: bearDecision?.entry_recommended,
        bullActionable, bearActionable,
        minDirectionSpread,
      }, '[engine] Master algorithm evaluated both directions');

      if (spread < minDirectionSpread) {
        if (ultraScalping) {
          // Ultra-scalping: pick the stronger side even with tiny spread
          direction = bullScore >= bearScore ? 'bullish' : 'bearish';
          masterDecision = bullScore >= bearScore ? bullDecision : bearDecision;
          logger.info({ bullScore, bearScore, spread, minDirectionSpread },
            '[engine] Ultra-scalping: spread tight but picking stronger side');
        } else {
          logger.info({ bullScore, bearScore, spread, minDirectionSpread },
            '[engine] Bull/bear spread too tight — waiting for directional bias');
          await engineLogger.logEvent({
            sessionId: state.session._id,
            eventType: 'direction_tight',
            level: 'info',
            message: `Spread too tight (bull ${bullScore.toFixed(1)} vs bear ${bearScore.toFixed(1)})`,
            data: { bullScore, bearScore, spread, minDirectionSpread },
          });
          return;
        }
      }

      if (bullActionable && (!bearActionable || bullScore >= bearScore)) {
        direction = 'bullish';
        masterDecision = bullDecision;
      } else if (bearActionable) {
        direction = 'bearish';
        masterDecision = bearDecision;
      } else {
        // Ultra-scalping: still pick the clearly stronger side if the
        // spread passes AND at least one direction is above the master
        // score floor. This keeps us in the market without firing blind.
        const scoreFloor = masterThresholds.minMasterScore - 5;
        if (ultraScalping && Math.max(bullScore, bearScore) >= scoreFloor && spread >= minDirectionSpread) {
          direction = bullScore >= bearScore ? 'bullish' : 'bearish';
          masterDecision = bullScore >= bearScore ? bullDecision : bearDecision;
          logger.info({
            direction, bullScore, bearScore, spread, scoreFloor
          }, '[engine] Ultra-scalping: leaning side meets score-floor, proceeding');
        } else {
          logger.info({
            bullScore, bearScore,
            bullSignal: bullDecision?.master_signal,
            bearSignal: bearDecision?.master_signal,
          }, '[engine] Neither direction actionable per master algorithm — waiting');

          // Before giving up — check if global markets provide a clear direction
          // When global is strongly_bullish/bearish, use that as direction even with tight spread
          const globalBiasForWait = algorithmOutputs.globalMarkets?.global_bias || 'neutral';
          if (globalBiasForWait === 'strongly_bullish' || globalBiasForWait === 'strongly_bearish') {
            direction = globalBiasForWait === 'strongly_bullish' ? 'bullish' : 'bearish';
            masterDecision = globalBiasForWait === 'strongly_bullish' ? bullDecision : bearDecision;
            logger.info({
              globalBias: globalBiasForWait,
              bullScore, bearScore, spread,
              direction,
            }, '[engine] Direction_wait overridden by global bias — using global direction');
          } else {
            await engineLogger.logEvent({
              sessionId: state.session._id,
              eventType: 'direction_wait',
              level: 'info',
              message: `No actionable direction (bull ${bullScore}, bear ${bearScore})`,
              data: { bullMaster: bullDecision, bearMaster: bearDecision },
            });
            return;
          }
        }
      }

      // Pro trader's selected_strike/option_type was based on its own neutral
      // view. Align with the direction we just picked so the downstream
      // pipeline (strike selection, downstream confidence gates) is consistent.
      tradeDecision.option_type = direction === 'bullish' ? 'CE' : 'PE';
      tradeDecision.trade_decision = direction === 'bullish' ? 'ENTER_LONG' : 'ENTER_SHORT';
      tradeDecision.dominant_direction = direction;
      // Use master algorithm confidence when pro trader expressed none.
      if (!tradeDecision.confidence || tradeDecision.confidence < 1) {
        tradeDecision.confidence = masterDecision.confidence;
      }
    } else {
      logger.info('[engine] Pro trader neutral and master-fallback disabled — waiting');
      return;
    }

    // ── DIRECTION LOCK: prevent flip-flopping every 60s ──────────────────────
    // If we picked a direction recently and it's different from last time,
    // only allow the switch if enough time has passed.
    const now_ms = Date.now();
    if (state.lastDirection && state.lastDirection !== direction &&
        (now_ms - state.lastDirectionAt) < state.directionLockMs) {

      // Don't lock if global markets strongly contradict the locked direction
      const globalBiasForLock = algorithmOutputs.globalMarkets?.global_bias || 'neutral';
      const lockConflictsGlobal = (state.lastDirection === 'bearish' && globalBiasForLock === 'strongly_bullish') ||
                                   (state.lastDirection === 'bullish' && globalBiasForLock === 'strongly_bearish');

      if (lockConflictsGlobal) {
        logger.warn({
          lastDirection: state.lastDirection,
          newDirection: direction,
          globalBias: globalBiasForLock,
        }, '[engine] Direction lock BROKEN — global markets strongly contradict locked direction');
        state.lastDirection = direction;
        state.lastDirectionAt = now_ms;
      } else {
        logger.warn({
          lastDirection: state.lastDirection,
          newDirection: direction,
          lockedForMs: state.directionLockMs - (now_ms - state.lastDirectionAt),
        }, '[engine] Direction lock active — keeping previous direction to prevent flip-flop');
        direction = state.lastDirection;
        tradeDecision.option_type = direction === 'bullish' ? 'CE' : 'PE';
        tradeDecision.trade_decision = direction === 'bullish' ? 'ENTER_LONG' : 'ENTER_SHORT';
        tradeDecision.dominant_direction = direction;
        masterDecision = masterAlgorithm.calculateMasterScore(payload, algorithmOutputs, direction, masterThresholds);
      }
    } else {
      state.lastDirection = direction;
      state.lastDirectionAt = now_ms;
    }

    // ── GLOBAL MARKETS DIRECTION SANITY CHECK ────────────────────────────────
    // If global markets are strongly bullish, don't enter bearish trades.
    // If global markets are strongly bearish, don't enter bullish trades.
    // This prevents the "BUY_PE when global is strongly_bullish" problem.
    const globalBias = algorithmOutputs.globalMarkets?.global_bias || 'neutral';
    const globalRisk = algorithmOutputs.globalMarkets?.risk_sentiment?.sentiment || 'neutral';
    if (globalBias === 'strongly_bullish' && direction === 'bearish') {
      logger.warn({ globalBias, direction }, '[engine] Global strongly_bullish conflicts with bearish direction — switching to bullish');
      direction = 'bullish';
      tradeDecision.option_type = 'CE';
      tradeDecision.trade_decision = 'ENTER_LONG';
      tradeDecision.dominant_direction = 'bullish';
      state.lastDirection = 'bullish';
      state.lastDirectionAt = now_ms;
      masterDecision = masterAlgorithm.calculateMasterScore(payload, algorithmOutputs, 'bullish', masterThresholds);
    } else if (globalBias === 'strongly_bearish' && direction === 'bullish') {
      logger.warn({ globalBias, direction }, '[engine] Global strongly_bearish conflicts with bullish direction — switching to bearish');
      direction = 'bearish';
      tradeDecision.option_type = 'PE';
      tradeDecision.trade_decision = 'ENTER_SHORT';
      tradeDecision.dominant_direction = 'bearish';
      state.lastDirection = 'bearish';
      state.lastDirectionAt = now_ms;
      masterDecision = masterAlgorithm.calculateMasterScore(payload, algorithmOutputs, 'bearish', masterThresholds);
    }

    if (!masterDecision) {
      logger.error('[engine] Master algorithm failed');
      return;
    }

    logger.info({
      direction,
      masterScore: masterDecision.master_score,
      confidence: masterDecision.confidence,
      agreementCount: masterDecision.agreement_count,
      signal: masterDecision.master_signal
    }, '[engine] Master algorithm decision completed');
    
    // Store master decision for monitor cycle to use
    state.lastMasterDecision = masterDecision;
    
    // Log master decision
    await engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'master_algorithm',
      level: 'info',
      message: `Master Score: ${masterDecision.master_score}/100, Confidence: ${masterDecision.confidence}/10, Agreement: ${masterDecision.agreement_count}/16`,
      data: masterDecision,
    });

    // ============================================================
    // STEP 3.1: PRICE ACTION OVERRIDE (NEW!)
    // When multi-timeframe shows CLEAR trend, override weak master decision
    // This prevents trading against obvious trends due to sentiment/news
    // ============================================================
    const mtf = payload.multi_timeframe;
    const vwapPos = payload.vwap_analysis?.price_vs_vwap;
    const spotLtp = payload.spot_data?.ltp || payload.actual_spot_price;
    const vwap = payload.vwap_analysis?.vwap;
    
    // Define clear uptrend: 15m + 30m bullish, price above VWAP
    const clearUptrend = (
      mtf?.tf_15m === 'bullish' &&
      mtf?.tf_30m === 'bullish' &&
      vwapPos === 'above' &&
      spotLtp > vwap
    );
    
    // Define clear downtrend: 15m + 30m bearish, price below VWAP
    const clearDowntrend = (
      mtf?.tf_15m === 'bearish' &&
      mtf?.tf_30m === 'bearish' &&
      vwapPos === 'below' &&
      spotLtp < vwap
    );
    
    // Override if master picked wrong direction with low conviction
    if (clearUptrend && direction === 'bearish' && masterDecision.master_score < 75) {
      logger.warn({
        masterDirection: 'bearish',
        masterScore: masterDecision.master_score,
        priceAction: 'CLEAR UPTREND',
        mtf15m: mtf?.tf_15m,
        mtf30m: mtf?.tf_30m,
        vwapPosition: vwapPos,
        spotVsVwap: `${spotLtp.toFixed(2)} > ${vwap.toFixed(2)}`
      }, '[engine] 🔄 PRICE ACTION OVERRIDE: Clear uptrend detected, switching to BULLISH');
      
      direction = 'bullish';
      masterDecision = masterAlgorithm.calculateMasterScore(payload, algorithmOutputs, 'bullish', masterThresholds);
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'price_action_override',
        level: 'warn',
        message: `Override: Bearish → Bullish (Clear uptrend on 15m+30m, price above VWAP)`,
        data: {
          originalDirection: 'bearish',
          newDirection: 'bullish',
          reason: 'clear_uptrend',
          mtf15m: mtf?.tf_15m,
          mtf30m: mtf?.tf_30m,
          vwapPosition: vwapPos,
          newMasterScore: masterDecision.master_score
        },
      });
    }
    
    if (clearDowntrend && direction === 'bullish' && masterDecision.master_score < 75) {
      logger.warn({
        masterDirection: 'bullish',
        masterScore: masterDecision.master_score,
        priceAction: 'CLEAR DOWNTREND',
        mtf15m: mtf?.tf_15m,
        mtf30m: mtf?.tf_30m,
        vwapPosition: vwapPos,
        spotVsVwap: `${spotLtp.toFixed(2)} < ${vwap.toFixed(2)}`
      }, '[engine] 🔄 PRICE ACTION OVERRIDE: Clear downtrend detected, switching to BEARISH');
      
      direction = 'bearish';
      masterDecision = masterAlgorithm.calculateMasterScore(payload, algorithmOutputs, 'bearish', masterThresholds);
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'price_action_override',
        level: 'warn',
        message: `Override: Bullish → Bearish (Clear downtrend on 15m+30m, price below VWAP)`,
        data: {
          originalDirection: 'bullish',
          newDirection: 'bearish',
          reason: 'clear_downtrend',
          mtf15m: mtf?.tf_15m,
          mtf30m: mtf?.tf_30m,
          vwapPosition: vwapPos,
          newMasterScore: masterDecision.master_score
        },
      });
    }

    // ============================================================
    // STEP 3.2: LIQUIDITY SAFETY CHECK (NEW!)
    // Don't trade in poor liquidity conditions
    // ============================================================
    if (algorithmOutputs.liquidityAnalysis) {
      const liquidityHealth = algorithmOutputs.liquidityAnalysis.liquidity_health;
      const liquidityScore = algorithmOutputs.liquidityAnalysis.liquidity_score;
      const sweepRisk = algorithmOutputs.liquidityAnalysis.liquidity_sweeps.sweep_risk;
      
      logger.info({
        liquidityHealth,
        liquidityScore,
        sweepRisk,
        spreadStatus: algorithmOutputs.liquidityAnalysis.spread_analysis.spread_status
      }, '[engine] Liquidity safety check');
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'liquidity_check',
        level: liquidityHealth === 'critical' || liquidityHealth === 'poor' ? 'warn' : 'info',
        message: `Liquidity: ${liquidityHealth} (Score: ${liquidityScore}/100)`,
        data: {
          liquidityHealth,
          liquidityScore,
          sweepRisk,
          bidAskImbalance: algorithmOutputs.liquidityAnalysis.bid_ask_imbalance,
          spreadStatus: algorithmOutputs.liquidityAnalysis.spread_analysis.spread_status,
          domDepth: algorithmOutputs.liquidityAnalysis.dom_depth.depth_quality
        },
      });
      
      // CRITICAL: Don't trade in poor liquidity
      if (liquidityHealth === 'critical') {
        logger.warn({ 
          liquidityScore,
          reason: 'Critical liquidity conditions'
        }, '[engine] Liquidity check failed - not entering trade');
        return;
      }
      
      // HIGH RISK: Don't trade during liquidity sweeps
      if (sweepRisk === 'high' || algorithmOutputs.liquidityAnalysis.liquidity_sweeps.sweep_detected) {
        logger.warn({ 
          sweepRisk,
          sweepDetected: algorithmOutputs.liquidityAnalysis.liquidity_sweeps.sweep_detected,
          reason: 'Liquidity sweep risk detected'
        }, '[engine] Liquidity sweep risk - not entering trade');
        return;
      }
      
      // MEDIUM RISK: Reduce size in poor liquidity
      if (liquidityHealth === 'poor') {
        logger.warn({ 
          liquidityScore,
          reason: 'Poor liquidity - reducing position size by 50%'
        }, '[engine] Poor liquidity - reducing size');
        settings.lotSize = Math.max(1, Math.floor(settings.lotSize * 0.5));
      }
      
      // FAIR LIQUIDITY: Reduce size by 25%
      if (liquidityHealth === 'fair') {
        logger.info({ 
          liquidityScore,
          reason: 'Fair liquidity - reducing position size by 25%'
        }, '[engine] Fair liquidity - reducing size');
        settings.lotSize = Math.max(1, Math.floor(settings.lotSize * 0.75));
      }
    }

    // ============================================================
    // STEP 3.25: SMART MONEY CONCEPTS (SMC) VALIDATION (NEW!)
    // Check if trade aligns with institutional order flow
    // ============================================================
    if (algorithmOutputs.smartMoneyConcepts) {
      const smcBias = algorithmOutputs.smartMoneyConcepts.smc_bias;
      const smcScore = algorithmOutputs.smartMoneyConcepts.smc_score;
      const marketStructure = algorithmOutputs.smartMoneyConcepts.market_structure;
      
      logger.info({
        smcBias,
        smcScore,
        marketStructure: marketStructure.structure,
        trend: marketStructure.trend
      }, '[engine] SMC validation check');
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'smc_check',
        level: 'info',
        message: `SMC: ${smcBias} bias (Score: ${smcScore}/100), Structure: ${marketStructure.structure}`,
        data: {
          smcBias,
          smcScore,
          marketStructure,
          orderBlocks: algorithmOutputs.smartMoneyConcepts.order_blocks,
          fairValueGaps: algorithmOutputs.smartMoneyConcepts.fair_value_gaps,
          breakOfStructure: algorithmOutputs.smartMoneyConcepts.break_of_structure,
          changeOfCharacter: algorithmOutputs.smartMoneyConcepts.change_of_character
        },
      });
      
      // CRITICAL: Don't trade against SMC bias
      if (smcBias !== 'neutral' && smcBias !== direction) {
        if (ultraScalping) {
          logger.warn({ smcBias, direction }, '[engine] Ultra-scalping: SMC bias conflict but proceeding with reduced size');
          settings.lotSize = Math.max(1, Math.floor((settings.lotSize || 1) * 0.5));
        } else {
          logger.warn({ 
            smcBias,
            direction,
            reason: 'SMC bias conflicts with trade direction'
          }, '[engine] SMC bias conflict - not entering trade');
          
          await engineLogger.logEvent({
            sessionId: state.session._id,
            eventType: 'smc_conflict',
            level: 'warn',
            message: `SMC bias (${smcBias}) conflicts with direction (${direction}) - trade blocked`,
            data: { smcBias, direction, smcScore },
          });
          
          return;
        }
      }
      
      // WARNING: Conflicting market structure
      if (marketStructure.structure === 'conflicting') {
        if (ultraScalping) {
          logger.warn({ structure: marketStructure.structure }, '[engine] Ultra-scalping: conflicting SMC structure but proceeding');
        } else {
          logger.warn({ 
            structure: marketStructure.structure,
            reason: 'Conflicting SMC signals detected'
          }, '[engine] Conflicting SMC structure - not entering trade');
          return;
        }
      }
      
      // BONUS: Inside order block = high probability zone
      if (algorithmOutputs.smartMoneyConcepts.order_blocks.inside_block) {
        const ob = algorithmOutputs.smartMoneyConcepts.order_blocks.inside_block;
        logger.info({ 
          orderBlock: ob,
          reason: 'Inside institutional order block - high probability zone'
        }, '[engine] Inside order block - excellent setup');
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'order_block_entry',
          level: 'info',
          message: `Inside ${ob.type} order block (${ob.zone_low}-${ob.zone_high}) - institutional zone`,
          data: { orderBlock: ob },
        });
      }
      
      // BONUS: Filling fair value gap = high probability
      if (algorithmOutputs.smartMoneyConcepts.fair_value_gaps.filling_gap) {
        const fvg = algorithmOutputs.smartMoneyConcepts.fair_value_gaps.filling_gap;
        logger.info({ 
          fvg,
          reason: 'Filling fair value gap - price imbalance correction'
        }, '[engine] Filling FVG - excellent setup');
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'fvg_fill',
          level: 'info',
          message: `Filling ${fvg.type} FVG (${fvg.gap_low}-${fvg.gap_high}) - price imbalance`,
          data: { fvg },
        });
      }
    }

    // ============================================================
    // OPTIMIZATION 3: Duplicate SMC validation removed
    // SMC validation already done above (lines 540-633)
    // ============================================================

    // ============================================================
    // STEP 3.3: GLOBAL MARKETS SAFETY CHECK (NEW!)
    // Don't trade against global risk sentiment
    // ============================================================
    if (algorithmOutputs.globalMarkets) {
      const riskSentiment = algorithmOutputs.globalMarkets.risk_sentiment.sentiment;
      const globalBias = algorithmOutputs.globalMarkets.global_bias;
      const globalScore = algorithmOutputs.globalMarkets.global_score;
      
      logger.info({
        riskSentiment,
        globalBias,
        globalScore,
        usFutures: algorithmOutputs.globalMarkets.us_futures?.direction,
        dxy: algorithmOutputs.globalMarkets.dxy?.changePct,
        crude: algorithmOutputs.globalMarkets.crude_oil?.changePct
      }, '[engine] Global markets safety check');
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'global_markets_check',
        level: riskSentiment.includes('risk_off') ? 'warn' : 'info',
        message: `Global: ${riskSentiment} (Score: ${globalScore}/100), Bias: ${globalBias}`,
        data: {
          riskSentiment,
          globalBias,
          globalScore,
          usFutures: algorithmOutputs.globalMarkets.us_futures,
          dxy: algorithmOutputs.globalMarkets.dxy,
          crudeOil: algorithmOutputs.globalMarkets.crude_oil,
          tradingImplication: algorithmOutputs.globalMarkets.trading_implication
        },
      });
      
      // CRITICAL: Don't trade longs in strong risk-off environment
      if (direction === 'bullish' && riskSentiment === 'strong_risk_off') {
        logger.warn({ 
          riskSentiment,
          direction,
          reason: 'Strong global risk-off - avoid longs'
        }, '[engine] Global risk-off - not entering long trade');
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'global_risk_off',
          level: 'warn',
          message: `Strong global risk-off detected - long trade blocked`,
          data: { riskSentiment, direction, globalScore },
        });
        
        return;
      }
      
      // WARNING: Crude oil spike (negative for India)
      if (algorithmOutputs.globalMarkets.crude_oil?.severity === 'critical' && 
          algorithmOutputs.globalMarkets.crude_oil?.changePct > 2) {
        logger.warn({ 
          crudeChange: algorithmOutputs.globalMarkets.crude_oil.changePct,
          reason: 'Crude oil spiking - negative for India'
        }, '[engine] Crude spike detected - reducing position size');
        
        // Reduce position size by 50%
        settings.lotSize = Math.max(1, Math.floor(settings.lotSize * 0.5));
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'crude_spike',
          level: 'warn',
          message: `Crude oil spike detected (+${algorithmOutputs.globalMarkets.crude_oil.changePct}%) - position size reduced`,
          data: { crudeOil: algorithmOutputs.globalMarkets.crude_oil },
        });
      }
      
      // WARNING: Strong dollar (FII outflow risk)
      if (algorithmOutputs.globalMarkets.dxy?.strength === 'strong' && 
          algorithmOutputs.globalMarkets.dxy?.changePct > 0.5) {
        logger.warn({ 
          dxyChange: algorithmOutputs.globalMarkets.dxy.changePct,
          reason: 'Dollar strengthening - FII outflow risk'
        }, '[engine] Dollar strength detected - reducing position size');
        
        // Reduce position size by 25%
        settings.lotSize = Math.max(1, Math.floor(settings.lotSize * 0.75));
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'dollar_strength',
          level: 'warn',
          message: `Dollar strengthening (+${algorithmOutputs.globalMarkets.dxy.changePct}%) - position size reduced`,
          data: { dxy: algorithmOutputs.globalMarkets.dxy },
        });
      }
    }

    // ============================================================
    // STEP 3.35: BEHAVIORAL ANALYSIS CHECK (NEW!)
    // Identify contrarian opportunities and avoid traps
    // ============================================================
    if (algorithmOutputs.behavioral) {
      const behavioralBias = algorithmOutputs.behavioral.behavioral_bias;
      const behavioralScore = algorithmOutputs.behavioral.behavioral_score;
      
      logger.info({
        behavioralBias,
        behavioralScore,
        retailPanic: algorithmOutputs.behavioral.retail_panic.detected,
        fomo: algorithmOutputs.behavioral.fomo.detected,
        shortSqueeze: algorithmOutputs.behavioral.short_squeeze.detected,
        trapMoves: algorithmOutputs.behavioral.trap_moves.detected
      }, '[engine] Behavioral analysis check');
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'behavioral_check',
        level: 'info',
        message: `Behavioral: ${behavioralBias} (Score: ${behavioralScore}/100)`,
        data: {
          behavioralBias,
          behavioralScore,
          retailPanic: algorithmOutputs.behavioral.retail_panic,
          fomo: algorithmOutputs.behavioral.fomo,
          shortSqueeze: algorithmOutputs.behavioral.short_squeeze,
          trapMoves: algorithmOutputs.behavioral.trap_moves,
          meanReversion: algorithmOutputs.behavioral.mean_reversion,
          tradingImplication: algorithmOutputs.behavioral.trading_implication
        },
      });
      
      // OPPORTUNITY: Retail panic with reversal (contrarian buy)
      if (algorithmOutputs.behavioral.retail_panic.detected && 
          algorithmOutputs.behavioral.retail_panic.reversal_confirmed &&
          direction === 'bullish') {
        logger.info({ 
          retailPanic: algorithmOutputs.behavioral.retail_panic,
          reason: 'Retail panic with reversal - contrarian buy opportunity'
        }, '[engine] Retail panic opportunity - excellent contrarian setup');
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'retail_panic_opportunity',
          level: 'info',
          message: `Retail panic detected with reversal - contrarian buy opportunity`,
          data: { retailPanic: algorithmOutputs.behavioral.retail_panic },
        });
      }
      
      // WARNING: Extreme FOMO (fade the rally)
      if (algorithmOutputs.behavioral.fomo.detected && 
          algorithmOutputs.behavioral.fomo.severity === 'extreme' &&
          direction === 'bullish') {
        if (ultraScalping) {
          logger.warn({ fomo: algorithmOutputs.behavioral.fomo }, '[engine] Ultra-scalping: extreme FOMO detected but proceeding with reduced size');
          settings.lotSize = Math.max(1, Math.floor((settings.lotSize || 1) * 0.5));
        } else {
          logger.warn({ 
            fomo: algorithmOutputs.behavioral.fomo,
            reason: 'Extreme FOMO detected - rally likely to fade'
          }, '[engine] Extreme FOMO - not entering long (fade opportunity)');
          
          await engineLogger.logEvent({
            sessionId: state.session._id,
            eventType: 'fomo_warning',
            level: 'warn',
            message: `Extreme FOMO detected - long trade blocked (fade opportunity)`,
            data: { fomo: algorithmOutputs.behavioral.fomo },
          });
          
          return;
        }
      }
      
      // OPPORTUNITY: Short squeeze (ride the momentum)
      if (algorithmOutputs.behavioral.short_squeeze.detected && direction === 'bullish') {
        logger.info({ 
          shortSqueeze: algorithmOutputs.behavioral.short_squeeze,
          reason: 'Short squeeze detected - ride the momentum'
        }, '[engine] Short squeeze - excellent momentum setup');
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'short_squeeze_opportunity',
          level: 'info',
          message: `Short squeeze detected - ride the momentum`,
          data: { shortSqueeze: algorithmOutputs.behavioral.short_squeeze },
        });
      }
      
      // WARNING: Trap moves (false breakout)
      if (algorithmOutputs.behavioral.trap_moves.detected) {
        const trapType = algorithmOutputs.behavioral.trap_moves.trap_type;
        
        // Bull trap + bullish direction = conflict
        if (trapType === 'bull_trap' && direction === 'bullish') {
          if (ultraScalping) {
            logger.warn({ trapType, direction }, '[engine] Ultra-scalping: bull trap detected but proceeding with reduced size');
            settings.lotSize = Math.max(1, Math.floor((settings.lotSize || 1) * 0.5));
          } else {
            logger.warn({ 
              trapType,
              direction,
              reason: 'Bull trap detected - false breakout'
            }, '[engine] Bull trap detected - not entering long');
            
            await engineLogger.logEvent({
              sessionId: state.session._id,
              eventType: 'trap_warning',
              level: 'warn',
              message: `Bull trap detected - long trade blocked`,
              data: { trapMoves: algorithmOutputs.behavioral.trap_moves },
            });
            
            return;
          }
        }
        
        // Bear trap + bearish direction = conflict
        if (trapType === 'bear_trap' && direction === 'bearish') {
          if (ultraScalping) {
            logger.warn({ trapType, direction }, '[engine] Ultra-scalping: bear trap detected but proceeding with reduced size');
            settings.lotSize = Math.max(1, Math.floor((settings.lotSize || 1) * 0.5));
          } else {
            logger.warn({ 
              trapType,
              direction,
              reason: 'Bear trap detected - false breakdown'
            }, '[engine] Bear trap detected - not entering short');
            
            await engineLogger.logEvent({
              sessionId: state.session._id,
              eventType: 'trap_warning',
              level: 'warn',
              message: `Bear trap detected - short trade blocked`,
              data: { trapMoves: algorithmOutputs.behavioral.trap_moves },
            });
            
            return;
          }
        }
      }
    }

    // ============================================================
    // STEP 3.4: AI VALIDATES MASTER ALGORITHM (DISABLED FOR SPEED)
    // OPTIMIZATION: Removed to save 2-4 seconds per entry
    // Algorithms already validated, no need for additional AI check
    // ============================================================
    /* DISABLED FOR SPEED OPTIMIZATION
    logger.info('[engine] Sending master algorithm output to AI for validation');
    
    const masterAIValidation = await aiAnalysis.validateMasterScoreWithAI(
      masterDecision,
      algorithmOutputs,
      payload,
      state.session.aiModel
    );
    
    if (masterAIValidation) {
      logger.info({
        aiAgreesWithEntry: masterAIValidation.ai_agrees_with_entry,
        aiConfidence: masterAIValidation.ai_confidence,
        shouldProceed: masterAIValidation.should_proceed,
        aiRecommendation: masterAIValidation.ai_recommendation
      }, '[engine] Master algorithm AI validation completed');
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'master_ai_validation',
        level: 'info',
        message: `AI Validation: ${masterAIValidation.ai_recommendation} (AI Confidence: ${masterAIValidation.ai_confidence}/10)`,
        data: masterAIValidation,
      });
      
      // AI DECIDES - Exit if AI doesn't agree
      if (!masterAIValidation.should_proceed || masterAIValidation.ai_recommendation !== 'ENTER') {
        logger.warn({ 
          aiRecommendation: masterAIValidation.ai_recommendation,
          reasoning: masterAIValidation.reasoning,
          hiddenRisks: masterAIValidation.hidden_risks
        }, '[engine] AI validation failed - not proceeding');
        return;
      }
    }
    */
    logger.info('[engine] Master AI validation SKIPPED (optimization enabled - saves 2-4s)');

    // ============================================================
    // STEP 3.45: FII/DII DATA — NO SEPARATE AI CALL
    // FII/DII data is included as context in the main institutional AI entry call.
    // A separate AI call for FII/DII wastes 2-3 seconds and always returns
    // "flows absent" when Sensibull has no data — which is most of the time.
    // The main entry AI already receives all algorithm outputs including FII/DII.
    // ============================================================
    const fiiDiiContext = algorithmOutputs.marketInternals?.institutional_flow_raw || null;
    const fiiDiiSummary = fiiDiiContext ? {
      available: true,
      fii_cash_net: fiiDiiContext?.cash?.fii?.buy_sell_difference || 0,
      dii_cash_net: fiiDiiContext?.cash?.dii?.buy_sell_difference || 0,
      fii_futures_net: fiiDiiContext?.future?.fii?.['quantity-wise']?.net_oi || 0,
      consensus: 'included_in_main_ai_call',
    } : { available: false, note: 'No FII/DII data from Sensibull — normal during market hours' };

    logger.info({ fiiDiiAvailable: !!fiiDiiContext }, '[engine] FII/DII data prepared for main AI call (no separate validation call)');

    // Check if master algorithm recommends entry (backup check)
    // ── MASTER SCORE HARD GATE ────────────────────────────────────────────────
    // Hard floor: master score must be >= masterMinScore (default 55 → lowered to 50).
    // 54.8 was being blocked by 55 — too tight for ranging markets.
    const hardMasterFloor = Number(settings.masterMinScore) || 50;
    if (masterDecision.master_score < hardMasterFloor) {
      logger.warn({
        masterScore: masterDecision.master_score,
        hardMasterFloor,
        direction,
      }, `[engine] Master score ${masterDecision.master_score} below hard floor ${hardMasterFloor} — no entry`);
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'master_floor_block',
        level: 'warn',
        message: `Master score ${masterDecision.master_score} < floor ${hardMasterFloor} — entry blocked`,
        data: { masterScore: masterDecision.master_score, hardMasterFloor, direction },
      });
      return;
    }

    // ── MASTER CONFIDENCE GATE ────────────────────────────────────────────────
    // Use configurable confidence threshold from settings (default 0.5 for ranging markets)
    // In ranging markets, algorithms naturally disagree more, so lower threshold is needed
    const minMasterConfidence = Number(settings.masterMinConfidence) || 0.5;
    if (masterDecision.confidence < minMasterConfidence) {
      logger.warn({
        masterScore: masterDecision.master_score,
        masterConfidence: masterDecision.confidence,
        minRequired: minMasterConfidence,
        direction,
      }, '[engine] Master confidence too low (algorithms split) — no entry');
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'master_confidence_block',
        level: 'warn',
        message: `Master confidence ${masterDecision.confidence}/10 < minimum ${minMasterConfidence} — algorithms disagree, no edge`,
        data: { masterScore: masterDecision.master_score, masterConfidence: masterDecision.confidence, minRequired: minMasterConfidence },
      });
      return;
    }

    // ── RANGING MARKET GATE ───────────────────────────────────────────────────
    // In a ranging market with no momentum, CE/PE premiums decay.
    // Only block if BOTH: MTF is neutral AND master score is below 70.
    // If master score is 70+ with global strongly_bullish/bearish, still enter.
    const aggMtf = payload.multi_timeframe;
    if (aggMtf && aggMtf.alignment === 'neutral' && masterDecision.confidence < 3
        && masterDecision.master_score < 70) {
      logger.warn({
        mtfAlignment: aggMtf.alignment,
        higherTfBias: aggMtf.higher_tf_bias,
        masterConfidence: masterDecision.confidence,
        masterScore: masterDecision.master_score,
      }, '[engine] Ranging market with no momentum and weak master score — skipping entry');
      return;
    }

    // Check if master algorithm recommends entry
    if (!masterDecision.entry_recommended) {
      logger.info({
        masterScore: masterDecision.master_score,
        masterConfidence: masterDecision.confidence,
        masterAgreement: masterDecision.agreement_count,
        proConfidence: tradeDecision.confidence,
        proDecision: tradeDecision.trade_decision,
        direction,
      }, '[engine] Master not recommended — proceeding (score above floor, AI will validate)');
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'master_override',
        level: 'warn',
        message: `Master not recommended (score ${masterDecision.master_score}, conf ${masterDecision.confidence}) — AI will validate`,
        data: { masterDecision, proConfidence: tradeDecision.confidence, direction },
      });
    }

    // ============================================================
    // STEP 3.5: NIFTY FUTURES — read from live-feed folder (no API)
    // ============================================================
    // CALIBRATED 2026-05-18: futures API auth keeps returning 401 in
    // production. We have a futuresCandleAggregator that builds
    // futures-1m/5m/15m candles from the WebSocket tick stream
    // (futures-ticks.jsonl) into the live-feed folder. Read from there
    // instead of hitting the API.
    let futuresConfirmation = null;
    let futuresAIDecision = null;
    let futuresDataForHybrid = null;

    if (settings.enableFuturesConfirmation) {
      try {
        const liveFeedProvider = require('./liveFeedDataProvider.service');
        const niftyFuturesProd = require('./niftyFuturesProd.service');
        const [futRes5, futRes1] = await Promise.all([
          liveFeedProvider.getFuturesCandles(state.authKey, '5', 120),
          liveFeedProvider.getFuturesCandles(state.authKey, '1', 30),
        ]);
        const futCandles = futRes5.ok ? (futRes5.data.candles || []) : [];
        const futCandles1m = futRes1.ok ? (futRes1.data.candles || []) : [];

        // Best-effort: get the futures security id (cached) for live tick delta
        let futSecurityId = null;
        try { futSecurityId = await niftyFuturesProd.getSecurityId(); } catch (_) {}

        // Live futures price — prefers WebSocket tick, falls back to last
        // recorded futures-1m close (provider handles freshness logic).
        const liveFutPrice = liveFeedProvider.getCurrentFuturesPrice();

        if (futCandles.length >= 3) {
          // Compute basic futures direction/momentum from local candles
          const last = futCandles[futCandles.length - 1];
          const prev = futCandles[futCandles.length - 2];
          const first = futCandles[0];
          const change1m = prev?.close ? ((last.close - prev.close) / prev.close) * 100 : 0;
          const changeWindow = first?.close ? ((last.close - first.close) / first.close) * 100 : 0;
          const direction = changeWindow > 0.05 ? 'bullish' : changeWindow < -0.05 ? 'bearish' : 'neutral';
          const trend = changeWindow > 0.15 ? 'bullish' : changeWindow < -0.15 ? 'bearish' : 'neutral';
          const momentum = Math.abs(change1m) > 0.1 ? (change1m > 0 ? 'bullish' : 'bearish') : 'neutral';

          // Prefer the live tick LTP when available (WebSocket is fresher
          // than the rolling 1m close).
          const ltp = liveFutPrice?.ltp || last?.close || null;
          const premium = (ltp && spotPrice) ? Number((ltp - spotPrice).toFixed(2)) : null;

          futuresDataForHybrid = {
            direction, trend, momentum,
            change_1m: Number(change1m.toFixed(3)),
            change_5m: Number(changeWindow.toFixed(3)),
            premium,
            spread: premium,
            spreadPct: spotPrice && premium ? Number((premium / spotPrice * 100).toFixed(3)) : null,
            divergence: null,
            ltp,
            candles_1m: futCandles1m,
            candles_5m: futCandles,
            securityId: futSecurityId || liveFutPrice?.securityId || null,
            source: liveFutPrice?.source || 'live_feed_folder',
            candleCount: futCandles.length,
          };

          state.lastFuturesData = futuresDataForHybrid;

          logger.info({
            source: futuresDataForHybrid.source,
            candles: futCandles.length,
            candles1m: futCandles1m.length,
            futSecurityId: futuresDataForHybrid.securityId,
            ltp,
            premium,
            direction, trend, momentum,
            change1m: change1m.toFixed(3),
            changeWindow: changeWindow.toFixed(3),
          }, '[engine] Futures data resolved (WebSocket → folder → API fallback chain)');
        } else if (liveFutPrice?.ltp) {
          // No candles yet but we have a tick — emit a minimal record so
          // downstream futures-leadership engine still has direction.
          futuresDataForHybrid = {
            direction: 'neutral',
            trend: 'neutral',
            momentum: 'neutral',
            change_1m: 0,
            change_5m: 0,
            premium: spotPrice ? Number((liveFutPrice.ltp - spotPrice).toFixed(2)) : null,
            spread: null,
            spreadPct: null,
            divergence: null,
            ltp: liveFutPrice.ltp,
            candles_1m: futCandles1m,
            candles_5m: futCandles,
            securityId: futSecurityId || liveFutPrice.securityId || null,
            source: 'websocket-only',
            candleCount: futCandles.length,
          };
          state.lastFuturesData = futuresDataForHybrid;
          logger.info({
            ltp: liveFutPrice.ltp,
            futSecurityId: futuresDataForHybrid.securityId,
          }, '[engine] Futures data: WebSocket tick only (insufficient candles)');
        } else {
          logger.warn({ candles: futCandles.length }, '[engine] Insufficient futures candles + no live tick');
        }
      } catch (e) {
        logger.warn({ err: e.message }, '[engine] Futures live-feed read failed');
      }
    }
    // (Legacy futures-AI confirmation block removed — futures data now
    // comes from live-feed folder above and flows directly to the hybrid
    // engine via state.lastFuturesData.)

    // ============================================================
    // OPTIMIZATION 1: PARALLEL AI EXECUTION (Save 6-10 seconds)
    // Run AI ensemble + sentiment validation in parallel
    // ULTRA-SCALPING: Skip AI ensemble entirely — the pro trader AI
    // already analyzed the market. Running 3 more AI calls that say
    // WAIT in quiet markets just wastes 6-10 seconds and blocks entries.
    // ============================================================
    let aiEntryDecision = { decision: 'ENTER', confidence: 7, votes: { enter: 5, wait: 0, avoid: 0 }, reasoning: 'Ultra-scalping: ensemble skipped' };
    let sentimentValidation = { should_proceed: true, recommended_action: 'PROCEED', adjustments_needed: [], reasoning: 'Ultra-scalping: sentiment skipped' };

    if (!ultraScalping) {
      logger.info('[engine] Running COMPREHENSIVE AI ensemble + sentiment validation in PARALLEL');

      aiAnalysis.setNextCallPurpose('entry_ensemble_vote');
      const [ensembleResult, sentimentResult] = await Promise.all([
        aiAnalysis.shouldEnterTradeEnsemble(
          payload,
          algorithmOutputs,  // All algorithm outputs
          masterDecision,    // Master algorithm decision
          tradeDecision,     // Professional trader decision
          state.session.aiModel
        ),
        sentimentAnalyzer.analyzeSentimentForTrade(
          {
            direction,
            strike: tradeDecision.selected_strike,
            optionType: tradeDecision.option_type,
            technicalScore: masterDecision.master_score,
            masterScore: masterDecision.master_score,
            confidence: masterDecision.confidence
          },
          marketSentiment,
          state.session.aiModel
        )
      ]);
      aiEntryDecision = ensembleResult || aiEntryDecision;
      sentimentValidation = sentimentResult || sentimentValidation;
    } else {
      logger.info('[engine] Ultra-scalping: AI ensemble + sentiment SKIPPED (pro trader conviction sufficient)');
    }
    
    logger.info({
      decision: aiEntryDecision.decision,
      confidence: aiEntryDecision.confidence,
      votes: aiEntryDecision.votes,
      sentimentSupports: sentimentValidation.sentiment_supports_trade
    }, '[engine] AI ensemble + sentiment validation completed (PARALLEL)');
    
    // Log AI ensemble (async - don't wait)
    engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'ai_ensemble_entry',
      level: 'info',
      message: `AI Ensemble: ${aiEntryDecision.decision} (${aiEntryDecision.votes.enter}/5 voted ENTER)`,
      data: aiEntryDecision,
    });
    
    // Only proceed if AI ensemble agrees.
    // Ultra-scalping: relax the quorum. If votes to enter meet a configurable
    // minimum (default 2/5), proceed with caution and reduced size. The
    // master algorithm already passed its own entry_recommended gate.
    const ensembleMinVotes = Number(settings.ensembleMinVotes) || (ultraScalping ? 2 : 3);
    const ensembleVotesEnter = Number(aiEntryDecision?.votes?.enter) || 0;
    if (aiEntryDecision.decision !== 'ENTER') {
      if (ultraScalping && ensembleVotesEnter >= ensembleMinVotes) {
        logger.info({
          decision: aiEntryDecision.decision,
          votes: aiEntryDecision.votes,
          ensembleMinVotes,
        }, '[engine] Ultra-scalping: ensemble quorum met, overriding and proceeding with reduced size');
        settings.lotSize = Math.max(1, Math.floor((settings.lotSize || 1) * 0.75));
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'ai_ensemble_softened',
          level: 'warn',
          message: `Ultra-scalping: ensemble minority approval (${ensembleVotesEnter}/5), entering`,
          data: { ensembleMinVotes, aiEntryDecision, lotSize: settings.lotSize },
        });
      } else {
        logger.info({
          decision: aiEntryDecision.decision,
          votes: aiEntryDecision.votes,
          reasoning: aiEntryDecision.reasoning,
        }, '[engine] AI ensemble: not entering');
        return;
      }
    }
    
    // Log sentiment validation (async - don't wait)
    engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'sentiment_validation',
      level: sentimentValidation.should_proceed ? 'info' : 'warn',
      message: `Sentiment ${sentimentValidation.recommended_action}: ${sentimentValidation.reasoning}`,
      data: sentimentValidation,
    });
    
    // AI DECIDES - Exit if sentiment doesn't support trade
    // Ultra-scalping: only a hard AVOID with breaking news blocks. A soft
    // "doesn't-really-support" just cuts size.
    if (!sentimentValidation.should_proceed || sentimentValidation.recommended_action === 'AVOID') {
      const hardAvoid = sentimentValidation.recommended_action === 'AVOID' &&
        (marketSentiment?.breaking_news === true ||
         marketSentiment?.risk_level === 'critical');

      if (ultraScalping && !hardAvoid) {
        logger.warn({
          recommendedAction: sentimentValidation.recommended_action,
          conflictDetected: sentimentValidation.conflict_detected,
        }, '[engine] Ultra-scalping: sentiment weak but no critical/breaking-news — continuing with minLots');
        
        // DON'T modify settings.lotSize! It's used for display and calculations.
        // The quantity is already controlled by minLots setting.
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'sentiment_softened',
          level: 'warn',
          message: `Ultra-scalping: sentiment soft, proceeding (size controlled by minLots)`,
          data: { lotSize: settings.lotSize, minLots: settings.minLots, sentimentValidation, hardAvoid },
        });
      } else {
        logger.warn({
          recommendedAction: sentimentValidation.recommended_action,
          reasoning: sentimentValidation.reasoning,
          conflictDetected: sentimentValidation.conflict_detected,
          hardAvoid,
        }, '[engine] Sentiment validation failed - not entering trade');
        return;
      }
    }

    // ============================================================
    // STEP 4.5: ATR VALIDATION (NEW - CRITICAL!)
    // Validate if target points are achievable based on current volatility
    // This prevents entries when market is too quiet or target is unrealistic
    // ============================================================
    let atrAnalysis = null;
    if (settings.enableATRConfirmation) {
      logger.info('[engine] Running ATR analysis to validate target achievability');
      
      const atrModule = require('../algorithms/atrAnalysis');
      atrAnalysis = await atrModule.analyzeATR(
        state.authKey,
        settings.targetPoints || 8,
        settings.slPoints || 12,
        spotPrice
      );
      
      logger.info({
        atrAvailable: atrAnalysis.atrAvailable,
        atr: atrAnalysis.atr,
        targetConfidence: atrAnalysis.targetConfidence,
        recommendation: atrAnalysis.recommendation,
        volatilityState: atrAnalysis.volatilityState
      }, '[engine] ATR analysis completed');
      
      await engineLogger.logEvent({
        sessionId: state.session._id,
        eventType: 'atr_validation',
        level: atrAnalysis.recommendation === 'REJECT' ? 'warn' : 'info',
        message: `ATR: ${atrAnalysis.atr || 'N/A'} pts | Target confidence: ${atrAnalysis.targetConfidence || 50}% | ${atrAnalysis.reasoning}`,
        data: atrAnalysis,
      });
      
      // CRITICAL: Reject if ATR confidence is below minimum threshold
      const minATRConfidence = settings.atrMinConfidence || 60;
      if (atrAnalysis.atrAvailable && atrAnalysis.targetConfidence < minATRConfidence) {
        logger.warn({
          targetConfidence: atrAnalysis.targetConfidence,
          minATRConfidence,
          atr: atrAnalysis.atr,
          targetPoints: settings.targetPoints,
          reasoning: atrAnalysis.reasoning
        }, '[engine] ATR confidence below minimum - target not achievable, rejecting entry');
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'atr_rejection',
          level: 'warn',
          message: `Entry rejected: Target confidence ${atrAnalysis.targetConfidence}% < minimum ${minATRConfidence}%`,
          data: {
            atr: atrAnalysis.atr,
            targetPoints: settings.targetPoints,
            targetConfidence: atrAnalysis.targetConfidence,
            minATRConfidence,
            reasoning: atrAnalysis.reasoning
          },
        });
        
        return; // Exit - don't enter trade
      }
      
      // WARNING: Reduce size if volatility is extreme or quiet
      if (atrAnalysis.recommendation === 'REDUCE_SIZE') {
        logger.warn({
          volatilityState: atrAnalysis.volatilityState,
          atr: atrAnalysis.atr,
          reasoning: atrAnalysis.reasoning
        }, '[engine] ATR recommends size reduction - adjusting position size');
        
        settings.lotSize = Math.max(1, Math.floor((settings.lotSize || 1) * 0.5));
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'atr_size_reduction',
          level: 'warn',
          message: `Position size reduced by 50% due to ${atrAnalysis.volatilityState} volatility`,
          data: {
            volatilityState: atrAnalysis.volatilityState,
            atr: atrAnalysis.atr,
            newLotSize: settings.lotSize,
            reasoning: atrAnalysis.reasoning
          },
        });
      }
      
      // BONUS: Use dynamic levels if ATR suggests better R:R
      if (atrAnalysis.dynamicLevels && atrAnalysis.atr) {
        const dynamicSL = atrAnalysis.dynamicLevels.slPoints;
        const dynamicTarget = atrAnalysis.dynamicLevels.targetPoints;
        
        // Only use dynamic levels if they're more conservative than settings
        if (dynamicSL >= settings.slPoints && dynamicTarget >= settings.targetPoints) {
          logger.info({
            currentSL: settings.slPoints,
            currentTarget: settings.targetPoints,
            dynamicSL,
            dynamicTarget,
            reasoning: atrAnalysis.dynamicLevels.reasoning
          }, '[engine] Using ATR-based dynamic levels for better R:R');
          
          settings.slPoints = dynamicSL;
          settings.targetPoints = dynamicTarget;
          
          await engineLogger.logEvent({
            sessionId: state.session._id,
            eventType: 'atr_dynamic_levels',
            level: 'info',
            message: `Using ATR-based levels: SL=${dynamicSL}pts, Target=${dynamicTarget}pts`,
            data: {
              atr: atrAnalysis.atr,
              slPoints: dynamicSL,
              targetPoints: dynamicTarget,
              reasoning: atrAnalysis.dynamicLevels.reasoning
            },
          });
        }
      }
    } else {
      logger.info('[engine] ATR confirmation disabled in settings - skipping ATR validation');
    }

    // ============================================================
    // STEP 5: INSTITUTIONAL AI ENTRY DECISION
    // Sends ±4 strike chain + ALL algorithm data to OpenAI.
    // targetPoints = MINIMUM — AI must confirm it's achievable.
    // AI also recommends exact strike, option type (ATM/ITM/OTM),
    // and can suggest additional strikes for concurrent entries.
    // ============================================================
    const currentOpenTrades = await require('../models/ScalpingTrade').find({
      sessionId: state.session._id,
      status: 'open',
    }).lean();

    // If option chain failed, build a minimal synthetic chain from aggregator ATM data
    // so AI still has premium/OI context rather than an empty chain
    let optionChainForAI = optionChain;
    if (!optionChainForAI && payload.options_chain) {
      const atmStrikeVal = payload.options_chain.atm_strike || Math.round(spotPrice / 50) * 50;
      optionChainForAI = {
        strikes: [{
          strike: atmStrikeVal,
          call: {
            ltp: payload.options_chain.atm_call?.ltp || 0,
            oi:  payload.options_chain.atm_call?.oi  || 0,
            oiChange: 0,
            iv:  payload.options_chain.atm_call?.iv  || payload.options_chain.atm_iv || 0,
            volume: 0,
            greeks: { delta: payload.options_chain.atm_call?.delta || 0.5 },
            displaySymbol: payload.options_chain.atm_call?.symbol || '',
          },
          put: {
            ltp: payload.options_chain.atm_put?.ltp || 0,
            oi:  payload.options_chain.atm_put?.oi  || 0,
            oiChange: 0,
            iv:  payload.options_chain.atm_put?.iv  || payload.options_chain.atm_iv || 0,
            volume: 0,
            greeks: { delta: payload.options_chain.atm_put?.delta || -0.5 },
            displaySymbol: payload.options_chain.atm_put?.symbol || '',
          },
        }],
        _synthetic: true,
      };
      logger.info({ atmStrike: atmStrikeVal }, '[engine] Using synthetic ATM chain for AI (option chain fetch failed)');
    }

    logger.info({
      direction,
      masterScore: masterDecision.master_score,
      minTarget: settings.targetPoints || 5,
      openTrades: currentOpenTrades.length,
      hasOptionChain: !!optionChainForAI,
      syntheticChain: !optionChain && !!optionChainForAI,
    }, '[engine] Calling Institutional AI for ENTRY decision (±4 strike chain + all algorithms)');

    let institutionalEntryDecision;
    // ENGINE ROUTING — always use the new centralised entry engine.
    // Legacy path (institutionalAI.getEntryDecision) is commented out below.
    const useNewEngines = true;

    if (useNewEngines) {
      // New centralised entry engine — loads today's intraday context + 5-7 prior days
      // + all algorithm outputs + master score, asks AI for strike + type + SCALP/SWING.
      const aggregatorBundle = {
        payload,
        atmStrike: payload?.actual_atm_strike || payload?.options_chain?.atm_strike,
        optionChain: optionChainForAI,
      };
      const newDecision = await entryEngine.decide({
        aggregator: aggregatorBundle,
        algorithmOutputs,
        masterDecision,
        settings,
        session: state.session,
        openTradesCount: currentOpenTrades.length,
        futuresData: futuresDataForHybrid || futuresAIDecision,
        // Pass the active market so the master entry engine doesn't have to
        // guess from registry state. This makes per-cycle routing deterministic
        // when running multiple symbols in parallel.
        market: state.activeSymbolKey,
        // Per-symbol daily caps — count trades and losses ONLY for the
        // active market so NIFTY's losses don't halt SENSEX entries and
        // vice versa. The hybrid risk engine inside masterScalpingEntryEngine
        // honours these via the maxTradesPerDay / maxLossesPerDay settings.
        tradesToday: await _countTodayTrades(state.session?._id, state.activeSymbolKey),
        lossesToday: await _countTodayLosses(state.session?._id, state.activeSymbolKey),
      });
      // Translate new-engine decision to the shape the rest of this function expects
      institutionalEntryDecision = {
        should_enter:          newDecision.signal !== 'NO_TRADE',
        signal:                newDecision.signal,
        strike:                newDecision.strike,
        option_type:           newDecision.option_type === 'CE' ? 'ATM' : newDecision.option_type === 'PE' ? 'ATM' : 'ATM',
        trade_type:            newDecision.trade_type,
        confidence:            newDecision.confidence,
        min_target_achievable: newDecision.min_target_achievable,
        expected_points:       newDecision.expected_points,
        breakout_probability:  60,
        direction:             newDecision.signal === 'BUY_CE' ? 'CE' : newDecision.signal === 'BUY_PE' ? 'PE' : 'neutral',
        reasoning:             newDecision.reasoning,
        risks:                 newDecision.risks,
        suggested_sl_points:   newDecision.sl_points,
        suggested_target_points: newDecision.target_points,
        suggested_max_hold_seconds: newDecision.max_hold_seconds,
        suggested_lots:        newDecision.lots_suggested,
        _raw:                  newDecision,
        _source:               newDecision._hybrid ? 'hybridEntryEngine' : 'entryEngine',
        // Surface hybrid metadata (snapshot used by monitor decay; details for analytics)
        hybridSnapshot:        newDecision.hybridSnapshot || null,
        hybridGrade:           newDecision.hybridSnapshot?.grade || null,
        hybridScore:           newDecision.hybridSnapshot?.score || null,
      };
      logger.info({ useNewEngines, signal: newDecision.signal, tradeType: newDecision.trade_type, confidence: newDecision.confidence }, '[engine] New entry engine decided');
    }
    // ─── LEGACY ENTRY PATH (disabled) ──────────────────────────────────────
    // Kept for reference / quick rollback. To restore, set useNewEngines = false
    // above and uncomment the else branch.
    //
    // else {
    //   institutionalEntryDecision = await institutionalAI.getEntryDecision({
    //     marketData:       payload,
    //     optionChain:      optionChainForAI,
    //     algorithmOutputs: algorithmOutputs,
    //     masterDecision:   masterDecision,
    //     tradeDecision:    tradeDecision,
    //     sessionSettings:  { ...settings, fiiDiiContext, fiiDiiSummary },
    //     openTrades:       currentOpenTrades,
    //     direction,
    //     aiModel:          state.session.aiModel,
    //   });
    // }

    await engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'institutional_ai_entry',
      level: institutionalEntryDecision.should_enter ? 'info' : 'warn',
      message: `Institutional AI: ${institutionalEntryDecision.signal} | Confidence: ${institutionalEntryDecision.confidence}/10 | Min target achievable: ${institutionalEntryDecision.min_target_achievable} | Expected: ${institutionalEntryDecision.expected_points} pts`,
      data: institutionalEntryDecision,
    });

    // ============================================================
    // HYBRID ENGINE IS AUTHORITATIVE — no override allowed
    // ============================================================
    // CALIBRATED 2026-05-18: removed the legacy LOCAL+GLOBAL OVERRIDE block.
    // The hybrid engine performs full institutional analysis (regime, OI,
    // gamma, MTF, trap detection, playbook routing). When it returns
    // NO_TRADE, that decision is final. The legacy override was forcing
    // trades against hybrid's NO_TRADE verdict based on simple "30m+15m+5m
    // bullish + above VWAP" rules — exactly the kind of naive logic the
    // hybrid engine was designed to replace.
    //
    // Live evidence (2026-05-18, session 6a0aaf37): hybrid said
    // "mean-revert bullish same direction as auction bullish trend —
    // failed fade risk" → override forced BUY_CE → trade lost ₹124.
    if (!institutionalEntryDecision.should_enter || !institutionalEntryDecision.min_target_achievable) {
      logger.info({
        shouldEnter:         institutionalEntryDecision.should_enter,
        minTargetAchievable: institutionalEntryDecision.min_target_achievable,
        confidence:          institutionalEntryDecision.confidence,
        reasoning:           institutionalEntryDecision.reasoning,
      }, '[engine] Hybrid engine returned NO_TRADE — respecting decision (no override)');
      return;
    }

    if (institutionalEntryDecision.confidence < (settings.minConfidence || 6)) {
      logger.warn({
        confidence: institutionalEntryDecision.confidence,
        required:   settings.minConfidence || 6,
      }, '[engine] Institutional AI confidence too low — skipping');
      return;
    }

    // Hard floor: never enter below confidence 6
    // Confidence 6 with min_target_achievable=true is a valid scalp entry
    const confFloor = institutionalEntryDecision.strike_selection_reason === 'global_bias_override' ? 6 : 6;
    if (institutionalEntryDecision.confidence < confFloor) {
      logger.warn({
        confidence: institutionalEntryDecision.confidence,
        confFloor,
      }, '[engine] Confidence below floor — skipping');
      return;
    }

    // Use AI's strike and option type
    selectedStrike  = institutionalEntryDecision.strike;
    optionType      = institutionalEntryDecision.signal === 'BUY_CE' ? 'CE' : 'PE';
    ensembleConfidence = institutionalEntryDecision.confidence;

    logger.info({
      selectedStrike,
      optionType,
      optionCategory:  institutionalEntryDecision.option_type,  // ATM/ITM/OTM
      confidence:      ensembleConfidence,
      expectedPoints:  institutionalEntryDecision.expected_points,
      breakoutProb:    institutionalEntryDecision.breakout_probability,
    }, '[engine] Institutional AI strike selection completed');

    await engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'ai_ensemble_strike',
      level: 'info',
      message: `AI Strike Selection: ${selectedStrike} ${optionType} (${institutionalEntryDecision.option_type}) | Confidence: ${ensembleConfidence} | Expected: ${institutionalEntryDecision.expected_points} pts`,
      data: institutionalEntryDecision,
    });

    // ============================================================
    // STEP 6: VALIDATE AND ENTER TRADE
    // ============================================================
    
    // Validate strike exists in option chain (AI picks from ±4, not just ±2)
    const marketSession = professionalTrader.getMarketSession();
    const validStrikes = professionalTrader.getValidStrikes(); // kept for fallback reference
    
    if (!selectedStrike || !optionChain?.strikes?.find(s => s.strike === selectedStrike)) {
      logger.error({ selectedStrike }, '[engine] AI selected strike not found in option chain, using ATM');
      selectedStrike = Math.round(spotPrice / 50) * 50;
      optionType = direction === 'bullish' ? 'CE' : 'PE';
    }

    // Confidence check — use the best available confidence (pro trader,
    // master algorithm, or AI ensemble) so a neutral pro trader doesn't
    // blackball the entry with confidence=0.
    const effectiveConfidence = Math.max(
      Number(tradeDecision.confidence) || 0,
      Number(masterDecision?.confidence) || 0,
      Number(aiEntryDecision?.confidence) || 0,
      Number(ensembleConfidence) || 0,
    );
    if (effectiveConfidence < settings.minConfidence) {
      logger.warn({
        proConfidence: tradeDecision.confidence,
        masterConfidence: masterDecision?.confidence,
        aiConfidence: aiEntryDecision?.confidence,
        ensembleConfidence,
        effectiveConfidence,
        required: settings.minConfidence
      }, '[engine] confidence too low for entry');
      return;
    }
    // Sync back so downstream logging uses the effective value.
    tradeDecision.confidence = effectiveConfidence;
    
    // OPTIMIZATION: Sentiment validation already done in parallel above
    // Apply sentiment-based adjustments
    if (sentimentValidation?.adjustments_needed?.includes('reduce_size')) {
      logger.info('[engine] Sentiment recommends reducing position size');
      // Reduce lot size by 50%
      settings.lotSize = Math.max(1, Math.floor(settings.lotSize * 0.5));
    }
    
    // Get strike data from option chain directly
    // Get strike data — use option chain if available, fall back to aggregator ATM data
    const strikeRow = optionChain?.strikes?.find(s => s.strike === selectedStrike);
    const isCE = optionType === 'CE';

    let premium, optionSymbol;
    let optionSecurityId = null; // for live-feed subscription

    if (strikeRow) {
      premium      = isCE ? strikeRow.call.ltp : strikeRow.put.ltp;
      optionSymbol = isCE ? strikeRow.call.displaySymbol : strikeRow.put.displaySymbol;
      optionSecurityId = isCE ? strikeRow.call.securityId : strikeRow.put.securityId;
    } else {
      // Option chain unavailable — use aggregator ATM data as fallback
      // This allows entries even when the option chain API fails
      const atmData = payload.options_chain;
      if (atmData) {
        premium      = isCE ? atmData.atm_call?.ltp : atmData.atm_put?.ltp;
        optionSymbol = isCE ? atmData.atm_call?.symbol : atmData.atm_put?.symbol;
        logger.warn({ selectedStrike, isCE, premium }, '[engine] Using aggregator ATM data as premium fallback (option chain unavailable)');
      }
    }

    if (!premium || premium <= 0) {
      logger.warn({ selectedStrike, isCE, hasOptionChain: !!optionChain }, '[engine] No premium available — skipping');
      return;
    }
    
    // ============================================================
    // MINIMUM PREMIUM CHECK - Avoid low-premium entries
    // CALIBRATED 2026-05-19: lowered fallback default from 80 to 30 so OTM
    // strikes with premium 33-79 (very common when spot is mid-range) can
    // enter. Live session 2026-05-19 had 6 valid LIGHT_TREND_DRIFT_SCALP
    // elite playbook firings blocked silently here despite confidence>=8.
    // ============================================================
    const minEntryPremium = Number(settings.minEntryPremium) || 30;
    if (premium < minEntryPremium) {
      logger.warn({
        premium,
        minEntryPremium,
        settingsValue: settings.minEntryPremium,
        selectedStrike,
        isCE
      }, '[engine] Premium too low — skipping entry (below minimum threshold)');
      // Also log to engine event stream so it shows up in the structured
      // session log (premium block is the most common silent skip).
      try {
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'engine_no_trade',
          level: 'warn',
          message: `Premium too low — skipping entry (premium=${premium} < min=${minEntryPremium})`,
          data: { premium, minEntryPremium, settingsValue: settings.minEntryPremium, selectedStrike, isCE },
        });
      } catch (_) {}
      return;
    }
    
    // Lot size — when running multi-symbol, use the lot size for the
    // ACTIVE symbol's contract spec (NIFTY=65, SENSEX=20). Fallback to
    // session settings.lotSize for legacy single-symbol sessions.
    let originalLotSize = Number(state.session.settings.lotSize) || 65;
    try {
      const symbolRegistry = require('../config/symbolRegistry');
      const active = symbolRegistry.getSymbol(state.activeSymbolKey || symbolRegistry.getActiveSymbol());
      if (Number.isFinite(active?.lotSize) && active.lotSize > 0) {
        originalLotSize = active.lotSize;
      }
    } catch (_) {}
    const minLots = Number(state.session.settings.minLots) || 1;
    const lots = minLots;
    const qty = lots * originalLotSize;
    const cost = premium * qty;

    // LOG: Show lot calculation details
    logger.info({
      originalLotSize,
      minLots,
      lots,
      qty,
      cost,
      premium,
      settingsMinLots: state.session.settings.minLots,
      settingsMaxLots: state.session.settings.maxLots,
      settingsLotSize: state.session.settings.lotSize
    }, '[engine] LOT CALCULATION - Entry quantity determined');

    if (cost > state.session.currentCapital * (settings.maxCapitalUsagePct / 100)) {
      logger.warn({ cost, capital: state.session.currentCapital }, '[engine] capital limit blocks trade');
      return;
    }

    // ============================================================
    // CALCULATE SL AND TARGET - SETTINGS-DRIVEN (POINTS-BASED)
    // Uses targetPoints and slPoints from settings
    // ============================================================
    // CALCULATE SL AND TARGET — DUAL TRADE TYPE SUPPORT
    // SCALP: tight target = settings.targetPoints, tight SL
    // SWING: wider target = AI's expected_points, wider SL
    // Trade type is determined by AI's expected_points vs targetPoints
    // ============================================================
    let slPremium, targetPremium;
    
    const targetPoints = Number(settings.targetPoints) || Number(settings.minPointsRequired) || 5;
    const slPoints     = Number(settings.slPoints)     || (targetPoints * 2);
    
    // Determine trade type from AI's expected points
    const aiExpectedPoints = Number(institutionalEntryDecision.expected_points) || targetPoints;
    // AI returns trade_type (snake_case) — use it directly, fall back to computed value
    const aiTradeType = institutionalEntryDecision.trade_type || institutionalEntryDecision.tradeType;
    const isSwingTrade = aiTradeType === 'SWING' || aiExpectedPoints >= targetPoints * 3;
    const tradeType = isSwingTrade ? 'SWING' : 'SCALP';
    
    if (isSwingTrade) {
      // SWING: use AI's expected points as target, SL = 2× scalp SL (wider)
      targetPremium = premium + aiExpectedPoints;
      slPremium     = premium - Math.round(slPoints * 2);
    } else {
      // SCALP: use settings targetPoints, standard SL
      targetPremium = premium + targetPoints;
      slPremium     = premium - slPoints;
    }
    
    // SL floor: never below 40% of premium
    slPremium = Math.max(slPremium, premium * 0.4);
    
    logger.info({
      premium, targetPoints, slPoints, aiExpectedPoints,
      tradeType, targetPremium, slPremium,
    }, `[engine] SL/Target calculated — ${tradeType} trade`);

    // ============================================================
    // STEP 6.5: POINTS SUFFICIENCY — TRUST THE AI, NOT A CIRCULAR CHECK
    // The old check was: netPoints = targetPoints - brokerage >= targetPoints
    // That is mathematically impossible (always fails by ~0.83 pts).
    // The institutional AI already confirmed min_target_achievable = true.
    // We only do a sanity check: premium must be > 0 and > brokerage cost.
    // ============================================================
    if (settings.targetPoints && settings.targetPoints > 0) {
      const estimatedBrokerage = brokerageCalculator.calculateBrokerage(
        premium, premium + targetPoints, qty, isCE ? 'BUY_CE' : 'BUY_PE'
      );
      const brokeragePerPoint = estimatedBrokerage.costPerPoint || 0;
      
      // Only block if brokerage alone exceeds the entire target (premium too cheap)
      if (brokeragePerPoint >= targetPoints) {
        logger.warn({
          brokeragePerPoint: brokeragePerPoint.toFixed(2),
          targetPoints,
          premium,
        }, '[engine] Premium too cheap — brokerage exceeds target, skipping');
        return;
      }
      
      logger.info({
        premium,
        targetPoints,
        brokeragePerPoint: brokeragePerPoint.toFixed(2),
        netAfterBrokerage: (targetPoints - brokeragePerPoint).toFixed(2),
        aiExpectedPoints: institutionalEntryDecision.expected_points,
        tradeType: institutionalEntryDecision.trade_type || 'scalp',
      }, '[engine] ✅ Points check passed — AI confirmed target achievable');
    }

    const trade = await ScalpingTrade.create({
      sessionId: state.session._id,
      signal: isCE ? 'BUY_CE' : 'BUY_PE',
      strike: selectedStrike,
      optionSymbol: optionSymbol,
      expiry,
      lotSize: originalLotSize,  // FIXED: Use original lotSize (65), not modified settings.lotSize
      quantity: qty,
      entryPrice: premium,
      currentPrice: premium,
      sl: Number(slPremium.toFixed(2)),
      target: Number(targetPremium.toFixed(2)),
      aiConfidence: masterDecision.confidence,
      entryReason: `[${tradeType}] InstitutionalAI: ${institutionalEntryDecision.reasoning?.slice(0,100)} | Master: ${masterDecision.master_score}/100 | Conf: ${ensembleConfidence} | Expected: ${aiExpectedPoints}pts`,
      marketRegime: tradeDecision.market_character,
      buildUpType: payload.futures_data?.build_up_type,
      vwapState: payload.vwap_analysis?.price_vs_vwap,
      oiDirection: direction,
      spotPriceAtEntry: spotPrice,
      strikeSelectionRationale: `InstitutionalAI: Master ${masterDecision.master_score}, Conf ${ensembleConfidence}, Strike ${selectedStrike} ${institutionalEntryDecision.option_type}, Expected ${aiExpectedPoints}pts [${tradeType}]`,
      strikeSelectionConfidence: ensembleConfidence,
      alternativeStrike: marketSession.openingStrike,
      expectedHoldDuration: isSwingTrade ? '3-15min' : '30-120sec',
      tradeType: tradeType,
      // ── ENGINE & MARKET (NEW 2026-05-19) ──
      engineType: institutionalEntryDecision.engineType || 'CORE',
      market:     institutionalEntryDecision.market
                  || state.activeSymbolKey
                  || state.session?.settings?.tradingSymbols?.[0]
                  || 'NIFTY_50',
      // Per-trade AI overrides — consumed by monitor engine
      maxHoldSeconds: Number(institutionalEntryDecision.suggested_max_hold_seconds)
        || (isSwingTrade ? (state.session.settings?.swingMaxHoldMinutes || 15) * 60 : state.session.settings?.maxHoldTimeSeconds || 180),
      aiEntryDecision: institutionalEntryDecision,
      // Hybrid entry snapshot — used by hybrid monitor for decay analysis.
      // Only present when entry came from the deterministic hybrid engine.
      hybridEntrySnapshot: institutionalEntryDecision.hybridSnapshot || null,
      hasReachedTarget: false,
      maxPriceReached: premium,
      // Futures confirmation data
      futuresConfirmed: futuresConfirmation?.confirmed || false,
      futuresDirection: futuresConfirmation?.futuresDirection || 'unknown',
      futuresPremium: futuresConfirmation?.premium || 0,
      // Live feed connection data
      optionSecurityId: optionSecurityId || null,
      liveFeedConnected: false,
      lastPriceUpdate: new Date(),
      priceUpdateSource: 'entry',
      // Brokerage data (will be calculated on exit)
      brokerageEnabled: settings.enableBrokerageCalculation || false,
      aiSnapshots: [
        { 
          at: new Date(), 
          confidence: masterDecision.confidence, 
          action: 'ENTER', 
          rationale: masterDecision.reasoning 
        },
      ],
    });

    state.cooldownUntil = Date.now() + (settings.cooldownSec || 60) * 1000;

    // LIVE FEED: subscribe to this option's security ID so monitor can read
    // millisecond-fresh LTP/OI from the WebSocket snapshot.
    try {
      if (optionSecurityId) {
        const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');
        const optionSegment = _optionSegmentForActive();
        liveFeedProd.subscribe(
          [{ exchangeSegment: optionSegment, securityId: optionSecurityId }],
          'FULL'
        );
        
        // Mark trade as connected to live feed
        trade.liveFeedConnected = true;
        trade.lastPriceUpdate = new Date();
        trade.priceUpdateSource = 'live_feed_subscribed';
        await trade.save();
        
        logger.info({ 
          optionSecurityId, 
          optionSymbol, 
          tradeId: trade._id,
          strike: selectedStrike,
          signal: trade.signal
        }, '[engine] ✅ Subscribed option to live feed — real-time prices active');
        
        // Emit immediate WebSocket update with live feed connection status
        scalpingSocket.emitTradeUpdated(trade, state.session._id, 'live_feed_connected');
      } else {
        logger.warn({ 
          tradeId: trade._id, 
          strike: selectedStrike,
          optionSymbol 
        }, '[engine] ⚠️ Option securityId unknown — live feed will fall back to polling');
      }
    } catch (e) {
      logger.warn({ err: e.message, tradeId: trade._id }, '[engine] Live feed subscribe failed (non-fatal)');
    }

    logger.info({ 
      tradeId: trade._id, 
      signal: trade.signal, 
      strike: trade.strike,
      premium,
      masterScore: masterDecision.master_score,
      aiConfidence: ensembleConfidence,
      expectedPoints: institutionalEntryDecision.expected_points,
      minTarget: settings.targetPoints || 5,
      optionCategory: institutionalEntryDecision.option_type,
    }, '[engine] 🚀 INSTITUTIONAL AI TRADE OPENED');
    
    // Emit WebSocket event for real-time updates
    scalpingSocket.emitTradeCreated(trade, state.session._id);
    
    // Log trade opened
    await engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'trade_opened',
      level: 'info',
      message: `🚀 Institutional AI Trade: ${trade.signal} @ ${trade.strike} (${institutionalEntryDecision.option_type}) for ₹${premium} | Expected: ${institutionalEntryDecision.expected_points}pts | Min target: ${settings.targetPoints || 5}pts`,
      tradeId: trade._id,
      data: {
        signal: trade.signal,
        strike: trade.strike,
        openingStrike: marketSession.openingStrike,
        entryPrice: premium,
        quantity: qty,
        sl: trade.sl,
        target: trade.target,
        masterScore: masterDecision.master_score,
        masterConfidence: masterDecision.confidence,
        agreementCount: masterDecision.agreement_count,
        aiConfidence: ensembleConfidence,
        expectedPoints: institutionalEntryDecision.expected_points,
        minTargetPoints: settings.targetPoints || 5,
        optionCategory: institutionalEntryDecision.option_type,
        breakoutProbability: institutionalEntryDecision.breakout_probability,
        aiReasoning: institutionalEntryDecision.reasoning,
        algorithms: {
          gamma: algorithmOutputs.gammaExposure ? 'active' : 'inactive',
          orderFlow: algorithmOutputs.orderFlow ? 'active' : 'inactive',
          multiTimeframe: algorithmOutputs.multiTimeframe ? 'active' : 'inactive',
          liquidity: algorithmOutputs.liquidityAnalysis ? 'active' : 'inactive',
          smc: algorithmOutputs.smartMoneyConcepts ? 'active' : 'inactive',
          marketInternals: algorithmOutputs.marketInternals ? 'active' : 'inactive',
          sectorRotation: algorithmOutputs.sectorRotation ? 'active' : 'inactive',
          globalMarkets: algorithmOutputs.globalMarkets ? 'active' : 'inactive',
          behavioral: algorithmOutputs.behavioral ? 'active' : 'inactive'
        },
        liquidityHealth: algorithmOutputs.liquidityAnalysis?.liquidity_health || 'unknown',
        liquidityScore: algorithmOutputs.liquidityAnalysis?.liquidity_score || 0,
        smcBias: algorithmOutputs.smartMoneyConcepts?.smc_bias || 'unknown',
        smcScore: algorithmOutputs.smartMoneyConcepts?.smc_score || 0,
        marketInternalsScore: algorithmOutputs.marketInternals?.market_internals_score || 0,
        sectorRotationScore: algorithmOutputs.sectorRotation?.sector_rotation_score || 0,
        globalMarketsScore: algorithmOutputs.globalMarkets?.global_score || 0,
        globalRiskSentiment: algorithmOutputs.globalMarkets?.risk_sentiment?.sentiment || 'unknown',
        behavioralScore: algorithmOutputs.behavioral?.behavioral_score || 0,
        behavioralBias: algorithmOutputs.behavioral?.behavioral_bias || 'unknown'
      },
    });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, '[engine] prediction cycle failed');
    if (state.session) {
      state.session.lastError = e.message;
      await state.session.save();
    }
  } finally {
    // Emit cycle completed so the frontend cycle counter updates in real-time.
    if (state.session) {
      scalpingSocket.emitCycleCompleted(
        String(state.session._id),
        state.session.cycleCount,
        'prediction'
      );
    }
    state.busy = false;
  }
}

async function runMonitorCycle() {
  if (!state.session) return;
  try {
    const open = await ScalpingTrade.find({ sessionId: state.session._id, status: 'open' });
    if (!open.length) return;

    const market = isMarketOpen();
    if (!market.open) {
      for (const t of open) await closeTrade(t, t.currentPrice || t.entryPrice, 'Market closed');
      await stop({ reason: 'Market closed' });
      return;
    }

    // ── Partition open trades by market ───────────────────────────────
    // Each symbol's open trades are evaluated against THAT symbol's
    // aggregator + algorithm cache. We loop symbol-by-symbol, set the
    // active slot, and call the per-market monitor sub-cycle.
    const tradesByMarket = new Map();
    for (const t of open) {
      const key = t.market || 'NIFTY_50';
      if (!tradesByMarket.has(key)) tradesByMarket.set(key, []);
      tradesByMarket.get(key).push(t);
    }
    _ensureSymbolSlots([...tradesByMarket.keys()]);

    for (const [marketKey, marketTrades] of tradesByMarket.entries()) {
      _useSymbolSlot(marketKey);
      try {
        await _runMonitorCycleForActiveSymbol(marketTrades);
      } catch (e) {
        logger.error({ err: e.message, market: marketKey }, '[engine] monitor cycle error for market');
      }
    }
    _flushAliasToSlot();
  } catch (e) {
    logger.error({ err: e.message }, '[engine] runMonitorCycle outer error');
  }
}

async function _runMonitorCycleForActiveSymbol(open) {
  if (!state.session || !open.length) return;
  try {
    const { payload, atmCallLtp, atmPutLtp } = await aggregator.buildPayload(state.authKey);

    // ============================================================
    // SEPARATE TRADE MONITORING SERVICE (with all algorithms)
    // ============================================================
    logger.info({
      market: state.activeSymbolKey,
      openTradesCount: open.length,
    }, '[engine] Delegating to Trade Monitor Service');

    // Fetch option chain for the ACTIVE symbol's expiry to get actual LTP
    // for each trade's specific strike.
    let optionChainForMonitor = null;
    try {
      const symbolRegistry = require('../config/symbolRegistry');
      const active = symbolRegistry.getSymbol(state.activeSymbolKey);
      const expiries = await dhanProd.getExpiryListBypass(state.authKey, {
        securityId: active.indexSecurityId,
        underlyingSeg: active.indexSegment,
      });
      const nearestExpiry = expiries?.data?.expiries?.[0];
      if (nearestExpiry) {
        const ocRes = await dhanProd.getOptionChainBypass(state.authKey, {
          segment: 0,
          expiry: nearestExpiry.exp,
          securityId: active.indexSecurityId,
          underlyingSeg: active.indexSegment,
        });
        if (ocRes.ok) optionChainForMonitor = ocRes.data;
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[engine] Failed to fetch option chain for monitor, using ATM fallback');
    }

    for (const trade of open) {
      // Update current price — use the ACTUAL strike's LTP, not ATM
      const isCE = trade.signal === 'BUY_CE';
      let ltp = null;
      let ltpSource = null;

      // PRIORITY 1: Live WebSocket feed (millisecond latency) using stored securityId
      // This is the fastest path — direct lookup by the securityId we stored at entry
      if (trade.optionSecurityId) {
        try {
          const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');
          const tick = liveFeedProd.getTick(_optionSegmentForTrade(trade), trade.optionSecurityId);
          if (tick && typeof tick.ltp === 'number' && tick.ltp > 0 && tick.updatedAt && Date.now() - tick.updatedAt < 5000) {
            ltp = tick.ltp;
            ltpSource = 'live_feed_direct';
            logger.debug({ 
              tradeId: trade._id, 
              optionSecurityId: trade.optionSecurityId,
              ltp,
              tickAge: Date.now() - tick.updatedAt
            }, '[engine] Monitor: using direct live feed (fastest path)');
          }
        } catch (err) {
          logger.warn({ 
            err: err.message, 
            tradeId: trade._id 
          }, '[engine] Monitor: live feed direct lookup failed');
        }
      }

      // PRIORITY 2: option chain snapshot we just fetched (fallback if live feed unavailable)
      if (!ltp && optionChainForMonitor?.strikes) {
        const strikeRow = optionChainForMonitor.strikes.find(s => s.strike === trade.strike);
        if (strikeRow) {
          ltp = isCE ? strikeRow.call?.ltp : strikeRow.put?.ltp;
          ltpSource = 'option_chain';
          logger.debug({
            tradeId: trade._id,
            strike: trade.strike,
            signal: trade.signal,
            strikeLtp: ltp,
          }, '[engine] Monitor: using option chain LTP (fallback)');
        }
      }

      // PRIORITY 3: Keep last known price if no fresh data available
      // CRITICAL: Do NOT use ATM fallback for SL/target checks — it's a
      // different option entirely and will cause false triggers.
      // Only update price if we have the EXACT strike's LTP.
      if (!ltp || ltp <= 0) {
        logger.warn({
          tradeId: trade._id,
          strike: trade.strike,
          signal: trade.signal,
          lastKnownPrice: trade.currentPrice,
          hasSecurityId: !!trade.optionSecurityId,
          reason: 'No fresh price data available — keeping last known price'
        }, '[engine] Monitor: skipping price update (no exact strike data)');
        // Don't update trade.currentPrice — keep last known good value
        // Still run the monitor for time-based exits
        ltp = trade.currentPrice; // Use last known for monitor decision
        ltpSource = 'last_known';
      }

      if (ltp && ltp > 0 && ltpSource !== 'last_known') {
        trade.currentPrice = ltp;
        trade.monitorTicks += 1;
        trade.lastPriceUpdate = new Date();
        trade.priceUpdateSource = ltpSource;
        
        if (ltpSource === 'live_feed_direct') {
          logger.debug({ 
            tradeId: trade._id, 
            ltp, 
            source: ltpSource,
            pnlPoints: (ltp - trade.entryPrice).toFixed(2)
          }, '[engine] Monitor: using direct live WS tick (optimal)');
        }

        // Track max price reached + target-hit flag so monitor engine can apply
        // the "target reached then fell back" exit rule.
        if (!trade.maxPriceReached || ltp > trade.maxPriceReached) {
          trade.maxPriceReached = ltp;
        }
        const minTargetPrice = trade.entryPrice + (state.session.settings?.targetPoints || 5);
        if (!trade.hasReachedTarget && ltp >= minTargetPrice) {
          trade.hasReachedTarget = true;
          logger.info({ tradeId: trade._id, ltp, minTargetPrice }, '[engine] Min target reached — switching to "protect profit" mode');
        }

        // Emit price update via WebSocket
        scalpingSocket.emitTradeUpdated(trade, state.session._id, 'price');
      }
      
      // ============================================================
      // ATTACH SESSION SETTINGS TO TRADE FOR MONITOR
      // This allows trade monitor to make settings-driven decisions
      // ============================================================
      trade.sessionSettings = state.session.settings;
      
      // ============================================================
      // MONITOR — always use the new centralised engine.
      // Legacy path (tradeMonitor.monitorTrade) is commented out below.
      // ============================================================
      const useNewEnginesMon = true;

      let monitorDecision;
      if (useNewEnginesMon) {
        const decision = await monitorEngine.decide({
          trade,
          aggregator: { payload, optionChain: optionChainForMonitor },
          algorithmOutputs: state.lastAlgorithmOutputs || null, // Use stored from last prediction cycle
          masterDecision: state.lastMasterDecision || null, // Use stored from last prediction cycle
          settings: state.session.settings,
          allOpenTrades: open, // Pass all open trades for position correlation analysis
          futuresData: state.lastFuturesData || null, // Use stored from last prediction cycle
        });
        // Translate to the legacy shape the rest of this block expects
        monitorDecision = {
          action: decision.action,
          confidence: decision.confidence,
          rationale: decision.reasoning,
          exit_type: decision.action === 'EXIT' ? (decision.exit_urgency === 'immediate' ? 'hard_stop' : 'soft') : null,
          new_sl: decision.new_sl,
          add_lots: decision.add_lots,
          source: decision.source || 'monitorEngine',
        };
      }
      // ─── LEGACY MONITOR PATH (disabled) ─────────────────────────────────
      // Kept for reference / quick rollback. To restore, set useNewEnginesMon = false
      // above and uncomment the else branch.
      //
      // else {
      //   monitorDecision = await tradeMonitor.monitorTrade(
      //     trade,
      //     state.authKey,
      //     payload,
      //     state.session.aiModel,
      //     state.session.settings
      //   );
      // }
      
      logger.info({
        tradeId: trade._id,
        action: monitorDecision.action,
        confidence: monitorDecision.confidence,
        exitType: monitorDecision.exit_type
      }, '[engine] Trade monitor decision received');
      
      // Log monitor decision
      trade.aiSnapshots.push({
        at: new Date(),
        confidence: monitorDecision.confidence,
        action: monitorDecision.action,
        rationale: monitorDecision.rationale,
      });
      
      // ============================================================
      // ACT ON MONITOR DECISION
      // ============================================================
      
      // EXIT - Close the trade
      if (monitorDecision.action === 'EXIT') {
        await closeTrade(
          trade,
          trade.currentPrice,
          monitorDecision.rationale
        );
        
        // Emit WebSocket event
        scalpingSocket.emitTradeClosed(trade, state.session._id);
        
        await engineLogger.logEvent({
          sessionId: state.session._id,
          eventType: 'trade_monitor_exit',
          level: 'info',
          message: `Monitor Exit: ${monitorDecision.exit_type} - ${monitorDecision.rationale}`,
          tradeId: trade._id,
          data: {
            exitType: monitorDecision.exit_type,
            masterScore: monitorDecision.master_score,
            aiVotes: monitorDecision.ai_votes,
            confidence: monitorDecision.confidence,
          },
        });
        
        continue;
      }
      
      // TRAIL_SL - Update stop loss
      if (monitorDecision.action === 'TRAIL_SL' && monitorDecision.new_sl) {
        const newSl = Number(monitorDecision.new_sl.toFixed(2));
        if (newSl > (trade.sl || 0)) {
          trade.sl = newSl;
          logger.info({ 
            tradeId: trade._id, 
            newSl, 
            rationale: monitorDecision.rationale 
          }, '[engine] Trailing SL activated by monitor');
          
          // Emit WebSocket event
          scalpingSocket.emitTradeUpdated(trade, state.session._id, 'sl');
          
          await engineLogger.logEvent({
            sessionId: state.session._id,
            eventType: 'trailing_sl_activated',
            level: 'info',
            message: `Monitor Trailing SL: ${newSl}`,
            tradeId: trade._id,
            data: {
              oldSl: trade.sl,
              newSl,
              currentPrice: trade.currentPrice,
              rationale: monitorDecision.rationale,
            },
          });
        }
        // Partial-exit marker (institutional spec — capture +1R partial-booking
        // event so the adaptiveExitEngine doesn't refire on subsequent cycles).
        // The actual order placement for partial booking is intentionally
        // deferred (avoiding multi-leg order complexity); we record the marker
        // and lock breakeven via the SL update above.
        if (monitorDecision.partialExitPct && !trade.partialBooked) {
          trade.partialBooked = true;
          trade.partialBookedAt = new Date();
          trade.partialBookedPrice = trade.currentPrice;
          trade.partialBookedPct = monitorDecision.partialExitPct;
          trade.breakevenSet = true;
          trade.breakevenSetAt = new Date();
          logger.info({
            tradeId: trade._id,
            partialPct: monitorDecision.partialExitPct,
            entryPrice: trade.entryPrice,
            currentPrice: trade.currentPrice,
          }, '[engine] +1R partial-booking marker recorded (breakeven locked via TRAIL_SL above)');

          await engineLogger.logEvent({
            sessionId: state.session._id,
            eventType: 'partial_booked_marker',
            level: 'info',
            message: `+1R partial-book marker (${(monitorDecision.partialExitPct * 100).toFixed(0)}% target booked); breakeven SL locked`,
            tradeId: trade._id,
            data: {
              partialPct: monitorDecision.partialExitPct,
              entryPrice: trade.entryPrice,
              currentPrice: trade.currentPrice,
              newSl: trade.sl,
            },
          });
        }
      }
      
      // ADD_QUANTITY - Add to winning position (if strong signal)
      // Respects maxLots setting — won't exceed the configured maximum.
      if (monitorDecision.action === 'ADD_QUANTITY' && monitorDecision.add_quantity) {
        const lotSize = state.session.settings.lotSize || 65;
        const maxLots = Number(state.session.settings.maxLots) || 3;
        const maxQty = maxLots * lotSize;
        const currentLots = Math.round(trade.quantity / lotSize);

        // Add 1 lot at a time (not arbitrary qty from AI)
        const additionalQty = lotSize;
        const additionalCost = trade.currentPrice * additionalQty;

        // Check: haven't exceeded maxLots AND have capital
        if (trade.quantity + additionalQty <= maxQty &&
            additionalCost <= state.session.currentCapital * 0.1) {
          trade.quantity += additionalQty;
          logger.info({
            tradeId: trade._id,
            additionalQty,
            newTotalQty: trade.quantity,
            currentLots: currentLots + 1,
            maxLots,
            rationale: monitorDecision.rationale
          }, '[engine] Added 1 lot to winning position');

          // Emit WebSocket event
          scalpingSocket.emitTradeUpdated(trade, state.session._id, 'quantity');

          await engineLogger.logEvent({
            sessionId: state.session._id,
            eventType: 'quantity_added',
            level: 'info',
            message: `Monitor Added 1 Lot: +${additionalQty} qty (Total: ${trade.quantity}, ${currentLots + 1}/${maxLots} lots)`,
            tradeId: trade._id,
            data: {
              additionalQty,
              newTotalQty: trade.quantity,
              currentLots: currentLots + 1,
              maxLots,
              additionalCost,
              rationale: monitorDecision.rationale,
            },
          });
        } else {
          logger.info({
            tradeId: trade._id,
            currentQty: trade.quantity,
            maxQty,
            reason: trade.quantity + additionalQty > maxQty ? 'maxLots reached' : 'capital limit'
          }, '[engine] Cannot add more lots');
        }
      }
      
      // HOLD - Continue monitoring
      if (monitorDecision.action === 'HOLD') {
        logger.info({ 
          tradeId: trade._id,
          masterScore: monitorDecision.master_score,
          aiVotes: monitorDecision.ai_votes
        }, '[engine] Monitor holding position');
      }
      
      await trade.save();
    }
  } catch (e) {
    logger.error({ err: e.message }, '[engine] monitor cycle failed');
  }
}

/**
 * Real-time price update cycle
 * Runs every 3 seconds to update trade prices from live feed
 * Separate from monitor cycle to provide smooth UI updates
 * Also performs FAST exit checks (hard SL, hard target) without AI
 */
async function runPriceUpdateCycle() {
  if (!state.session) return;
  
  try {
    const open = await ScalpingTrade.find({ 
      sessionId: state.session._id, 
      status: 'open' 
    });
    
    if (!open.length) return;

    const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');
    let pricesUpdated = 0;

    for (const trade of open) {
      // Skip if no security ID stored
      if (!trade.optionSecurityId) continue;

      try {
        // Get live tick from WebSocket feed
        const tick = liveFeedProd.getTick(_optionSegmentForTrade(trade), trade.optionSecurityId);
        
        // Validate tick is fresh (< 5 seconds old) and has valid LTP
        if (tick && 
            typeof tick.ltp === 'number' && 
            tick.ltp > 0 && 
            tick.updatedAt && 
            Date.now() - tick.updatedAt < 5000) {
          
          // Update trade price
          const oldPrice = trade.currentPrice;
          trade.currentPrice = tick.ltp;
          trade.lastPriceUpdate = new Date();
          trade.priceUpdateSource = 'live_feed';
          
          // Track max price reached
          if (!trade.maxPriceReached || tick.ltp > trade.maxPriceReached) {
            trade.maxPriceReached = tick.ltp;
          }
          
          // Check if target reached
          const minTargetPrice = trade.entryPrice + (state.session.settings?.targetPoints || 5);
          if (!trade.hasReachedTarget && tick.ltp >= minTargetPrice) {
            trade.hasReachedTarget = true;
            logger.info({ 
              tradeId: trade._id, 
              ltp: tick.ltp, 
              minTargetPrice 
            }, '[priceUpdate] Target reached — switching to protect profit mode');
          }
          
          // ============================================================
          // FAST EXIT CHECKS (No AI, immediate action)
          // These run every 3 seconds for instant protection
          // ============================================================
          const pnlPoints = tick.ltp - trade.entryPrice;
          const settings = state.session.settings || {};
          
          // HARD STOP LOSS - Immediate exit if hit
          if (trade.sl && tick.ltp <= trade.sl) {
            logger.warn({ 
              tradeId: trade._id, 
              ltp: tick.ltp, 
              sl: trade.sl,
              pnlPoints: pnlPoints.toFixed(2)
            }, '[priceUpdate] ⚠️ HARD SL HIT — Immediate exit');
            
            await closeTrade(trade, tick.ltp, `Hard SL hit @ ₹${tick.ltp} (SL: ₹${trade.sl})`);
            continue; // Skip to next trade
          }
          
          // HARD TARGET - Immediate exit if hit (optional, configurable)
          const hardTargetEnabled = settings.enableHardTarget !== false; // Default true
          if (hardTargetEnabled && trade.target && tick.ltp >= trade.target) {
            logger.info({ 
              tradeId: trade._id, 
              ltp: tick.ltp, 
              target: trade.target,
              pnlPoints: pnlPoints.toFixed(2)
            }, '[priceUpdate] ✅ HARD TARGET HIT — Immediate exit');
            
            await closeTrade(trade, tick.ltp, `Hard target hit @ ₹${tick.ltp} (Target: ₹${trade.target})`);
            continue; // Skip to next trade
          }
          
          await trade.save();
          pricesUpdated++;
          
          // Emit WebSocket update for UI
          scalpingSocket.emitTradeUpdated(trade, state.session._id, 'price');
          
          // Log significant price changes (> 2 points)
          const priceChange = Math.abs(tick.ltp - oldPrice);
          if (priceChange > 2) {
            logger.debug({ 
              tradeId: trade._id,
              oldPrice,
              newPrice: tick.ltp,
              change: priceChange.toFixed(2),
              pnlPoints: pnlPoints.toFixed(2)
            }, '[priceUpdate] Significant price movement');
          }
        }
      } catch (err) {
        logger.warn({ 
          err: err.message, 
          tradeId: trade._id,
          optionSecurityId: trade.optionSecurityId 
        }, '[priceUpdate] Failed to update price for trade');
      }
    }
    
    if (pricesUpdated > 0) {
      logger.debug({ 
        pricesUpdated, 
        totalOpen: open.length 
      }, '[priceUpdate] Real-time prices updated');
    }
  } catch (e) {
    logger.error({ err: e.message }, '[priceUpdate] Price update cycle failed');
  }
}

async function closeTrade(trade, exitPrice, reason) {
  trade.exitPrice = exitPrice;
  trade.status = 'closed';
  trade.closedAt = new Date();
  trade.exitReason = reason;
  
  // Calculate gross P&L
  const grossPnl = (exitPrice - trade.entryPrice) * trade.quantity;
  
  // ── ALWAYS apply flat ₹40 brokerage (Dhan NIFTY options round-trip) ─────────
  // brokerageEnabled flag only controls whether net or gross is used for
  // capital tracking — brokerage is always real and always ₹40.
  const brokerageData = brokerageCalculator.calculateBrokerage(
    trade.entryPrice,
    exitPrice,
    trade.quantity,
    trade.signal
  );
  // Force flat ₹40 regardless of what the calculator returns
  brokerageData.totalCharges = 40;
  brokerageData.brokerage    = 40;

  const netPnl = grossPnl - 40;
  
  // Store brokerage data on the trade record always
  trade.grossPnL = Number(grossPnl.toFixed(2));
  trade.brokerageCharges = brokerageData.totalCharges;
  trade.brokerageBreakdown = {
    brokerage: brokerageData.brokerage,
    stt: brokerageData.stt,
    exchangeCharges: brokerageData.exchangeCharges,
    gst: brokerageData.gst,
    sebiCharges: brokerageData.sebiCharges,
    stampDuty: brokerageData.stampDuty,
  };
  
  // pnl field: use net (after brokerage) if flag enabled, else gross
  // Either way, brokerageCharges is always stored for display
  const pnlForCapital = trade.brokerageEnabled ? netPnl : grossPnl;
  
  trade.pnl = Number(pnlForCapital.toFixed(2));
  trade.pnlPct = Number((((exitPrice - trade.entryPrice) / trade.entryPrice) * 100).toFixed(2));
  trade.result = pnlForCapital > 0 ? 'WIN' : pnlForCapital < 0 ? 'LOSS' : 'BREAKEVEN';
  await trade.save();

  // LIVE FEED: unsubscribe this option — no need to keep receiving ticks for a closed trade
  try {
    const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');
    // We don't store the raw security id on the trade — best-effort unsubscribe by looking
    // at the last tick keyed on symbol. If another open trade is on the same strike we
    // simply leave the subscription; the feed deduplicates by (segment,id).
    if (trade.optionSymbol) {
      logger.debug({ tradeId: trade._id, symbol: trade.optionSymbol }, '[engine] Live feed kept — will be pruned on session stop');
    }
  } catch (_) {}

  if (state.session) {
    state.session.realizedPnL += pnlForCapital;
    state.session.currentCapital += pnlForCapital;
    // Always accumulate brokerage charges on session for top-bar display
    state.session.totalBrokerageCharges = (state.session.totalBrokerageCharges || 0) + brokerageData.totalCharges;
    state.session.totalTrades += 1;
    if (trade.result === 'WIN') state.session.wins += 1;
    if (trade.result === 'LOSS') state.session.losses += 1;
    await state.session.save();
    
    // Emit session update so top bar refreshes immediately after trade close
    scalpingSocket.emitSessionUpdate(state.session, true, 0);
  }

  logger.info({ 
    tradeId: trade._id, 
    grossPnL: grossPnl,
    brokerageCharges: brokerageData.totalCharges,
    netPnL: netPnl,
    pnlForCapital,
    reason 
  }, '[engine] trade closed');
  
  // Log trade closed
  if (state.session) {
    await engineLogger.logEvent({
      sessionId: state.session._id,
      eventType: 'trade_closed',
      level: 'info',
      message: `Trade closed: ${trade.result} with Gross ₹${grossPnl.toFixed(2)}, Brokerage ₹${brokerageData.totalCharges.toFixed(2)}, Net ₹${netPnl.toFixed(2)}`,
      tradeId: trade._id,
      data: {
        signal: trade.signal,
        strike: trade.strike,
        entryPrice: trade.entryPrice,
        exitPrice,
        grossPnL: grossPnl,
        brokerageCharges: brokerageData.totalCharges,
        netPnL: netPnl,
        pnlForCapital,
        pnlPct: trade.pnlPct,
        result: trade.result,
        reason,
      },
    });
  }
}

async function manualExit(tradeId) {
  const trade = await ScalpingTrade.findById(tradeId);
  if (!trade || trade.status !== 'open') throw new Error('Trade not open');
  await closeTrade(trade, trade.currentPrice || trade.entryPrice, 'Manual exit');
  return trade;
}

// ════════════════════════════════════════════════════════════════════
// Fast-path trade execution helper for ULTRA / SUPPORT scalp engines.
// ════════════════════════════════════════════════════════════════════
// Called from runPredictionCycle when _ultraOnly && entryEngine fires.
// Self-contained — does NOT depend on the legacy 17-algorithm pipeline
// locals (masterDecision, tradeDecision, marketSession, etc.). Reads
// everything it needs from the passed-in `decision` and `payload`.
//
// Creates the trade record, subscribes the option to the live feed,
// emits the WebSocket event, and updates the cooldown.
async function _executeFastPathTrade({
  decision, payload, atmCallLtp, atmPutLtp,
  atmCallSymbol, atmPutSymbol, expiry, settings,
}) {
  const isCE = decision.option_type === 'CE';
  const direction = decision.direction;
  const selectedStrike = decision.strike;
  const tradeType = decision.trade_type || 'SCALP';
  const isSwingTrade = tradeType === 'SWING';
  const spotPrice = payload?.spot_data?.ltp || payload?.actual_spot_price || 0;

  // Resolve premium + symbol from the chain in payload
  const optionChain = payload?.options_chain || null;
  const strikeRow = optionChain?.strikes?.find(s => s.strike === selectedStrike);
  let premium      = decision.entry_premium_estimate || 0;
  let optionSymbol = isCE ? atmCallSymbol : atmPutSymbol;
  let optionSecurityId = null;
  if (strikeRow) {
    premium      = isCE ? strikeRow.call?.ltp : strikeRow.put?.ltp;
    optionSymbol = isCE ? strikeRow.call?.displaySymbol : strikeRow.put?.displaySymbol;
    optionSecurityId = isCE ? strikeRow.call?.securityId : strikeRow.put?.securityId;
  } else if (selectedStrike === payload?.actual_atm_strike || selectedStrike === payload?.options_chain?.atm_strike) {
    premium      = isCE ? atmCallLtp : atmPutLtp;
    optionSymbol = isCE ? atmCallSymbol : atmPutSymbol;
  }
  if (!premium || premium < (settings.minEntryPremium || 50)) {
    logger.warn({ premium, minEntryPremium: settings.minEntryPremium },
      '[engine] fast-path: premium too low, skipping entry');
    return;
  }

  // Lot size from the active symbol (NIFTY=65, SENSEX=20)
  let originalLotSize = Number(settings.lotSize) || 65;
  try {
    const symbolRegistry = require('../config/symbolRegistry');
    const active = symbolRegistry.getSymbol(state.activeSymbolKey || symbolRegistry.getActiveSymbol());
    if (Number.isFinite(active?.lotSize) && active.lotSize > 0) originalLotSize = active.lotSize;
  } catch (_) {}
  const minLots = Number(settings.minLots) || 1;
  const lots = minLots;
  const qty = lots * originalLotSize;

  const targetPoints = decision.target_points || settings.targetPoints || 10;
  const slPoints = decision.sl_points || settings.slPoints || 15;
  const targetPremium = premium + targetPoints;
  const slPremium = premium - slPoints;
  const ensembleConfidence = decision.confidence;

  // Try to get opening strike for alternativeStrike field (best-effort)
  let openingStrike = selectedStrike;
  try { openingStrike = professionalTrader.getMarketSession?.()?.openingStrike || selectedStrike; } catch (_) {}

  const trade = await ScalpingTrade.create({
    sessionId: state.session._id,
    signal: isCE ? 'BUY_CE' : 'BUY_PE',
    strike: selectedStrike,
    optionSymbol: optionSymbol,
    expiry,
    lotSize: originalLotSize,
    quantity: qty,
    entryPrice: premium,
    currentPrice: premium,
    sl: Number(slPremium.toFixed(2)),
    target: Number(targetPremium.toFixed(2)),
    aiConfidence: ensembleConfidence,
    entryReason: `[${tradeType}] ${decision.engineType}: ${(decision.reasoning || '').slice(0, 100)} | Conf: ${ensembleConfidence}`,
    marketRegime: decision.engineType || 'ULTRA_SCALP',
    buildUpType: payload?.futures_data?.build_up_type,
    vwapState: payload?.vwap_analysis?.price_vs_vwap,
    oiDirection: direction,
    spotPriceAtEntry: spotPrice,
    strikeSelectionRationale: `${decision.engineType}: ${decision.signal} ${selectedStrike} ${decision.option_type}, target ${targetPoints}pts, sl ${slPoints}pts`,
    strikeSelectionConfidence: ensembleConfidence,
    alternativeStrike: openingStrike,
    expectedHoldDuration: isSwingTrade ? '3-15min' : '30-120sec',
    tradeType,
    engineType: decision.engineType || 'ULTRA_SCALP',
    market: decision.market || state.activeSymbolKey || 'NIFTY_50',
    maxHoldSeconds: Number(decision.suggested_max_hold_seconds)
      || Number(decision.max_hold_seconds)
      || (isSwingTrade ? (settings.swingMaxHoldMinutes || 15) * 60 : settings.maxHoldTimeSeconds || 180),
    aiEntryDecision: decision,
    hybridEntrySnapshot: decision.hybridSnapshot || null,
    hasReachedTarget: false,
    maxPriceReached: premium,
    futuresConfirmed: false,
    futuresDirection: 'unknown',
    futuresPremium: 0,
    optionSecurityId: optionSecurityId || null,
    liveFeedConnected: false,
    lastPriceUpdate: new Date(),
    priceUpdateSource: 'entry',
    brokerageEnabled: settings.enableBrokerageCalculation || false,
    aiSnapshots: [{
      at: new Date(),
      confidence: ensembleConfidence,
      action: 'ENTER',
      rationale: decision.reasoning,
    }],
  });

  state.cooldownUntil = Date.now() + (settings.cooldownSec || 60) * 1000;

  // Subscribe option to live feed for fast monitor reads
  try {
    if (optionSecurityId) {
      const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');
      const optionSegment = _optionSegmentForActive();
      liveFeedProd.subscribe(
        [{ exchangeSegment: optionSegment, securityId: optionSecurityId }],
        'FULL'
      );
      trade.liveFeedConnected = true;
      trade.priceUpdateSource = 'live_feed_subscribed';
      await trade.save();
      scalpingSocket.emitTradeUpdated(trade, state.session._id, 'live_feed_connected');
    }
  } catch (e) {
    logger.warn({ err: e.message, tradeId: trade._id }, '[engine] fast-path: live feed subscribe failed');
  }

  logger.info({
    tradeId: trade._id,
    market: trade.market,
    engineType: trade.engineType,
    signal: trade.signal,
    strike: trade.strike,
    premium,
    target: trade.target,
    sl: trade.sl,
    confidence: ensembleConfidence,
  }, '[engine] 🚀 FAST-PATH TRADE OPENED');

  scalpingSocket.emitTradeCreated(trade, state.session._id);

  await engineLogger.logEvent({
    sessionId: state.session._id,
    eventType: 'trade_opened',
    level: 'info',
    message: `🚀 ${decision.engineType} ${trade.market}: ${trade.signal} @ ${trade.strike} (${decision.option_type}) for ₹${premium} | tgt ${targetPoints}pts | sl ${slPoints}pts | conf ${ensembleConfidence}`,
    tradeId: trade._id,
    data: {
      signal: trade.signal,
      strike: trade.strike,
      market: trade.market,
      engineType: trade.engineType,
      entryPrice: premium,
      quantity: qty,
      sl: trade.sl,
      target: trade.target,
      confidence: ensembleConfidence,
      reasoning: decision.reasoning,
    },
  });

  return trade;
}

module.exports = { start, stop, getStatus, isRunning, manualExit };
