const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { todayBounds, shopLocalLabel } = require('../lib/businessDay');

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

  res.json({
    today: todayStatsResult.rows[0],
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
    },
  });
}));

module.exports = router;
