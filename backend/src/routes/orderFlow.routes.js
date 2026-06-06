const express = require('express');
const ctrl = require('../controllers/orderFlow.controller');

const router = express.Router();
router.get('/', ctrl.getOrderFlow);

module.exports = router;
