const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { describeAccount } = require('../lib/account');
const { logStockChange } = require('../lib/stockLog');
const { resolveRegisterId } = require('../lib/register');
const { withdrawalScopeSql } = require('../lib/withdrawalScope');
const { parseUnit, validQuantity, trackStockFor, roundQty, parsePack } = require('../lib/units');
const { dailyStock } = require('../lib/dailyStock');
const { syncChanges, isPaginated } = require('../lib/syncChanges');
const normalize = (name) => String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Una fotografía bajo la misma transacción: no mezclar stock anterior a una
// venta con historial posterior. Los cajeros no descargan reportes agregados ni auditoría.
router.get('/snapshot', asyncHandler(async (req, res) => {
  const tx = await getDb().transaction('read');
  try {
    if (isPaginated(req.query)) {
      const page = await syncChanges(tx, req);
      await tx.commit();
      return res.json(page);
    }
    if (req.sharedDevice && req.role !== 'dueño') {
      const snapshot = await require('../lib/sharedSnapshot').sharedSnapshot(tx, req);
      await tx.commit();
      return res.json(snapshot);
    }
    const products = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? ORDER BY name', args: [req.userId] })).rows;
    const register = resolveRegisterId(req, 'web');
    const cashierScope = req.role === 'cajero'
      ? ' AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))'
      : '';
    const scopeArgs = req.role === 'cajero' ? [req.accountId, req.accountId] : [];
    const isOwner = req.role === 'dueño';
    const open = (await tx.execute({ sql: `SELECT created_at FROM sales WHERE user_id = ? AND cash_close_id IS NULL${isOwner ? '' : ' AND (register_id = ? OR register_id IS NULL)'}${cashierScope} ORDER BY created_at LIMIT 1`, args: isOwner ? [req.userId] : [req.userId, register, ...scopeArgs] })).rows[0];
    const openPurchase = (await tx.execute({ sql: `SELECT created_at FROM currency_purchases WHERE user_id = ? AND cash_close_id IS NULL${isOwner ? '' : ' AND (register_id = ? OR register_id IS NULL)'}${cashierScope} ORDER BY created_at LIMIT 1`, args: isOwner ? [req.userId] : [req.userId, register, ...scopeArgs] })).rows[0];
    const withdrawalAccess = withdrawalScopeSql({ isOwner, registerId: register, accountId: req.accountId, includeLegacy: !req.sharedDevice });
    const withdrawalScope = isOwner ? '' : ` AND ${withdrawalAccess.sql}`;
    const withdrawalArgs = isOwner ? [] : withdrawalAccess.args;
    const openWithdrawal = (await tx.execute({
      sql: `SELECT created_at FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL${withdrawalScope} ORDER BY created_at LIMIT 1`,
      args: [req.userId, ...withdrawalArgs],
    })).rows[0];
    const last = (await tx.execute({ sql: `SELECT closed_at FROM cash_closes WHERE user_id = ?${isOwner ? '' : ' AND register_id = ?'} ORDER BY closed_at DESC LIMIT 1`, args: isOwner ? [req.userId] : [req.userId, register] })).rows[0];
    const snapshot = { products, cash_close_coverage_version: 1, current_period: { opened_at: last?.closed_at || open?.created_at || openPurchase?.created_at || openWithdrawal?.created_at || null, has_sales: !!(open || openPurchase || openWithdrawal), is_first_close: !last } };
    if (req.role === 'dueño') {
      if (req.sharedDevice) snapshot.shared_device = req.sharedDevice;
      snapshot.daily_stock = await dailyStock(tx, req.userId);
      snapshot.sales = (await tx.execute({ sql: 'SELECT * FROM sales WHERE user_id = ? ORDER BY id', args: [req.userId] })).rows;
      const items = (await tx.execute({ sql: 'SELECT i.* FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.user_id = ? ORDER BY i.id', args: [req.userId] })).rows;
      const bySale = new Map();
      for (const item of items) { if (!bySale.has(item.sale_id)) bySale.set(item.sale_id, []); bySale.get(item.sale_id).push(item); }
      snapshot.sales = snapshot.sales.map((s) => ({ ...s, items: bySale.get(s.id) || [] }));
      snapshot.currency_purchases = (await tx.execute({ sql: 'SELECT * FROM currency_purchases WHERE user_id = ? ORDER BY id', args: [req.userId] })).rows;
      snapshot.cash_withdrawals = (await tx.execute({ sql: 'SELECT * FROM cash_withdrawals WHERE user_id = ? ORDER BY id', args: [req.userId] })).rows;
      snapshot.cash_closes = (await tx.execute({ sql: 'SELECT * FROM cash_closes WHERE user_id = ?', args: [req.userId] })).rows;
      const counts = (await tx.execute({ sql: 'SELECT * FROM inventory_counts WHERE user_id = ?', args: [req.userId] })).rows;
      const countItems = (await tx.execute({ sql: 'SELECT i.* FROM inventory_count_items i JOIN inventory_counts c ON c.id = i.count_id WHERE c.user_id = ?', args: [req.userId] })).rows;
      const byCount = new Map();
      for (const item of countItems) { if (!byCount.has(item.count_id)) byCount.set(item.count_id, []); byCount.get(item.count_id).push(item); }
      snapshot.inventory_counts = counts.map((c) => ({ ...c, items: byCount.get(c.id) || [] }));
      snapshot.rejected_sales = (await tx.execute({ sql: 'SELECT * FROM rejected_sales WHERE user_id = ? AND reviewed_at IS NULL', args: [req.userId] })).rows.map((s) => ({ ...s, items: JSON.parse(s.items || '[]') }));
      snapshot.cashiers = (await tx.execute({ sql: 'SELECT id, email, created_at FROM users WHERE owner_id = ? ORDER BY created_at', args: [req.userId] })).rows;
    } else {
      snapshot.cash_closes = (await tx.execute({
        sql: `SELECT id, client_close_id, opened_at, closed_at, opening_float,
                     expected_cash, counted_cash, difference, expected_transfer,
                     sales_count, note, register_id, account_id, account_email,
                     expected_usd, counted_usd, difference_usd, expected_eur,
                     counted_eur, difference_eur, withdrawn_cash, withdrawn_transfer,
                     withdrawn_usd, withdrawn_eur, correction_revision
              FROM cash_closes WHERE user_id = ?
                AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))
              ORDER BY closed_at DESC`,
        args: [req.userId, req.accountId, req.accountId],
      })).rows;
      // Ventas propias abiertas y cerradas: hacen falta para su historial y
      // para calcular el cierre offline con la misma cobertura del servidor.
      // La proyección excluye ganancia y cualquier dato de costo.
      snapshot.sales = (await tx.execute({
        sql: `SELECT id, client_sale_id, total, payment_method, transfer_amount,
                     foreign_currency, foreign_amount, exchange_rate, shop_rate, cash_received,
                     created_at, register_id, account_id, account_email, cash_close_id
              FROM sales WHERE user_id = ?
                AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))
              ORDER BY created_at DESC, id DESC`,
        args: [req.userId, req.accountId, req.accountId],
      })).rows;
      // Las compras y extracciones del cajero se limitan a su caja y a su
      // cuenta legacy cuando la fila no tiene register_id.
      snapshot.currency_purchases = (await tx.execute({
        sql: `SELECT id, client_purchase_id, foreign_currency, foreign_amount,
                     exchange_rate, cup_amount, created_at, register_id,
                     account_id, account_email, cash_close_id
              FROM currency_purchases WHERE user_id = ? AND cash_close_id IS NULL
                AND (register_id = ? OR register_id IS NULL)${cashierScope} ORDER BY created_at DESC`,
        args: [req.userId, register, ...scopeArgs],
      })).rows;
      snapshot.purchase_states = (await tx.execute({
        sql: `SELECT id, cash_close_id, CASE WHEN cash_close_id IS NULL THEN 0 ELSE 1 END AS closed
              FROM currency_purchases WHERE user_id = ? AND (register_id = ? OR register_id IS NULL)${cashierScope}
              ORDER BY id`,
        args: [req.userId, register, ...scopeArgs],
      })).rows;
      snapshot.cash_withdrawals = (await tx.execute({
        sql: `SELECT id, client_withdrawal_id, method, amount, register_id, account_id, account_email,
                     created_at, cash_close_id, voided_at
              FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL${withdrawalScope}
              ORDER BY created_at DESC`,
        args: [req.userId, ...withdrawalArgs],
      })).rows;
      snapshot.withdrawal_states = (await tx.execute({
        sql: `SELECT id, cash_close_id, voided_at,
                     CASE WHEN cash_close_id IS NULL THEN 0 ELSE 1 END AS closed,
                     CASE WHEN voided_at IS NULL THEN 0 ELSE 1 END AS voided
              FROM cash_withdrawals WHERE user_id = ?${withdrawalScope} ORDER BY id`,
        args: [req.userId, ...withdrawalArgs],
      })).rows;
      const ids = snapshot.sales.map((sale) => Number(sale.id));
      if (ids.length) {
        const marks = ids.map(() => '?').join(',');
        const items = (await tx.execute({
          sql: `SELECT i.id, i.sale_id, i.product_id, i.product_name, i.quantity,
                      i.unit_price, i.pack_size, p.unit
                FROM sale_items i LEFT JOIN products p ON p.id = i.product_id
                WHERE i.sale_id IN (${marks}) ORDER BY i.id`,
          args: ids,
        })).rows;
        const bySale = new Map();
        for (const item of items) {
          if (!bySale.has(Number(item.sale_id))) bySale.set(Number(item.sale_id), []);
          bySale.get(Number(item.sale_id)).push(item);
        }
        snapshot.sales = snapshot.sales.map((sale) => ({ ...sale, items: bySale.get(Number(sale.id)) || [] }));
      } else {
        snapshot.sales = [];
      }
    }
    await tx.commit();
    res.json(snapshot);
  } catch (error) { await tx.rollback().catch(() => {}); throw error; }
}));

