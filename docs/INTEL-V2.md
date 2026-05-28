# Intel V2 — Institutional Options Console

A self-contained intraday options-flow dashboard. Single endpoint
(`GET /api/intel-v2/snapshot?symbol=NIFTY_50&date=YYYY-MM-DD`) returns a
fully-populated payload that drives every card on `/intel-v2`.

The whole stack reuses the live-feed folder (`backend/live-feed/<date>_<symbol>/`)
and the production option-chain API — no v1 dependency.

---

## 1. Data sources

| Source | What we read | When |
|---|---|---|
| `live-feed/<date>_<symbol>/candles-{1m,5m,15m,30m}.jsonl` | Spot OHLCV per timeframe | always (preferred) |
| `live-feed/<date>_<symbol>/futures-{1m,5m,15m,30m}.jsonl` | Index-futures OHLCV | always (preferred) |
| `live-feed/<date>_<symbol>/option-chain.jsonl` | Latest snapshot of the chain | always |
| `dhanProd.service` historical API | Spot/futures candles | fallback if folder empty |
| `dhanLiveFeedProd.getTick()` | Real-time spot LTP | only when `marketOpen` |
| `niftyFuturesProd.getLiveTick()` | Real-time futures LTP | only when `marketOpen` |
| Yahoo `query1.finance.yahoo.com/v8/finance/chart` | VIX, Sensex, Gift Nifty, S&P/Nasdaq, DXY, Crude, Nikkei | every snapshot, 60s cache |
| Sensibull `oxide.sensibull.com/v1/compute/cache/fii_dii_daily` | FII/DII cash + futures flows | every snapshot, 60s cache |
| `marketInternals.service` | NIFTY 50 + Sensex 30 constituents from Yahoo | full breadth, 60s cache |

**Cache TTL**: live = 800 ms, historical = 60 s, macro/breadth = 60 s.

**Sanitisation**: `_sanitiseCandles()` rejects any candle whose close lies outside the
expected range for the symbol (NIFTY 10 000–40 000, SENSEX 40 000–120 000,
BANKNIFTY 30 000–80 000) plus any individual outlier > ±30 % of the median close.

---

## 2. Pipeline at a glance

```
  raw candles + option chain + macro + breadth + futures + tick
                              │
                              ▼
                     getSnapshot({symbol, date})
                              │
   ┌──────────────────────────┼──────────────────────────────┐
   ▼                          ▼                              ▼
 indicator math       per-strike analytics              macro overlays
 (vwap, ema, atr,    (atmBlk, oiHistogram, FRVP,        (vix, gift, fiiDii,
  rsi, cpr)          ladder, walls, premium velocity)    heavyweights, breadth)
                              │
                              ▼
              ┌────── master verdict (0..100) ──────┐
              ▼                                     ▼
       directional engines                    overlay engines
       (heroZero, tradeStrategy,              (trapDetection,
        bestTradePicks, bestOptionBuy)         supportResistance,
                                               marketDirection)
                              │
                              ▼
                      narrator (marketStory)
                              │
                              ▼
                       dashboard payload
```

All numeric outputs are deterministic — same input ⇒ same output. The only
non-deterministic surface is the live-tick freshness window.

---

## 3. Indicator math

All indicators live in `intelV2.service.js` top-section helpers:

| Indicator | Formula | Notes |
|---|---|---|
| **EMA(n)** | `EMA_t = α·close_t + (1−α)·EMA_{t-1}` with α = 2/(n+1) | Used at 9, 20, 50 periods |
| **VWAP** | `Σ(typical·vol) / Σ(vol)` over the session | typical = `(H+L+C)/3` |
| **AVWAP** | Same as VWAP but sum begins at an anchor index | Prior-day anchor + session anchor |
| **ATR(14)** | Avg of true ranges; TR = `max(H−L, |H−prevC|, |L−prevC|)` | 14-period default |
| **RSI(14)** | `100 − 100/(1+RS)`; RS = avg gain / avg loss over 14 closes | |
| **CPR** | `pivot=(H+L+C)/3`, `bc=(H+L)/2`, `tc=2·pivot−bc` | Plus R1/R2/R3 + S1/S2/S3 |

---

## 4. Top quote ribbon (`Row1MasterDecision`)

Eight tiles. No computation — just direct reads.

