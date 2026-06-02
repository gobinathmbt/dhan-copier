# INTEL V6 — NIFTY MASTER ENGINE DASHBOARD

> **GREEKS + CPR + BREADTH + IT ENGINE → one institutional master verdict.**
>
> **Golden Rule:** *Breadth tells the truth · CPR tells the location · Greeks confirm the strength.*

This document explains **every function and every piece of logic** used in the Intel V6
Master Engine Dashboard — backend computation, the data it consumes, the thresholds for
each engine, and how the frontend renders it.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND  (TanStack route)                                       │
│  src/routes/intel-v6.tsx                                          │
│     └─ useIntelV6Decision()  ── polls every 3s ──┐                │
│  src/hooks/useIntelV6Decision.ts                 │                │
│  src/lib/intelV6Types.ts   (response typing)     │                │
└──────────────────────────────────────────────────┼───────────────┘
                                                    │  GET
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKEND  (Express)                                               │
│  routes/intelV6.routes.js  →  GET /api/intel-v6/decision          │
│  controllers/intelV6.controller.js                                │
│  services/intelV6.service.js   ← all the logic lives here         │
│        └─ consumes intelV2.service.getSnapshot()                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key principle:** V6 does **not** fetch raw market data itself. It calls
`intelV2.getSnapshot({ symbol, date })` (which already loads candles, option chain,
breadth, CPR, VIX, futures, greeks) and *re-interprets* that snapshot into 6 decision
engines. This keeps V6 deterministic and consistent with the rest of the platform.

**Endpoint:** `GET /api/intel-v6/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]`
- `symbol` — `NIFTY_50` (default) or `SENSEX`
- `date` — optional `YYYY-MM-DD`; omit for **live**, supply for **historical replay**

---

## 2. Files & Their Roles

| File | Role |
|------|------|
| `backend/src/services/intelV6.service.js` | All engine logic + the `getDecision()` computation |
| `backend/src/controllers/intelV6.controller.js` | Thin HTTP wrapper, reads query params, calls service |
| `backend/src/routes/intelV6.routes.js` | Registers `GET /decision` |
| `backend/src/app.js` | Mounts router at `/api/intel-v6` |
| `src/lib/intelV6Types.ts` | TypeScript response contract |
| `src/hooks/useIntelV6Decision.ts` | Polling data hook |
| `src/routes/intel-v6.tsx` | The dashboard UI (all panels) |

---

## 3. Backend Helper Functions

### `_safe(n, d = 0)`
Coerces `n` to a finite number; returns the default `d` when the value is `NaN`,
`null`, `undefined`, or `Infinity`. Used everywhere to harden against missing
fields in the V2 snapshot.

### `_round(n, d = 2)`
Rounds `n` to `d` decimals. Returns `0` for non-finite input.

### `_clamp(n, lo, hi)`
Constrains `n` to the `[lo, hi]` range. Used for confidence score and star caps.

### `_fmtSigned(n, d)`
Formats a number with an explicit leading `+`/`−` sign (e.g. `+0.57`, `-16.438`).
Used for the Greeks row in the Logic Matrix.

### `_session(isToday, dateStr)`
Builds the header **date label** and **time**:
- Computes IST time as `Date.now() + 5.5h`.
- `dateLabel` → `DD MON YYYY` (e.g. `02 JUN 2026`). For historical dates it uses
  `dateStr`; for live it uses today.
- `time` → 12-hour `HH:MM AM/PM` in IST.

---

## 4. Greeks Trend Detection (history-based)

Greeks are **rate-of-change** signals — a single snapshot can't tell whether Delta
is rising or falling. V6 keeps a short rolling history per symbol.

### `_greekHistory` (Map) + constants
- `_greekHistory: Map<symbol, Array<{ t, delta, gamma, theta, vega }>>`
- `GREEK_HISTORY_MAX = 80` samples max
- `GREEK_TTL_MS = 30 min` — samples older than 30 minutes are dropped

### `_pushGreekHistory(symbol, sample)`
Appends `{ t: now, ...sample }` to the symbol's list, evicts entries older than the
TTL, trims to the max length, and returns the current list. Called once per request,
so at a 3-second poll the buffer fills with live readings over time.

### `_trend(list, key, eps, useAbs = false)`
Determines `RISING | FALLING | FLAT` for a greek series:
1. Needs at least **4 samples**, else returns `FLAT`.
2. Splits the series into thirds; compares the **average of the oldest third** to the
   **average of the newest third**.
