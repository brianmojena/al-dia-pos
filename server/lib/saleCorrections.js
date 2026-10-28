/**
 * Correcciones de la cuenta principal sobre una venta ya registrada.
 *
 * Dos acciones:
 *   - 'pago': cambia la forma de pago (efectivo, transferencia, mixto o divisa).
 *     El total, los productos y la ganancia no cambian.
 *   - 'anular': la venta desaparece y sus unidades vuelven al stock.
 *
 * Si la venta ya estaba en un cierre de caja, el cierre se recalcula con la
 * misma cuenta del arqueo (paymentSplit): lo esperado cambia y la diferencia
 * contra lo contado también. Lo contado nunca se toca: es lo que hubo en la
 * gaveta. El cierre queda marcado como corregido y guarda lo que dio la
 * primera vez.
 *
 * Todo queda en sale_corrections con la venta antes y después, quién y cuándo.
 */
const { PAYMENT_METHODS, paymentSplit, foreignFields, round2 } = require('./payment');
const { logStockChange } = require('./stockLog');
const { lineUnits } = require('./units');
const { replay, record } = require('./clientOperations');

class CorrectionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const PAYMENT_FIELDS = ['payment_method', 'transfer_amount', 'foreign_currency', 'foreign_amount', 'exchange_rate', 'shop_rate'];

const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

const CLOSE_FIELDS = [
  'expected_cash', 'counted_cash', 'difference', 'expected_transfer', 'sales_count',
  'expected_usd', 'counted_usd', 'difference_usd', 'expected_eur', 'counted_eur', 'difference_eur',
  'opening_float', 'note', 'withdrawn_cash', 'withdrawn_transfer', 'withdrawn_usd', 'withdrawn_eur',
  'corrected_at', 'original_expected_cash', 'original_difference', 'correction_revision',
];

// La forma de pago nueva, validada igual que al cobrar.
function nextPayment(body, sale, shop) {
  const method = body.payment_method;
  if (!PAYMENT_METHODS.includes(method)) throw new CorrectionError(400, 'Forma de pago inválida');
  const total = Number(sale.total) || 0;
  let transferAmount = null;
  if (method === 'mixto') {
    transferAmount = round2(body.transfer_amount);
    if (body.transfer_amount == null || !Number.isFinite(Number(body.transfer_amount)) || transferAmount <= 0) {
      throw new CorrectionError(400, 'Falta el monto transferido del cobro mixto');
    }
    if (transferAmount >= total) throw new CorrectionError(400, 'El monto transferido tiene que ser menor que el total');
  }
  let foreign;
  try {
    // La tasa de la tienda contra la que se compara es la de hoy, salvo que la
    // venta ya fuera en esa misma moneda: entonces se conserva la que tenía.
    const sameCurrency = sale.payment_method === 'divisa' && sale.foreign_currency === body.foreign_currency;
    const shopRate = sameCurrency
      ? sale.shop_rate
      : shop?.[body.foreign_currency === 'EUR' ? 'eur_rate' : 'usd_rate'] ?? null;
    foreign = foreignFields({ ...body, shop_rate: shopRate });
  } catch (error) { throw new CorrectionError(400, error.message); }
  return { payment_method: method, transfer_amount: transferAmount, ...foreign };
}

const samePayment = (a, b) => PAYMENT_FIELDS.every((k) => {
  if (k === 'shop_rate') return true;
  const x = a[k] ?? null, y = b[k] ?? null;
  return typeof x === 'number' || typeof y === 'number' ? Number(x) === Number(y) : x === y;
});

// Recalcula el cierre quitando lo que aportaba la venta y sumando lo nuevo.
async function adjustClose(tx, userId, closeId, before, after) {
  const close = (await tx.execute({
    sql: 'SELECT * FROM cash_closes WHERE id = ? AND user_id = ?',
    args: [closeId, userId],
  })).rows[0];
  if (!close) return { before: null, after: null };
  const old = paymentSplit(before);
  const next = after ? paymentSplit(after) : { cash: 0, transfer: 0, usd: 0, eur: 0 };
  const expectedCash = round2(Number(close.expected_cash) + next.cash - old.cash);
  const expectedTransfer = round2(Number(close.expected_transfer) + next.transfer - old.transfer);
  const expectedUsd = round2(Number(close.expected_usd) + next.usd - old.usd);
  const expectedEur = round2(Number(close.expected_eur) + next.eur - old.eur);
  const salesCount = Number(close.sales_count) - (after ? 0 : 1);
  await tx.execute({
    sql: `UPDATE cash_closes SET
            expected_cash = ?, difference = ?, expected_transfer = ?, sales_count = ?,
            expected_usd = ?, difference_usd = ?, expected_eur = ?, difference_eur = ?,
            original_expected_cash = COALESCE(original_expected_cash, ?),
            original_difference = COALESCE(original_difference, ?),
            corrected_at = datetime('now'), correction_revision = correction_revision + 1
          WHERE id = ?`,
    args: [
      expectedCash, round2(Number(close.counted_cash) - expectedCash), expectedTransfer, Math.max(0, salesCount),
      expectedUsd, round2(Number(close.counted_usd) - expectedUsd),
      expectedEur, round2(Number(close.counted_eur) - expectedEur),
      close.expected_cash, close.difference, closeId,
    ],
  });
  const updated = (await tx.execute({ sql: 'SELECT * FROM cash_closes WHERE id = ?', args: [closeId] })).rows[0];
  return { before: pick(close, CLOSE_FIELDS), after: pick(updated, CLOSE_FIELDS) };
}

