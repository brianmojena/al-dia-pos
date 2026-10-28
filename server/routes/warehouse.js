const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { withOperation } = require('../lib/clientOperations');
const { requireOwner } = require('../middleware/auth');
const { describeAccount } = require('../lib/account');
const { parseUnit, validQuantity, roundQty } = require('../lib/units');

/**
 * Almacén. Cualquier cuenta lo ve, lo modifica (alta, edición, reposición,
 * importación, borrado) y TRANSFIERE mercancía en ambas direcciones (a la tienda
 * y desde la tienda). Cada cambio deja un registro con quién lo hizo, que solo
 * revisa la cuenta principal. Un artículo tiene costo y cantidad: no tiene precio
 * de venta.
 */

const normalizeName = (name) =>
  String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
const cleanName = (name) => (typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '');
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : NaN; };

router.get('/', asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM warehouse_items WHERE user_id = ? ORDER BY name ASC',
    args: [req.userId],
  });
  res.json(result.rows);
}));

// Historial de transferencias: solo el dueño, que es quien revisa faltantes.
router.get('/transfers', requireOwner, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM warehouse_transfers WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
    args: [req.userId],
  });
  res.json(result.rows);
}));

// Historial de cambios al almacén: igual, solo el dueño.
router.get('/changes', requireOwner, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM warehouse_changes WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
    args: [req.userId],
  });
  res.json(result.rows);
}));

const logChange = (userId, account, action, itemName, detail) => ({
  sql: 'INSERT INTO warehouse_changes (user_id, action, item_name, detail, account_id, account_email) VALUES (?, ?, ?, ?, ?, ?)',
  args: [userId, action, itemName, detail ?? null, account.id, account.email],
});

const findByName = async (db, userId, name, exceptId = null) => {
  const key = normalizeName(name);
  const rows = (await db.execute({ sql: 'SELECT * FROM warehouse_items WHERE user_id = ?', args: [userId] })).rows;
  return rows.find((r) => normalizeName(r.name) === key && Number(r.id) !== Number(exceptId)) || null;
};

router.post('/', asyncHandler((req, res) => withOperation(req, res, async (db, res) => {
  const name = cleanName(req.body.name);
  const unit = parseUnit(req.body.unit);
  if (unit === false) return res.status(400).json({ error: 'La unidad de medida no es válida (kg, g o lb)' });
  if (!name) return res.status(400).json({ error: 'Falta el nombre del artículo' });
  const cost = money(req.body.cost ?? 0);
  if (Number.isNaN(cost)) return res.status(400).json({ error: 'El costo no es válido' });
  const quantity = req.body.quantity === undefined || req.body.quantity === '' ? 0 : req.body.quantity;
  if (!validQuantity(quantity, unit)) {
    return res.status(400).json({ error: unit ? 'La cantidad debe ser un número mayor o igual a 0 (hasta 3 decimales)' : 'La cantidad debe ser un entero mayor o igual a 0' });
  }
  if (await findByName(db, req.userId, name)) {
    return res.status(409).json({ error: 'Ya hay un artículo con ese nombre en el almacén' });
  }
  const account = await describeAccount(db, req);
  const inserted = await db.execute({
    sql: 'INSERT INTO warehouse_items (user_id, name, unit, cost, quantity, created_by_email) VALUES (?, ?, ?, ?, ?, ?)',
    args: [req.userId, name, unit ?? null, cost, roundQty(quantity), account.email],
  });
  await db.execute(logChange(req.userId, account, 'alta', name, `cantidad ${roundQty(quantity)}, costo ${cost}`));
  const row = await db.execute({ sql: 'SELECT * FROM warehouse_items WHERE id = ?', args: [Number(inserted.lastInsertRowid)] });
  res.status(201).json(row.rows[0]);
})));

/**
 * Carga masiva del almacén (solo la cuenta principal). Mismo criterio que la
 * de productos: un artículo con el mismo nombre se ACTUALIZA en vez de
 * duplicarse; costo y cantidad vacíos significan "no cambiar" en uno existente
 * y 0 en uno nuevo. stock_mode 'sumar' suma la cantidad a la que hay; cualquier
 * otro valor la reemplaza. Todo va en un solo batch: entra todo o nada.
 */
