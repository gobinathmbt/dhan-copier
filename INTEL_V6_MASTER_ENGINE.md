# INTEL V6 — NIFTY MASTER ENGINE DASHBOARD

> **GREEKS + CPR + BREADTH + IT ENGINE → one institutional master verdict.**
>
> **Golden Rule:** *Breadth tells the truth · CPR tells the location · Greeks confirm the strength.*

This document explains **every function and every piece of logic** used in the Intel V6
Master Engine Dashboard — the data it consumes, the thresholds for each engine, the
weighted scoring, the greeks-gated verdict, and how the frontend renders it.

> **v4 upgrade note (premium-behaviour layers):** V6 now adds three more
> institutional layers that directly measure **premium expansion** — the core
> objective of an option buyer:
> **L5.5 Strike Momentum (ATM ± 2)**, **L6.5 Dealer Gamma Regime**, and a
> **Time-of-Day Engine** (confidence multiplier). Alignment expanded from 6 → **7
> directional engines**, and the verdict is now **time-aware** (theta-zone blocks
> fresh buys).
>
> **New weighted decision (premium-aware):**
> `Auction 18 · Breadth 20 · CPR 18 · Flow 10 · Strike-Momentum 15 · Greeks 12 ·
> IT 8 · VIX 7 · Gamma 10` (nominal sum 118; net score normalised to ±100). Premium-
> behaviour layers (Strike Momentum + Greeks + Flow = 37) now outweigh any single
> structural engine.
>
> **Final Verdict gating:** directional condition **+** greeks confirm **+** ≥ 4/7
> aligned **+** buyer-friendly time-of-day → BUY SETUP; otherwise it stays a BIAS.
>
> **v3 upgrade note (institutional layering):** V6 added three layers on top of the
> prior engines — **L0 Auction (FRVP)**, **L4 Flow Confirmation**, and
> **L7 Alignment Engine** — plus **heavyweight leadership** in Breadth, a
> **CPR + FRVP alignment** read, and a **Premium Expansion Score** in Greeks. The
> Final Verdict became both **greeks-gated AND alignment-graded**.
>
> **Layer stack (current):** L0 Auction → L1 Breadth(+Leadership) → L2 IT →
> L3 CPR(+FRVP align) → L4 Flow → L5 Greeks(+Premium Expansion) →
> **L5.5 Strike Momentum** → L6 VIX → **L6.5 Dealer Gamma** → **L7 Alignment (0–7)** →
> L8 Logic Matrix → L9 Final Verdict (greeks-gated · align-graded · time-aware).
>
> **Earlier upgrades retained:** true CPR value migration (today TC&BC vs yesterday),
> finer breadth tiers (56% = Mild Bull), CE-vs-PE greeks dominance, Market Character
> engine, greeks-gated verdict.

---

## 1. Architecture Overview

```
FRONTEND  src/routes/intel-v6.tsx
   └─ useIntelV6Decision()  (src/hooks/useIntelV6Decision.ts, polls 3s)
   └─ types: src/lib/intelV6Types.ts
                       │ GET /api/intel-v6/decision?symbol=&date=
                       ▼
BACKEND   routes/intelV6.routes.js → controllers/intelV6.controller.js
   └─ services/intelV6.service.js   ← all logic
         └─ consumes intelV2.service.getSnapshot()
         └─ reads intelV2.__internals for YESTERDAY's CPR
```

V6 does **not** fetch raw market data. It calls `intelV2.getSnapshot({ symbol, date })`
(candles, option chain, breadth, CPR, VIX, futures, greeks already computed) and
re-interprets it into 6 weighted engines + 2 helper engines + a greeks-gated verdict.

**Endpoint:** `GET /api/intel-v6/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]`
- `symbol` — `NIFTY_50` (default) or `SENSEX`
- `date` — omit for **live**, supply `YYYY-MM-DD` for **historical replay**

---

## 2. Files & Roles

| File | Role |
|------|------|
| `backend/src/services/intelV6.service.js` | All engine logic + `getDecision()` |
| `backend/src/controllers/intelV6.controller.js` | HTTP wrapper (query params → service) |
| `backend/src/routes/intelV6.routes.js` | Registers `GET /decision` |
| `backend/src/app.js` | Mounts router at `/api/intel-v6` |
| `src/lib/intelV6Types.ts` | TypeScript response contract |
| `src/hooks/useIntelV6Decision.ts` | Polling data hook |
| `src/routes/intel-v6.tsx` | The dashboard UI |

---

## 3. Backend Helper Functions

- **`_safe(n, d=0)`** — coerce to finite number, else default `d`.
- **`_round(n, d=2)`** — round to `d` decimals (0 if non-finite).
- **`_clamp(n, lo, hi)`** — constrain to `[lo, hi]`.
- **`_session(isToday, dateStr)`** — builds header `dateLabel` (`DD MON YYYY`) and IST
  12-hour `time`.

### Engine weights
```js
WEIGHTS = { breadth: 30, cprLocation: 25, cprRelation: 15, it: 10, greeks: 10, vix: 10 }  // sum = 100
```

