const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAuth, requireOwner, OWNER, CASHIER } = require('../middleware/auth');
const { JWT_SECRET } = require('../config');
const { asyncHandler } = require('../lib/asyncHandler');

const PLANS = ['premium', 'dev'];

// La identidad y los ajustes del negocio salen de sitios distintos: un cajero
// tiene su propio email y su propio rol, pero el nombre de la tienda, el plan,
// el límite de transferencia y la tasa del dólar son de la TIENDA. Sin esto,
// la caja de un cajero abriría sin límite ni tasa configurados.
const publicUser = (account, shop = account) => ({
  id: account.id,
  email: account.email,
  role: account.role || OWNER,
  created_at: account.created_at,
  store_name: shop.store_name,
  plan: shop.plan,
  transfer_limit: shop.transfer_limit ?? null,
  usd_rate: shop.usd_rate ?? null,
});

// userId es la TIENDA (para un dueño, él mismo); accountId es quien inicia
// sesión. Ver la nota en middleware/auth.js.
const sign = (user) => jwt.sign(
  {
    userId: user.owner_id || user.id,
    accountId: user.id,
    role: user.role || OWNER,
  },
  JWT_SECRET,
  { expiresIn: '30d' }
);

// Carga la fila de la tienda cuando quien pide es un cajero.
const loadShop = async (db, account) => {
  if (!account.owner_id) return account;
  const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [account.owner_id] });
  return result.rows[0] || account;
};

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
  res.status(201).json({ token: sign(user), user: publicUser(user) });
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

  res.json({ token: sign(user), user: publicUser(user, await loadShop(db, user)) });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  // accountId, no userId: para un cajero son distintos y aquí queremos saber
  // quién inició sesión, no de quién es la tienda.
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [req.accountId],
  });
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: publicUser(user, await loadShop(db, user)) });
}));

// Configuración del negocio: límite de transferencia y tasa del dólar que el
// dueño ajusta desde el dashboard móvil. Ambos campos son opcionales e
// independientes — se puede actualizar uno sin tocar el otro. null explícito
// borra el valor (vuelve a "sin definir").
router.put('/settings', requireAuth, requireOwner, asyncHandler(async (req, res) => {
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

// --- Cajeros -------------------------------------------------------------
// Cuentas que pueden cobrar y cerrar la caja, pero no ver cuánto debería haber
// en ella. Solo el dueño las crea y las borra.

const publicCashier = (u) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  created_at: u.created_at,
});

router.get('/cashiers', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM users WHERE owner_id = ? ORDER BY created_at ASC',
    args: [req.userId],
  });
  res.json(result.rows.map(publicCashier));
}));

router.post('/cashiers', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  const db = getDb();
  const existing = await db.execute({
    sql: 'SELECT id FROM users WHERE email = ?',
    args: [email.toLowerCase()],
  });
  if (existing.rows[0]) return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });

  const shopResult = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.userId] });
  const shop = shopResult.rows[0];
  if (!shop) return res.status(404).json({ error: 'Tienda no encontrada' });

  const insert = await db.execute({
    sql: `INSERT INTO users (email, password_hash, store_name, plan, role, owner_id)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      email.toLowerCase(),
      bcrypt.hashSync(password, 10),
      shop.store_name,   // el cajero pertenece a la misma tienda
      shop.plan,
      CASHIER,
      req.userId,
    ],
  });

  const created = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [Number(insert.lastInsertRowid)],
  });
  res.status(201).json(publicCashier(created.rows[0]));
}));

router.delete('/cashiers/:id', requireAuth, requireOwner, asyncHandler(async (req, res) => {
  // El owner_id en el WHERE no es decorativo: sin él, un dueño podría borrar
  // el cajero de otra tienda adivinando su id.
  const result = await getDb().execute({
    sql: 'DELETE FROM users WHERE id = ? AND owner_id = ?',
    args: [req.params.id, req.userId],
  });
  if (result.rowsAffected === 0) return res.status(404).json({ error: 'Cajero no encontrado' });
  res.json({ success: true });
}));

module.exports = router;
