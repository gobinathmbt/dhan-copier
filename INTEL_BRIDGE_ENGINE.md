# INTEL BRIDGE — INSTITUTIONAL INTENT CONVERTER (V2 → V6)

> The **brain** that connects the two engines into one decision system:
>
> **Positioning (V2) → Market Readiness → Conviction → Premium Expansion → Decision (V6)**
>
> - **V2** = *what is happening* (institutional positioning)
> - **Market Readiness** = *is today's environment suitable for option buying?* (gatekeeper)
> - **V6** = *should I buy it* (premium-gated decision)
> - **Bridge** = the transition layer that gates the environment, then translates
>   positioning into conviction, conviction into premium-expansion probability, and that
>   into an action.

Separate menu: **Intel Bridge (V2→V6 Intent)** · route `/intel-bridge`.

---

## 1. Files

| File | Role |
|------|------|
| `backend/src/services/intelBridge.service.js` | All bridge logic (`getDecision`) |
| `backend/src/controllers/intelBridge.controller.js` | HTTP wrapper |
| `backend/src/routes/intelBridge.routes.js` | `GET /decision` |
| `backend/src/app.js` | Mounts at `/api/intel-bridge` |
| `src/lib/intelBridgeTypes.ts` | Response typing |
| `src/hooks/useIntelBridgeDecision.ts` | Polling hook (3s live) |
| `src/routes/intel-bridge.tsx` | The dashboard |

**Endpoint:** `GET /api/intel-bridge/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]`