### `_yesterdayCpr(symbolKey, usedDate)`  ← key upgrade
Computes **yesterday's CPR** so the engine can detect *true value migration*:
1. Today's CPR is built from the **prior** trading day's OHLC (inside V2).
2. So yesterday's CPR = CPR built from the **day-before-prior** OHLC.
3. Uses `intelV2.__internals._previousTradingDay` twice, reads that day's 5-minute
   candles with `_readCandlesFile`, derives OHLC, and runs `_cprFromOHLC`.
4. Returns `{ tc, bc, pivot, … }` or `null` when history isn't recorded.

---

## 4. Greeks Trend Detection (history-based)

Greeks are rate-of-change signals; one snapshot can't show rising/falling. V6 keeps a
rolling history **per side (CE & PE)**.

- `_greekHistory: Map<symbol, Array<{ t, ceDelta, peDelta, ceGamma, peGamma, ceVega, peVega, ceTheta, peTheta, ceIv, peIv }>>`
- `GREEK_HISTORY_MAX = 80`, `GREEK_TTL_MS = 30 min`
- **`_pushGreekHistory(symbol, sample)`** — appends now-stamped sample, evicts > 30 min
  old, trims to 80, returns the list.
- **`_trend(list, key, eps, useAbs=false)`** — needs ≥ 4 samples; compares avg of oldest
  third vs newest third; `drift ≥ eps → RISING`, `≤ −eps → FALLING`, else `FLAT`.
  `useAbs` compares magnitudes (gamma/vega/theta/delta-magnitude).

Per-greek epsilon: delta `0.01` · gamma `0.00003` · vega `0.1` · IV `0.1` · theta `0.4`.

> On a single historical fetch all trends read `FLAT`; they become meaningful after
> several live polls fill the buffer.

---

## 5. IT Sector Membership
```js
IT_MEMBERS = {
  NIFTY_50: ['INFY','TCS','HCLTECH','WIPRO','TECHM'],
  SENSEX:   ['INFY','TCS','HCLTECH','TECHM'],
}
```

---

## 6. `getDecision({ symbol, date })`

Single async entry. Calls `intelV2.getSnapshot`; on failure returns
`{ ok:false, error:'V2 snapshot unavailable', version:'v6' }`.

Inputs pulled from V2: `spot`, `spotChange/Pct`, `vix`/`vixChangePct`, `cpr`, `breadth`,
`atmCall/atmPut`, `atm`, `ladder`, `priorClose`.

---

## 7. Engine 1 — MARKET BREADTH ENGINE *(weight 30%)*

`breadthPct = round(advancing / total × 100)`.

**Finer institutional tiers** (the key fix — 56% is Mild Bull):

| Breadth % | Zone | Tone |
|-----------|------|------|
| ≥ 75 | EXTREME BULL | strongbull |
| 65 – 75 | STRONG BULL | strongbull |
| 55 – 65 | **MILD BULL** | bull |
| 45 – 55 | NEUTRAL | neutral |
| 35 – 45 | MILD BEAR | bear |
| 25 – 35 | STRONG BEAR | strongbear |
| < 25 | EXTREME BEAR | strongbear |

**Bias:** `≥ 55 → BULLISH`, `< 45 → BEARISH`, else `NEUTRAL`.
Output: counts, `pct`, `formula`, `zone`, `tone`, `bias`, 7-row `scale[]`.

---

## 8. Engine 2 — IT SECTOR STRENGTH *(weight 10%)*

`itChangePct = average % change of IT_MEMBERS` (from breadth `allStocks`).

| IT avg % | Zone | Tone |
|----------|------|------|
| > +1.5 | STRONG SUPPORT | strongbull |
| +0.5..+1.5 | SUPPORT | bull |
| −0.5..+0.5 | NEUTRAL | neutral |
| −1.5..−0.5 | DRAG | bear |
| < −1.5 | HEAVY DRAG | strongbear |

**Bias:** `≥ +0.5 BULLISH`, `≤ −0.5 BEARISH`, else NEUTRAL.
Summary: `IT SUPPORTING / DRAGGING / NEUTRAL ON INDEX`.

---

## 9. Engine 3 — CPR ENGINE *(Location 25% · Relationship 15%)*

### 9.1 CPR Width (`cpr.widthClass`)
`narrow → NARROW (Big Move Expected)` · `wide → WIDE (Range bias)` · `normal → NORMAL`.

### 9.2 Price Location (25%)
`spot > tc → ABOVE TC / BULL / BULLISH` · `spot < bc → BELOW BC / BEAR / BEARISH` ·
else `INSIDE CPR / NEUTRAL`. Summarised in `locationBanner`.

### 9.3 CPR Relationship — TRUE value migration (15%)  ← key upgrade
Compares **today's TC & BC** to **yesterday's TC & BC** (`_yesterdayCpr`):
- `tc > yTC` **and** `bc > yBC` → **HIGHER VALUE CPR** (Bullish Structure)
- `tc < yTC` **and** `bc < yBC` → **LOWER VALUE CPR** (Bearish Structure)
- mixed → **OVERLAPPING CPR** (Neutral / Indecision)
- `method: 'tc-bc'`.

