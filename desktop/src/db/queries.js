const crypto = require('crypto');
const { getLocalDb } = require('./localDb');
const { todayBounds, boundsForDate } = require('../lib/businessDay');
const { PAYMENT_METHODS, paymentSplit, foreignFields, round2, purchaseSplit, purchaseFields, WITHDRAWAL_METHODS, withdrawalSplit, withdrawalFields } = require('../lib/payment');

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

function getSession() {
  const db = getLocalDb();
  return db.prepare('SELECT * FROM session WHERE id = 1').get() || null;
}

function setSession({
  user_id, email, store_name, plan, token,
  transfer_limit = null, usd_rate = null, eur_rate = null, role = null, warehouse_enabled = null,
}) {
  const db = getLocalDb();
  db.prepare(`
    INSERT INTO session (id, user_id, email, store_name, plan, token, transfer_limit, usd_rate, eur_rate, role, warehouse_enabled, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id, email = excluded.email, store_name = excluded.store_name,
      plan = excluded.plan, token = excluded.token,
      transfer_limit = excluded.transfer_limit, usd_rate = excluded.usd_rate,
      eur_rate = excluded.eur_rate, role = excluded.role,
      warehouse_enabled = excluded.warehouse_enabled,
      updated_at = datetime(\'now\')
  `).run(user_id, email, store_name, plan, token, transfer_limit, usd_rate, eur_rate, role, toFlag(warehouse_enabled));
}

// true/false del servidor → 1/0; sin dato → NULL (se muestra el almacén).
const toFlag = (value) => (value == null ? null : value ? 1 : 0);

/**
 * Actualiza SOLO transfer_limit y las tasas de la sesión ya guardada, sin tocar
 * el resto — la usa el sync worker para reflejar en la caja lo que el dueño
 * cambió desde su teléfono, sin tener que volver a loguearse. No crea sesión
 * si no hay una activa: no tendría a quién actualizar.
 */
function updateSessionSettings({ transfer_limit = null, usd_rate = null, eur_rate = null, warehouse_enabled = null }) {
  const db = getLocalDb();
  db.prepare(`
    UPDATE session SET transfer_limit = ?, usd_rate = ?, eur_rate = ?, warehouse_enabled = ?, updated_at = datetime(\'now\') WHERE id = 1
  `).run(transfer_limit, usd_rate, eur_rate, toFlag(warehouse_enabled));
}

function clearSession() {
  getLocalDb().prepare('DELETE FROM session WHERE id = 1').run();
}

function getSyncState(key) {
  return getLocalDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
}

function setSyncState(key, value) {
  getLocalDb().prepare(`
    INSERT INTO sync_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value == null ? null : String(value));
}

function getRegisterId() {
  return getSyncState('register_id');
}

function prepareDeltaSession(userId) {
  const db = getLocalDb();
  const current = getSyncState('delta_user_id');
  if (current !== String(userId)) {
    const reset = db.transaction(() => {
      setSyncState('delta_user_id', userId);
      setSyncState('delta_after_sale', 0);
      setSyncState('delta_after_purchase', 0);
      setSyncState('delta_after_withdrawal', 0);
      setSyncState('delta_after_close', 0);
      setSyncState('delta_after_count', 0);
      setSyncState('delta_after_correction', 0);
      setSyncState('delta_after_close_correction', 0);
    });
    reset();
  }
  return {
    sale: Number(getSyncState('delta_after_sale') || 0),
    purchase: Number(getSyncState('delta_after_purchase') || 0),
    withdrawal: Number(getSyncState('delta_after_withdrawal') || 0),
    close: Number(getSyncState('delta_after_close') || 0),
    count: Number(getSyncState('delta_after_count') || 0),
    correction: Number(getSyncState('delta_after_correction') || 0),
    close_correction: Number(getSyncState('delta_after_close_correction') || 0),
  };
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

function applyServerDayStock(dayStock) {
  const { validDayStock } = require('../lib/dailyStock');
  if (!validDayStock(dayStock)) throw new Error('Resumen diario de stock inválido');
  setSyncState('daily_stock_snapshot', JSON.stringify(dayStock));
  // El resumen ya incluye toda entrada que esta caja subió y el servidor
  // confirmó, así que esas operaciones quedan cubiertas y dejan de sumarse
  // encima. Se marca solo lo 'synced': lo pendiente o en vuelo todavía no
  // está en este resumen (el ACK va antes del GET, pero si el GET falla la
  // operación ya sincronizada se conserva porque no quedó cubierta).
  getLocalDb().prepare("UPDATE outbox SET covered_by_snapshot = 1 WHERE status = 'synced'").run();
}

/**
 * Entradas de mercancía de ESTA caja que todavía no aparecen en el resumen del
 * servidor: el alta de un producto con stock inicial, cada "añadir stock" y la
 * mercancía recibida del almacén (transferencia to_store). Se leen del outbox.
 *
 * Se incluyen las pendientes/sincronizando/en conflicto (todavía no confirmadas)
 * y las ya sincronizadas que NO quedaron cubiertas por el último resumen
 * (covered_by_snapshot = 0): el sync marca 'synced' antes de refrescar el
 * resumen, así que si ese GET falla la entrada confirmada sigue contándose; al
 * bajar un resumen nuevo esas operaciones quedan cubiertas y no se duplican.
 * El filtro por día evita arrastrar operaciones de ayer.
 *
 * Devuelve un Map id local → cantidad recibida.
 */
function pendingEntriesByProduct(db = getLocalDb(), { date = null } = {}) {
  const { createdBusinessDate } = require('../lib/dailyStock');
  const out = new Map();
  const rows = db.prepare(`
    SELECT op_type, local_ref_id, payload, status, created_at FROM outbox
    WHERE op_type IN ('product.create', 'product.update', 'warehouse.transfer')
      AND (status IN ('pending', 'syncing', 'conflict')
           OR (status = 'synced' AND covered_by_snapshot = 0))
  `).all();
  for (const row of rows) {
    if (date && createdBusinessDate(row.created_at) !== date) continue;
    let payload;
    try { payload = JSON.parse(row.payload); } catch (_) { continue; }
    // La transferencia guarda el producto en el payload (local_ref_id es el
    // artículo del almacén) y siempre es almacén → tienda.
    const id = Number(row.op_type === 'warehouse.transfer' ? payload.local_product_id : row.local_ref_id);
    const quantity = Number(row.op_type === 'product.create' ? payload.stock
      : row.op_type === 'warehouse.transfer' ? payload.quantity : payload.add_stock);
    if (!Number.isFinite(id) || !(quantity > 0)) continue;
    out.set(id, round3((out.get(id) || 0) + quantity));
  }
  return out;
}

function getDayStock(date) {
  const { businessToday } = require('../lib/businessDay');
  const { withDayStock } = require('../lib/dailyStock');
  const today = businessToday('America/Havana');
  const target = date || today;
  const products = listProducts();
  let snapshot = null;
  try { snapshot = JSON.parse(getSyncState('daily_stock_snapshot') || 'null'); } catch (_) { /* cache is absent/corrupt */ }
  return withDayStock(snapshot, products, target, pendingEntriesByProduct(undefined, { date: target }));
}

/** "  Arroz   (1 LB) " y "arroz (1 lb)" son el mismo producto — misma regla que el servidor. */
const normalizeName = (name) =>
  String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

const findProductByName = (db, name) => {
  const key = normalizeName(name);
  return db.prepare('SELECT * FROM products WHERE deleted = 0').all()
    .find((p) => normalizeName(p.name) === key) || null;
};

const UNITS = ['kg', 'g', 'lb'];

// Cantidades por peso con hasta 3 decimales (misma regla que el servidor).
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** undefined/null/'' = por unidad (null); 'kg' | 'g' | 'lb' = por peso. */
function normalizeUnit(unit) {
  if (unit === undefined || unit === null || unit === '') return null;
  if (!UNITS.includes(unit)) {
    throw new Error("La unidad debe ser kg, g o lb (o dejarla vacía para vender por unidad)");
  }
  return unit;
}

/** Stock o cantidad: decimal (3 como máximo) si el producto es por peso, entero si no. */
function normalizeQuantity(value, unit, { allowZero }) {
  const n = Number(value);
  const bad = !Number.isFinite(n) || n < 0 || (!allowZero && n <= 0) || value === null || value === '';
  if (bad) return NaN;
  return unit ? round3(n) : (Number.isInteger(n) ? n : NaN);
}

/**
 * Solo un producto con unit puede dejar de llevar stock; sin unit siempre se
 * controla. Sin valor se usa `fallback` (alta: 0 = sin control; edición: el
 * que ya tenía).
 */
const normalizeTrackStock = (value, unit, fallback) => {
  if (!unit) return 1;
  if (value === undefined || value === null || value === '') return fallback;
  return (value === false || value === 0 || value === '0' || value === 'false') ? 0 : 1;
};

function createProduct({ name, purchase_price = 0, sale_price, stock = 0, unit, track_stock }) {
  const db = getLocalDb();
  const cleanUnit = normalizeUnit(unit);
  const cleanTrack = normalizeTrackStock(track_stock, cleanUnit, 0);
  const cleanStock = normalizeQuantity(stock, cleanUnit, { allowZero: true });
  if (Number.isNaN(cleanStock)) {
    throw new Error(cleanUnit
      ? 'El stock debe ser un número mayor o igual a 0'
      : 'El stock debe ser un número entero mayor o igual a 0');
  }
  // Sin control de stock, el stock que llegue no vale: se guarda en 0.
  stock = cleanUnit && cleanTrack === 0 ? 0 : cleanStock;
  const clientOpId = crypto.randomUUID();
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');

  // Si esta caja ya tiene el producto (lo bajó del catálogo o lo creó antes),
  // se avisa en vez de duplicarlo. El caso en que la caja NO lo tiene todavía
  // —el dueño lo cargó en la web mientras no había internet— lo resuelve el
  // servidor al sincronizar, uniéndolos (ver onSuccess de product.create).
  const existing = findProductByName(db, cleanName);
  if (existing) {
    throw Object.assign(
      new Error(`Ya existe «${existing.name}». Búscalo en la lista en vez de crearlo otra vez.`),
      { code: 'DUPLICATE_NAME', product: existing }
    );
  }

  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO products (name, purchase_price, sale_price, stock, unit, track_stock) VALUES (?, ?, ?, ?, ?, ?)
    `).run(cleanName, purchase_price, sale_price, stock, cleanUnit, cleanTrack);
    const localId = result.lastInsertRowid;

    enqueueOutbox(db, {
      op_type: 'product.create',
      client_op_id: clientOpId,
      local_ref_id: localId,
      payload: { local_product_id: localId, name: cleanName, purchase_price, sale_price, stock, unit: cleanUnit, track_stock: cleanTrack },
    });

    return db.prepare('SELECT * FROM products WHERE id = ?').get(localId);
  });

  return insert();
}

