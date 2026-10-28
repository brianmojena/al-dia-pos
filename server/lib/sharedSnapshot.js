const { registerOf } = require('./sharedDevices');
const { withdrawalScopeSql } = require('./withdrawalScope');

async function sharedSnapshot(tx, req) {
  const device = req.sharedDevice;
  // El registro físico exacto es el alcance; otros cajeros del mismo
  // dispositivo conservan su propio historial y estado de caja.
  const register = registerOf(device, req.accountId);
  const scope = [req.userId, register];
  const products = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? ORDER BY name', args: [req.userId] })).rows
    .map(({ purchase_price, ...product }) => product);
  const sales = (await tx.execute({
    sql: `SELECT id, client_sale_id, total, payment_method, transfer_amount, foreign_currency, foreign_amount,
          exchange_rate, shop_rate, cash_received, created_at, register_id, account_id, account_email, cash_close_id
          FROM sales WHERE user_id = ? AND register_id = ? ORDER BY created_at DESC, id DESC`, args: scope,
  })).rows;
  const items = (await tx.execute({
    sql: `SELECT i.id, i.sale_id, i.product_id, i.product_name, i.quantity, i.unit_price, i.pack_size, p.unit
          FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id
          WHERE s.user_id = ? AND s.register_id = ? ORDER BY i.id`, args: scope,
  })).rows;
  const bySale = new Map();
  for (const item of items) { if (!bySale.has(item.sale_id)) bySale.set(item.sale_id, []); bySale.get(item.sale_id).push(item); }
  const purchases = (await tx.execute({ sql: `SELECT * FROM currency_purchases WHERE user_id = ? AND register_id = ? ORDER BY created_at DESC, id DESC`, args: scope })).rows;
  const closes = (await tx.execute({ sql: `SELECT * FROM cash_closes WHERE user_id = ? AND register_id = ? ORDER BY closed_at DESC, id DESC`, args: scope })).rows;
  // El snapshot solo recibe retiros del registro físico exacto, incluidos los
  // de otros cajeros de esa misma gaveta continua; no incorpora retiros legados.
  const withdrawalAccess = withdrawalScopeSql({ registerId: register, accountId: null, includeLegacy: false });
  const withdrawals = (await tx.execute({
    sql: `SELECT id, client_withdrawal_id, method, amount, register_id, account_id,
                 created_at, cash_close_id, voided_at
          FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL
            AND ${withdrawalAccess.sql}
          ORDER BY created_at, id`,
    args: [req.userId, ...withdrawalAccess.args],
  })).rows;
  const withdrawalStates = (await tx.execute({
    sql: `SELECT id, cash_close_id, voided_at,
                 CASE WHEN cash_close_id IS NULL THEN 0 ELSE 1 END AS closed,
                 CASE WHEN voided_at IS NULL THEN 0 ELSE 1 END AS voided
          FROM cash_withdrawals WHERE user_id = ?
            AND ${withdrawalAccess.sql}
          ORDER BY id`,
    args: [req.userId, ...withdrawalAccess.args],
  })).rows;
  const members = [{ account_id: req.accountId }];
  const currentPeriods = {};
  for (const member of members) {
    const register = registerOf(device, member.account_id);
    const memberWithdrawalAccess = withdrawalScopeSql({ registerId: register, accountId: null, includeLegacy: false });
    const openSales = sales.filter((s) => s.register_id === register && s.cash_close_id == null);
    const openPurchases = purchases.filter((p) => p.register_id === register && p.cash_close_id == null);
    const last = closes.find((c) => c.register_id === register);
    const openWithdrawal = (await tx.execute({
      // Per-member status only; no amounts from another member are projected.
      sql: `SELECT created_at FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL
            AND ${memberWithdrawalAccess.sql} ORDER BY created_at`,
      args: [req.userId, ...memberWithdrawalAccess.args],
    })).rows;
    const first = [...openSales, ...openPurchases, ...openWithdrawal].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    currentPeriods[register] = { register_id: register, opened_at: last?.closed_at || first?.created_at || null, has_sales: !!(openSales.length || openPurchases.length || openWithdrawal.length), is_first_close: !last };
  }
  return { products, sales: sales.map((s) => ({ ...s, items: bySale.get(s.id) || [] })), currency_purchases: purchases,
    cash_closes: closes, cash_withdrawals: withdrawals, withdrawal_states: withdrawalStates, shared_device: device, current_periods: currentPeriods,
    current_period: currentPeriods[registerOf(device, req.accountId)], cash_close_coverage_version: 1 };
}
module.exports = { sharedSnapshot };
