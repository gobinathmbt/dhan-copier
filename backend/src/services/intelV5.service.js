/* ─────────────────────────────────────────────────────────────────────
 * INTEL V5 — Institutional Option Buyer Verdict
 * ========================================================================
 *
 * Pure positioning → control → acceptance → confirmation → action engine.
 *
 * No indicators. No strategy stacks. No chart overlays.
 *
 * Six institutional layers feed ONE final verdict:
 *
 *   1. OI CHANGE      — Fresh money entering or exiting
 *   2. OI BUILDUP     — Long/Short Buildup, Covering, Unwinding (intent)
 *   3. AVWAP          — Buyer or Seller control of the auction
 *   4. FRVP           — Above/Below POC + POC migration (acceptance)
 *   5. FUTURES BASIS  — Premium = bullish, Discount = bearish
 *   6. CPR (context)  — Bullish / Bearish / Chop environment
 *
 * Output: BUY CE | BUY PE | WAIT plus the alignment of each layer.
 *
 * Endpoint: GET /api/intel-v5/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelV2 = require('./intelV2.service');

function _safe(n) { return Number.isFinite(n) ? n : 0; }
function _round(n, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/* ─── Per-symbol POC history — used to detect rising vs falling POC ─── */
const _pocHistory = new Map(); // symbol → [{ t, poc }]
const POC_HISTORY_MAX = 60;
const POC_TTL_MS = 30 * 60_000;

function _pushPocHistory(symbol, t, poc) {
  if (!Number.isFinite(poc)) return;
  const list = _pocHistory.get(symbol) || [];
  list.push({ t, poc });
  const cutoff = t - POC_TTL_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  while (list.length > POC_HISTORY_MAX) list.shift();
  _pocHistory.set(symbol, list);
}

function _pocMigration(symbol) {
  const list = _pocHistory.get(symbol) || [];
  if (list.length < 5) return { direction: 'STABLE', drift: 0 };
  const oldPoc = list[0].poc;
  const newPoc = list[list.length - 1].poc;
  const drift = newPoc - oldPoc;
  if (drift >= 5) return { direction: 'RISING', drift: _round(drift, 1) };
  if (drift <= -5) return { direction: 'FALLING', drift: _round(drift, 1) };
  return { direction: 'STABLE', drift: _round(drift, 1) };
}

