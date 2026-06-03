const express = require('express');
const ctrl = require('../controllers/strikeChart.controller');

const router = express.Router();
router.get('/', ctrl.getStrikeChart);

module.exports = router;
