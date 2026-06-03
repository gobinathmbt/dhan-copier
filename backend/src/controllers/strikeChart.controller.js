/* ─────────────────────────────────────────────────────────────────────
 * STRIKE CHART controller
 *   GET /api/strike-chart?symbol=NIFTY_50[&date=YYYY-MM-DD][&offset=4][&interval=5]
 * ───────────────────────────────────────────────────────────────────── */

const strikeChart = require('../services/strikeChart.service');

async function getStrikeChart(req, res) {
  try {
    const symbol = (req.query.symbol || 'NIFTY_50').toUpperCase();
    const date = req.query.date || null;
    const offset = req.query.offset != null ? Number(req.query.offset) : 3;
    const interval = req.query.interval || '5';
    const data = await strikeChart.getStrikeChart({ symbol, date, offset, interval });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { getStrikeChart };
