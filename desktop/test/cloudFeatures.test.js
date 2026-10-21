const test = require('node:test');
const assert = require('node:assert/strict');
const apiPath = require.resolve('../src/sync/apiClient');
let reply = async () => ({ ok: true, status: 200, data: { ok: true } });
const requests = [];
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true,
  exports: { apiRequest: async (...args) => { requests.push(args); return reply(...args); } } };
const { routeRequest } = require('../src/router');
const { startLocalDb, crearProductoSincronizado } = require('./helpers');

test('recuperación y auditoría cloud conservan la caja local', async (t) => {
  const ctx = startLocalDb();
  t.after(() => ctx.close());
  const pan = crearProductoSincronizado(ctx.queries, { stock: 10 });
  ctx.queries.createSaleLocal({ items: [{ product_id: pan.id, quantity: 1, unit_price: 100 }] });
  const queue = ctx.db.prepare('SELECT * FROM outbox').all();
  const session = ctx.queries.getSession();
  ctx.queries.clearSession();
  const body = { email: 'tienda@test.local', code: 'ABCD1234', new_password: 'nueva1234' };
  const reset = await routeRequest('POST', '/api/auth/reset-password', body);
  assert.equal(reset.status, 200, 'recuperación funciona sin sesión local');
  assert.equal(requests.at(-1)[2].token, undefined, 'no adjunta credenciales de otra cuenta');
  assert.deepEqual(requests.at(-1)[2].body, body);
  ctx.queries.setSession(session);
  assert.equal((await routeRequest('GET', '/api/audit/reports')).status, 403, 'cajero no consulta informes');
  ctx.queries.setSession({ ...session, role: 'dueño' });
  reply = async () => ({ ok: false, status: 401, data: { error: 'Expirada' } });
  assert.equal((await routeRequest('GET', '/api/audit/reports')).status, 403, '401 remoto no cierra la caja');
  reply = async () => { throw new Error('Sin red'); };
  assert.equal((await routeRequest('GET', '/api/audit/reports')).status, 503);
  assert.equal((await routeRequest('POST', '/api/auth/reset-password', body)).status, 503);
  assert.ok(ctx.queries.getSession(), 'conserva la sesión local');
  assert.deepEqual(ctx.db.prepare('SELECT * FROM outbox').all(), queue, 'ningún fallo cloud toca ventas pendientes');
  assert.equal(ctx.db.prepare('SELECT stock FROM products WHERE id = ?').get(pan.id).stock, 9);
});
