const test = require('node:test');
const assert = require('node:assert/strict');
const { operationTime } = require('../lib/operationTime');
const { startTestServer, registerUser, createProduct } = require('./helpers');

test('fechas: conserva el pasado, rechaza formatos inválidos y permite reintentar un reloj adelantado', () => {
  assert.equal(operationTime(null), null);
  assert.equal(operationTime('2026-01-01T12:34:56.000Z'), '2026-01-01 12:34:56');
  for (const value of ['mañana', '2026-01-01 12:34:56', '2026-99-99T12:00:00Z']) {
    assert.throws(() => operationTime(value), /Fecha de operación inválida/);
  }
  assert.throws(() => operationTime(new Date(Date.now() + 3600000).toISOString()), (e) =>
    e.status === 503 && e.code === 'CLOCK_AHEAD' && Number.isFinite(Date.parse(e.server_time)));
});

test('un reloj adelantado no pierde el cobro ni descuenta stock; el mismo identificador se recupera una sola vez', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await registerUser(ctx.api);
  const product = await createProduct(ctx.api, token, { stock: 20 });
  const body = { client_sale_id: 'clock-sale', payment_method: 'efectivo',
    sold_at: new Date(Date.now() + 3600000).toISOString(),
    items: [{ product_id: product, quantity: 7, unit_price: 330 }] };
  const pending = await ctx.api('POST', '/api/sales', { token, body });
  assert.equal(pending.status, 503);
  assert.equal(pending.body.code, 'CLOCK_AHEAD');
  assert.equal((await ctx.db.execute({ sql: 'SELECT stock FROM products WHERE id=?', args: [product] })).rows[0].stock, 20);
  assert.equal((await ctx.db.execute('SELECT COUNT(*) AS n FROM sales')).rows[0].n, 0);
  const recovered = await ctx.api('POST', '/api/sales', { token, body: { ...body, sold_at: new Date().toISOString() } });
  assert.equal(recovered.status, 201);
  const replay = await ctx.api('POST', '/api/sales', { token, body });
  assert.equal(replay.status, 200, 'una respuesta perdida no vuelve a validar la fecha del cobro ya registrado');
  assert.equal(replay.body.id, recovered.body.id);
  assert.equal((await ctx.db.execute({ sql: 'SELECT stock FROM products WHERE id=?', args: [product] })).rows[0].stock, 13);
});
