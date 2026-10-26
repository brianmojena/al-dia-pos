const { getDb } = require('../db/database');
const { planOf } = require('../lib/plans');

/**
 * Requiere que el plan de la tienda sea 'enterprise'. Responde 403 si no lo es.
 */
async function requireEnterprise(req, res, next) {
  try {
    const result = await getDb().execute({
      sql: 'SELECT plan FROM users WHERE id = ?',
      args: [req.userId],
    });
    const row = result.rows[0];
    const plan = row ? row.plan : null;

    if (planOf(plan) !== 'enterprise') {
      return res.status(403).json({
        error: 'La contabilidad es parte del plan Enterprise',
        code: 'PLAN_REQUIRED',
      });
    }
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireEnterprise };
