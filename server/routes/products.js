const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireOwner } = require('../middleware/auth');
const { describeAccount } = require('../lib/account');

// Leer el catálogo lo necesita cualquiera que cobre: es la pantalla del POS.
//
// DAR DE ALTA un producto nuevo también lo puede hacer un empleado: muchos
// dueños delegan la carga de la mercancía que llega. Lo que queda para el
// dueño es EDITAR y BORRAR los que ya existen — un empleado que pudiera bajar
// un precio tendría la forma más simple de quedarse con la diferencia.
router.get('/', asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM products WHERE user_id = ? ORDER BY name ASC',
    args: [req.userId],
  });
  res.json(result.rows);
}));

/**
 * Alta de un producto. Si ya existe uno con el mismo nombre —sin distinguir
 * mayúsculas, acentos ni espacios, igual que la importación— NO se crea otro:
 * se devuelve el existente con `merged: true` y sin tocar su precio ni su stock.
 *
 * Eso cubre tres casos reales:
 *   - la cajera, sin internet, crea "arroz (1 lb)" que el dueño ya había cargado;
 *   - la caja reintenta un alta cuya respuesta se perdió (sin id de
 *     idempotencia, antes eso creaba un duplicado en el servidor);
 *   - un empleado que intentara "cambiar" un precio creando el producto de nuevo.
 * El precio y el stock del existente mandan: lo decidido para el negocio es que
 * gane lo que ya cargó el dueño.
 *
 * Límite conocido: dos altas simultáneas con el mismo nombre pueden colarse
 * ambas (la comparación normalizada no se puede expresar como índice UNIQUE en
 * SQLite). En una tienda con una o dos cajas es muy improbable.
 */
router.post('/', asyncHandler(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
  const { purchase_price, sale_price, stock } = req.body;

  if (!name || sale_price === undefined || sale_price === null || sale_price === '') {
    return res.status(400).json({ error: 'Nombre y precio de venta son requeridos' });
  }
  const sale = Number(sale_price);
  if (!Number.isFinite(sale) || sale < 0) {
    return res.status(400).json({ error: 'El precio de venta no es válido' });
  }
  const hasPurchase = purchase_price !== undefined && purchase_price !== null && purchase_price !== '';
  const purchase = hasPurchase ? Number(purchase_price) : 0;
  if (!Number.isFinite(purchase) || purchase < 0) {
    return res.status(400).json({ error: 'El precio de compra no es válido' });
  }
  if (stock !== undefined && stock !== null && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
    return res.status(400).json({ error: 'El stock debe ser un número entero mayor o igual a 0' });
  }

  const db = getDb();

  // normalizeName se define más abajo, junto a la importación: misma regla.
  const key = normalizeName(name);
  const existingResult = await db.execute({
    sql: 'SELECT * FROM products WHERE user_id = ?',
    args: [req.userId],
  });
  const existing = existingResult.rows.find((p) => normalizeName(p.name) === key);
  if (existing) {
    return res.status(200).json({ ...existing, merged: true });
  }

  const account = await describeAccount(db, req);
  const insertResult = await db.execute({
    sql: `INSERT INTO products
            (user_id, name, purchase_price, sale_price, stock, created_by_account_id, created_by_email)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [req.userId, name, purchase, sale, Number(stock) || 0, account.id, account.email],
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
