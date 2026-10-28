const { operationTime } = require('../lib/operationTime');
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { describeAccount } = require('../lib/account');
const { requireOwner } = require('../middleware/auth');
const { validQuantity, roundQty } = require('../lib/units');
const { stockChangeStatement } = require('../lib/stockLog');
const { operationOf, replay, record, OperationError } = require('../lib/clientOperations');

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

// GET endpoints are owner-only (list and detail of counts).
// POST is allowed to any authenticated user (account_email records who counted).

router.get('/', requireOwner, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM inventory_counts WHERE user_id = ? ORDER BY counted_at DESC LIMIT 100',
    args: [req.userId],
  });
  res.json(result.rows);
}));

router.get('/:id', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  const countResult = await db.execute({
    sql: 'SELECT * FROM inventory_counts WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.userId],
  });
  const count = countResult.rows[0];
  if (!count) return res.status(404).json({ error: 'Arqueo no encontrado' });

  const items = await loadItems(db, count.id);

  // Para cada línea, comprobar si el mismo producto se volvió a contar después en un arqueo más nuevo.
  // Más nuevo = counted_at posterior, o mismo counted_at pero id posterior.
  const newerCounts = await db.execute({
    sql: `SELECT DISTINCT product_id FROM inventory_count_items
          WHERE count_id IN (
            SELECT id FROM inventory_counts
            WHERE user_id = ? AND (
              counted_at > ? OR
              (counted_at = ? AND id > ?)
            )
          )`,
    args: [req.userId, count.counted_at, count.counted_at, count.id],
  });
  const recounteProductIds = new Set(newerCounts.rows.map(r => r.product_id));

  const itemsWithRecounted = items.rows.map(item => ({
    ...item,
    recounted_later: recounteProductIds.has(item.product_id),
  }));

  res.json({ ...count, items: itemsWithRecounted });
}));

