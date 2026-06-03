/* ─────────────────────────────────────────────────────────────────────
 * STRIKE TABLE controller
 *   GET /api/strike-table?symbol=NIFTY_50[&date=YYYY-MM-DD][&range=6]
 * ───────────────────────────────────────────────────────────────────── */

const strikeTable = require('../services/strikeTable.service');

async function getStrikeTable(req, res) {
  try {
    const symbol = (req.query.symbol || 'NIFTY_50').toUpperCase();
    const date = req.query.date || null;
    const range = req.query.range != null ? Number(req.query.range) : 6;
    const data = await strikeTable.getStrikeTable({ symbol, date, range });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { getStrikeTable };
