const { isAdminEmail } = require('../config');
const { planStateOf } = require('./plans');

const publicUser = (account, shop = account) => ({
  id: Number(account.id), email: account.email, role: account.role || 'dueño', created_at: account.created_at,
  store_name: shop.store_name, plan: shop.plan,
  transfer_limit: shop.transfer_limit ?? null, usd_rate: shop.usd_rate ?? null, eur_rate: shop.eur_rate ?? null,
  warehouse_enabled: Number(shop.warehouse_enabled ?? 1) !== 0,
  ...planStateOf(shop), is_admin: isAdminEmail(account.email),
});

module.exports = { publicUser };
