/* ─────────────────────────────────────────────────────────────────────
 * INTEL V5 — Institutional Option Buyer Verdict controller
 *   GET /api/intel-v5/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelV5 = require('../services/intelV5.service');

async function getDecision(req, res) {
  try {
    const symbol = (req.query.symbol || 'NIFTY_50').toUpperCase();
    const date = req.query.date || null;
    const data = await intelV5.getDecision({ symbol, date });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, version: 'v5' });
  }
}

module.exports = { getDecision };
