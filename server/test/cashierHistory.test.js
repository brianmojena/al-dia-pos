const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createCashier, createProduct } = require('./helpers');
const { todayBounds } = require('../lib/businessDay');

test('cajero: historial de hoy de su tienda, detalles y snapshot sin permisos de modificación', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const owner = await registerUser(ctx.api);
  const cashier = await createCashier(ctx.api, owner);
  const otherOwner = await registerUser(ctx.api);
  const product = await createProduct(ctx.api, owner, { stock: 10 });
  const otherProduct = await createProduct(ctx.api, otherOwner, { stock: 10 });
  const sell = async (token, id) => {
    const res = await ctx.api('POST', '/api/sales', { token, body: { items: [{ product_id: id, quantity: 1, unit_price: 100 }] } });
    assert.equal(res.status, 201);
    return res.body.id;
  };
  const todaySale = await sell(owner, product);
  const cashierSale = await sell(cashier.token, product);
  const oldSale = await sell(owner, product);
  const foreignSale = await sell(otherOwner, otherProduct);
  const { date, start } = todayBounds();
  await ctx.db.execute({ sql: "UPDATE sales SET created_at = datetime(?, '-1 second') WHERE id = ?", args: [start, oldSale] });
  const oldDate = '2000-01-01';
  for (const path of ['/api/sales', `/api/sales?date=${date}`]) {
    const res = await ctx.api('GET', path, { token: cashier.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((s) => s.id).sort(), [todaySale, cashierSale].sort());
    assert.ok(res.body.every((s) => !('profit' in s)));
  }
  assert.equal((await ctx.api('GET', `/api/sales?date=${oldDate}`, { token: cashier.token })).status, 403);
  const detail = await ctx.api('GET', `/api/sales/${todaySale}`, { token: cashier.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.items.length, 1);
  assert.equal(detail.body.items[0].quantity, 1);
  assert.equal('unit_cost' in detail.body.items[0], false);
  assert.equal('profit' in detail.body, false);
  for (const id of [oldSale, foreignSale]) assert.equal((await ctx.api('GET', `/api/sales/${id}`, { token: cashier.token })).status, 404);
  for (const action of ['pago', 'anular']) {
    assert.equal((await ctx.api('POST', `/api/sales/${todaySale}/correct`, { token: cashier.token, body: { action, payment_method: 'transferencia' } })).status, 403);
  }
  const snapshot = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.body.sales.map((s) => s.id).sort(), [todaySale, cashierSale].sort());
  assert.ok(snapshot.body.sales.every((s) => !('profit' in s) && s.items.every((i) => !('unit_cost' in i))));
  assert.equal(snapshot.body.cash_closes, undefined);
  assert.equal((await ctx.api('GET', `/api/sales/${oldSale}`, { token: owner })).status, 200);
  const owned = await ctx.api('GET', `/api/sales/${todaySale}`, { token: owner });
  assert.ok('profit' in owned.body);
  assert.ok('unit_cost' in owned.body.items[0]);
});
