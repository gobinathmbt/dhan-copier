/* ─────────────────────────────────────────────────────────────────────
 * INTEL BRIDGE — Institutional Intent Converter (V2 → V6) controller
 *   GET /api/intel-bridge/decision?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const intelBridge = require('../services/intelBridge.service');

async function getDecision(req, res) {
  try {
    const symbol = (req.query.symbol || 'NIFTY_50').toUpperCase();
    const date = req.query.date || null;
    const data = await intelBridge.getDecision({ symbol, date });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, version: 'bridge' });
  }
}

module.exports = { getDecision };
