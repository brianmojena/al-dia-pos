const { operationTime } = require('../lib/operationTime');
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { describeAccount } = require('../lib/account');
const { requireOwner } = require('../middleware/auth');
const { resolveRegisterId } = require('../lib/register');
const { paymentSplit } = require('../lib/payment');

/**
 * Arqueo de caja por CAJA, no por tienda.
 *
 * Cada gaveta física se cuadra contra sus propias ventas: si Yamila y Pedro
 * cobran en dos cajas, cada uno cuenta su efectivo contra lo que vendió él.
 * La cobertura vive en la venta (`sales.cash_close_id`), no en un rango de
 * fechas: una venta queda cerrada por exactamente un arqueo y dos cierres no
 * pueden llevarse la misma.
 *
 * Tres formas de pedir un cierre, según quién lo manda:
 *   - escritorio: trae la lista de client_sale_ids que ya cerró sin red;
 *   - web: trae register_id y cubre las ventas abiertas de esa caja;
 *   - legado (clientes sin register_id): cubre las ventas abiertas sin caja.
 */

// Antes del primer cierre no existe un corte anterior del cual partir. Este
// centinela ordena por debajo de cualquier fecha real ('0000-...' < '2026-...'
// como texto). Hoy solo lo usa el modo legado para describir el período.
const BEGINNING_OF_TIME = '0000-01-01 00:00:00';

const isUniqueViolation = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
};

const findByClientCloseId = (db, userId, clientCloseId) =>
  db.execute({
    sql: 'SELECT * FROM cash_closes WHERE user_id = ? AND client_close_id = ?',
    args: [userId, clientCloseId],
  });

// Frontera global: el corte del último cierre de la tienda. Solo la necesita
// el modo legado para mostrar desde cuándo va el período; qué ventas entran ya
// no depende de fechas sino de `cash_close_id`.
const getPeriodStart = async (executor, userId) => {
  const result = await executor.execute({
    sql: 'SELECT closed_at FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC LIMIT 1',
    args: [userId],
  });
  return result.rows[0]?.closed_at || BEGINNING_OF_TIME;
};

// El último corte de ESTA caja: es donde empieza su período, aunque otra caja
// haya cerrado después.
const getLastCloseForRegister = async (executor, userId, registerId) => {
  const result = registerId
    ? await executor.execute({
        sql: 'SELECT closed_at FROM cash_closes WHERE user_id = ? AND register_id = ? ORDER BY closed_at DESC LIMIT 1',
        args: [userId, registerId],
      })
    : await executor.execute({
        sql: 'SELECT closed_at FROM cash_closes WHERE user_id = ? AND register_id IS NULL ORDER BY closed_at DESC LIMIT 1',
        args: [userId],
      });
  return result.rows[0]?.closed_at || null;
};

// Separado por forma de cobro: solo el efectivo tiene que aparecer físicamente
// en la gaveta; las transferencias se muestran aparte como referencia. Una
// venta mixta aporta a los dos lados.
const summarize = (rows) => ({
  cash: rows.reduce((sum, row) => sum + paymentSplit(row).cash, 0),
  transfer: rows.reduce((sum, row) => sum + paymentSplit(row).transfer, 0),
  count: rows.length,
  first_sale_at: rows[0]?.created_at || null,
});

/**
 * Ventas todavía sin arqueo que le tocan a esta caja.
 *
 * La caja web también se lleva las ventas abiertas SIN caja (register_id NULL):
 * son las cobradas antes de este despliegue, o desde un escritorio viejo que
 * todavía no manda su identidad. Si nadie las tomara quedarían fuera de todo
 * arqueo para siempre. Si después ese escritorio viejo las cierra por ids, el
 * cierre lo deja anotado en `overlap_sales` (ver el POST).
 */
const openSales = async (executor, userId, mode, registerId) => {
  if (mode === 'web') {
    const result = await executor.execute({
      sql: `SELECT * FROM sales WHERE user_id = ? AND cash_close_id IS NULL
            AND (register_id = ? OR register_id IS NULL) ORDER BY created_at ASC, id ASC`,
      args: [userId, registerId],
    });
    return result.rows;
  }
  const result = await executor.execute({
    sql: `SELECT * FROM sales WHERE user_id = ? AND register_id IS NULL
          AND cash_close_id IS NULL ORDER BY created_at ASC, id ASC`,
    args: [userId],
  });
  return result.rows;
};

