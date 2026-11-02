const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

test('el dueño anula entradas y descuenta el stock sin perder la auditoría', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const owner = await registerUser(ctx.api);
  const other = await registerUser(ctx.api);
  const cashier = await createCashier(ctx.api, owner, { email: `caja-${Date.now()}@test.local` });
  const product = await createProduct(ctx.api, owner, { stock: 10 });
  await ctx.api('PUT', `/api/products/${product}`, { token: owner, body: { add_stock: 5 } });
  const entries = (await ctx.api('GET', '/api/products/stock-entries', { token: owner })).body;
  const entry = entries.find((item) => item.kind === 'entrada');
  const path = `/api/products/stock-entries/${entry.id}`;

  assert.equal((await ctx.api('DELETE', path, { token: cashier.token })).status, 403);
  assert.equal((await ctx.api('DELETE', path, { token: other })).status, 404);
  assert.equal((await ctx.api('DELETE', path, { token: owner })).status, 200);
  assert.equal((await ctx.api('DELETE', path, { token: owner })).status, 404);
  const products = (await ctx.api('GET', '/api/products', { token: owner })).body;
  assert.equal(Number(products[0].stock), 10);
  const history = (await ctx.api('GET', '/api/products/stock-entries', { token: owner })).body;
  assert.ok(!history.some((item) => item.id === entry.id));
  assert.ok(history.some((item) => item.kind === 'correccion' && Number(item.quantity) === -5));
  const day = (await ctx.api('GET', '/api/products/day-stock', { token: owner })).body;
  assert.equal(Number(day.products[0].entries_stock), 10);

  const initialEntry = entries.find((item) => item.kind === 'nuevo');
  await ctx.api('PUT', `/api/products/${product}`, { token: owner, body: { stock: 3 } });
  assert.equal((await ctx.api('DELETE', `/api/products/stock-entries/${initialEntry.id}`, { token: owner })).status, 409);
  assert.equal(Number((await ctx.api('GET', '/api/products', { token: owner })).body[0].stock), 3);
});
