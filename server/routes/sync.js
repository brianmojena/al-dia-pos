const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');

const numberParam = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

const loadItems = async (db, table, foreignKey, ids) => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const result = await db.execute({
    sql: `SELECT * FROM ${table} WHERE ${foreignKey} IN (${placeholders}) ORDER BY id ASC`,
    args: ids,
  });
  return result.rows;
};

const attachItems = (rows, items, key, itemKey) => {
  const grouped = new Map();
  for (const item of items) {
    const owner = Number(item[itemKey]);
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(item);
  }
  return rows.map((row) => ({ ...row, items: grouped.get(Number(row.id)) || [] }));
};

router.get('/delta', asyncHandler(async (req, res) => {
  const afterSale = numberParam(req.query.after_sale);
  const afterClose = numberParam(req.query.after_close);
  const afterCount = numberParam(req.query.after_count);
  const afterPurchase = numberParam(req.query.after_purchase);
  const afterWithdrawal = numberParam(req.query.after_withdrawal);
  const afterCorrection = numberParam(req.query.after_correction);
  const afterCloseCorrection = numberParam(req.query.after_close_correction);
  const rawLimit = numberParam(req.query.limit, 500);
  const limit = Math.min(rawLimit || 500, 500);
  const since = typeof req.query.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.since)
    ? req.query.since : null;
  const db = getDb();
  const sales = await db.execute({
    sql: `SELECT id, user_id, client_sale_id, total, profit, payment_method, transfer_amount,
            foreign_currency, foreign_amount, exchange_rate, shop_rate, cash_received,
            created_at, register_id, account_id, account_email, cash_close_id
          FROM sales WHERE user_id = ? AND id > ?
            ${since ? 'AND created_at >= ?' : ''}
          ORDER BY id ASC LIMIT ?`,
    args: since ? [req.userId, afterSale, since, limit] : [req.userId, afterSale, limit],
  });
  const closes = await db.execute({
    sql: `SELECT * FROM cash_closes WHERE user_id = ? AND id > ?
            ${since ? 'AND closed_at >= ?' : ''}
          ORDER BY id ASC LIMIT ?`,
    args: since ? [req.userId, afterClose, since, limit] : [req.userId, afterClose, limit],
  });
  const counts = await db.execute({
    sql: `SELECT * FROM inventory_counts WHERE user_id = ? AND id > ?
            ${since ? 'AND counted_at >= ?' : ''}
          ORDER BY id ASC LIMIT ?`,
    args: since ? [req.userId, afterCount, since, limit] : [req.userId, afterCount, limit],
  });

  const purchases = await db.execute({
    sql: `SELECT * FROM currency_purchases WHERE user_id = ? AND id > ?
            ${since ? 'AND created_at >= ?' : ''}
          ORDER BY id ASC LIMIT ?`,
    args: since ? [req.userId, afterPurchase, since, limit] : [req.userId, afterPurchase, limit],
  });

  // Las extracciones nuevas avanzan por cursor. Las que siguen abiertas y ya
  // estaban antes del cursor se mandan aparte, como recordatorio: así una
  // anulación hecha en otro aparato llega a todos, pero no llenan la página
  // ni impiden que el cursor avance (antes se reenviaban en cada página).
  const withdrawals = await db.execute({
    sql: `SELECT * FROM cash_withdrawals WHERE user_id = ? AND id > ?
            ${since ? 'AND created_at >= ?' : ''}
          ORDER BY id ASC LIMIT ?`,
    args: since ? [req.userId, afterWithdrawal, since, limit] : [req.userId, afterWithdrawal, limit],
  });
  const openWithdrawals = await db.execute({
    sql: `SELECT * FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND id <= ?
          ORDER BY id DESC LIMIT 200`,
    args: [req.userId, afterWithdrawal],
  });
  const withdrawalRows = new Map();
  for (const row of withdrawals.rows) withdrawalRows.set(Number(row.id), row);
  for (const row of openWithdrawals.rows) {
    if (!withdrawalRows.has(Number(row.id))) withdrawalRows.set(Number(row.id), row);
  }
  const allWithdrawals = [...withdrawalRows.values()]
    .sort((a, b) => Number(a.id) - Number(b.id));

  // Correcciones de la cuenta principal (forma de pago cambiada o venta
  // anulada): la caja de escritorio ya bajó esas ventas y esos cierres, así que
  // tiene que enterarse de cómo quedaron. Va con la venta y el cierre actuales.
  const corrections = (await db.execute({
    sql: `SELECT id, action, sale_id, client_sale_id, cash_close_id, created_at
          FROM sale_corrections WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    args: [req.userId, afterCorrection, limit],
  })).rows;
  const byId = async (table, ids) => {
    const unique = [...new Set(ids.filter((id) => id != null).map(Number))];
    if (unique.length === 0) return new Map();
    const rows = (await db.execute({
      sql: `SELECT * FROM ${table} WHERE user_id = ? AND id IN (${unique.map(() => '?').join(',')})`,
      args: [req.userId, ...unique],
    })).rows;
    return new Map(rows.map((row) => [Number(row.id), row]));
  };
  const correctedSales = await byId('sales', corrections.map((c) => c.sale_id));
  const correctedCloses = await byId('cash_closes', corrections.map((c) => c.cash_close_id));
  const correctionRows = corrections.map((c) => ({
    ...c,
    sale: correctedSales.get(Number(c.sale_id)) || null,
    cash_close: c.cash_close_id != null ? correctedCloses.get(Number(c.cash_close_id)) || null : null,
  }));

  // Las correcciones manuales de cierres tienen cursor propio: las cajas que
  // ya superaron el cursor del cierre deben recibir igualmente la revisión.
  const closeCorrections = (await db.execute({
    sql: `SELECT id, cash_close_id, correction_revision, account_id, account_email,
                 before, after, created_at
            FROM cash_close_corrections WHERE user_id = ? AND id > ?
           ORDER BY id ASC LIMIT ?`,
    args: [req.userId, afterCloseCorrection, limit],
  })).rows;
  const correctedCloseIds = [...new Set(closeCorrections.map((row) => Number(row.cash_close_id)))];
  const manuallyCorrectedCloses = correctedCloseIds.length
    ? (await db.execute({
      sql: `SELECT * FROM cash_closes WHERE user_id = ? AND id IN (${correctedCloseIds.map(() => '?').join(',')})`,
      args: [req.userId, ...correctedCloseIds],
    })).rows
    : [];
  const correctedCloseById = new Map(manuallyCorrectedCloses.map((row) => [Number(row.id), row]));
  const closeCorrectionRows = closeCorrections.map((row) => ({
    ...row, cash_close: correctedCloseById.get(Number(row.cash_close_id)) || null,
  }));

  // Qué ventas, compras y extracciones cubrió cada cierre: así la caja de escritorio sabe
  // cuáles de las que ya bajó dejaron de estar abiertas.
  const closeIds = closes.rows.map((row) => Number(row.id));
  const covered = { sales: new Map(), purchases: new Map(), withdrawals: new Map() };
  if (closeIds.length > 0) {
    const marks = closeIds.map(() => '?').join(',');
    for (const [table, map] of [['sales', covered.sales], ['currency_purchases', covered.purchases], ['cash_withdrawals', covered.withdrawals]]) {
      const rows = (await db.execute({
        sql: `SELECT id, cash_close_id FROM ${table} WHERE user_id = ? AND cash_close_id IN (${marks})`,
        args: [req.userId, ...closeIds],
      })).rows;
      for (const r of rows) {
        const key = Number(r.cash_close_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(Number(r.id));
      }
    }
  }
  const closeRows = closes.rows.map((row) => ({
    ...row,
    covered_sale_ids: covered.sales.get(Number(row.id)) || [],
    covered_purchase_ids: covered.purchases.get(Number(row.id)) || [],
    covered_withdrawal_ids: covered.withdrawals.get(Number(row.id)) || [],
  }));

  const saleItems = await loadItems(db, 'sale_items', 'sale_id', sales.rows.map((row) => row.id));
  const countItems = await loadItems(db, 'inventory_count_items', 'count_id', counts.rows.map((row) => row.id));
  const saleRows = attachItems(sales.rows, saleItems, 'id', 'sale_id');
  const countRows = attachItems(counts.rows, countItems, 'id', 'count_id');
  const last = (rows, cursor) => rows.length ? Number(rows[rows.length - 1].id) : cursor;

  res.json({
    sales: saleRows,
    cash_closes: closeRows,
    inventory_counts: countRows,
    currency_purchases: purchases.rows,
    cash_withdrawals: allWithdrawals,
    sale_corrections: correctionRows,
    cash_close_corrections: closeCorrectionRows,
    cursors: {
      correction: last(corrections, afterCorrection),
      close_correction: last(closeCorrections, afterCloseCorrection),
      purchase: last(purchases.rows, afterPurchase),
      withdrawal: last(withdrawals.rows, afterWithdrawal),
      sale: last(sales.rows, afterSale),
      close: last(closes.rows, afterClose),
      count: last(counts.rows, afterCount),
    },
    has_more: sales.rows.length === limit || closes.rows.length === limit || counts.rows.length === limit
      || purchases.rows.length === limit || withdrawals.rows.length === limit
      || corrections.length === limit || closeCorrections.length === limit,
  });
}));

module.exports = router;
