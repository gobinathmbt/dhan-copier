# Intel V2 — Institutional Options Console

End-to-end documentation of the `/intel-v2` dashboard. Covers every card, the
exact computation behind each metric, the data sources the engine pulls from,
and the way the cards are wired into a single coherent verdict.

> **Endpoint:** `GET /api/intel-v2/snapshot?symbol=NIFTY_50|SENSEX|BANKNIFTY[&date=YYYY-MM-DD]`
> **Live polling:** 3 s on the page · 800 ms cache window on the orchestrator
> **Trading hours:** 09:15–15:30 IST · entry cutoff 15:00 IST
> **Strike grid rule:** all option strike picks are forced to the nearest 100-step within ATM ± 6

---

## 1. Data sources

| Source | What it provides | Cache |
|---|---|---|
| **Dhan v2 REST** (`getIntradayOHLC`) | 1m / 5m / 15m / 25m index candles + futures candles | 60 s historical · 800 ms live |
| **Dhan v2 WebSocket** (`liveFeedProd`) | Live tick (LTP, OI, depth) — packets 4/5/8 | streaming |
| **Dhan v2 Option Chain** (`/v2/optionchain`) | Full strike chain with greeks, OI, ΔOI, IV per leg | 800 ms |
| **niftyFuturesProd** | Near + next NIFTY futures contract (sid, expiry, lot) + live tick (LTP, OI, prevOI) | 5 s scrip-master cache |
| **Yahoo Finance** | India VIX, ^NSEI (GIFT proxy), ES=F, NQ=F, DX-Y.NYB, CL=F, ^N225, ^BSESN, all 50 NIFTY / 30 SENSEX constituents | 60 s |
| **Sensibull** (`oxide.sensibull.com/v1/compute/cache/fii_dii_daily`) | FII/DII/PRO/CLIENT cash · futures · options breakdown | 5 min |
| **`live-feed/<date>_<sym>/`** (recorder) | Persisted JSONL tick stream + synthesized 1m/5m/15m/30m/option-chain candles | disk |

The **production token + clientId** are required: `DHAN_ACCESS_TOKEN` carries
the JWT (its payload contains `dhanClientId`), and `DHAN_CLIENT_ID` must be
set explicitly in `backend/.env`. Without both, the live WebSocket never
connects and `/v2/optionchain/expirylist` returns 401.

---

## 2. Pipeline at a glance

```
                ┌──────────────────────────┐
                │  Dhan REST + WebSocket   │
                └─────────────┬────────────┘
                              ▼
                  candleSet  +  liveTick
                              │
                              ▼
        ┌──────────  intelV2.service.js  ──────────┐
        │                                          │
        │   _loadCandles            _readChain     │
        │   _atmAnalytics           _verdict       │
        │   _delta + _vp            _supportResistance
        │   _frvpInstitutional → frvpEngine.evaluate()
        │   _heroZero  _premiumMomentum  _tradeStrategy
        │   _executionEngine  _marketStory  _trapDetection
        │   _macroContext (Yahoo + Sensibull)      │
        │   _heavyweights + _fullBreadth (50/30)   │
        │                                          │
        └────────────┬─────────────────────────────┘
                     ▼
            JSON snapshot (~25 KB)
                     │
                     ▼
        useIntelV2Snapshot()  →  intel-v2.tsx (rows 1-5)
```

Every engine reads from the same `candleSet`, `strikes`, `atmBlk`, `vp`,
`frvpInstitutional` blocks — no engine recomputes index-level state. This is
why all engines now agree on direction (recent unification of `vaPrimary` —
see §6).

---

## 3. Indicator math

| Helper | Formula |
|---|---|
| `_ema(closes, n)` | classic exponential moving average, `α = 2/(n+1)` |
| `_vwap(candles)` | `Σ(typical × volume) / Σ volume` over the last 200 1m bars |
| `_anchoredVwap(candles, fromIdx)` | VWAP starting from a chosen index (session AVWAP from idx 0; prior-day AVWAP from `len-60`) |
| `_atr(c5m, 14)` | true-range ATR on 5m candles |
| `_rsi(closes, 14)` | Wilder's RSI |
| `_cprFromOHLC(prior)` | Pivot = (H+L+C)/3, BC = (H+L)/2, TC = 2·Pivot − BC |
| `_round(n, d)` | `Math.round(n*10^d)/10^d` (used everywhere to keep JSON terse) |

---

## 4. Top header (`TopHeader.tsx`)

The center of the header is built around 4 neon-style icon tiles, absolutely
positioned so the cluster stays geometrically centered regardless of the
left/right cluster widths:

| Tile | Tone | Logic |
|---|---|---|
| **DATE** | sky | `<input type="date">` with chevron prev/next bound to `availableDates`. Selecting today returns to live polling (`onDate(null)`). |
| **STATUS** | green when `!date` else gray | `LIVE` button — clicking toggles auto-refresh on (clears the historical date). |
| **STATE** | green when `data.market.isOpen` else red | derived from `marketHours.service`. Lock icon on closed, activity icon on open. |
| **TIME** | purple | `Date.now()` re-rendered every 1s in IST locale. |