**Fallback** (`method: 'pivot-fallback'`) when yesterday's CPR isn't recorded: compares
`pivot` vs `priorClose` (the original, weaker heuristic). The UI flags this with a small
"pivot proxy" note.

### 9.4 Levels & Opening map
Exposes `r3, tc, pivot, bc, s3` (+ `r1,r2,s1,s2`) and `yesterday {tc,bc,pivot}`. The
**Opening Scenario Engine** maps Gap-Up / Flat / Gap-Down reads vs CPR with the active
cell flagged by `locationBias`.

---

## 10. Engine 4 — GREEKS ENGINE (ATM) — CE vs PE dominance *(weight 10%)*  ← key upgrade

Instead of one ATM greek, V6 reads **both** ATM legs and scores each side.

**Per side inputs:** `ceDelta/peDelta`, `ceGamma/peGamma`, `ceVega/peVega`,
`ceTheta/peTheta`, `ceIv/peIv` (from the ladder ATM row). Trends via `_trend()`.

**Dominance score (0–100) per side:**
```
sideScore = clamp( |delta|×60 (cap 35)
                 + 25 if delta rising
                 + 20 if vega rising
                 + 12 if gamma rising
                 +  8 if IV rising , 0, 100)
```
`ceScore` and `peScore` computed identically.

**Dominant side:** `ceScore > peScore + 8 → CE (BULLISH)` · `peScore > ceScore + 8 → PE
(BEARISH)` · else `NEUTRAL`. Example reading: *CE Delta rising + CE Vega rising + CE
Gamma rising → Call Buyers Active.*

**Display cards** (Delta/Gamma/Vega/Theta) reflect the **dominant** side (default CE when
balanced). Theta uses magnitude: `>15 HIGH/Seller`, `8–15 MEDIUM/Neutral`,
`<8 LOW/Buyer-friendly`.

**Confirmation flags:**
- `greeksPositive` = side CE & gamma not falling & vega not falling & |theta| ≤ 15
- `greeksNegative` = side PE & gamma not falling & vega not falling & |theta| ≤ 15
- `greeksConfirm = greeksPositive || greeksNegative` (greeks taking a clean, healthy side)

Output: `side`, `bias`, `confirm`, `dominance {ceScore, peScore, ce{}, pe{}}`, the four
greek cards, and a `reading[]` (CE/PE dominance, gamma rising, vega rising, theta low).

---

## 11. Engine 6 — VIX *(weight 10%)*

`vixChangePct ≤ −1 → BULLISH (risk-on)` · `≥ +4 → BEARISH (risk-off)` · else `NEUTRAL`.
`vixTrend`: `≤ −2 FALLING` · `≥ +4 RISING` · else FLAT.

---

## 12. MARKET TREND VIEW (vote)

Majority vote of **Breadth + IT + CPR-Location** biases:
`≥ 2 bull & > bear → BULLISH`, `≥ 2 bear & > bull → BEARISH`, else `NEUTRAL`.
Renders three rows (Bullish / Range-Neutral / Bearish) with the winner active.

---

## 13. MARKET CHARACTER ENGINE  ← new (Breadth + CPR Width + VIX)

Classifies the **type of day**, evaluated in priority order:

| Output | Condition |
|--------|-----------|
| **PANIC DAY** | `vixChangePct ≥ 8` and `breadth < 40` |
| **EXPANSION DAY** | CPR `NARROW` and breadth strong (≥ 65 or ≤ 35) |
| **TREND DAY** | breadth strong and CPR location not neutral |
| **SHORT COVERING DAY** | breadth ≥ 55 and VIX falling and location bullish |
| **RANGE DAY** | CPR `WIDE`, or breadth 45–55, or neutral location |
| **NORMAL DAY** | none of the above |

Output: `label`, `desc`, `tone`, and `inputs {breadthPct, cprWidth, vix, vixChangePct, vixTrend}`.

---

## 14. MARKET MODE

`RISK ON` when `(breadth BULLISH or trend BULLISH)` and `vixChangePct ≤ 5`;
`RISK OFF` when breadth BEARISH; else `NEUTRAL`. Shown in header with 🐂/🐻/•.

---

## 15. Engine 5 — WEIGHTED LOGIC MATRIX  ← upgraded to weighted scoring

Each engine contributes its **weight** signed by its bias:
```
contrib(bias, w) = +w if BULLISH, −w if BEARISH, 0 if NEUTRAL

netScore = contrib(breadth,30) + contrib(cprLocation,25) + contrib(cprRelation,15)
         + contrib(it,10) + contrib(greeks,10) + contrib(vix,10)         // range −100..+100
```

**Condition bias:** `netScore ≥ +20 → BULLISH`, `≤ −20 → BEARISH`, else `NEUTRAL`.

**Market Condition label** (by `absNet = |netScore|`):
- BULLISH: `≥60 BULLS IN CONTROL` · `≥35 BULLISH TILT` · else `MILD BULLISH`
- BEARISH: mirror
- NEUTRAL: `MIXED SIGNALS — WAIT FOR ALIGNMENT`