function updateProduct(id, { name, purchase_price, sale_price, stock, unit, track_stock, add_stock, stock_reason }) {
  const stockReason = typeof stock_reason === 'string' && stock_reason.trim() ? stock_reason.trim().slice(0, 200) : null;
  if (sale_price !== undefined && (sale_price === null || sale_price === '' || !Number.isFinite(Number(sale_price)) || Number(sale_price) < 0)) {
    throw new Error('El precio de venta no es válido');
  }
  const db = getLocalDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(id);
  if (!existing) return null;
  const nextUnit = unit === undefined ? existing.unit : normalizeUnit(unit);
  const nextTrack = normalizeTrackStock(track_stock, nextUnit, existing.track_stock ?? 1);
  // Mercancía recibida: se suma al stock actual y viaja como cantidad (no como
  // total) para que no pise ventas de otra caja. Queda en el registro de entradas.
  const hasAdd = add_stock !== undefined && add_stock !== null && add_stock !== '';
  let addedQty = 0;
  if (hasAdd) {
    if (existing.unit && Number(existing.track_stock ?? 1) !== 1) throw new Error('Este producto no lleva control de stock');
    addedQty = normalizeQuantity(add_stock, nextUnit, { allowZero: false });
    if (Number.isNaN(addedQty)) {
      throw new Error(nextUnit
        ? 'La cantidad a añadir debe ser un número mayor que 0 (hasta 3 decimales)'
        : 'La cantidad a añadir debe ser un número entero mayor que 0');
    }
    stock = round3(Number(existing.stock) + addedQty);
  }
  // Se valida el stock que va a quedar (el nuevo o el que ya había) contra la
  // unidad que va a quedar: pasar un producto con decimales a "por unidad"
  // sin corregir el stock lo dejaría con medio producto.
  const nextStock = normalizeQuantity(stock ?? existing.stock, nextUnit, { allowZero: true });
  if (Number.isNaN(nextStock)) {
    throw new Error(nextUnit
      ? 'El stock debe ser un número mayor o igual a 0'
      : 'El stock debe ser un número entero mayor o igual a 0');
  }

  const next = {
    name: name ?? existing.name,
    purchase_price: purchase_price ?? existing.purchase_price,
    sale_price: sale_price ?? existing.sale_price,
    stock: nextStock,
    unit: nextUnit,
    track_stock: nextTrack,
  };

  // Solo viaja al servidor lo que de verdad cambió. El formulario manda todos
  // los campos siempre; si se reenviara el stock al corregir un precio, el
  // stock que tenía ESTA caja en ese momento pisaría en el servidor las ventas
  // que entraron entretanto desde la web u otra caja.
  const changed = {};
  if (String(next.name) !== String(existing.name)) changed.name = next.name;
  if (next.unit !== (existing.unit ?? null)) changed.unit = next.unit;
  if (next.track_stock !== (existing.track_stock ?? 1)) changed.track_stock = next.track_stock;
  for (const key of ['purchase_price', 'sale_price', 'stock']) {
    if (Number(next[key]) !== Number(existing[key])) changed[key] = next[key];
  }
  if (addedQty > 0) delete changed.stock;
  if (Object.keys(changed).length === 0 && addedQty === 0) return existing;

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE products SET name = ?, purchase_price = ?, sale_price = ?, stock = ?, unit = ?, track_stock = ? WHERE id = ?
    `).run(next.name, next.purchase_price, next.sale_price, next.stock, next.unit, next.track_stock, id);

    enqueueOutbox(db, {
      op_type: 'product.update',
      client_op_id: crypto.randomUUID(),
      local_ref_id: id,
      payload: {
        local_product_id: id, ...changed,
        ...(addedQty > 0 && { add_stock: addedQty }),
        ...(changed.stock !== undefined && stockReason && { stock_reason: stockReason }),
      },
    });

    if (addedQty > 0) {
      db.prepare(`
        INSERT INTO stock_entries (product_id, product_name, quantity, stock_before, stock_after, account_email)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, next.name, addedQty, Number(existing.stock), next.stock, getSession()?.email ?? null);
    } else if (changed.stock !== undefined) {
      // Stock puesto a mano (58 → 55): queda anotado, con el motivo si lo hay.
      db.prepare(`
        INSERT INTO stock_entries (product_id, product_name, quantity, stock_before, stock_after, account_email, kind, reason)
        VALUES (?, ?, ?, ?, ?, ?, 'correccion', ?)
      `).run(id, next.name, round3(next.stock - Number(existing.stock)), Number(existing.stock), next.stock,
        getSession()?.email ?? null, stockReason);
    }

    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  });

  return update();
}

/**
 * Importación masiva del dueño. Con stock_mode 'sumar' el stock del archivo se
 * suma al actual; si no, lo reemplaza. Reusa create/updateProduct, así que cada
 * fila queda encolada en el outbox como cualquier edición.
 */
function importProducts(items, stockMode) {
  const db = getLocalDb();
  const result = { created: 0, updated: 0, total: items.length };
  db.transaction(() => {
    for (const item of items) {
      const existing = findProductByName(db, item.name);
      if (!existing) { createProduct(item); result.created++; continue; }
      const patch = { sale_price: item.sale_price, purchase_price: item.purchase_price, unit: item.unit };
      if (item.stock !== undefined && item.stock !== null && item.stock !== '') {
        if (stockMode === 'sumar') {
          if (Number(item.stock) > 0) patch.add_stock = item.stock;
        } else patch.stock = item.stock;
      }
      for (const k of Object.keys(patch)) if (patch[k] === undefined || patch[k] === null) delete patch[k];
      updateProduct(existing.id, patch);
      result.updated++;
    }
  })();
  return result;
}

// Entradas de mercancía hechas en esta caja (el servidor guarda las de todas).
function listStockEntries() {
  return getLocalDb().prepare('SELECT * FROM stock_entries ORDER BY created_at DESC, id DESC LIMIT 200').all();
}

// ---------------------------------------------------------------------------
// Almacén
// ---------------------------------------------------------------------------

const listWarehouse = () => getLocalDb().prepare('SELECT * FROM warehouse_items ORDER BY name ASC').all();

// Cantidad que ya se transfirió desde aquí y todavía no subió, por artículo.
const pendingTransferred = (db) => {
  const out = new Map();
  for (const row of db.prepare(`SELECT payload FROM outbox WHERE op_type = 'warehouse.transfer' AND status IN ('pending', 'syncing')`).all()) {
    try {
      const p = JSON.parse(row.payload);
      out.set(Number(p.warehouse_item_id), round3((out.get(Number(p.warehouse_item_id)) || 0) + Number(p.quantity)));
    } catch (_) { /* fila ilegible: se ignora */ }
  }
  return out;
};

/**
 * Reemplaza el espejo con lo que dice el servidor, descontando lo transferido
 * aquí que aún no subió (si no, el almacén "recuperaría" esa mercancía hasta
 * que la transferencia llegue). Una lista vacía sí vacía el almacén.
 */
function applyServerWarehouse(items) {
  if (!Array.isArray(items)) return;
  const db = getLocalDb();
  const pending = pendingTransferred(db);
  db.transaction(() => {
    const keep = new Set();
    const upsert = db.prepare(`
      INSERT INTO warehouse_items (id, name, unit, cost, quantity) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, unit = excluded.unit, cost = excluded.cost, quantity = excluded.quantity
    `);
    for (const it of items) {
      keep.add(Number(it.id));
      upsert.run(Number(it.id), it.name, it.unit ?? null, Number(it.cost) || 0, Math.max(0, round3(Number(it.quantity) - (pending.get(Number(it.id)) || 0))));
    }
    for (const row of db.prepare('SELECT id FROM warehouse_items').all()) {
      if (!keep.has(row.id)) db.prepare('DELETE FROM warehouse_items WHERE id = ?').run(row.id);
    }
  })();
}

/**
 * Transferencia almacén -> tienda, sin red. Baja el almacén local y sube el
 * stock del producto (lo crea si no existe, con el precio de venta indicado).
 * El servidor repite la misma cuenta al sincronizar; el alta del producto va
 * antes en el outbox y la transferencia viaja como cantidad.
 */
