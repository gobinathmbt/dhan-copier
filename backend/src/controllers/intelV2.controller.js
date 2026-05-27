/**
 * Intel V2 Controller — version-2 institutional console snapshot.
 *
 *   GET  /api/intel-v2/snapshot?symbol=NIFTY_50&date=YYYY-MM-DD
 *   GET  /api/intel-v2/dual?date=YYYY-MM-DD
 *   GET  /api/intel-v2/available-dates?symbol=NIFTY_50
 *
 * Pure read endpoints — no state mutation. Self-contained, has NO
 * dependency on the v1 intel.controller.
 */

const asyncHandler = require('../utils/asyncHandler');
const intelV2 = require('../services/intelV2.service');

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
  const data = await intelV2.getSnapshot({ symbol, date });
  return res.json(data);
});

const getDualSnapshot = asyncHandler(async (req, res) => {
  const date = _validDate(req.query.date) ? req.query.date : null;
  const data = await intelV2.getDualSnapshot({ date });
  return res.json(data);
});

const getAvailableDates = asyncHandler(async (req, res) => {
  const symbol = String(req.query.symbol || 'NIFTY_50').toUpperCase();
  if (!SUPPORTED.has(symbol)) {
    return res.status(400).json({
      ok: false,
      error: `Unsupported symbol: ${symbol}`,
    });
  }
  const dates = intelV2.getAvailableDates(symbol);
  return res.json({ ok: true, symbol, dates, count: dates.length });
});

module.exports = { getSnapshot, getDualSnapshot, getAvailableDates };
