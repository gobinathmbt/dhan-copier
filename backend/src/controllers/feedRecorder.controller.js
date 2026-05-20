/**
 * Feed Recorder controller — inspect / replay recorded market data.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { instance: recorder, ROOT_DIR, getUnderlying } = require('../services/feedRecorder.service');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');

/** GET /api/feed-recorder/status */
exports.getStatus = asyncHandler(async (_req, res) => {
  res.json(recorder.getStatus());
});

/** GET /api/feed-recorder/days */
exports.listDays = asyncHandler(async (_req, res) => {
  const entries = fs.existsSync(ROOT_DIR)
    ? fs.readdirSync(ROOT_DIR, { withFileTypes: true })
    : [];
  // List folders for whichever symbol the active session is recording.
  // Falls back to NIFTY_50 when no session is live.
  const underlying = getUnderlying();
  const days = entries
    .filter(e => e.isDirectory() && e.name.includes(`_${underlying}`))
    .map(e => {
      const folder = path.join(ROOT_DIR, e.name);
      const metaPath = path.join(folder, 'metadata.json');
      let meta = null;
      try {
        if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_) {}
      const stat = (file) => {
        try {
          const p = path.join(folder, file);
          return fs.existsSync(p) ? fs.statSync(p).size : 0;
        } catch (_) { return 0; }
      };
      return {
        folder: e.name,
        date: e.name.split('_')[0],
        spotBytes: stat('spot.jsonl'),
        chainBytes: stat('option-chain.jsonl'),
        metadata: meta,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  res.json({ count: days.length, days });
});

/**
 * GET /api/feed-recorder/spot?date=2026-05-13&limit=100&from=&to=
 * Streams last N spot ticks for the day.
 */
exports.getSpot = asyncHandler(async (req, res) => {
  const { date, limit = '500', from, to } = req.query;
  if (!date) throw new HttpError(400, 'date is required (YYYY-MM-DD)');
  const file = path.join(ROOT_DIR, `${date}_${getUnderlying()}`, 'spot.jsonl');
  if (!fs.existsSync(file)) return res.json({ count: 0, ticks: [] });
  const max = Math.max(1, Math.min(5000, parseInt(limit, 10) || 500));
  const rows = await _readJsonl(file, max, from ? Number(from) : null, to ? Number(to) : null);
  res.json({ count: rows.length, ticks: rows });
});

/**
 * GET /api/feed-recorder/option-chain?date=2026-05-13&limit=100
 * Streams last N option-chain snapshots for the day.
 */
exports.getOptionChain = asyncHandler(async (req, res) => {
  const { date, limit = '120', from, to } = req.query;
  if (!date) throw new HttpError(400, 'date is required (YYYY-MM-DD)');
  const file = path.join(ROOT_DIR, `${date}_${getUnderlying()}`, 'option-chain.jsonl');
  if (!fs.existsSync(file)) return res.json({ count: 0, snapshots: [] });
  const max = Math.max(1, Math.min(2000, parseInt(limit, 10) || 120));
  const rows = await _readJsonl(file, max, from ? Number(from) : null, to ? Number(to) : null);
  res.json({ count: rows.length, snapshots: rows });
});

/** GET /api/feed-recorder/metadata?date=YYYY-MM-DD */
exports.getMetadata = asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) throw new HttpError(400, 'date is required (YYYY-MM-DD)');
  const file = path.join(ROOT_DIR, `${date}_${getUnderlying()}`, 'metadata.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(file);
});

// ---- helpers -------------------------------------------------------------
async function _readJsonl(file, maxRows, from, to) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    const all = [];
    rl.on('line', (line) => {
      if (!line) return;
      try {
        const row = JSON.parse(line);
        if (from != null && row.t < from) return;
        if (to != null && row.t > to) return;
        all.push(row);
      } catch (_) {}
    });
    rl.on('close', () => {
      // Return the tail (most recent N)
      resolve(all.slice(-maxRows));
    });
  });
}