const MAX_IMPORT_ROWS = 2000;
const optionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

router.post('/import', asyncHandler((req, res) => withOperation(req, res, async (db, res) => {
  const { items } = req.body;
  const addQty = req.body.stock_mode === 'sumar';
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No hay artículos para importar' });
  if (items.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: `Máximo ${MAX_IMPORT_ROWS} artículos por importación` });

  const existingRows = (await db.execute({ sql: 'SELECT * FROM warehouse_items WHERE user_id = ?', args: [req.userId] })).rows;
  const existing = new Map();
  for (const row of existingRows) if (!existing.has(normalizeName(row.name))) existing.set(normalizeName(row.name), row);

  const errors = [];
  const clean = [];
  const seen = new Set();
  items.forEach((item, index) => {
    const fail = (error) => errors.push({ index, error });
    const name = cleanName(item?.name);
    if (!name) return fail('Falta el nombre');
    if (name.length > 120) return fail(`"${name.slice(0, 30)}…": nombre demasiado largo`);
    const key = normalizeName(name);
    if (seen.has(key)) return fail(`"${name}": aparece repetido`);
    seen.add(key);
    const prior = existing.get(key) || null;

    const blankUnit = item.unit === undefined || item.unit === null || item.unit === '';
    // Sin unidad en el archivo, un artículo existente conserva la suya.
    const parsedUnit = blankUnit && prior ? (prior.unit ?? null) : parseUnit(item.unit);
    if (parsedUnit === false) return fail(`"${name}": la unidad no es válida (kg, g o lb)`);
    const unit = parsedUnit === undefined ? null : parsedUnit;
    if (prior && (prior.unit ?? null) !== unit) return fail(`"${name}": ya está en el almacén con otra unidad de medida`);

    const cost = optionalNumber(item.cost);
    if (Number.isNaN(cost) || (cost !== null && cost < 0)) return fail(`"${name}": costo no válido`);
    const quantity = optionalNumber(item.quantity);
    if (Number.isNaN(quantity) || (quantity !== null && !validQuantity(quantity, unit))) {
      return fail(`"${name}": ${unit ? 'la cantidad debe ser mayor o igual a 0 (hasta 3 decimales)' : 'la cantidad debe ser un entero mayor o igual a 0'}`);
    }
    clean.push({ name, key, unit, cost, quantity: quantity === null ? null : roundQty(quantity), prior });
  });
  if (errors.length > 0) return res.status(400).json({ error: 'Hay filas con errores; no se importó nada', errors });

  const account = await describeAccount(db, req);
  let created = 0, updated = 0;
  const statements = clean.map((p) => {
    if (p.prior) {
      updated++;
      return {
        sql: `UPDATE warehouse_items SET cost = COALESCE(?, cost),
                quantity = ${addQty ? 'ROUND(quantity + COALESCE(?, 0), 3)' : 'COALESCE(?, quantity)'}
              WHERE id = ? AND user_id = ?`,
        args: [p.cost, p.quantity, p.prior.id, req.userId],
      };
    }
    created++;
    return {
      sql: 'INSERT INTO warehouse_items (user_id, name, unit, cost, quantity, created_by_email) VALUES (?, ?, ?, ?, ?, ?)',
      args: [req.userId, p.name, p.unit, p.cost ?? 0, p.quantity ?? 0, account.email],
    };
  });
  statements.push(logChange(req.userId, account, 'importación', `${clean.length} artículos`, `${created} nuevos, ${updated} actualizados${addQty ? ' (cantidades sumadas)' : ''}`));
  await db.batch(statements, 'write');
  res.json({ created, updated, total: clean.length });
})));

