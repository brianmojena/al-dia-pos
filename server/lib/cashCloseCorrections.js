'use strict';

const { replay, record } = require('./clientOperations');
const { paymentSplit, purchaseSplit, withdrawalSplit, round2 } = require('./payment');

class CashCloseCorrectionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const EDITABLE_FIELDS = ['opening_float', 'counted_cash', 'counted_usd', 'counted_eur', 'note'];
const SNAPSHOT_FIELDS = [
  ...EDITABLE_FIELDS, 'expected_cash', 'difference', 'expected_transfer', 'sales_count',
  'expected_usd', 'difference_usd', 'expected_eur', 'difference_eur',
  'withdrawn_cash', 'withdrawn_transfer', 'withdrawn_usd', 'withdrawn_eur',
  'corrected_at', 'original_expected_cash', 'original_difference', 'correction_revision',
];

const valueFrom = (row, key) => row[key] ?? null;
const snapshot = (row) => Object.fromEntries(SNAPSHOT_FIELDS.map((key) => [key, valueFrom(row, key)]));
const amount = (value, field) => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
      || !['number', 'string'].includes(typeof value)) {
    throw new CashCloseCorrectionError(400, `${field} debe ser un número mayor o igual a cero`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CashCloseCorrectionError(400, `${field} debe ser un número mayor o igual a cero`);
  }
  const rounded = round2(parsed);
  if (!Number.isFinite(rounded) || !Number.isSafeInteger(Math.round(rounded * 100))) {
    throw new CashCloseCorrectionError(400, `${field} supera el importe permitido`);
  }
  return rounded;
};

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CashCloseCorrectionError(400, 'Datos de corrección inválidos');
  }
  const allowed = new Set([...EDITABLE_FIELDS, 'correction_revision']);
  const extra = Object.keys(body).filter((key) => !allowed.has(key));
  if (extra.length) throw new CashCloseCorrectionError(400, `Campo no permitido: ${extra[0]}`);
  for (const key of ['opening_float', 'counted_cash', 'counted_usd', 'counted_eur', 'correction_revision']) {
    if (!Object.hasOwn(body, key)) throw new CashCloseCorrectionError(400, `Falta el campo ${key}`);
  }
  if (!Object.hasOwn(body, 'note')) throw new CashCloseCorrectionError(400, 'Falta el campo note');
  const rawRevision = body.correction_revision;
  const revision = typeof rawRevision === 'number' ? rawRevision
    : typeof rawRevision === 'string' && rawRevision.trim() !== '' ? Number(rawRevision) : NaN;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new CashCloseCorrectionError(400, 'La revisión del cierre no es válida');
  }
  if (body.note != null && typeof body.note !== 'string') {
    throw new CashCloseCorrectionError(400, 'La nota debe ser texto');
  }
  const note = body.note == null ? null : body.note.trim();
  if (note?.length > 200) throw new CashCloseCorrectionError(400, 'La nota no puede superar 200 caracteres');
  return {
    opening_float: amount(body.opening_float, 'El fondo inicial'),
    counted_cash: amount(body.counted_cash, 'El efectivo contado'),
    counted_usd: amount(body.counted_usd, 'Los dólares contados'),
    counted_eur: amount(body.counted_eur, 'Los euros contados'),
    note: note || null,
    correction_revision: revision,
  };
}

const run = async (tx, sql, args = []) => (await tx.execute({ sql, args })).rows;
const total = (rows, split, field) => rows.reduce((sum, row) => sum + split(row)[field], 0);

async function closeDetails(db, close, { includeAudit = true } = {}) {
  let corrections = [];
  if (includeAudit) {
    corrections = await run(db,
      `SELECT id, cash_close_id, correction_revision, account_id, account_email,
              before, after, created_at
         FROM cash_close_corrections WHERE user_id = ? AND cash_close_id = ?
        ORDER BY correction_revision DESC`, [close.user_id, close.id]);
    corrections = corrections.map((row) => ({
      ...row,
      before: JSON.parse(row.before),
      after: JSON.parse(row.after),
    }));
  }
  return { ...close, corrections };
}

