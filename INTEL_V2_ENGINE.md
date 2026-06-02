# INTEL V2 — INSTITUTIONAL CONSOLE ENGINE (complete reference)

> A self-contained, deterministic market-intelligence snapshot for **NIFTY 50 /
> SENSEX / BANKNIFTY**. No AI, no DB writes, no engine-state mutation — every value
> is computed on each request from candles + option chain + macro context.

This document covers **every function and every dashboard section** in the V2 engine,
with a brief "logic used" summary for each.

- **Service:** `backend/src/services/intelV2.service.js` (~4,300 lines)
- **Controller:** `backend/src/controllers/intelV2.controller.js`
- **Routes:** `backend/src/routes/intelV2.routes.js`
- **Frontend types:** `src/lib/intelV2Types.ts`
- **Frontend route:** `src/routes/intel-v2.tsx` (+ `src/components/intelv2/**`)

---

## 0. API Surface

| Endpoint | Logic |
|----------|-------|
| `GET /api/intel-v2/snapshot?symbol=&date=` | Full single-symbol snapshot. Validates symbol ∈ {NIFTY_50, SENSEX, BANKNIFTY}, optional `YYYY-MM-DD` date (else live). |
| `GET /api/intel-v2/dual?date=` | Runs `getSnapshot` for **both** NIFTY_50 and SENSEX in parallel; returns `{ NIFTY_50, SENSEX }`. |
| `GET /api/intel-v2/available-dates?symbol=` | Lists recorded live-feed dates for a symbol. |

Read-only, no auth (dashboard polls every ~3s). Controller is a thin validator;
all computation is in the service.

---

## 1. Data Sources & Priority

The engine pulls data in a strict fallback order so it works live **and** for historical replay:

1. **Live-feed folder** — `backend/live-feed/<DATE>_<SYMBOL>/` JSONL recordings
   (`candles-1m/5m/15m/30m.jsonl`, `futures-*.jsonl`, `option-chain.jsonl`, `metadata.json`).
2. **Dhan production API** — historical candles + live option chain (only valid for "today").
3. **Live WebSocket tick** — overrides the last 1-minute candle close when market is open and the tick is < 5s old (avoids a stale price during the open bar).
4. **Yahoo Finance** — macro context (VIX, GIFT, US futures, DXY, crude, Nikkei) + per-stock breadth/heavyweights.
5. **Sensibull** — FII/DII institutional cash flow (via `marketInternals`).

**Caching:** snapshot cached 800 ms live / 60 s historical; macro & breadth & heavyweights cached 60 s.

---

## 2. Helper Functions (utilities)

### Number / format
| Function | Logic |
|----------|-------|
| `_safe(n, d=0)` | Coerce to finite number, else default. |
| `_round(n, d=2)` | Round to `d` decimals (0 if non-finite). |
| `_fmtOiCompact(n)` | Format OI into `{val, unit}` — ≥1Cr → "Cr", ≥1L → "L". |

### Date / session
| Function | Logic |
|----------|-------|
| `_todayIST()` | Today's date in IST as `YYYY-MM-DD`. |
| `_isWeekend(d)` | True for Sat/Sun (UTC day 0/6). |
| `_sessionUtcRange(d)` | Returns UTC epoch range for the trade session (09:15–15:30 IST → 03:45–10:00 UTC). |
| `_previousTradingDay(d)` | Walk back skipping weekends. |
| `_activeAuthKey()` | Dhan access token from env. |

### Indicator math
| Function | Logic |
|----------|-------|
| `_ema(values, period)` | Standard EMA, `k = 2/(period+1)`. |
| `_vwap(candles)` | Volume-weighted avg of typical price `(H+L+C)/3`. |
| `_anchoredVwap(candles, anchorIdx)` | VWAP from a chosen start index (session vs prior-anchor AVWAP). |
| `_atr(candles, 14)` | Average True Range over last 14 bars. |
| `_rsi(closes, 14)` | Wilder's RSI. |
| `_cprFromOHLC(ohlc)` | **CPR** — `pivot=(H+L+C)/3`, `BC=(H+L)/2`, `TC=2·pivot−BC`, plus R1–R3 / S1–S3, width % and `widthClass` (narrow <0.15%, wide >0.40%, else normal). |