3. `drift = newAvg − oldAvg`.
   - `drift ≥ eps` → `RISING`
   - `drift ≤ −eps` → `FALLING`
   - otherwise → `FLAT`
4. `useAbs = true` compares **magnitudes** (used for gamma/vega/theta, where the sign
   is not what matters — only whether the greek is growing).

Per-greek epsilon (sensitivity) thresholds:

| Greek | `eps` | `useAbs` |
|-------|-------|----------|
| Delta | `0.01` | no |
| Gamma | `0.00003` | yes |
| Vega  | `0.1` | yes |
| Theta | `0.4` | yes |

> **Note:** On a single historical fetch (no rolling history), all trends read `FLAT`.
> Trends become meaningful only after several live polls have accumulated.

---

## 5. IT Sector Membership

```js
IT_MEMBERS = {
  NIFTY_50: ['INFY', 'TCS', 'HCLTECH', 'WIPRO', 'TECHM'],
  SENSEX:   ['INFY', 'TCS', 'HCLTECH', 'TECHM'],
}
```
Defines which constituents count as "IT" for the IT Sector Strength Engine. The engine
averages the daily `% change` of these names from the V2 breadth `allStocks` list.

---

## 6. `getDecision({ symbol, date })` — Main Computation

The single async entry point. It calls `intelV2.getSnapshot(...)`; if the snapshot
fails it returns `{ ok: false, error: 'V2 snapshot unavailable', version: 'v6' }`.

### Inputs pulled from the V2 snapshot
| Variable | Source | Meaning |
|----------|--------|---------|
| `spot` | `v2.spot.ltp` | Index last price |
| `spotChange` / `spotChangePct` | `v2.spot.change` / `.changePct` | Day change |
| `vix` / `vixChangePct` | `v2.macro.vix.price` (fallback `dashboard.ivAnalytics.vix`) | India VIX |
| `cprRaw` | `v2.cpr` | CPR levels object |
| `breadth` | `v2.dashboard.breadth` | Advance/decline + per-stock list |
| `atmCall` / `atmPut` | `v2.options.atmCall/.atmPut` | ATM option summaries |
| `atm` | `v2.options.atm` | ATM strike |
| `ladder` | `v2.ladder` | Per-strike option rows (CE/PE greeks, OI) |
| `priorClose` | `v2.spot.priorClose` | Previous-day close (for CPR relation) |

---

## 7. Engine 1 — MARKET BREADTH ENGINE

**Question it answers:** *Are more stocks rising or falling? (the truth of the day)*

**Logic:**
- `advancing`, `declining`, `unchanged` taken from breadth.
- `totalStocks = breadth.total` (fallback: sum of the three).
- **`breadthPct = round(advancing / totalStocks × 100)`** (defaults to 50 if no total).

**Zone classification (`breadthZone`):**

| Breadth % | Zone | Tone |
|-----------|------|------|
| ≥ 70 | STRONG BULL | strongbull |
| 60 – 70 | BULL | bull |
| 40 – 60 | NEUTRAL | neutral |
| 30 – 40 | BEAR | bear |
| < 30 | STRONG BEAR | strongbear |

**Bias (`breadthBias`):** `≥ 60 → BULLISH`, `≤ 40 → BEARISH`, else `NEUTRAL`.

**Output object `breadthEngine`:** counts, `pct`, the human `formula`
(`"38 / 50 × 100 = 76%"`), `zone`, `tone`, `bias`, and a `scale[]` (the 5 rows shown in
the UI, with `active` flag marking the live zone).

---

## 8. Engine 2 — IT SECTOR STRENGTH ENGINE

**Question it answers:** *Is the heavyweight IT pack supporting or dragging the index?*

**Logic:**
- Filter `breadth.allStocks` to the `IT_MEMBERS` list for the symbol.
- **`itChangePct = average of member % change`** (0 if none found).

**Zone classification (`itZone`):**

| IT avg % | Zone | Tone |
|----------|------|------|
| > +1.5 | STRONG SUPPORT | strongbull |
| +0.5 to +1.5 | SUPPORT | bull |
| −0.5 to +0.5 | NEUTRAL | neutral |
| −0.5 to −1.5 | DRAG | bear |
| < −1.5 | HEAVY DRAG | strongbear |

**Bias (`itBias`):** `≥ +0.5 → BULLISH`, `≤ −0.5 → BEARISH`, else `NEUTRAL`.

**Summary line:** `IT SUPPORTING INDEX` / `IT DRAGGING INDEX` / `IT NEUTRAL ON INDEX`.