| Tile | Source |
|---|---|
| **NIFTY** | `data.spot.ltp` + `changePct` |
| **NIFTY FUT** | `data.futures.ltp` + `premium` |
| **SENSEX** | `data.macro.sensex` (Yahoo `^BSESN`) |
| **GIFT NIFTY** | `data.macro.giftNifty` (Yahoo `^NSEI` proxy) |
| **MAX PAIN** | `data.options.maxPain` |
| **PCR** | `data.flow.oi.pcr` (total CE OI / total PE OI) |
| **INDIA VIX** | `data.macro.vix` (Yahoo `^INDIAVIX`) |
| **ATM IV** | `data.options.atmIv` (option-chain avg of ATM CE+PE IV) |

PCR sentiment label: `≥1.15 Bullish`, `≥1.05 Mild Bull`, `≤0.85 Bearish`, `≤0.95 Mild Bear`, else `Neutral`.

VIX state: `≥18 Elevated`, `≥14 Normal`, `>0 Low`.

ATM IV state: `≥25 Expensive`, `≥18 Premium`, `≥10 Healthy`, `>0 Dead`.

---

## 5. Master Verdict — `_masterVerdict()`

Single 0–100 score that drives the bias of every downstream engine.

13 input factors, each clamped, then weighted:

| Factor | Score range | Weight | Source |
|---|---|---|---|
| `pcr` | clamp((PCR−1)·30, ±30) | 0.10 | option chain totals |
| `oiWriters` | +30 if PE writing, −30 if CE writing | 0.10 | atmBlk |
| `vwap` | clamp((spot−vwap)/vwap·10000, ±50) | 0.08 | spot, vwap |
| `ema` | EMA stack: +60 / +25 / −25 / −60 / 0 | 0.10 | EMA9/20/50 |
| `cpr` | +40 above TC, −40 below BC | 0.06 | prior-day OHLC |
| `heavyweights` | clamp(weightedAvgChg·50, ±60) | 0.10 | top constituents |
| `vix` | clamp(−vixChgPct·5, ±30) | 0.05 | Yahoo VIX |
| `gift` | clamp(giftChgPct·25, ±50) | 0.06 | Yahoo NSEI |
| `fiiDii` | clamp(net Cr/50, ±40) | 0.08 | Sensibull |
| `futures` | clamp(premium·1.5, ±30) | 0.07 | futures.ltp − spot |
| `delta` | +40 bullish / −40 bearish / 0 neutral | 0.10 | candle close-position proxy |
| `iv` | clamp(−(iv−18)·0.7, ±15) | 0.04 | atmBlk.atmIv |
| `breadth` | clamp((advancePct−50)·0.8, ±40) | 0.06 | full breadth |

```
composite  = Σ (factor × weight)
cePct      = clamp(50 + composite/2, 0..100)
pePct      = 100 − cePct
verdict    = STRONG_BULLISH  (cePct ≥ 70)
           | BULLISH          (cePct ≥ 58)
           | NEUTRAL          (else)
           | BEARISH          (pePct ≥ 58)
           | STRONG_BEARISH   (pePct ≥ 70)
```

The exact factor breakdown is exposed at `data.verdict.factors` for debugging.

---

## 6. Option-chain analytics

### 6.1 `_atmBlocks(strikes, atm)`
- ATM CE / PE OI, IV, delta
- Total CE OI, Total PE OI, **PCR = totPe/totCe**
- Call wall = strike with max CE OI; Put wall = strike with max PE OI
- **Max pain** = strike with largest combined OI
- Writing flags: `peWriting` if any PE strike with ΔOI > 0 within ATM±2; same for CE

### 6.2 `_oiHistogram(strikes, atm, ±4, step=100)`
- ATM ± 4 strikes spaced in 100s — used by the "OI Shift Active Strikes" card
- Per-row buyer-favor score (40 pts side dominance + 20 spot-vs-strike + 15 delta band + 15 premium liveness + 10 OI)

### 6.3 `_oiBuildupAnalysis(strikes, atm, spot, step=100, range=6)`
- Ranks every strike by `|ΔOI|`, takes top 5 per side
- Per-row interpretation:
  - `≥15%` Strong Buildup
  - `≥8%` Buildup
  - `≥3%` Moderate Buildup
  - `≤−15%` Strong Unwinding
  - `≤−8%` Unwinding
  - `≤−3%` Mild Unwinding
  - else Stable
