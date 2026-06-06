const express = require('express');
const ctrl = require('../controllers/cprCamarilla.controller');

const router = express.Router();
router.get('/', ctrl.getCprCam);

module.exports = router;
