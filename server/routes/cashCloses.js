const { operationTime } = require('../lib/operationTime');
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { describeAccount } = require('../lib/account');
const { requireOwner, OWNER } = require('../middleware/auth');
const { resolveRegisterId } = require('../lib/register');
const { paymentSplit, purchaseSplit, withdrawalSplit, round2 } = require('../lib/payment');
const { CashCloseCorrectionError, closeDetails, correctCashClose } = require('../lib/cashCloseCorrections');
const { enqueueAuditJob } = require('../lib/auditJobs');

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
// venta mixta aporta a los dos lados. Los dólares y euros se cuentan cada uno
// por su lado, en billetes: el vuelto en pesos de una venta en divisa ya está
// descontado del efectivo.
//
// Las compras de divisa de la caja entran en la misma cuenta: los pesos que
// salieron de la gaveta restan del efectivo y los billetes comprados suman a
// su moneda.
const sumOf = (rows, key, purchases = [], withdrawals = []) => round2(
  rows.reduce((sum, row) => sum + paymentSplit(row)[key], 0)
  + purchases.reduce((sum, row) => sum + purchaseSplit(row)[key], 0)
  + withdrawals.reduce((sum, row) => sum + withdrawalSplit(row)[key], 0)
);
const summarize = (rows, purchases = [], withdrawals = []) => ({
  cash: sumOf(rows, 'cash', purchases, withdrawals),
  transfer: sumOf(rows, 'transfer', purchases, withdrawals),
  usd: sumOf(rows, 'usd', purchases, withdrawals),
  eur: sumOf(rows, 'eur', purchases, withdrawals),
  count: rows.length,
  first_sale_at: rows[0]?.created_at || null,
});

// Lo contado en divisa es opcional: una caja que nunca cobra en dólares no
// tiene por qué mandarlo, y entonces se contó cero.
const countedForeign = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? round2(n) : NaN;
};

/**
 * Ventas todavía sin arqueo que le tocan a esta caja.
 *
 * La caja web también se lleva las ventas abiertas SIN caja (register_id NULL):
 * son las cobradas antes de este despliegue, o desde un escritorio viejo que
 * todavía no manda su identidad. Si nadie las tomara quedarían fuera de todo
 * arqueo para siempre. Si después ese escritorio viejo las cierra por ids, el
 * cierre lo deja anotado en `overlap_sales` (ver el POST).
 */
