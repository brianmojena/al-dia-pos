const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { ADMIN_EMAILS } = require('../config');
const { labelOf, planStateOf } = require('../lib/plans');
const { issueResetCode } = require('../lib/passwordReset');

/**
 * Panel de administración: confirmar tiendas nuevas después de cobrar el pago
 * (que es en persona). Una tienda nace 'pending' con 7 días de prueba; si la
 * prueba vence sin confirmación, la tienda entera queda bloqueada (el cálculo
 * vive en planStateOf, compartido con las respuestas de auth).
 */

// Fila de tienda (cuenta principal) tal como la ve el panel.
const shapeShop = (row) => ({
  id: Number(row.id),
  email: row.email,
  store_name: row.store_name,
  plan: row.plan,
  plan_label: labelOf(row.plan),
  created_at: row.created_at,
  team_size: Number(row.team_size || 1),
  ...planStateOf(row),
});

const SHOP_COLUMNS = `
  u.id, u.email, u.store_name, u.plan, u.created_at, u.plan_status, u.trial_ends_at,
  (1 + (SELECT COUNT(*) FROM users c WHERE c.owner_id = u.id)) AS team_size
`;

// Todas las tiendas, pendientes primero. La cuenta (o cuentas) de
// administración se excluyen: no se confirman a sí mismas.
router.get('/shops', asyncHandler(async (req, res) => {
  const marks = ADMIN_EMAILS.map(() => '?').join(', ');
  const result = await getDb().execute({
    sql: `SELECT ${SHOP_COLUMNS}
          FROM users u
          WHERE u.owner_id IS NULL AND u.email NOT IN (${marks})
          ORDER BY (u.plan_status = 'pending') DESC, u.created_at DESC, u.id DESC`,
    args: ADMIN_EMAILS,
  });
  res.json({ shops: result.rows.map(shapeShop) });
}));

// Confirmación: la tienda deja de estar pendiente para siempre. Se aplica
// solo sobre cuentas principales (owner_id NULL): confirmar un cajero por su
// id sería confirmar la tienda equivocada.
router.post('/shops/:id/confirm', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Tienda inválida' });

  const db = getDb();
  const update = await db.execute({
    sql: "UPDATE users SET plan_status = 'active' WHERE id = ? AND owner_id IS NULL",
    args: [id],
  });
  if (update.rowsAffected === 0) return res.status(404).json({ error: 'Tienda no encontrada' });

  const row = (await db.execute({
    sql: `SELECT ${SHOP_COLUMNS} FROM users u WHERE u.id = ?`,
    args: [id],
  })).rows[0];
  res.json({ shop: shapeShop(row) });
}));

// Generación de código de recuperación de contraseña.
// Solo para cuentas principales (dueños de tienda), no para cajeros ni admin.
router.post('/shops/:id/reset-code', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Tienda inválida' });

  const db = getDb();
  // Buscar la tienda: debe ser una cuenta principal, no de administración
  const shop = (await db.execute({
    sql: 'SELECT id, email FROM users WHERE id = ? AND owner_id IS NULL',
    args: [id],
  })).rows[0];

  if (!shop) return res.status(404).json({ error: 'Tienda no encontrada' });
  if (ADMIN_EMAILS.includes(shop.email.toLowerCase())) {
    return res.status(404).json({ error: 'Tienda no encontrada' });
  }

  const { code, expires_at } = await issueResetCode(db, id);
  res.json({ code, expires_at });
}));

module.exports = router;
