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
  const rawLimit = numberParam(req.query.limit, 500);
  const limit = Math.min(rawLimit || 500, 500);
  const since = typeof req.query.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.since)
    ? req.query.since : null;
  const db = getDb();
  const sales = await db.execute({
    sql: `SELECT id, user_id, client_sale_id, total, profit, payment_method,
            created_at, register_id, account_id, account_email
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

  const saleItems = await loadItems(db, 'sale_items', 'sale_id', sales.rows.map((row) => row.id));
  const countItems = await loadItems(db, 'inventory_count_items', 'count_id', counts.rows.map((row) => row.id));
  const saleRows = attachItems(sales.rows, saleItems, 'id', 'sale_id');
  const countRows = attachItems(counts.rows, countItems, 'id', 'count_id');
  const last = (rows, cursor) => rows.length ? Number(rows[rows.length - 1].id) : cursor;

  res.json({
    sales: saleRows,
    cash_closes: closes.rows,
    inventory_counts: countRows,
    cursors: {
      sale: last(sales.rows, afterSale),
      close: last(closes.rows, afterClose),
      count: last(counts.rows, afterCount),
    },
    has_more: sales.rows.length === limit || closes.rows.length === limit || counts.rows.length === limit,
  });
}));

module.exports = router;