**Output `itEngine`:** `changePct`, `members[]` (symbol + change), `zone`, `tone`,
`bias`, `summary`, and the 5-row `scale[]`.

---

## 9. Engine 3 — CPR ENGINE

**Question it answers:** *Where is price relative to the Central Pivot Range, and what
does that imply?* CPR levels come pre-computed from the prior day's OHLC inside V2.

### 9.1 CPR Width (`cprWidth`)
Driven by `cpr.widthClass` (`narrow | normal | wide`):

| widthClass | Label | Headline | Sub | Tone |
|------------|-------|----------|-----|------|
| narrow | NARROW | Compression Energy Building | Big Move Expected | bull |
| wide | WIDE | Range / Sideways Bias | Trend Day Less Likely | bear |
| normal | NORMAL | Balanced Structure | Standard Day Expected | neutral |

### 9.2 Price Location (vs TC / BC)
- `spot > tc` → **ABOVE TC** · BULL TERRITORY · "Trend CE Favorable" · `BULLISH`
- `spot < bc` → **BELOW BC** · BEAR TERRITORY · "Trend PE Favorable" · `BEARISH`
- otherwise → **INSIDE CPR** · NEUTRAL ZONE · "Wait For Direction" · `NEUTRAL`

A `locationBanner` summarises this in one line (e.g. `PRICE ABOVE TC — BULL TERRITORY`).

### 9.3 CPR Relationship (today vs prior day)
Compares today's `pivot` to the prior-day `priorClose`:
- `pivot > priorClose` → **HIGHER VALUE CPR** (Bullish Structure / Higher High Probability)
- `pivot < priorClose` → **LOWER VALUE CPR** (Bearish Structure / Lower Low Probability)
- equal → **UNCHANGED CPR** (Neutral / Range Probable)

### 9.4 Levels exposed
`r3, tc, pivot, bc, s3` (primary, shown in UI) plus `r1, r2, s1, s2` (carried for
completeness). All from the V2 CPR object.

### 9.5 Opening Scenario Engine (`opening`)
A static map of how to read the **next session's open** against CPR, with the matching
cell flagged `active` based on current `locationBias`:
- **GAP UP OPEN:** *Above TC → Strong Bullish (no CPR touch needed)* | *Inside CPR → Gap Failed / Neutral*
- **FLAT OPEN:** *Inside CPR → Neutral Zone (wait for break)*
- **GAP DOWN OPEN:** *Below BC → Strong Bearish (no CPR touch needed)* | *Inside CPR → Gap Failed / Neutral*

---

## 10. MARKET TREND VIEW (3-engine vote)

A simple **majority vote** across the three "location/structure" engines —
Breadth, IT, and CPR Price-Location:

```
bullVotes = (breadthBias==BULLISH) + (itBias==BULLISH) + (locationBias==BULLISH)
bearVotes = (breadthBias==BEARISH) + (itBias==BEARISH) + (locationBias==BEARISH)

if bullVotes ≥ 2 and bullVotes > bearVotes → BULLISH
if bearVotes ≥ 2 and bearVotes > bullVotes → BEARISH
else                                       → NEUTRAL
```

`trendView.rows[]` renders three lines (Trend Bullish / Range-Neutral / Trend Bearish)
with the winning one highlighted `active`.

---

## 11. MARKET MODE

A risk-appetite tag shown in the header:
- **RISK ON** when `(breadthBias == BULLISH OR trendBias == BULLISH)` **and**
  `vixChangePct ≤ 5` (VIX not spiking).
- **RISK OFF** when `breadthBias == BEARISH`.
- **NEUTRAL** otherwise.

`marketMode = { label: 'INSTITUTIONAL', state, bias: trendBias }`. The header shows a
🐂 / 🐻 / • icon based on `bias`.

---

## 12. Engine 4 — GREEKS ENGINE (ATM)

**Question it answers:** *Do the option greeks confirm strength and favour buyers?*

**Source:** the ATM row from the `ladder` (CE leg as the directional reference, falling
back to `atmCall`). Reads `delta, gamma, vega, theta` and `atmIv`. Trends come from
`_trend()` over the rolling history (Section 4).

### 12.1 DELTA — direction conviction
- `deltaBias`: `> +0.25 → BULLISH`, `< −0.25 → BEARISH`, else `NEUTRAL`.
- `control`: `BULL CONTROL` / `BEAR CONTROL` / `NEUTRAL`.
- Scale rows: `> +0.25 BULLISH` · `−0.25 to +0.25 NEUTRAL` · `< −0.25 BEARISH`.