- Bar-chart series for ATM ± `range` strikes
- `ceTakeaway` / `peTakeaway` — clustering of top-3 OI builds

### 6.4 `_oiShiftBias(rows)`
- Bullish flow = PE OI added + CE OI removed
- Bearish flow = CE OI added + PE OI removed
- Direction: BULLISH (`bullPct ≥ 55`), BEARISH (`bearPct ≥ 55`), else NEUTRAL
- Strength: `STRONG` (margin ≥ 30), `MODERATE` (≥ 15), else `MILD`
- Tracks the single heaviest |ΔOI| as the "dominant strike"

---

## 7. FRVP Institutional Engine — `frvpEngine.evaluate()`

A 14-section auction-theory engine over 5-min candles.

### 7.1 Profile (`_buildProfile`)
- Bucket size: NIFTY 5pt, BANKNIFTY/SENSEX 10pt, others = 0.05% of avg price
- For each candle, distribute volume **proportionally across all buckets** in the H/L range (not close-only)
- **POC** = highest-volume bucket
- **Value Area** (VAH/VAL) = expand outward from POC alternating up/down highest-volume neighbour until acc ≥ 70 % of total volume
- HVN = top-5 buckets by volume
- LVN = bottom-5 buckets inside the value area

### 7.2 Location
- `markerPct = clamp((vah − spot)/(vah − val) · 100, 0..100)` — 0 = bullish edge, 100 = bearish edge
- `nearPOC` if `|spot − POC| ≤ 0.15·(vah − val)`

### 7.3 Acceptance / Rejection (`_acceptance`)
- Acceptance above VAH: 3 consecutive closes > VAH OR last-6-bar above-vol > 2× prior-30 avg
- Rejection above VAH: any bar pierced VAH but last 2 closes are inside value
- Symmetric below VAL

### 7.4 Strike Selection (`_selectStrikes`)
- Take strikes that rank top-N on **any** of: total OI, total volume, |ΔOI|
- Always include ATM regardless of ranking

### 7.5 Buildup classification + flow (`_classifyBuildup` + `_aggregateFlow`)

Tag → buyer/seller weight:

| Tag | Buy | Sell |
|---|---|---|
| Long Buildup | 0.80 | 0.20 |
| Short Covering | 0.65 | 0.35 |
| Balanced | 0.50 | 0.50 |
| Long Unwinding | 0.35 | 0.65 |
| Short Buildup | 0.20 | 0.80 |

Per-strike weighted contribution to `ceBuy/ceSell/peBuy/peSell` plus the
per-side dominant strike (max contribution).

`buyersEntering = (ceBuyersPct + peBuyersPct) / 2` ; sellers = 100 − buyers.

### 7.6 Delta Pressure (`_deltaPressure`)
Close-position-within-range proxy:
```
proxy = (2·close − high − low) / (high − low)   // [-1, +1]
cumulative += volume × proxy
deltaPct = cumulative / totalVolume × 100
bias = bullish (>+8) | bearish (<−8) | neutral
```

### 7.7 Dominance
```
buyersScore  = (buyersEntering + (100 − sellersEntering)) / 2
dominantSide = BUYERS  (≥60)
             | SELLERS (≥60)
             | BALANCED
conviction   = high      (dom + delta align)
             | divergent (dom + delta opposite)
             | normal
```

### 7.8 Directional Bias (option buyer)
6 mutually-exclusive rules generate `{ side, strength, reason, targetStrike }`:
- BUYERS + accepted-above ⇒ **CE STRONG/MODERATE**
- SELLERS + accepted-below ⇒ **PE STRONG/MODERATE**
- Bull-trap rejection at VAH + sellers ⇒ **PE STRONG**
- Bear-trap rejection at VAL + buyers ⇒ **CE STRONG**
- Trap + opposite-side dominance OR divergent conviction ⇒ **NEUTRAL WAIT**
- Inside value pure flow ⇒ moderate CE / PE
- else BALANCED

### 7.9 Advanced overlays
- `gammaWall` = max abs(ce_gamma · ce_oi − pe_gamma · pe_oi)
- `premiumVel` = `{ ceLtp, peLtp, total, skew, state }` — skew > 0.10 ⇒ CE_EXPANDING; < −0.10 ⇒ PE_EXPANDING
- `developingPOC` = trail of POCs over 30-min rolling windows
- `nakedPOC` = lowest-touch HVN (magnet candidate)

