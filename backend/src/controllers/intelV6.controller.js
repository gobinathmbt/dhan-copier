/* ─────────────────────────────────────────────────────────────────────
 * INTEL V6 — Premium Intelligence (Greeks) Engine controller
 *   GET /api/intel-v6/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelV6 = require('../services/intelV6.service');

async function getDecision(req, res) {
  try {
    const symbol = (req.query.symbol || 'NIFTY_50').toUpperCase();
    const date = req.query.date || null;
    const data = await intelV6.getDecision({ symbol, date });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, version: 'v6' });
  }
}

module.exports = { getDecision };
