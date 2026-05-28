const express = require('express');
const ctrl = require('../controllers/intelV3.controller');

const router = express.Router();

// Read-only
router.get('/snapshot', ctrl.getSnapshot);
router.get('/available-dates', ctrl.getAvailableDates);

module.exports = router;