---

## 8. Market Direction Card

`marketDirection` block in the orchestrator.

- **Direction Meter**: `downside = pePct`, `upside = cePct`, needle = upsidePct.
  Verdict labels: `STRONG DOWNSIDE` (pe≥65), `DOWNSIDE BIAS` (pe≥55), `STRONG UPSIDE` (ce≥65), `UPSIDE BIAS` (ce≥55), else `BALANCED`.
- **Intraday Levels**: anchor = round(atm/100)·100. CE candidates = clean 100-step strikes strictly above anchor (top 6 closest by distance). PE candidates = clean 100-step strikes strictly below anchor (top 6 closest).
- Tier labels (closest → farthest):
  - CE: Immediate / Strong / Extreme / R4 (Major) / R5 (Heavy) / R6 (Wall)
  - PE: Immediate / Major / Critical / S4 (Deep) / S5 (Floor) / S6 (Bedrock)
- **OI Estimated Move**: `downsideTarget = peCandidates[1] ?? peCandidates[0]`, `upsideTarget = ceCandidates[1] ?? ceCandidates[0]`, `maxPain = atmBlk.maxPain`.

---

## 9. Best Trade Picks — `_bestTradePicks()`

Drives the green BUY CE / red BUY PE banners. **Strikes are restricted to 100-step + ATM ± 6** via `_hundredStepWindow()`.

### Per-side scoring (max ≈ 92, base 35):

| Pillar | Max points | Source |
|---|---|---|
| Verdict alignment | up to 25 | `(sidePct − 50) × 0.5` |
| FRVP directional bias | 20 (STRONG) / 12 (MODERATE) / 6 (WEAK), or −10 if opposite | engine.directionalBias |
| Acceptance / rejection | ±12 same-side / ±8 opposite trap | acceptance flags |
| Smart money (delta) | ±10 / ±8 cross | delta.bias |
| Strike health | ±10 | leg.health.score |
| OI structure | ±6 ±4 | atmBlk writing/unwinding |
| Trap penalty | up to −10 | trapBlk.score × −0.5 |

Final `probability = clamp(score, 25..92)`. Action label: `STRONG BUY ≥70`, `BUY ≥60`, `CAUTIOUS BUY ≥50`, `WAIT ≥40`, else `AVOID`.

Primary side = whichever has higher probability AND ≥50.

`tradeBoard` uses these picks to emit:
- Best Option Buy (primary)
- Alternate Scenario (opposite side, with reversal-condition string)
- Risk Gauge (composite of trap + 100−confidence + bias-spread)
- Execution Context (auction phase + flow + next level + key levels)

Step is hard-coded to **100** for every target/SL — T1 = strike + dir·200, T2 = strike + dir·400, T3 = strike + dir·600, SL = strike − dir·150.

---

## 10. Hero or Zero Engine

Score-based sniper banner. **Each side scored 0..9, threshold = 7**.

| Signal | CE points | PE points |
|---|---|---|
| Above VAH | +2 | — |
| Below VAL | — | +2 |
| Above VWAP | +2 | — |
| Below VWAP | — | +2 |
| premiumVel.state = CE_EXPANDING | +2 | — |
| premiumVel.state = PE_EXPANDING | — | +2 |
| Buyers dominant ≥65% | +1 | — |
| Sellers dominant ≥65% | — | +1 |
| Δ ≥ +10% | +1 | — |
| Δ ≤ −10% | — | +1 |
| Volume surge (last 5m vol > 1.5× prior-20 avg) | +1 | +1 |
| Bull-trap rejection at VAH | **−4 veto** | — |
| Bear-trap rejection at VAL | — | **−4 veto** |

Verdict:
- score ≥ 7 ⇒ **HERO_CE** / **HERO_PE**, confidence = `min(95, 70 + score·3)` (so 7→91, 8→94, 9→95)
- else **ZERO** (subreason = insideValue / bullTrap / bearTrap / premium-stagnant / mixed-flow)

Target strike = closest 100-step OTM (`round((spot ± 100)/100) × 100`).

---

## 11. Premium Momentum Engine

```
ceExpansionPct = state==CE_EXPANDING ? 15 + skew·60
               : state==PE_EXPANDING ? skew·40
               : skew·30
peExpansionPct = mirrored
```

