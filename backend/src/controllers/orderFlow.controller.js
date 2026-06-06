/* ─────────────────────────────────────────────────────────────────────
 * ORDER FLOW INTEL ENGINE controller
 *   GET /api/order-flow?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const orderFlow = require('../services/orderFlow.service');

async function getOrderFlow(req, res) {
  try {
    const symbol = (req.query.symbol || 'NIFTY_50').toUpperCase();
    const date = req.query.date || null;
    const data = await orderFlow.getOrderFlow({ symbol, date });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { getOrderFlow };
