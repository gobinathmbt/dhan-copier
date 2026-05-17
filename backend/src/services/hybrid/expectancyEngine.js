/**
 * Expectancy Engine
 * =================
 * Tracks closed-trade outcomes by setup type, regime, session phase, and
 * expiry/non-expiry. Auto-adjusts the confidence pillar weights and the
 * minimum-score thresholds for each entry type so the engine learns which
 * setups actually work.
 *
 * Storage: a single JSON file at backend/logs/expectancy.json.
 * Updates  : on every trade close (call `recordTrade`).
 * Reads    : every cycle (call `getAdjustments`).
 *
 * No curve-fitting: we only adjust thresholds when sample size ≥ 20 trades
 * for a given bucket, and we cap the adjustment to ±10 score points.
 */

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.resolve(__dirname, '../../../logs/expectancy.json');
const MIN_SAMPLE = 20;
const MAX_ADJUSTMENT = 10;

let _state = null;

function _load() {
  if (_state) return _state;
  try {
    if (fs.existsSync(STORE_FILE)) {
      _state = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } else {
      _state = { buckets: {}, lastUpdated: null };
    }
  } catch (_) {
    _state = { buckets: {}, lastUpdated: null };
  }
  if (!_state.buckets) _state.buckets = {};
  return _state;
}

function _save() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(_state, null, 2));
  } catch (_) {}
}

function _bucketKey({ entryType, regime, phase, expiry }) {
  return `${entryType || 'UNKNOWN'}|${regime || 'unknown'}|${phase || 'any'}|${expiry ? 'exp' : 'normal'}`;
}

/**
 * Record a closed trade.
 * @param {Object} trade
 * @param {string} trade.entryType   - MOMENTUM_CONTINUATION / REVERSAL / etc.
 * @param {string} trade.regime      - market regime at entry
 * @param {string} trade.phase       - session phase at entry
 * @param {boolean} trade.expiry     - was it expiry day
 * @param {number} trade.netPnl
 * @param {string} trade.result      - 'WIN' / 'LOSS' / 'BE'
 * @param {number} trade.holdSec
 */
function recordTrade(trade) {
  const s = _load();
  const key = _bucketKey(trade);
  if (!s.buckets[key]) {
    s.buckets[key] = { n: 0, wins: 0, losses: 0, sumPnl: 0, sumHold: 0,
                      bigWin: 0, bigLoss: 0, lastUpdated: null };
  }
  const b = s.buckets[key];
  b.n += 1;
  b.sumPnl  += Number(trade.netPnl) || 0;
  b.sumHold += Number(trade.holdSec) || 0;
  if (trade.result === 'WIN') b.wins++;
  if (trade.result === 'LOSS') b.losses++;
  if ((trade.netPnl || 0) > b.bigWin)  b.bigWin = trade.netPnl;
  if ((trade.netPnl || 0) < b.bigLoss) b.bigLoss = trade.netPnl;
  b.lastUpdated = new Date().toISOString();
  s.lastUpdated = b.lastUpdated;
  _save();
}

/**
 * Get the score adjustment for a given bucket. Returns {adjustment, sample,
 * winRate, expectancy, reasoning}. Adjustment is capped to ±MAX_ADJUSTMENT.
 *
 * Logic:
 *   - sample < MIN_SAMPLE  → 0 (no info)
 *   - winRate ≥ 70 + expectancy > 0 → +score (favourable bucket)
 *   - winRate ≤ 40 OR expectancy < 0 → −score
 *   - linear blend in between
 */
function getAdjustment({ entryType, regime, phase, expiry } = {}) {
  const s = _load();
  const key = _bucketKey({ entryType, regime, phase, expiry });
  const b = s.buckets[key];
  if (!b || b.n < MIN_SAMPLE) {
    return { adjustment: 0, sample: b?.n || 0, winRate: null, expectancy: null,
             reasoning: 'insufficient sample' };
  }
  const winRate = (b.wins / b.n) * 100;
  const expectancy = b.sumPnl / b.n;

  let adj = 0;
  if (expectancy > 0 && winRate >= 70) adj = +MAX_ADJUSTMENT;
  else if (expectancy > 0 && winRate >= 60) adj = +6;
  else if (expectancy > 0 && winRate >= 55) adj = +3;
  else if (winRate >= 45 && winRate < 55)   adj = 0;
  else if (winRate < 45 || expectancy < 0)  adj = -6;
  if (winRate < 35 || expectancy < -300)    adj = -MAX_ADJUSTMENT;

  return {
    adjustment: adj, sample: b.n,
    winRate: Number(winRate.toFixed(2)),
    expectancy: Number(expectancy.toFixed(2)),
    avgHoldSec: Math.round(b.sumHold / b.n),
    bigWin: b.bigWin, bigLoss: b.bigLoss,
    reasoning: `n=${b.n} wr=${winRate.toFixed(1)}% expectancy=₹${expectancy.toFixed(0)}`,
  };
}

function getStats() {
  const s = _load();
  return s;
}

function reset() {
  _state = { buckets: {}, lastUpdated: null };
  _save();
}

module.exports = { recordTrade, getAdjustment, getStats, reset };