Left cluster keeps the INTEL V2 logo + NIFTY / SENSEX symbol toggle. Right
cluster keeps the Refresh + last-updated indicator + AUTO-3s pill.

---

## 5. Master Verdict — `_masterVerdict()`

Final bias score is computed as a weighted sum of 13 factors. Each factor is
clipped to `[-100, +100]` and multiplied by its weight. Positive points push
toward CE, negative toward PE.

```
verdict = Σ (factor_i × weight_i)
cePct = clamp(50 + verdict/2, 0, 100)
pePct = 100 - cePct
side  = cePct >= 60 ? CE : pePct >= 60 ? PE : NEUTRAL
```

| Factor | Weight | Source | Rule |
|---|---|---|---|
| `pcr` | 0.10 | `flow.oi.pcr` | bullish if PCR > 1, bearish if < 0.7 |
| `oiWriters` | 0.10 | `atmBlk.peWriting`, `atmBlk.ceWriting` | PE writers = bullish, CE writers = bearish |
| `vwap` | 0.08 | `(spot − vwap) / vwap × 1000` | distance scaled to ±50 |
| `ema` | 0.10 | EMA 9>20>50 stack | full ascending = +60, descending = -60 |
| `cpr` | 0.06 | `cpr.pivot` vs spot | above pivot = bull, below = bear |
| `heavyweights` | 0.10 | `heavyweightsTotalImpact` | weighted basket impact in pts |
| `vix` | 0.05 | `vix.changePct` | rising VIX = bearish |
| `gift` | 0.06 | `giftNifty.changePct` | global cue proxy |
| `fiiDii` | 0.08 | Sensibull cash buy/sell diff (₹ Cr) | net institutional flow |
| `futures` | 0.07 | `futures.premium` | premium = bullish basis |
| `delta` | 0.10 | `flow.delta.deltaPct` | volume-flow imbalance |
| `iv` | 0.04 | `atmIv` vs trend | rising IV in trending = continuation |
| `breadth` | 0.06 | `breadth.advancePct` | advance/decline % around 50% pivot |

The card displays the dominant side as `BUY CE 62%` / `BUY PE 58%` /
`NEUTRAL` and the per-factor contributions are surfaced in the snapshot
under `verdict.factors`.

---

## 6. Value-area unification — `vaPrimary`

A subtle but critical fix: there are TWO VAH/VAL bands in the snapshot —

- `flow.volume.{vah, val}` — simple price-bin VAH/VAL (often wider)
- `frvpInstitutional.engine.profile.{vah, val}` — institutional engine band (curated, accurate)

The HeroZero, Trade Strategy, Execution Engine, Market Story, and No-Trade
conditions all now read a single unified band:

```js
const vaPrimary = engineProfile?.vah && engineProfile?.val
  ? { vah: engineProfile.vah, val: engineProfile.val, poc: engineProfile.poc }
  : (vp?.vah && vp?.val ? { vah: vp.vah, val: vp.val, poc: vp.poc } : null);
```

Without this, downstream engines were reporting "Inside Value Area" while
the FRVP card simultaneously showed "Below Value / Rejection below value".
Now the entire dashboard agrees on a single value-area location.

---

## 7. Option-chain analytics

`_atmAnalytics(strikes, atm)` walks the chain ±6 strikes around ATM and
returns:

| Field | Computation |
|---|---|
| `atmCall`, `atmPut` | the matching strike's `call.ltp/oi/iv/delta` and `put.*` |
| `pcr` | total PE OI / total CE OI within ±6 strikes |
| `ceTotal`, `peTotal` | sum of OI on each side |
| `ceWriting`, `peWriting` | true if `oiChange > 0` and `oiChange / totalOiChange > 0.30` |
| `ceUnwinding`, `peUnwinding` | mirror — `oiChange < 0` with same threshold |
| `callWall` | strike with the highest CE OI in the window |
| `putWall` | strike with the highest PE OI in the window |
| `maxPain` | strike that minimises total writer pain (CE + PE intrinsic loss) |

`_strikeLadder()` builds the per-strike ladder (greeks, OI, ΔOI, health
score, classified buildup) for the trade-board / writer-pressure cards.

---

## 8. FRVP Institutional Engine — `frvpEngine.evaluate()`

A 14-section institutional auction engine. Inputs: candle stream + chain.
Outputs the full `dashboard.frvpInstitutional.engine` object.

