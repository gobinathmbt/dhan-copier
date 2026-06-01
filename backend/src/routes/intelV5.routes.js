const express = require('express');
const ctrl = require('../controllers/intelV5.controller');

const router = express.Router();
router.get('/decision', ctrl.getDecision);

module.exports = router;