### 12.2 GAMMA — acceleration
- `state`: trend `RISING → ACCELERATION`, `FALLING → DECELERATION`, `FLAT → STEADY`.
- Scale rows: `RISING FAST → STRONG MOVE` · `RISING SLOW → MODERATE` · `FALLING → WEAK MOVE`.

### 12.3 VEGA — premium / IV expansion
- Carries the ATM `iv`.
- `state`: trend `RISING → PREMIUM EXPANSION`, `FALLING → IV CRUSH RISK`, `FLAT → NEUTRAL`.
- Scale rows: `RISING → BUYER FRIENDLY` · `FLAT → NEUTRAL` · `FALLING → SELLER FRIENDLY`.

### 12.4 THETA — time decay (uses magnitude `thetaAbs = |theta|`)
- `decay`: `> 15 → HIGH DECAY`, `8–15 → MEDIUM DECAY`, `< 8 → LOW DECAY`.
- `friendly`: `≤ 8 → BUYER FRIENDLY`, `≤ 15 → NEUTRAL`, else `SELLER EDGE`.
  *(Less negative theta = cheaper to hold = buyer friendly.)*
- Scale rows: `MORE NEGATIVE → SELLER EDGE` · `STABLE → NEUTRAL` · `LESS NEGATIVE → BUYER EDGE`.

### 12.5 Greeks "all positive" check (`greeksPositive`)
A buyer-aligned confluence flag — **true** when **all** hold:
```
deltaBias == BULLISH        (direction up)
gammaTrend != FALLING       (acceleration not dying)
vegaTrend  != FALLING       (premium not collapsing)
thetaAbs   <= 15            (decay not severe)
```

### 12.6 Greeks Market Reading (`reading[]`)
Five interpretive statements, each lit when its condition is met:

| Statement | Lights when |
|-----------|-------------|
| DELTA POSITIVE + PRICE ABOVE TC = BULLS IN CONTROL | `deltaBias==BULLISH` **and** `locationBias==BULLISH` |
| DELTA NEGATIVE + PRICE BELOW BC = BEARS IN CONTROL | `deltaBias==BEARISH` **and** `locationBias==BEARISH` |
| GAMMA RISING = MOVE ACCELERATING | `gammaTrend==RISING` |
| VEGA RISING = PREMIUM EXPANDING | `vegaTrend==RISING` |
| THETA LOW = OPTION BUYER FRIENDLY | `thetaAbs < 8` |

---

## 13. Engine 5 — COMPLETE LOGIC MATRIX

**Question it answers:** *When all engines are placed side-by-side, who wins?*

### 13.1 Bullish checklist (`checks`)
```
breadthStrong  = breadthBias  == BULLISH
itSupporting   = itBias       == BULLISH
priceAboveTc   = locationBias == BULLISH
cprHigherValue = cprRelation.bias == BULLISH
greeksPositive = greeksPositive (Section 12.5)
```
`bullScore = number of true checks` (0–5).

### 13.2 Bearish mirror (`bearChecks`)
```
breadthWeak    = breadthBias  == BEARISH
itDragging     = itBias       == BEARISH
priceBelowBc   = locationBias == BEARISH
cprLowerValue  = cprRelation.bias == BEARISH
greeksNegative = deltaBias    == BEARISH
```
`bearScore = number of true checks` (0–5).

### 13.3 Market Condition (`marketCondition` / `conditionBias`)

| Condition | Result | Bias |
|-----------|--------|------|
| `bullScore == 5` | BULLS IN CONTROL — HIGH CONVICTION CE SETUP | BULLISH |
| `bearScore == 5` | BEARS IN CONTROL — HIGH CONVICTION PE SETUP | BEARISH |
| `bullScore ≥ 3` and `> bearScore` | BULLISH TILT — CE SETUP FORMING | BULLISH |
| `bearScore ≥ 3` and `> bullScore` | BEARISH TILT — PE SETUP FORMING | BEARISH |
| otherwise | MIXED SIGNALS — WAIT FOR ALIGNMENT | NEUTRAL |

### 13.4 Matrix rows (`rows[]`)
One row per engine, each with `engine`, `value`, `verdict`, and `tone`:
`BREADTH` (%), `IT SECTOR` (%), `CPR LOCATION`, `CPR WIDTH`, `CPR RELATION`,
`GREEKS (ATM)` (the `Δ Γ V Θ` signed line, marked `greeks: true` for smaller font).

