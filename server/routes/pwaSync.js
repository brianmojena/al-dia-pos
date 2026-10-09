const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { describeAccount } = require('../lib/account');
const { resolveRegisterId } = require('../lib/register');
const normalize = (name) => String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Una fotografía bajo la misma transacción: no mezclar stock anterior a una
// venta con historial posterior. Los cajeros no descargan totales ni auditoría.
router.get('/snapshot', asyncHandler(async (req, res) => {
  const tx = await getDb().transaction('read');
  try {
    const products = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? ORDER BY name', args: [req.userId] })).rows;
    const register = resolveRegisterId(req, 'web');
    const open = (await tx.execute({ sql: 'SELECT created_at FROM sales WHERE user_id = ? AND cash_close_id IS NULL AND (register_id = ? OR register_id IS NULL) ORDER BY created_at LIMIT 1', args: [req.userId, register] })).rows[0];
    const last = (await tx.execute({ sql: 'SELECT closed_at FROM cash_closes WHERE user_id = ? AND register_id = ? ORDER BY closed_at DESC LIMIT 1', args: [req.userId, register] })).rows[0];
    const snapshot = { products, current_period: { opened_at: last?.closed_at || open?.created_at || null, has_sales: !!open, is_first_close: !last } };
    if (req.role === 'dueño') {
      snapshot.sales = (await tx.execute({ sql: 'SELECT * FROM sales WHERE user_id = ? ORDER BY id', args: [req.userId] })).rows;
      const items = (await tx.execute({ sql: 'SELECT i.* FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.user_id = ? ORDER BY i.id', args: [req.userId] })).rows;
      const bySale = new Map();
      for (const item of items) { if (!bySale.has(item.sale_id)) bySale.set(item.sale_id, []); bySale.get(item.sale_id).push(item); }
      snapshot.sales = snapshot.sales.map((s) => ({ ...s, items: bySale.get(s.id) || [] }));
      snapshot.cash_closes = (await tx.execute({ sql: 'SELECT * FROM cash_closes WHERE user_id = ?', args: [req.userId] })).rows;
      const counts = (await tx.execute({ sql: 'SELECT * FROM inventory_counts WHERE user_id = ?', args: [req.userId] })).rows;
      const countItems = (await tx.execute({ sql: 'SELECT i.* FROM inventory_count_items i JOIN inventory_counts c ON c.id = i.count_id WHERE c.user_id = ?', args: [req.userId] })).rows;
      const byCount = new Map();
      for (const item of countItems) { if (!byCount.has(item.count_id)) byCount.set(item.count_id, []); byCount.get(item.count_id).push(item); }
      snapshot.inventory_counts = counts.map((c) => ({ ...c, items: byCount.get(c.id) || [] }));
      snapshot.rejected_sales = (await tx.execute({ sql: 'SELECT * FROM rejected_sales WHERE user_id = ? AND reviewed_at IS NULL', args: [req.userId] })).rows.map((s) => ({ ...s, items: JSON.parse(s.items || '[]') }));
      snapshot.cashiers = (await tx.execute({ sql: 'SELECT id, email, created_at FROM users WHERE owner_id = ? ORDER BY created_at', args: [req.userId] })).rows;
    }
    await tx.commit();
    res.json(snapshot);
  } catch (error) { await tx.rollback().catch(() => {}); throw error; }
}));

// Recibo y modificación en la MISMA transacción. Si se pierde la respuesta,
// el reintento devuelve el recibo, incluso si luego otra caja cambió el stock.
router.post('/product-operation', asyncHandler(async (req, res) => {
  const { operation_id, method, product_id, product = {}, expected } = req.body;
  if (typeof operation_id !== 'string' || !operation_id || operation_id.length > 100 || !['POST', 'PUT', 'DELETE'].includes(method)) return res.status(400).json({ error: 'Operación de producto inválida' });
  if (method !== 'POST' && req.role !== 'dueño') return res.status(403).json({ error: 'Solo el dueño puede editar o borrar productos' });
  const db = getDb(), account = await describeAccount(db, req);
  const tx = await db.transaction('write');
  try {
    const receipt = (await tx.execute({ sql: 'SELECT response FROM pwa_product_operations WHERE user_id = ? AND account_id = ? AND operation_id = ?', args: [req.userId, req.accountId, operation_id] })).rows[0];
    if (receipt) { await tx.commit(); return res.json(JSON.parse(receipt.response)); }
    if (method !== 'POST' && expected) {
      const previous = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? AND id = ?', args: [req.userId, product_id] })).rows[0];
      if (previous && ['name', 'sale_price', 'purchase_price', 'stock'].some((key) => previous[key] !== expected[key])) {
        await tx.rollback();
        return res.status(409).json({ error: 'El producto cambió en otra caja. Los cambios locales están guardados y necesitan revisión antes de subir.' });
      }
    }
    let result;
    if (method === 'DELETE') {
      await tx.execute({ sql: 'DELETE FROM products WHERE user_id = ? AND id = ?', args: [req.userId, product_id] });
      result = { success: true };
    } else {
      const name = typeof product.name === 'string' ? product.name.trim().replace(/\s+/g, ' ') : '';
      const sale = Number(product.sale_price), purchase = Number(product.purchase_price ?? 0), stock = Number(product.stock ?? 0);
      if (!name || product.sale_price == null || !Number.isFinite(sale) || sale < 0 || !Number.isFinite(purchase) || purchase < 0 || !Number.isInteger(stock) || stock < 0) { await tx.rollback(); return res.status(400).json({ error: 'Nombre, precios o stock inválidos' }); }
      let id = product_id;
      if (method === 'POST') {
        const existing = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ?', args: [req.userId] })).rows.find((p) => normalize(p.name) === normalize(name));
        if (existing) result = { ...existing, merged: true };
        else {
          const insert = await tx.execute({ sql: 'INSERT INTO products (user_id, name, purchase_price, sale_price, stock, created_by_account_id, created_by_email) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [req.userId, name, purchase, sale, stock, account.id, account.email] });
          id = Number(insert.lastInsertRowid);
        }
      } else {
        const updated = await tx.execute({ sql: 'UPDATE products SET name = ?, purchase_price = ?, sale_price = ?, stock = ? WHERE user_id = ? AND id = ?', args: [name, purchase, sale, stock, req.userId, id] });
        if (!updated.rowsAffected) { await tx.rollback(); return res.status(404).json({ error: 'Producto no encontrado' }); }
      }
      if (!result) result = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? AND id = ?', args: [req.userId, id] })).rows[0];
    }
    await tx.execute({ sql: 'INSERT INTO pwa_product_operations (user_id, account_id, operation_id, response) VALUES (?, ?, ?, ?)', args: [req.userId, req.accountId, operation_id, JSON.stringify(result)] });
    await tx.commit();
    res.json(result);
  } catch (error) { await tx.rollback().catch(() => {}); throw error; }
}));
module.exports = router;
