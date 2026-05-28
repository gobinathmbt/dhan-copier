/**
 * Intel V3 Controller — Ultimate Institutional Console
 *
 *   GET  /api/intel-v3/snapshot?symbol=NIFTY_50&date=YYYY-MM-DD
 *   GET  /api/intel-v3/available-dates?symbol=NIFTY_50
 *
 * v3 is additive — does NOT modify v1/v2 endpoints.
 */

const asyncHandler = require('../utils/asyncHandler');
const intelV3 = require('../services/intelV3.service');

const SUPPORTED = new Set(['NIFTY_50', 'SENSEX', 'BANKNIFTY']);

function _validDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

const getSnapshot = asyncHandler(async (req, res) => {
  const symbol = String(req.query.symbol || 'NIFTY_50').toUpperCase();
  if (!SUPPORTED.has(symbol)) {
    return res.status(400).json({
      ok: false,
      error: `Unsupported symbol: ${symbol}. Allowed: ${[...SUPPORTED].join(', ')}`,
    });
  }
  const date = _validDate(req.query.date) ? req.query.date : null;
  const data = await intelV3.getSnapshot({ symbol, date });
  return res.json(data);
});

const getAvailableDates = asyncHandler(async (req, res) => {
  const symbol = String(req.query.symbol || 'NIFTY_50').toUpperCase();
  if (!SUPPORTED.has(symbol)) {
    return res.status(400).json({ ok: false, error: `Unsupported symbol: ${symbol}` });
  }
  const dates = intelV3.getAvailableDates(symbol);
  return res.json({ ok: true, symbol, dates, count: dates.length });
});

module.exports = { getSnapshot, getAvailableDates };