/* ─── 6-layer institutional decision ─────────────────────────────────── */
async function getDecision({ symbol = 'NIFTY_50', date = null } = {}) {
  const v2 = await intelV2.getSnapshot({ symbol, date });
  if (!v2 || !v2.ok) {
    return { ok: false, error: 'V2 snapshot unavailable', version: 'v5' };
  }

  const spot = v2.spot?.ltp ?? 0;
  const vwap = v2.spot?.vwap ?? 0;
  const futPremium = v2.futures?.premium ?? 0;
  const cpr = v2.cpr || null;
  const fEngine = v2.dashboard?.frvpInstitutional?.engine;
  const profile = fEngine?.profile;
  const oiBuild = v2.dashboard?.oiBuildupAnalysis;
  const md = v2.dashboard?.marketDirection;
  const flowOi = v2.flow?.oi;
  const flowDelta = v2.flow?.delta;
  const ladder = Array.isArray(v2.ladder) ? v2.ladder : [];
  const trap = v2.trap;

  // Track POC for the migration engine
  if (profile?.poc) _pushPocHistory(symbol, Date.now(), profile.poc);
  const pocMig = _pocMigration(symbol);

  // ── LAYER 1 — OI CHANGE (fresh money) ────────────────────────────────
  const totals = oiBuild?.totals;
  const ceChangePct = totals?.ce?.changePct ?? 0;
  const peChangePct = totals?.pe?.changePct ?? 0;
  // Net = bullish flow indicator: PE writing + CE unwinding = bullish
  // CE writing + PE unwinding = bearish
  const netOiPositive = peChangePct > ceChangePct + 5;
  const netOiNegative = ceChangePct > peChangePct + 5;
  const oiChangeLabel =
    netOiPositive ? 'POSITIVE' :
    netOiNegative ? 'NEGATIVE' :
    'BALANCED';
  const oiChangeBias = netOiPositive ? 'BULLISH' : netOiNegative ? 'BEARISH' : 'NEUTRAL';

  // ── LAYER 2 — OI BUILDUP (intent) ────────────────────────────────────
  // Aggregate per-strike buildup tags from the V2 ladder. Find the dominant
  // tag among ATM ± 5 strikes weighted by volume.
  const atm = v2.options?.atm;
  const aboveLadder = ladder.filter(r => atm != null && Math.abs(r.strike - atm) <= 500);
  const buildupTally = {};
  for (const row of aboveLadder) {
    for (const side of ['ce', 'pe']) {
      const tag = row[side]?.buildup;
      if (!tag) continue;
      const vol = row[side]?.volume || 0;
      buildupTally[tag] = (buildupTally[tag] || 0) + vol;
    }
  }
  const sortedBuildup = Object.entries(buildupTally).sort((a, b) => b[1] - a[1]);
  const dominantBuildup = sortedBuildup[0]?.[0] || 'Balanced';
  const buildupBias = (() => {
    if (dominantBuildup === 'Long Buildup') return 'BULLISH';
    if (dominantBuildup === 'Short Covering') return 'BULLISH';
    if (dominantBuildup === 'Short Buildup') return 'BEARISH';
    if (dominantBuildup === 'Long Unwinding') return 'BEARISH';
    return 'NEUTRAL';
  })();

  // ── LAYER 3 — AVWAP CONTROL ──────────────────────────────────────────
  const avwap = v2.avwap?.priorDay ?? vwap;
  const aboveAvwap = avwap != null && spot > avwap;
  const avwapLabel = aboveAvwap ? 'ABOVE' : 'BELOW';
  const avwapBias = aboveAvwap ? 'BULLISH' : 'BEARISH';

  // ── LAYER 4 — FRVP (POC) ACCEPTANCE ──────────────────────────────────
  const poc = profile?.poc ?? null;
  const abovePoc = poc != null && spot > poc;
  const pocLabel = poc == null ? 'UNKNOWN' : abovePoc ? 'ABOVE POC' : 'BELOW POC';
  const pocAcceptance = abovePoc ? 'BUYER' : 'SELLER';
  const pocMigrationLabel =
    pocMig.direction === 'RISING' ? 'RISING' :
    pocMig.direction === 'FALLING' ? 'FALLING' :
    'FLAT';
  const frvpBias = abovePoc ? 'BULLISH' : 'BEARISH';

  // ── LAYER 5 — FUTURES PARTICIPATION ──────────────────────────────────
  const futuresLabel = futPremium > 5 ? 'PREMIUM' : futPremium < -5 ? 'DISCOUNT' : 'NEUTRAL';
  const futuresBias = futPremium > 5 ? 'BULLISH' : futPremium < -5 ? 'BEARISH' : 'NEUTRAL';

  // ── LAYER 6 — CPR CONTEXT ────────────────────────────────────────────
  let cprLabel = 'UNKNOWN';
  let cprBias = 'NEUTRAL';
  let insideCpr = false;
  if (cpr?.pivot && cpr?.tc && cpr?.bc) {
    if (spot > cpr.tc) { cprLabel = 'ABOVE CPR'; cprBias = 'BULLISH'; }
    else if (spot < cpr.bc) { cprLabel = 'BELOW CPR'; cprBias = 'BEARISH'; }
    else { cprLabel = 'INSIDE CPR'; cprBias = 'NEUTRAL'; insideCpr = true; }
  }

  // ─────────────────────────────────────────────────────────────────────
  // FINAL VERDICT — alignment-based
  // ─────────────────────────────────────────────────────────────────────
  const layers = [
    { key: 'OI_CHANGE',  bias: oiChangeBias, label: oiChangeLabel },
    { key: 'OI_BUILDUP', bias: buildupBias,  label: dominantBuildup },
    { key: 'AVWAP',      bias: avwapBias,    label: avwapLabel },
    { key: 'FRVP_POC',   bias: frvpBias,     label: pocLabel },
    { key: 'FUTURES',    bias: futuresBias,  label: futuresLabel },
    { key: 'CPR',        bias: cprBias,      label: cprLabel },
  ];
  const bullCount = layers.filter(l => l.bias === 'BULLISH').length;
  const bearCount = layers.filter(l => l.bias === 'BEARISH').length;
  const neutralCount = layers.filter(l => l.bias === 'NEUTRAL').length;

  // Wait gates — any single one of these forces WAIT (per spec).
  const waitGates = [];
  if (insideCpr) waitGates.push('Inside CPR');
  if (pocMigrationLabel === 'FLAT' && abovePoc === false) waitGates.push('POC flat below value');
  if (oiChangeLabel === 'BALANCED') waitGates.push('Mixed OI change');
  if (futuresLabel === 'NEUTRAL') waitGates.push('Future neutral');
  if (avwap != null && Math.abs(spot - avwap) / avwap < 0.0008) waitGates.push('Near AVWAP');

  // POC flat is a soft gate — only blocks if other engines also conflict.
  const poorPocConfirmation = pocMigrationLabel === 'FLAT';

  // Decision
  let verdict = 'WAIT';
  let control = 'NEUTRAL';
  if (bullCount >= 5 || (bullCount === 4 && bearCount === 0 && waitGates.length === 0)) {
    verdict = 'BUY CE';
    control = 'BUYERS';
  } else if (bearCount >= 5 || (bearCount === 4 && bullCount === 0 && waitGates.length === 0)) {
    verdict = 'BUY PE';
    control = 'SELLERS';
  } else if (waitGates.length === 0 && bullCount >= 4 && bullCount > bearCount + 2) {
    verdict = 'BUY CE';
    control = 'BUYERS';
  } else if (waitGates.length === 0 && bearCount >= 4 && bearCount > bullCount + 2) {
    verdict = 'BUY PE';
    control = 'SELLERS';
  } else {
    verdict = 'WAIT';
    control = bullCount > bearCount ? 'BUYERS' : bearCount > bullCount ? 'SELLERS' : 'NEUTRAL';
  }

  // Confidence — alignment depth
  // 6 aligned = 95, 5 = 84, 4 = 72, 3 = 58, 2 = 45, ≤ 1 = 35
  const aligned = verdict === 'BUY CE' ? bullCount : verdict === 'BUY PE' ? bearCount : Math.max(bullCount, bearCount);
  const confidenceTable = { 6: 95, 5: 84, 4: 72, 3: 58, 2: 45, 1: 35, 0: 25 };
  let confidence = confidenceTable[aligned] ?? 35;
  if (poorPocConfirmation) confidence -= 8;
  if (waitGates.length > 0 && verdict !== 'WAIT') confidence -= 10;
  if (trap?.detected > 0) confidence -= 5 * trap.detected;
  confidence = Math.max(20, Math.min(95, confidence));
  const conviction =
    confidence >= 80 ? 'HIGH' :
    confidence >= 60 ? 'MEDIUM' :
    confidence >= 45 ? 'LOW' :
    'AVOID';
  const grade =
    confidence >= 90 ? 'A+' :
    confidence >= 80 ? 'A' :
    confidence >= 70 ? 'B' :
    confidence >= 55 ? 'C' :
    'D';

  // Flow Score 0..100 (institutional alignment + activity)
  const flowScore = Math.round(
    (verdict === 'BUY CE'
      ? (bullCount * 12)
      : verdict === 'BUY PE'
        ? (bearCount * 12)
        : Math.max(bullCount, bearCount) * 8) +
    (oiChangeBias !== 'NEUTRAL' ? 14 : 0) +
    (buildupBias !== 'NEUTRAL' ? 14 : 0)
  );

  // ── Risk / Trap / Regime tags ────────────────────────────────────────
  const riskLevel =
    insideCpr ? 'HIGH' :
    waitGates.length >= 2 ? 'HIGH' :
    waitGates.length === 1 ? 'MEDIUM' :
    'LOW';
  const trapLabel = trap?.detected > 0 ? `${trap.detected} ACTIVE` : 'NONE';
  const regimeLabel =
    insideCpr ? 'CHOP' :
    Math.abs(spot - vwap) / Math.max(1, vwap) > 0.0035 ? 'TRENDING' :
    'BALANCED';

  // ── Top wall picks for SUPPORT/RESISTANCE block ──────────────────────
  const topResistances = (md?.resistances || []).slice(0, 2).map(r => ({
    strike: Math.round(r.strike / 100) * 100,
    side: 'CE',
    tier: r.tier,
    oi: r.oi,
    oiChange: r.oiChange,
  }));
  const topSupports = (md?.supports || []).slice(0, 2).map(r => ({
    strike: Math.round(r.strike / 100) * 100,
    side: 'PE',
    tier: r.tier,
    oi: r.oi,
    oiChange: r.oiChange,
  }));

  return {
    ok: true,
    version: 'v5',
    symbol: v2.symbol,
    date: v2.date,
    isToday: v2.isToday,
    at: Date.now(),

    spotPrice: _round(spot, 2),
    vwap: _round(vwap, 2),
    avwap: _round(avwap || 0, 2),
    futPremium: _round(futPremium, 2),
    atm,

    verdict,
    control,
    confidence,
    grade,
    conviction,
    flowScore,

    layers: {
      oiChange: {
        label: oiChangeLabel,                     // POSITIVE | NEGATIVE | BALANCED
        bias:  oiChangeBias,                      // BULLISH | BEARISH | NEUTRAL
        cePct: _round(ceChangePct, 1),
        pePct: _round(peChangePct, 1),
        narrative: oiChangeBias === 'BULLISH'
          ? 'Fresh PE writers · CE unwinding'
          : oiChangeBias === 'BEARISH'
            ? 'Fresh CE writers · PE unwinding'
            : 'Balanced position changes',
      },
      oiBuildup: {
        label: dominantBuildup,                   // Long Buildup | Short Buildup | …
        bias: buildupBias,
        narrative: buildupBias === 'BULLISH'
          ? 'Bullish positioning across ATM strikes'
          : buildupBias === 'BEARISH'
            ? 'Bearish positioning across ATM strikes'
            : 'Mixed positioning',
      },
      avwap: {
        label: avwapLabel,                         // ABOVE | BELOW
        bias: avwapBias,
        avwapValue: _round(avwap || 0, 2),
        distance: _round(spot - (avwap || spot), 2),
        narrative: aboveAvwap ? 'Buyers own the auction' : 'Sellers own the auction',
      },
      frvp: {
        label: pocLabel,                           // ABOVE POC | BELOW POC
        bias: frvpBias,
        pocValue: poc,
        pocMigration: pocMigrationLabel,           // RISING | FALLING | FLAT
        pocDrift: pocMig.drift,
        acceptance: pocAcceptance,                 // BUYER | SELLER
        narrative: abovePoc
          ? (pocMigrationLabel === 'RISING' ? 'Value accepted higher' : 'Above value, watch acceptance')
          : (pocMigrationLabel === 'FALLING' ? 'Value rotating lower' : 'Below value, sellers in charge'),
      },
      futures: {
        label: futuresLabel,                       // PREMIUM | DISCOUNT | NEUTRAL
        bias: futuresBias,
        premium: _round(futPremium, 2),
        narrative: futuresBias === 'BULLISH'
          ? 'Institutions paying premium'
          : futuresBias === 'BEARISH'
            ? 'Institutions selling at discount'
            : 'Futures aligned with cash',
      },
      cpr: {
        label: cprLabel,                           // ABOVE CPR | BELOW CPR | INSIDE CPR
        bias: cprBias,
        pivot: cpr?.pivot ?? null,
        tc: cpr?.tc ?? null,
        bc: cpr?.bc ?? null,
        narrative: insideCpr ? 'Chop zone — avoid directional' : cprBias === 'BULLISH' ? 'Bullish environment' : 'Bearish environment',
      },
    },

    alignment: {
      bull: bullCount,
      bear: bearCount,
      neutral: neutralCount,
      total: 6,
      aligned,
    },

    waitGates,                                     // reasons that force WAIT
    risk:    { level: riskLevel },
    trap:    { label: trapLabel, count: trap?.detected ?? 0 },
    regime:  { label: regimeLabel },

    levels: {
      support:    topSupports,
      resistance: topResistances,
      atm,
      spot: _round(spot, 2),
    },

    // Raw V2 sources kept for transparency / debugging
    debug: {
      oiBuildupSource: !!oiBuild,
      flowOi,
      flowDeltaBias: flowDelta?.bias,
    },
  };
}

module.exports = { getDecision };
