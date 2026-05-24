/**
 * Premium Swing Exit Validator
 * ============================
 * Per-tick exit decisions for SWING trades opened by premiumSwingEngine.
 * Mirrors the scalp exit validator's shape but with swing-appropriate
 * logic:
 *
 *   E1.  Hard SL          — current ≤ stored sl_premium (always)
 *   E2.  T1 partial book   — at target1, lock 50% of position, trail rest
 *   E3.  T2 hit            — exit remainder
 *   E4.  Time cutoff       — 14:30 IST hard exit (no overnight)
 *   E5.  Max hold          — 4hr ceiling
 *   E6.  Peak giveback     — gave back ≥ 60% of peak after T1 → exit
 *   E7.  Adverse range break (OPP) — if regime was bullish reversal and
 *                          PE breaks above PE_high (its own range high),
 *                          the regime has flipped → exit immediately.
 *                          Mirror for bearish reversal.
 *   E8.  Velocity stall    — premium hasn't moved ±1pt in 3 minutes after
 *                          the first 10 minutes → trade is dead, exit.
 *
 * SWING EXITS DO NOT USE: quick-fail, premium velocity gate (those are
 * scalp-only). Swings need room to breathe.
 *
 * Returns: { action: 'EXIT'|'TRAIL_SL'|'PARTIAL_BOOK'|'HOLD', reasoning, source, factors, new_sl?, partial_pct? }
 */

function _safe(n, def = 0) { const x = Number(n); return Number.isFinite(x) ? x : def; }

const HARD_END_MIN = 14 * 60 + 30; // 14:30 IST hard exit