### File loaders (live-feed folder)
| Function | Logic |
|----------|-------|
| `_folderFor / _readJsonl` | Resolve folder path; parse JSONL line-by-line, skip bad lines. |
| `_readCandlesFile(date, sym, kind, tf)` | Read & normalise candles to `{timestamp,o,h,l,c,v}`, then sanitise. |
| `_sanitiseCandles(rows, range)` | Drop candles from the wrong symbol: validate median close against the expected range; drop ±30% outliers. |
| `_readLatestOptionChain` | Last option-chain row of the day (spot, atm, expiry, strikes[]). |
| `_readMetadata / _hasLiveFeed / _availableDatesForSymbol` | Metadata read, folder existence check, list recorded dates. |
| `_EXPECTED_RANGE` | Per-symbol price guards (NIFTY 10k–40k, SENSEX 40k–120k, BANKNIFTY 30k–80k). |

### Remote loaders
| Function | Logic |
|----------|-------|
| `_yahooQuote(symbol)` | One Yahoo chart quote → price/change/changePct/prevClose. |
| `_macroContext()` | Parallel-fetch VIX, GIFT (^NSEI proxy), S&P/Nasdaq futures, DXY, crude, Nikkei, SENSEX + FII/DII. 60s cache. |
| `_heavyweights(sym, date)` | Top-8 index constituents (Yahoo) → weighted avg change, advancing/declining, leaders/laggards. |
| `_fullBreadth(sym, date)` | Full 50/30-stock breadth → advancing/declining/unchanged, advancePct, A/D ratio, leaders/laggards, full heatmap list. |
| `_loadCandles / _loadOptionChain / _loadPriorDayOHLC` | Folder-first, Dhan-API fallback loaders for candles, option chain, and prior-day OHLC (CPR + change baseline). |

---

## 3. Analyzer Functions (the engine's brains)

### `_computeAtm(spot, step)`
Rounds spot to the nearest strike step → ATM strike.

### `_strikeLadder(strikes, atm, range=4, bias)`  → `ladder[]`
**Logic:** Builds an ATM ± `range` ladder. For each CE/PE leg computes a **health score (0–100)** from: delta band (0.45–0.65 ideal), IV band (12–30 healthy), theta/LTP ratio (decay penalty), OI change direction, bias alignment, OI liquidity, volume, and dead-premium penalty. Maps score → state (`explosive` ≥70, `healthy` ≥55, `weak` ≥40, else `dead`). Carries `ltp, oi, oiChange, iv, delta, gamma, theta, vega, volume, health, buildup`.

### `_atmBlocks(strikes, atm)`  → walls / pain / PCR
**Logic:** Scans all strikes for: highest-OI CE strike = **Call Wall**, highest-OI PE = **Put Wall**, strike with max combined OI = **Max Pain**. Totals CE/PE OI → **PCR = totPE/totCE**. Counts writing vs unwinding per side → `ceWriting/peWriting/ceUnwinding/peUnwinding`. Extracts ATM IV and ATM CE/PE summaries.

### `_oiHistogram(strikes, atm, range=4, step=100, ctx)`  → per-strike buyer-favour
**Logic:** Clean 100-step window around ATM. Per strike computes a **CE-buy vs PE-buy favour score (0–100 each)** from: writing dominance (OIΔ), spot-vs-strike position, delta band (0.30–0.55 cheap gamma), premium liveness, and OI presence. Normalises to `ceFavorPct/peFavorPct` and a `favorSide`.

### `_oiBuildupAnalysis(strikes, atm, spot, step=100, range=6)`
**Logic:** Builds the institutional "OI Buildup" card — top stats strip (spot, total CE/PE OI, PCR, market view), per-side top-strike tables with prior-day OI proxy, today's OI, ΔOI, %Δ, and a buildup interpretation tag (Long/Short Buildup, Covering, Unwinding) per the Sensibull/IIFL convention.

### `_oiShiftBias(rows)`
**Logic:** Aggregates the histogram rows into a single side + % verdict (CE/PE dominance shift) with call/put build counts.

