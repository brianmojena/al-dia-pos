const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');

router.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const todayStatsResult = await db.execute({
    sql: "SELECT COALESCE(SUM(total),0) AS sales, COALESCE(SUM(profit),0) AS profit, COUNT(*) AS count FROM sales WHERE user_id = ? AND date(created_at) = ?",
    args: [req.userId, today],
  });

  const lowStockResult = await db.execute({
    sql: 'SELECT * FROM products WHERE user_id = ? AND stock <= 5 ORDER BY stock ASC',
    args: [req.userId],
  });
  const recentSalesResult = await db.execute({
    sql: "SELECT * FROM sales WHERE user_id = ? AND date(created_at) = ? ORDER BY created_at DESC LIMIT 5",
    args: [req.userId, today],
  });

  res.json({
    today: todayStatsResult.rows[0],
    lowStock: lowStockResult.rows,
    recentSales: recentSalesResult.rows,
  });
}));

module.exports = router;