function transferWarehouseLocal({ warehouse_item_id, quantity, sale_price } = {}) {
  const db = getLocalDb();
  const item = db.prepare('SELECT * FROM warehouse_items WHERE id = ?').get(Number(warehouse_item_id));
  if (!item) throw new Error('Artículo no encontrado en el almacén');
  const qty = normalizeQuantity(quantity, item.unit, { allowZero: false });
  if (Number.isNaN(qty)) {
    throw new Error(item.unit ? 'La cantidad debe ser mayor que 0 (hasta 3 decimales)' : 'La cantidad debe ser un entero mayor que 0');
  }
  if (qty > Number(item.quantity)) throw new Error(`En el almacén solo hay ${item.quantity} de ${item.name}`);

  let product = findProductByName(db, item.name);
  if (product && (product.unit ?? null) !== (item.unit ?? null)) {
    throw new Error('El producto de la tienda tiene otra unidad de medida que el del almacén');
  }
  if (!product && (sale_price === undefined || sale_price === null || sale_price === '' || !Number.isFinite(Number(sale_price)) || Number(sale_price) < 0)) {
    throw Object.assign(new Error('Este producto aún no está en la tienda: indica su precio de venta'), { code: 'NEEDS_SALE_PRICE' });
  }
  const clientTransferId = crypto.randomUUID();
  const email = getSession()?.email ?? null;

  return db.transaction(() => {
    let created = 0;
    if (!product) {
      // Nace con stock 0: la entrada la pone la transferencia (aquí y en el servidor).
      product = createProduct({ name: item.name, purchase_price: item.cost, sale_price: Number(sale_price), stock: 0, unit: item.unit, track_stock: true });
      created = 1;
    }
    db.prepare('UPDATE warehouse_items SET quantity = ? WHERE id = ?').run(round3(Number(item.quantity) - qty), item.id);
    if (!product.unit || Number(product.track_stock ?? 1) === 1) {
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(round3(Number(product.stock) + qty), product.id);
    }
    enqueueOutbox(db, {
      op_type: 'warehouse.transfer',
      client_op_id: clientTransferId,
      local_ref_id: item.id,
      payload: { client_transfer_id: clientTransferId, warehouse_item_id: item.id, local_product_id: product.id, quantity: qty, sale_price: sale_price ?? null, account_email: email },
    });
    return { client_transfer_id: clientTransferId, item_name: item.name, quantity: qty, created_product: created, account_email: email, product_id: product.id };
  })();
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
function createSaleLocal({ items, payment_method = 'efectivo', transfer_amount = null, ...rest }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('La venta debe tener al menos un producto'), { code: 'EMPTY_SALE' });
  }
  // Mismas reglas que POST /api/sales: si la caja aceptara algo que el
  // servidor rechaza, la venta quedaría cobrada aquí y en conflicto allá.
  if (!PAYMENT_METHODS.includes(payment_method)) {
    throw Object.assign(new Error('Forma de pago inválida'), { code: 'BAD_PAYMENT' });
  }
  const transferAmount = payment_method === 'mixto' ? round2(transfer_amount) : null;
  if (payment_method === 'mixto'
      && (transfer_amount === null || !Number.isFinite(Number(transfer_amount)) || transferAmount <= 0)) {
    throw Object.assign(new Error('Falta el monto transferido del cobro mixto'), { code: 'BAD_PAYMENT' });
  }

  let foreign;
  try { foreign = foreignFields({ payment_method, ...rest }); }
  catch (error) { throw Object.assign(error, { code: 'BAD_PAYMENT' }); }

  const db = getLocalDb();
  const clientSaleId = crypto.randomUUID();
  const registerId = getRegisterId();
  const session = getSession();
  const accountEmail = session?.email ?? null;
  // Sin shop_rate del cliente se compara contra la tasa de la tienda que
  // tiene guardada esta caja, igual que hace el servidor con la suya.
  if (foreign.foreign_currency && !('shop_rate' in rest)) {
    foreign.shop_rate = session?.[foreign.foreign_currency === 'USD' ? 'usd_rate' : 'eur_rate'] ?? null;
  }

  const create = db.transaction(() => {
    let total = 0;
    let profit = 0;
    const lines = [];

    for (const item of items) {
      const unitPrice = Number(item.unit_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw Object.assign(new Error('Precio inválido'), { code: 'BAD_PRICE' });
      }

      const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(item.product_id);
      if (!product) {
        throw Object.assign(new Error('Producto no existe'), { code: 'NO_PRODUCT' });
      }

      // Decimal sólo si el producto se vende por peso; si no, entero.
      const quantity = normalizeQuantity(item.quantity, product.unit, { allowZero: false });
      if (Number.isNaN(quantity) || quantity <= 0) {
        throw Object.assign(new Error('Cantidad inválida'), { code: 'BAD_QUANTITY' });
      }

      if (product.unit) {
        // Un producto por peso nunca bloquea la venta por stock: con control
        // el stock baja hasta 0 (sin quedar negativo); sin control no se toca.
        // ROUND evita que 12.5 - 2.35 deje 10.149999999999999 en el stock.
        if (product.track_stock !== 0) {
          db.prepare('UPDATE products SET stock = MAX(0, ROUND(stock - ?, 3)) WHERE id = ?')
            .run(quantity, item.product_id);
        }
      } else {
        const updated = db.prepare(
          'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?'
        ).run(quantity, item.product_id, quantity);
        if (updated.changes !== 1) {
          throw Object.assign(
            new Error(`Stock insuficiente para ${product.name}`),
            { code: 'NO_STOCK', product: product.name }
          );
        }
      }

      // Cada línea se redondea a centavos y el total es la suma de líneas.
      total  += round2(quantity * unitPrice);
      profit += round2(quantity * (unitPrice - (product.purchase_price || 0)));
      lines.push({
        product_id: product.id,
        product_name: product.name,
        quantity,
        unit_price: unitPrice,
        unit_cost: product.purchase_price || 0,
      });
    }
    total = round2(total);
    profit = round2(profit);

    // El total recién se conoce aquí: un mixto que no deja efectivo no es
    // mixto, y aceptarlo pondría efectivo negativo en el arqueo.
    if (payment_method === 'mixto' && transferAmount >= total) {
      throw Object.assign(
        new Error('El monto transferido tiene que ser menor que el total'),
        { code: 'BAD_PAYMENT' }
      );
    }

    const saleResult = db.prepare(`
      INSERT INTO sales
        (client_sale_id, origin, register_id, account_email, total, profit, payment_method, transfer_amount,
         foreign_currency, foreign_amount, exchange_rate, shop_rate)
      VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(clientSaleId, registerId, accountEmail, total, profit, payment_method, transferAmount,
      foreign.foreign_currency, foreign.foreign_amount, foreign.exchange_rate, foreign.shop_rate);
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
        transfer_amount: transferAmount,
        ...foreign,
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

function listSales({ date, accountEmail = null, closedOnly = false } = {}) {
  const db = getLocalDb();
  const filters = [];
  const args = [];
  if (date) {
    const { start, end } = boundsForDate(date);
    filters.push('created_at >= ?', 'created_at < ?');
    args.push(start, end);
  }
  if (accountEmail != null) { filters.push('account_email = ?'); args.push(accountEmail); }
  if (closedOnly) filters.push('cash_close_id IS NOT NULL');
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const columns = accountEmail == null ? '*' : 'id, server_id, client_sale_id, origin, register_id, total, payment_method, transfer_amount, foreign_currency, foreign_amount, exchange_rate, shop_rate, created_at, account_email, cash_close_id';
  const rows = db.prepare(`SELECT ${columns} FROM sales${where} ORDER BY created_at DESC${date || accountEmail != null ? '' : ' LIMIT 200'}`).all(...args);
  if (accountEmail == null) return rows;
  return rows.map((sale) => ({ ...sale, items: db.prepare(`SELECT i.id, i.sale_id, i.product_id, i.product_name, i.quantity, i.unit_price, NULL AS pack_size, p.unit FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = ?`).all(sale.id) }));
}

function getSale(id, { accountEmail = null } = {}) {
  const db = getLocalDb();
  const sale = db.prepare(`SELECT ${accountEmail == null ? '*' : 'id, server_id, client_sale_id, origin, register_id, total, payment_method, transfer_amount, foreign_currency, foreign_amount, exchange_rate, shop_rate, created_at, account_email, cash_close_id'} FROM sales WHERE id = ?`).get(id);
  if (!sale) return null;
  if (accountEmail != null && sale.account_email !== accountEmail) return null;
  const items = accountEmail == null
    ? db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id)
    : db.prepare('SELECT i.id, i.sale_id, i.product_id, i.product_name, i.quantity, i.unit_price, NULL AS pack_size, p.unit FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = ?').all(id);
  return { ...sale, items };
}

// ---------------------------------------------------------------------------
// Compra de divisa
// ---------------------------------------------------------------------------

/**
 * Registra sin red una compra de dólares o euros: los pesos que salen de la
 * gaveta (monto × tasa) los calcula esta función, no el cliente. Fila y outbox
 * se guardan en una sola transacción, igual que una venta.
 */
function createCurrencyPurchaseLocal(body = {}) {
  let fields;
  try { fields = purchaseFields(body); }
  catch (error) { throw Object.assign(error, { code: 'BAD_PURCHASE' }); }

  const db = getLocalDb();
  const clientPurchaseId = crypto.randomUUID();
  const registerId = getRegisterId();
  const session = getSession();
  const accountEmail = session?.email ?? null;
  // Sin shop_rate del cliente se compara contra la tasa de la tienda que
  // tiene guardada esta caja, igual que en los cobros en divisa.
  if (fields.shop_rate == null && !('shop_rate' in body)) {
    fields.shop_rate = session?.[fields.foreign_currency === 'USD' ? 'usd_rate' : 'eur_rate'] ?? null;
  }

  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO currency_purchases
        (client_purchase_id, origin, register_id, account_email, foreign_currency, foreign_amount,
         exchange_rate, shop_rate, cup_amount)
      VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)
    `).run(clientPurchaseId, registerId, accountEmail, fields.foreign_currency, fields.foreign_amount,
      fields.exchange_rate, fields.shop_rate, fields.cup_amount);
    const purchaseId = result.lastInsertRowid;
    const row = db.prepare('SELECT * FROM currency_purchases WHERE id = ?').get(purchaseId);

    enqueueOutbox(db, {
      op_type: 'currency_purchase.create',
      client_op_id: clientPurchaseId,
      local_ref_id: purchaseId,
      payload: {
        client_purchase_id: clientPurchaseId,
        foreign_currency: fields.foreign_currency,
        foreign_amount: fields.foreign_amount,
        exchange_rate: fields.exchange_rate,
        shop_rate: fields.shop_rate,
        register_id: registerId,
        // Hora real de la operación (UTC, ISO) para que el servidor la ponga en
        // el día correcto aunque suba horas después.
        sold_at: `${row.created_at.replace(' ', 'T')}Z`,
      },
    });
    return row;
  });
  return create();
}

function listCurrencyPurchases({ date } = {}) {
  const db = getLocalDb();
  if (!date) return db.prepare('SELECT * FROM currency_purchases ORDER BY created_at DESC, id DESC LIMIT 200').all();
  const { start, end } = boundsForDate(date);
  return db.prepare(
    'SELECT * FROM currency_purchases WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC'
  ).all(start, end);
}

// ---------------------------------------------------------------------------
// Extracción de caja
// ---------------------------------------------------------------------------

/**
 * Registra sin red una extracción de dinero. Solo el dueño puede hacerlo.
 * Fila y outbox se guardan en una sola transacción, igual que una compra.
 */