### `_volumeProfile(candles)`  → FRVP POC/VAH/VAL
**Logic:** Bins closes by ~0.05% price buckets weighted by volume → **POC** (max-volume bin), **VAH/VAL** (70% value-area edges), plus HVNs/LVNs.

### `_cvdSeries(candles)`
**Logic:** Cumulative volume delta proxy — `+volume` on up bars, `−volume` on down bars, accumulated.

### `_deltaFromCandles(candles)`
**Logic:** Splits candle volume into buy (close ≥ open) vs sell; `deltaPct = (buy−sell)/total×100`; bias bullish >8%, bearish <−8%.

### `_regimeFromCandles(c1m, c5m, c15m)`
**Logic:** EMA20 vs EMA50 + price → `trending_bullish/bearish` or `range`; ATR-vs-range → volatility `expansion/dead/normal`; produces `dayType` (TREND/RANGE/VOLATILE DAY) and `trendStrength`.

### `_masterVerdict({...})`  → the directional core
**Logic:** Weighted fusion of ~13 factors into `cePct / pePct (0–100)`:
`PCR (0.03), OI writers (0.10), VWAP (0.10), EMA stack (0.10), CPR (0.06), heavyweights (0.10), VIX (0.05), GIFT (0.06), FII/DII (0.08), futures premium (0.07), option delta (0.13), IV (0.04), breadth (0.08)`. Each factor is clamped to ±range, summed to a composite, mapped to `cePct = 50 + composite/2`. Verdict tiers: ≥70 STRONG_BULLISH, ≥58 BULLISH, ≤30 STRONG_BEARISH, ≤42 BEARISH, else NEUTRAL. *(PCR weight deliberately low — unreliable intraday; delta + flow weighted highest.)*

### `_pickBestStrike(side, ladder, atm)`
**Logic:** Ranks ladder legs of one side by a probability blend (health, delta band, OI, liquidity) → best tradeable strike.

### `_hundredStepWindow(ladder, atm, range=6)`
**Logic:** Returns a clean 100-step ATM ± range slice of the ladder (drops half-step strikes).

### `_bestTradePicks({...})`
**Logic:** Independent CE & PE strike picks with **confluence probability** fused from verdict %, FRVP bias, acceptance, delta bias, strike health, OI, minus a trap penalty. Returns `primary` (higher prob) + `ce`/`pe` detail.

### `_tradePlan(verdict, ladder, atm, marketOpen)`
**Logic:** Turns the verdict side into an actionable plan — chosen strike, entry/SL/target levels, `NO_TRADE` if no liquid strike in ATM ± 4.

### `_ivRank(atmIv)`
**Logic:** IV → rank/label: ≥28 HIGH (bear), 18–28 / 12–18 MODERATE, 6–12 LOW (bull), <6 DEAD.

### `_supportResistance(strikes, atm, spot)`
**Logic:** PE walls below = supports, CE walls above = resistances, ranked by OI; pressure score (support vs resistance strength) → BULLISH/BEARISH/NEUTRAL.

### `_topStrikeSelections(ladder, atm, verdict, atmBlk)`
**Logic:** Picks the top CE, PE, and combined strikes for the quick-selection strip.

### `_heavyweightsImpact(heavy, indexValue)`
**Logic:** Per heavyweight, converts its % change × index weight into **index points contributed** (so you see which stocks are pushing/dragging the index).

### `_trapDetection({...})`  → bull/bear trap risk
**Logic:** Heuristic boolean rows — fake breakout (price vs VWAP/EMA divergence), premium trap (dead IV), delta divergence, exhaustion. Aggregates into `risk` (low/medium/high), `score`, `detected` count.

### `_liveAlerts({...})`
**Logic:** Generates time-stamped alert chips from wall proximity, futures basis, and heavyweight moves.

### `_statusWidgets({...})`
**Logic:** Builds the top status tiles — Market State, Delta Aggression, Trap Risk, Trade Action, Confidence Score, etc., each with label + tone.

### `_smartMoneyBias({deltaBias, peWriting, ceWriting})`
**Logic:** `bullish + PE writing → buyers`, `bearish + CE writing → sellers`, else follows delta bias.

---

