const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireOwner } = require('../middleware/auth');

// Leer el catálogo lo necesita cualquiera que cobre: es la pantalla del POS.
// Crear, editar y borrar es del dueño — un cajero que pudiera cambiar precios
// tendría la forma más simple que existe de quedarse con la diferencia.
router.get('/', asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM products WHERE user_id = ? ORDER BY name ASC',
    args: [req.userId],
  });
  res.json(result.rows);
}));

router.post('/', requireOwner, asyncHandler(async (req, res) => {
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

/**
 * Carga masiva desde una hoja de cálculo (el cliente ya la interpretó y mostró
 * la vista previa; aquí se vuelve a validar todo, porque el cliente no es de
 * fiar).
 *
 * Un producto que ya existe con el mismo nombre —sin distinguir mayúsculas,
 * acentos ni espacios— se ACTUALIZA en vez de duplicarse: así se puede corregir
 * la lista y volver a subirla. Precio de compra y stock vacíos (null) significan
 * "no cambiar" en un producto existente y 0 en uno nuevo.
 *
 * Todo va en un solo db.batch(): una única ida y vuelta a Turso, y o entran
 * todas las filas o ninguna. Con una transacción interactiva serían dos
 * peticiones HTTP por fila, y 300 productos no caben en el tiempo de una función.
 */
const MAX_IMPORT_ROWS = 2000;

const normalizeName = (name) =>
  String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

const optionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

router.post('/import', requireOwner, asyncHandler(async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No hay productos para importar' });
  }
  if (items.length > MAX_IMPORT_ROWS) {
    return res.status(400).json({ error: `Máximo ${MAX_IMPORT_ROWS} productos por importación` });
  }

  const errors = [];
  const clean = [];
  const seen = new Set();

  items.forEach((item, index) => {
    const fail = (error) => errors.push({ index, error });
    const name = typeof item?.name === 'string' ? item.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return fail('Falta el nombre');
    if (name.length > 120) return fail(`"${name.slice(0, 30)}…": nombre demasiado largo`);

    const sale = optionalNumber(item.sale_price);
    if (sale === null || Number.isNaN(sale) || sale < 0) return fail(`"${name}": precio de venta no válido`);

    const purchase = optionalNumber(item.purchase_price);
    if (Number.isNaN(purchase) || (purchase !== null && purchase < 0)) return fail(`"${name}": precio de compra no válido`);

    const stock = optionalNumber(item.stock);
    if (Number.isNaN(stock) || (stock !== null && (!Number.isInteger(stock) || stock < 0))) {
      return fail(`"${name}": el stock tiene que ser un entero mayor o igual a 0`);
    }

    const key = normalizeName(name);
    if (seen.has(key)) return fail(`"${name}": aparece repetido`);
    seen.add(key);

    clean.push({ name, key, sale, purchase, stock });
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Hay filas con errores; no se importó nada', errors });
  }

  const db = getDb();
  const existingResult = await db.execute({
    sql: 'SELECT id, name FROM products WHERE user_id = ?',
    args: [req.userId],
  });
  const existing = new Map();
  for (const row of existingResult.rows) {
    const key = normalizeName(row.name);
    if (!existing.has(key)) existing.set(key, Number(row.id));
  }

  let created = 0;
  let updated = 0;
  const statements = clean.map((p) => {
    const id = existing.get(p.key);
    if (id !== undefined) {
      updated++;
      return {
        sql: `UPDATE products
              SET name = ?, sale_price = ?,
                  purchase_price = COALESCE(?, purchase_price),
                  stock = COALESCE(?, stock)
              WHERE id = ? AND user_id = ?`,
        args: [p.name, p.sale, p.purchase, p.stock, id, req.userId],
      };
    }
    created++;
    return {
      sql: 'INSERT INTO products (user_id, name, purchase_price, sale_price, stock) VALUES (?, ?, ?, ?, ?)',
      args: [req.userId, p.name, p.purchase ?? 0, p.sale, p.stock ?? 0],
    };
  });

  await db.batch(statements, 'write');
  res.json({ created, updated, total: clean.length });
}));

router.put('/:id', requireOwner, asyncHandler(async (req, res) => {
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

router.delete('/:id', requireOwner, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'DELETE FROM products WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.userId],
  });
  if (result.rowsAffected === 0) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ success: true });
}));

module.exports = router;