| Section | Output | Logic |
|---|---|---|
| 1 | **Profile** (VAH/POC/VAL/HVN/LVN) | classical Market Profile — sort 5-pt bins by volume, take 70% concentration as VAH/VAL, top bin as POC |
| 2 | **Location** | inside/outside value, near POC (±15% of value-area width), markerPct |
| 3 | **Acceptance** | `consecutiveAbove ≥ 3` bars closing above VAH = `acceptedAboveVAH`; same below |
| 4 | **Selected strikes** | ATM ± 4 strikes (100-step), with classified `ceBuildup` / `peBuildup` per leg |
| 5 | **Buildup classification** | `_classifyBuildup(side, oiChg, spotChange)` → Long Buildup / Short Buildup / Long Unwinding / Short Covering / Balanced |
| 6 | **Flow aggregation** | per-strike weighted shares: `ceBuy = vol × _TAG_WEIGHTS[tag].buy`, etc. |
| 7 | **Delta pressure** | `cumulative` (Σ delta on selected strikes), `deltaPct = cum / totalVol × 100`, bias bull if ≥ +8% |
| 8 | **Dominance** | **fixed in this build**: `bullishVol = ceBuy + peSell`, `bearishVol = ceSell + peBuy`, `buyersScore = bullishVol / total × 100`. Conviction = "high" if dominance aligns with delta, "divergent" if opposite |
| 9 | **Interpretation** | combines location + acceptance + dominance + delta into a one-line verdict (`PROBING_BELOW`, `BREAKOUT_CONFIRMED`, etc.) |
| 10 | **Developing POC** | rolling 30-min POC trail — flags `Migrating Up` / `Migrating Down` |
| 11 | **Gamma wall** | strike with the largest |delta·OI·100| product (gamma exposure) |
| 12 | **Premium velocity** | CE/PE LTP skew — used as cold-start fallback only by the Premium Momentum engine |
| 13 | **Naked POC** | unfilled POC from prior session (price has moved away without revisiting) |
| 14 | **Trapped traders** | acceptance + dominance disagreement → bull/bear trap classifier |

### Critical fix — bull/bear vol formula
Earlier `buyersEntering = (ceBuyersPct + peBuyersPct) / 2` averaged
opposite-direction signals (CE buying = bullish, PE buying = bearish), so
the donut always read ~50/50 regardless of real flow. The replacement
formula correctly computes `bullishVol / (bullishVol + bearishVol)` so 80/20
reads truly mean 80% bullish vs 20% bearish flow.

---

## 9. Market Direction Card (2.2)

The combined card now shows BOTH sides on every strike row plus the ATM:

```
[ CE strip · Tier · Strike CE · OI Build · Δ% · Strength · Interp ]
                       [ STRIKE PILL ]
[ PE strip · Tier · Strike PE · OI Build · Δ% · Strength · Interp ]
```

- 6 resistance tiers (Immediate → R6 Wall) ABOVE ATM, 6 support tiers
  (Immediate → S6 Bedrock) BELOW ATM, plus the ATM in the middle
- Each side reads from `oiBuildupAnalysis.ceTable` / `peTable`; if a strike
  isn't in those tables the engine falls back to raw `optionChainSnapshot`
  for OI numbers
- The center pill is sky-blue + boxed only on the ATM row, neutral elsewhere
- Strength bar = 7 segments scaled by `|oiChangePct|`

The **Direction Meter** above it is a split bar with a needle:
`needlePos = (callBuildSum - putBuildSum) / totalBuild × 50 + 50`. >= 60 →
"DOWNSIDE BIAS"; <= 40 → "UPSIDE BIAS".

---

## 10. Best Trade Picks — `_bestTradePicks()`

Per-side score (max 30) — with a strict 100-step ATM ± 6 window:

| Component | Weight | Logic |
|---|---|---|
| Verdict alignment | 6 | strike picked from CE/PE side of master verdict |
| FRVP location | 4 | inside-value penalty, breakout / breakdown bonus |
| Acceptance | 12 | accepted above VAH / below VAL = +12 |
| Delta | 10 | aligned with directional bias |
| Health | 3 | ladder health score (0-100 → 0-3) |
| OI | 6 | OI within target band (not too thin) |
| Trap penalty | -10 | bull/bear trap detected |

`probability` clamps to `[0, 95]`. Action labels:

```
≥ 60 → "BUY"        50-59 → "CAUTIOUS BUY"
40-49 → "WAIT"      < 40 → "AVOID"
```

`primary` is the side with higher probability; `spread = primary − loser`.
Used by Trade Board card + Execution Engine.

---

## 11. Hero or Zero Engine

**9-point sniper score per side, threshold ≥ 7 for HERO.**

| Signal | Side | Pts | Veto |
|---|---|---|---|
| `aboveVAH` / `belowVAL` | CE / PE | +2 | — |
| `aboveVWAP` / `belowVWAP` | CE / PE | +2 | — |
| `ceExpanding` / `peExpanding` | CE / PE | +2 | — |
| `buyersDominant ≥ 65` / `sellersDominant ≥ 65` | CE / PE | +1 | — |
| `deltaPct ≥ +10` / `≤ -10` | CE / PE | +1 | — |
| `volSurge` (last 5m vol > 1.5× prior-20 avg) | both | +1 | — |
| `bullTrap` | CE | — | **-4 hard veto** |
| `bearTrap` | PE | — | **-4 hard veto** |

`HERO_CE` fires only if `ceScore ≥ 7 AND ceScore > peScore`. Confidence:
`min(95, 70 + score × 3)`. Otherwise emits `ZERO` with a sub-reason
(`Inside Value Area`, `Bull Trap Detected`, `Bear Trap Detected`,
`Premium Stagnant`, `No Edge`).