function _istMinutesNow() {
  const ms = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function _findStrikeRow(strikes, strike) {
  return (strikes || []).find(s => Number(s?.strike) === Number(strike)) || null;
}

function _readSide(strikes, strike, side) {
  const row = _findStrikeRow(strikes, strike);
  if (!row) return null;
  const leg = side === 'CE' ? (row.ce ?? row.call) : (row.pe ?? row.put);
  return leg || null;
}

function decide({
  trade,
  aggregator = {},
  candles1m  = [],
  candles3m  = [],
  candles5m  = [],
  candles15m = [],
  settings   = {},
} = {}) {
  const cfg = settings?.premiumSwingExit || {};
  const now = Date.now();
  const openedAt = new Date(trade?.openedAt || trade?.createdAt || now).getTime();
  const elapsed = Math.floor((now - openedAt) / 1000);

  const entry = _safe(trade?.entryPrice);
  const cur   = _safe(trade?.currentPrice) || entry;
  const peak  = _safe(trade?.maxPriceReached) || entry;
  const slPrice = _safe(trade?.sl);
  const target1 = _safe(trade?.target);    // T1 stored as primary `target`
  const target2 = _safe(trade?.swingTarget2 || trade?.aiEntryDecision?.target2_premium);
  const isCE = (trade?.signal === 'BUY_CE') || (trade?.optionType === 'CE');

  const minHoldSec   = _safe(cfg.minHoldSec, 5 * 60);          // 5 min
  const maxHoldSec   = _safe(trade?.maxHoldSeconds, _safe(cfg.maxHoldSec, 4 * 60 * 60));
  const peakGiveBackPct = _safe(cfg.peakGiveBackPct, 0.60);
  const partialBookPct  = _safe(cfg.partialBookPct,  0.50);
  const stallMinutes    = _safe(cfg.stallMinutes, 3);
  const stallMoveAbs    = _safe(cfg.stallMoveAbs, 1.0);

  const factors = {
    elapsed,
    pnlPts: cur - entry,
    peakPts: peak - entry,
    target1, target2, slPrice,
    minutes: _istMinutesNow(),
  };

  // ── E1. Hard SL ──────────────────────────────────────────────────────
  if (slPrice && cur <= slPrice) {
    return {
      action: 'EXIT',
      reasoning: `[SWING-EXIT] SL hit: ${cur.toFixed(2)} ≤ ${slPrice.toFixed(2)} (P&L ${(cur - entry).toFixed(2)}pts at ${elapsed}s)`,
      source: 'swing_exit:hard_sl',
      factors,
    };
  }

  // ── E4. 14:30 IST hard cutoff ──────────────────────────────────────
  if (factors.minutes >= HARD_END_MIN) {
    return {
      action: 'EXIT',
      reasoning: `[SWING-EXIT] 14:30 IST cutoff — closing swing (P&L ${(cur - entry).toFixed(2)}pts at ${elapsed}s)`,
      source: 'swing_exit:time_cutoff',
      factors,
    };
  }

  // ── E5. Max hold ───────────────────────────────────────────────────
  if (elapsed >= maxHoldSec) {
    return {
      action: 'EXIT',
      reasoning: `[SWING-EXIT] Max hold ${maxHoldSec}s reached (P&L ${(cur - entry).toFixed(2)}pts)`,
      source: 'swing_exit:max_hold',
      factors,
    };
  }

  // Below min-hold guard — only SL exits + 14:30 cutoff allowed
  if (elapsed < minHoldSec) {
    return {
      action: 'HOLD',
      reasoning: `[SWING-EXIT] Min hold ${elapsed}s/${minHoldSec}s — only SL allowed`,
      source: 'swing_exit:min_hold',
      factors,
    };
  }

  // ── E2/E3. Target ladder ──────────────────────────────────────────
  // Target2 hit → close out
  if (Number.isFinite(target2) && cur >= target2) {
    return {
      action: 'EXIT',
      reasoning: `[SWING-EXIT] T2 hit: ${cur.toFixed(2)} ≥ ${target2.toFixed(2)} (P&L +${(cur - entry).toFixed(2)}pts)`,
      source: 'swing_exit:target2',
      factors,
    };
  }
  // Target1 hit and not yet partial-booked → partial book + trail SL
  if (Number.isFinite(target1) && cur >= target1 && !trade?.partialBooked) {
    const newSl = Math.max(slPrice, entry + 1);  // breakeven+1
    return {
      action: 'PARTIAL_BOOK',
      partial_pct: partialBookPct,
      new_sl: Number(newSl.toFixed(2)),
      reasoning: `[SWING-EXIT] T1 hit: ${cur.toFixed(2)} ≥ ${target1.toFixed(2)} — book ${(partialBookPct*100).toFixed(0)}%, trail SL to ${newSl.toFixed(2)}`,
      source: 'swing_exit:target1_partial',
      factors,
    };
  }

  // ── E7. Adverse range break (regime flip detection) ───────────────
  // For a bullish_reversal trade (BUY CE), watch the OPPOSITE leg's range:
  // if the PE LTP exceeds PE_high (i.e. the "opposite" range is being
  // taken out), the bullish reversal thesis has broken — exit our CE.
  // Mirror for bearish_reversal trades.
  try {
    const range = trade?.aiEntryDecision?.pillars?.range;
    const regime = trade?.aiEntryDecision?.pillars?.regime;
    const strike = Number(trade?.strike);
    const optionChain = aggregator?.optionChain || aggregator?.payload?.options_chain;
    const strikes = optionChain?.strikes;
    if (range && strikes && strike) {
      // Opposite leg of OUR position
      const oppSide = isCE ? 'PE' : 'CE';
      const oppLeg = _readSide(strikes, range.primaryStrike, oppSide);
      const oppLtp = _safe(oppLeg?.ltp);
      const oppRange = oppSide === 'CE' ? range.ce : range.pe;
      const adverseBuffer = _safe(cfg.adverseBreakBuffer, 1.5);
      if (regime === 'bullish_reversal' && oppLtp > oppRange.high + adverseBuffer) {
        return {
          action: 'EXIT',
          reasoning: `[SWING-EXIT] Adverse PE break — PE ${oppLtp.toFixed(2)} > PE_high ${oppRange.high.toFixed(2)}; regime broken`,
          source: 'swing_exit:adverse_break',
          factors: { ...factors, oppLtp, oppRangeHigh: oppRange.high },
        };
      }
      if (regime === 'bearish_reversal' && oppLtp > oppRange.high + adverseBuffer) {
        return {
          action: 'EXIT',
          reasoning: `[SWING-EXIT] Adverse CE break — CE ${oppLtp.toFixed(2)} > CE_high ${oppRange.high.toFixed(2)}; regime broken`,
          source: 'swing_exit:adverse_break',
          factors: { ...factors, oppLtp, oppRangeHigh: oppRange.high },
        };
      }
    }
  } catch (_) { /* best-effort */ }

  // ── E6. Peak giveback (after partial book) ────────────────────────
  // If we already booked T1 and price has dropped back > peakGiveBackPct
  // of the peak gain → exit remainder.
  const peakPts = peak - entry;
  if (trade?.partialBooked && peakPts > 4) {
    const giveBackRatio = peakPts > 0 ? (peak - cur) / peakPts : 0;
    if (giveBackRatio >= peakGiveBackPct) {
      return {
        action: 'EXIT',
        reasoning: `[SWING-EXIT] Peak giveback ${(giveBackRatio * 100).toFixed(0)}% (peak +${peakPts.toFixed(2)}pts → ${(cur - entry).toFixed(2)}pts) post-T1`,
        source: 'swing_exit:peak_giveback',
        factors: { ...factors, peakGiveBackRatio: Number(giveBackRatio.toFixed(2)) },
      };
    }
  }

  // ── E8. Velocity stall ────────────────────────────────────────────
  // After 10 min, if premium hasn't moved more than ±stallMoveAbs in
  // the last `stallMinutes` minutes → trade is dead, exit.
  if (elapsed >= 10 * 60 && !trade?.partialBooked) {
    const lookbackSec = stallMinutes * 60;
    const snaps = trade?.priceHistory || [];
    const cutoff = now - lookbackSec * 1000;
    const recent = snaps.filter(s => s.t >= cutoff);
    if (recent.length >= 2) {
      const minP = Math.min(...recent.map(s => _safe(s.p)));
      const maxP = Math.max(...recent.map(s => _safe(s.p)));
      if (maxP - minP < stallMoveAbs && cur - entry < 4) {
        return {
          action: 'EXIT',
          reasoning: `[SWING-EXIT] Velocity stall — premium ranged only ${(maxP - minP).toFixed(2)}pts in last ${stallMinutes}min and pnl < +4pts`,
          source: 'swing_exit:velocity_stall',
          factors: { ...factors, stallRange: maxP - minP },
        };
      }
    }
  }

  return { action: 'HOLD', source: 'swing_exit:hold', factors };
}

module.exports = { decide };
