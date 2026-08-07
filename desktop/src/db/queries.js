const crypto = require('crypto');
const { getLocalDb } = require('./localDb');

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

function getSession() {
  const db = getLocalDb();
  return db.prepare('SELECT * FROM session WHERE id = 1').get() || null;
}

function setSession({ user_id, email, store_name, plan, token }) {
  const db = getLocalDb();
  db.prepare(`
    INSERT INTO session (id, user_id, email, store_name, plan, token, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id, email = excluded.email, store_name = excluded.store_name,
      plan = excluded.plan, token = excluded.token, updated_at = datetime('now')
  `).run(user_id, email, store_name, plan, token);
}

function clearSession() {
  getLocalDb().prepare('DELETE FROM session WHERE id = 1').run();
}

// ---------------------------------------------------------------------------
// Outbox — helpers compartidos por queries.js (encolar) y syncWorker.js (leer)
// ---------------------------------------------------------------------------

function enqueueOutbox(db, { op_type, client_op_id, local_ref_id, payload }) {
  db.prepare(`
    INSERT INTO outbox (op_type, client_op_id, local_ref_id, payload)
    VALUES (?, ?, ?, ?)
  `).run(op_type, client_op_id, local_ref_id, JSON.stringify(payload));
}

function getPendingOutbox(limit = 50) {
  return getLocalDb()
    .prepare(`SELECT * FROM outbox WHERE status IN ('pending', 'conflict') ORDER BY id ASC LIMIT ?`)
    .all(limit);
}

function countPendingOutbox() {
  const row = getLocalDb()
    .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status IN ('pending', 'syncing', 'conflict')`)
    .get();
  return row.c;
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

function listProducts() {
  return getLocalDb()
    .prepare('SELECT * FROM products WHERE deleted = 0 ORDER BY name ASC')
    .all();
}

function createProduct({ name, purchase_price = 0, sale_price, stock = 0 }) {
  const db = getLocalDb();
  const clientOpId = crypto.randomUUID();

  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO products (name, purchase_price, sale_price, stock) VALUES (?, ?, ?, ?)
    `).run(name, purchase_price, sale_price, stock);
    const localId = result.lastInsertRowid;

    enqueueOutbox(db, {
      op_type: 'product.create',
      client_op_id: clientOpId,
      local_ref_id: localId,
      payload: { local_product_id: localId, name, purchase_price, sale_price, stock },
    });

    return db.prepare('SELECT * FROM products WHERE id = ?').get(localId);
  });

  return insert();
}

function updateProduct(id, { name, purchase_price, sale_price, stock }) {
  const db = getLocalDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(id);
  if (!existing) return null;
  if (stock !== undefined && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
    throw new Error('El stock debe ser un número entero mayor o igual a 0');
  }

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE products SET name = ?, purchase_price = ?, sale_price = ?, stock = ? WHERE id = ?
    `).run(
      name ?? existing.name,
      purchase_price ?? existing.purchase_price,
      sale_price ?? existing.sale_price,
      stock ?? existing.stock,
      id
    );

    enqueueOutbox(db, {
      op_type: 'product.update',
      client_op_id: crypto.randomUUID(),
      local_ref_id: id,
      payload: {
        local_product_id: id,
        name: name ?? existing.name,
        purchase_price: purchase_price ?? existing.purchase_price,
        sale_price: sale_price ?? existing.sale_price,
        stock: stock ?? existing.stock,
      },
    });

    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  });

  return update();
}

function deleteProduct(id) {
  const db = getLocalDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(id);
  if (!existing) return false;

  const del = db.transaction(() => {
    // Soft delete: mantenemos la fila para que sale_items conserve su referencia
    // y para poder resolver server_id cuando el outbox de borrado se sincronice.
    db.prepare('UPDATE products SET deleted = 1 WHERE id = ?').run(id);
    enqueueOutbox(db, {
      op_type: 'product.delete',
      client_op_id: crypto.randomUUID(),
      local_ref_id: id,
      payload: { local_product_id: id },
    });
  });

  del();
  return true;
}

// ---------------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------------

/**
 * Crea una venta 100% local, sin red. Espeja la lógica de server/routes/sales.js:
 * valida stock con un UPDATE condicional (misma defensa que la carrera que
 * arreglamos en el servidor) y todo ocurre en una sola transacción con el
 * encolado del outbox — o se guarda todo, o no se guarda nada.
 */
function createSaleLocal({ items, payment_method = 'efectivo' }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('La venta debe tener al menos un producto'), { code: 'EMPTY_SALE' });
  }

  const db = getLocalDb();
  const clientSaleId = crypto.randomUUID();

  const create = db.transaction(() => {
    let total = 0;
    let profit = 0;
    const lines = [];

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw Object.assign(new Error('Cantidad inválida'), { code: 'BAD_QUANTITY' });
      }
      const unitPrice = Number(item.unit_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw Object.assign(new Error('Precio inválido'), { code: 'BAD_PRICE' });
      }

      const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(item.product_id);
      if (!product) {
        throw Object.assign(new Error('Producto no existe'), { code: 'NO_PRODUCT' });
      }

      const updated = db.prepare(
        'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?'
      ).run(quantity, item.product_id, quantity);
      if (updated.changes !== 1) {
        throw Object.assign(
          new Error(`Stock insuficiente para ${product.name}`),
          { code: 'NO_STOCK', product: product.name }
        );
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

    const saleResult = db.prepare(`
      INSERT INTO sales (client_sale_id, total, profit, payment_method) VALUES (?, ?, ?, ?)
    `).run(clientSaleId, total, profit, payment_method);
    const saleId = saleResult.lastInsertRowid;

    for (const line of lines) {
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(saleId, line.product_id, line.product_name, line.quantity, line.unit_price, line.unit_cost);
    }

    enqueueOutbox(db, {
      op_type: 'sale.create',
      client_op_id: clientSaleId,   // mismo id: es EL identificador de idempotencia de esta venta
      local_ref_id: saleId,
      payload: {
        client_sale_id: clientSaleId,
        payment_method,
        items: lines.map(l => ({
          local_product_id: l.product_id,
          quantity: l.quantity,
          unit_price: l.unit_price,
        })),
      },
    });

    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  });

  return create();
}

function listSales({ date } = {}) {
  const db = getLocalDb();
  return date
    ? db.prepare(`SELECT * FROM sales WHERE date(created_at) = ? ORDER BY created_at DESC`).all(date)
    : db.prepare(`SELECT * FROM sales ORDER BY created_at DESC LIMIT 200`).all();
}

function getSale(id) {
  const db = getLocalDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) return null;
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);
  return { ...sale, items };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function getDashboard() {
  const db = getLocalDb();
  const today = new Date().toISOString().split('T')[0];

  const todayStats = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS sales, COALESCE(SUM(profit),0) AS profit, COUNT(*) AS count
    FROM sales WHERE date(created_at) = ?
  `).get(today);

  const lowStock = db.prepare(`
    SELECT * FROM products WHERE deleted = 0 AND stock <= 5 ORDER BY stock ASC
  `).all();

  const recentSales = db.prepare(`
    SELECT * FROM sales WHERE date(created_at) = ? ORDER BY created_at DESC LIMIT 5
  `).all(today);

  return { today: todayStats, lowStock, recentSales };
}

module.exports = {
  getSession, setSession, clearSession,
  getPendingOutbox, countPendingOutbox, enqueueOutbox,
  listProducts, createProduct, updateProduct, deleteProduct,
  createSaleLocal, listSales, getSale,
  getDashboard,
};
