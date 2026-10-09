const { operationTime } = require('../lib/operationTime');
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { boundsForDate } = require('../lib/businessDay');
const { describeAccount } = require('../lib/account');
const { requireOwner } = require('../middleware/auth');
const { resolveRegisterId } = require('../lib/register');
const { PAYMENT_METHODS, paymentSplit, round2 } = require('../lib/payment');

const isUniqueViolation = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
};

const findByClientSaleId = (db, userId, clientSaleId) =>
  db.execute({
    sql: 'SELECT * FROM sales WHERE user_id = ? AND client_sale_id = ?',
    args: [userId, clientSaleId],
  });

router.get('/', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  const { date } = req.query;
  // El filtro por fecha usa el día del negocio en Cuba, igual que el dashboard.
  const dia = date ? boundsForDate(date) : null;
  const result = dia
    ? await db.execute({
        sql: 'SELECT * FROM sales WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC',
        args: [req.userId, dia.start, dia.end],
      })
    : await db.execute({
        sql: 'SELECT * FROM sales WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
        args: [req.userId],
      });
  res.json(result.rows);
}));

// --- Ventas rechazadas -------------------------------------------------------
// Estas rutas van ANTES de /:id: si no, GET /rejected lo capturaría el detalle.

const MAX_REJECTED_ITEMS = 200;

const parseRejected = (row) => {
  let items = [];
  try { items = JSON.parse(row.items); } catch (_) { /* fila vieja o dañada */ }
  return { ...row, items };
};

/**
 * La app del empleado avisa de una venta que cobró SIN internet y que este
 * servidor rechazó al subirla (ver client/src/lib/salesQueue.js). Decisión del
 * negocio: esas ventas no se descartan — el dinero se cobró — sino que quedan
 * a la vista del dueño para que las revise.
 *
 * La puede reportar cualquier cuenta de la tienda: quien cobró es justo el
 * empleado. Es idempotente por client_sale_id, porque el teléfono reintenta el
 * aviso si se corta la conexión. El total se calcula aquí con cantidades y
 * precios; no se acepta el que mande el teléfono.
 */
