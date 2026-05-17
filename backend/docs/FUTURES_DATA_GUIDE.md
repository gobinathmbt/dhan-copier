# NIFTY Futures Data - Quick Reference Guide

## Overview
The system now captures and stores NIFTY 50 futures data in real-time and historical backfills. This guide shows how to access and use this data in your algo engines.

## Data Structure

### Live Feed Folder Layout
```
backend/live-feed/
  2026-05-13_NIFTY_50/
    ├── metadata.json              # Session info + futures contract
    ├── spot.jsonl                 # NIFTY 50 spot ticks
    ├── futures-ticks.jsonl        # NIFTY futures ticks (NEW)
    ├── candles-1m.jsonl           # Spot 1-minute candles
    ├── candles-5m.jsonl           # Spot 5-minute candles
    ├── candles-15m.jsonl          # Spot 15-minute candles
    ├── futures-1m.jsonl           # Futures 1-minute candles (NEW)
    ├── futures-5m.jsonl           # Futures 5-minute candles (NEW)
    ├── futures-15m.jsonl          # Futures 15-minute candles (NEW)
    └── option-chain.jsonl         # ATM ± 6 strikes per minute
```

## Data Formats

### Futures Tick (futures-ticks.jsonl)
```json
{
  "t": 1778643960000,        // timestamp (ms)
  "ltp": 23491.6,            // last traded price
  "ltt": 1778643960,         // last trade time (sec)
  "volume": 50310,           // volume
  "open": 23491.6,           // open price
  "high": 23500,             // high price
  "low": 23451.2,            // low price
  "close": 23452,            // close price
  "oi": 1234567,             // open interest
  "premium": 44.3            // premium over spot (futures - spot)
}
```

### Futures Candle (futures-1m.jsonl, futures-5m.jsonl, futures-15m.jsonl)
```json
{
  "t": 1778643960,           // candle start time (sec)
  "o": 23491.6,              // open
  "h": 23500,                // high
  "l": 23451.2,              // low
  "c": 23452,                // close
  "v": 50310                 // volume
}
```

### Metadata (metadata.json)
```json
{
  "date": "2026-05-13",
  "underlying": "NIFTY_50",
  "openPrice": 23447.3,
  "openingAtm": 23450,
  "futuresContract": {
    "securityId": 66071,
    "tradingSymbol": "NIFTY MAY FUT",
    "expiryDate": "2026-05-26",
    "lotSize": 65
  },
  "futuresOpen": 23491.6,
  "futuresClose": 23481,
  "futuresOpenPremium": 44.3,
  "futuresClosePremium": 52.3
}
```

## API Usage

### 1. Get Current Futures Contract
```javascript
const niftyFuturesProd = require('./services/niftyFuturesProd.service');

const contract = await niftyFuturesProd.getNearContract();
console.log(contract);
// {
//   securityId: 66071,
//   tradingSymbol: 'NIFTY MAY FUT',
//   expiryDate: '2026-05-26',
//   lotSize: 65
// }
```

### 2. Get Intraday Futures Candles
```javascript
const nowSec = Math.floor(Date.now() / 1000);

// Last 30 minutes of 1m candles
const result = await niftyFuturesProd.getIntradayCandles({
  interval: '1',
  startTime: nowSec - 1800,
  endTime: nowSec
});

if (result.ok) {
  const candles = result.data.candles;
  console.log(`Got ${candles.length} candles`);
  // Each candle: { time, open, high, low, close, volume }
}
```

### 3. Get Live Futures Tick
```javascript
// Get the latest tick from WebSocket feed
const tick = await niftyFuturesProd.getLiveTick();

if (tick) {
  console.log(`Futures LTP: ${tick.ltp}, OI: ${tick.oi}`);
  console.log(`Contract: ${tick.tradingSymbol}, Lot: ${tick.lotSize}`);
}
```

### 4. Analyze Futures Trend
```javascript
const spotLtp = 23450;
const candles = result.data.candles; // from getIntradayCandles

const analysis = niftyFuturesProd.analyzeCandles(candles, spotLtp);
console.log(analysis);
// {
//   trend: 'bullish',        // 'bullish' | 'bearish' | 'neutral'
//   momentum: 3,             // -5 to +5 (short-term momentum)
//   premium: 45.2,           // futures premium over spot
//   lastClose: 23481,        // last candle close
//   sessionHigh: 23520,      // session high
//   sessionLow: 23400,       // session low
//   candleCount: 374         // number of candles analyzed
// }
```

## Use Cases for Algo Engines