router.put('/:id', asyncHandler((req, res) => withOperation(req, res, async (db, res) => {
  const found = await db.execute({ sql: 'SELECT * FROM warehouse_items WHERE id = ? AND user_id = ?', args: [req.params.id, req.userId] });
  const existing = found.rows[0];
  if (!existing) return res.status(404).json({ error: 'Artículo no encontrado' });

  const name = req.body.name === undefined ? existing.name : cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Falta el nombre del artículo' });
  const parsedUnit = parseUnit(req.body.unit);
  if (parsedUnit === false) return res.status(400).json({ error: 'La unidad de medida no es válida (kg, g o lb)' });
  const unit = parsedUnit === undefined ? (existing.unit ?? null) : parsedUnit;
  const cost = req.body.cost === undefined ? Number(existing.cost) : money(req.body.cost);
  if (Number.isNaN(cost)) return res.status(400).json({ error: 'El costo no es válido' });
  if (await findByName(db, req.userId, name, existing.id)) {
    return res.status(409).json({ error: 'Ya hay un artículo con ese nombre en el almacén' });
  }
  // Reponer va como cantidad a sumar (no como total) para no pisar una
  // transferencia que ocurra al mismo tiempo.
  const add = req.body.add_quantity;
  const hasAdd = add !== undefined && add !== null && add !== '';
  if (hasAdd && (!validQuantity(add, unit) || Number(add) <= 0)) {
    return res.status(400).json({ error: unit ? 'La cantidad a añadir debe ser mayor que 0 (hasta 3 decimales)' : 'La cantidad a añadir debe ser un entero mayor que 0' });
  }
  let quantity = existing.quantity;
  if (req.body.quantity !== undefined && !hasAdd) {
    if (!validQuantity(req.body.quantity, unit)) {
      return res.status(400).json({ error: unit ? 'La cantidad debe ser un número mayor o igual a 0 (hasta 3 decimales)' : 'La cantidad debe ser un entero mayor o igual a 0' });
    }
    quantity = roundQty(req.body.quantity);
  }
  if (!unit && !hasAdd && !Number.isInteger(Number(quantity))) {
    return res.status(400).json({ error: 'Al quitar la unidad de medida hay que poner la cantidad en piezas enteras' });
  }
  const account = await describeAccount(db, req);
  const changes = [];
  if (name !== existing.name) changes.push(`nombre «${existing.name}» → «${name}»`);
  if (cost !== Number(existing.cost)) changes.push(`costo ${existing.cost} → ${cost}`);
  if ((unit ?? null) !== (existing.unit ?? null)) changes.push(`unidad ${existing.unit ?? 'pieza'} → ${unit ?? 'pieza'}`);
  if (hasAdd) changes.push(`repuso ${Number(add)}`);
  else if (Number(quantity) !== Number(existing.quantity)) changes.push(`cantidad ${existing.quantity} → ${quantity}`);
  await db.batch([
    {
      sql: `UPDATE warehouse_items SET name = ?, unit = ?, cost = ?,
              quantity = ${hasAdd ? 'ROUND(quantity + ?, 3)' : '?'} WHERE id = ?`,
      args: [name, unit, cost, hasAdd ? Number(add) : quantity, existing.id],
    },
    ...(changes.length ? [logChange(req.userId, account, hasAdd && changes.length === 1 ? 'reposición' : 'edición', name, changes.join('; '))] : []),
  ], 'write');
  const row = await db.execute({ sql: 'SELECT * FROM warehouse_items WHERE id = ?', args: [existing.id] });
  res.json(row.rows[0]);
})));

router.delete('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const found = (await db.execute({ sql: 'SELECT * FROM warehouse_items WHERE id = ? AND user_id = ?', args: [req.params.id, req.userId] })).rows[0];
  if (!found) return res.status(404).json({ error: 'Artículo no encontrado' });
  const account = await describeAccount(db, req);
  await db.batch([
    { sql: 'DELETE FROM warehouse_items WHERE id = ? AND user_id = ?', args: [found.id, req.userId] },
    logChange(req.userId, account, 'borrado', found.name, `quedaban ${found.quantity}, costo ${found.cost}`),
  ], 'write');
  res.json({ success: true });
}));

/**
 * Transferencia almacén -> tienda, cualquier cuenta. Todo en una transacción:
 * baja el almacén (con UPDATE condicional, así dos transferencias a la vez no
 * dejan cantidades negativas), sube el stock del producto de la tienda —lo crea
 * si no existe, con su precio de venta— y deja el registro con direction='to_store'.
 * Idempotente por client_transfer_id: la caja de escritorio reintenta.
 */