**Matrix rows** carry `engine`, `weight`, `value`, `verdict`, `tone` for all six engines
(Greeks shows `CE x / PE y`). **Logic Summary** ticks each engine that's taking a side
(non-neutral); greeks tick uses `greeksConfirm`. `alignText` shows
`ALL SYSTEMS ALIGN` or `N / 6 ALIGNED`.

---

## 16. Engine 6 — FINAL VERDICT (greeks-gated)  ← key upgrade

- **Confidence /10:** `clamp(round(3 + absNet/100 × 6 + (vix<14 ? 0.5 : 0)), 1, 10)`
- **Stars:** `clamp(round(absNet/20), 1, 5)`
- **Strength:** `absNet ≥60 STRONG · ≥35 MODERATE · ≥20 MILD · else WEAK`

**Greeks gate** (prevents false BUY signals):

| conditionBias | greeksBias | Setup | Gate | Trade Plan |
|---------------|-----------|-------|------|------------|
| BULLISH | BULLISH | **CE BUY SETUP** | CONFIRMED | BUY CE ON DIP / ON CONFIRMATION |
| BULLISH | not bullish | **BULLISH BIAS** | PENDING | AWAIT GREEKS CONFIRMATION |
| BEARISH | BEARISH | **PE BUY SETUP** | CONFIRMED | BUY PE ON RISE / ON CONFIRMATION |
| BEARISH | not bearish | **BEARISH BIAS** | PENDING | AWAIT GREEKS CONFIRMATION |
| NEUTRAL | — | **NO TRADE SETUP** | N/A | WAIT FOR ALIGNMENT |

> So *Breadth bullish + Above TC + Mixed Greeks* now shows **BULLISH BIAS (gate pending)**
> — **not** a CE BUY SETUP. The CE/PE buy setup appears only when greeks confirm.

**Verdict cells:** TREND (trend vote), STRENGTH (absNet tier), MOMENTUM (dominant-side
gamma trend → RISING/FADING/STEADY), CHARACTER (Market Character label).

---

## 17. Response Shape

```jsonc
{
  "ok": true, "version": "v6", "symbol", "displayName", "date", "isToday", "at",
  "header":        { date, time, indexName, spot, change, changePct, vix, vixChangePct, marketMode },
  "breadthEngine": { advancing, declining, unchanged, total, pct, formula, zone, tone, bias, scale[] },
  "itEngine":      { changePct, members[], zone, tone, bias, summary, scale[] },
  "cprEngine":     { width, widthPct, levels, yesterday, priceLocation, territory,
                     locationSub, locationBias, locationBanner, relation{…,method}, alignment, opening },
  "auctionEngine": { poc, vah, val, spot, zone, bias, desc, priceAbovePocPct, acceptance, scale[] },
  "flowEngine":    { bias, label, deltaPct, futPremium, buyersPct, components[], desc },
  "strikeMomentum":{ ready, score, ceScore, peScore, side, bias, state, tone, strikes[], desc },   // L5.5 (new)
  "gammaRegime":   { regime, premium, bias, tone, score, atmGamma, desc },                          // L6.5 (new)
  "timeOfDay":     { phase, label, multiplier, tone, buyerFriendly, desc },                         // (new)
  "trendView":     { active, rows[] },
  "greeksEngine":  { side, bias, confirm, dominance{ceScore,peScore,ce,pe},
                     delta, gamma, vega, theta, premiumExpansion, allPositive, reading[] },
  "marketCharacter": { label, desc, tone, inputs },
  "alignmentEngine": { count, total(7), dominantSide, grade, gradeLabel, tone, text, rows[] },
  "logicMatrix":   { netScore, weights(9), rows[], condition, conditionBias, summary[], allAlign, alignText },
  "finalVerdict":  { setup, bias, greeksGate, netScore, stars, confidence, confidenceText,
                     quality{alignment,grade,gradeLabel,premiumState,flowState,auctionZone,
                             strikeMomentum,gammaRegime,timePhase,timeMultiplier}, cells[], tradePlan },
  "goldenRule": "...",
  "debug": { netScore, rawNet, baseNet, alignBull, alignBear, alignCount, dominantSide, prelimBias,
             greeksGate, greeksSide, ceScore, peScore, premiumScore, strikeMomentumScore,
             gammaRegime, gammaBias, timePhase, timeMultiplier, … }
}
```
On failure: `{ ok:false, error, version:'v6' }`.

---

## 18. Frontend (`src/routes/intel-v6.tsx`)

Auth-guarded full-screen dashboard. Header has symbol toggle, date picker, LIVE button,
refresh. **`useIntelV6Decision`** polls every 3s in live mode (pauses when tab hidden),
fetches once for a historical date; exposes `{ data, loading, error, lastFetchAt, refetch }`.

