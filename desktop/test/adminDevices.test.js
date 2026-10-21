const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb } = require('./helpers');
const { apiRequest } = require('../src/sync/apiClient');
const { routeRequest } = require('../src/router');

test('identidad y panel administrativo en escritorio', async t => {
  const ctx = startLocalDb();
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; ctx.close(); });
  const calls = [];
  let status = 200;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ accounts: [], unique_device_count: 0 }), { status });
  };
  await apiRequest('GET', '/api/products', { token: 'token' });
  await apiRequest('POST', '/api/auth/login', { body: { email: 'a', password: 'b' } });
  assert.equal(calls[0].options.headers['X-Device-Id'], ctx.queries.getRegisterId());
  assert.equal(calls[1].options.headers['X-Device-Id'], calls[0].options.headers['X-Device-Id']);
  assert.equal(calls[0].options.headers['X-Device-Platform'], 'desktop');
  ctx.queries.setSession({ user_id: 1, email: 'admin@test.local', store_name: 'Tienda', plan: 'dev', token: 'token', is_admin: true });
  assert.equal((await routeRequest('GET', '/api/auth/me')).data.user.is_admin, true);
  assert.equal((await routeRequest('GET', '/api/admin/devices')).status, 200);
  status = 401;
  assert.equal((await routeRequest('GET', '/api/admin/devices')).status, 403);
  assert.ok(ctx.queries.getSession(), 'la sesión local sigue disponible si venció la nube');
  global.fetch = async () => { throw new Error('Sin red'); };
  assert.equal((await routeRequest('GET', '/api/admin/devices')).status, 503);
});