### 13.5 Logic Summary checklist (`summary[]`)
Five ticks shown on the right. Each is `ok` when **either** the bullish **or** bearish
version of that check fires (i.e. the engine is taking a side, not sitting neutral):
BREADTH STRONG · IT SUPPORTING INDEX · PRICE ABOVE TC · CPR HIGHER VALUE · GREEKS ALL POSITIVE.

### 13.6 Alignment
- `allAlign = (bullScore==5) || (bearScore==5)`.
- `alignText`: `ALL SYSTEMS ALIGN` when fully aligned, else `"N / 5 ALIGNED"` where
  `N = max(bullScore, bearScore)`.

---

## 14. Engine 6 — FINAL VERDICT

**Question it answers:** *What's the trade and how confident are we?*

### 14.1 Scores
- `dominantScore = max(bullScore, bearScore)` (0–5).
- **Confidence /10:** `clamp(round(4 + dominantScore × 1.1 + (vix < 14 ? 0.5 : 0)), 1, 10)`
  — base 4, +1.1 per aligned engine, +0.5 bonus when VIX is calm (< 14).
- **Stars:** `clamp(round(dominantScore), 1, 5)`.

### 14.2 Setup & Trade Plan

| `conditionBias` | Setup | Trade Plan |
|-----------------|-------|------------|
| BULLISH | CE BUY SETUP | `BUY CE ON DIP` (if allBull) else `BUY CE ON CONFIRMATION` |
| BEARISH | PE BUY SETUP | `BUY PE ON RISE` (if allBear) else `BUY PE ON CONFIRMATION` |
| NEUTRAL | NO TRADE SETUP | `WAIT FOR ALIGNMENT` |

### 14.3 Verdict cells (`cells[]`)
Four bottom tiles:
- **TREND** → `UP` / `DOWN` / `FLAT` from `trendBias`.
- **STRENGTH** → `dominantScore ≥ 4 → STRONG`, `≥ 3 → MODERATE`, else `WEAK`.
- **MOMENTUM** → `gammaTrend RISING → RISING`, `FALLING → FADING`, else `STEADY`.
- **MARKET MODE** → mirrors `marketMode.state` (RISK ON / OFF / NEUTRAL).

---

## 15. Response Shape (returned JSON)

```jsonc
{
  "ok": true,
  "version": "v6",
  "symbol": "NIFTY_50",
  "displayName": "NIFTY 50",
  "date": "2026-06-02",
  "isToday": true,
  "at": 1717320000000,

  "header":       { date, time, indexName, spot, change, changePct, vix, vixChangePct, marketMode },
  "breadthEngine":{ advancing, declining, unchanged, total, pct, formula, zone, tone, bias, scale[] },
  "itEngine":     { changePct, members[], zone, tone, bias, summary, scale[] },
  "cprEngine":    { width, widthPct, levels, priceLocation, territory, locationSub,
                    locationBias, locationBanner, relation, opening },
  "trendView":    { active, rows[] },
  "greeksEngine": { delta, gamma, vega, theta, allPositive, reading[] },
  "logicMatrix":  { rows[], condition, conditionBias, summary[], allAlign, alignText },
  "finalVerdict": { setup, bias, stars, confidence, confidenceText, cells[], tradePlan },

  "goldenRule": "BREADTH TELLS THE TRUTH · CPR TELLS THE LOCATION · GREEKS CONFIRM THE STRENGTH",
  "debug": { bullScore, bearScore, trendBias, conditionBias, itMembersFound, historySamples }
}
```

On failure: `{ ok: false, error: "...", version: "v6" }`.

---

## 16. Frontend (`src/routes/intel-v6.tsx`)

The route guards auth (`isAuthenticated()` → redirect to `/login`), then renders a
full-screen dark dashboard. Symbol toggle (NIFTY/SENSEX), date picker, LIVE button, and
manual refresh sit in the header.

### Data hook — `useIntelV6Decision({ symbol, date, intervalMs })`
- Calls `GET /api/intel-v6/decision` via the shared `api` axios instance.
- **Live mode** (no date): re-polls every `intervalMs` (3000 ms); pauses while the tab
  is hidden (`document.hidden`).
- **Historical mode** (date set): fetches once.
- Guards against overlapping requests with an `inFlight` ref; exposes
  `{ data, loading, error, lastFetchAt, refetch }`.