(skew = `(ceLtp − peLtp)/(ceLtp + peLtp)` from FRVP advanced overlay)

- **Sparklines**: 30-point series built from `((2c−h−l)/(h−l))` close-position proxy of the last 30 5m bars; CE rises on positive close-bias, PE on negative
- **Momentum Quality** (max 100): `(|Δ|≥12 ? 35 : ≥6 ? 22 : 10) + (|expansion|≥20 ? 35 : ≥10 ? 22 : 8) + (writing ? 15 : 0) + (trendDay ? 15 : 5)` ⇒ STRONG ≥75, MODERATE ≥50, else WEAK
- **Delta Speed**: AGGRESSIVE (|Δ|≥20), MODERATE (≥10), SLOW (≥4), FLAT
- **Scalping Aggression**: `(volSurge ? 30 : 0) + (|Δ|≥10 ? 25 : 10) + (|expansion|≥15 ? 25 : 10) + (volHigh ? 20 : 10)` ⇒ HIGH ≥70, MODERATE ≥45, else LOW

---

## 12. Trade Strategy Engine

Five mutually-exclusive strategies scored independently. Highest score wins; if best score < 5 OR (no expansion + tiny delta) ⇒ forced to RANGE_MARKET.

| Strategy | Max | Triggers |
|---|---|---|
| BUY_ON_DIP_CE | 13 | aboveVWAP +2, abovePOC +1, peWriting +2, buyersDominant +2, supportHolding +1, Δ≥+8 +1, vwapPullback +2, ceExpanding +1, bearTrapReject +1 |
| SELL_ON_RISE_PE | 13 | mirror of above |
| BREAKOUT_CE_BUY | 12 | aboveVAH +3, acceptedAbove +2, volSurge +2, ceExpanding +2, ceUnwinding +1, buyersDom +1, Δ≥+8 +1, **bullTrap −5 veto** |
| BREAKDOWN_PE_BUY | 12 | mirror, **bearTrap −5 veto** |
| RANGE_MARKET | 9 | insideValue +3, balancedFlow +2, two-sided writing +2, premium stagnant +1, Δ neutral +1 |

`confidence = clamp(40 + (score/maxScore)·50 + edge·2, 25..92)`.

---

## 13. Trap Detection — `_trapDetection()`

Heuristic per-row score (each true ⇒ +25):
- **fakeBreakout**: spot > vwap and spot > ema9·1.005 but `deltaBias != 'bullish'`
- **fakeBreakdown**: spot < vwap and spot < ema9·0.995 but `deltaBias != 'bearish'`
- **premiumTrap**: ATM IV < 8% (no premium expansion possible)
- **ivCrushRisk**: ATM IV > 30%

Output `risk = high (≥75) | medium (≥40) | low`.

---

## 14. Support / Resistance Pressure — `_supportResistance()`

```
sStr = Σ supports(oi · 1/(1 + dist/50) + oiChange·0.5 · 1/(1 + dist/50))
rStr = Σ resistances(...same...)
pressureScore = sStr / (sStr + rStr) × 100
verdict = BULLISH (≥55) | BEARISH (≤45) | NEUTRAL
```

Top 2 PE strikes below ATM = supports; top 2 CE strikes above ATM = resistances.
Pressure bar visualises CE walls (red, left) vs PE walls (green, right) — needle position = `pressureScore`.

---

## 15. AI Market Story (narrator)

`marketStory` block — pure synthesis, zero new data. Writes one paragraph + bullet list using:

1. **OI structure** narrative ("Heavy CE writing between X–Y…" / "Two-sided writing…")
2. **Price location** ("Above VWAP and above POC — bullish acceptance")
3. **Premium velocity** ("CE premiums expanding aggressively — buyers stepping up")
4. **Dominance + delta** ("Sellers dominate flow with 80% pressure (Δ +14.7%)…")
5. **Hero/Zero overlay** ("🚀 HERO CE setup active…" / "⚠ Bear trap detected…")
6. **Verdict tilt** ("Bias tilts CE +6 pts" / "Bias balanced (CE 56 vs PE 44)")

Headline derived from heroZero.verdict OR cePct/pePct ≥ 60.

---

## 16. Buyers vs Sellers Donut

Lives **inside** the FRVP card now. Renders `dominance.buyersScore` / `sellersScore` as a green/red donut, with delta below.

