const express = require('express');
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { redeemEnrollCode } = require('../lib/sharedDevices');

// Activación remota de una caja compartida. El código de un solo uso ES la
// credencial (lo dicta el administrador), así que la ruta va sin sesión: el
// aparato todavía no tiene cuenta a la que recurrir. Devuelve el bundle con los
// PIN ya cifrados para que el aparato instale la caja sin teclear ningún PIN.
const router = express.Router();

router.post('/', asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'Falta el código de activación' });
  const bundle = await redeemEnrollCode(getDb(), code);
  if (!bundle) return res.status(404).json({ error: 'El código no es válido, ya se usó o venció. Pide uno nuevo al administrador.' });
  res.json(bundle);
}));

module.exports = router;
