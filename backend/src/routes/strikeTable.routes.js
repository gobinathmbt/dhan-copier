const express = require('express');
const ctrl = require('../controllers/strikeTable.controller');

const router = express.Router();
router.get('/', ctrl.getStrikeTable);

module.exports = router;
