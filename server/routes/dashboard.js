const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { todayBounds, boundsForDate, businessToday, shopLocalLabel, shopLocalTime } = require('../lib/businessDay');
const { paymentSplit, purchaseSplit, withdrawalSplit, round2 } = require('../lib/payment');

router.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  // "Hoy" es el día del negocio en Cuba, no el día UTC: comparar contra
  // date(created_at) hacía que el día cambiara a las 8:00 pm hora local.
  const { start, end } = todayBounds();

  const todayStatsResult = await db.execute({
    sql: "SELECT COALESCE(SUM(total),0) AS sales, COALESCE(SUM(profit),0) AS profit, COUNT(*) AS count FROM sales WHERE user_id = ? AND created_at >= ? AND created_at < ?",
    args: [req.userId, start, end],
  });

  const lowStockResult = await db.execute({
    sql: 'SELECT * FROM products WHERE user_id = ? AND stock <= 5 AND (unit IS NULL OR track_stock = 1) ORDER BY stock ASC',
    args: [req.userId],
  });
  const recentSalesResult = await db.execute({
    sql: "SELECT * FROM sales WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 5",
    args: [req.userId, start, end],
  });

  // Estado de los arqueos, para el dueño que NO está en la tienda: la pregunta
  // que hace desde el teléfono no es solo "¿cuánto se vendió?" sino "¿cuadró
  // todo?". Viaja dentro de /api/dashboard en vez de en tres endpoints aparte
  // porque en una conexión cubana cada petición extra es otra oportunidad de
  // fallar — la app del dueño resuelve su pantalla con una sola llamada.
  const lastCashCloseResult = await db.execute({
    sql: `SELECT id, closed_at, difference, expected_cash, counted_cash, sales_count, account_email
          FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC LIMIT 1`,
    args: [req.userId],
  });

  const lastInventoryCountResult = await db.execute({
    sql: `SELECT id, counted_at, lines_count, units_missing, units_extra, value_missing, account_email
          FROM inventory_counts WHERE user_id = ? ORDER BY counted_at DESC LIMIT 1`,
    args: [req.userId],
  });

  // Solo tiene sentido si hay más de una cuenta cerrando caja: con una sola,
  // el "patrón por cajero" es la misma información que el último cierre.
  const cashierSummaryResult = await db.execute({
    sql: `SELECT account_id, account_email,
                 COUNT(*) AS closes,
                 COALESCE(SUM(difference), 0) AS total_difference,
                 SUM(CASE WHEN difference < -0.5 THEN 1 ELSE 0 END) AS times_short
          FROM cash_closes
          WHERE user_id = ?
          GROUP BY account_id, account_email
          ORDER BY total_difference ASC`,
    args: [req.userId],
  });

  // Ventas cobradas sin internet que no se pudieron registrar y el dueño
  // todavía no revisó: dinero en la caja que no aparece en ninguna venta.
  const rejectedResult = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM rejected_sales WHERE user_id = ? AND reviewed_at IS NULL',
    args: [req.userId],
  });

  // Ventas de hoy cobradas en divisa a una tasa que no era la de la tienda:
  // el cajero que la sube se queda con la diferencia en billetes.
  const offRateResult = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM sales
          WHERE user_id = ? AND created_at >= ? AND created_at < ? AND payment_method = 'divisa'
            AND shop_rate IS NOT NULL AND ABS(exchange_rate - shop_rate) > 0.005`,
    args: [req.userId, start, end],
  });

  // Lo que hay ahora en la tienda: todo lo cobrado desde el último arqueo de
  // cada caja. Es la misma cuenta del arqueo (paymentSplit), así que efectivo
  // ya descuenta el vuelto de las ventas en divisa.
  const openSalesResult = await db.execute({
    sql: 'SELECT total, payment_method, transfer_amount, foreign_currency, foreign_amount, exchange_rate FROM sales WHERE user_id = ? AND cash_close_id IS NULL',
    args: [req.userId],
  });
  const holdings = { cash: 0, transfer: 0, usd: 0, eur: 0 };
  for (const sale of openSalesResult.rows) {
    const split = paymentSplit(sale);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }
  // Las compras de divisa sin arqueo: pesos que salieron, billetes que entraron.
  const openPurchasesResult = await db.execute({
    sql: 'SELECT foreign_currency, foreign_amount, cup_amount FROM currency_purchases WHERE user_id = ? AND cash_close_id IS NULL',
    args: [req.userId],
  });
  for (const purchase of openPurchasesResult.rows) {
    const split = purchaseSplit(purchase);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }

  // Las extracciones abiertas sin arqueo: dinero que el dueño retiró.
  const openWithdrawalsResult = await db.execute({
    sql: 'SELECT * FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL ORDER BY created_at DESC, id DESC',
    args: [req.userId],
  });
  for (const withdrawal of openWithdrawalsResult.rows) {
    const split = withdrawalSplit(withdrawal);
    for (const key of Object.keys(holdings)) holdings[key] += split[key];
  }

  for (const key of Object.keys(holdings)) holdings[key] = round2(holdings[key]);

  const inventoryResult = await db.execute({
    sql: `SELECT COALESCE(SUM(stock * purchase_price), 0) AS cost, COALESCE(SUM(stock * sale_price), 0) AS retail, COALESCE(SUM(CASE WHEN unit IS NULL THEN stock ELSE 0 END), 0) AS units
          FROM products WHERE user_id = ? AND (unit IS NULL OR track_stock = 1)`,
    args: [req.userId],
  });
  const inventory = {
    cost: round2(inventoryResult.rows[0].cost),
    retail: round2(inventoryResult.rows[0].retail),
    units: Number(inventoryResult.rows[0].units) || 0,
  };

  // El almacén, para que el dueño lo tenga a la vista desde Inicio: cuánto hay
  // guardado y el último pase a la tienda (quién y cuándo).
  const warehouseResult = await db.execute({
    sql: 'SELECT COUNT(*) AS items, COALESCE(SUM(quantity * cost), 0) AS cost FROM warehouse_items WHERE user_id = ?',
    args: [req.userId],
  });
  const lastTransferResult = await db.execute({
    sql: `SELECT item_name, quantity, account_email, created_at
          FROM warehouse_transfers WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    args: [req.userId],
  });
  const lastTransfer = lastTransferResult.rows[0];
  const warehouse = {
    items: Number(warehouseResult.rows[0].items) || 0,
    cost: round2(warehouseResult.rows[0].cost),
    lastTransfer: lastTransfer
      ? { ...lastTransfer, created_at_label: shopLocalLabel(lastTransfer.created_at) }
      : null,
  };

  res.json({
    today: todayStatsResult.rows[0],
    holdings,
    open_withdrawals: openWithdrawalsResult.rows,
    inventory,
    warehouse,
    lowStock: lowStockResult.rows,
    recentSales: recentSalesResult.rows,
    audit: {
      // La etiqueta va en hora de la TIENDA, no del dispositivo: el dueño de
      // viaje quiere leer a qué hora se cerró su caja en La Habana.
      lastCashClose: lastCashCloseResult.rows[0]
        ? { ...lastCashCloseResult.rows[0], closed_at_label: shopLocalLabel(lastCashCloseResult.rows[0].closed_at) }
        : null,
      lastInventoryCount: lastInventoryCountResult.rows[0]
        ? { ...lastInventoryCountResult.rows[0], counted_at_label: shopLocalLabel(lastInventoryCountResult.rows[0].counted_at) }
        : null,
      cashierSummary: cashierSummaryResult.rows.length > 1 ? cashierSummaryResult.rows : [],
      rejectedSales: Number(rejectedResult.rows[0].n) || 0,
      offRateSales: Number(offRateResult.rows[0].n) || 0,
    },
  });
}));