### Component map
| Component | Renders |
|-----------|---------|
| `MasterDashboard` | The overall responsive grid (rows A/B/C + golden rule) |
| `Panel` | Reusable bordered card with a coloured title bar |
| `TitleBar` | Date/time · dashboard title + index quote + VIX · Market Mode |
| `BreadthEngine` + `Stat` + `Gauge` | Adv/Dec/Unch stats, half-circle % gauge, scale |
| `ItEngine` | NIFTY IT % + scale + summary |
| `CprEngine` + `LevelRow` + `OpeningCol` | Width, levels, price location, opening map |
| `CprRelationship` | Higher/Lower value structure |
| `TrendView` | 3-row trend vote |
| `GreeksEngine` + `GreekCard` + `GreeksReading` | 4 greek cards + market reading |
| `LogicMatrix` | Engine rows + logic-summary checklist + alignment |
| `FinalVerdict` + `Stars` | Setup, confidence, 4 cells, trade plan |
| `GoldenRule` | Footer banner |
| `ScaleTable` | Shared range→label rows (used by Breadth, IT, all greeks) |

### Tone → colour map (`TONE` / `tc()`)
```
strongbull #16c784 · bull #22c55e · neutral #eab308 · bear #f97316 · strongbear #ef4444
```
`tc()` also accepts bias words (`BULLISH/BEARISH/NEUTRAL`) and maps them to green/red/amber.

### Layout notes
- Outer container is full-width; `main` uses `overflow-y-auto` so nothing is clipped.
- Rows use `items-stretch`; the right column gives **CPR Relationship** its natural
  height (`shrink-0`) and lets **Market Trend View** take the rest (`flex-1`) so all
  three trend rows stay visible.

---

## 17. Data Lineage Summary

| V6 field | Ultimately derived from |
|----------|-------------------------|
| Breadth % | V2 `dashboard.breadth.advancing/total` (NIFTY-50 / SENSEX-30 constituents via Yahoo) |
| IT Sector % | V2 `dashboard.breadth.allStocks` filtered to IT names |
| CPR levels/width | V2 `cpr` (computed from **prior-day OHLC**) |
| Price Location | `spot` vs CPR `tc`/`bc` |
| CPR Relation | `pivot` vs `priorClose` |
| Greeks (Δ Γ V Θ, IV) | V2 `ladder` ATM CE leg / `options.atmCall` (Dhan option-chain feed) |
| Greek trends | V6's own 30-min rolling history of those greeks |
| VIX | V2 `macro.vix` (Yahoo `^INDIAVIX`) |
| Verdict / Confidence | Weighted vote of all 5 checks + VIX bonus |

---

## 18. Quick Reference — All Thresholds

```
BREADTH %:   ≥70 SBull · 60-70 Bull · 40-60 Neutral · 30-40 Bear · <30 SBear
             bias: ≥60 BULLISH · ≤40 BEARISH

IT AVG %:    >1.5 SSupport · 0.5..1.5 Support · -0.5..0.5 Neutral · -1.5..-0.5 Drag · <-1.5 HDrag
             bias: ≥+0.5 BULLISH · ≤-0.5 BEARISH

CPR LOC:     spot>TC ABOVE(Bull) · spot<BC BELOW(Bear) · else INSIDE(Neutral)
CPR REL:     pivot>priorClose HIGHER(Bull) · pivot<priorClose LOWER(Bear)
CPR WIDTH:   narrow NARROW(Bull) · wide WIDE(Bear) · normal NORMAL(Neutral)

DELTA bias:  >+0.25 BULLISH · <-0.25 BEARISH · else NEUTRAL
THETA |x|:   >15 HIGH/SellerEdge · 8-15 MEDIUM/Neutral · <8 LOW/BuyerFriendly
TREND eps:   Δ 0.01 · Γ 0.00003(abs) · V 0.1(abs) · Θ 0.4(abs)

TREND VOTE:  ≥2 of {Breadth, IT, CPR-Location} agree → that bias, else NEUTRAL
MARKET MODE: (Bull breadth/trend & VIX chg ≤5) RISK ON · Bear breadth RISK OFF · else NEUTRAL

LOGIC:       5 bull checks / 5 bear checks → score 0-5
             5 = HIGH CONVICTION · ≥3 & dominant = TILT · else MIXED/WAIT
CONFIDENCE:  clamp(round(4 + dominantScore×1.1 + (VIX<14 ? 0.5 : 0)), 1, 10)
STARS:       clamp(round(dominantScore), 1, 5)
```

---

*This dashboard is for educational purposes only. Always consult a financial advisor
before trading.*