async function correctCashClose(db, { userId, closeId, body, account, op = null }) {
  const input = validateBody(body);
  const tx = await db.transaction('write');
  try {
    const prior = op && await replay(tx, op);
    if (prior) { await tx.rollback(); return prior.body; }
    const close = (await run(tx,
      'SELECT * FROM cash_closes WHERE id = ? AND user_id = ?', [closeId, userId]))[0];
    if (!close) throw new CashCloseCorrectionError(404, 'Cierre de caja no encontrado');
    const revision = Number(close.correction_revision || 0);
    if (revision !== input.correction_revision) {
      throw new CashCloseCorrectionError(409, 'Este cierre cambió desde que lo abriste. Vuelve a cargarlo antes de corregir.');
    }
    const before = snapshot(close);
    const changed = EDITABLE_FIELDS.some((key) => input[key] !== (close[key] ?? null));
    if (!changed) {
      await tx.rollback();
      return { cash_close: await closeDetails(db, close), correction: null };
    }

    let expected;
    if (Number(close.overlap_sales || 0) > 0) {
      // El solapamiento de una transición de legado impide recomponer con
      // seguridad qué contribuciones originales eran válidas. Se conserva
      // todo lo esperado y se cambia únicamente el efecto del fondo inicial.
      expected = {
        expected_cash: round2(Number(close.expected_cash) + input.opening_float - Number(close.opening_float)),
        expected_transfer: Number(close.expected_transfer) || 0,
        expected_usd: Number(close.expected_usd) || 0,
        expected_eur: Number(close.expected_eur) || 0,
        sales_count: Number(close.sales_count) || 0,
        withdrawn_cash: Number(close.withdrawn_cash) || 0,
        withdrawn_transfer: Number(close.withdrawn_transfer) || 0,
        withdrawn_usd: Number(close.withdrawn_usd) || 0,
        withdrawn_eur: Number(close.withdrawn_eur) || 0,
      };
    } else {
      // Solo movimientos explícitamente vinculados a este cierre, dentro de
      // la fecha cerrada. Las ventas/compras/extracciones abiertas o posteriores
      // nunca participan en una corrección histórica.
      const sales = await run(tx,
        `SELECT total, payment_method, transfer_amount, foreign_currency,
                foreign_amount, exchange_rate
           FROM sales WHERE user_id = ? AND cash_close_id = ?`,
        [userId, close.id]);
      const purchases = await run(tx,
        `SELECT foreign_currency, foreign_amount, cup_amount
           FROM currency_purchases WHERE user_id = ? AND cash_close_id = ?`,
        [userId, close.id]);
      const withdrawals = await run(tx,
        `SELECT method, amount, voided_at FROM cash_withdrawals
          WHERE user_id = ? AND cash_close_id = ? AND voided_at IS NULL`,
        [userId, close.id]);
      expected = {
        expected_cash: round2(input.opening_float + total(sales, paymentSplit, 'cash')
          + total(purchases, purchaseSplit, 'cash') + total(withdrawals, withdrawalSplit, 'cash')),
        expected_transfer: round2(total(sales, paymentSplit, 'transfer')
          + total(purchases, purchaseSplit, 'transfer') + total(withdrawals, withdrawalSplit, 'transfer')),
        expected_usd: round2(total(sales, paymentSplit, 'usd')
          + total(purchases, purchaseSplit, 'usd') + total(withdrawals, withdrawalSplit, 'usd')),
        expected_eur: round2(total(sales, paymentSplit, 'eur')
          + total(purchases, purchaseSplit, 'eur') + total(withdrawals, withdrawalSplit, 'eur')),
        sales_count: sales.length,
        withdrawn_cash: round2(withdrawals.reduce((sum, row) => sum + (row.method === 'efectivo' ? Number(row.amount) : 0), 0)),
        withdrawn_transfer: round2(withdrawals.reduce((sum, row) => sum + (row.method === 'transferencia' ? Number(row.amount) : 0), 0)),
        withdrawn_usd: round2(withdrawals.reduce((sum, row) => sum + (row.method === 'USD' ? Number(row.amount) : 0), 0)),
        withdrawn_eur: round2(withdrawals.reduce((sum, row) => sum + (row.method === 'EUR' ? Number(row.amount) : 0), 0)),
      };
    }

    const correctedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const after = {
      ...before,
      ...input,
      ...expected,
      difference: round2(input.counted_cash - expected.expected_cash),
      difference_usd: round2(input.counted_usd - expected.expected_usd),
      difference_eur: round2(input.counted_eur - expected.expected_eur),
      original_expected_cash: close.original_expected_cash ?? close.expected_cash,
      original_difference: close.original_difference ?? close.difference,
      corrected_at: correctedAt,
      correction_revision: revision + 1,
    };

    await tx.execute({
      sql: `INSERT INTO cash_close_corrections
              (user_id, cash_close_id, correction_revision, account_id, account_email, before, after)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [userId, close.id, revision + 1, account.id, account.email,
        JSON.stringify(before), JSON.stringify(after)],
    });
    const updated = await tx.execute({
      sql: `UPDATE cash_closes SET opening_float = ?, counted_cash = ?, counted_usd = ?, counted_eur = ?,
              note = ?, expected_cash = ?, difference = ?, expected_transfer = ?, sales_count = ?,
              expected_usd = ?, difference_usd = ?, expected_eur = ?, difference_eur = ?,
              withdrawn_cash = ?, withdrawn_transfer = ?, withdrawn_usd = ?, withdrawn_eur = ?,
              original_expected_cash = COALESCE(original_expected_cash, ?),
              original_difference = COALESCE(original_difference, ?),
              corrected_at = ?, correction_revision = ?
            WHERE id = ? AND user_id = ? AND correction_revision = ?`,
      args: [input.opening_float, input.counted_cash, input.counted_usd, input.counted_eur,
        input.note, expected.expected_cash, after.difference, expected.expected_transfer,
        expected.sales_count, expected.expected_usd, after.difference_usd,
        expected.expected_eur, after.difference_eur, expected.withdrawn_cash,
        expected.withdrawn_transfer, expected.withdrawn_usd, expected.withdrawn_eur,
        close.expected_cash, close.difference, correctedAt, revision + 1, close.id, userId, revision],
    });
    if (Number(updated.rowsAffected) !== 1) {
      throw new CashCloseCorrectionError(409, 'Este cierre cambió durante la corrección. Vuelve a cargarlo.');
    }
    const nextClose = (await run(tx,
      'SELECT * FROM cash_closes WHERE id = ? AND user_id = ?', [close.id, userId]))[0];
    const correction = (await run(tx,
      `SELECT id, cash_close_id, correction_revision, account_id, account_email,
              before, after, created_at FROM cash_close_corrections
        WHERE user_id = ? AND cash_close_id = ? AND correction_revision = ?`,
      [userId, close.id, revision + 1]))[0];
    const result = {
      cash_close: await closeDetails(tx, nextClose),
      correction: { ...correction, before: JSON.parse(correction.before), after: JSON.parse(correction.after) },
    };
    if (op) await record(tx, op, 200, result);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

module.exports = { CashCloseCorrectionError, validateCashCloseCorrection: validateBody, closeDetails, correctCashClose };