function createWithdrawalLocal(body = {}) {
  const session = getSession();
  if (session?.role === 'cajero') {
    throw Object.assign(new Error('Solo el dueño puede extraer dinero'), { code: 'UNAUTHORIZED' });
  }

  let fields;
  try { fields = withdrawalFields(body); }
  catch (error) { throw Object.assign(error, { code: 'BAD_WITHDRAWAL' }); }

  const db = getLocalDb();
  const clientWithdrawalId = crypto.randomUUID();
  const registerId = getRegisterId();
  const accountEmail = session?.email ?? null;

  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO cash_withdrawals
        (client_withdrawal_id, origin, register_id, account_email, method, amount, note)
      VALUES (?, 'local', ?, ?, ?, ?, ?)
    `).run(clientWithdrawalId, registerId, accountEmail, fields.method, fields.amount, fields.note);
    const withdrawalId = result.lastInsertRowid;
    const row = db.prepare('SELECT * FROM cash_withdrawals WHERE id = ?').get(withdrawalId);

    enqueueOutbox(db, {
      op_type: 'cash_withdrawal.create',
      client_op_id: clientWithdrawalId,
      local_ref_id: withdrawalId,
      payload: {
        client_withdrawal_id: clientWithdrawalId,
        method: fields.method,
        amount: fields.amount,
        note: fields.note,
        register_id: registerId,
        withdrawn_at: `${row.created_at.replace(' ', 'T')}Z`,
      },
    });
    return row;
  });
  return create();
}

function listWithdrawals({ date, open } = {}) {
  const db = getLocalDb();
  if (open) {
    return db.prepare(
      'SELECT * FROM cash_withdrawals WHERE cash_close_id IS NULL ORDER BY created_at DESC, id DESC'
    ).all();
  }
  if (date) {
    const { start, end } = boundsForDate(date);
    return db.prepare(
      'SELECT * FROM cash_withdrawals WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC'
    ).all(start, end);
  }
  return db.prepare('SELECT * FROM cash_withdrawals ORDER BY created_at DESC, id DESC LIMIT 200').all();
}

/**
 * Anula una extracción (idempotente si ya estaba anulada).
 * 409 si ya fue cubierta por un cierre.
 * 404 si no existe.
 */
function voidWithdrawalLocal(clientWithdrawalId) {
  const session = getSession();
  if (session?.role === 'cajero') {
    throw Object.assign(new Error('Solo el dueño puede anular extracciones'), { code: 'UNAUTHORIZED' });
  }

  const db = getLocalDb();
  const void_fn = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM cash_withdrawals WHERE client_withdrawal_id = ?').get(clientWithdrawalId);
    if (!existing) {
      throw Object.assign(new Error('No encontrada'), { code: 'NOT_FOUND', status: 404 });
    }
    if (existing.cash_close_id !== null) {
      throw Object.assign(
        new Error('Esta extracción ya entró en un cierre de caja y no se puede anular'),
        { code: 'COVERED', status: 409 }
      );
    }
    if (existing.voided_at) {
      // Ya estaba anulada: idempotente, devuelve la misma.
      return existing;
    }
    
    // Anular
    db.prepare('UPDATE cash_withdrawals SET voided_at = datetime(\'now\') WHERE id = ?')
      .run(existing.id);

    enqueueOutbox(db, {
      op_type: 'cash_withdrawal.void',
      client_op_id: `${clientWithdrawalId}-void`,
      local_ref_id: existing.id,
      payload: { client_withdrawal_id: clientWithdrawalId },
    });

    return db.prepare('SELECT * FROM cash_withdrawals WHERE id = ?').get(existing.id);
  });
  return void_fn();
}


// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// Lo cobrado en esta caja que el servidor todavía no conoce: se suma a lo que
// él informa de toda la tienda para que "Lo que hay ahora" no se atrase.
function pendingHoldings() {
  const db = getLocalDb();
  const holdings = { cash: 0, transfer: 0, usd: 0, eur: 0 };
  const sales = db.prepare(
    `SELECT total, payment_method, transfer_amount, foreign_currency, foreign_amount, exchange_rate
     FROM sales WHERE origin = 'local' AND cash_close_id IS NULL AND server_id IS NULL`
  ).all();
  const purchases = db.prepare(
    `SELECT foreign_currency, foreign_amount, cup_amount
     FROM currency_purchases WHERE origin = 'local' AND cash_close_id IS NULL AND server_id IS NULL`
  ).all();
  const withdrawals = db.prepare(
    `SELECT method, amount, voided_at
     FROM cash_withdrawals WHERE origin = 'local' AND cash_close_id IS NULL AND server_id IS NULL`
  ).all();
  for (const sale of sales) {
    const split = paymentSplit(sale);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }
  for (const purchase of purchases) {
    const split = purchaseSplit(purchase);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }
  for (const withdrawal of withdrawals) {
    const split = withdrawalSplit(withdrawal);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }
  return holdings;
}

function getDashboard() {
  const db = getLocalDb();
  // Antes se comparaba contra la fecha UTC, así que a las 8:00 pm hora de Cuba
  // el día del dueño se reiniciaba con la tienda todavía abierta.
  const { start, end } = todayBounds();

  const todayStats = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS sales, COALESCE(SUM(profit),0) AS profit, COUNT(*) AS count
    FROM sales WHERE created_at >= ? AND created_at < ?
  `).get(start, end);

  const lowStock = db.prepare(`
    SELECT * FROM products WHERE deleted = 0 AND stock <= 5 AND (unit IS NULL OR track_stock = 1) ORDER BY stock ASC
  `).all();

  const recentSales = db.prepare(`
    SELECT * FROM sales WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 5
  `).all(start, end);

  // Mismo aviso que el servidor: cobros en divisa de hoy a una tasa que no
  // era la de la tienda.
  const offRate = db.prepare(`
    SELECT COUNT(*) AS n FROM sales
    WHERE created_at >= ? AND created_at < ? AND payment_method = 'divisa'
      AND shop_rate IS NOT NULL AND ABS(exchange_rate - shop_rate) > 0.005
  `).get(start, end);

  // Lo que hay ahora en la tienda: lo cobrado desde el último arqueo, con la
  // misma cuenta del arqueo (paymentSplit).
  const holdings = { cash: 0, transfer: 0, usd: 0, eur: 0 };
  for (const sale of periodSales(db, isWholeShop())) {
    const split = paymentSplit(sale);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }
  for (const purchase of periodPurchases(db, isWholeShop())) {
    const split = purchaseSplit(purchase);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }
  for (const withdrawal of periodWithdrawals(db)) {
    const split = withdrawalSplit(withdrawal);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }
  for (const key of Object.keys(holdings)) holdings[key] = round2(holdings[key]);

  const inv = db.prepare(`
    SELECT COALESCE(SUM(stock * purchase_price), 0) AS cost, COALESCE(SUM(stock * sale_price), 0) AS retail, COALESCE(SUM(CASE WHEN unit IS NULL THEN stock ELSE 0 END), 0) AS units
    FROM products WHERE deleted = 0 AND (unit IS NULL OR track_stock = 1)
  `).get();
  const inventory = { cost: round2(inv.cost), retail: round2(inv.retail), units: round3(inv.units) };

  const openWithdrawals = db.prepare(
    `SELECT * FROM cash_withdrawals WHERE cash_close_id IS NULL AND voided_at IS NULL ORDER BY created_at DESC, id DESC`
  ).all();

  return { today: todayStats, holdings, inventory, lowStock, recentSales, audit: { offRateSales: offRate.n }, open_withdrawals: openWithdrawals };
}

// ---------------------------------------------------------------------------
// Arqueo de caja
// ---------------------------------------------------------------------------

// Antes del primer cierre no hay corte anterior. Mismo centinela que el
// servidor (server/routes/cashCloses.js): ordena por debajo de cualquier fecha
// real, así que el primer arqueo barre todo lo que nunca se contó.
const BEGINNING_OF_TIME = '0000-01-01 00:00:00';

const getPeriodStart = (db) => {
  const session = getSession();
  const row = session?.role === 'cajero'
    ? db.prepare("SELECT closed_at FROM cash_closes WHERE origin = 'local' AND (account_email = ? OR account_email IS NULL) ORDER BY closed_at DESC LIMIT 1").get(session.email)
    : db.prepare("SELECT closed_at FROM cash_closes WHERE origin = 'local' ORDER BY closed_at DESC LIMIT 1").get();
  return row ? row.closed_at : BEGINNING_OF_TIME;
};

// created_at > inicio (estricto): una venta registrada justo en el segundo del
// corte anterior cae en el período siguiente. En el peor caso se cuenta un
// período más tarde; nunca dos veces.
// La cuenta principal cuenta la tienda entera: además de lo hecho aquí, lo que
// bajó de teléfonos y otras cajas y sigue sin cerrar. Un cajero, solo lo suyo.
const isWholeShop = () => (getSession()?.role ?? null) !== 'cajero';
const periodSales = (db, wholeShop = false) =>
  db.prepare(
    `SELECT client_sale_id, total, payment_method, transfer_amount,
            foreign_currency, foreign_amount, exchange_rate, created_at
     FROM sales WHERE ${wholeShop ? '1 = 1' : "(account_email = ? OR (origin = 'local' AND account_email IS NULL))"} AND cash_close_id IS NULL ORDER BY created_at ASC, id ASC`
  ).all(...(wholeShop ? [] : [getSession()?.email]));

// Compras de divisa de esta caja que ningún arqueo ha cubierto todavía.
const periodPurchases = (db, wholeShop = false) =>
  db.prepare(
    `SELECT id, client_purchase_id, foreign_currency, foreign_amount, cup_amount, created_at
     FROM currency_purchases WHERE ${wholeShop ? '1 = 1' : "(account_email = ? OR (origin = 'local' AND account_email IS NULL))"} AND cash_close_id IS NULL ORDER BY created_at ASC, id ASC`
  ).all(...(wholeShop ? [] : [getSession()?.email]));

// Extracciones de caja que ningún arqueo ha cubierto todavía.
// El cierre toma TODAS (de cualquier origen) porque la dueña extrae por teléfono
// pero el cajero cierra en la laptop: el cierre es de la tienda entera.
const periodWithdrawals = (db) =>
  db.prepare(
    `SELECT id, client_withdrawal_id, method, amount, voided_at, created_at
     FROM cash_withdrawals WHERE cash_close_id IS NULL ORDER BY created_at ASC, id ASC`
  ).all();


/**
 * Describe el período abierto SIN revelar cuánto debería haber.
 *
 * Misma disciplina que en el servidor: el conteo a ciegas no se sostiene si el
 * monto esperado llega a la pantalla antes de que el cajero declare lo contado.
 * Acá el que la sostiene es este router local, porque en modo escritorio no
 * hay servidor en el medio.
 */
function getCurrentCashPeriod() {
  const db = getLocalDb();
  const periodStart = getPeriodStart(db);
  const sales = periodSales(db, isWholeShop());
  const purchases = periodPurchases(db, isWholeShop());
  const withdrawals = periodWithdrawals(db);
  const isFirstClose = periodStart === BEGINNING_OF_TIME;
  const firstAt = [sales[0]?.created_at, purchases[0]?.created_at, withdrawals[0]?.created_at].filter(Boolean).sort()[0] ?? null;

  return {
    opened_at: isFirstClose ? firstAt : periodStart,
    is_first_close: isFirstClose,
    has_sales: sales.length > 0 || purchases.length > 0 || withdrawals.length > 0,
  };
}

