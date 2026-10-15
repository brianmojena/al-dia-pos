const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { operationTime } = require('../lib/operationTime');
const { boundsForDate } = require('../lib/businessDay');
const { describeAccount } = require('../lib/account');
const { requireOwner, OWNER } = require('../middleware/auth');
const { resolveRegisterId } = require('../lib/register');
const { withdrawalFields } = require('../lib/payment');

/**
 * Extracciones de caja: el dueño retira dinero en efectivo, transferencia,
 * dólares o euros. Solo el dueño puede crear o anular extracciones.
 */

const isUniqueViolation = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
};

const findByClientId = (db, userId, clientId) =>
  db.execute({
    sql: 'SELECT * FROM cash_withdrawals WHERE user_id = ? AND client_withdrawal_id = ?',
    args: [userId, clientId],
  });

router.get('/', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  let sql = 'SELECT * FROM cash_withdrawals WHERE user_id = ?';
  let args = [req.userId];

  if (req.query.date) {
    const dia = boundsForDate(req.query.date);
    sql += ' AND created_at >= ? AND created_at < ?';
    args.push(dia.start, dia.end);
  }

  if (req.query.open) {
    sql += ' AND cash_close_id IS NULL';
  }

  sql += ' ORDER BY created_at DESC, id DESC';
  if (!req.query.date && !req.query.open) {
    sql += ' LIMIT 200';
  }

  const result = await db.execute({ sql, args });
  res.json(result.rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  // No usamos requireOwner: devolvemos un mensaje diferente si no es dueño.
  if (req.role !== OWNER) {
    return res.status(403).json({ error: 'Solo el dueño puede extraer dinero' });
  }

  let operationDate;
  try { operationDate = operationTime(req.body.withdrawn_at); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  let fields;
  try { fields = withdrawalFields(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const { client_withdrawal_id = null, register_id: requestedRegisterId = null } = req.body;
  if (!client_withdrawal_id) {
    return res.status(400).json({ error: 'client_withdrawal_id es requerido' });
  }

  const db = getDb();

  // Idempotencia (camino rápido), igual que en compras de divisa.
  if (client_withdrawal_id) {
    const existing = await findByClientId(db, req.userId, client_withdrawal_id);
    if (existing.rows[0]) return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
  }

  const account = await describeAccount(db, req);
  const registerId = resolveRegisterId(req, requestedRegisterId);

  try {
    const inserted = await db.execute({
      sql: `INSERT INTO cash_withdrawals
              (user_id, client_withdrawal_id, method, amount, note,
               register_id, account_id, account_email, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      args: [
        req.userId, client_withdrawal_id, fields.method, fields.amount, fields.note,
        registerId, account.id, account.email, operationDate,
      ],
    });
    const row = await db.execute({
      sql: 'SELECT * FROM cash_withdrawals WHERE id = ?',
      args: [Number(inserted.lastInsertRowid)],
    });
    return res.status(201).json(row.rows[0]);
  } catch (err) {
    if (client_withdrawal_id && isUniqueViolation(err)) {
      const existing = await findByClientId(db, req.userId, client_withdrawal_id);
      if (existing.rows[0]) return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
    }
    throw err;
  }
}));

router.post('/:clientWithdrawalId/void', asyncHandler(async (req, res) => {
  // No usamos requireOwner: devolvemos un mensaje diferente si no es dueño.
  if (req.role !== OWNER) {
    return res.status(403).json({ error: 'Solo el dueño puede extraer dinero' });
  }

  const db = getDb();
  const { clientWithdrawalId } = req.params;

  const tx = await db.transaction('write');
  try {
    const withdrawal = await tx.execute({
      sql: 'SELECT * FROM cash_withdrawals WHERE user_id = ? AND client_withdrawal_id = ?',
      args: [req.userId, clientWithdrawalId],
    });

    if (withdrawal.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Extracción no encontrada' });
    }

    const row = withdrawal.rows[0];

    // Ya estaba anulada - idempotente
    if (row.voided_at) {
      await tx.rollback();
      return res.status(200).json(row);
    }

    // Ya está cubierta por un cierre - no se puede anular
    if (row.cash_close_id != null) {
      await tx.rollback();
      return res.status(409).json({ error: 'Esta extracción ya entró en un cierre de caja y no se puede anular' });
    }

    // Anular la extracción
    await tx.execute({
      sql: 'UPDATE cash_withdrawals SET voided_at = datetime(\'now\') WHERE id = ? AND cash_close_id IS NULL AND voided_at IS NULL',
      args: [row.id],
    });

    await tx.commit();

    const updated = await db.execute({
      sql: 'SELECT * FROM cash_withdrawals WHERE id = ?',
      args: [row.id],
    });

    return res.status(200).json(updated.rows[0]);
  } catch (err) {
    await tx.rollback().catch(() => { /* transacción ya cerrada */ });
    throw err;
  }
}));

module.exports = router;
