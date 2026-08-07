const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');

router.get('/', asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM products WHERE user_id = ? ORDER BY name ASC',
    args: [req.userId],
  });
  res.json(result.rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, purchase_price, sale_price, stock } = req.body;
  if (!name || sale_price === undefined) {
    return res.status(400).json({ error: 'Nombre y precio de venta son requeridos' });
  }
  if (stock !== undefined && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
    return res.status(400).json({ error: 'El stock debe ser un número entero mayor o igual a 0' });
  }
  const db = getDb();
  const insertResult = await db.execute({
    sql: 'INSERT INTO products (user_id, name, purchase_price, sale_price, stock) VALUES (?, ?, ?, ?, ?)',
    args: [req.userId, name, purchase_price || 0, sale_price, stock || 0],
  });
  const result = await db.execute({
    sql: 'SELECT * FROM products WHERE id = ?',
    args: [Number(insertResult.lastInsertRowid)],
  });
  res.status(201).json(result.rows[0]);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const existingResult = await db.execute({
    sql: 'SELECT * FROM products WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.userId],
  });
  const existing = existingResult.rows[0];
  if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });

  const { name, purchase_price, sale_price, stock } = req.body;
  if (stock !== undefined && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
    return res.status(400).json({ error: 'El stock debe ser un número entero mayor o igual a 0' });
  }
  await db.execute({
    sql: 'UPDATE products SET name = ?, purchase_price = ?, sale_price = ?, stock = ? WHERE id = ?',
    args: [
      name           ?? existing.name,
      purchase_price ?? existing.purchase_price,
      sale_price     ?? existing.sale_price,
      stock          ?? existing.stock,
      req.params.id,
    ],
  });
  const result = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
  res.json(result.rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'DELETE FROM products WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.userId],
  });
  if (result.rowsAffected === 0) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ success: true });
}));

module.exports = router;
