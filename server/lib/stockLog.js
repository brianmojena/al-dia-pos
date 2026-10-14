/**
 * Anota en stock_entries un cambio de stock que no es mercancía recibida:
 *   - 'correccion': la cuenta principal pone el stock a mano (58 → 55);
 *   - 'anulacion': las unidades que vuelven al anular una venta.
 * La cantidad lleva signo (55 - 58 = -3). Si el stock no cambió no se anota nada.
 */
const roundQty = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// La sentencia, para quien la junta con otras en un db.batch. null si no hay cambio.
function stockChangeStatement({ userId, product, before, after, account, kind, reason = null }) {
  const quantity = roundQty(Number(after) - Number(before));
  if (quantity === 0) return null;
  const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : null;
  return {
    sql: `INSERT INTO stock_entries
            (user_id, product_id, product_name, quantity, stock_before, stock_after, account_id, account_email, kind, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [userId, product.id, product.name, quantity, roundQty(before), roundQty(after),
           account.id, account.email, kind, cleanReason],
  };
}

async function logStockChange(executor, change) {
  const statement = stockChangeStatement(change);
  if (statement) await executor.execute(statement);
}

module.exports = { stockChangeStatement, logStockChange };