| Component | Renders |
|-----------|---------|
| `MasterDashboard` | Overall grid (Title · Row0 Auction/Flow/Alignment · Row A · Greeks · **Strike-Momentum/Gamma/Time row** · Market Character · Logic+Verdict · Golden Rule) |
| `TitleBar` | Date/time · title + index quote + VIX · Market Mode |
| `AuctionEngine`+`LevelChip` | **L0 FRVP** — price location vs VAH/POC/VAL + acceptance/trap badge |
| `FlowEngine` | **L4** — FLOW BULLISH/BEARISH + Delta · Fut Prem · Buyers components |
| `AlignmentEngine` | **L7** — n/7 count + grade (Institutional/High/Tradable/Watch) + per-engine ✓/✗ grid |
| `BreadthEngine`+`Gauge`+`Stat` | Adv/Dec/Unch, % gauge, 7-tier scale + **heavyweight leadership row** |
| `ItEngine` | NIFTY IT % + scale + summary |
| `CprEngine`+`LevelRow`+`OpeningCol` | Width, levels, price location, opening map + **CPR+FRVP alignment badge** |
| `CprRelationship` | Value migration + **today vs yesterday TC/BC table** |
| `TrendView` | 3-row trend vote |
| `GreeksEngine`+`GreekCard`+`GreeksReading`+`PremiumExpansionBar` | **CE/PE dominance bar** + **Premium Expansion Score bar** + 4 greek cards + reading |
| `StrikeMomentumPanel` | **L5.5** — ATM±2 score + per-strike CE/PE momentum bars (warming-up aware) |
| `GammaRegimePanel` | **L6.5** — Dealer gamma regime + premium expansion/decay read |
| `TimeOfDayPanel` | Session phase + confidence multiplier + buyer-friendly flag |
| `MarketCharacter` | Day-type badge + breadth/CPR/VIX inputs |
| `LogicMatrix` | 9 weighted rows (weight badges) + **net-score bipolar bar** + summary |
| `FinalVerdict`+`Stars`+`QualityCell` | Setup + **Greeks Gate badge** + confidence + **quality block (alignment·premium·flow + strike-momentum·gamma·time-phase)** + 4 cells + trade plan |
| `GoldenRule` | Footer banner |
| `ScaleTable` | Shared range→label rows |

**Tone → colour (`TONE`/`tc()`):** strongbull `#16c784` · bull `#22c55e` · neutral
`#eab308` · bear `#f97316` · strongbear `#ef4444`.

**Layout:** `main` uses `overflow-y-auto`; rows use `items-stretch`; right column gives
CPR Relationship natural height (`shrink-0`) and Trend View the rest (`flex-1`).

---

## 19. Quick Reference — All Thresholds

```
WEIGHTS:     Auction 18 · Breadth 20 · CPR 18 · Flow 10 · Strike-Momentum 15 · Greeks 12 · IT 8 · VIX 7 · Gamma 10  (Σ=118)

AUCTION:     spot>VAH ABOVE/Bull · spot<VAL BELOW/Bear · else INSIDE/Neutral (vote); rejected=trap→Neutral
BREADTH %:   ≥75 ExtBull · 65-75 StrongBull · 55-65 MildBull · 45-55 Neutral
             35-45 MildBear · 25-35 StrongBear · <25 ExtBear
             bias: ≥55 BULLISH · <45 BEARISH ; LEADERSHIP from heavyweight impact (CONFIRMED/DIVERGENT)

IT AVG %:    >1.5 SSupport · 0.5..1.5 Support · ±0.5 Neutral · -1.5..-0.5 Drag · <-1.5 HDrag
CPR LOC:     spot>TC ABOVE(Bull) · spot<BC BELOW(Bear) · else INSIDE(Neutral)
CPR REL:     today TC&BC vs yesterday → HIGHER/LOWER/OVERLAP (fallback pivot vs priorClose)
CPR ALIGN:   Above TC+Above VAH STRONG BULL · Above TC+inside WEAK BULL (mirror bear); CPR vote = majority of loc+rel+align
CPR WIDTH:   narrow NARROW · wide WIDE · normal NORMAL

FLOW:        2-of-3 vote — Delta(>±8) · FutPrem(>±5) · Buyers%(≥58/≤42)

STRIKE MOM:  ATM±2; per side: premium%Δ(≤40)+OI%Δ(≤25)+freshOI(15)+vol(≤20) → avg CE vs PE
             80+ INSTITUTIONAL · 60+ BUILDING · 40+ NEUTRAL · <40 DECAY (history-based)

GREEKS:      sideScore = |Δ|×60(cap35) + 25(Δ↑) + 20(V↑) + 12(Γ↑) + 8(IV↑); CE>PE+8 → CE/BULL
             PREMIUM EXPANSION = Δ↑35 + Γ↑25 + V↑25 + Θlow15 → ≥65 EXPANDING · ≥40 NEUTRAL · <40 DECAYING
THETA |x|:   >15 HIGH/Seller · 8-15 MED/Neutral · <8 LOW/Buyer
TREND eps:   Δ .01 · Γ .00003 · V .1 · IV .1 · Θ .4  (gamma/vega/theta abs)

VIX:         chg≤-1 BULLISH · ≥+4 BEARISH; trend ≤-2 FALLING · ≥+4 RISING
DEALER GAMMA: score from move/CPR-width/VIX/character → ≥+2 NEG-GAMMA/EXPANSION (votes WITH bias)
             ≤-2 POS-GAMMA/DECAY (votes AGAINST) · else NEUTRAL  (amplifier, 2nd pass)
TIME-OF-DAY: 09:15-10:15 ×1.15 · 10:15-12:00 ×1.00 · 12:00-14:00 ×0.80(theta) · 14:00-15:30 ×1.10 · pre/post ×0.70

TREND VIEW:  ≥2 of {Breadth, IT, CPR-Loc} agree
CHARACTER:   Panic / Expansion / Trend / Short-Cover / Range / Normal (priority order)
MARKET MODE: (Bull breadth/trend & VIXchg≤5) RISK ON · Bear breadth RISK OFF · else NEUTRAL

NET SCORE:   pass1 = Σ contrib(bias,weight) w/o gamma → prelimBias; pass2 += gamma; netScore = round(rawNet/118×100)
CONDITION:   ≥+20 BULLISH · ≤-20 BEARISH · else NEUTRAL ; |net| ≥60 HIGH CONVICTION · ≥35 TILT · ≥20 MILD
ALIGNMENT:   7 engines (FRVP,Breadth,CPR,Flow,Strike,Greeks,VIX); 7/7 A+ · 6/7 A · 5/7 B · 4/7 C · <4 D
VERDICT:     condition + greeks CONFIRM + align≥4/7 + buyer-friendly time → BUY SETUP; else BIAS
CONFIDENCE:  clamp((3 + |net|/100×4 + alignCount/7×2.5 + (VIX<14?0.5:0)) × timeMultiplier, 1, 10)
STARS:       clamp(round(alignCount/7 × 5), 1, 5)
```