// Suma mercancía recibida dentro de la transacción y la anota en stock_entries
// (quién, cuánto, antes y después), igual que PUT /api/products/:id.
async function addStock(tx, req, account, productId, quantity) {
  const target = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? AND id = ?', args: [req.userId, productId] })).rows[0];
  if (!target) return { status: 404, error: 'Producto no encontrado' };
  if (target.unit && Number(target.track_stock) !== 1) return { status: 400, error: 'Este producto no lleva control de stock' };
  if (!validQuantity(quantity, target.unit || null, target.unit ? 0.001 : 1)) {
    return { status: 400, error: target.unit ? 'La cantidad a añadir admite hasta 3 decimales' : 'La cantidad a añadir debe ser un número entero' };
  }
  const before = Number(target.stock);
  const after = roundQty(before + quantity);
  await tx.execute({ sql: 'UPDATE products SET stock = ROUND(stock + ?, 3) WHERE user_id = ? AND id = ?', args: [quantity, req.userId, productId] });
  await tx.execute({
    sql: 'INSERT INTO stock_entries (user_id, product_id, product_name, quantity, stock_before, stock_after, account_id, account_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [req.userId, productId, target.name, quantity, before, after, account.id, account.email],
  });
  return null;
}

// Recibo y modificación en la MISMA transacción. Si se pierde la respuesta,
// el reintento devuelve el recibo, incluso si luego otra caja cambió el stock.
router.post('/product-operation', asyncHandler(async (req, res) => {
  const { operation_id, method, product_id, product = {}, expected } = req.body;
  if (typeof operation_id !== 'string' || !operation_id || operation_id.length > 100 || !['POST', 'PUT', 'DELETE'].includes(method)) return res.status(400).json({ error: 'Operación de producto inválida' });
  const priceOnly = method === 'PUT' && req.role !== 'dueño';
  if (req.role !== 'dueño' && (method === 'DELETE' || (priceOnly && Object.keys(product).some((key) => key !== 'sale_price' && key !== 'add_stock')))) {
    return res.status(403).json({ error: 'El cajero solo puede cambiar el precio de venta y añadir stock' });
  }
  // Mercancía recibida: llega como CANTIDAD a sumar, no como stock final, para
  // que las ventas hechas en otras cajas mientras tanto no se pisen (igual que
  // PUT /api/products/:id).
  const hasAdd = product.add_stock !== undefined && product.add_stock !== null && product.add_stock !== '';
  const addQty = hasAdd ? Number(product.add_stock) : 0;
  if (hasAdd && (method !== 'PUT' || !Number.isFinite(addQty) || addQty <= 0)) {
    return res.status(400).json({ error: 'La cantidad a añadir debe ser mayor que 0' });
  }
  const hasPrice = product.sale_price !== undefined && product.sale_price !== null && product.sale_price !== '';
  if (priceOnly && ((hasPrice && (!Number.isFinite(Number(product.sale_price)) || Number(product.sale_price) < 0)) || (!hasPrice && !hasAdd))) {
    return res.status(400).json({ error: 'El precio de venta no es válido' });
  }
  const db = getDb(), account = await describeAccount(db, req);
  const tx = await db.transaction('write');
  try {
    const receipt = (await tx.execute({ sql: 'SELECT response FROM pwa_product_operations WHERE user_id = ? AND account_id = ? AND operation_id = ?', args: [req.userId, req.accountId, operation_id] })).rows[0];
    if (receipt) { await tx.commit(); return res.json(JSON.parse(receipt.response)); }
    if (method !== 'POST' && expected) {
      const previous = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? AND id = ?', args: [req.userId, product_id] })).rows[0];
      // Con add_stock el stock no se compara: lo que cambió allá son ventas y se suma encima.
      const compared = priceOnly ? (hasPrice ? ['sale_price'] : []) : ['name', 'sale_price', 'purchase_price', ...(hasAdd ? [] : ['stock']), 'unit'];
      if (previous && compared.some((key) => (previous[key] ?? null) !== (expected[key] ?? null))) {
        await tx.rollback();
        return res.status(409).json({ error: 'El producto cambió en otra caja. Los cambios locales están guardados y necesitan revisión antes de subir.' });
      }
    }
    let result;
    if (method === 'DELETE') {
      await tx.execute({ sql: 'DELETE FROM products WHERE user_id = ? AND id = ?', args: [req.userId, product_id] });
      result = { success: true };
    } else if (priceOnly) {
      const found = (await tx.execute({ sql: 'SELECT id FROM products WHERE user_id = ? AND id = ?', args: [req.userId, product_id] })).rows[0];
      if (!found) { await tx.rollback(); return res.status(404).json({ error: 'Producto no encontrado' }); }
      if (hasPrice) await tx.execute({ sql: 'UPDATE products SET sale_price = ? WHERE user_id = ? AND id = ?', args: [Number(product.sale_price), req.userId, product_id] });
      if (hasAdd) {
        const failure = await addStock(tx, req, account, product_id, addQty);
        if (failure) { await tx.rollback(); return res.status(failure.status).json({ error: failure.error }); }
      }
      result = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? AND id = ?', args: [req.userId, product_id] })).rows[0];
    } else {
      const name = typeof product.name === 'string' ? product.name.trim().replace(/\s+/g, ' ') : '';
      const current = hasAdd ? (await tx.execute({ sql: 'SELECT stock FROM products WHERE user_id = ? AND id = ?', args: [req.userId, product_id] })).rows[0] : null;
      const sale = Number(product.sale_price), purchase = Number(product.purchase_price ?? 0), stock = hasAdd ? Number(current?.stock ?? 0) : Number(product.stock ?? 0);
      const unit = parseUnit(product.unit) ?? null;
      const prior = method === 'PUT' ? (await tx.execute({ sql: 'SELECT track_stock, pack_size, pack_price FROM products WHERE user_id = ? AND id = ?', args: [req.userId, product_id] })).rows[0] : null;
      const trackStock = trackStockFor(unit, product.track_stock, method === 'PUT' ? Number(prior?.track_stock ?? 1) : 0);
      if (!name || product.sale_price == null || !Number.isFinite(sale) || sale < 0 || !Number.isFinite(purchase) || purchase < 0 || unit === false || !validQuantity(trackStock ? stock : 0, unit)) { await tx.rollback(); return res.status(400).json({ error: 'Nombre, precios o stock inválidos' }); }
      // Paquete: si la operación no lo trae (una app antigua) se conserva el que había.
      const pack = parsePack(product, unit) ?? (unit || !prior ? { pack_size: null, pack_price: null } : { pack_size: prior.pack_size ?? null, pack_price: prior.pack_price ?? null });
      if (pack.error) { await tx.rollback(); return res.status(400).json({ error: pack.error }); }
      let id = product_id;
      if (method === 'POST') {
        const existing = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ?', args: [req.userId] })).rows.find((p) => normalize(p.name) === normalize(name));
        if (existing) result = { ...existing, merged: true };
        else {
          const insert = await tx.execute({ sql: 'INSERT INTO products (user_id, name, purchase_price, sale_price, stock, unit, track_stock, pack_size, pack_price, created_by_account_id, created_by_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [req.userId, name, purchase, sale, trackStock ? stock : 0, unit, trackStock, pack.pack_size, pack.pack_price, account.id, account.email] });
          id = Number(insert.lastInsertRowid);
          // Log stock entry for new product with initial stock
          if (trackStock && stock > 0) {
            await logStockChange(tx, { userId: req.userId, product: { id, name }, before: 0, after: stock, account, kind: 'nuevo' });
          }
        }
      } else {
        const before = hasAdd ? null : (await tx.execute({ sql: 'SELECT stock, track_stock FROM products WHERE user_id = ? AND id = ?', args: [req.userId, id] })).rows[0];
        const updated = await tx.execute({ sql: 'UPDATE products SET name = ?, purchase_price = ?, sale_price = ?, stock = ?, unit = ?, track_stock = ?, pack_size = ?, pack_price = ? WHERE user_id = ? AND id = ?', args: [name, purchase, sale, trackStock ? stock : 0, unit, trackStock, pack.pack_size, pack.pack_price, req.userId, id] });
        if (!updated.rowsAffected) { await tx.rollback(); return res.status(404).json({ error: 'Producto no encontrado' }); }
        // Stock puesto a mano por la cuenta principal: queda anotado (ver lib/stockLog.js).
        if (before && trackStock && Number(before.track_stock ?? 1) === 1) {
          await logStockChange(tx, { userId: req.userId, product: { id, name }, before: before.stock, after: stock, account, kind: 'correccion', reason: product.stock_reason });
        }
        if (hasAdd) {
          const failure = await addStock(tx, req, account, id, addQty);
          if (failure) { await tx.rollback(); return res.status(failure.status).json({ error: failure.error }); }
        }
      }
      if (!result) result = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? AND id = ?', args: [req.userId, id] })).rows[0];
    }
    await tx.execute({ sql: 'INSERT INTO pwa_product_operations (user_id, account_id, operation_id, response) VALUES (?, ?, ?, ?)', args: [req.userId, req.accountId, operation_id, JSON.stringify(result)] });
    await tx.commit();
    res.json(result);
  } catch (error) { await tx.rollback().catch(() => {}); throw error; }
}));
module.exports = router;
