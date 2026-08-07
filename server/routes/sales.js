const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');

const isUniqueViolation = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
};

const findByClientSaleId = (db, userId, clientSaleId) =>
  db.execute({
    sql: 'SELECT * FROM sales WHERE user_id = ? AND client_sale_id = ?',
    args: [userId, clientSaleId],
  });

router.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const { date } = req.query;
  const result = date
    ? await db.execute({
        sql: 'SELECT * FROM sales WHERE user_id = ? AND date(created_at) = ? ORDER BY created_at DESC',
        args: [req.userId, date],
      })
    : await db.execute({
        sql: 'SELECT * FROM sales WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
        args: [req.userId],
      });
  res.json(result.rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const saleResult = await db.execute({
    sql: 'SELECT * FROM sales WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.userId],
  });
  const sale = saleResult.rows[0];
  if (!sale) return res.status(404).json({ error: 'Venta no encontrada' });
  const itemsResult = await db.execute({
    sql: 'SELECT * FROM sale_items WHERE sale_id = ?',
    args: [req.params.id],
  });
  res.json({ ...sale, items: itemsResult.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { items, payment_method = 'efectivo', client_sale_id = null } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La venta debe tener al menos un producto' });
  }

  const db = getDb();

  // Idempotencia (camino rápido): si el POS reintenta una venta que sí llegó a
  // registrarse — porque se perdió la respuesta, no la petición — devolvemos la
  // venta original en vez de cobrar dos veces.
  if (client_sale_id) {
    const existing = await findByClientSaleId(db, req.userId, client_sale_id);
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
    }
  }

  const tx = await db.transaction('write');
  try {
    let total = 0;
    let profit = 0;
    const lines = [];

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        await tx.rollback();
        return res.status(400).json({ error: 'Cantidad inválida' });
      }
      const unitPrice = Number(item.unit_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        await tx.rollback();
        return res.status(400).json({ error: 'Precio inválido' });
      }

      // Lectura DENTRO de la transacción (antes se hacía fuera, lo que abría una
      // ventana entre la comprobación de stock y el descuento).
      const productResult = await tx.execute({
        sql: 'SELECT id, name, purchase_price FROM products WHERE id = ? AND user_id = ?',
        args: [item.product_id, req.userId],
      });
      const product = productResult.rows[0];
      if (!product) {
        await tx.rollback();
        return res.status(400).json({ error: 'Producto no existe' });
      }

      // Descuento condicional: el propio UPDATE comprueba el stock. Si otra venta
      // simultánea se adelantó, rowsAffected es 0 y abortamos — el stock nunca
      // puede quedar negativo por esta vía.
      const updated = await tx.execute({
        sql: 'UPDATE products SET stock = stock - ? WHERE id = ? AND user_id = ? AND stock >= ?',
        args: [quantity, item.product_id, req.userId, quantity],
      });
      if (updated.rowsAffected !== 1) {
        await tx.rollback();
        return res.status(409).json({ error: `Stock insuficiente para ${product.name}` });
      }

      total  += quantity * unitPrice;
      profit += quantity * (unitPrice - (product.purchase_price || 0));
      lines.push({
        product_id: product.id,
        product_name: product.name,
        quantity,
        unit_price: unitPrice,
        unit_cost: product.purchase_price || 0,
      });
    }

    const saleResult = await tx.execute({
      sql: 'INSERT INTO sales (user_id, client_sale_id, total, profit, payment_method) VALUES (?, ?, ?, ?, ?)',
      args: [req.userId, client_sale_id, total, profit, payment_method],
    });
    const saleId = Number(saleResult.lastInsertRowid);

    for (const line of lines) {
      await tx.execute({
        sql: 'INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
        args: [saleId, line.product_id, line.product_name, line.quantity, line.unit_price, line.unit_cost],
      });
    }

    await tx.commit();

    const finalResult = await db.execute({ sql: 'SELECT * FROM sales WHERE id = ?', args: [saleId] });
    return res.status(201).json(finalResult.rows[0]);
  } catch (err) {
    await tx.rollback().catch(() => { /* la transacción ya estaba cerrada */ });

    // Dos peticiones idénticas a la vez: ambas pasaron el camino rápido y una perdió
    // la carrera contra el índice UNIQUE. Devolvemos la que sí se registró.
    if (client_sale_id && isUniqueViolation(err)) {
      const existing = await findByClientSaleId(db, req.userId, client_sale_id);
      if (existing.rows[0]) {
        return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
      }
    }
    throw err;
  }
}));

module.exports = router;