- Center label = dominant side + percentage
- Sellers/Buyers tags: `Dominating` (≥60), `Balanced` (≥45), `Weak`
- Conviction badge: CONFIRMED (delta aligned) / DIVERGENT (delta opposed)

---

## 17. Writer Pressure Engine — Per-strike institutional grade

Top 5 strikes per side ranked by `|ΔOI|`, restricted to clean 100-step + ATM ± 6.

Each row carries 8 metrics:
- **OI Velocity**: `oiPct` ⇒ EXPLOSIVE ≥50, HIGH ≥25, MODERATE ≥10, SLOW ≥3, UNWINDING ≤−10, else FLAT
- **Premium State**: cross of `oiChg` × `iv − atmIv` ⇒ FAST DECAY / DECAYING / STICKY / EXPANDING (CE) ; STRONG / STABLE / WEAKENING (PE)
- **Delta Pressure**: depends on global delta bias + per-strike `|delta|` (SELLERS ACTIVE / BUYERS PUSHING etc.)
- **Volume Burst**: `volume/oi ≥ 0.5` YES, ≥0.25 MILD, else NO
- **Smart Money tag**: Long/Short Buildup / Short Covering / Long Unwinding (from oiChg sign × spot direction)
- **Wall Strength** = velocity·25% + premium·20% + delta·20% + volume·15% + futures·10% + ivBehavior·10% ⇒ EXTREME ≥80, VERY STRONG ≥65, STRONG ≥50, MODERATE ≥35, else WEAK
- **Trap Risk**: oiChg > 0 with opposite-side delta + futures contradiction ⇒ HIGH ≥60, MEDIUM ≥35, else LOW
- **Futures Alignment**: based on basis sign vs writer-dominant side

Top-level summary: `writerControl` (CE/PE/BALANCED), `aggressionLevel`, `premiumHealth`, `confidence`.

---

## 18. Endpoint shape (high level)

```ts
interface IntelV2Snapshot {
  ok: boolean;
  symbol: 'NIFTY_50' | 'SENSEX' | 'BANKNIFTY';
  date: string;            // YYYY-MM-DD
  isToday: boolean;
  market: { isOpen: boolean; phase: string };

  spot:    { ltp, change, changePct, dayHigh, dayLow, priorClose, vwap, ema9, ema20, ema50, atr, rsi, sessionAvwap, priorAvwap, live, liveTickAgeMs };
  futures: { ltp, premium, basisState, basis };
  options: { atm, maxPain, atmIv, atmCall, atmPut, callWall, putWall, expiry };
  cpr:     { pivot, tc, bc, r1, r2, r3, s1, s2, s3, width, widthPct, widthClass };

  verdict:    { side, verdict, cePct, pePct, factors, weights };
  bias:       { directionScore, overallBias, smartMoney, reasoning };
  confidence: { winning, label };
  trap:       { risk, score, detected, rows };
  flow:       { delta, volume, oi };
  macro:      { vix, giftNifty, sensex, usFutures, dxy, crude, nikkei, fiiDii };
  heavyweights: { rows, weightedAvgChangePct, leaders, laggards };

  ladder: LadderRow[];      // ATM ± 4 with health scores
  tradePlan: { action, reason, pick };
  riskManagement: { entryPrice, stopLoss, target1, target2, rr, ... };

  dashboard: {
    statusWidgets, tradingDay, spotFutSeries,
    buildUp, buyerSellerFlow, auctionIntensity,
    vwapAvwapIntraday, frvpAuction, frvpInstitutional,
    futuresInfo, oiHistogram, oiShiftBias, oiBuildupAnalysis,
    marketDirection, writerPressure,
    cvdSeries, delta, frvpHistogram, breadth,
    heavyweightsImpact, heavyweightsAlignment,
    ivAnalytics, trapDetector, regimeClassification,
    optionChainSnapshot, topStrikeSelections,
    bestTradePick, tradeBoard, heroZero,
    premiumMomentum, tradeStrategy, marketStory,
    supportResistance, riskManagement,
    keyLevels, noTradeConditions, liveAlerts,
    spark1m, hints,
  };

  debug: { candleCounts, strikeCount, ladderCount, candleSource, optionChainSource };
}
```

---

## 19. Frontend layout (`/intel-v2`)

