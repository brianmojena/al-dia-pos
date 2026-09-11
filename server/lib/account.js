/**
 * Quién está haciendo la operación, listo para congelar en la fila.
 *
 * El email se resuelve con una consulta por clave primaria en vez de viajar en
 * el JWT: así no hay que lidiar con tokens viejos que no lo traen ni con un
 * email que quedó obsoleto dentro de un token de 30 días. Es una lectura
 * indexada y, en el caso de una venta, se hace FUERA de la transacción — la
 * cuenta que cobra no cambia a mitad del cobro.
 */
const describeAccount = async (db, req) => {
  const result = await db.execute({
    sql: 'SELECT id, email FROM users WHERE id = ?',
    args: [req.accountId],
  });
  const row = result.rows[0];
  return {
    id: row ? Number(row.id) : req.accountId ?? null,
    email: row ? row.email : null,
  };
};

module.exports = { describeAccount };
