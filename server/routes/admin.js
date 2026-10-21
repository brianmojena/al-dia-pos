const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { deviceReport } = require('../lib/devices');
const router = express.Router();

router.get('/devices', asyncHandler(async (_req, res) => {
  res.json(await deviceReport());
}));

module.exports = router;
