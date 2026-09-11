const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { describeAccount } = require('../lib/account');
const { requireOwner } = require('../middleware/auth');

/**
 * Arqueo de inventario.
 *
 * El dueño cuenta lo que hay en el estante; el sistema compara contra lo que
 * creía tener, deja constancia de la diferencia y ajusta el stock a la
 * realidad. Ese ajuste es el punto: sin él la base se queda equivocada para
 * siempre y el mismo faltante reaparece en cada conteo. Pero ajustar sin dejar
 * registro borraría justamente la evidencia, así que las dos cosas van juntas
 * y en la misma transacción.
 *
 * Es un conteo PARCIAL por diseño: se cuentan los productos que se quieran, no
 * hay que barrer las 200 referencias para cerrar un arqueo. En una tienda real
 * se cuenta lo caro y lo que se sospecha, no todo cada noche.
 *
 * Todo es de dueño: un cajero que pudiera declarar el conteo taparía su propio
 * faltante escribiendo el número que el sistema espera.
 */

const isUniqueViolation = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
};

const findByClientCountId = (db, userId, clientCountId) =>
  db.execute({
    sql: 'SELECT * FROM inventory_counts WHERE user_id = ? AND client_count_id = ?',
    args: [userId, clientCountId],
  });

const loadItems = (db, countId) =>
  db.execute({
    sql: 'SELECT * FROM inventory_count_items WHERE count_id = ? ORDER BY difference ASC, product_name ASC',
    args: [countId],
  });

router.use(requireOwner);

router.get('/', asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM inventory_counts WHERE user_id = ? ORDER BY counted_at DESC LIMIT 100',
    args: [req.userId],
  });
  res.json(result.rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const countResult = await db.execute({
    sql: 'SELECT * FROM inventory_counts WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.userId],
  });
  const count = countResult.rows[0];
  if (!count) return res.status(404).json({ error: 'Arqueo no encontrado' });

  const items = await loadItems(db, count.id);
  res.json({ ...count, items: items.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { items, note = null, client_count_id = null } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Hay que contar al menos un producto' });
  }

  for (const item of items) {
    const counted = Number(item.counted);
    if (!Number.isInteger(counted) || counted < 0) {
      return res.status(400).json({ error: 'Las cantidades contadas deben ser números enteros mayores o iguales a 0' });
    }
  }

  // Un mismo producto dos veces en el mismo arqueo dejaría el resultado a
  // merced del orden de aplicación.
  const ids = items.map((i) => Number(i.product_id));
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'Un producto aparece repetido en el conteo' });
  }

  const db = getDb();

  if (client_count_id) {
    const existing = await findByClientCountId(db, req.userId, client_count_id);
    if (existing.rows[0]) {
      const previos = await loadItems(db, existing.rows[0].id);
      return res.status(200).json({ ...existing.rows[0], items: previos.rows, idempotent_replay: true });
    }
  }

  const account = await describeAccount(db, req);

  const tx = await db.transaction('write');
  try {
    const lines = [];
    let unitsMissing = 0;
    let unitsExtra = 0;
    let valueMissing = 0;
    let withDifference = 0;

    for (const item of items) {
      const counted = Number(item.counted);

      // El stock esperado se lee DENTRO de la transacción, no cuando se abrió
      // la pantalla: si entró una venta mientras se contaba, la diferencia se
      // calcula contra el número más fresco y no contra uno ya vencido.
      const productResult = await tx.execute({
        sql: 'SELECT id, name, stock, purchase_price, sale_price FROM products WHERE id = ? AND user_id = ?',
        args: [item.product_id, req.userId],
      });
      const product = productResult.rows[0];
      if (!product) {
        await tx.rollback();
        return res.status(400).json({ error: 'Producto no existe' });
      }

      const expected = Number(product.stock);
      const difference = counted - expected;

      if (difference !== 0) {
        withDifference += 1;
        if (difference < 0) {
          unitsMissing += -difference;
          // Valorizado al precio de VENTA: si la unidad desapareció por una
          // venta que nadie registró, eso es el dinero que debió entrar a la
          // caja. El costo queda guardado en la línea para poder mirarlo desde
          // la otra óptica más adelante.
          valueMissing += -difference * Number(product.sale_price || 0);
        } else {
          unitsExtra += difference;
        }

        // Ajustar el stock a la realidad. Solo se toca lo que cambió.
        await tx.execute({
          sql: 'UPDATE products SET stock = ? WHERE id = ? AND user_id = ?',
          args: [counted, product.id, req.userId],
        });
      }

      lines.push({
        product_id: product.id,
        product_name: product.name,
        expected,
        counted,
        difference,
        unit_cost: Number(product.purchase_price || 0),
        unit_price: Number(product.sale_price || 0),
      });
    }

    const inserted = await tx.execute({
      sql: `INSERT INTO inventory_counts
              (user_id, client_count_id, lines_count, products_with_difference,
               units_missing, units_extra, value_missing, note, account_id, account_email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [req.userId, client_count_id, lines.length, withDifference,
             unitsMissing, unitsExtra, valueMissing, note, account.id, account.email],
    });
    const countId = Number(inserted.lastInsertRowid);

    for (const line of lines) {
      await tx.execute({
        sql: `INSERT INTO inventory_count_items
                (count_id, product_id, product_name, expected, counted, difference, unit_cost, unit_price)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [countId, line.product_id, line.product_name, line.expected,
               line.counted, line.difference, line.unit_cost, line.unit_price],
      });
    }

    await tx.commit();

    const final = await db.execute({
      sql: 'SELECT * FROM inventory_counts WHERE id = ?',
      args: [countId],
    });
    const finalItems = await loadItems(db, countId);
    return res.status(201).json({ ...final.rows[0], items: finalItems.rows });
  } catch (err) {
    await tx.rollback().catch(() => { /* la transacción ya estaba cerrada */ });

    if (client_count_id && isUniqueViolation(err)) {
      const existing = await findByClientCountId(db, req.userId, client_count_id);
      if (existing.rows[0]) {
        const previos = await loadItems(db, existing.rows[0].id);
        return res.status(200).json({ ...existing.rows[0], items: previos.rows, idempotent_replay: true });
      }
    }
    throw err;
  }
}));

module.exports = router;
