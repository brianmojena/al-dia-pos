const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');

const PLATFORMS = ['ios', 'android'];

// El teléfono registra su token tras iniciar sesión. Solo el dueño (el router
// se monta con requireOwner): un cajero no debe enterarse de lo que se vende.
router.post('/register', asyncHandler(async (req, res) => {
  const { platform, token } = req.body || {};
  if (!PLATFORMS.includes(platform) || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'Falta plataforma (ios/android) o token' });
  }
  await getDb().execute({
    sql: `INSERT INTO push_devices (user_id, account_id, platform, token) VALUES (?, ?, ?, ?)
          ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, account_id = excluded.account_id, platform = excluded.platform`,
    args: [req.userId, req.accountId, platform, token.trim()],
  });
  res.status(204).end();
}));

// Al cerrar sesión: ese teléfono deja de recibir avisos de esta tienda.
router.delete('/register', asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (typeof token === 'string' && token.trim()) {
    await getDb().execute({
      sql: 'DELETE FROM push_devices WHERE token = ? AND user_id = ?',
      args: [token.trim(), req.userId],
    });
  }
  res.status(204).end();
}));

module.exports = router;