## 3.5 Option-Buyer Institutional Engines (v2 upgrades)

> These answer the question a professional option buyer actually asks — *"is this
> move worth chasing?"* — rather than just *"is the market bullish or bearish?"*.
> Option buyers make money when **premium expands faster than theta decay**, not from
> being directionally correct. No new indicators were added; all six build on data V2
> already produces, plus three small per-symbol ring-buffer histories.

### Shared history infra
`_pushHistory(map, key, sample, max, ttl)` — generic age-pruned, length-capped ring
buffer. Three buffers (40-min TTL, 240 samples):
- `_efficiencyHistory` — `{ t, spot, ceLtp, peLtp, ceDelta, peDelta }`
- `_deltaHistory` — `{ t, deltaPct }`
- `_wallHistory` — `{ t, callWall, putWall }`

> History-based engines (Efficiency, Persistence, Migration) read **WARMING UP** until
> the buffers fill from live 3-second polling (a few minutes), then activate. Wall
> Break and Quality Score work on the first tick.

### ⭐ `_premiumEfficiency(symbol, atm, spot, atmBlk)` — Tier 1
**Question:** *Is premium actually responding to the move?*
**Logic:** Picks a baseline sample ~6 min old. Determines the side that *should* be
gaining (`spotMove ≥ 0 → CE`, else `PE`). Computes:
```
expectedΔpremium = |spotMove| × |delta|
actualΔpremium   = curLtp − baseLtp
efficiency%      = actualΔ / expectedΔ × 100
```
| Efficiency | Label | Meaning |
|------------|-------|---------|
| ≥ 120% | EXPLOSIVE | premium expanding faster than the move — buyers well paid |
| 90–120% | HEALTHY | premium tracking the move |
| 70–90% | WEAK | premium lagging — buyers underpaid |
| < 70% | DEAD | premium not responding — theta/IV killing it |
If spot barely moved (< ~0.04%) → **FLAT** (efficiency not meaningful).

