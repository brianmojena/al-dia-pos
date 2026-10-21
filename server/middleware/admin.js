const { getDb } = require('../db/database');
const { isAdminEmail } = require('../lib/admin');
const { asyncHandler } = require('../lib/asyncHandler');

const requireAdmin = asyncHandler(async (req, res, next) => {
  const result = await getDb().execute({
    sql: 'SELECT email FROM users WHERE id = ?', args: [req.accountId],
  });
  if (!isAdminEmail(result.rows[0]?.email)) {
    return res.status(403).json({ error: 'Acceso exclusivo del administrador del sistema' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});

module.exports = { requireAdmin };
