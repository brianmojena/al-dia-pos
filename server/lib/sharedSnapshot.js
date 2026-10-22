const { registerOf } = require('./sharedDevices');

async function sharedSnapshot(tx, req) {
  const device = req.sharedDevice;
  // Igualdad del dispositivo o prefijo completo terminado en ':'. El UUID
  // proviene de la autorización del servidor, nunca del query del navegador.
  const deviceScope = '(register_id = ? OR register_id LIKE ?)';
  const scope = [req.userId, `shared:${device.id}`, `shared:${device.id}:%`];
  const products = (await tx.execute({ sql: 'SELECT * FROM products WHERE user_id = ? ORDER BY name', args: [req.userId] })).rows
    .map(({ purchase_price, ...product }) => product);
  const sales = (await tx.execute({
    sql: `SELECT id, client_sale_id, total, payment_method, transfer_amount, foreign_currency, foreign_amount,
          exchange_rate, shop_rate, cash_received, created_at, register_id, account_id, account_email, cash_close_id
          FROM sales WHERE user_id = ? AND ${deviceScope} ORDER BY created_at DESC, id DESC`, args: scope,
  })).rows;
  const items = (await tx.execute({
    sql: `SELECT i.id, i.sale_id, i.product_id, i.product_name, i.quantity, i.unit_price, i.pack_size, p.unit
          FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id
          WHERE s.user_id = ? AND (s.register_id = ? OR s.register_id LIKE ?) ORDER BY i.id`, args: scope,
  })).rows;
  const bySale = new Map();
  for (const item of items) { if (!bySale.has(item.sale_id)) bySale.set(item.sale_id, []); bySale.get(item.sale_id).push(item); }
  const purchases = (await tx.execute({ sql: `SELECT * FROM currency_purchases WHERE user_id = ? AND ${deviceScope} ORDER BY created_at DESC, id DESC`, args: scope })).rows;
  const closes = (await tx.execute({ sql: `SELECT * FROM cash_closes WHERE user_id = ? AND ${deviceScope} ORDER BY closed_at DESC, id DESC`, args: scope })).rows;
  // Regla existente del negocio: la extracción que hizo el dueño desde otro
  // aparato entra en el próximo cierre de la tienda, sin depender de su caja.
  const withdrawals = (await tx.execute({ sql: 'SELECT * FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL ORDER BY created_at, id', args: [req.userId] })).rows;
  const members = (await tx.execute({ sql: 'SELECT account_id FROM shared_device_cashiers WHERE device_id = ? AND active = 1', args: [device.id] })).rows;
  const currentPeriods = {};
  for (const member of members) {
    const register = registerOf(device, member.account_id);
    const openSales = sales.filter((s) => s.register_id === register && s.cash_close_id == null);
    const openPurchases = purchases.filter((p) => p.register_id === register && p.cash_close_id == null);
    const last = closes.find((c) => c.register_id === register);
    const first = [...openSales, ...openPurchases, ...withdrawals].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    currentPeriods[register] = { register_id: register, opened_at: last?.closed_at || first?.created_at || null, has_sales: !!(openSales.length || openPurchases.length || withdrawals.length), is_first_close: !last };
  }
  return { products, sales: sales.map((s) => ({ ...s, items: bySale.get(s.id) || [] })), currency_purchases: purchases,
    cash_closes: closes, cash_withdrawals: withdrawals, shared_device: device, current_periods: currentPeriods,
    current_period: currentPeriods[registerOf(device, req.accountId)], cash_close_coverage_version: 1 };
}
module.exports = { sharedSnapshot };