/**
 * Cierra la caja 100% local, sin red.
 *
 * El outbox lleva la lista de client_sale_id que este cierre cubrió, no las
 * fechas: el servidor le pone a cada venta sincronizada su propia hora de
 * llegada, así que un cierre definido por timestamps no encontraría ninguna
 * venta del otro lado. Con los ids, el servidor suma exactamente las mismas
 * ventas y el resultado no depende de cuánto tardó la sincronización.
 */
// Lo contado en divisa es opcional, igual que en el servidor: no mandarlo es
// haber contado cero.
const countedForeign = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? round2(n) : NaN;
};

function createCashCloseLocal({ counted_cash, opening_float = 0, note = null, counted_usd, counted_eur }) {
  const counted = Number(counted_cash);
  if (!Number.isFinite(counted) || counted < 0) {
    throw Object.assign(new Error('El efectivo contado no es válido'), { code: 'BAD_COUNT' });
  }
  const float = Number(opening_float);
  if (!Number.isFinite(float) || float < 0) {
    throw Object.assign(new Error('El fondo de caja no es válido'), { code: 'BAD_FLOAT' });
  }
  const countedUsd = countedForeign(counted_usd);
  const countedEur = countedForeign(counted_eur);
  if (Number.isNaN(countedUsd) || Number.isNaN(countedEur)) {
    throw Object.assign(new Error('Los dólares o euros contados no son válidos'), { code: 'BAD_COUNT' });
  }

  const db = getLocalDb();
  const clientCloseId = crypto.randomUUID();
  const email = getSession()?.email ?? null;
  const registerId = getRegisterId();

  const create = db.transaction(() => {
    const periodStart = getPeriodStart(db);
    const wholeShop = isWholeShop();
    const sales = periodSales(db, wholeShop);
    const purchases = periodPurchases(db, wholeShop);
    const withdrawals = periodWithdrawals(db);

    // Una venta mixta aporta a los dos lados: su efectivo está en la gaveta.
    // Una en divisa deja sus billetes aparte y descuenta el vuelto en pesos.
    const sumOf = (key) => round2(
      sales.reduce((sum, s) => sum + paymentSplit(s)[key], 0)
      + purchases.reduce((sum, p) => sum + purchaseSplit(p)[key], 0)
      + withdrawals.reduce((sum, w) => sum + withdrawalSplit(w)[key], 0)
    );
    const cash = sumOf('cash');
    const transfer = sumOf('transfer');
    const usd = sumOf('usd');
    const eur = sumOf('eur');

    // Calcula los totales de lo extraído (positivos, para guardar en withdrawn_*)
    const withdrawnOf = (method) => round2(
      withdrawals
        .filter(w => !w.voided_at && w.method === method)
        .reduce((sum, w) => sum + w.amount, 0)
    );
    const withdrawnCash = withdrawnOf('efectivo');
    const withdrawnTransfer = withdrawnOf('transferencia');
    const withdrawnUsd = withdrawnOf('USD');
    const withdrawnEur = withdrawnOf('EUR');

    const expectedCash = float + cash;
    const openedAt = periodStart === BEGINNING_OF_TIME
      ? ([sales[0]?.created_at, purchases[0]?.created_at, withdrawals[0]?.created_at].filter(Boolean).sort()[0] ?? new Date().toISOString().replace('T', ' ').slice(0, 19))
      : periodStart;

    const result = db.prepare(`
      INSERT INTO cash_closes
        (client_close_id, origin, register_id, opened_at, opening_float, expected_cash, counted_cash,
         difference, expected_transfer, sales_count, note, account_email,
         expected_usd, counted_usd, difference_usd, expected_eur, counted_eur, difference_eur,
         withdrawn_cash, withdrawn_transfer, withdrawn_usd, withdrawn_eur)
      VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clientCloseId, registerId, openedAt, float, expectedCash, counted,
      counted - expectedCash, transfer, sales.length, note, email,
      usd, countedUsd, round2(countedUsd - usd), eur, countedEur, round2(countedEur - eur),
      withdrawnCash, withdrawnTransfer, withdrawnUsd, withdrawnEur
    );
    const closeId = result.lastInsertRowid;

    // El vínculo vive en la venta y se escribe junto con el cierre: así una
    // segunda apertura no puede volver a incluir las mismas ventas locales.
    if (sales.length > 0) {
      const placeholders = sales.map(() => '?').join(',');
      db.prepare(`UPDATE sales SET cash_close_id = ? WHERE client_sale_id IN (${placeholders}) AND cash_close_id IS NULL`)
        .run(closeId, ...sales.map((sale) => sale.client_sale_id));
    }

    if (purchases.length > 0) {
      const placeholders = purchases.map(() => '?').join(',');
      db.prepare(`UPDATE currency_purchases SET cash_close_id = ? WHERE client_purchase_id IN (${placeholders}) AND cash_close_id IS NULL`)
        .run(closeId, ...purchases.map((p) => p.client_purchase_id));
    }

    if (withdrawals.length > 0) {
      const placeholders = withdrawals.map(() => '?').join(',');
      db.prepare(`UPDATE cash_withdrawals SET cash_close_id = ? WHERE client_withdrawal_id IN (${placeholders}) AND cash_close_id IS NULL AND voided_at IS NULL`)
        .run(closeId, ...withdrawals.map((w) => w.client_withdrawal_id));
    }

    enqueueOutbox(db, {
      op_type: 'cash_close.create',
      client_op_id: clientCloseId,
      local_ref_id: closeId,
      payload: {
        client_close_id: clientCloseId,
        opening_float: float,
        counted_cash: counted,
        counted_usd: countedUsd,
        counted_eur: countedEur,
        note,
        closed_at: db.prepare('SELECT closed_at FROM cash_closes WHERE id = ?').get(closeId).closed_at,
        client_sale_ids: sales.map(s => s.client_sale_id),
        client_purchase_ids: purchases.map(p => p.client_purchase_id),
        client_withdrawal_ids: withdrawals.filter(w => !w.voided_at).map(w => w.client_withdrawal_id),
      },
    });

    return db.prepare('SELECT * FROM cash_closes WHERE id = ?').get(closeId);
  });

  return create();
}

const getCashClose = (id) => getLocalDb().prepare('SELECT * FROM cash_closes WHERE id = ?').get(id);

const getCashCloseDetail = (id) => {
  const db = getLocalDb();
  const close = db.prepare('SELECT * FROM cash_closes WHERE id = ?').get(id);
  if (!close) return null;
  const audit = close.server_id == null ? [] : db.prepare(`SELECT server_id AS id, cash_close_server_id AS cash_close_id,
    correction_revision, account_id, account_email, before, after, created_at
    FROM cash_close_corrections WHERE cash_close_server_id = ? ORDER BY correction_revision DESC`).all(close.server_id);
  return { ...close, pending: close.server_id == null, corrections: audit.map((row) => ({
    ...row, before: JSON.parse(row.before), after: JSON.parse(row.after),
  })) };
};

const listCashCloses = ({ accountEmail = null } = {}) => {
  const db = getLocalDb();
  const rows = accountEmail == null
    ? db.prepare('SELECT * FROM cash_closes ORDER BY closed_at DESC LIMIT 100').all()
    : db.prepare('SELECT * FROM cash_closes WHERE account_email = ? ORDER BY closed_at DESC LIMIT 100').all(accountEmail);
  return rows.map((row) => ({ ...row, pending: row.server_id == null }));
};

// Saldo acumulado por cuenta. En una caja de escritorio suele haber una sola,
// pero si el dueño y un cajero se turnan en la misma máquina el patrón sigue
// valiendo — y es el mismo dato que muestra la web.
const cashCloseSummary = () =>
  getLocalDb().prepare(`
    SELECT account_email,
           COUNT(*) AS closes,
           COALESCE(SUM(difference), 0) AS total_difference,
           COALESCE(MIN(difference), 0) AS worst_difference,
           SUM(CASE WHEN difference < -0.5 THEN 1 ELSE 0 END) AS times_short,
           COALESCE(SUM(difference_usd), 0) AS total_difference_usd,
           COALESCE(SUM(difference_eur), 0) AS total_difference_eur,
           MAX(closed_at) AS last_close_at
    FROM cash_closes WHERE server_id IS NOT NULL
    GROUP BY account_email
    ORDER BY total_difference ASC
  `).all();

// ---------------------------------------------------------------------------
// Arqueo de inventario
// ---------------------------------------------------------------------------

/**
 * Cuenta físico contra lo que el sistema cree tener, ajusta el stock local a
 * lo contado y deja la evidencia — las tres cosas en una sola transacción,
 * por la misma razón que en el servidor: sin ajustar, el mismo faltante
 * reaparece cada noche; sin registrar, ajustar sería tapar el problema.
 */
function createInventoryCountLocal({ items, note = null }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('Hay que contar al menos un producto'), { code: 'EMPTY_COUNT' });
  }
  const ids = items.map(i => Number(i.product_id));
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('Un producto aparece repetido en el conteo'), { code: 'DUPLICATE' });
  }

  const db = getLocalDb();
  const clientCountId = crypto.randomUUID();
  const email = getSession()?.email ?? null;

  const create = db.transaction(() => {
    const lines = [];
    let unitsMissing = 0;
    let unitsExtra = 0;
    let valueMissing = 0;
    let withDifference = 0;

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(item.product_id);
      if (!product) {
        throw Object.assign(new Error('Producto no existe'), { code: 'NO_PRODUCT' });
      }

      // Un producto por peso sin control de stock no se cuenta: no tiene stock.
      if (product.unit && product.track_stock === 0) {
        throw Object.assign(
          new Error(`${product.name} no lleva control de stock, no se puede contar`),
          { code: 'NOT_COUNTABLE' }
        );
      }

      // Lo contado es decimal (3 como máximo) en productos por peso; entero en el resto.
      const counted = normalizeQuantity(item.counted, product.unit, { allowZero: true });
      if (Number.isNaN(counted)) {
        throw Object.assign(
          new Error(product.unit
            ? `La cantidad contada de ${product.name} debe ser un número mayor o igual a 0`
            : `La cantidad contada de ${product.name} debe ser un número entero mayor o igual a 0`),
          { code: 'BAD_COUNT' }
        );
      }

      const expected = product.stock;
      const difference = round3(counted - expected);

      if (difference !== 0) {
        withDifference += 1;
        if (difference < 0) {
          unitsMissing += -difference;
          // A precio de VENTA: si la unidad se fue por una venta que nadie
          // registró, eso es el dinero que debió entrar a la caja.
          valueMissing += round2(-difference * (product.sale_price || 0));
        } else {
          unitsExtra += difference;
        }
        db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(counted, product.id);
      }

      lines.push({
        product_id: product.id,
        product_name: product.name,
        expected,
        counted,
        difference,
        unit_cost: product.purchase_price || 0,
        unit_price: product.sale_price || 0,
      });
    }

    const result = db.prepare(`
      INSERT INTO inventory_counts
        (client_count_id, origin, lines_count, products_with_difference,
         units_missing, units_extra, value_missing, note, account_email)
      VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)
    `).run(clientCountId, lines.length, withDifference, round3(unitsMissing), round3(unitsExtra), round2(valueMissing), note, email);
    const countId = result.lastInsertRowid;

    for (const line of lines) {
      db.prepare(`
        INSERT INTO inventory_count_items
          (count_id, product_id, product_name, expected, counted, difference, unit_cost, unit_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(countId, line.product_id, line.product_name, line.expected,
             line.counted, line.difference, line.unit_cost, line.unit_price);
    }

    enqueueOutbox(db, {
      op_type: 'inventory_count.create',
      client_op_id: clientCountId,
      local_ref_id: countId,
      payload: {
        client_count_id: clientCountId,
        note,
        // Ids LOCALES: el sync worker los traduce a server_id al armar el POST,
        // igual que hace con las líneas de una venta.
        items: lines.map(l => ({ local_product_id: l.product_id, counted: l.counted })),
      },
    });

    const count = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(countId);
    return { ...count, items: db.prepare(
      'SELECT * FROM inventory_count_items WHERE count_id = ? ORDER BY difference ASC, product_name ASC'
    ).all(countId) };
  });

  return create();
}