---

## 20. v3 Institutional Layers (detailed)

### L0 — Auction Structure Engine (FRVP) · weight 18
**Answers "where is price?" before "who is buying?".** Reads POC / VAH / VAL (from V2
`flow.volume` or the FRVP institutional engine profile) + acceptance/rejection.
- `spot > VAH` → **ABOVE VALUE** → BULLISH (NEUTRAL if rejected above VAH = bull trap)
- `spot < VAL` → **BELOW VALUE** → BEARISH (NEUTRAL if rejected below VAL = bear trap)
- else → **INSIDE VALUE** → leans by POC half, but **votes NEUTRAL** (rotational).
- Exposes acceptance flags: acceptedAboveVAH / acceptedBelowVAL / rejected (trap) flags.

### Breadth + Heavyweight Leadership
Breadth still gives participation %, but now also reports **leadership** from V2
`heavyweightsTotalImpact`:
- `> +0.05 pts` → LEADERS BULLISH · `< −0.05` → LEADERS BEARISH · else MIXED.
- `status`: **CONFIRMED** (breadth == leadership), **DIVERGENT** (opposite), or **PARTIAL**.
- Catches the "breadth 60% but HDFC/ICICI/RELIANCE red" case (participation ≠ leadership).

### L3 — CPR + FRVP Alignment
Removes fake breakouts by combining CPR location with auction zone:
| CPR location | Auction | Result |
|--------------|---------|--------|
| Above TC | Above VAH | **STRONG BULL** |
| Above TC | Inside/Below | **WEAK BULL** |
| Below BC | Below VAL | **STRONG BEAR** |
| Below BC | Inside/Above | **WEAK BEAR** |
| Inside CPR | — | **NO EDGE** |

The **combined CPR bias** (location + value migration + FRVP alignment, majority vote)
drives the 18% CPR weight.

### L4 — Flow Confirmation Engine · weight 10
Fuses three real-flow reads (majority vote, ≥2 agree):
- **Delta** — V2 `flow.delta.deltaPct`: `>+8 bull`, `<−8 bear`.
- **Futures Premium** — `>+5 bull`, `<−5 bear`.
- **Buyer/Seller flow** — avg CE+PE buyers% from V2 `buyerSellerFlow`: `≥58 bull`, `≤42 bear`.
Output: FLOW BULLISH / BEARISH / NEUTRAL.

### L5 — Greeks + Premium Expansion Score
On top of CE-vs-PE dominance, a single readable **Premium Expansion Score (0–100)** for
the dominant side:
`Delta rising 35 + Gamma rising 25 + Vega rising 25 + Theta low(≤8) 15` (flat trends get
partial credit). → **EXPANDING ≥65 · NEUTRAL ≥40 · DECAYING <40.**

### L7 — Alignment Engine (the headline read)
Counts how many of the directional engines agree with the dominant side. **v4 expanded
this from 6 → 7 engines** (FRVP, Breadth, CPR, Flow, **Strike Momentum**, Greeks, VIX):
- **7/7 → INSTITUTIONAL SETUP (A+)** · **6/7 → HIGH CONVICTION (A)** ·
  **5/7 → TRADABLE (B)** · **4/7 → WATCH (C)** · **<4 → NO TRADE (D)**.
Shown as a per-engine ✓/✗ grid. *(Dealer Gamma is not counted as a directional vote —
it amplifies the prevailing side in the weighted score instead.)*

