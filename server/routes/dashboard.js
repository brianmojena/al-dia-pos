const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { todayBounds, shopLocalLabel } = require('../lib/businessDay');
const { paymentSplit, round2 } = require('../lib/payment');

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
    sql: 'SELECT * FROM products WHERE user_id = ? AND stock <= 5 ORDER BY stock ASC',
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
  for (const key of Object.keys(holdings)) holdings[key] = round2(holdings[key]);

  const inventoryResult = await db.execute({
    sql: `SELECT COALESCE(SUM(stock * purchase_price), 0) AS cost, COALESCE(SUM(stock * sale_price), 0) AS retail, COALESCE(SUM(stock), 0) AS units
          FROM products WHERE user_id = ?`,
    args: [req.userId],
  });
  const inventory = {
    cost: round2(inventoryResult.rows[0].cost),
    retail: round2(inventoryResult.rows[0].retail),
    units: Number(inventoryResult.rows[0].units) || 0,
  };

  res.json({
    today: todayStatsResult.rows[0],
    holdings,
    inventory,
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

module.exports = router;