// --- Actividad de un día --------------------------------------------------
// Lo que el dueño abre al tocar "Ventas" en la app del teléfono: todas las
// ventas del día con quién cobró, y lo que se movió esa jornada entre almacén,
// inventario y caja. Solo se mira hacia atrás HISTORY_DAYS días.
//
// Las fechas y horas viajan ya resueltas (day_label, time, prev, next): la app
// no calcula fechas, y la zona relevante es la de la tienda, no la del teléfono.

const HISTORY_DAYS = 90;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' desplazado N días, con los componentes a mano (sin Date local).
const shiftDate = (dateStr, delta) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
};

const DAY_LABEL = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
});

router.get('/day', asyncHandler(async (req, res) => {
  const today = businessToday();
  const date = req.query.date || today;
  const oldest = shiftDate(today, -(HISTORY_DAYS - 1));
  if (!DATE_RE.test(date) || date > today || date < oldest) {
    return res.status(400).json({ error: `Solo se pueden ver los últimos ${HISTORY_DAYS} días` });
  }

  const db = getDb();
  const { start, end } = boundsForDate(date);
  const args = [req.userId, start, end];
  const query = (table, extra = '') => db.execute({
    sql: `SELECT * FROM ${table} WHERE user_id = ? AND created_at >= ? AND created_at < ? ${extra}`,
    args,
  });
  const withTime = (row) => ({ ...row, time: shopLocalTime(row.created_at) });

  const [sales, transfers, stockEntries, purchases, closesResult, withdrawalsResult, warehouseChangesResult] = await Promise.all([
    query('sales', 'ORDER BY created_at DESC, id DESC'),
    query('warehouse_transfers', 'ORDER BY created_at DESC, id DESC'),
    query('stock_entries', 'ORDER BY created_at DESC, id DESC'),
    query('currency_purchases', 'ORDER BY created_at DESC, id DESC'),
    db.execute({
      sql: `SELECT id, closed_at AS created_at, difference, sales_count, account_email
            FROM cash_closes WHERE user_id = ? AND closed_at >= ? AND closed_at < ? ORDER BY closed_at DESC`,
      args,
    }),
    query('cash_withdrawals', 'ORDER BY created_at DESC, id DESC'),
    query('warehouse_changes', 'ORDER BY created_at DESC, id DESC'),
  ]);

  // Las líneas de todas las ventas del día en una sola consulta.
  const itemsBySale = new Map();
  if (sales.rows.length > 0) {
    const ids = sales.rows.map((s) => Number(s.id));
    const itemsResult = await db.execute({
      sql: `SELECT sale_id, product_name, quantity, unit_price FROM sale_items WHERE sale_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      args: ids,
    });
    for (const item of itemsResult.rows) {
      const key = Number(item.sale_id);
      if (!itemsBySale.has(key)) itemsBySale.set(key, []);
      itemsBySale.get(key).push(item);
    }
  }

  const summary = sales.rows.reduce((acc, s) => ({
    sales: acc.sales + (Number(s.total) || 0),
    profit: acc.profit + (Number(s.profit) || 0),
    count: acc.count + 1,
  }), { sales: 0, profit: 0, count: 0 });

  res.json({
    date,
    day_label: DAY_LABEL.format(new Date(`${date}T12:00:00Z`)),
    prev: date > oldest ? shiftDate(date, -1) : null,
    next: date < today ? shiftDate(date, 1) : null,
    summary: { sales: round2(summary.sales), profit: round2(summary.profit), count: summary.count },
    sales: sales.rows.map((s) => ({ ...withTime(s), items: itemsBySale.get(Number(s.id)) || [] })),
    transfers: transfers.rows.map(withTime),
    stockEntries: stockEntries.rows.map(withTime),
    purchases: purchases.rows.map(withTime),
    withdrawals: withdrawalsResult.rows.map(withTime),
    cashCloses: closesResult.rows.map(withTime),
    warehouseChanges: warehouseChangesResult.rows.map(withTime),
  });
}));

module.exports = router;
