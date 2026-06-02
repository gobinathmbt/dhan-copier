const express = require('express');
const ctrl = require('../controllers/intelV6.controller');

const router = express.Router();
router.get('/decision', ctrl.getDecision);

module.exports = router;