The card now uses `vaPrimary` (see §6) for accurate VA location.

---

## 12. Premium Momentum Engine

**Real time-derivative of CE/PE premium**, replacing the prior static-skew
implementation that always reported "CE_EXPANDING" because CE LTP was
structurally bigger than PE LTP.

How it works:

1. Per-symbol ring buffer `_premiumHistory[symbol|atm] = [{t, ceLtp, peLtp}]`
   pushes one sample on every snapshot call. Capacity 240 entries (~12 min
   at 3s polling); TTL 30 min.
2. On each compute, picks the sample closest to `now − 8 min` as the
   baseline; if buffer < 3 samples, falls back to the FRVP engine's static
   skew heuristic (clearly marked as cold-start).
3. Computes:
   ```
   ceExpansionPct = (ceLtp − baseline.ceLtp) / baseline.ceLtp × 100
   peExpansionPct = (peLtp − baseline.peLtp) / baseline.peLtp × 100
   ```
4. Sparklines use the last 30 ring-buffer samples directly (real LTP
   trail). Cold-start synthesises from candle close-position-in-range.
5. Top state classifier:
   - `ceExpansionPct > peExpansionPct + 5 AND ce >= 8` → **CE Momentum Strong** 🟢
   - `peExpansionPct > ceExpansionPct + 5 AND pe >= 8` → **PE Momentum Strong** 🔴
   - both < 5 → **Weak Premium** ⚠
   - else → **Two-sided Momentum** ◇
6. `momentumQuality` is a separate score (0-100): delta intensity (35) +
   expansion magnitude (35) + writer presence (15) + day type (15).
7. `scalpingAggression`: volSurge (30) + |delta| (25) + expansion (25) +
   volatility regime (20). HIGH ≥ 70, MODERATE ≥ 45, LOW otherwise.
8. Surfaces `baselineAgeSec` and `historyDepth` for transparency.

---

## 13. Trade Strategy Engine

Scores 5 strategies against a fixed factor checklist; tie-broken by
**directional bias** (verdict + price location), not by JS Object.entries
insertion order (former bug).

```
const verdictDir = verdict.cePct >= verdict.pePct ? 'CE' : 'PE';
let locationDir = 'NEUTRAL';
if (belowVWAP && belowVAL)        locationDir = 'PE';
else if (aboveVWAP && aboveVAH)   locationDir = 'CE';
else if (belowVWAP || belowVAL)   locationDir = 'PE';
else if (aboveVWAP || aboveVAH)   locationDir = 'CE';
const tieBreakDir = verdictSpread < 5 ? locationDir : verdictDir;
```

| Strategy | Triggers (each +1-3) |
|---|---|
| **BUY_ON_DIP_CE** | aboveVWAP +2 · abovePOC · peWriting +2 · buyersDominant +2 · supportHolding · deltaPos · pullbackBullish +2 · ceExpanding · rejectedBelow |
| **SELL_ON_RISE_PE** | belowVWAP +2 · belowPOC · ceWriting +2 · sellersDominant +2 · resistanceCapping · deltaNeg · pullbackBearish +2 · peExpanding · rejectedAbove |
| **BREAKOUT_CE_BUY** | aboveVAH +3 · acceptedAbove +2 · volSurge +2 · ceExpanding +2 · ceUnwinding · buyersDominant · deltaPos · `rejectedAbove −5` (hard veto) |
| **BREAKDOWN_PE_BUY** | belowVAL +3 · acceptedBelow +2 · volSurge +2 · peExpanding +2 · ceWriting · sellersDominant · deltaNeg · `rejectedBelow −5` (hard veto) |
| **RANGE_MARKET** | insideValue +3 · BALANCED dominance +2 · two-sided writing +2 · stagnant premium · neutral delta |

`confidence = clamp(25 + topScore × 5 + edge × 8, 25, 92)`.

Outputs: `key`, `verdict` (`BUY CE` / `BUY PE` / `WAIT`), `strategy` label,
`side`, `strike` (forced into ATM ± 6 100-step window), `topReasons[]`,
`scores`, `edge`, `ranked[]`.

---

## 14. AI Execution Engine — final brain

Fuses every other engine into ONE decision. Calculates dynamic weights
based on time-of-day and regime, then runs a 5-vote ballot.

### Time-of-day weight modifiers