router.post('/transfer', asyncHandler(async (req, res) => {
  const { warehouse_item_id, client_transfer_id = null } = req.body;
  const db = getDb();
  const itemResult = await db.execute({
    sql: 'SELECT * FROM warehouse_items WHERE id = ? AND user_id = ?',
    args: [warehouse_item_id ?? null, req.userId],
  });
  const item = itemResult.rows[0];

  if (client_transfer_id) {
    const dup = await db.execute({
      sql: 'SELECT * FROM warehouse_transfers WHERE user_id = ? AND client_transfer_id = ?',
      args: [req.userId, client_transfer_id],
    });
    if (dup.rows[0]) return res.status(200).json({ ...dup.rows[0], idempotent_replay: true });
  }
  if (!item) return res.status(404).json({ error: 'Artículo no encontrado en el almacén' });

  const unit = item.unit ?? null;
  const qty = req.body.quantity;
  if (!validQuantity(qty, unit) || Number(qty) <= 0) {
    return res.status(400).json({ error: unit ? 'La cantidad debe ser mayor que 0 (hasta 3 decimales)' : 'La cantidad debe ser un entero mayor que 0' });
  }
  const quantity = roundQty(qty);
  if (quantity > Number(item.quantity)) {
    return res.status(409).json({ error: `En el almacén solo hay ${item.quantity} de ${item.name}` });
  }

  const products = (await db.execute({ sql: 'SELECT * FROM products WHERE user_id = ?', args: [req.userId] })).rows;
  const key = normalizeName(item.name);
  const product = products.find((p) => normalizeName(p.name) === key) || null;
  let salePrice = null;
  if (!product) {
    const raw = req.body.sale_price;
    salePrice = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(salePrice) || salePrice < 0) {
      return res.status(400).json({ error: 'Este producto aún no está en la tienda: indica su precio de venta', needs_sale_price: true });
    }
  } else if ((product.unit ?? null) !== unit) {
    return res.status(409).json({ error: 'El producto de la tienda tiene otra unidad de medida que el del almacén' });
  }

  const account = await describeAccount(db, req);
  const tx = await db.transaction('write');
  try {
    const down = await tx.execute({
      sql: 'UPDATE warehouse_items SET quantity = ROUND(quantity - ?, 3) WHERE id = ? AND quantity >= ?',
      args: [quantity, item.id, quantity],
    });
    if (!down.rowsAffected) {
      await tx.rollback();
      return res.status(409).json({ error: `En el almacén ya no hay suficiente ${item.name}` });
    }
    let productId, created = 0;
    if (product) {
      productId = Number(product.id);
      // Un producto por peso sin control de stock no acumula cantidad.
      if (!unit || Number(product.track_stock ?? 1) === 1) {
        await tx.execute({ sql: 'UPDATE products SET stock = ROUND(stock + ?, 3) WHERE id = ?', args: [quantity, productId] });
      }
    } else {
      const ins = await tx.execute({
        sql: `INSERT INTO products (user_id, name, purchase_price, sale_price, stock, unit, track_stock, created_by_account_id, created_by_email)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        args: [req.userId, item.name, item.cost, salePrice, quantity, unit, account.id, account.email],
      });
      productId = Number(ins.lastInsertRowid);
      created = 1;
    }
    const log = await tx.execute({
      sql: `INSERT INTO warehouse_transfers
              (user_id, client_transfer_id, warehouse_item_id, product_id, item_name, quantity, unit_cost, created_product, account_id, account_email, direction)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [req.userId, client_transfer_id, item.id, productId, item.name, quantity, item.cost, created, account.id, account.email, 'to_store'],
    });
    await tx.commit();
    const row = await db.execute({ sql: 'SELECT * FROM warehouse_transfers WHERE id = ?', args: [Number(log.lastInsertRowid)] });
    res.status(201).json(row.rows[0]);
  } catch (err) {
    await tx.rollback().catch(() => {});
    if (client_transfer_id && /UNIQUE/i.test(String(err.message))) {
      const dup = await db.execute({
        sql: 'SELECT * FROM warehouse_transfers WHERE user_id = ? AND client_transfer_id = ?',
        args: [req.userId, client_transfer_id],
      });
      if (dup.rows[0]) return res.status(200).json({ ...dup.rows[0], idempotent_replay: true });
    }
    throw err;
  }
}));