const listInventoryCounts = () =>
  getLocalDb().prepare('SELECT * FROM inventory_counts ORDER BY counted_at DESC LIMIT 100').all();

function getInventoryCount(id) {
  const db = getLocalDb();
  const count = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(id);
  if (!count) return null;
  const items = db.prepare(
    'SELECT * FROM inventory_count_items WHERE count_id = ? ORDER BY difference ASC, product_name ASC'
  ).all(id);
  return { ...count, items };
}

// ---------------------------------------------------------------------------
// Delta recibido del servidor
// ---------------------------------------------------------------------------

const localProductForServerId = (db, serverId) => {
  if (serverId == null) return null;
  return db.prepare('SELECT id FROM products WHERE server_id = ? ORDER BY deleted ASC, id ASC LIMIT 1')
    .get(Number(serverId))?.id ?? null;
};

/**
 * Aplica una página completa en una sola transacción. Las filas remotas son
 * solo historial: no descuentan stock, no generan outbox y los cierres remotos
 * nunca reciben el vínculo local `sales.cash_close_id`.
 */
// Una venta o compra bajada que el servidor ya tiene en un cierre deja de estar
// abierta aquí. Si ese cierre todavía no bajó, queda -id_del_cierre_en_servidor
// (cualquier valor que no sea NULL la saca del período) y se corrige al bajar el cierre.
function markClosedOnServer(db, table, rowId, serverCloseId) {
  if (serverCloseId == null) return;
  const close = db.prepare('SELECT id FROM cash_closes WHERE server_id = ?').get(Number(serverCloseId));
  db.prepare(`UPDATE ${table} SET cash_close_id = ? WHERE id = ? AND cash_close_id IS NULL`)
    .run(close ? close.id : -Number(serverCloseId), rowId);
}

// Pasa a cerradas, con el id local de este cierre, las ventas y compras que el
// servidor dice que cubrió (incluidas las que ya estaban bajadas y abiertas).
function applyCloseCoverage(db, localCloseId, close) {
  db.prepare('UPDATE sales SET cash_close_id = ? WHERE cash_close_id = ?').run(localCloseId, -Number(close.id));
  db.prepare('UPDATE currency_purchases SET cash_close_id = ? WHERE cash_close_id = ?').run(localCloseId, -Number(close.id));
  for (const [table, ids] of [['sales', close.covered_sale_ids], ['currency_purchases', close.covered_purchase_ids]]) {
    for (const id of Array.isArray(ids) ? ids : []) {
      db.prepare(`UPDATE ${table} SET cash_close_id = ? WHERE server_id = ? AND (cash_close_id IS NULL OR cash_close_id < 0)`)
        .run(localCloseId, Number(id));
    }
  }
}