| Phase | Trigger | Weight tweaks |
|---|---|---|
| `OPEN_DRIVE` | 09:15 – 09:45 IST | premium ×1.4, vwap ×0.7 (price hasn't settled) |
| `MORNING_TREND` | 09:45 – 11:30 | balanced |
| `MIDDAY_CHOP` | 11:30 – 13:30 | premium ×0.8, support ×1.3 |
| `AFTERNOON_BUILD` | 13:30 – 14:30 | frvp ×1.3 |
| `POWER_HOUR` | 14:30 – 15:00 | delta ×1.3, premium ×1.3 |
| `CLOSING_DRIFT` | 15:00 – 15:30 | wait ×2.0 (entry cutoff) |

### Late-entry / stretched-move filter

```
const distFromVwap = Math.abs(spot - vwap);
const stretched = distFromVwap > atr * 1.5;
const veryStretched = distFromVwap > atr * 2.5;
lateEntryPenalty = stretched ? 15 : 0;  // veryStretched +25
```

### Voting ballot

| Voter | Weight | Output |
|---|---|---|
| HeroZero | 30 × premium-boost | CE / PE / WAIT 10 |
| TradeStrategy | 25-28 × frvp-boost | CE / PE / WAIT 18 |
| BestTradePick | 20 | CE / PE / WAIT 8 |
| MasterVerdict | 15 × vwap-boost | side or WAIT 5 |
| DeltaBias | 10 × delta-boost | CE / PE / WAIT 5 |

### Penalties

- `wait += noTradeScore × 0.6`
- if `lateEntryPenalty > 0` → blocker `Move stretched — late entry`
- if `noTradeScore ≥ 60` → **hard WAIT veto**

### Final action
```
if votes.CE > votes.PE && votes.CE > votes.WAIT && votes.CE >= 35 → BUY CE
if votes.PE > votes.CE && votes.PE > votes.WAIT && votes.PE >= 35 → BUY PE
else → WAIT
```

### Confidence
```
totalVotes = sum(votes)
winningVote = votes[winningSide]
base = winningVote / totalVotes × 100
bonus = +5 if HERO mode, +5 if edge over runner-up >= 20
penalty = lateEntryPenalty + noTradeScore × 0.3
confidence = clamp(base + bonus - penalty, 0, 100)
```

### Card layout (recent redesign)
- LEFT cluster: `BUY CE / BUY PE / WAIT` headline + target strike + lifecycle phase
  PAIRED with a large 170 px slim 3-stroke confidence ring (42 px center text)
- TOP of ring: No-Trade chip
- RIGHT cluster: Entry Type panel (24 px label) + 3 vote chips (CE / PE / WAIT)

---

## 15. Trap Detection — `_trapDetection()`

Five trap classifiers. Each detected = +20 trap score. Risk:
- ≥ 60 → high (kills HERO + flips action to WAIT)
- ≥ 30 → medium (raises confidence penalty)
- else → low

| Trap | Trigger |
|---|---|
| **fakeBreakout** | spot pierced VAH but reverted within 2 bars |
| **fakeBreakdown** | spot pierced VAL but reverted within 2 bars |
| **liquiditySweep** | dayHigh swept then reversed sharply on volSurge |
| **premiumTrap** | premium expanded > 30% then collapsed to baseline |
| **oiTrap** | sudden OI build at one strike followed by unwind in next 2 bars |

---

## 16. Support / Resistance Pressure — `_supportResistance()`

Top 6 resistance + 6 support strikes ranked by OI. Card adds:

- **Pressure bar** with red-resistance-LEFT / green-support-RIGHT split,
  needle position = `support strength / total × 100`
- **Strike ladder** strip below the bar — 13 chips (ATM ± 6, 100-step),
  positioned at `(i/12) × 100%` so each chip aligns exactly under the bar's
  tick-mark for that strike
- ATM chip is sky-blue + boxed; resistance walls light up red, support
  walls light up green
- Each chip rendered as `<span>` with absolute positioning + `translateX(-50%)`
  for clean visual alignment

`pressureScore = supportStrength / (supportStrength + resistanceStrength) × 100`.

---

## 17. AI Market Story (narrator)

Builds a 5-6 sentence narrative paragraph from the snapshot:

1. OI structure summary (PE/CE writing zones)
2. Price location vs VWAP + POC (uses `vaPrimary` now)
3. Premium expansion direction
4. Buyers vs Sellers dominance verdict
5. Trade verdict (HERO + side OR WAIT/ZERO)
6. Bias balance (`CE X vs PE Y`)

Tone driven by `verdict.tone`. Builds at end of orchestrator pipeline so it
sees every other engine's output.

---

## 18. Buyers vs Sellers Donut (inside FRVP card)

Lives ONLY inside the 2.5 FRVP Institutional Map card (no longer
duplicated in Row 1b). 150 × 150 px donut showing dominance + delta:

- Green arc = `buyersScore`, red arc = `sellersScore` (sum to 100)
- Center: dominant percentage + `BUYERS` / `SELLERS` / `BALANCED` label
- Right legend: side counts + Δ delta footer with positive/negative tone
- A 4-tile **Call/Put · Buyers/Sellers breakdown** sits ABOVE the donut:
  - Call Buyers (bullish · green) — `ceBuy` weighted vol + `ceBuyersPct`
  - Call Sellers (bearish · red) — `ceSell` weighted vol + `ceSellersPct`
  - Put Buyers (bearish · red) — `peBuy` weighted vol + `peBuyersPct`
  - Put Sellers (bullish · green) — `peSell` weighted vol + `peSellersPct`

---

## 19. Writer Pressure Engine (per-strike institutional grade)

For each strike in the ladder, computes 8 metrics:

1. **OI velocity** = ΔOI / prior-OI × 100
2. **Premium state** = expanding / holding / decaying based on 5-bar trend
3. **Delta pressure** = |delta| × OI × 100 (gamma exposure proxy)
4. **Volume burst** = current vol > 1.5× prior-20 avg
5. **Smart-money tag** = Long Buildup / Short Buildup / Long Unwinding / Short Covering
6. **Wall strength** = OI / median-strike-OI ratio
7. **Trap risk** = piercing without acceptance (1 if true)
8. **Futures alignment** = side aligned with futures premium direction

These power the ladder card and the Best Trade Pick reasoning.

---

## 20. Row 3 — Confirmation layer

Each card uses a 2-column grid: **120 px pie LEFT · data RIGHT**. Pies are
slim (10% stroke), 110 px diameter, with toned-down inner text (20% pct,
9% sublabel relative to pie diameter).

| Card | Pie meaning | Data side |
|---|---|---|
| **3.1 Delta + Volume** | real buying strength (`buy / (buy+sell) × 100`); tone = delta bias | Aggression pill · Bid/Ask Imb (real `(buy-sell)/(buy+sell)*100`) · Net Delta · Volume Exp |
| **3.2 Market Breadth** | advancing % of total | Adv / Dec / A-D ratio / Participation |
| **3.3 Heavyweights / Index Breadth** | **dual-slice donut**: green bull% + red bear% (computed against `adv+dec` only) with both percentages rendered inline; center stack `X% BULL / X/Y / X% BEAR` | Heatmap dot-grid of every constituent (50 NIFTY / 30 SENSEX) sorted DESC by changePct, color intensity scales with abs(changePct) capped at 3% |
| **3.4 IV / VIX** | IV rank score 0-100 | India VIX · VIX Δ% · ATM IV · IV Crush yes/no |

The 3.3 card reads `breadth.allStocks[]` (newly added) which contains every
constituent's `{symbol, changePct, price}` sorted DESC. Title auto-adapts
to `NIFTY 50 Breadth` / `SENSEX 30 Breadth` based on `data.symbol`.

---

## 21. Row 4 — Structure context

Same 2-column pattern as Row 3. Pies show **directional strength** rather
than raw percentages where applicable:

| Card | Pie | Data |
|---|---|---|
| **4.1 VWAP / AVWAP** | how far stretched from VWAP, capped at ±0.5%. Green if above, red if below | VWAP · AVWAP · Reclaim yes/no |
| **4.2 EMA (9/20/50)** | stack alignment: 100% if fully ascending or fully descending, 50% if partial | EMA values · Trend pill |
| **4.3 CPR (Daily)** | bias strength: 100% outside CPR, 50% inside | TC · Pivot · BC · Status pill |
| **4.4 Max Pain** | distance from MP as % of day's range | Max Pain · Expiry · Day range · Bias pill (BULL DRAW / BEAR DRAW) |

---

## 22. Row 5 — No-Trade Engine

Eight binary conditions:

| Key | Trigger |
|---|---|
| `chopMarket` | regime = range AND trap detected |
| `weakPremium` | atmIv < 8 OR premiumTrap detected |
| `weakDelta` | bias = neutral AND |cvd| < 3 |
| `futuresDivergence` | |futPremium| > 50 |
| `insideValue` | spot inside `vaPrimary` (uses unified band) |
| `ivCrush` | vix.changePct < -3 |
| `breadthWeak` | adRatio < 0.7 |
| `heavyweightsWeak` | weighted impact < -0.3% |

Result:
- ≥ 4 flagged OR trap risk = high → **NO TRADE**
- ≥ 2 flagged OR trap risk = medium → **CAUTION**
- else → **SAFE TO TRADE**

Result tile shows a slim 90 px pie (flagged/total) on the left with a
ShieldCheck/AlertTriangle/ShieldX icon + verdict text on the right.

---

## 23. FII / DII Smart Money Flow card (Row 6)

Bottom-row full-width card driven by Sensibull payload:

### Section 1 — FUTURES OI table
```
Participant · Date · Buy OI · Sell OI · Net OI · Overall Bias
```
Sensibull doesn't publish Buy/Sell split for futures, so those cells render
`—`. Net OI from `quantity-wise.net_oi`. Bias = `view + strength`
(e.g. `BEARISH + Medium → "Medium Bearish"`).

### Section 2 — INDEX OPTIONS OI table
```
Participant · Date · Call Buy · Call Sell · Call Net · Put Buy · Put Sell · Put Net · Overall Bias
```
Buy/Sell from `call.long.oi_change` / `call.short.oi_change` per side.
For PRO (the only player with full long/short), all six numeric cells fill;
other players get `—` on Buy/Sell with cumulative `net_oi` as the Net.

### Section 3 — OVERALL BIAS panel
- **Institutional Bias headline** = FII futures `view + strength`
- **Reason bullets** auto-built from per-segment views (FII fut/opt
  direction, CE pressure, PRO mix, contrarian client warning)
- **Market Interpretation arrows**: directional playbook
  (`SELL ON RISE preferred`, `BUY PE on resistance rejection`, etc.)

---

## 24. Endpoint shape (high level)

```ts
{
  ok: true, version: 'v2', symbol, displayName,
  date, isToday, fallbackUsed, at, dataSource,
  market: { isOpen, phase, reason },
  spot: { ltp, change, changePct, vwap, ema9/20/50, atr, rsi, sessionAvwap, priorAvwap, live, liveTickAgeMs },
  futures: { ltp, premium, basisState, basis },
  regime: { regime, dayType, volatility, trendStrength },
  bias: { directionScore, overallBias, smartMoney, reasoning },
  confidence: { winning, label },
  trap: { risk, score, detected, rows[] },
  flow: {
    delta: { bias, cvd, totalBuy, totalSell, deltaPct, netDelta },
    volume: { poc, vah, val, hvns[], lvns[] } | null,
    oi: { ceWriting, peWriting, ceUnwinding, peUnwinding, pcr, ceTotal, peTotal },
  },
  options: { atm, maxPain, atmIv, atmCall, atmPut, callWall, putWall, expiry },
  cpr: { pivot, tc, bc, r1..r3, s1..s3, width, widthPct, widthClass } | null,
  avwap: { session, priorDay },
  macro: {
    vix, giftNifty, sensex, usFutures, dxy, crude, nikkei,
    fiiDii: { date, cash, future, option }
  },
  heavyweights: { rows[8], weightedAvgChangePct, advancing, declining, leaders[3], laggards[3] },
  verdict: { side, verdict, cePct, pePct, factors{}, weights{} },
  tradePlan: { action, reason, pick },
  ladder: LadderRow[],
  tradingDay: { today, expiry, expiryDate, daysToExpiry, lotSize },
  dashboard: {
    statusWidgets: { marketState, smartMoney, futures, premium, delta, trapRisk, bestAction, confidence, oiStructure, vwap },
    spotFutSeries: { spot[], futures[] },
    buildUp, buyerSellerFlow, auctionIntensity, vwapAvwapIntraday,
    frvpAuction, frvpInstitutional,
    futuresInfo: { oi, oiChange, volume, ltp, premium, basis, basisTrend, interpretation },
    oiHistogram[], oiShiftBias, oiBuildupAnalysis,
    marketDirection: { directionMeter, resistances[6], supports[6], oiEstimatedMove },
    cvdSeries[], delta: { totalBuyVol, totalSellVol, netDelta, deltaPct, bidAskImbalance, interpretation },
    frvpHistogram[], priceAbovePoc,
    breadth: { advancing, declining, unchanged, total, sampled, advancePct, leaders[5], laggards[5], allStocks[] },
    heavyweightsImpact[8], heavyweightsTotalImpact, heavyweightsAlignment,
    ivAnalytics: { vix, vixChangePct, atmIv, ivRank, trend[], interpretation },
    trapDetector[], regimeClassification,
    optionChainSnapshot[], topStrikeSelections,
    tradeBoard: { bestOptionBuy, alternateScenario, riskGauge, executionContext },
    heroZero, marketStory, tradeStrategy, executionEngine, premiumMomentum,
    bestTradePick, supportResistance, riskManagement, keyLevels[], noTradeConditions,
    liveAlerts[], spark1m[], hints{},
  },
  debug: { candleCounts, strikeCount, ladderCount, candleSource, optionChainSource },
}
```

---

## 25. Frontend layout (`/intel-v2`)

```
TopHeaderV2 ─ logo + symbol toggle + DATE/STATUS/STATE/TIME tiles + refresh
Row1MasterDecision ─ 8-tile institutional quote ribbon
ExecutionEngineCard ─ AI Execution Engine (final brain) — 230 px
Row1bTradeBoard ─ Hero/Zero (40%) + Premium Momentum (30%) + Trade Strategy (30%) — 260 px
Row1bTradeBoard ─ Best Option Buy + Alternate Scenario + Execution Context (3 col)
Row2InstitutionalFlow ─ 2.2 Market Direction (60%) + 2.5 FRVP Institutional Map (40%)
Row3ConfirmationLayer ─ 3.1 Delta · 3.2 Breadth · 3.3 Heavyweights · 3.4 IV/VIX (12 col, 360 px)
Row4StructureContext ─ 4.1 VWAP · 4.2 EMA · 4.3 CPR · 4.4 Max Pain (12 col, 300 px)
Row5NoTradeEngine ─ 8 condition tiles + Result donut (200 px)
MarketStoryCard ─ AI narrator (280 px)
FiiDiiCard ─ Smart Money Flow full-width bottom row (700 px)
AlertsTickerV2 ─ live alert strip
```

Hidden / commented (kept for reference):
- `Row6BottomPanel` — legacy bottom panel
- `Row7AuctionPanel` — legacy auction view
- `4.6 GIFT Nifty` — duplicate of Row 1 quote tile

---

## 26. Key files

```
backend/src/
  app.js                                       # mounts /api/intel-v2
  routes/intelV2.routes.js                     # snapshot + available-dates endpoints
  services/intelV2.service.js                  # orchestrator (~3400 lines)
  services/frvpEngine.service.js               # 14-section auction engine
  services/algorithms/marketInternals.service.js  # FII/DII Sensibull integration
  services/niftyFuturesProd.service.js         # NIFTY futures contract resolver + live tick
  services/dhanLiveFeedProd.service.js         # WebSocket packets 4/5/8 parser
  services/marketHours.service.js              # IST market open/closed
  services/sensexBackfill.service.js           # SENSEX put-call-parity premium derivation
  config/symbolRegistry.js                     # NIFTY_50, SENSEX, BANKNIFTY metadata

src/
  routes/intel-v2.tsx                          # page shell + 3s polling
  hooks/useIntelV2Snapshot.ts                  # poll loop, available-dates fetch
  lib/intelV2Types.ts                          # full type tree
  components/intelv2/dash/
    common.tsx                                 # V2Card · V2Pill · V2_TONE · V2MiniPie
    TopHeader.tsx                              # 4 neon tiles
    Row1MasterDecision.tsx                     # 8-tile ribbon
    Row1bTradeBoard.tsx                        # Best Option Buy / Alt / Exec Context
    HeroZeroCard.tsx                           # ZERO / HERO_CE / HERO_PE
    PremiumMomentumCard.tsx                    # CE / PE expansion sparklines
    TradeStrategyCard.tsx                      # 5-strategy verdict
    ExecutionEngineCard.tsx                    # final-brain card with big slim ring
    Row2InstitutionalFlow.tsx                  # combined 2.2 + 2.5 FRVP, S/R below
    SupportResistanceCard.tsx                  # pressure bar + 13-chip strike ladder
    Row3ConfirmationLayer.tsx                  # 3.1-3.4 with pies
    Row4StructureContext.tsx                   # 4.1-4.4 with pies
    Row5NoTradeEngine.tsx                      # 8 tiles + Result donut
    MarketStoryCard.tsx                        # AI narrator
    FiiDiiCard.tsx                             # full-width FII/DII bottom row
    AlertsTicker.tsx                           # live alert strip
```

---

## 27. Operational notes

- Backend has **no nodemon** — must hard-restart for code changes.
  `taskkill /F /PID <pid>` then `node src/server.js` from `backend/`.
- Cache TTL: live = 800 ms · historical = 60 s · macro/breadth = 60 s.
- 3-second polling on the page side.
- All option strike picks **must** be 100-step within ATM ± 6 (via the
  `_hundredStepWindow()` helper). Even on indexes with 50-step chains
  (NIFTY), the dashboard renders only the 100-step strikes.
- Symbol registry: NIFTY_50 sid=13 step=50 · SENSEX sid=51 step=100 ·
  BANKNIFTY sid=25 step=100.
- NIFTY futures pulled via `niftyFuturesProd.service.js` (NSE_FNO).
  SENSEX uses put-call parity for implied premium.

---

## 28. Math invariants (sanity assertions)

The engine guarantees:

- `cePct + pePct === 100` always
- `verdict.factors[k] × verdict.weights[k]` summed = `directionScore` × 2
- `frvpInstitutional.engine.dominance.buyersScore + sellersScore === 100`
- `flow.delta.totalBuy + totalSell` = total option chain volume in window
- `breadth.advancing + declining + unchanged ≤ breadth.total`
- All option strike picks in `tradeBoard`, `bestTradePick`, `heroZero`,
  `tradeStrategy`, `executionEngine` lie within ATM ± 600 pts (6 strikes
  × 100-step) and are divisible by 100.
- `executionEngine.votes.ce + pe + wait` does not necessarily = 100; raw
  weighted sums are kept so the relative magnitudes are preserved.

---

## 29. Recent fixes & lessons

| Bug | Symptom | Fix |
|---|---|---|
| `bidAskImbalance` hardcoded | always 0 in 3.1 Delta card | replaced with real `((buy-sell)/(buy+sell))×100` |
| `futuresInfo.oi` / `oiChange` hardcoded | always 0 | wired to live `niftyFuturesProd.getLiveTick()` |
| FRVP buyers/sellers always ~50/50 | `(ceBuyersPct + peBuyersPct)/2` averaged opposite signals | replaced with `bullishVol/(bullishVol+bearishVol)*100` |
| Premium Momentum reported `CE_EXPANDING` always | static skew formula = LTP ratio, not derivative | added per-symbol ring buffer with 8-min baseline window |
| HeroZero / TradeStrategy / Exec said "Inside Value" while FRVP said "Below Value" | two different VAH/VAL bands in snapshot | unified through `vaPrimary` constant (engine-profile preferred) |
| Trade Strategy tie-break used JS insertion order | always preferred BUY_ON_DIP_CE on tie | tie-break by `(verdict, location)` composite |
| `expiry.slice` crash when expiry was Date or number | `Row4StructureContext` MaxPain card crashed | added `typeof expiry === 'string'` guard |
| `DHAN_CLIENT_ID missing` 401 loop | live feed never started | added explicit `DHAN_CLIENT_ID` env var (extracted from JWT payload) |

---

*Last updated: dashboard recompose pass — slim pie charts, FRVP fixes, premium momentum ring buffer, vaPrimary unification, header tile redesign, full breadth dot grid, dual-slice bull/bear pie.*