### Weighted Net Score (normalised)
```
rawNet = Σ contrib(bias, weight)
  weights: FRVP18 Breadth20 CPR18 Flow10 StrikeMomentum15 Greeks12 IT8 VIX7 Gamma10
netScore = round(rawNet / 118 × 100)        // → ±100
condition: ≥+20 BULLISH · ≤−20 BEARISH · else NEUTRAL
```
Gamma is applied in a **second pass**: pass 1 computes the net without gamma to get the
prevailing bias, then gamma votes WITH it (expansion) or AGAINST it (decay/range).

### L9 — Final Verdict (greeks-gated + alignment-graded + time-aware)
A directional condition becomes a **BUY SETUP** only when **all**:
1. Greeks confirm the same side, **and**
2. Alignment ≥ **4/7**, **and**
3. Time-of-day is **buyer-friendly** (not the theta zone / pre/post-market).

Otherwise it stays a **BIAS** with gate `PENDING` (greeks disagree), `ALIGN-PENDING`
(greeks agree but alignment short), or a `WAIT — <PHASE>` plan in the theta zone. The
verdict carries a **quality block**:
`alignment (n/7 + grade) · premium state · flow state · auction zone · strike momentum ·
gamma regime · time phase (×mult)`.
- **Confidence /10** = `(3 + |net|/100×4 + alignCount/7×2.5 + (VIX<14 ? 0.5)) × timeMultiplier`.
- **Stars** = `round(alignCount/7 × 5)`.

### New response fields
`auctionEngine`, `flowEngine`, `alignmentEngine`, `breadthEngine.leadership`,
`cprEngine.alignment`, `greeksEngine.premiumExpansion`, `finalVerdict.quality`,
**`strikeMomentum`**, **`gammaRegime`**, **`timeOfDay`**.

### Golden Rule (updated)
> *AUCTION TELLS LOCATION · BREADTH TELLS TRUTH · FLOW + GREEKS + STRIKE MOMENTUM CONFIRM STRENGTH*

---

## 20b. v4 Premium-Behaviour Layers (detailed)

### L5.5 — Strike Momentum Engine (ATM ± 2) · weight 15
**Question:** *Are institutions accumulating ATM / ATM+1 / ATM+2 before the move shows?*
**Logic:** Snapshots the ATM ± 2 band each poll into `_strikeHistory` (30-min ring
buffer). Against a ~6-min baseline, per strike & per side it scores:
```
premium %Δ  (≥15 → 40 · ≥6 → 26 · ≥0 → 12)
+ OI %Δ      (≥5 → 25 · ≥1 → 14)
+ fresh OIΔ>0 (long buildup) → 15
+ volume      (>1L → 20 · >20k → 10)        // 0..100 per side per strike
```
Averages CE-side vs PE-side across the band → dominant side + a 0–100 score:
**80+ INSTITUTIONAL BUYING · 60+ MOMENTUM BUILDING · 40+ NEUTRAL · <40 DECAY ZONE.**
History-based → reads *WARMING UP* until the buffer fills (live only).

### L6.5 — Dealer Gamma Regime · weight 10
**Question:** *Are dealers long or short gamma (range vs trend)?*
**Logic:** We can't see dealer books directly, so infer from observable proxies already
in V2 — realised move vs CPR width, VIX direction, market character. A signed score:
```
+2 big realised move (|Δ%|≥0.5)   +1 narrow CPR   −1 wide CPR
+2 VIX rising (≥3)                 −1 VIX collapsing (≤−3)
+2 Trend/Expansion/Panic day       −2 Range day
```
- score **≥ +2 → NEGATIVE GAMMA / EXPANSION** (dealers hedge *with* the move → premium
  expands → great for buyers).
- score **≤ −2 → POSITIVE GAMMA / DECAY** (dealers hedge *against* → range / theta bleed).
- else **NEUTRAL GAMMA / MIXED**.
The regime is **not directional by itself** — it *amplifies* the prevailing bias
(expansion votes WITH it, decay votes AGAINST it / fades the move).

### Time-of-Day Engine · confidence multiplier (not a vote)
**Question:** *Is this the right session window to buy?* Option buying behaves
differently by phase, so the same score isn't equal at 09:25 vs 12:30.
| IST window | Phase | Multiplier | Buyer-friendly |
|------------|-------|-----------|----------------|
| 09:15–10:15 | OPENING EXPANSION | ×1.15 | ✅ |
| 10:15–12:00 | CONTINUATION | ×1.00 | ✅ |
| 12:00–14:00 | THETA ZONE | ×0.80 | ❌ (blocks fresh buys) |
| 14:00–15:30 | CLOSING EXPANSION | ×1.10 | ✅ |
| pre / post | PRE/POST MARKET | ×0.70 | ❌ |
Historical replay → neutral (×1.0). The multiplier scales final confidence; a
non-buyer-friendly phase downgrades a would-be BUY SETUP to a BIAS with a
`WAIT — <PHASE>` plan.


---

## 21. Live Output Snapshot (NIFTY 50 · 2026-05-27)

