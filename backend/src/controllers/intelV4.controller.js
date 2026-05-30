/* ─────────────────────────────────────────────────────────────────────
 * INTEL V4 controller
 *   GET /api/intel-v4/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelV4 = require('../services/intelV4.service');

async function getDecision(req, res) {
  try {
    const symbol = (req.query.symbol || 'NIFTY_50').toUpperCase();
    const date = req.query.date || null;
    const data = await intelV4.getDecision({ symbol, date });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, version: 'v4' });
  }
}

module.exports = { getDecision };
