/**
 * Premium Swing Engine
 * ====================
 * A premium-based intraday SWING engine — distinct from SUPPORT_SCALP.
 *
 *   Scalp engine:  3-min UT Bot, 8-22pt premium, 30s-5min hold
 *   Swing engine:  opening-range breakout, 25-60pt premium, 5min-4hr hold
 *
 * STRATEGY (locked at 9:15-9:20 IST):
 *   1. Capture primary-strike (ATM-at-9:15) CE H/L and PE H/L over the
 *      first 5 minutes of trading.
 *   2. Classify the regime by how the two ranges relate:
 *
 *      A. PE_low ≥ CE_high   → BULLISH REVERSAL setup
 *         Bearish open, PE was bid up. If CE breaks ABOVE its H, market
 *         has reversed up. BUY CE.
 *           T1 = PE low  (premium-symmetric mean revert)
 *           T2 = PE high (full reversal)
 *           SL = CE low
 *
 *      B. CE_low ≥ PE_high   → BEARISH REVERSAL setup
 *         Bullish open, CE was bid up. If PE breaks ABOVE its H, market
 *         has reversed down. BUY PE.
 *           T1 = CE low
 *           T2 = CE high
 *           SL = PE low
 *
 *      C. Ranges overlap     → SIDEWAYS day
 *         CE H/L and PE H/L both useful as fade zones.
 *           Buy CE near CE_low, target CE_high
 *           Buy PE near PE_low, target PE_high
 *
 *   3. CASCADING REVERSAL — if a primary-strike trade SLs, re-arm
 *      at the NEAREST OI-defended support/resistance zone (handled
 *      via oiZoneMapper.nextReversalZone).
 *
 * STRIKE SELECTION:
 *   Trend trades (regime A/B):
 *     • ATM or 1-strike ITM (delta 0.50-0.60) — theta resistant for swing hold
 *   Sideways trades (regime C):
 *     • Strict ATM (delta 0.50)
 *   Reversal-zone trades (cascade):
 *     • ATM/OTM with delta 0.40-0.50
 *
 * The engine returns a decision payload identical in shape to
 * supportScalpEngine so the master engine can wrap it the same way.
 */

const tracker        = require('./premiumSwingRangeTracker');
const oiZoneMapper   = require('./oiZoneMapper');

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

const HARD_END_MIN = 14 * 60 + 30;   // 14:30 IST — no new entries
const MIN_REGIME_BUFFER = 1.0;       // pts — minimum gap between PE and CE ranges to call a regime

