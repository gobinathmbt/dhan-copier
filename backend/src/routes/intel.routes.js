const express = require('express');
const ctrl = require('../controllers/intel.controller');

const router = express.Router();

// Public read-only intelligence — no auth required so the dashboard
// can poll without a token. Mirrors the live-feed status endpoint.
router.get('/snapshot', ctrl.getSnapshot);
router.get('/dual', ctrl.getDualSnapshot);

module.exports = router;