router.post('/', asyncHandler(async (req, res) => {
  let operationDate;
  try { operationDate = operationTime(req.body.counted_at); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const { items, note = null, client_count_id = null } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Hay que contar al menos un producto' });
  }

  // Aquí solo se comprueba que sea un número >= 0; si exige entero o admite
  // decimales (producto por peso) se decide abajo, con el producto delante.
  for (const item of items) {
    const counted = Number(item.counted);
    if (item.counted === null || item.counted === '' || !Number.isFinite(counted) || counted < 0) {
      return res.status(400).json({ error: 'Las cantidades contadas deben ser números mayores o iguales a 0' });
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
        sql: 'SELECT id, name, stock, unit, track_stock, purchase_price, sale_price FROM products WHERE id = ? AND user_id = ?',
        args: [item.product_id, req.userId],
      });
      const product = productResult.rows[0];
      if (!product) {
        await tx.rollback();
        return res.status(400).json({ error: 'Producto no existe' });
      }
      if (product.unit && Number(product.track_stock) !== 1) {
        await tx.rollback();
        return res.status(400).json({ error: `${product.name} no lleva control de stock` });
      }
      if (!validQuantity(counted, product.unit)) {
        await tx.rollback();
        return res.status(400).json({
          error: product.unit
            ? `La cantidad contada de ${product.name} admite hasta 3 decimales`
            : `${product.name} se cuenta en unidades enteras`,
        });
      }

      const expected = Number(product.stock);
      const difference = roundQty(counted - expected);

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
               units_missing, units_extra, value_missing, note, account_id, account_email, counted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      args: [req.userId, client_count_id, lines.length, withDifference,
             roundQty(unitsMissing), roundQty(unitsExtra), Math.round(valueMissing * 100) / 100, note, account.id, account.email, operationDate],
    });
    const countId = Number(inserted.lastInsertRowid);

    for (const line of lines) {
      await tx.execute({
        sql: `INSERT INTO inventory_count_items
                (count_id, product_id, product_name, expected, counted, difference, initial_difference, unit_cost, unit_price)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [countId, line.product_id, line.product_name, line.expected,
               line.counted, line.difference, line.difference, line.unit_cost, line.unit_price],
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

// PUT /:id - Corregir líneas de un arqueo anterior (solo el dueño)
router.put('/:id', requireOwner, asyncHandler(async (req, res) => {
  const { items: updateItems } = req.body;

  if (!Array.isArray(updateItems)) {
    return res.status(400).json({ error: 'items debe ser un array' });
  }

  const db = getDb();

  // Validar que el arqueo existe y pertenece al usuario.
  const countResult = await db.execute({
    sql: 'SELECT * FROM inventory_counts WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.userId],
  });
  const count = countResult.rows[0];
  if (!count) return res.status(404).json({ error: 'Arqueo no encontrado' });

  // No se pueden corregir arqueos pendientes de sincronizar (id < 0 o negative).
  if (Number(count.id) < 0) {
    return res.status(400).json({
      error: 'Pendiente de sincronizar: aún no se puede corregir.',
    });
  }

  // Validar que todos los item_id pertenecen a este arqueo.
  const existingItems = await db.execute({
    sql: 'SELECT id, product_id FROM inventory_count_items WHERE count_id = ?',
    args: [count.id],
  });
  const existingItemIds = new Set(existingItems.rows.map(i => i.id));
  const existingProductIds = new Map(existingItems.rows.map(i => [i.id, i.product_id]));

  for (const item of updateItems) {
    if (!Number.isFinite(item.item_id) || !Number.isFinite(item.counted)) {
      return res.status(400).json({
        error: 'item_id y counted deben ser números válidos',
      });
    }
    if (item.counted < 0) {
      return res.status(400).json({
        error: 'Las cantidades contadas deben ser ≥ 0',
      });
    }
    if (!existingItemIds.has(item.item_id)) {
      return res.status(400).json({
        error: 'Una línea no pertenece a este arqueo',
      });
    }
  }

  // Detectar duplicados en updateItems.
  const itemIds = updateItems.map(i => i.item_id);
  if (new Set(itemIds).size !== itemIds.length) {
    return res.status(400).json({
      error: 'Un item aparece repetido en la corrección',
    });
  }

  let op;
  try { op = operationOf(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }

  const tx = await db.transaction('write');
  try {
    const prior = op && await replay(tx, op);
    if (prior) {
      await tx.rollback();
      return res.json(prior.body);
    }
    // Comprobar si algún producto se volvió a contar en un arqueo más nuevo.
    const newerCountsResult = await tx.execute({
      sql: `SELECT DISTINCT product_id FROM inventory_count_items
            WHERE count_id IN (
              SELECT id FROM inventory_counts
              WHERE user_id = ? AND (
                counted_at > ? OR
                (counted_at = ? AND id > ?)
              )
            )`,
      args: [req.userId, count.counted_at, count.counted_at, count.id],
    });
    const newerProductIds = new Set(newerCountsResult.rows.map(r => r.product_id));

    // Cargar las líneas que se van a corregir.
    const linesToCorrect = await tx.execute({
      sql: `SELECT * FROM inventory_count_items
            WHERE count_id = ? AND id IN (${updateItems.map(() => '?').join(',')})`,
      args: [count.id, ...updateItems.map(i => i.item_id)],
    });
    const linesByItemId = new Map(linesToCorrect.rows.map(line => [line.id, line]));

    // Validar que ningún producto a corregir aparece en un arqueo más nuevo.
    for (const item of updateItems) {
      const line = linesByItemId.get(item.item_id);
      if (newerProductIds.has(line.product_id)) {
        await tx.rollback();
        // Obtener el nombre del producto fuera de la transacción.
        const newerProduct = await db.execute({
          sql: 'SELECT name FROM products WHERE id = ? LIMIT 1',
          args: [line.product_id],
        });
        const productName = newerProduct.rows[0]?.name || 'el producto';
        return res.status(409).json({
          error: `${productName} se volvió a contar en un arqueo más nuevo; corrígelo allí`,
        });
      }
    }

    // Obtener el producto y stock actual para cada línea a corregir.
    const correctionDetails = [];
    for (const item of updateItems) {
      const line = linesByItemId.get(item.item_id);
      const productResult = await tx.execute({
        sql: 'SELECT id, name, stock, unit, track_stock, sale_price FROM products WHERE id = ? AND user_id = ?',
        args: [line.product_id, req.userId],
      });
      const product = productResult.rows[0];

      // Comprobar que el producto existe y sigue llevando control de stock.
      if (!product) {
        await tx.rollback();
        return res.status(400).json({
          error: 'Producto no existe',
        });
      }
      if (product.unit && Number(product.track_stock) !== 1) {
        await tx.rollback();
        return res.status(400).json({
          error: `${product.name} no lleva control de stock`,
        });
      }

      // Validar la nueva cantidad.
      const counted = Number(item.counted);
      if (!validQuantity(counted, product.unit)) {
        await tx.rollback();
        return res.status(400).json({
          error: product.unit
            ? `La cantidad contada de ${product.name} admite hasta 3 decimales`
            : `${product.name} se cuenta en unidades enteras`,
        });
      }

      // Solo procesar si cambió.
      if (Number(line.counted) === counted) continue;

      correctionDetails.push({
        itemId: item.item_id,
        line,
        product,
        currentStock: Number(product.stock),
        oldCounted: Number(line.counted),
        newCounted: counted,
      });
    }

    // Si no hay cambios, devolver el arqueo sin modificar.
    if (correctionDetails.length === 0) {
      await tx.rollback();
      const items = await loadItems(db, count.id);
      const newerCounts = await db.execute({
        sql: `SELECT DISTINCT product_id FROM inventory_count_items
              WHERE count_id IN (
                SELECT id FROM inventory_counts
                WHERE user_id = ? AND (
                  counted_at > ? OR
                  (counted_at = ? AND id > ?)
                )
              )`,
        args: [req.userId, count.counted_at, count.counted_at, count.id],
      });
      const recounteProductIds = new Set(newerCounts.rows.map(r => r.product_id));
      const itemsWithRecounted = items.rows.map(item => ({
        ...item,
        recounted_later: recounteProductIds.has(item.product_id),
      }));
      return res.json({ ...count, items: itemsWithRecounted });
    }

    // Aplicar correcciones: actualizar stock y línea.
    const account = await describeAccount(db, req);

    for (const detail of correctionDetails) {
      const { itemId, line, product, currentStock, oldCounted, newCounted } = detail;

      // Cambio esperado: con la corrección, la diferencia NEW = newCounted - expected.
      const oldDifference = roundQty(oldCounted - line.expected);
      const newDifference = roundQty(newCounted - line.expected);

      // Stock nuevo: oldCounted fue ajustado, ahora corregimos a newCounted.
      // Si oldCounted = 10 y el stock está a 10, corrección a 12 deja stock en 12.
      // Fórmula: newStock = currentStock + (newCounted - oldCounted).
      const newStock = roundQty(Math.max(0, currentStock + (newCounted - oldCounted)));

      // Actualizar el stock del producto.
      await tx.execute({
        sql: 'UPDATE products SET stock = ? WHERE id = ? AND user_id = ?',
        args: [newStock, product.id, req.userId],
      });

      // Anotar en stock_entries.
      const reason = `Corrección del arqueo del ${new Date(count.counted_at).toLocaleDateString('es-ES')}`;
      const correction = stockChangeStatement({
        userId: req.userId,
        product: { id: product.id, name: product.name },
        before: currentStock,
        after: newStock,
        account,
        kind: 'correccion',
        reason,
      });
      if (correction) {
        await tx.execute(correction);
      }

      // Actualizar la línea: counted y difference.
      await tx.execute({
        sql: `UPDATE inventory_count_items SET counted = ?, difference = ?
              WHERE id = ?`,
        args: [newCounted, newDifference, itemId],
      });
    }

    // Recomputar agregados del arqueo desde todas sus líneas (POST hace lo mismo).
    const allItemsAfter = await tx.execute({
      sql: 'SELECT counted, expected, difference, unit_price FROM inventory_count_items WHERE count_id = ?',
      args: [count.id],
    });

    let newLineCount = allItemsAfter.rows.length;
    let newWithDifference = 0;
    let newUnitsMissing = 0;
    let newUnitsExtra = 0;
    let newValueMissing = 0;

    for (const item of allItemsAfter.rows) {
      const diff = roundQty(Number(item.difference) || 0);
      if (diff !== 0) {
        newWithDifference += 1;
        if (diff < 0) {
          newUnitsMissing += -diff;
          newValueMissing += (-diff) * Number(item.unit_price || 0);
        } else {
          newUnitsExtra += diff;
        }
      }
    }

    // Actualizar los agregados del arqueo.
    await tx.execute({
      sql: `UPDATE inventory_counts
            SET lines_count = ?, products_with_difference = ?,
                units_missing = ?, units_extra = ?, value_missing = ?
            WHERE id = ?`,
      args: [newLineCount, newWithDifference, roundQty(newUnitsMissing),
             roundQty(newUnitsExtra), Math.round(newValueMissing * 100) / 100, count.id],
    });

    // Devolver el arqueo actualizado con recounted_later.
    const updatedCount = await tx.execute({
      sql: 'SELECT * FROM inventory_counts WHERE id = ?',
      args: [count.id],
    });
    const updatedItems = await loadItems(tx, count.id);
    const newerCounts = await tx.execute({
      sql: `SELECT DISTINCT product_id FROM inventory_count_items
            WHERE count_id IN (
              SELECT id FROM inventory_counts
              WHERE user_id = ? AND (
                counted_at > ? OR
                (counted_at = ? AND id > ?)
              )
            )`,
      args: [req.userId, count.counted_at, count.counted_at, count.id],
    });
    const recounteProductIds = new Set(newerCounts.rows.map(r => r.product_id));
    const itemsWithRecounted = updatedItems.rows.map(item => ({
      ...item,
      recounted_later: recounteProductIds.has(item.product_id),
    }));

    const result = { ...updatedCount.rows[0], items: itemsWithRecounted };
    if (op) await record(tx, op, 200, result);
    await tx.commit();
    res.json(result);
  } catch (err) {
    await tx.rollback().catch(() => { /* la transacción ya estaba cerrada */ });
    if (err instanceof OperationError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

module.exports = router;