function _istMinutesNow() {
  const ms = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function _findStrikeRow(strikes, strike) {
  return (strikes || []).find(s => Number(s?.strike) === Number(strike)) || null;
}

/**
 * Read the current premium of the given side from the option chain.
 *
 * @returns {{ ltp, bid, ask, delta, iv, oi, oiChg, vol } | null}
 */
function _readSide(strikes, strike, side) {
  const row = _findStrikeRow(strikes, strike);
  if (!row) return null;
  const leg = side === 'CE' ? (row.ce ?? row.call) : (row.pe ?? row.put);
  if (!leg) return null;
  return {
    ltp:    _safe(leg.ltp),
    bid:    _safe(leg.bid),
    ask:    _safe(leg.ask),
    delta:  _safe(leg.delta ?? leg.greeks?.delta),
    iv:     _safe(leg.iv),
    oi:     _safe(leg.oi),
    oiChg:  _safe(leg.oiChg ?? leg.oiChange),
    vol:    _safe(leg.vol ?? leg.volume),
  };
}

/**
 * Decide whether to fire a Premium Swing entry for the given market.
 *
 * @param {{
 *   market, primaryStrikes, atmStrike, spotPrice, settings, sessionId,
 *   prevTrades?: Array,   // closed swing trades today (for cascade tracking)
 * }} args
 *
 * @returns Decision payload (same shape as supportScalpEngine.decide)
 */
function decide({
  market = null,
  primaryStrikes = [],
  atmStrike = null,
  spotPrice = null,
  settings = {},
  sessionId = null,
  prevSwingTrades = [],
} = {}) {
  const cfg = settings?.premiumSwing || {};
  const minutes = _istMinutesNow();

  // 1) Capture / read the opening range
  const range = tracker.capture(market) || tracker.get(market);
  if (!range) {
    return {
      fired: false,
      reasoning: minutes < tracker.CAPTURE_END_MIN
        ? `swing: opening range not yet closed (waiting until 09:20 IST)`
        : `swing: opening range capture failed for ${market}`,
      pillars: {},
    };
  }

  // 2) Hard cutoff for new entries
  if (minutes >= HARD_END_MIN) {
    return {
      fired: false,
      reasoning: `swing: past 14:30 IST cutoff — no new swing entries`,
      pillars: { range },
    };
  }

  // 3) Regime gating — if regime says SIDEWAYS but settings disabled it, bail
  const allowReversal     = cfg.allowReversalRegimes !== false;
  const allowBullishRev   = cfg.allowBullishReversal !== false;
  const allowBearishRev   = cfg.allowBearishReversal !== false;
  const allowSideways     = cfg.allowSidewaysRegime  !== false;
  if (range.regime === 'sideways' && !allowSideways) {
    return { fired: false, reasoning: 'swing: sideways regime disabled in settings (low historical edge)', pillars: { range } };
  }
  if (range.regime !== 'sideways' && !allowReversal) {
    return { fired: false, reasoning: 'swing: reversal regimes disabled in settings', pillars: { range } };
  }
  if (range.regime === 'bullish_reversal' && !allowBullishRev) {
    return { fired: false, reasoning: 'swing: bullish_reversal regime disabled in settings', pillars: { range } };
  }
  if (range.regime === 'bearish_reversal' && !allowBearishRev) {
    return { fired: false, reasoning: 'swing: bearish_reversal regime disabled in settings (needs futures confirmation gate)', pillars: { range } };
  }

  // 4) Per-day max-trades & per-direction lockout
  const maxTradesPerDay = _safe(cfg.maxTradesPerDay || 4);
  if ((prevSwingTrades || []).length >= maxTradesPerDay) {
    return { fired: false, reasoning: `swing: max ${maxTradesPerDay} trades per day reached`, pillars: { range } };
  }

  // 5) Compute OI zones (used for cascade plays)
  const zones = oiZoneMapper.computeZones({
    primaryStrikes, spot: spotPrice, count: 3,
  });

  // 6) Pick a play
  const play = _selectPlay({
    range, primaryStrikes, atmStrike, spotPrice,
    cfg, zones, prevSwingTrades,
  });
  if (!play.ok) {
    return { fired: false, reasoning: `swing: ${play.reason}`, pillars: { range, zones, candidates: play.candidates } };
  }

  // 7) Convert play into a decision payload
  return _buildDecision({ play, range, cfg, market, atmStrike, primaryStrikes, zones });
}

/**
 * Core play selector. Returns the chosen entry (strike + side + targets)
 * based on the regime, current premium levels, and OI zones.
 */
function _selectPlay({
  range, primaryStrikes, atmStrike, spotPrice,
  cfg, zones, prevSwingTrades,
}) {
  const usedStrikes = new Set((prevSwingTrades || []).map(t => Number(t.strike)));

  // ── Helper: live read of primary-strike CE/PE
  const ceNow = _readSide(primaryStrikes, range.primaryStrike, 'CE');
  const peNow = _readSide(primaryStrikes, range.primaryStrike, 'PE');
  if (!ceNow || !peNow) {
    return { ok: false, reason: `primary strike ${range.primaryStrike} missing from current chain` };
  }

  // ── Regime A: BULLISH REVERSAL ────────────────────────────────────
  // Fire BUY CE when current CE LTP breaks ABOVE range.ce.high.
  // T1 = PE low, T2 = PE high, SL = CE low.
  if (range.regime === 'bullish_reversal') {
    const triggerHit = ceNow.ltp > range.ce.high + MIN_REGIME_BUFFER;
    if (!triggerHit) {
      return {
        ok: false,
        reason: `bullish_reversal armed — waiting for CE LTP ${ceNow.ltp.toFixed(1)} to break > ${range.ce.high.toFixed(1)}`,
      };
    }
    return {
      ok: true,
      direction: 'bullish',
      side: 'CE',
      strike: range.primaryStrike,
      entry: ceNow.ltp,
      target1: range.pe.low,
      target2: range.pe.high,
      sl: range.ce.low,
      regime: 'bullish_reversal',
      kind: 'primary',
      moneyness: range.primaryStrike === atmStrike ? 'ATM' : (range.primaryStrike < atmStrike ? 'ITM' : 'OTM'),
      delta: ceNow.delta,
      iv: ceNow.iv,
      bid: ceNow.bid, ask: ceNow.ask,
      reasoning: `Bullish reversal — CE broke ${range.ce.high.toFixed(1)} (range high). T1=${range.pe.low.toFixed(1)} T2=${range.pe.high.toFixed(1)} SL=${range.ce.low.toFixed(1)}`,
    };
  }

  // ── Regime B: BEARISH REVERSAL ────────────────────────────────────
  if (range.regime === 'bearish_reversal') {
    const triggerHit = peNow.ltp > range.pe.high + MIN_REGIME_BUFFER;
    if (!triggerHit) {
      return {
        ok: false,
        reason: `bearish_reversal armed — waiting for PE LTP ${peNow.ltp.toFixed(1)} to break > ${range.pe.high.toFixed(1)}`,
      };
    }
    return {
      ok: true,
      direction: 'bearish',
      side: 'PE',
      strike: range.primaryStrike,
      entry: peNow.ltp,
      target1: range.ce.low,
      target2: range.ce.high,
      sl: range.pe.low,
      regime: 'bearish_reversal',
      kind: 'primary',
      moneyness: range.primaryStrike === atmStrike ? 'ATM' : 'OTM',
      delta: peNow.delta,
      iv: peNow.iv,
      bid: peNow.bid, ask: peNow.ask,
      reasoning: `Bearish reversal — PE broke ${range.pe.high.toFixed(1)} (range high). T1=${range.ce.low.toFixed(1)} T2=${range.ce.high.toFixed(1)} SL=${range.pe.low.toFixed(1)}`,
    };
  }

  // ── Regime C: SIDEWAYS — buy at extremes, target opposite extreme ─
  if (range.regime === 'sideways') {
    const ceFadeBuf = _safe(cfg.sidewaysFadeBuffer || 1.0);
    // BUY CE near CE.low — bounce play
    if (ceNow.ltp <= range.ce.low + ceFadeBuf) {
      return {
        ok: true,
        direction: 'bullish',
        side: 'CE',
        strike: range.primaryStrike,
        entry: ceNow.ltp,
        target1: (range.ce.high + range.ce.low) / 2,
        target2: range.ce.high,
        sl: range.ce.low - 5,
        regime: 'sideways',
        kind: 'sideways_bounce',
        moneyness: 'ATM',
        delta: ceNow.delta, iv: ceNow.iv,
        bid: ceNow.bid, ask: ceNow.ask,
        reasoning: `Sideways CE fade-buy at ${ceNow.ltp.toFixed(1)} (low ${range.ce.low.toFixed(1)}). T1=mid T2=${range.ce.high.toFixed(1)}`,
      };
    }
    // BUY PE near PE.low — bounce play
    if (peNow.ltp <= range.pe.low + ceFadeBuf) {
      return {
        ok: true,
        direction: 'bearish',
        side: 'PE',
        strike: range.primaryStrike,
        entry: peNow.ltp,
        target1: (range.pe.high + range.pe.low) / 2,
        target2: range.pe.high,
        sl: range.pe.low - 5,
        regime: 'sideways',
        kind: 'sideways_bounce',
        moneyness: 'ATM',
        delta: peNow.delta, iv: peNow.iv,
        bid: peNow.bid, ask: peNow.ask,
        reasoning: `Sideways PE fade-buy at ${peNow.ltp.toFixed(1)} (low ${range.pe.low.toFixed(1)}). T1=mid T2=${range.pe.high.toFixed(1)}`,
      };
    }
    return { ok: false, reason: `sideways waiting — CE ${ceNow.ltp.toFixed(1)} not at low ${range.ce.low.toFixed(1)}, PE ${peNow.ltp.toFixed(1)} not at low ${range.pe.low.toFixed(1)}` };
  }

  return { ok: false, reason: `unknown regime: ${range.regime}` };
}

/**
 * Wrap play details into the decision shape the master engine expects.
 */
function _buildDecision({ play, range, cfg, market, atmStrike, primaryStrikes, zones }) {
  const targetMin = _safe(cfg.targetMin || 25);
  const targetMax = _safe(cfg.targetMax || 70);
  // Premium points the strategy projects (T1) — used by sizing
  const target_pts = Math.max(targetMin, Math.min(targetMax, Math.round(play.target1 - play.entry)));
  const sl_pts     = Math.max(8, Math.round(play.entry - play.sl));
  const rrTarget   = Number((target_pts / Math.max(1, sl_pts)).toFixed(2));
  const maxHoldSec = _safe(cfg.maxHoldSec || 4 * 60 * 60);  // 4 hours

  // Confidence — high baseline because the regime is locked + structural
  // levels exist. Bump for ATM, healthy delta, tight spread.
  let confidence = 75;
  if (play.moneyness === 'ATM') confidence += 6;
  if (Math.abs(play.delta) >= 0.45 && Math.abs(play.delta) <= 0.60) confidence += 5;
  if (play.bid > 0 && play.ask > 0) {
    const spreadPct = (play.ask - play.bid) / ((play.ask + play.bid) / 2) * 100;
    if (spreadPct <= 0.5) confidence += 4;
    else if (spreadPct >= 2.0) confidence -= 6;
  }
  if (rrTarget >= 2) confidence += 3;
  confidence = Math.min(95, Math.max(50, confidence));

  return {
    fired: true,
    signal: play.direction === 'bullish' ? 'BUY_CE' : 'BUY_PE',
    direction: play.direction,
    strike: play.strike,
    optionType: play.side,
    moneyness: play.moneyness,
    target_pts,
    sl_pts,
    target1_premium: play.target1,
    target2_premium: play.target2,
    sl_premium: play.sl,
    entry_estimate: play.entry,
    maxHoldSec,
    rrTarget,
    confidence,
    reasoning: play.reasoning,
    timeframe: '5m_open_range',
    family: 'premium_swing',
    name: `PREMIUM_SWING_${play.regime.toUpperCase()}_${play.kind.toUpperCase()}`,
    holdProfile: { tradeType: 'SWING', maxHoldSec, rrTarget },
    riskProfile: { slPct: 0.15, sizingFactor: cfg.sizingFactor || 0.7 },
    confluenceTier: 'standard',
    consensusScore: 80,
    pillars: {
      range,
      regime: play.regime,
      kind: play.kind,
      zones,
      strike: play.strike,
      side: play.side,
      delta: play.delta,
      iv: play.iv,
      bid: play.bid, ask: play.ask,
    },
    smartTrail: {
      mode: 'structural',
      // Structural targets handled inside premiumSwingExitValidator
      targetLadder: [play.target1, play.target2],
      slPremium: play.sl,
    },
    market,
  };
}

module.exports = { decide };