async function correctSale(db, { userId, saleId, body, account, op = null }) {
  const action = body?.action;
  if (action !== 'pago' && action !== 'anular') throw new CorrectionError(400, 'Corrección inválida');
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : null;

  const shop = (await db.execute({ sql: 'SELECT usd_rate, eur_rate FROM users WHERE id = ?', args: [userId] })).rows[0];

  const tx = await db.transaction('write');
  try {
    const prior = op && await replay(tx, op);
    if (prior) { await tx.rollback(); return prior.body; }
    const sale = (await tx.execute({
      sql: 'SELECT * FROM sales WHERE id = ? AND user_id = ?',
      args: [saleId, userId],
    })).rows[0];
    if (!sale) throw new CorrectionError(404, 'Venta no encontrada');
    const items = (await tx.execute({ sql: 'SELECT * FROM sale_items WHERE sale_id = ?', args: [sale.id] })).rows;

    let after = null;
    if (action === 'pago') {
      const payment = nextPayment(body, sale, shop);
      if (samePayment(sale, payment)) throw new CorrectionError(400, 'La venta ya tiene esa forma de pago');
      await tx.execute({
        sql: `UPDATE sales SET payment_method = ?, transfer_amount = ?, foreign_currency = ?,
                foreign_amount = ?, exchange_rate = ?, shop_rate = ? WHERE id = ?`,
        args: [payment.payment_method, payment.transfer_amount, payment.foreign_currency,
               payment.foreign_amount, payment.exchange_rate, payment.shop_rate, sale.id],
      });
      after = { ...sale, ...payment };
    } else {
      // Las unidades vuelven a la tienda. Un producto por peso sin control de
      // stock no se toca, igual que al venderlo; uno borrado ya no existe.
      for (const item of items) {
        if (item.product_id == null) continue;
        const product = (await tx.execute({
          sql: 'SELECT id, name, stock, unit, track_stock FROM products WHERE id = ? AND user_id = ?',
          args: [item.product_id, userId],
        })).rows[0];
        if (!product || (product.unit && Number(product.track_stock) !== 1)) continue;
        const before = Number(product.stock);
        // Un paquete devuelve todos sus sueltos.
        const restored = Math.round((before + lineUnits(item)) * 1000) / 1000;
        await tx.execute({ sql: 'UPDATE products SET stock = ? WHERE id = ?', args: [restored, product.id] });
        await logStockChange(tx, {
          userId, product, before, after: restored, account, kind: 'anulacion',
          reason: `Venta #${sale.id} anulada`,
        });
      }
      await tx.execute({ sql: 'DELETE FROM sale_items WHERE sale_id = ?', args: [sale.id] });
      await tx.execute({ sql: 'DELETE FROM sales WHERE id = ?', args: [sale.id] });
    }

    const close = sale.cash_close_id != null
      ? await adjustClose(tx, userId, Number(sale.cash_close_id), sale, after)
      : { before: null, after: null };

    const inserted = await tx.execute({
      sql: `INSERT INTO sale_corrections
              (user_id, sale_id, client_sale_id, sale_created_at, action, before, after,
               cash_close_id, close_before, close_after, reason, account_id, account_email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        userId, sale.id, sale.client_sale_id ?? null, sale.created_at, action,
        JSON.stringify({ ...sale, items }), after ? JSON.stringify(pick(after, PAYMENT_FIELDS)) : null,
        sale.cash_close_id ?? null,
        close.before ? JSON.stringify(close.before) : null,
        close.after ? JSON.stringify(close.after) : null,
        reason, account.id, account.email,
      ],
    });

    const correction = (await tx.execute({
      sql: 'SELECT * FROM sale_corrections WHERE id = ?',
      args: [Number(inserted.lastInsertRowid)],
    })).rows[0];
    const updatedSale = after
      ? (await tx.execute({ sql: 'SELECT * FROM sales WHERE id = ?', args: [sale.id] })).rows[0]
      : null;
    const updatedClose = sale.cash_close_id != null
      ? (await tx.execute({ sql: 'SELECT * FROM cash_closes WHERE id = ?', args: [sale.cash_close_id] })).rows[0] ?? null
      : null;
    const result = { correction: parseCorrection(correction), sale: updatedSale, cash_close: updatedClose };
    if (op) await record(tx, op, 200, result);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => { /* la transacción ya estaba cerrada */ });
    throw error;
  }
}

const parseJson = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
};

const parseCorrection = (row) => ({
  ...row,
  before: parseJson(row.before),
  after: parseJson(row.after),
  close_before: parseJson(row.close_before),
  close_after: parseJson(row.close_after),
});

module.exports = { correctSale, parseCorrection, CorrectionError };
