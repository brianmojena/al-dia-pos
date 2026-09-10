const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { todayBounds } = require('../lib/businessDay');

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

  res.json({
    today: todayStatsResult.rows[0],
    lowStock: lowStockResult.rows,
    recentSales: recentSalesResult.rows,
  });
}));

module.exports = router;
