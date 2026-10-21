const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { startTestServer, registerUser, createCashier, createProduct } = require('./helpers');
process.env.ADMIN_EMAILS = 'admin-anterior@test.local';
process.env.AUDIT_ENABLED = '1';

test('actualizar una base anterior conserva clientes, sesiones e historial', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const owner = await registerUser(ctx.api, 'cliente-anterior@test.local');
  const account = jwt.decode(owner);
  const cashier = await createCashier(ctx.api, owner);
  const productId = await createProduct(ctx.api, owner, { stock: 20, sale_price: 100 });
  const legacyToken = jwt.sign({ userId: account.userId }, 'test-secret', { expiresIn: '30d' });
  const oldSale = { client_sale_id: 'venta-anterior', items: [{ product_id: productId, quantity: 2, unit_price: 100 }] };
  const sold = await ctx.api('POST', '/api/sales', { token: legacyToken, body: oldSale });
  assert.equal(sold.status, 201);
  const closed = await ctx.api('POST', '/api/cash-closes', { token: legacyToken,
    body: { client_close_id: 'cierre-anterior', counted_cash: 200, register_id: 'web' } });
  assert.equal(closed.status, 201);
  await ctx.db.execute({ sql: `INSERT INTO users (email, password_hash, store_name, plan, plan_status)
    VALUES (?, ?, 'Administración anterior', 'enterprise', 'active')`,
    args: ['admin-anterior@test.local', bcrypt.hashSync('test1234', 10)] });
  const adminId = Number((await ctx.db.execute("SELECT id FROM users WHERE email = 'admin-anterior@test.local'")).rows[0].id);
  const adminToken = jwt.sign({ userId: adminId }, 'test-secret', { expiresIn: '30d' });
  const tables = {
    users: 'id, email, password_hash, store_name, plan, plan_status, role, owner_id, trial_ends_at',
    products: 'id, user_id, name, stock, purchase_price, sale_price, pack_size',
    sales: 'id, user_id, client_sale_id, total, profit, account_id, account_email, cash_close_id, created_at',
    sale_items: '*',
    cash_closes: 'id, user_id, client_close_id, expected_cash, counted_cash, difference, closed_at',
  };
  const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(tables).map(async ([table, columns]) =>
    [table, (await ctx.db.execute(`SELECT ${columns} FROM ${table} ORDER BY id`)).rows])));
  const before = await snapshot();
  // Quitar solo en esta base temporal las incorporaciones de esta versión.
  for (const name of ['is_admin', 'reset_code_hash', 'reset_code_expires_at', 'reset_attempts']) {
    await ctx.db.execute(`ALTER TABLE users DROP COLUMN ${name}`);
  }
  await ctx.db.execute('DROP TABLE audit_jobs');
  await ctx.db.execute('DROP TABLE audit_reports');
  await ctx.db.execute("DELETE FROM schema_migrations WHERE key = 'admin_flag_v1'");
  const { initDb } = require('../db/database');
  await initDb();
  await initDb();
  assert.deepEqual(await snapshot(), before, 'la migración y su repetición preservan los datos anteriores');
  assert.equal((await ctx.api('GET', '/api/auth/me', { token: legacyToken })).status, 200, 'conserva tokens anteriores');
  assert.equal((await ctx.api('GET', '/api/auth/me', { token: cashier.token })).status, 200);
  const admin = await ctx.api('GET', '/api/auth/me', { token: adminToken });
  assert.equal(admin.body.user.is_admin, true, 'el administrador anterior conserva el acceso');
  assert.equal((await ctx.api('GET', '/api/admin/shops', { token: adminToken })).status, 200);
  assert.equal((await ctx.api('POST', '/api/auth/login', {
    body: { email: 'cliente-anterior@test.local', password: 'test1234' } })).status, 200, 'conserva contraseñas');
  const replay = await ctx.api('POST', '/api/sales', { token: legacyToken, body: oldSale });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, sold.body.id, 'una respuesta perdida anterior no duplica la venta');
  assert.equal((await ctx.db.execute({ sql: 'SELECT stock FROM products WHERE id = ?', args: [productId] })).rows[0].stock, 18);
  const v1 = await ctx.api('GET', '/api/sync/snapshot', { token: legacyToken });
  assert.equal(v1.status, 200);
  assert.ok(v1.body.sales.some((row) => row.id === sold.body.id));
  assert.ok(v1.body.cash_closes.some((row) => row.id === closed.body.id));
  assert.equal(v1.body.cursors, undefined, 'el cliente anterior conserva su protocolo');
  const edit = await ctx.api('PUT', `/api/products/${productId}`, { token: cashier.token, body: { sale_price: 110, add_stock: 1 } });
  assert.equal(edit.status, 200, 'operation_id es opcional para clientes anteriores');
  assert.equal(edit.body.stock, 19);
  assert.equal((await ctx.api('POST', `/api/admin/shops/${account.userId}/reset-code`, { token: adminToken })).status, 200);
});