### ⭐ `_deltaPersistence(symbol, deltaPct)` — Tier 1
**Question:** *Is buying/selling sustained or just a spike?*
**Logic:** Keeps last 10 `deltaPct` samples; computes `avg` and `sameSignPct` (fraction
of recent samples sharing the dominant sign with |value| ≥ 3).
- `sameSignPct ≥ 70 & |avg| ≥ 8` → **PERSISTENT BUYING/SELLING**
- `sameSignPct ≥ 55 & |avg| ≥ 5` → **BUILDING BUYING/SELLING**
- latest |value| ≥ 12 but `sameSignPct < 50` → **TEMPORARY SPIKE** (don't chase)
- else → **CHOPPY / NEUTRAL**
Returns a 10-point series for the sparkline.

### ⭐ `_strikeMigration(symbol, callWall, putWall)` — Tier 1
**Question:** *Are institutions shifting their walls?*
**Logic:** Tracks the dominant CE-OI and PE-OI walls over time; compares first vs last:
- both rising → **BULLISH** (repositioning higher)
- both falling → **BEARISH**
- CE up & PE down → walls widening (range expanding) → neutral/warn
- CE down & PE up → walls compressing (squeeze) → neutral/warn
Returns wall trails + drift + window minutes.

### `_premiumTrapProbability(efficiency, deltaPersist, spotChangePct)` — Tier 2
**Question:** *Is this a premium trap (price moves, premium doesn't)?*
**Logic:** Adds risk points: DEAD efficiency +50 / WEAK +30; premium falling into the
move +25; delta TEMPORARY SPIKE +20. → **LOW (<30) · MEDIUM (30–59) · HIGH (≥60)** with
reasons.

### `_optionBuyerQuality({...})` — Tier 2
**Question (one number):** *Should I buy?*
**Logic:** Fuses six factors (0–100): Premium Efficiency (0–30) + Delta Persistence
(0–20) + FRVP acceptance/dominance (0–18) + Strike Migration (0–12) + Regime (0–10) +
IV health (0–10).
| Score | Action |
|-------|--------|
| ≥ 80 | AGGRESSIVE BUY |
| 65–79 | BUY DIPS |
| 50–64 | WATCH |
| < 50 | AVOID |
Returns the per-factor breakdown so the score is transparent.

### `_wallBreakProbability(atmBlk, spot, deltaPct, strikes)` — Tier 3
**Question:** *How breakable is the wall?*
**Logic:** For the nearest CE (resistance) & PE (support) walls, computes **strength
(5–95)** from base 40 + OI size (+8/+15/+25) + fresh OIΔ (writers defending +15 /
unwinding −15) + distance to spot (far +10 / near −12) − flow pushing into the wall
(−12). **breakProbability = 100 − strength.**

---

## 4. `getSnapshot({ symbol, date })` — orchestration flow

1. **Resolve date** — validate `YYYY-MM-DD`; weekend → previous trading day; check cache.
2. **Market state** — `isToday`, `marketOpen` via `marketHours.service`.
3. **Load candles** — folder→Dhan; if empty, walk back up to 5 trading days (fallback).
4. **Indicators** — EMA 9/20/50, VWAP, session & prior AVWAP, ATR(14), RSI(14), day H/L.
5. **Prior-day OHLC → CPR**.
6. **Spot** — last candle close, overridden by fresh (<5s) live WS tick when open; compute change/changePct vs prior close.
7. **Option chain → ATM blocks** (walls, pain, PCR, ATM IV).
8. **Delta / regime / volume profile / CVD** from 5m candles.
9. **Futures premium** — live near-month NIFTY tick (with OI), or **put-call parity** forward for SENSEX (`Forward = K + CE − PE`).
10. **Macro / heavyweights / full breadth** (parallel).
11. **Master verdict → overallBias → ladder → trade plan → traps → S/R**.
12. Build **all dashboard sections** (below) and assemble the final response.

---

## 5. Dashboard Sections (the `dashboard.*` payload)

Each is an inline builder in `getSnapshot`. Brief logic summary per section:

| Section | Logic used |
|---------|-----------|
| **statusWidgets** | Top status tiles (Market State, Delta, Trap, Action, Confidence) — see `_statusWidgets`. |
| **tradingDay** | Resolved date + market phase. |
| **spotFutSeries** | Last ~80 1m closes for spot + futures overlay chart. |
| **buildUp** | Detects dominant Long/Short Buildup + Unwinding/Covering strikes from per-strike OIΔ; strength label (delta-aligned) + velocity (|deltaPct|) + shift bias. |
| **buyerSellerFlow** | ATM ± 4 per-leg volume split into buy/sell shares using **buildup-tag weights** (e.g. Long Buildup 80/20); falls back to OIΔ + spot direction heuristic → CE & PE buyers/sellers %. |
| **auctionIntensity** | Weighted `breadth 0.4 + deltaScore 0.4 + volScore 0.2` → Strong/Moderate/Weak Participation. |
| **vwapAvwapIntraday** | VWAP, prior-day AVWAP, price vs VWAP, bias. |
| **frvpAuction** | Full intraday auction profile — POC/VAH/VAL, session H/L, Initial Balance (first 60m), volume inside-IB vs out, POC shape (P/b/balanced), acceptance/rejection, buyer/seller advantage summary. |
| **frvpInstitutional** | Runs the external **`frvpEngine.evaluate()`** (13-section institutional auction engine — dominance, delta, acceptance, premium velocity) + value-area marker, buyers/sellers entering/leaving, interpretation. |
| **futuresInfo** | Futures OI, OIΔ, volume, LTP, premium/basis, basis-trend interpretation. |
| **oiHistogram / oiShiftBias** | ATM ± 4 buyer-favour map + single shift verdict (see `_oiHistogram`). |
| **oiBuildupAnalysis** | Institutional writing-pressure tables (see `_oiBuildupAnalysis`). |
| **marketDirection** | 6-tier resistance ladder (CE walls above) + 6-tier support ladder (PE walls below), direction meter (downside vs upside % from verdict), OI estimated-move targets, max pain. |
| **cvdSeries** | Cumulative volume delta line. |
| **delta** | Buy/sell volume, net delta, deltaPct, bid/ask imbalance, interpretation. |
| **frvpHistogram / priceAbovePoc** | Volume-profile bins; % of bars closed above POC. |
| **breadth** | Advancing/declining/unchanged + interpretation tier. |
| **heavyweightsImpact / TotalImpact / Alignment** | Per-stock index-point contribution + net + aligned-count label. |
| **ivAnalytics** | VIX + ATM IV + IV rank + synthetic IV trend + cheap/expensive interpretation. |
| **trapDetector** | Trap rows (see `_trapDetection`). |
| **regimeClassification** | Day type, volatility, trend strength, market quality (from trap risk), participation. |
| **optionChainSnapshot** | ATM ± 2 table (CE/PE LTP, OI, IV, delta). |
| **topStrikeSelections / bestTradePick** | Quick strike picks + best CE/PE confluence pick. |
| **tradeBoard** | 4 glance cards: Best Option Buy, Alternate Scenario, Risk Gauge, Execution Context (with mini key levels). |
| **heroZero** | High-risk sniper banner. Scores **6 boolean signals per side** (Above VAH/Below VAL +2, Above/Below VWAP +2, premium expanding right side +2, dominance ≥65% +1, delta ≥±10% +1, volume burst >1.5× +1; max 9). **Hero fires at ≥7** → HERO_CE / HERO_PE, else ZERO; also flags bull/bear traps. |
| **premiumMomentum** | Real CE/PE premium velocity from FRVP engine's premium-velocity state → expansion/contraction read. |
| **premiumEfficiency** ⭐ | Actual vs expected premium move (`actualΔ / (|spotMove|×delta)`) → EXPLOSIVE / HEALTHY / WEAK / DEAD / FLAT. (history-based) |
| **deltaPersistence** ⭐ | Last-10 deltaPct → PERSISTENT BUYING/SELLING vs TEMPORARY SPIKE vs CHOPPY (sameSign% + avg). (history-based) |
| **strikeMigration** ⭐ | CE/PE OI wall drift over time → bullish (both rising) / bearish (both falling) / widening / compressing. (history-based) |
| **premiumTrap** | Trap probability from poor efficiency + premium falling into the move + unsustained delta → LOW/MEDIUM/HIGH. |
| **wallBreak** | Per-wall strength (OI + fresh OIΔ + distance + flow) and breakProbability for resistance (CE) & support (PE). |
| **optionBuyerQuality** | One 0–100 score (efficiency + persistence + FRVP + migration + regime + IV) → AGGRESSIVE BUY / BUY DIPS / WATCH / AVOID. |
| **tradeStrategy** | Chosen strategy (Breakout / Buy Dip / Sell Rise / Reversal) with target strike, confidence, and the 4 firing reasons. |
| **executionEngine** | "AI Execution Engine" card — time-of-day phase (Pre-market / Open Drive / Mid / Power Hour), final action (BUY CE/PE/WAIT), entry type, votes, mode (HERO/NORMAL/AVOID), invalidation rules. |
| **marketStory** | Narrative paragraph fusing HeroZero, FRVP engine, S/R, verdict, delta, market direction, VWAP, futures into plain-English lines + headline. |
| **supportResistance / keyLevels** | Wall-based S/R + side-panel key levels (resistance, support, pivot, day H/L). |
| **riskManagement** | Lot size, position lots, SL/target sizing for the picked strike. |
| **noTradeConditions** | Boolean kill-switch panel — Chop Market, Weak Premium (IV<8), Weak Delta, Futures Divergence, Inside Value, etc. → result NO TRADE / CAUTION / OK. |
| **hints** | Per-card one-line footer interpretations. |
| **spark1m** | Last 60 1m bars for the footer sparkline. |

---

## 6. Top-Level Response Fields

```jsonc
{
  ok, version: "v2", symbol, displayName, requestedDate, date, isToday,
  fallbackUsed, at, dataSource, market: { isOpen, phase, reason },
  spot:    { ltp, change, changePct, dayHigh, dayLow, priorClose,
             vwap, ema9, ema20, ema50, atr, rsi, sessionAvwap, priorAvwap, live, liveTickAgeMs },
  futures: { ltp, premium, basisState, basis },
  regime, bias: { directionScore, overallBias, smartMoney, reasoning },
  confidence: { winning, label },
  trap: { risk, score, detected, rows },
  flow: { delta, volume: {poc,vah,val,hvns,lvns}, oi: {ceWriting,peWriting,…,pcr,ceTotal,peTotal} },
  options: { atm, maxPain, atmIv, atmCall, atmPut, callWall, putWall, expiry },
  cpr, avwap: { session, priorDay },
  macro, heavyweights, verdict, tradePlan, ladder, tradingDay,
  dashboard: { … all sections from §5 … },
  debug: { candleCounts, strikeCount, ladderCount, candleSource, optionChainSource }
}
```

`getDualSnapshot` wraps two of these as `{ ok, NIFTY_50, SENSEX, at }`.

---

## 7. Engine Hierarchy (how a verdict is built)

```
candles + option chain + macro
        │
        ├─ indicators (EMA/VWAP/AVWAP/ATR/RSI/CPR)
        ├─ option analytics (ATM blocks, PCR, walls, OI buildup, histogram)
        ├─ flow (delta, CVD, volume profile / FRVP POC-VAH-VAL)
        ├─ context (breadth, heavyweights, FII/DII, VIX, GIFT, futures basis)
        │
        ▼
  _masterVerdict  ──►  cePct / pePct  ──►  overallBias + confidence
        │
        ├─ ladder + _tradePlan + _bestTradePicks
        ├─ heroZero (6-signal sniper)  ·  tradeStrategy  ·  executionEngine
        ├─ OPTION-BUYER LAYER (v2 upgrades):
        │     premiumEfficiency → deltaPersistence → strikeMigration
        │     → premiumTrap → wallBreak → optionBuyerQuality (0–100 verdict)
        └─ trap detection · no-trade conditions · market story
```

---

## 8. Frontend

- **Route:** `src/routes/intel-v2.tsx` polls `/api/intel-v2/snapshot` (3s live, once for history) via the snapshot hook; renders all cards from `dashboard.*`.
- **Components:** `src/components/intelv2/**` (e.g. `dash/ExecutionEngineCard.tsx`, dashboard cards, headers). The six option-buyer engines render in **`dash/OptionBuyerEngineCard.tsx`** (one card: Buyer Quality headline + Premium Efficiency · Premium Trap · Delta Persistence sparkline · Strike Migration · Wall Break).
- **Types:** `src/lib/intelV2Types.ts` mirrors the response shape above (incl. `dashboard.premiumEfficiency / deltaPersistence / strikeMigration / premiumTrap / wallBreak / optionBuyerQuality`).

---

## 9. Quick Reference — Key Thresholds

```
DELTA bias:     >+8% bullish · <-8% bearish
PCR:            totPE/totCE   (weight only 0.03 in verdict — intraday-unreliable)
IV RANK:        ≥28 HIGH · 18-28 / 12-18 MODERATE · 6-12 LOW · <6 DEAD
CPR WIDTH:      <0.15% narrow · >0.40% wide · else normal
VERDICT cePct:  ≥70 STRONG_BULL · ≥58 BULL · ≤42 BEAR · ≤30 STRONG_BEAR · else NEUTRAL
OVERALL BIAS:   cePct≥55 bullish · pePct≥55 bearish · else neutral
HERO/ZERO:      score 0-9; HERO at ≥7 (Above VAH/VWAP +2 each, premium +2, dominance/delta/volume +1 each)
AUCTION:        breadth·0.4 + delta·0.4 + vol·0.2 → ≥75 Strong · ≥55 Moderate · else Weak
FUTURES BASIS:  Forward−Spot; SENSEX uses put-call parity K+CE−PE
LIVE TICK:      used only if < 5s old, else candle close
CACHE:          800ms live · 60s historical · macro 60s

── OPTION-BUYER ENGINES (v2 upgrades) ──
PREMIUM EFFICIENCY:  actualΔ / (|spotMove|×delta) → ≥120 EXPLOSIVE · 90-120 HEALTHY · 70-90 WEAK · <70 DEAD
DELTA PERSISTENCE:   last-10 deltaPct; sameSign≥70 & |avg|≥8 PERSISTENT · ≥55 BUILDING · spike&<50 TEMPORARY · else CHOPPY
STRIKE MIGRATION:    both walls↑ BULLISH · both↓ BEARISH · widen/compress NEUTRAL
PREMIUM TRAP:        DEAD+50 / WEAK+30 / premium-falling+25 / delta-spike+20 → <30 LOW · 30-59 MED · ≥60 HIGH
BUYER QUALITY 0-100: Eff30 + Persist20 + FRVP18 + Migration12 + Regime10 + IV10 → ≥80 AGG BUY · 65-79 BUY DIPS · 50-64 WATCH · <50 AVOID
WALL BREAK:          strength 5-95 (OI + fresh OIΔ + distance + flow); breakProb = 100 − strength
HISTORY BUFFERS:     40-min TTL, 240 samples; engines WARM UP over first few live polls
```

---

## 10. Live Output Snapshot (NIFTY 50 · 2026-05-27)

Real `GET /api/intel-v2/snapshot` output (trimmed to the key + new engine fields).
History-based engines show *WARMING UP* here because this was a historical replay
(single cached snapshot); in live mode they activate after a few 3-second polls.

```jsonc
{
  "ok": true, "version": "v2", "symbol": "NIFTY_50", "date": "2026-05-27",
  "spot":    { "ltp": 23924.25, "change": 4.65, "changePct": 0.02, "vwap": 23903.23 },
  "futures": { "ltp": 24010, "premium": 85.75, "basisState": "premium" },
  "options": { "atm": 23900, "maxPain": 24000, "atmIv": 12.95, "callWall": 24000, "putWall": 23900 },
  "flow": {
    "oi":    { "pcr": 0.92, "ceTotal": 33651605, "peTotal": 30899180, "ceWriting": false, "peWriting": false },
    "delta": { "deltaPct": 26.59, "bias": "bullish" }
  },
  "verdict": { "side": "CE", "verdict": "BULLISH", "cePct": 60.1, "pePct": 39.9 },

  "dashboard": {
    "premiumEfficiency": { "ready": false, "label": "WARMING UP", "side": null,
                           "interpretation": "Collecting premium history…", "historyDepth": 1 },
    "deltaPersistence":  { "ready": false, "state": "WARMING UP", "series": [26.6], "avg": 26.6 },
    "strikeMigration":   { "ready": false, "ceWallTrend": "STABLE", "peWallTrend": "STABLE",
                           "callWall": 24000, "putWall": 23900, "ceDrift": 0, "peDrift": 0 },
    "premiumTrap":       { "probability": 0, "level": "LOW", "tone": "bull",
                           "interpretation": "Low trap risk — premium behaviour supports the move." },
    "wallBreak": {
      "resistance": { "strike": 24000, "oi": 8895250, "oiChange": 3052660,
                      "distancePct": 0.32, "strength": 68, "breakProbability": 32 },
      "support":    { "strike": 23900, "oi": 5949840, "oiChange": 2969135,
                      "distancePct": 0.10, "strength": 68, "breakProbability": 32 }
    },
    "optionBuyerQuality": {
      "score": 20, "action": "AVOID", "side": "CE",
      "breakdown": [
        { "k": "Premium Efficiency", "pts": 0 }, { "k": "Delta Persistence", "pts": 0 },
        { "k": "FRVP Acceptance", "pts": 0 },    { "k": "Strike Migration", "pts": 0 },
        { "k": "Regime", "pts": 10 },            { "k": "IV Health", "pts": 10 }
      ],
      "interpretation": "Low quality — premium/structure not aligned, avoid."
    }
  }
}
```

> Reading it: structure is mildly bullish (verdict CE 60%, futures premium +85, delta
> +26%), but the **option-buyer layer withholds approval** — Buyer Quality is only 20
> (AVOID) because the premium-behaviour engines haven't confirmed (history warming up,
> IV healthy but efficiency/persistence/migration not yet scored). Wall Break shows both
> the 24000 resistance and 23900 support at 68% strength (32% break chance) — a balanced
> cage. This is exactly the "don't chase direction without premium confirmation" filter
> the layer is designed to enforce.

---

*This dashboard is for educational purposes only. Always consult a financial advisor
before trading.*
