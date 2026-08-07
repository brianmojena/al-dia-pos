const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { JWT_SECRET } = require('../config');
const { asyncHandler } = require('../lib/asyncHandler');

const PLANS = ['premium', 'dev'];

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  store_name: u.store_name,
  plan: u.plan,
  created_at: u.created_at,
  transfer_limit: u.transfer_limit ?? null,
  usd_rate: u.usd_rate ?? null,
});

const sign = (userId) => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });

router.post('/register', asyncHandler(async (req, res) => {
  const { email, password, store_name, plan } = req.body;

  if (!email || !password || !store_name) {
    return res.status(400).json({ error: 'Email, contraseña y nombre de la tienda son requeridos' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  const chosenPlan = PLANS.includes(plan) ? plan : 'dev';

  const db = getDb();
  const existingResult = await db.execute({
    sql: 'SELECT id FROM users WHERE email = ?',
    args: [email.toLowerCase()],
  });
  if (existingResult.rows[0]) return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });

  const password_hash = bcrypt.hashSync(password, 10);
  const insertResult = await db.execute({
    sql: 'INSERT INTO users (email, password_hash, store_name, plan) VALUES (?, ?, ?, ?)',
    args: [email.toLowerCase(), password_hash, store_name, chosenPlan],
  });

  const userResult = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [Number(insertResult.lastInsertRowid)],
  });
  const user = userResult.rows[0];
  res.status(201).json({ token: sign(user.id), user: publicUser(user) });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE email = ?',
    args: [email.toLowerCase()],
  });
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  }

  res.json({ token: sign(user.id), user: publicUser(user) });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [req.userId],
  });
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: publicUser(user) });
}));

// Configuración del negocio: límite de transferencia y tasa del dólar que el
// dueño ajusta desde el dashboard móvil. Ambos campos son opcionales e
// independientes — se puede actualizar uno sin tocar el otro. null explícito
// borra el valor (vuelve a "sin definir").
router.put('/settings', requireAuth, asyncHandler(async (req, res) => {
  const { transfer_limit, usd_rate } = req.body;

  const validate = (value, label) => {
    if (value === undefined || value === null) return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      throw Object.assign(new Error(`${label} debe ser un número mayor o igual a 0`), { status: 400 });
    }
    return num;
  };

  let nextTransferLimit, nextUsdRate;
  try {
    nextTransferLimit = 'transfer_limit' in req.body ? validate(transfer_limit, 'El límite de transferencia') : undefined;
    nextUsdRate        = 'usd_rate' in req.body ? validate(usd_rate, 'La tasa del dólar') : undefined;
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const db = getDb();
  const existing = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.userId] });
  const user = existing.rows[0];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  await db.execute({
    sql: 'UPDATE users SET transfer_limit = ?, usd_rate = ? WHERE id = ?',
    args: [
      nextTransferLimit !== undefined ? nextTransferLimit : user.transfer_limit,
      nextUsdRate        !== undefined ? nextUsdRate        : user.usd_rate,
      req.userId,
    ],
  });

  const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.userId] });
  res.json({ user: publicUser(result.rows[0]) });
}));

module.exports = router;