function applyServerDelta(page) {
  if (!page || !Array.isArray(page.sales) || !Array.isArray(page.cash_closes)
      || !Array.isArray(page.inventory_counts) || !page.cursors) {
    throw new Error('Delta del servidor inválido');
  }
  const db = getLocalDb();
  const stats = { sales: 0, closes: 0, counts: 0, purchases: 0, withdrawals: 0, close_corrections: 0 };
  const apply = db.transaction(() => {
    const insertSale = db.prepare(`
      INSERT INTO sales
        (server_id, client_sale_id, origin, register_id, account_email, total, profit,
         payment_method, transfer_amount, foreign_currency, foreign_amount, exchange_rate, shop_rate,
         created_at)
      VALUES (?, ?, 'server', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSaleItem = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const sale of page.sales) {
      const clientSaleId = sale.client_sale_id || `srv-${sale.id}`;
      const existing = db.prepare('SELECT id, server_id FROM sales WHERE client_sale_id = ?').get(clientSaleId);
      if (existing) {
        if (existing.server_id == null) db.prepare('UPDATE sales SET server_id = ? WHERE id = ?').run(Number(sale.id), existing.id);
        continue;
      }
      const result = insertSale.run(
        Number(sale.id), clientSaleId, sale.register_id ?? null, sale.account_email ?? null,
        Number(sale.total) || 0, Number(sale.profit) || 0, sale.payment_method || 'efectivo',
        sale.transfer_amount ?? null, sale.foreign_currency ?? null, sale.foreign_amount ?? null,
        sale.exchange_rate ?? null, sale.shop_rate ?? null, sale.created_at,
      );
      const saleId = Number(result.lastInsertRowid);
      markClosedOnServer(db, 'sales', saleId, sale.cash_close_id);
      for (const item of sale.items || []) {
        insertSaleItem.run(
          saleId, localProductForServerId(db, item.product_id), String(item.product_name || ''),
          Number(item.quantity) || 0, Number(item.unit_price) || 0, Number(item.unit_cost) || 0,
        );
      }
      stats.sales++;
    }

    // Compras de divisa de otras cajas: solo historial; sin vínculo de cierre
    // local ni outbox (el arqueo local solo cubre origin = 'local').
    const insertPurchase = db.prepare(`
      INSERT INTO currency_purchases
        (server_id, client_purchase_id, origin, register_id, account_email, foreign_currency,
         foreign_amount, exchange_rate, shop_rate, cup_amount, created_at)
      VALUES (?, ?, 'server', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const purchase of page.currency_purchases || []) {
      const clientPurchaseId = purchase.client_purchase_id || `srv-${purchase.id}`;
      const existing = db.prepare('SELECT id, server_id FROM currency_purchases WHERE client_purchase_id = ?').get(clientPurchaseId);
      if (existing) {
        if (existing.server_id == null) db.prepare('UPDATE currency_purchases SET server_id = ? WHERE id = ?').run(Number(purchase.id), existing.id);
        continue;
      }
      const purchaseRow = insertPurchase.run(
        Number(purchase.id), clientPurchaseId, purchase.register_id ?? null, purchase.account_email ?? null,
        purchase.foreign_currency, Number(purchase.foreign_amount) || 0, Number(purchase.exchange_rate) || 0,
        purchase.shop_rate ?? null, Number(purchase.cup_amount) || 0, purchase.created_at,
      );
      markClosedOnServer(db, 'currency_purchases', Number(purchaseRow.lastInsertRowid), purchase.cash_close_id);
      stats.purchases++;
    }

    // Extracciones de caja del servidor: se registran y cuentan para el cierre del dueño.
    const insertWithdrawal = db.prepare(`
      INSERT INTO cash_withdrawals
        (server_id, client_withdrawal_id, origin, register_id, account_email, method, amount, note, voided_at, created_at)
      VALUES (?, ?, 'server', ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const withdrawal of page.cash_withdrawals || []) {
      const clientWithdrawalId = withdrawal.client_withdrawal_id || `srv-${withdrawal.id}`;
      const existing = db.prepare('SELECT id, server_id FROM cash_withdrawals WHERE client_withdrawal_id = ?').get(clientWithdrawalId);
      if (existing) {
        if (existing.server_id == null) db.prepare('UPDATE cash_withdrawals SET server_id = ? WHERE id = ?').run(Number(withdrawal.id), existing.id);
        // Marcar como cubierta si el servidor dice que lo está
        if (withdrawal.cash_close_id) {
          markClosedOnServer(db, 'cash_withdrawals', existing.id, withdrawal.cash_close_id);
        }
        continue;
      }
      const withdrawalRow = insertWithdrawal.run(
        Number(withdrawal.id), clientWithdrawalId, withdrawal.register_id ?? null, withdrawal.account_email ?? null,
        withdrawal.method, Number(withdrawal.amount) || 0, withdrawal.note ?? null,
        withdrawal.voided_at ?? null, withdrawal.created_at,
      );
      markClosedOnServer(db, 'cash_withdrawals', Number(withdrawalRow.lastInsertRowid), withdrawal.cash_close_id);
      stats.withdrawals++;
    }

    const insertClose = db.prepare(`
      INSERT INTO cash_closes
        (server_id, client_close_id, origin, register_id, opened_at, closed_at,
         opening_float, expected_cash, counted_cash, difference, expected_transfer,
         sales_count, note, account_email,
         expected_usd, counted_usd, difference_usd, expected_eur, counted_eur, difference_eur,
         withdrawn_cash, withdrawn_transfer, withdrawn_usd, withdrawn_eur, corrected_at,
         original_expected_cash, original_difference, correction_revision)
      VALUES (?, ?, 'server', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const close of page.cash_closes) {
      const clientCloseId = close.client_close_id || `srv-${close.id}`;
      const existing = db.prepare('SELECT id, server_id FROM cash_closes WHERE client_close_id = ?').get(clientCloseId);
      if (existing) {
        if (existing.server_id == null) db.prepare('UPDATE cash_closes SET server_id = ? WHERE id = ?').run(Number(close.id), existing.id);
        // Una respuesta confirmada reemplaza los importes provisionales locales
        // para que la tarjeta y el siguiente historial muestren el mismo cierre.
        db.prepare(`UPDATE cash_closes SET opened_at = COALESCE(?, opened_at), closed_at = ?,
          opening_float = ?, expected_cash = ?, counted_cash = ?, difference = ?, expected_transfer = ?,
          sales_count = ?, expected_usd = ?, counted_usd = ?, difference_usd = ?,
          expected_eur = ?, counted_eur = ?, difference_eur = ?, withdrawn_cash = ?,
          withdrawn_transfer = ?, withdrawn_usd = ?, withdrawn_eur = ?, corrected_at = ?,
          original_expected_cash = ?, original_difference = ?, correction_revision = ? WHERE id = ?`).run(
          close.opened_at ?? null, close.closed_at, Number(close.opening_float) || 0,
          Number(close.expected_cash) || 0, Number(close.counted_cash) || 0, Number(close.difference) || 0,
          Number(close.expected_transfer) || 0, Number(close.sales_count) || 0,
          Number(close.expected_usd) || 0, Number(close.counted_usd) || 0, Number(close.difference_usd) || 0,
          Number(close.expected_eur) || 0, Number(close.counted_eur) || 0, Number(close.difference_eur) || 0,
          Number(close.withdrawn_cash) || 0, Number(close.withdrawn_transfer) || 0,
          Number(close.withdrawn_usd) || 0, Number(close.withdrawn_eur) || 0,
          close.corrected_at ?? null, close.original_expected_cash ?? null,
          close.original_difference ?? null, Number(close.correction_revision) || 0,
          existing.id,
        );
        applyCloseCoverage(db, existing.id, close);
        continue;
      }
      const insertedClose = insertClose.run(
        Number(close.id), clientCloseId, close.register_id ?? null, close.opened_at,
        close.closed_at, Number(close.opening_float) || 0, Number(close.expected_cash) || 0,
        Number(close.counted_cash) || 0, Number(close.difference) || 0,
        Number(close.expected_transfer) || 0, Number(close.sales_count) || 0,
        close.note ?? null, close.account_email ?? null,
        Number(close.expected_usd) || 0, Number(close.counted_usd) || 0, Number(close.difference_usd) || 0,
        Number(close.expected_eur) || 0, Number(close.counted_eur) || 0, Number(close.difference_eur) || 0,
        Number(close.withdrawn_cash) || 0, Number(close.withdrawn_transfer) || 0,
        Number(close.withdrawn_usd) || 0, Number(close.withdrawn_eur) || 0,
        close.corrected_at ?? null, close.original_expected_cash ?? null,
        close.original_difference ?? null, Number(close.correction_revision) || 0,
      );
      applyCloseCoverage(db, Number(insertedClose.lastInsertRowid), close);
      stats.closes++;
    }

    const insertCount = db.prepare(`
      INSERT INTO inventory_counts
        (server_id, client_count_id, origin, counted_at, lines_count,
         products_with_difference, units_missing, units_extra, value_missing, note, account_email)
      VALUES (?, ?, 'server', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCountItem = db.prepare(`
      INSERT INTO inventory_count_items
        (count_id, product_id, product_name, expected, counted, difference, unit_cost, unit_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const count of page.inventory_counts) {
      const clientCountId = count.client_count_id || `srv-${count.id}`;
      const existing = db.prepare('SELECT id, server_id FROM inventory_counts WHERE client_count_id = ?').get(clientCountId);
      if (existing) {
        if (existing.server_id == null) db.prepare('UPDATE inventory_counts SET server_id = ? WHERE id = ?').run(Number(count.id), existing.id);
        continue;
      }
      const result = insertCount.run(
        Number(count.id), clientCountId, count.counted_at, Number(count.lines_count) || 0,
        Number(count.products_with_difference) || 0, Number(count.units_missing) || 0,
        Number(count.units_extra) || 0, Number(count.value_missing) || 0, count.note ?? null,
        count.account_email ?? null,
      );
      const countId = Number(result.lastInsertRowid);
      for (const item of count.items || []) {
        insertCountItem.run(
          countId, localProductForServerId(db, item.product_id), String(item.product_name || ''),
          Number(item.expected) || 0, Number(item.counted) || 0, Number(item.difference) || 0,
          Number(item.unit_cost) || 0, Number(item.unit_price) || 0,
        );
      }
      stats.counts++;
    }

    setSyncState('delta_after_sale', page.cursors.sale);
    // Un servidor anterior a esta función no manda el cursor de compras.
    if (page.cursors.purchase != null) setSyncState('delta_after_purchase', page.cursors.purchase);
    // Un servidor anterior a esta función no manda el cursor de extracciones.
    if (page.cursors.withdrawal != null) setSyncState('delta_after_withdrawal', page.cursors.withdrawal);
    setSyncState('delta_after_close', page.cursors.close);
    setSyncState('delta_after_count', page.cursors.count);

    // Correcciones de la cuenta principal: van después de ventas y cierres para
    // encontrar ya en la base lo que corrigen. Un servidor anterior no las manda.
    for (const correction of page.sale_corrections || []) {
      applySaleCorrection(db, correction);
      stats.corrections = (stats.corrections || 0) + 1;
    }
    if (page.cursors.correction != null) setSyncState('delta_after_correction', page.cursors.correction);
    for (const correction of page.cash_close_corrections || []) {
      if (applyCashCloseCorrection(db, correction)) stats.close_corrections++;
    }
    if (page.cursors.close_correction != null) setSyncState('delta_after_close_correction', page.cursors.close_correction);
  });
  apply();
  return stats;
}

/**
 * Refleja aquí una corrección hecha en el servidor: la venta cambia de forma
 * de pago o desaparece (anulada) y su cierre queda con las cifras recalculadas.
 * El stock devuelto llega con el catálogo, como cualquier otro cambio de stock.
 * Es idempotente: aplicarla dos veces deja lo mismo.
 */
function applySaleCorrection(db, correction) {
  const local = db.prepare('SELECT id FROM sales WHERE server_id = ? OR client_sale_id = ?')
    .get(Number(correction.sale_id), correction.client_sale_id || `srv-${correction.sale_id}`);
  if (local) {
    const sale = correction.sale;
    if (!sale) {
      db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(local.id);
      db.prepare('DELETE FROM sales WHERE id = ?').run(local.id);
    } else {
      db.prepare(`
        UPDATE sales SET payment_method = ?, transfer_amount = ?, foreign_currency = ?,
          foreign_amount = ?, exchange_rate = ?, shop_rate = ? WHERE id = ?
      `).run(sale.payment_method || 'efectivo', sale.transfer_amount ?? null, sale.foreign_currency ?? null,
        sale.foreign_amount ?? null, sale.exchange_rate ?? null, sale.shop_rate ?? null, local.id);
    }
  }
  const close = correction.cash_close;
  if (close) {
    db.prepare(`
      UPDATE cash_closes SET expected_cash = ?, difference = ?, expected_transfer = ?, sales_count = ?,
        expected_usd = ?, difference_usd = ?, expected_eur = ?, difference_eur = ?,
        corrected_at = ?, original_expected_cash = ?, original_difference = ?, correction_revision = ?,
        opening_float = ?, counted_cash = ?, counted_usd = ?, counted_eur = ?, note = ?,
        withdrawn_cash = ?, withdrawn_transfer = ?, withdrawn_usd = ?, withdrawn_eur = ?
      WHERE server_id = ? OR client_close_id = ?
    `).run(
      Number(close.expected_cash) || 0, Number(close.difference) || 0, Number(close.expected_transfer) || 0,
      Number(close.sales_count) || 0, Number(close.expected_usd) || 0, Number(close.difference_usd) || 0,
      Number(close.expected_eur) || 0, Number(close.difference_eur) || 0,
      close.corrected_at ?? null, close.original_expected_cash ?? null, close.original_difference ?? null,
      Number(close.correction_revision) || 0, Number(close.opening_float) || 0,
      Number(close.counted_cash) || 0, Number(close.counted_usd) || 0, Number(close.counted_eur) || 0,
      close.note ?? null, Number(close.withdrawn_cash) || 0, Number(close.withdrawn_transfer) || 0,
      Number(close.withdrawn_usd) || 0, Number(close.withdrawn_eur) || 0,
      Number(close.id), close.client_close_id || `srv-${close.id}`,
    );
  }
}

function applyCashCloseCorrection(db, correction) {
  const close = correction.cash_close;
  if (!close) return false;
  let local = db.prepare('SELECT id FROM cash_closes WHERE server_id = ? OR client_close_id = ?')
    .get(Number(close.id), close.client_close_id || `srv-${close.id}`);
  if (!local) {
    const inserted = db.prepare(`INSERT INTO cash_closes
      (server_id, client_close_id, origin, register_id, opened_at, closed_at, opening_float,
       expected_cash, counted_cash, difference, expected_transfer, sales_count, note, account_email,
       expected_usd, counted_usd, difference_usd, expected_eur, counted_eur, difference_eur,
       withdrawn_cash, withdrawn_transfer, withdrawn_usd, withdrawn_eur, corrected_at,
       original_expected_cash, original_difference, correction_revision)
      VALUES (?, ?, 'server', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Number(close.id), close.client_close_id || `srv-${close.id}`, close.register_id ?? null,
      close.opened_at, close.closed_at, Number(close.opening_float) || 0,
      Number(close.expected_cash) || 0, Number(close.counted_cash) || 0,
      Number(close.difference) || 0, Number(close.expected_transfer) || 0,
      Number(close.sales_count) || 0, close.note ?? null, close.account_email ?? null,
      Number(close.expected_usd) || 0, Number(close.counted_usd) || 0,
      Number(close.difference_usd) || 0, Number(close.expected_eur) || 0,
      Number(close.counted_eur) || 0, Number(close.difference_eur) || 0,
      Number(close.withdrawn_cash) || 0, Number(close.withdrawn_transfer) || 0,
      Number(close.withdrawn_usd) || 0, Number(close.withdrawn_eur) || 0,
      close.corrected_at ?? null, close.original_expected_cash ?? null,
      close.original_difference ?? null, Number(close.correction_revision) || 0,
    );
    local = { id: Number(inserted.lastInsertRowid) };
  }
  db.prepare(`UPDATE cash_closes SET opening_float = ?, expected_cash = ?, counted_cash = ?,
    difference = ?, expected_transfer = ?, sales_count = ?, note = ?, expected_usd = ?,
    counted_usd = ?, difference_usd = ?, expected_eur = ?, counted_eur = ?, difference_eur = ?,
    withdrawn_cash = ?, withdrawn_transfer = ?, withdrawn_usd = ?, withdrawn_eur = ?,
    corrected_at = ?, original_expected_cash = ?, original_difference = ?, correction_revision = ?
    WHERE id = ?`).run(
    Number(close.opening_float) || 0, Number(close.expected_cash) || 0, Number(close.counted_cash) || 0,
    Number(close.difference) || 0, Number(close.expected_transfer) || 0, Number(close.sales_count) || 0,
    close.note ?? null, Number(close.expected_usd) || 0, Number(close.counted_usd) || 0,
    Number(close.difference_usd) || 0, Number(close.expected_eur) || 0, Number(close.counted_eur) || 0,
    Number(close.difference_eur) || 0, Number(close.withdrawn_cash) || 0,
    Number(close.withdrawn_transfer) || 0, Number(close.withdrawn_usd) || 0,
    Number(close.withdrawn_eur) || 0, close.corrected_at ?? null,
    close.original_expected_cash ?? null, close.original_difference ?? null,
    Number(close.correction_revision) || 0, local.id,
  );
  if (correction.id != null) {
    db.prepare(`INSERT OR IGNORE INTO cash_close_corrections
      (server_id, cash_close_server_id, correction_revision, account_id, account_email, before, after, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Number(correction.id), Number(close.id), Number(correction.correction_revision),
      correction.account_id ?? null, correction.account_email ?? null,
      typeof correction.before === 'string' ? correction.before : JSON.stringify(correction.before),
      typeof correction.after === 'string' ? correction.after : JSON.stringify(correction.after),
      correction.created_at,
    );
  }
  return true;
}

function applyCashCloseCorrectionLocal(correction) {
  // PUT responde { cash_close, correction }; el delta entrega la fila de
  // auditoría con cash_close anidado. Aceptar ambos contratos evita que la
  // corrección inmediata dependa de esperar el próximo delta.
  if (correction?.cash_close && !correction.id && correction.correction) {
    correction = { ...correction.correction, cash_close: correction.cash_close };
  }
  const db = getLocalDb();
  return db.transaction(() => applyCashCloseCorrection(db, correction))();
}

function applyCashCloseDetailLocal(detail) {
  const db = getLocalDb();
  const close = detail?.cash_close || detail;
  if (!close?.id) return false;
  const corrections = detail?.corrections || [];
  return db.transaction(() => {
    let updated = false;
    for (const correction of corrections) {
      updated = applyCashCloseCorrection(db, { ...correction, cash_close: close }) || updated;
    }
    // A GET can refresh the current close without a correction row in older
    // servers or in an uncorrected close.
    if (!updated) updated = applyCashCloseCorrection(db, { cash_close: close }) || false;
    return updated;
  })();
}

/** Corrección recién hecha desde esta caja: se aplica sin esperar al delta. */
function applySaleCorrectionLocal(correction) {
  const db = getLocalDb();
  db.transaction(() => applySaleCorrection(db, correction))();
}

// ---------------------------------------------------------------------------
// Catálogo recibido del servidor
// ---------------------------------------------------------------------------

/**
 * Productos locales con cambios propios que todavía no subieron: los que
 * aparecen en una operación pendiente del outbox (su alta, una edición, un
 * borrado, o una línea de una venta o de un arqueo).
 *
 * 'conflict' NO cuenta a propósito: una operación que el servidor ya rechazó
 * no va a cambiar el stock de allá, así que la verdad es la del servidor. Si
 * contara, un solo rechazo dejaría ese producto sin actualizarse para siempre.
 */
function productsWithPendingChanges(db) {
  const ids = new Set();
  const rows = db.prepare(`SELECT payload FROM outbox WHERE status IN ('pending', 'syncing')`).all();
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch (_) { continue; }
    if (payload.local_product_id != null) ids.add(Number(payload.local_product_id));
    for (const item of payload.items || []) {
      if (item.local_product_id != null) ids.add(Number(item.local_product_id));
    }
  }
  return ids;
}

/**
 * Aplica el catálogo del servidor a esta caja: altas, cambios de precio y de
 * stock, y productos borrados en la web.
 *
 * La regla que evita perder ventas: un producto con cambios locales que todavía
 * no subieron NO se toca en esta pasada. Si la caja vendió 2 sin internet, el
 * servidor sigue diciendo "10"; copiar ese número borraría la venta del stock
 * local y se podría vender lo que ya no hay. Cuando esas operaciones suben, la
 * pasada siguiente lo actualiza con el número que ya las incluye.
 *
 * Los productos creados aquí que aún no tienen server_id tampoco se tocan: el
 * servidor todavía no sabe que existen.
 *
 * Si el servidor devuelve la lista vacía no se borra nada. Un dueño que borre
 * todo su catálogo es rarísimo; una caja que se queda sin productos en medio
 * de la jornada por una respuesta anómala es un desastre.
 */
function applyServerCatalog(serverProducts) {
  if (!Array.isArray(serverProducts)) throw new Error('El catálogo del servidor no es una lista');

  const db = getLocalDb();
  const stats = { created: 0, updated: 0, removed: 0, skipped: 0 };

  const apply = db.transaction(() => {
    const pending = productsWithPendingChanges(db);
    // Primero las filas visibles: si hay una copia oculta con el mismo
    // server_id (un duplicado que se unió al sincronizar), manda la visible.
    const locals = db.prepare(
      'SELECT * FROM products WHERE server_id IS NOT NULL ORDER BY deleted ASC, id ASC'
    ).all();
    const byServerId = new Map();
    for (const p of locals) if (!byServerId.has(p.server_id)) byServerId.set(p.server_id, p);

    const insert = db.prepare(`
      INSERT INTO products (server_id, name, purchase_price, sale_price, stock, unit, track_stock, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE products SET name = ?, purchase_price = ?, sale_price = ?, stock = ?, unit = ?, track_stock = ?, deleted = 0 WHERE id = ?
    `);

    const seen = new Set();
    for (const s of serverProducts) {
      const serverId = Number(s.id);
      seen.add(serverId);
      // Una unidad que esta versión no conoce se trata como "por unidad": mejor
      // vender de menos precisión que bloquear el catálogo entero.
      const unit = UNITS.includes(s.unit) ? s.unit : null;
      const stock = Math.max(0, Number(s.stock) || 0);
      const values = [
        String(s.name),
        Number(s.purchase_price) || 0,
        Number(s.sale_price) || 0,
        unit ? round3(stock) : Math.trunc(stock),
        unit,
        // Un servidor que no lo manda es de antes de esta opción: se controla.
        unit && (s.track_stock === 0 || s.track_stock === false) ? 0 : 1,
      ];

      const local = byServerId.get(serverId);
      if (!local) {
        const createdAt = s.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19);
        insert.run(serverId, ...values, createdAt);
        stats.created++;
        continue;
      }
      if (pending.has(local.id)) { stats.skipped++; continue; }

      const differs =
        local.deleted === 1 ||
        local.name !== values[0] ||
        local.purchase_price !== values[1] ||
        local.sale_price !== values[2] ||
        local.stock !== values[3] ||
        (local.unit ?? null) !== values[4] ||
        (local.track_stock ?? 1) !== values[5];
      if (differs) {
        update.run(...values, local.id);
        stats.updated++;
      }
    }

    if (serverProducts.length > 0) {
      const remove = db.prepare('UPDATE products SET deleted = 1 WHERE id = ?');
      for (const local of locals) {
        if (local.deleted || seen.has(local.server_id) || pending.has(local.id)) continue;
        remove.run(local.id);
        stats.removed++;
      }
    }
  });

  apply();
  stats.changed = stats.created + stats.updated + stats.removed > 0;
  return stats;
}

/**
 * Devuelve a 'pending' las operaciones que quedaron en 'syncing'.
 *
 * Una pasada del sync worker nunca empieza con otra en curso (el loop espera a
 * que termine para programar la siguiente), así que cualquier 'syncing' al
 * empezar es de una pasada que se cortó: la app se cerró o se colgó a mitad de
 * una petición. Antes quedaban así para siempre, porque getPendingOutbox solo
 * lee 'pending' y 'conflict'.
 *
 * Reintentarlas es seguro: ventas, cierres y arqueos llevan su id de
 * idempotencia, y un alta de producto repetida la une el servidor por nombre.
 */
function resetStuckSyncing() {
  return getLocalDb().prepare(`UPDATE outbox SET status = 'pending' WHERE status = 'syncing'`).run().changes;
}

/**
 * Descuenta stock de un producto (para transferencias a almacén).
 * Nunca baja de 0. Productos sin unidad se mantienen como enteros.
 * Retorna la fila actualizada o null si no existe.
 */
function takeLocalStock(productId, quantity) {
  const db = getLocalDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(productId);
  if (!product) return null;

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0) return null;

  let newStock;
  if (product.unit) {
    // Productos por peso: mantener 3 decimales
    newStock = round3(Math.max(0, Number(product.stock) - qty));
  } else {
    // Productos por unidad: mantener como entero
    newStock = Math.trunc(Math.max(0, Number(product.stock) - qty));
  }

  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, productId);
  return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
}

module.exports = {
  getSession, setSession, updateSessionSettings, clearSession,
  getSyncState, setSyncState, getRegisterId, prepareDeltaSession, applyServerDelta, applySaleCorrectionLocal,
  applyCashCloseCorrectionLocal, applyCashCloseDetailLocal,
  getPendingOutbox, countPendingOutbox, enqueueOutbox, resetStuckSyncing,
  listProducts, getDayStock, applyServerDayStock, createProduct, updateProduct, deleteProduct, listStockEntries, importProducts, listWarehouse, applyServerWarehouse, transferWarehouseLocal, applyServerCatalog, takeLocalStock,
  createSaleLocal, listSales, getSale,
  createCurrencyPurchaseLocal, listCurrencyPurchases,
  createWithdrawalLocal, listWithdrawals, voidWithdrawalLocal,
  getDashboard, pendingHoldings,
  getCurrentCashPeriod, createCashCloseLocal, getCashClose, getCashCloseDetail, listCashCloses, cashCloseSummary,
  createInventoryCountLocal, listInventoryCounts, getInventoryCount,
};
