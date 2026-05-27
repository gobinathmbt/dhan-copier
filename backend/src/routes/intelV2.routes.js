const express = require('express');
const ctrl = require('../controllers/intelV2.controller');

const router = express.Router();

// Public read-only — same auth model as v1 (none, dashboard polls without token)
router.get('/snapshot', ctrl.getSnapshot);
router.get('/dual', ctrl.getDualSnapshot);
router.get('/available-dates', ctrl.getAvailableDates);

module.exports = router;