/**
 * Las ventas de un conjunto EXPLÍCITO de client_sale_id. Lo usa la app de
 * escritorio al subir un cierre que ya calculó sin red.
 *
 * Por qué por ids y no por fechas: a una venta hecha offline el servidor le
 * pone su propia hora de llegada al sincronizar, no la hora real del cobro.
 * Un cierre definido por un rango de fechas no encontraría del otro lado las
 * ventas que en la caja ocurrieron horas antes.
 *
 * Lo que NO se acepta es el expected_cash ya calculado por el cliente: el
 * servidor siempre lo recalcula. Si lo tomara como dato, cualquiera podría
 * mandar contado y esperado iguales y hacer que la caja cuadre siempre, que es
 * justo lo que el conteo a ciegas trata de impedir.
 */
const salesByClientIds = async (executor, userId, ids) => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const result = await executor.execute({
    sql: `SELECT * FROM sales WHERE user_id = ? AND client_sale_id IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: [userId, ...ids],
  });
  return result.rows;
};

const modeFor = (req, clientSaleIds, requestedRegisterId) => {
  if (Array.isArray(clientSaleIds)) return 'desktop';
  return requestedRegisterId != null && resolveRegisterId(req, requestedRegisterId) ? 'web' : 'legacy';
};

const describeOpenPeriod = async (executor, req, requestedRegisterId) => {
  const registerId = resolveRegisterId(req, requestedRegisterId);
  const mode = requestedRegisterId != null && registerId ? 'web' : 'legacy';
  const sales = await openSales(executor, req.userId, mode, registerId);

  if (mode === 'web') {
    const lastClose = await getLastCloseForRegister(executor, req.userId, registerId);
    return {
      sales,
      openedAt: lastClose || sales[0]?.created_at || null,
      isFirstClose: !lastClose,
    };
  }

  const periodStart = await getPeriodStart(executor, req.userId);
  const isFirstClose = periodStart === BEGINNING_OF_TIME;
  return {
    sales,
    openedAt: isFirstClose ? (sales[0]?.created_at || null) : periodStart,
    isFirstClose,
  };
};

// Historial: solo el dueño. Cada fila lleva el efectivo esperado de su
// período, así que dejarlo abierto le daría al cajero justo el número que el
// conteo a ciegas le esconde.
router.get('/', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC LIMIT 100',
    args: [req.userId],
  });
  res.json(result.rows);
}));

/**
 * Descuadres agrupados por quien cerró la caja.
 *
 * Es el motivo por el que se guarda la atribución. Un cierre suelto con un
 * faltante puede ser un vuelto mal dado; el mismo nombre repitiendo faltantes
 * durante un mes es otra cosa. Ordenado por saldo acumulado, así que el peor
 * aparece primero.
 *
 * Se agrupa por account_id, pero se muestra el email congelado en la fila: si
 * el dueño borra al cajero, el historial tiene que seguir diciendo quién fue.
 */
router.get('/summary', requireOwner, asyncHandler(async (req, res) => {
  const result = await getDb().execute({
    sql: `SELECT
            account_id,
            account_email,
            COUNT(*)                        AS closes,
            COALESCE(SUM(difference), 0)    AS total_difference,
            COALESCE(MIN(difference), 0)    AS worst_difference,
            SUM(CASE WHEN difference < -0.5 THEN 1 ELSE 0 END) AS times_short,
            MAX(closed_at)                  AS last_close_at
          FROM cash_closes
          WHERE user_id = ?
          GROUP BY account_id, account_email
          ORDER BY total_difference ASC`,
    args: [req.userId],
  });
  res.json(result.rows);
}));

// Describe el período que está por cerrarse — y NADA MÁS que eso.
//
// Deliberadamente no devuelve el efectivo esperado ni la cantidad de ventas.
// Ese es todo el punto del conteo a ciegas: el cajero declara lo que contó sin
// saber contra qué se va a comparar. Si el monto esperado viajara al navegador
// "solo para mostrarlo después", bastaría con abrir la pestaña de red para
// verlo antes de declarar, y la garantía se caería. El cálculo vive del lado
// del servidor y solo se revela junto con el resultado del arqueo.
router.get('/current', asyncHandler(async (req, res) => {
  const period = await describeOpenPeriod(getDb(), req, req.query.register_id);
  res.json({
    opened_at: period.openedAt,
    is_first_close: period.isFirstClose,
    has_sales: period.sales.length > 0,
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  let operationDate;
  try { operationDate = operationTime(req.body.closed_at); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const {
    counted_cash, opening_float = 0, note = null, client_close_id = null,
    client_sale_ids = null, register_id: requestedRegisterId = null,
  } = req.body;

  if (client_sale_ids != null && !Array.isArray(client_sale_ids)) {
    return res.status(400).json({ error: 'client_sale_ids debe ser una lista' });
  }

  const counted = Number(counted_cash);
  if (!Number.isFinite(counted) || counted < 0) {
    return res.status(400).json({ error: 'El efectivo contado no es válido' });
  }
  const float = Number(opening_float);
  if (!Number.isFinite(float) || float < 0) {
    return res.status(400).json({ error: 'El fondo de caja no es válido' });
  }

  const db = getDb();

  // Idempotencia (camino rápido), igual que en ventas: un doble toque en
  // "Cerrar caja" no puede producir dos arqueos del mismo período.
  if (client_close_id) {
    const existing = await findByClientCloseId(db, req.userId, client_close_id);
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
    }
  }

  const registerId = resolveRegisterId(req, requestedRegisterId);
  const mode = modeFor(req, client_sale_ids, requestedRegisterId);

  // Quién está cerrando: es la mitad del valor del arqueo. "Faltaron 220" no
  // se puede accionar; "faltaron 220 en el cierre de Yamila" sí.
  const account = await describeAccount(db, req);

  // Leer las ventas abiertas y marcarlas como cerradas en la misma
  // transacción: si dos cierres de la misma caja llegaran a la vez, el segundo
  // encuentra las ventas ya marcadas y no las vuelve a contar.
  const tx = await db.transaction('write');
  try {
    // La PWA cierra el conjunto exacto que vio localmente, para que una venta
    // posterior de otra pestaña no entre en un cierre offline anterior.
    const explicitIds = req.body.covered_sale_ids;
    if (explicitIds != null && (!Array.isArray(explicitIds) || explicitIds.some((id) => !Number.isInteger(id) || id <= 0) || new Set(explicitIds).size !== explicitIds.length || mode !== 'web')) {
      await tx.rollback();
      return res.status(400).json({ error: 'Ventas del cierre inválidas' });
    }
    let covered = mode === 'desktop'
      ? await salesByClientIds(tx, req.userId, client_sale_ids)
      : await openSales(tx, req.userId, mode, registerId);
    if (explicitIds) {
      const available = new Set(covered.map((sale) => Number(sale.id)));
      if (explicitIds.some((id) => !available.has(id))) {
        await tx.rollback();
        return res.status(409).json({ error: 'Una venta de este cierre ya no está disponible. Revisa la caja antes de sincronizar.' });
      }
      covered = covered.filter((sale) => explicitIds.includes(Number(sale.id)));
    }
    const summary = summarize(covered);

    // Solo pasa en la transición: un escritorio viejo cierra por ids ventas
    // que la web ya se había llevado. Se suman igual —ese dinero está en esa
    // gaveta y el cierre local ya es un hecho— pero queda anotado para que el
    // dueño vea de dónde sale el sobrante en la otra caja.
    const overlapSales = mode === 'desktop'
      ? covered.filter((sale) => sale.cash_close_id != null).length
      : 0;

    let openedAt;
    if (mode === 'legacy') {
      const periodStart = await getPeriodStart(tx, req.userId);
      openedAt = periodStart === BEGINNING_OF_TIME ? summary.first_sale_at : periodStart;
    } else {
      const priorClose = await getLastCloseForRegister(tx, req.userId, registerId);
      openedAt = priorClose || summary.first_sale_at;
    }

    const expectedCash = float + summary.cash;

    // Un primer cierre sin ninguna venta no tiene fecha de apertura natural:
    // COALESCE deja que SQLite ponga la de ahora.
    const inserted = await tx.execute({
      sql: `INSERT INTO cash_closes
              (user_id, client_close_id, opened_at, opening_float, expected_cash,
               counted_cash, difference, expected_transfer, sales_count, note,
               register_id, overlap_sales, account_id, account_email, closed_at)
            VALUES (?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      args: [
        req.userId, client_close_id, openedAt, float, expectedCash,
        counted, counted - expectedCash,
        summary.transfer, summary.count, note,
        registerId, overlapSales, account.id, account.email, operationDate,
      ],
    });
    const closeId = Number(inserted.lastInsertRowid);

    if (covered.length > 0) {
      const placeholders = covered.map(() => '?').join(',');
      await tx.execute({
        sql: `UPDATE sales SET cash_close_id = ?
              WHERE id IN (${placeholders}) AND cash_close_id IS NULL`,
        args: [closeId, ...covered.map((sale) => sale.id)],
      });
    }

    await tx.commit();

    const final = await db.execute({
      sql: 'SELECT * FROM cash_closes WHERE id = ?',
      args: [closeId],
    });
    return res.status(201).json(final.rows[0]);
  } catch (err) {
    await tx.rollback().catch(() => { /* la transacción ya estaba cerrada */ });

    // Dos peticiones idénticas a la vez: una perdió la carrera contra el índice
    // UNIQUE. Devolvemos el cierre que sí se registró.
    if (client_close_id && isUniqueViolation(err)) {
      const existing = await findByClientCloseId(db, req.userId, client_close_id);
      if (existing.rows[0]) {
        return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
      }
    }
    throw err;
  }
}));

module.exports = router;