/**
 * Transferencia tienda -> almacén, cualquier cuenta. Espejo de /transfer:
 * baja el stock del producto de la tienda (con UPDATE condicional), suma o crea
 * el artículo del almacén y deja el registro con direction='to_warehouse'.
 * Idempotente por client_transfer_id: la tienda reintenta.
 */
router.post('/from-store', asyncHandler(async (req, res) => {
  const { product_id, client_transfer_id = null } = req.body;
  const db = getDb();
  const productResult = await db.execute({
    sql: 'SELECT * FROM products WHERE id = ? AND user_id = ?',
    args: [product_id ?? null, req.userId],
  });
  const product = productResult.rows[0];

  if (client_transfer_id) {
    const dup = await db.execute({
      sql: 'SELECT * FROM warehouse_transfers WHERE user_id = ? AND client_transfer_id = ?',
      args: [req.userId, client_transfer_id],
    });
    if (dup.rows[0]) return res.status(200).json({ ...dup.rows[0], idempotent_replay: true });
  }
  if (!product) return res.status(404).json({ error: 'Producto no encontrado en la tienda' });

  const unit = product.unit ?? null;
  if (unit && Number(product.track_stock ?? 1) === 0) {
    return res.status(400).json({ error: 'Este producto no lleva control de stock: no se puede pasar al almacén' });
  }

  const qty = req.body.quantity;
  if (!validQuantity(qty, unit) || Number(qty) <= 0) {
    return res.status(400).json({ error: unit ? 'La cantidad debe ser mayor que 0 (hasta 3 decimales)' : 'La cantidad debe ser un entero mayor que 0' });
  }
  const quantity = roundQty(qty);
  if (quantity > Number(product.stock)) {
    return res.status(409).json({ error: `En la tienda solo hay ${product.stock} de ${product.name}` });
  }

  const item = await findByName(db, req.userId, product.name);
  if (item && (item.unit ?? null) !== unit) {
    return res.status(409).json({ error: 'El artículo del almacén tiene otra unidad de medida que el producto de la tienda' });
  }

  const account = await describeAccount(db, req);
  const tx = await db.transaction('write');
  try {
    const down = await tx.execute({
      sql: 'UPDATE products SET stock = ROUND(stock - ?, 3) WHERE id = ? AND user_id = ? AND stock >= ?',
      args: [quantity, product.id, req.userId, quantity],
    });
    if (!down.rowsAffected) {
      await tx.rollback();
      return res.status(409).json({ error: `En la tienda ya no hay suficiente ${product.name}` });
    }
    let warehouse_item_id, created = 0;
    if (item) {
      warehouse_item_id = Number(item.id);
      await tx.execute({ sql: 'UPDATE warehouse_items SET quantity = ROUND(quantity + ?, 3) WHERE id = ?', args: [quantity, warehouse_item_id] });
    } else {
      const ins = await tx.execute({
        sql: 'INSERT INTO warehouse_items (user_id, name, unit, cost, quantity, created_by_email) VALUES (?, ?, ?, ?, ?, ?)',
        args: [req.userId, product.name, unit, Number(product.purchase_price) || 0, quantity, account.email],
      });
      warehouse_item_id = Number(ins.lastInsertRowid);
      created = 1;
    }
    const log = await tx.execute({
      sql: `INSERT INTO warehouse_transfers
              (user_id, client_transfer_id, warehouse_item_id, product_id, item_name, quantity, unit_cost, created_product, account_id, account_email, direction)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [req.userId, client_transfer_id, warehouse_item_id, product.id, product.name, quantity, product.purchase_price, created, account.id, account.email, 'to_warehouse'],
    });
    await tx.commit();
    const row = await db.execute({ sql: 'SELECT * FROM warehouse_transfers WHERE id = ?', args: [Number(log.lastInsertRowid)] });
    res.status(201).json(row.rows[0]);
  } catch (err) {
    await tx.rollback().catch(() => {});
    if (client_transfer_id && /UNIQUE/i.test(String(err.message))) {
      const dup = await db.execute({
        sql: 'SELECT * FROM warehouse_transfers WHERE user_id = ? AND client_transfer_id = ?',
        args: [req.userId, client_transfer_id],
      });
      if (dup.rows[0]) return res.status(200).json({ ...dup.rows[0], idempotent_replay: true });
    }
    throw err;
  }
}));

module.exports = router;