router.post('/rejected', asyncHandler(async (req, res) => {
  const {
    client_sale_id, items, payment_method, transfer_amount = null, error = null, sold_at = null,
  } = req.body;

  if (!client_sale_id || typeof client_sale_id !== 'string') {
    return res.status(400).json({ error: 'Falta el identificador de la venta' });
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_REJECTED_ITEMS) {
    return res.status(400).json({ error: 'La venta rechazada no tiene líneas válidas' });
  }

  const db = getDb();

  // Si la venta sí llegó a registrarse (se reintentó y esa vez hubo stock), no
  // hay nada que reportar: el teléfono la quita de su lista.
  const registered = await findByClientSaleId(db, req.userId, client_sale_id);
  if (registered.rows[0]) {
    return res.status(200).json({ already_registered: true, sale_id: registered.rows[0].id });
  }

  const productsResult = await db.execute({
    sql: 'SELECT id, name FROM products WHERE user_id = ?',
    args: [req.userId],
  });
  const names = new Map(productsResult.rows.map((p) => [Number(p.id), p.name]));

  const lines = [];
  for (const item of items) {
    const quantity = Number(item?.quantity);
    const unitPrice = Number(item?.unit_price);
    if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      return res.status(400).json({ error: 'Una línea de la venta rechazada no es válida' });
    }
    const productId = item.product_id != null ? Number(item.product_id) : null;
    const givenName = typeof item.product_name === 'string' ? item.product_name.trim().slice(0, 120) : '';
    lines.push({
      product_id: productId,
      product_name: givenName || names.get(productId) || `Producto #${productId ?? '?'}`,
      quantity,
      unit_price: unitPrice,
    });
  }
  const total = lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
  const account = await describeAccount(db, req);

  try {
    const inserted = await db.execute({
      sql: `INSERT INTO rejected_sales
              (user_id, client_sale_id, total, payment_method, transfer_amount,
               items, error, sold_at, account_id, account_email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        req.userId, client_sale_id, total,
        PAYMENT_METHODS.includes(payment_method) ? payment_method : 'efectivo',
        // El dinero ya se cobró: el aviso guarda lo que diga el teléfono, sin
        // rechazarlo por un monto raro. Solo tiene sentido en un cobro mixto.
        payment_method === 'mixto' && Number.isFinite(Number(transfer_amount)) ? round2(transfer_amount) : null,
        JSON.stringify(lines),
        typeof error === 'string' ? error.slice(0, 300) : null,
        typeof sold_at === 'string' ? sold_at.slice(0, 40) : null,
        account.id, account.email,
      ],
    });
    const row = await db.execute({
      sql: 'SELECT * FROM rejected_sales WHERE id = ?',
      args: [Number(inserted.lastInsertRowid)],
    });
    return res.status(201).json(parseRejected(row.rows[0]));
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.execute({
        sql: 'SELECT * FROM rejected_sales WHERE user_id = ? AND client_sale_id = ?',
        args: [req.userId, client_sale_id],
      });
      if (existing.rows[0]) return res.status(200).json(parseRejected(existing.rows[0]));
    }
    throw err;
  }
}));

// Solo el dueño: dice cuánto dinero se cobró fuera del sistema.
router.get('/rejected', requireOwner, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: `SELECT * FROM rejected_sales WHERE user_id = ?
          ORDER BY (reviewed_at IS NOT NULL) ASC, reported_at DESC LIMIT 100`,
    args: [req.userId],
  });
  res.json(result.rows.map(parseRejected));
}));

router.post('/rejected/:id/review', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  const updated = await db.execute({
    sql: `UPDATE rejected_sales SET reviewed_at = COALESCE(reviewed_at, datetime('now'))
          WHERE id = ? AND user_id = ?`,
    args: [req.params.id, req.userId],
  });
  if (updated.rowsAffected === 0) return res.status(404).json({ error: 'Venta rechazada no encontrada' });
  const row = await db.execute({ sql: 'SELECT * FROM rejected_sales WHERE id = ?', args: [req.params.id] });
  res.json(parseRejected(row.rows[0]));
}));

router.get('/:id', requireOwner, asyncHandler(async (req, res) => {
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
  let operationDate;
  try { operationDate = operationTime(req.body.sold_at); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const {
    items, payment_method = 'efectivo', client_sale_id = null,
    register_id: requestedRegisterId = null, transfer_amount = null,
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La venta debe tener al menos un producto' });
  }

  // La forma de cobro solo puede ser efectivo, transferencia o mixto: el techo
  // del dueño y el desglose de la caja dependen de este valor.
  if (!PAYMENT_METHODS.includes(payment_method)) {
    return res.status(400).json({ error: 'Forma de pago inválida' });
  }

  // En un cobro mixto el teléfono manda cuánto se transfirió; el efectivo es el
  // resto. Que quede dentro del total se comprueba más abajo, cuando el total
  // ya está calculado con los precios de cada línea.
  const transferAmount = payment_method === 'mixto' ? round2(transfer_amount) : null;
  if (payment_method === 'mixto'
      && (transfer_amount === null || !Number.isFinite(Number(transfer_amount)) || transferAmount <= 0)) {
    return res.status(400).json({ error: 'Falta el monto transferido del cobro mixto' });
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

  // El techo de transferencia lo fija el dueño (PUT /api/auth/settings) y se
  // valida aquí, no solo en la pantalla del POS: la cola offline y la app de
  // escritorio también cobran por esta vía.
  const shopResult = await db.execute({
    sql: 'SELECT transfer_limit FROM users WHERE id = ?',
    args: [req.userId],
  });
  const transferLimit = shopResult.rows[0]?.transfer_limit ?? null;

  // Fuera de la transacción a propósito: es una lectura por clave primaria y
  // la cuenta que cobra no cambia a mitad del cobro.
  const account = await describeAccount(db, req);
  const registerId = resolveRegisterId(req, requestedRegisterId);

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

    // Un cobro mixto con 0 en una de las partes no es mixto: el POS lo manda
    // como efectivo o transferencia puro. Si llega así es un cliente roto o un
    // precio que cambió por el camino, y aceptarlo dejaría efectivo negativo.
    if (payment_method === 'mixto' && transferAmount >= total) {
      await tx.rollback();
      return res.status(400).json({ error: 'El monto transferido tiene que ser menor que el total' });
    }

    // Techo de transferencia (inclusivo): el total exacto pasa, por encima se
    // bloquea sin descontar stock — la transacción se revierte completa. En un
    // cobro mixto el techo mira solo la parte transferida: el efectivo no pasa
    // por el banco.
    const transferPart = paymentSplit({ payment_method, total, transfer_amount: transferAmount }).transfer;
    if (transferLimit !== null && transferLimit !== undefined && transferPart > transferLimit) {
      await tx.rollback();
      return res.status(403).json({
        error: payment_method === 'mixto'
          ? `La parte en transferencia supera el límite ($${transferLimit})`
          : `Transferencia por encima del límite ($${transferLimit})`,
      });
    }

    const saleResult = await tx.execute({
      sql: `INSERT INTO sales
              (user_id, client_sale_id, total, profit, payment_method, transfer_amount,
               register_id, account_id, account_email, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      args: [req.userId, client_sale_id, total, profit, payment_method, transferAmount,
             registerId, account.id, account.email, operationDate],
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
