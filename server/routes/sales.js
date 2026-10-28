const { operationTime } = require('../lib/operationTime');
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { boundsForDate } = require('../lib/businessDay');
const { describeAccount } = require('../lib/account');
const { requireOwner } = require('../middleware/auth');
const { resolveRegisterId } = require('../lib/register');
const { notifySale } = require('../lib/push');
const { roundQty, validQuantity, lineUnits } = require('../lib/units');
const { PAYMENT_METHODS, paymentSplit, foreignFields, round2 } = require('../lib/payment');
const { correctSale, parseCorrection, CorrectionError } = require('../lib/saleCorrections');
const { operationOf, OperationError } = require('../lib/clientOperations');
const { sharedOperationMatches, sharedSaleResponse } = require('../lib/sharedDevices');

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
  // El cajero recupera su historial personal, incluido el día aún abierto;
  // la proyección nunca incluye ganancias ni costos.
  const cashierScope = req.role === 'cajero'
    ? ' AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))'
    : '';
  const columns = req.role === 'cajero'
    ? 'id, client_sale_id, total, payment_method, transfer_amount, foreign_currency, foreign_amount, exchange_rate, shop_rate, cash_received, created_at, register_id, cash_close_id'
    : '*';
  const argsFor = (dateArgs) => req.role === 'cajero'
    ? [...dateArgs, req.accountId, req.accountId]
    : dateArgs;
  // El filtro por fecha usa el día del negocio en Cuba, igual que el dashboard.
  const dia = date ? boundsForDate(date) : null;
  const result = dia
    ? await db.execute({
        sql: `SELECT ${columns} FROM sales WHERE user_id = ? AND created_at >= ? AND created_at < ?${cashierScope} ORDER BY created_at DESC`,
        args: argsFor([req.userId, dia.start, dia.end]),
      })
    : await db.execute({
        sql: `SELECT ${columns} FROM sales WHERE user_id = ?${cashierScope} ORDER BY created_at DESC${req.role === 'cajero' ? ', id DESC' : ' LIMIT 200'}`,
        args: argsFor([req.userId]),
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
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      return res.status(400).json({ error: 'Una línea de la venta rechazada no es válida' });
    }
    const productId = item.product_id != null ? Number(item.product_id) : null;
    const givenName = typeof item.product_name === 'string' ? item.product_name.trim().slice(0, 120) : '';
    lines.push({
      product_id: productId,
      product_name: givenName || names.get(productId) || `Producto #${productId ?? '?'}`,
      quantity: roundQty(quantity),
      unit_price: unitPrice,
      ...(Number(item.pack_size) > 1 && { pack_size: Number(item.pack_size) }),
    });
  }
  const total = round2(lines.reduce((sum, l) => sum + round2(l.quantity * l.unit_price), 0));
  const account = await describeAccount(db, req);
  // Igual que el monto transferido: el dinero ya se cobró, así que un aviso
  // con la divisa mal formada se guarda sin ella antes que rechazarlo.
  let foreign = foreignFields({});
  try { foreign = foreignFields(req.body); } catch (_) { /* se guarda sin divisa */ }

  try {
    const inserted = await db.execute({
      sql: `INSERT INTO rejected_sales
              (user_id, client_sale_id, total, payment_method, transfer_amount,
               items, error, sold_at, account_id, account_email,
               foreign_currency, foreign_amount, exchange_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        foreign.foreign_currency, foreign.foreign_amount, foreign.exchange_rate,
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

// --- Correcciones de la cuenta principal ------------------------------------
// También antes de /:id. Con ?date= son las de las ventas de ese día del
// negocio (incluidas las anuladas, que ya no aparecen en la lista de ventas).
router.get('/corrections', requireOwner, asyncHandler(async (req, res) => {
  const dia = req.query.date ? boundsForDate(req.query.date) : null;
  const result = await getDb().execute(dia
    ? {
        sql: `SELECT * FROM sale_corrections WHERE user_id = ? AND sale_created_at >= ? AND sale_created_at < ?
              ORDER BY id DESC`,
        args: [req.userId, dia.start, dia.end],
      }
    : { sql: 'SELECT * FROM sale_corrections WHERE user_id = ? ORDER BY id DESC LIMIT 100', args: [req.userId] });
  res.json(result.rows.map(parseCorrection));
}));

router.get('/:id/corrections', requireOwner, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: 'SELECT * FROM sale_corrections WHERE user_id = ? AND sale_id = ? ORDER BY id DESC',
    args: [req.userId, req.params.id],
  });
  res.json(result.rows.map(parseCorrection));
}));

// Cambiar la forma de pago o anular la venta. Ver server/lib/saleCorrections.js.
router.post('/:id/correct', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  const account = await describeAccount(db, req);
  try {
    const op = operationOf(req);
    const result = await correctSale(db, { userId: req.userId, saleId: req.params.id, body: req.body, account, op });
    res.json(result);
  } catch (error) {
    if (error instanceof CorrectionError || error instanceof OperationError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const columns = req.role === 'cajero'
    ? 'id, client_sale_id, total, payment_method, transfer_amount, foreign_currency, foreign_amount, exchange_rate, shop_rate, cash_received, created_at, register_id, cash_close_id'
    : '*';
  const saleResult = await db.execute({
    sql: `SELECT ${columns} FROM sales WHERE id = ? AND user_id = ?${req.role === 'cajero' ? ' AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))' : ''}`,
    args: req.role === 'cajero' ? [req.params.id, req.userId, req.accountId, req.accountId] : [req.params.id, req.userId],
  });
  const sale = saleResult.rows[0];
  if (!sale) return res.status(404).json({ error: 'Venta no encontrada' });
  const itemsResult = await db.execute({
    sql: req.role === 'cajero'
      ? 'SELECT i.id, i.sale_id, i.product_id, i.product_name, i.quantity, i.unit_price, i.pack_size, p.unit FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = ?'
      : 'SELECT * FROM sale_items WHERE sale_id = ?',
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
    register_id: requestedRegisterId = null, transfer_amount = null, cash_received = null,
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La venta debe tener al menos un producto' });
  }

  // La forma de cobro solo puede ser efectivo, transferencia, mixto o divisa:
  // el techo del dueño y el desglose de la caja dependen de este valor.
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

  // Cobro en divisa: cuántos billetes, de qué moneda y a qué tasa. Que los
  // billetes alcancen o no da igual: lo que falte lo pone el cliente en pesos
  // y lo que sobre sale de vuelto (ver server/lib/payment.js).
  let foreign;
  try { foreign = foreignFields(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const db = getDb();

  // Idempotencia (camino rápido): si el POS reintenta una venta que sí llegó a
  // registrarse — porque se perdió la respuesta, no la petición — devolvemos la
  // venta original en vez de cobrar dos veces.
  if (client_sale_id) {
    const existing = await findByClientSaleId(db, req.userId, client_sale_id);
    if (existing.rows[0]) {
      if (!sharedOperationMatches(req, existing.rows[0])) return res.status(409).json({ error: 'Este identificador de venta pertenece a otra caja o cajero' });
      return res.status(200).json({ ...sharedSaleResponse(req, existing.rows[0]), idempotent_replay: true });
    }
  }

  // El techo de transferencia lo fija el dueño (PUT /api/auth/settings) y se
  // valida aquí, no solo en la pantalla del POS: la cola offline y la app de
  // escritorio también cobran por esta vía.
  const shopResult = await db.execute({
    sql: 'SELECT transfer_limit, usd_rate, eur_rate FROM users WHERE id = ?',
    args: [req.userId],
  });
  const transferLimit = shopResult.rows[0]?.transfer_limit ?? null;

  // La tasa de la tienda la manda el aparato: es la que conocía al cobrar,
  // que puede ser de ayer si cobró sin internet. Solo un cliente que no sabe
  // de tasas (no la manda) se compara contra la tasa de hoy.
  if (foreign.foreign_currency && !('shop_rate' in req.body)) {
    const current = shopResult.rows[0]?.[foreign.foreign_currency === 'USD' ? 'usd_rate' : 'eur_rate'];
    foreign.shop_rate = current ?? null;
  }

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
      if (!Number.isFinite(quantity) || quantity <= 0) {
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
        sql: 'SELECT id, name, purchase_price, stock, unit, track_stock FROM products WHERE id = ? AND user_id = ?',
        args: [item.product_id, req.userId],
      });
      const product = productResult.rows[0];
      if (!product) {
        await tx.rollback();
        return res.status(400).json({ error: 'Producto no existe' });
      }

      // Línea vendida como paquete: quantity son paquetes enteros y del stock
      // salen quantity × pack_size sueltos. El tamaño viaja en la línea (el que
      // vio la caja al cobrar), no se relee del producto: una venta sin internet
      // no cambia si después el dueño cambia el paquete.
      const packSize = item.pack_size == null || item.pack_size === '' ? null : Number(item.pack_size);
      if (packSize !== null) {
        if (product.unit || !Number.isInteger(packSize) || packSize < 2 || packSize > 10000 || !Number.isInteger(quantity)) {
          await tx.rollback();
          return res.status(400).json({ error: `Paquete inválido para ${product.name}` });
        }
      }
      const stockQty = lineUnits({ quantity, pack_size: packSize });
      const stockDelta = product.unit
        ? Number(product.track_stock) === 1 ? -roundQty(Math.min(Number(product.stock) || 0, quantity)) : 0
        : -stockQty;
      const unitCost = packSize ? round2(product.purchase_price * packSize) : (product.purchase_price || 0);
      // Solo un producto por peso admite fracciones (hasta 3 decimales); uno por
      // pieza sigue vendiéndose en unidades enteras.
      if (!validQuantity(quantity, product.unit, { min: 0.001 })) {
        await tx.rollback();
        return res.status(400).json({
          error: product.unit
            ? `Cantidad inválida para ${product.name} (usa hasta 3 decimales)`
            : `${product.name} se vende por unidades enteras`,
        });
      }

      // Descuento condicional: el propio UPDATE comprueba el stock. Si otra venta
      // simultánea se adelantó, rowsAffected es 0 y abortamos — el stock nunca
      // puede quedar negativo por esta vía.
      //
      // Un producto por peso nunca bloquea la venta: se pesa y se cobra aunque
      // el stock no esté al día. Si lleva control, baja hasta 0; si no, no se toca.
      if (product.unit) {
        if (Number(product.track_stock) === 1) {
          await tx.execute({
            sql: 'UPDATE products SET stock = MAX(0, ROUND(stock - ?, 3)) WHERE id = ? AND user_id = ?',
            args: [quantity, item.product_id, req.userId],
          });
        }
      } else {
        const updated = await tx.execute({
          sql: 'UPDATE products SET stock = ROUND(stock - ?, 3) WHERE id = ? AND user_id = ? AND ROUND(stock, 3) >= ?',
          args: [stockQty, item.product_id, req.userId, stockQty],
        });
        if (updated.rowsAffected !== 1) {
          await tx.rollback();
          return res.status(409).json({ error: `Stock insuficiente para ${product.name}` });
        }
      }

      // Cada línea se redondea a centavos: es el importe que el cliente ve y
      // paga, y el total tiene que ser exactamente la suma de lo que se ve.
      total  += round2(quantity * unitPrice);
      profit += round2(quantity * (unitPrice - unitCost));
      lines.push({
        product_id: product.id,
        product_name: packSize ? `${product.name} (paquete de ${packSize})` : product.name,
        quantity: roundQty(quantity),
        unit_price: unitPrice,
        unit_cost: packSize ? unitCost : product.purchase_price || 0,
        pack_size: packSize,
        stock_delta: stockDelta,
      });
    }

    total = round2(total);
    profit = round2(profit);

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

    // Efectivo recibido del cliente: solo se guarda si el pago es en efectivo.
    // En otros métodos se ignora y se guarda NULL.
    let finalCashReceived = null;
    if (payment_method === 'efectivo') {
      if (cash_received !== null && cash_received !== undefined && cash_received !== '') {
        const cashReceivedNum = Number(cash_received);
        if (!Number.isFinite(cashReceivedNum)) {
          await tx.rollback();
          return res.status(400).json({ error: 'Efectivo recibido inválido' });
        }
        const cashReceivedRounded = round2(cashReceivedNum);
        // Menos que el total (p. ej. un precio cambió mientras la venta esperaba
        // en la cola sin internet): la venta ya se cobró, no se pierde; solo se
        // descarta este dato en vez de rechazarla.
        if (cashReceivedRounded >= total) finalCashReceived = cashReceivedRounded;
      }
    }

    const saleResult = await tx.execute({
      sql: `INSERT INTO sales
              (user_id, client_sale_id, total, profit, payment_method, transfer_amount,
               foreign_currency, foreign_amount, exchange_rate, shop_rate, cash_received,
               register_id, account_id, account_email, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      args: [req.userId, client_sale_id, total, profit, payment_method, transferAmount,
             foreign.foreign_currency, foreign.foreign_amount, foreign.exchange_rate, foreign.shop_rate,
             finalCashReceived, registerId, account.id, account.email, operationDate],
    });
    const saleId = Number(saleResult.lastInsertRowid);

    for (const line of lines) {
      // stock_delta conserva lo que el UPDATE aplicó realmente; en una venta
      // por peso puede ser menor que quantity por el clamp a cero.
      if (line.pack_size == null) {
        await tx.execute({
          sql: 'INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost, stock_delta) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [saleId, line.product_id, line.product_name, line.quantity, line.unit_price, line.unit_cost, line.stock_delta],
        });
      } else {
        await tx.execute({
          sql: 'INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost, pack_size, stock_delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          args: [saleId, line.product_id, line.product_name, line.quantity, line.unit_price, line.unit_cost, line.pack_size, line.stock_delta],
        });
      }
    }

    await tx.commit();

    const finalResult = await db.execute({ sql: 'SELECT * FROM sales WHERE id = ?', args: [saleId] });
    // Aviso al teléfono del dueño. Se espera (con tope) antes de responder: en
    // Vercel la función se congela al enviar la respuesta y un envío "en
    // segundo plano" se perdería. Nunca hace fallar el cobro.
    await notifySale(db, req.userId, finalResult.rows[0]);
    return res.status(201).json(sharedSaleResponse(req, finalResult.rows[0]));
  } catch (err) {
    await tx.rollback().catch(() => { /* la transacción ya estaba cerrada */ });

    // Dos peticiones idénticas a la vez: ambas pasaron el camino rápido y una perdió
    // la carrera contra el índice UNIQUE. Devolvemos la que sí se registró.
    if (client_sale_id && isUniqueViolation(err)) {
      const existing = await findByClientSaleId(db, req.userId, client_sale_id);
      if (existing.rows[0]) {
        if (!sharedOperationMatches(req, existing.rows[0])) return res.status(409).json({ error: 'Este identificador de venta pertenece a otra caja o cajero' });
        return res.status(200).json({ ...sharedSaleResponse(req, existing.rows[0]), idempotent_replay: true });
      }
    }
    throw err;
  }
}));

module.exports = router;
