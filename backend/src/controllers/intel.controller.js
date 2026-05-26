/**
 * Intel Controller — institutional intelligence snapshot endpoint.
 *
 * GET /api/intel/snapshot?symbol=NIFTY_50
 * GET /api/intel/snapshot?symbol=SENSEX
 *
 * Returns the composite intelligence payload assembled by intel.service.
 * Pure read — no engine state mutation.
 */

const asyncHandler = require('../utils/asyncHandler');
const intelService = require('../services/intel.service');

const SUPPORTED = new Set(['NIFTY_50', 'SENSEX', 'BANKNIFTY']);

const getSnapshot = asyncHandler(async (req, res) => {
  const symbol = String(req.query.symbol || 'NIFTY_50').toUpperCase();
  if (!SUPPORTED.has(symbol)) {
    return res.status(400).json({
      ok: false,
      error: `Unsupported symbol: ${symbol}. Allowed: ${[...SUPPORTED].join(', ')}`,
    });
  }
  const data = await intelService.getSnapshot(symbol);
  return res.json(data);
});

const getDualSnapshot = asyncHandler(async (_req, res) => {
  // Convenience endpoint — returns both NIFTY_50 + SENSEX in one shot.
  const [nifty, sensex] = await Promise.all([
    intelService.getSnapshot('NIFTY_50').catch(e => ({ ok: false, error: e.message, symbol: 'NIFTY_50' })),
    intelService.getSnapshot('SENSEX').catch(e => ({ ok: false, error: e.message, symbol: 'SENSEX' })),
  ]);
  return res.json({ ok: true, NIFTY_50: nifty, SENSEX: sensex, at: Date.now() });
});

module.exports = { getSnapshot, getDualSnapshot };