### Entry Engine - Confirm Spot Signals
```javascript
// Before entering a trade, check futures confirmation
const spotTrend = 'bullish'; // from your spot analysis
const futuresAnalysis = niftyFuturesProd.analyzeCandles(futuresCandles, spotLtp);

if (spotTrend === 'bullish' && futuresAnalysis.trend === 'bullish') {
  // Strong confirmation - both spot and futures bullish
  if (futuresAnalysis.premium > 30 && futuresAnalysis.momentum > 2) {
    // High premium + strong momentum = high conviction entry
    makeEntry();
  }
}
```

### Monitor Engine - Detect Divergence
```javascript
// During a trade, watch for spot-futures divergence
const spotMoving = 'up';
const futuresAnalysis = niftyFuturesProd.analyzeCandles(futuresCandles, spotLtp);

if (spotMoving === 'up' && futuresAnalysis.trend === 'bearish') {
  // Divergence detected - futures not confirming spot move
  // Consider early exit or tightening stop loss
  logger.warn('Spot-futures divergence detected');
}

// Also watch premium compression
if (futuresAnalysis.premium < 20) {
  // Premium compressing - possible reversal signal
  logger.warn('Futures premium compressing');
}
```

### Swing Engine - Multi-Day Analysis
```javascript
// For swing trades, analyze futures momentum over longer periods
const result = await niftyFuturesProd.getIntradayCandles({
  interval: '15',
  startTime: nowSec - 86400, // last 24 hours
  endTime: nowSec
});

const analysis = niftyFuturesProd.analyzeCandles(result.data.candles, spotLtp);

if (analysis.momentum > 3 && analysis.premium > 50) {
  // Strong sustained momentum + high premium = swing opportunity
  makeSwingEntry();
}
```

## Reading Historical Data

### Load a Specific Day
```javascript
const fs = require('fs');
const path = require('path');

function loadFuturesCandles(date, interval) {
  const folder = path.join(__dirname, '../live-feed', `${date}_NIFTY_50`);
  const file = path.join(folder, `futures-${interval}m.jsonl`);
  
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line));
}

// Load May 13 futures 1m candles
const candles = loadFuturesCandles('2026-05-13', '1');
console.log(`Loaded ${candles.length} candles`);
```

### Load Metadata
```javascript
function loadMetadata(date) {
  const folder = path.join(__dirname, '../live-feed', `${date}_NIFTY_50`);
  const file = path.join(folder, 'metadata.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const meta = loadMetadata('2026-05-13');
console.log(`Contract: ${meta.futuresContract.tradingSymbol}`);
console.log(`Open Premium: ${meta.futuresOpenPremium}`);
console.log(`Close Premium: ${meta.futuresClosePremium}`);
```

## Key Insights from Futures Data

### 1. Premium Analysis
- **Normal Premium:** 30-60 points (cost of carry)
- **High Premium (>60):** Strong bullish sentiment
- **Low Premium (<20):** Weak sentiment or near expiry
- **Negative Premium:** Extreme bearish sentiment (rare)

### 2. Trend Confirmation
- **Spot + Futures Aligned:** High conviction trades
- **Divergence:** Warning signal, reduce position size
- **Futures Leading:** Futures often lead spot by 1-2 minutes

### 3. Momentum Signals
- **Momentum > 3:** Strong uptrend
- **Momentum < -3:** Strong downtrend
- **Momentum near 0:** Consolidation/range-bound

### 4. Volume Analysis
- **High Volume + Trend:** Strong conviction
- **Low Volume + Trend:** Weak move, likely reversal
- **Volume Spike:** Potential breakout/breakdown

## Best Practices

1. **Always check futures confirmation** before major entries
2. **Monitor premium changes** during trades - compression = warning
3. **Use futures momentum** as a leading indicator
4. **Watch for divergence** between spot and futures
5. **Consider lot size** when calculating position sizing
6. **Track expiry dates** - behavior changes near expiry

## Backfill Command
```bash
# Backfill more historical data
cd backend
node scripts/backfill-2weeks.js

# The script will load 10 trading days (2 weeks) of data
# Includes spot + futures + option chain for each day
```

## Data Retention
- Live feed data is kept for **365 days (1 year)** (configurable)
- Older folders are automatically pruned
- Backfilled data follows the same retention policy
- Adjust `RETENTION_DAYS` in `feedRecorder.service.js` if needed

---

**Ready to Use:** All futures data is now available for your algo engines!
**Next Step:** Integrate futures analysis into your entry and monitor engines.