const openSales = async (executor, userId, mode, registerId, wholeShop = false, accountId = null) => {
  if (mode === 'web' && wholeShop) {
    const result = await executor.execute({
      sql: `SELECT * FROM sales WHERE user_id = ? AND cash_close_id IS NULL ORDER BY created_at ASC, id ASC`,
      args: [userId],
    });
    return result.rows;
  }
  if (mode === 'web') {
    const ownLegacy = accountId == null ? '' : ` AND (account_id = ? OR
      (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))`;
    const result = await executor.execute({
      sql: `SELECT * FROM sales WHERE user_id = ? AND cash_close_id IS NULL
            AND (register_id = ? OR register_id IS NULL)${ownLegacy} ORDER BY created_at ASC, id ASC`,
      args: accountId == null ? [userId, registerId] : [userId, registerId, accountId, accountId],
    });
    return result.rows;
  }
  const result = await executor.execute({
    sql: `SELECT * FROM sales WHERE user_id = ? AND register_id IS NULL
          AND cash_close_id IS NULL${accountId == null ? '' : ' AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))'} ORDER BY created_at ASC, id ASC`,
    args: accountId == null ? [userId] : [userId, accountId, accountId],
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
const salesByClientIds = async (executor, userId, ids, accountId = null) => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const result = await executor.execute({
    sql: `SELECT * FROM sales WHERE user_id = ? AND client_sale_id IN (${placeholders})
          ${accountId == null ? '' : 'AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))'}
          ORDER BY created_at ASC, id ASC`,
    args: accountId == null ? [userId, ...ids] : [userId, ...ids, accountId, accountId],
  });
  return result.rows;
};

// Lo mismo para las compras de divisa: las que le tocan a esta caja y siguen
// sin arqueo. Misma regla de cobertura que las ventas.
const openPurchases = async (executor, userId, mode, registerId, wholeShop = false, accountId = null) => {
  if (mode === 'web' && wholeShop) {
    const all = await executor.execute({
      sql: `SELECT * FROM currency_purchases WHERE user_id = ? AND cash_close_id IS NULL ORDER BY created_at ASC, id ASC`,
      args: [userId],
    });
    return all.rows;
  }
  const ownLegacy = accountId == null ? '' : ` AND (account_id = ? OR
    (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))`;
  const result = mode === 'web'
    ? await executor.execute({
        sql: `SELECT * FROM currency_purchases WHERE user_id = ? AND cash_close_id IS NULL
              AND (register_id = ? OR register_id IS NULL)${ownLegacy} ORDER BY created_at ASC, id ASC`,
        args: accountId == null ? [userId, registerId] : [userId, registerId, accountId, accountId],
      })
    : await executor.execute({
        sql: `SELECT * FROM currency_purchases WHERE user_id = ? AND register_id IS NULL
              AND cash_close_id IS NULL${ownLegacy} ORDER BY created_at ASC, id ASC`,
        args: accountId == null ? [userId] : [userId, accountId, accountId],
      });
  return result.rows;
};

// Las compras de un conjunto explícito de client_purchase_id (cierre de la
// app de escritorio, que ya las tiene sincronizadas).
const purchasesByClientIds = async (executor, userId, ids, accountId = null) => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const result = await executor.execute({
    sql: `SELECT * FROM currency_purchases WHERE user_id = ? AND client_purchase_id IN (${placeholders})
          ${accountId == null ? '' : 'AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))'}
          ORDER BY created_at ASC, id ASC`,
    args: accountId == null ? [userId, ...ids] : [userId, ...ids, accountId, accountId],
  });
  return result.rows;
};

// Las extracciones de caja abiertas: dinero que el dueño retiró y no fue
// cubierto por ningún cierre todavía. Todas las extracciones de la tienda
// (de cualquier caja y cualquier cajero) entran en el próximo cierre, sea
// quién lo haga.
const openWithdrawals = async (executor, userId) => {
  const result = await executor.execute({
    sql: `SELECT * FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL
          ORDER BY created_at ASC, id ASC`,
    args: [userId],
  });
  return result.rows;
};

// La cuenta principal cierra la tienda entera: todas las ventas abiertas, de
// cualquier caja y cajero. Los cajeros siguen cerrando solo la suya.
const closesWholeShop = (req) => req.role === OWNER;

const sharedOpenRows = async (executor, table, req) => (await executor.execute({
  sql: `SELECT * FROM ${table} WHERE user_id = ? AND register_id = ? AND cash_close_id IS NULL ORDER BY created_at ASC, id ASC`,
  args: [req.userId, resolveRegisterId(req, 'web')],
})).rows;

const modeFor = (req, clientSaleIds, requestedRegisterId) => {
  if (req.sharedDevice) return 'web';
  if (Array.isArray(clientSaleIds)) return 'desktop';
  return requestedRegisterId != null && resolveRegisterId(req, requestedRegisterId) ? 'web' : 'legacy';
};

const describeOpenPeriod = async (executor, req, requestedRegisterId) => {
  const registerId = resolveRegisterId(req, requestedRegisterId);
  const mode = req.sharedDevice || (requestedRegisterId != null && registerId) ? 'web' : 'legacy';
  const cashierAccountId = req.role === OWNER ? null : req.accountId;
  const sales = req.sharedDevice ? await sharedOpenRows(executor, 'sales', req) : await openSales(executor, req.userId, mode, registerId, closesWholeShop(req), cashierAccountId);
  const purchases = req.sharedDevice ? await sharedOpenRows(executor, 'currency_purchases', req) : await openPurchases(executor, req.userId, mode, registerId, closesWholeShop(req), cashierAccountId);
  // Las extracciones siempre son de toda la tienda, independiente de la caja.
  const withdrawals = await openWithdrawals(executor, req.userId);

  if (mode === 'web') {
    const lastClose = await getLastCloseForRegister(executor, req.userId, registerId);
    return {
      sales,
      purchases,
      withdrawals,
      openedAt: lastClose || sales[0]?.created_at || purchases[0]?.created_at || withdrawals[0]?.created_at || null,
      isFirstClose: !lastClose,
    };
  }

  const periodStart = await getPeriodStart(executor, req.userId);
  const isFirstClose = periodStart === BEGINNING_OF_TIME;
  return {
    sales,
    purchases,
    withdrawals,
    openedAt: isFirstClose ? (sales[0]?.created_at || purchases[0]?.created_at || withdrawals[0]?.created_at || null) : periodStart,
    isFirstClose,
  };
};

// El dueño ve el historial de la tienda; cada cajero ve el resultado de sus
// propios cierres, que ya terminaron y no pueden alterar el conteo abierto.
router.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const cashierColumns = `id, client_close_id, opened_at, closed_at, opening_float,
    expected_cash, counted_cash, difference, expected_transfer, sales_count, note,
    register_id, account_id, account_email, expected_usd, counted_usd,
    difference_usd, expected_eur, counted_eur, difference_eur, withdrawn_cash,
    withdrawn_transfer, withdrawn_usd, withdrawn_eur, correction_revision`;
  const result = await db.execute({
    sql: `SELECT ${req.role === OWNER ? '*' : cashierColumns} FROM cash_closes WHERE user_id = ?${req.role === OWNER ? '' : ' AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))'} ORDER BY closed_at DESC${req.role === OWNER ? ' LIMIT 100' : ''}`,
    args: req.role === OWNER ? [req.userId] : [req.userId, req.accountId, req.accountId],
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
            COALESCE(SUM(difference_usd), 0) AS total_difference_usd,
            COALESCE(SUM(difference_eur), 0) AS total_difference_eur,
            MAX(closed_at)                  AS last_close_at
          FROM cash_closes
          WHERE user_id = ?
            AND (register_id IS NULL OR register_id NOT LIKE 'shared:%' OR instr(substr(register_id, 8), ':') > 0)
          GROUP BY account_id, account_email
          ORDER BY total_difference ASC`,
    args: [req.userId],
  });
  const shared = await getDb().execute({
    sql: `SELECT NULL AS account_id, NULL AS account_email, c.register_id, d.name AS register_name,
            'register' AS attribution, COUNT(*) AS closes, COALESCE(SUM(c.difference), 0) AS total_difference,
            COALESCE(MIN(c.difference), 0) AS worst_difference, SUM(CASE WHEN c.difference < -0.5 THEN 1 ELSE 0 END) AS times_short,
            COALESCE(SUM(c.difference_usd), 0) AS total_difference_usd, COALESCE(SUM(c.difference_eur), 0) AS total_difference_eur,
            MAX(c.closed_at) AS last_close_at
          FROM cash_closes c LEFT JOIN shared_devices d ON c.register_id = 'shared:' || d.id
          WHERE c.user_id = ? AND c.register_id LIKE 'shared:%' AND instr(substr(c.register_id, 8), ':') = 0 GROUP BY c.register_id`,
    args: [req.userId],
  });
  res.json([...result.rows, ...shared.rows].sort((a, b) => Number(a.total_difference) - Number(b.total_difference)));
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
    has_sales: period.sales.length > 0 || period.purchases.length > 0 || period.withdrawals.length > 0,
  });
}));

// Detalle de un cierre confirmado. El cajero solo puede consultar los suyos;
// los cambios y su auditoría quedan reservados al dueño de la tienda.
router.get('/:id', asyncHandler(async (req, res) => {
  const closeId = Number(req.params.id);
  if (!Number.isInteger(closeId) || closeId <= 0) return res.status(400).json({ error: 'ID de cierre inválido' });
  const db = getDb();
  const ownScope = req.role === OWNER ? '' : ` AND (account_id = ? OR
    (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))`;
  const args = req.role === OWNER ? [closeId, req.userId] : [closeId, req.userId, req.accountId, req.accountId];
  const close = (await db.execute({
    sql: `SELECT * FROM cash_closes WHERE id = ? AND user_id = ?${ownScope}`,
    args,
  })).rows[0];
  if (!close) return res.status(404).json({ error: 'Cierre de caja no encontrado' });
  if (req.role !== OWNER) {
    const { corrected_at, original_expected_cash, original_difference, overlap_sales, ...safeClose } = close;
    return res.json({ ...safeClose, corrections: [] });
  }
  const details = await closeDetails(db, close);
  // Añadir cruce de inventario: solo para el dueño
  try {
    const { computeInventoryCrossCheck } = await import('../lib/audit/inventoryCrossCheck.mjs');
    details.inventory_check = await computeInventoryCrossCheck(db, close);
  } catch (error) {
    // Si el cálculo falla, el detalle sigue funcionando sin él
    details.inventory_check = null;
  }
  res.json(details);
}));

router.put('/:id', requireOwner, asyncHandler(async (req, res) => {
  const closeId = Number(req.params.id);
  if (!Number.isInteger(closeId) || closeId <= 0) return res.status(400).json({ error: 'ID de cierre inválido' });
  const account = await describeAccount(getDb(), req);
  try {
    const result = await correctCashClose(getDb(), {
      userId: req.userId, closeId, body: req.body, account,
    });
    // Una corrección cambia la historia del cierre: se analiza como una
    // revisión nueva, conservando el informe anterior para auditoría.
    if (result.correction) {
      await enqueueAuditJob(getDb(), {
        userId: req.userId,
        cashCloseId: closeId,
        revision: Number(result.cash_close.correction_revision || 0),
      });
    }
    res.json(result);
  } catch (error) {
    if (error instanceof CashCloseCorrectionError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));

router.post('/', asyncHandler(async (req, res) => {
  let operationDate;
  try { operationDate = operationTime(req.body.closed_at); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const {
    counted_cash, opening_float = 0, note = null, client_close_id = null,
    client_sale_ids = null, client_purchase_ids = null, register_id: requestedRegisterId = null,
  } = req.body;

  if (client_sale_ids != null && !Array.isArray(client_sale_ids)) {
    return res.status(400).json({ error: 'client_sale_ids debe ser una lista' });
  }
  if (client_purchase_ids != null && !Array.isArray(client_purchase_ids)) {
    return res.status(400).json({ error: 'client_purchase_ids debe ser una lista' });
  }

  const counted = Number(counted_cash);
  if (!Number.isFinite(counted) || counted < 0) {
    return res.status(400).json({ error: 'El efectivo contado no es válido' });
  }
  const float = Number(opening_float);
  if (!Number.isFinite(float) || float < 0) {
    return res.status(400).json({ error: 'El fondo de caja no es válido' });
  }
  const countedUsd = countedForeign(req.body.counted_usd);
  const countedEur = countedForeign(req.body.counted_eur);
  if (Number.isNaN(countedUsd) || Number.isNaN(countedEur)) {
    return res.status(400).json({ error: 'Los dólares o euros contados no son válidos' });
  }

  const db = getDb();

  // Idempotencia (camino rápido), igual que en ventas: un doble toque en
  // "Cerrar caja" no puede producir dos arqueos del mismo período.
  if (client_close_id) {
    const existing = await findByClientCloseId(db, req.userId, client_close_id);
    if (existing.rows[0]) {
      if (req.sharedDevice && (existing.rows[0].register_id !== resolveRegisterId(req, 'web') || Number(existing.rows[0].account_id) !== Number(req.accountId))) return res.status(409).json({ error: 'Este identificador de cierre pertenece a otra caja o cajero' });
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
    // La cuenta principal que cierra desde el escritorio también lleva lo que
    // sigue abierto en los demás aparatos (teléfonos); sin duplicar las suyas.
    const withWholeShop = async (own, wholeShopRows) => {
      if (!closesWholeShop(req)) return own;
      const seen = new Set(own.map((row) => Number(row.id)));
      return [...own, ...wholeShopRows.filter((row) => !seen.has(Number(row.id)))]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
    };
    let covered = req.sharedDevice ? await sharedOpenRows(tx, 'sales', req) : mode === 'desktop'
      ? await withWholeShop(await salesByClientIds(tx, req.userId, client_sale_ids, req.role === OWNER ? null : req.accountId), await openSales(tx, req.userId, 'web', null, true))
      : await openSales(tx, req.userId, mode, registerId, closesWholeShop(req), req.role === OWNER ? null : req.accountId);
    if (explicitIds) {
      const available = new Set(covered.map((sale) => Number(sale.id)));
      if (explicitIds.some((id) => !available.has(id))) {
        await tx.rollback();
        return res.status(409).json({ error: 'Una venta de este cierre ya no está disponible. Revisa la caja antes de sincronizar.' });
      }
      covered = covered.filter((sale) => explicitIds.includes(Number(sale.id)));
    }
    // Compras de divisa: mismo criterio que las ventas. Sin la lista explícita
    // de ids (escritorio) o de ids de servidor (PWA), se llevan las abiertas.
    const explicitPurchaseIds = req.body.covered_purchase_ids;
    if (explicitPurchaseIds != null && (!Array.isArray(explicitPurchaseIds) || explicitPurchaseIds.some((id) => !Number.isInteger(id) || id <= 0) || new Set(explicitPurchaseIds).size !== explicitPurchaseIds.length || mode !== 'web')) {
      await tx.rollback();
      return res.status(400).json({ error: 'Compras del cierre inválidas' });
    }
    let coveredPurchases = req.sharedDevice ? await sharedOpenRows(tx, 'currency_purchases', req) : mode === 'desktop'
      ? await withWholeShop(await purchasesByClientIds(tx, req.userId, client_purchase_ids || [], req.role === OWNER ? null : req.accountId), await openPurchases(tx, req.userId, 'web', null, true))
      : await openPurchases(tx, req.userId, mode, registerId, closesWholeShop(req), req.role === OWNER ? null : req.accountId);
    if (explicitPurchaseIds) {
      const available = new Set(coveredPurchases.map((purchase) => Number(purchase.id)));
      if (explicitPurchaseIds.some((id) => !available.has(id))) {
        await tx.rollback();
        return res.status(409).json({ error: 'Una compra de divisa de este cierre ya no está disponible. Revisa la caja antes de sincronizar.' });
      }
      coveredPurchases = coveredPurchases.filter((purchase) => explicitPurchaseIds.includes(Number(purchase.id)));
    }

    // Extracciones de caja: siempre se cogen todas las abiertas, de cualquier
    // caja y cualquier cajero. No llevan lista explícita como las ventas.
    const coveredWithdrawals = await openWithdrawals(tx, req.userId);

    const summary = summarize(covered, coveredPurchases, coveredWithdrawals);

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
      openedAt = periodStart === BEGINNING_OF_TIME ? (summary.first_sale_at || coveredPurchases[0]?.created_at || null) : periodStart;
    } else {
      const priorClose = await getLastCloseForRegister(tx, req.userId, registerId);
      openedAt = priorClose || summary.first_sale_at || coveredPurchases[0]?.created_at || null;
    }

    const expectedCash = float + summary.cash;

    // Calcular los totales retirados (en valor positivo) para cada método.
    const withdrawnSplit = { cash: 0, transfer: 0, usd: 0, eur: 0 };
    for (const w of coveredWithdrawals) {
      const split = withdrawalSplit(w);
      withdrawnSplit.cash -= split.cash;     // negativo se convierte en positivo
      withdrawnSplit.transfer -= split.transfer;
      withdrawnSplit.usd -= split.usd;
      withdrawnSplit.eur -= split.eur;
    }
    // Redondear para evitar deriva de punto flotante (0.1+0.2 en JS).
    withdrawnSplit.cash = round2(withdrawnSplit.cash);
    withdrawnSplit.transfer = round2(withdrawnSplit.transfer);
    withdrawnSplit.usd = round2(withdrawnSplit.usd);
    withdrawnSplit.eur = round2(withdrawnSplit.eur);

    // Un primer cierre sin ninguna venta no tiene fecha de apertura natural:
    // COALESCE deja que SQLite ponga la de ahora.
    const inserted = await tx.execute({
      sql: `INSERT INTO cash_closes
              (user_id, client_close_id, opened_at, opening_float, expected_cash,
               counted_cash, difference, expected_transfer, sales_count, note,
               register_id, overlap_sales, account_id, account_email, closed_at,
               expected_usd, counted_usd, difference_usd,
               expected_eur, counted_eur, difference_eur,
               withdrawn_cash, withdrawn_transfer, withdrawn_usd, withdrawn_eur)
            VALUES (?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')),
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?)`,
      args: [
        req.userId, client_close_id, openedAt, float, expectedCash,
        counted, counted - expectedCash,
        summary.transfer, summary.count, note,
        registerId, overlapSales, account.id, account.email, operationDate,
        summary.usd, countedUsd, round2(countedUsd - summary.usd),
        summary.eur, countedEur, round2(countedEur - summary.eur),
        withdrawnSplit.cash, withdrawnSplit.transfer, withdrawnSplit.usd, withdrawnSplit.eur,
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

    if (coveredPurchases.length > 0) {
      const placeholders = coveredPurchases.map(() => '?').join(',');
      await tx.execute({
        sql: `UPDATE currency_purchases SET cash_close_id = ?
              WHERE id IN (${placeholders}) AND cash_close_id IS NULL`,
        args: [closeId, ...coveredPurchases.map((purchase) => purchase.id)],
      });
    }

    if (coveredWithdrawals.length > 0) {
      const placeholders = coveredWithdrawals.map(() => '?').join(',');
      await tx.execute({
        sql: `UPDATE cash_withdrawals SET cash_close_id = ?
              WHERE id IN (${placeholders}) AND cash_close_id IS NULL AND voided_at IS NULL`,
        args: [closeId, ...coveredWithdrawals.map((w) => w.id)],
      });
    }

    await tx.commit();

    const final = await db.execute({
      sql: 'SELECT * FROM cash_closes WHERE id = ?',
      args: [closeId],
    });
    // El cierre ya está confirmado. El análisis es asíncrono y no puede
    // retrasar ni tumbar la respuesta al cajero.
    await enqueueAuditJob(db, {
      userId: req.userId,
      cashCloseId: closeId,
      revision: Number(final.rows[0]?.correction_revision || 0),
    });
    return res.status(201).json(final.rows[0]);
  } catch (err) {
    await tx.rollback().catch(() => { /* la transacción ya estaba cerrada */ });

    // Dos peticiones idénticas a la vez: una perdió la carrera contra el índice
    // UNIQUE. Devolvemos el cierre que sí se registró.
    if (client_close_id && isUniqueViolation(err)) {
      const existing = await findByClientCloseId(db, req.userId, client_close_id);
      if (existing.rows[0]) {
        if (req.sharedDevice && (existing.rows[0].register_id !== resolveRegisterId(req, 'web') || Number(existing.rows[0].account_id) !== Number(req.accountId))) return res.status(409).json({ error: 'Este identificador de cierre pertenece a otra caja o cajero' });
        return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
      }
    }
    throw err;
  }
}));

module.exports = router;