```
┌── Top Header (live status, refresh, symbol picker) ─────────────────┐
├── Row 1  — 8-tile quote ribbon (Spot/Fut/Sensex/GiftNifty/MaxPain/PCR/VIX/IV) ─┤
├── Row 1a — HeroZeroCard (40%) | PremiumMomentumCard (30%) | TradeStrategyCard (30%) ─┤
├── Row 1b — TradeBoard: BestOptionBuy | AlternateScenario | ExecutionContext ─┤
├── Row 2  — 2.2 Combined (Writing Pressure + Market Direction, 60%) | 2.5 FRVP Map (40%) ─┤
│                                  Support / Resistance Pressure (full width)
├── Row 3  — Confirmation Layer (delta / breadth / heavyweights / iv-vix / fii-dii) ─┤
├── Row 4  — Structure Context (vwap / ema-stack / cpr / max-pain) ────┤
├── Row 5  — No-trade Engine (8 conditions) ──────────────────────────┤
├── Row 6  — AI Market Story (narrator, full width) ──────────────────┤
└── Bottom — Live Alerts ticker ──────────────────────────────────────┘
```

Each row component reads only from `data.dashboard.*` — no raw computation in the React layer.

---

## 20. Key files

```
backend/src/
  app.js                          # mounts /api/intel-v2
  controllers/intelV2.controller.js
  routes/intelV2.routes.js
  services/intelV2.service.js     # orchestrator (3000 lines)
  services/frvpEngine.service.js  # 14-section auction engine
  services/algorithms/marketInternals.service.js  # FII/DII + breadth
  config/symbolRegistry.js        # NIFTY_50, SENSEX, BANKNIFTY metadata

src/
  routes/intel-v2.tsx                              # page shell + polling
  hooks/useIntelV2Snapshot.ts                      # 3s polling, available-dates fetch
  lib/intelV2Types.ts                              # full type tree
  components/intelv2/dash/
    common.tsx                  # V2Card, V2Pill, V2_TONE
    TopHeader.tsx
    Row1MasterDecision.tsx       # 8-tile ribbon
    HeroZeroCard.tsx
    PremiumMomentumCard.tsx
    TradeStrategyCard.tsx
    Row1bTradeBoard.tsx
    Row2InstitutionalFlow.tsx    # combined 2.2 + 2.5 FRVP, S/R below
    SupportResistanceCard.tsx
    MarketDirectionCard.tsx      # standalone (now embedded in 2.2)
    OiBuildupAnalysisCard.tsx    # legacy 2.3, retained but not rendered
    Row3ConfirmationLayer.tsx
    Row4StructureContext.tsx
    Row5NoTradeEngine.tsx
    Row6BottomPanel.tsx          # imported but NOT rendered
    Row7AuctionPanel.tsx         # imported but NOT rendered
    MarketStoryCard.tsx
    AlertsTicker.tsx
```

---

## 21. Operational notes

- **Backend**: `node src/server.js` from `backend/`. No nodemon — restart on code changes.
- **Polling**: 3s interval in live mode; historical mode fetches once.
- **Cache**: live=800ms, historical=60s, macro=60s. Hard-restart clears all caches.
- **Clean restart**: `taskkill /F /PID <port-3000-pid>` then `node src/server.js`.
- **Trading day**: 09:15–15:30 IST. Engine entry cutoff = 15:00 IST; square-off only after.
- **Weekend**: snapshot falls back to the most-recent trading day automatically.

---

## 22. Math invariants (sanity assertions)

These hold for every snapshot regardless of symbol/date:

| Invariant | Why |
|---|---|
| `cePct + pePct === 100` | mirror split |
| `verdict.factors.* ∈ [−60, +60]` | each factor pre-clamped |
| `marketDirection.resistances` strikes are all `> anchor` and `% 100 === 0` | clean 100-step filter |
| `marketDirection.supports` strikes are all `< anchor` and `% 100 === 0` | mirror |
| `bestTradePick.ce.strike` and `bestTradePick.pe.strike` ∈ [anchor − 600, anchor + 600] AND `% 100 === 0` | `_hundredStepWindow` |
| `tradeStrategy.ranked.length === 5` | always 5 strategies scored |
| `heroZero.scores.{ce,pe} ∈ [−4, 9]` | hard-veto can drive negative |
| `frvpInstitutional.engine.dominance.{buyersScore,sellersScore} sum to 100` | mirror |

These can be added as backend integration tests if you want a regression net.
