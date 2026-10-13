const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { operationTime } = require('../lib/operationTime');
const { boundsForDate } = require('../lib/businessDay');
const { describeAccount } = require('../lib/account');
const { requireOwner } = require('../middleware/auth');
const { resolveRegisterId } = require('../lib/register');
const { purchaseFields } = require('../lib/payment');

/**
 * Compra de dólares o euros. Cualquier cuenta de la tienda puede registrarla
 * (quien atiende la caja es quien compra); el historial es del dueño.
 *
 * Los pesos que salen de la gaveta se calculan aquí —monto × tasa— y no se
 * aceptan del cliente. La tasa de la tienda la manda el aparato, como en las
 * ventas: es la que conocía al comprar, que puede ser de ayer si no tenía red.
 */

const isUniqueViolation = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
};

const findByClientId = (db, userId, clientId) =>
  db.execute({
    sql: 'SELECT * FROM currency_purchases WHERE user_id = ? AND client_purchase_id = ?',
    args: [userId, clientId],
  });

router.get('/', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  const dia = req.query.date ? boundsForDate(req.query.date) : null;
  const result = dia
    ? await db.execute({
        sql: 'SELECT * FROM currency_purchases WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC',
        args: [req.userId, dia.start, dia.end],
      })
    : await db.execute({
        sql: 'SELECT * FROM currency_purchases WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
        args: [req.userId],
      });
  res.json(result.rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  let operationDate;
  try { operationDate = operationTime(req.body.sold_at); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  let fields;
  try { fields = purchaseFields(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const { client_purchase_id = null, register_id: requestedRegisterId = null } = req.body;
  const db = getDb();

  // Idempotencia (camino rápido), igual que en ventas.
  if (client_purchase_id) {
    const existing = await findByClientId(db, req.userId, client_purchase_id);
    if (existing.rows[0]) return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
  }

  if (!('shop_rate' in req.body)) {
    const shop = await db.execute({ sql: 'SELECT usd_rate, eur_rate FROM users WHERE id = ?', args: [req.userId] });
    fields.shop_rate = shop.rows[0]?.[fields.foreign_currency === 'USD' ? 'usd_rate' : 'eur_rate'] ?? null;
  }

  const account = await describeAccount(db, req);
  const registerId = resolveRegisterId(req, requestedRegisterId);

  try {
    const inserted = await db.execute({
      sql: `INSERT INTO currency_purchases
              (user_id, client_purchase_id, foreign_currency, foreign_amount, exchange_rate, shop_rate,
               cup_amount, register_id, account_id, account_email, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      args: [
        req.userId, client_purchase_id, fields.foreign_currency, fields.foreign_amount, fields.exchange_rate,
        fields.shop_rate, fields.cup_amount, registerId, account.id, account.email, operationDate,
      ],
    });
    const row = await db.execute({
      sql: 'SELECT * FROM currency_purchases WHERE id = ?',
      args: [Number(inserted.lastInsertRowid)],
    });
    return res.status(201).json(row.rows[0]);
  } catch (err) {
    if (client_purchase_id && isUniqueViolation(err)) {
      const existing = await findByClientId(db, req.userId, client_purchase_id);
      if (existing.rows[0]) return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
    }
    throw err;
  }
}));

module.exports = router;
