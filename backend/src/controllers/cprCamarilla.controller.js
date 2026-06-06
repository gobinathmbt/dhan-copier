/* ─────────────────────────────────────────────────────────────────────
 * CPR + CAMARILLA POWER ENGINE controller
 *   GET /api/cpr-cam?symbol=NIFTY_50[&date=YYYY-MM-DD]
 * ───────────────────────────────────────────────────────────────────── */

const cprCam = require('../services/cprCamarilla.service');

async function getCprCam(req, res) {
  try {
    const symbol = (req.query.symbol || 'NIFTY_50').toUpperCase();
    const date = req.query.date || null;
    const interval = req.query.interval || '5';
    const data = await cprCam.getCprCam({ symbol, date, interval });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { getCprCam };