The service runs **V2 and V6 in parallel** (V6 internally reuses the cached V2 snapshot,
so it's cheap) and fuses them.

**Layer order (gatekeeper-first):**
`V2 → MARKET READINESS → POSITIONING → CONVICTION → PREMIUM EXPANSION → V6 DECISION`

---

## 1b. Engine 0 — Market Readiness Engine (the gatekeeper)

> **Runs before everything else.** Answers *"is today's ENVIRONMENT healthy enough for
> option buying at all?"* — independent of direction. If the environment is unfit, the
> bridge returns **NO TRADE** and never bothers evaluating premium.

Score = Structure 30 + Flow 30 + Participation 20 + Risk 20 (0–100).

| Section | Max | Checks (each pts) |
|---------|-----|-------------------|
| **Structure** | 30 | Above VWAP (10) · Above AVWAP (10) · Outside Value/trending (10) |
| **Flow** | 30 | Delta strong \|Δ\|≥8 (10) · CVD aligned with delta (10) · Futures premium present (10) |
| **Participation** | 20 | Breadth decisive >60% or <40% (10) · Heavyweights aligned (10) |
| **Risk** | 20 | Low trap risk (10) · Trend day (10) |

**Status:** `0-39 POOR · 40-59 FAIR · 60-79 GOOD · 80-100 EXCELLENT`.
**Gate threshold:** readiness ≥ **50** opens the gate; below 50 → **NO TRADE**.

Sources (all existing V2 data): `vwapAvwapIntraday`, `avwap.session`,
`frvpInstitutional.outsideValue`, `flow.delta`, `cvdSeries`, `futures.premium`,
`breadth.advancePct`, `heavyweightsAlignment`, `trap.risk`, `regimeClassification.dayType`.

---

## 2. Engine 1 — Institutional Conviction Meter

A signed conviction built by summing **weighted institutional drivers**. Each driver
votes BULL or BEAR; the card shows every active ✓ reason.

| Driver group | Source | Max pts | Bull condition / Bear condition |
|--------------|--------|---------|---------------------------------|
| OI Shift | V2 `oiShiftBias` | 18 | bullishPct ≥ 60 / ≤ 40 |
| PE Writing | V2 `flow.oi` | 8 | peWriting |
| CE Unwinding | V2 `flow.oi` | 8 | ceUnwinding |
| CE Writing | V2 `flow.oi` | 8 | — / ceWriting |
| PE Unwinding | V2 `flow.oi` | 8 | — / peUnwinding |
| Delta Flow | V2 `flow.delta` | 14 | deltaPct > 8 / < −8 |
| Futures Premium | V2 `futures` | 8 | > +5 / < −5 |
| Breadth | V2 `breadth` | 14 | ≥ 58 / ≤ 42 |
| FRVP Acceptance | V6 `auctionEngine` | 16 | Above VAH / Below VAL |
| CPR Location | V6 `cprEngine` | 10 | Above TC / Below BC |
| PCR | V2 `flow.oi` | 6 | ≥ 1.15 / ≤ 0.85 |

```
bullConviction = round(activeBullPts / maxBullPts × 100)
bearConviction = round(activeBearPts / maxBearPts × 100)
side = bull > bear+5 ? BULL : bear > bull+5 ? BEAR : NEUTRAL
conviction = the dominant side's %
```

**Tiers:** `0-20 NO CONVICTION · 20-40 WEAK · 40-60 BUILDING · 60-80 STRONG · 80-100 AGGRESSIVE`.

---

## 3. Engine 2 — Premium Expansion Probability (PEP)

Conviction says *where* positioning leans; PEP says whether the option will actually
**pay**. It fuses conviction with V6's premium-behaviour layers:

```
pep  = conviction/100 × 35                      // positioning strength (0..35)
     + clamp(V6 premiumExpansion.score × 0.30)  // V6 premium-expansion (0..30)
     + greeksAgree ? 15 : (neutral ? 6 : 0)     // V6 greeks side confirms conviction
     + strikeAgree ? 12 : (ready ? 0 : 6)        // V6 strike momentum confirms
     + gammaExpansion ? 8 : gammaDecay ? 0 : 4   // dealer gamma tailwind
pep = clamp(round(pep), 0, 100)
```
- `greeksAgree` = V6 greeks side matches conviction side.
- `strikeAgree` = V6 strike-momentum side matches conviction side.
- `gammaExpansion` = V6 dealer gamma regime = EXPANSION.

---

## 4. Engine 3 — Expected Premium Behavior

| Condition | Output |
|-----------|--------|
| PEP ≥ 80 & not decaying | **EXPLOSIVE {CE/PE} EXPANSION** |
| PEP ≥ 60 | **HEALTHY {CE/PE} EXPANSION** |
| PEP ≥ 40 | **SLOW / CHOPPY PREMIUM** |
| PEP < 40 | **WEAK / DEAD PREMIUM** (or *IV CRUSH RISK* if gamma decay) |

---

## 5. Bridge Verdict (readiness-gated decision tree)

The bridge is stricter than either engine alone. The decision tree (per the
gatekeeper design):

| Step | Condition | Verdict |
|------|-----------|---------|
| 0 | **Market Readiness < 50** | **NO TRADE** (environment unfit — premium never evaluated) |
| 1 | Readiness OK, conviction NEUTRAL or < 40 | **WAIT** (positioning uncommitted) |
| 2 | Readiness OK, PEP < 40 | **AVOID** (premium won't expand → trap) |
| 3 | Readiness OK, conviction ≥ 60, PEP ≥ 60, **V6 gate CONFIRMED**, Buyer Quality ≥ 60 | **BUY CE / BUY PE** |
| 4 | Same but Buyer Quality < 60 | **WAIT** (premium not responding yet) |
| 5 | Same but V6 gate not confirmed | **BUY CE/PE (await V6)** — PREP |
| 6 | otherwise | **BUILDING CE / BUILDING PE** — WATCH |

This is the gatekeeper in action:
```
Market Readiness < 50           → NO TRADE
Readiness OK · Quality < 60     → WAIT
Readiness OK · Quality ≥ 60 ·
  conviction + premium + V6 gate → BUY CE / BUY PE
```

---

## 6. Response Shape

```jsonc
{
  "ok": true, "version": "bridge", "symbol", "date", "isToday", "at",
  "header":     { spot, change, changePct, vix },
  "marketReadiness": { score, status, tone, ok,                    // Engine 0 — gatekeeper
                       sections: [ { key, score, max, items:[{ok,pts,label}] } ], interpretation },
  "conviction": { side, value, bull, bear, tier, tone },
  "premium":    { probability, expectedBehavior, tone, pexScore, pexState,
                  gammaRegime, gammaPremium, greeksAgree, strikeAgree, gammaExpansion },
  "drivers":    [ { label, side } ],          // active ✓ reasons (winning side)
  "allDrivers": [ { label, side, pts, active } ],
  "verdict":    { action, label, tone, rationale, v6Gate, v6Setup },
  "flowStages": [ { stage, source, value, tone } ],   // Readiness→Positioning→Conviction→Premium→Decision
  "sources":    { v2: { oiShiftSide, oiShiftBullPct, marketView, pcr, deltaPct, breadthPct, futPremium },
                  v6: { setup, netScore, alignment, grade, greeksSide, strikeMomentum, auctionZone, buyerQuality } },
  "goldenRule": "READINESS → POSITIONING → CONVICTION → PREMIUM EXPANSION → DECISION"
}
```

---

## 7. Frontend

`src/routes/intel-bridge.tsx` (polls 3s live / once historical):
- **Flow Diagram** — the 5 stages Readiness → Positioning → Conviction → Premium → Decision.
- **Market Readiness** — score /100, GATE OPEN/BLOCKED badge, the 4 section bars (Structure/Flow/Participation/Risk) with active checks, interpretation.
- **Conviction Meter** — bull/bear bars + 5-tier scale.
- **Premium Expansion** — PEP score + expected behavior + greeks/strike/gamma confirm chips.
- **Drivers** — the ✓ institutional reasons.
- **Verdict** — bridge action + V6 gate badge + rationale.
- **Sources** — side-by-side V2 positioning vs V6 decision (incl. Buyer Quality) reference.

---

## 8. Live Output Snapshot (NIFTY 50 · 2026-05-27)

```jsonc
{
  "ok": true, "version": "bridge", "symbol": "NIFTY_50",
  "header":     { "spot": 23924.25, "changePct": 0.02 },
  "marketReadiness": { "score": 90, "status": "EXCELLENT", "ok": true,
    "sections": [
      { "key": "STRUCTURE",     "score": 30, "max": 30 },   // Above VWAP · Above AVWAP · Outside Value
      { "key": "FLOW",          "score": 30, "max": 30 },   // Delta Strong · CVD Aligned · Futures Premium
      { "key": "PARTICIPATION", "score": 10, "max": 20 },   // Heavyweights Aligned (breadth 56% not decisive)
      { "key": "RISK",          "score": 20, "max": 20 }    // Low Trap · Trend Day
    ],
    "interpretation": "Institutional participation present. Trend structure healthy. Premium expansion environment favorable. Proceed to Option Buyer Engine." },
  "conviction": { "side": "BULL", "value": 37, "bull": 37, "bear": 10, "tier": "WEAK" },
  "premium":    { "probability": 39, "expectedBehavior": "WEAK / DEAD PREMIUM",
                  "pexScore": 35, "pexState": "DECAYING", "gammaRegime": "NEUTRAL GAMMA",
                  "greeksAgree": false, "strikeAgree": false, "gammaExpansion": false },
  "drivers":    [ { "label": "Positive Delta Flow (real buying)", "side": "BULL" },
                  { "label": "Futures Premium (institutions paying up)", "side": "BULL" },
                  { "label": "Acceptance Above VAH", "side": "BULL" } ],
  "verdict":    { "label": "WAIT", "action": "WAIT", "v6Gate": "PENDING",
                  "rationale": "Environment ready, but institutional positioning not yet committed." },
  "flowStages": [ { "stage": "READINESS", "source": "BRIDGE", "value": "90/100 · EXCELLENT" },
                  { "stage": "POSITIONING", "source": "V2", "value": "BALANCED OI" },
                  { "stage": "CONVICTION", "source": "BRIDGE", "value": "BULL 37% · WEAK" },
                  { "stage": "PREMIUM", "source": "BRIDGE", "value": "39% · WEAK / DEAD PREMIUM" },
                  { "stage": "DECISION", "source": "V6", "value": "WAIT" } ],
  "sources": {
    "v2": { "oiShiftSide": "BALANCED", "oiShiftBullPct": 45, "marketView": "Slightly Bearish",
            "pcr": 0.92, "deltaPct": 26.59, "breadthPct": 56, "futPremium": 85.75 },
    "v6": { "setup": "BULLISH BIAS", "netScore": 38, "alignment": "4 / 7 ALIGNED", "grade": "C",
            "greeksSide": "NEUTRAL", "strikeMomentum": "WARMING UP", "auctionZone": "ABOVE VALUE",
            "buyerQuality": 20 }
  },
  "goldenRule": "READINESS → POSITIONING → CONVICTION → PREMIUM EXPANSION → DECISION"
}
```

> Reading it: **Market Readiness is 90/100 (EXCELLENT) — the gate is OPEN** (structure
> 30/30, flow 30/30, risk 20/20; participation only 10/20 because breadth at 56% isn't
> decisive). The environment is fit for option buying. But the bridge still returns
> **WAIT**, because the next layers aren't there yet: conviction is only **BULL 37%
> (WEAK)** (OI shift balanced), premium expansion is **39%** (greeks/strike unconfirmed,
> gamma neutral → DEAD premium), and V2 Buyer Quality is **20/100**. So a healthy
> *environment* alone doesn't trigger a trade — the gatekeeper opens the door, but
> conviction + premium must still line up. Had readiness been < 50, the verdict would be
> **NO TRADE** and premium would never be evaluated.

---

*This dashboard is for educational purposes only. Always consult a financial advisor
before trading.*