Real `GET /api/intel-v6/decision` output with the v4 layers (trimmed). The history-based
engines (Greeks trends, Strike Momentum) read warming/flat here because this was a single
historical fetch; they populate over live 3-second polling, and the Time engine reads
`HISTORICAL` (×1.0) on replay.

```jsonc
{
  "ok": true, "version": "v6", "symbol": "NIFTY_50", "date": "2026-05-27",
  "header": { "spot": 23924.25, "vix": 15.36, "vixChangePct": -7.16,
              "marketMode": { "state": "RISK ON", "bias": "BULLISH" } },

  "auctionEngine":  { "zone": "ABOVE VALUE", "bias": "BULLISH" },

  "breadthEngine":  { "pct": 56, "zone": "MILD BULL", "bias": "BULLISH",
                      "leadership": { "label": "LEADERS BULLISH", "totalImpact": 151.05,
                                      "alignment": "5/8", "status": "CONFIRMED" } },

  "cprEngine":      { "priceLocation": "BELOW BC", "relation": "OVERLAPPING CPR",
                      "alignment": "WEAK BEAR" },

  "flowEngine":     { "label": "FLOW BULLISH", "bias": "BULLISH" },

  "strikeMomentum": { "ready": false, "score": 50, "side": "NEUTRAL", "state": "WARMING UP",
                      "ceScore": 0, "peScore": 0,
                      "strikes": [ "23800", "23850", "23900*", "23950", "24000" ],
                      "desc": "Collecting ATM±2 premium history…" },

  "gammaRegime":    { "regime": "NEUTRAL GAMMA", "premium": "MIXED", "bias": "NEUTRAL",
                      "score": -1, "atmGamma": 0.001,
                      "desc": "Mixed gamma regime — no strong dealer-flow edge." },

  "timeOfDay":      { "phase": "HISTORICAL", "label": "Historical Replay",
                      "multiplier": 1, "buyerFriendly": true },

  "greeksEngine":   { "side": "NEUTRAL", "dominance": { "ceScore": 34, "peScore": 26 },
                      "premiumExpansion": { "score": 35, "state": "DECAYING", "side": "CE" } },

  "alignmentEngine":{ "count": 4, "total": 7, "dominantSide": "BULLISH",
                      "grade": "C", "gradeLabel": "WATCH", "text": "4 / 7 ALIGNED",
                      "rows": [ { "engine": "FRVP", "bias": "BULLISH", "aligned": true },
                                { "engine": "BREADTH", "bias": "BULLISH", "aligned": true },
                                { "engine": "CPR", "bias": "BEARISH", "aligned": false },
                                { "engine": "FLOW", "bias": "BULLISH", "aligned": true },
                                { "engine": "STRIKE", "bias": "NEUTRAL", "aligned": false },
                                { "engine": "GREEKS", "bias": "NEUTRAL", "aligned": false },
                                { "engine": "VIX", "bias": "BULLISH", "aligned": true } ] },

  "logicMatrix":    { "netScore": 38, "condition": "BULLISH TILT — CE SETUP FORMING",
                      "weights": { "frvp": 18, "breadth": 20, "cpr": 18, "flow": 10,
                                   "strikeMomentum": 15, "greeks": 12, "it": 8, "vix": 7, "gamma": 10 } },

  "finalVerdict":   { "setup": "BULLISH BIAS", "bias": "BULLISH", "greeksGate": "PENDING",
                      "netScore": 38, "stars": 3, "confidence": 5.9,
                      "quality": { "alignment": "4/7", "grade": "C", "gradeLabel": "WATCH",
                                   "premiumState": "DECAYING", "flowState": "BUYERS ACTIVE",
                                   "auctionZone": "ABOVE VALUE", "strikeMomentum": "WARMING UP",
                                   "gammaRegime": "NEUTRAL GAMMA", "timePhase": "Historical Replay",
                                   "timeMultiplier": 1 },
                      "tradePlan": "AWAIT GREEKS CONFIRMATION" },

  "goldenRule": "AUCTION TELLS LOCATION · BREADTH TELLS TRUTH · FLOW + GREEKS + STRIKE MOMENTUM CONFIRM STRENGTH"
}
```

> Reading it: net score **+38** (BULLISH TILT) — Auction above value, breadth mild-bull
> with leadership CONFIRMED, flow bullish, VIX risk-on. But the **verdict stays BULLISH
> BIAS, not CE BUY SETUP**, because the premium-behaviour layers don't confirm:
> **Greeks NEUTRAL** (CE 34 / PE 26, premium DECAYING → gate PENDING), **Strike Momentum
> WARMING UP** (no ATM±2 accumulation read yet), **Dealer Gamma NEUTRAL** (no expansion
> tailwind), and only **4/7 aligned (grade C WATCH)** with CPR diverging bearish. The new
> layers tighten the filter further: even a +38 structural tilt won't issue a buy until
> premium actually expands — exactly the "direction ≠ premium expansion" discipline that
> separates V6 (trade-decision engine) from V2 (market-intelligence engine).

---

*This dashboard is for educational purposes only. Always consult a financial advisor
before trading.*
