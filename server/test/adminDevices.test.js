const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startTestServer, registerUser, createCashier } = require('./helpers');

test('panel privado y registro de dispositivos', async t => {
  const previousAdmins = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  const ctx = await startTestServer();
  t.after(async () => {
    if (previousAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdmins;
    await ctx.close();
  });
  const admin = await registerUser(ctx.api, 'admin@test.local');
  const owner = await registerUser(ctx.api, 'owner@test.local');
  const cashier = await createCashier(ctx.api, owner, { email: 'cashier@test.local' });
  const deviceRequest = async (method, path, { token, id = 'web-device-00000001', platform = 'web', body } = {}) => {
    const res = await fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json', 'X-Device-Id': id,
        'X-Device-Platform': platform, 'User-Agent': 'Mozilla/5.0 (iPhone) Safari/604.1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const report = async () => (await ctx.api('GET', '/api/admin/devices', { token: admin })).body;

  await t.test('sin allowlist nadie puede entrar; después solo el email configurado', async () => {
    assert.equal((await ctx.api('GET', '/api/admin/devices')).status, 401);
    assert.equal((await ctx.api('GET', '/api/admin/devices', { token: admin })).status, 403);
    process.env.ADMIN_EMAILS = ' ADMIN@TEST.LOCAL , ';
    for (const token of [owner, cashier.token]) {
      assert.equal((await ctx.api('GET', '/api/admin/devices', { token })).status, 403);
    }
    const privateResponse = await deviceRequest('GET', '/api/admin/devices', { token: admin, id: 'web-admin-00000001' });
    assert.equal(privateResponse.status, 200);
    assert.equal(privateResponse.headers.get('cache-control'), 'no-store');
    assert.equal(privateResponse.body.accounts.length, 3);
    assert.equal(privateResponse.body.accounts.find(a => a.email === 'owner@test.local').device_count, 0);
    assert.equal(JSON.stringify(privateResponse.body).includes('password_hash'), false);
    assert.equal(JSON.stringify(privateResponse.body).includes(admin), false);
    assert.equal((await ctx.api('GET', '/api/auth/me', { token: admin })).body.user.is_admin, true);
    assert.equal((await ctx.api('GET', '/api/auth/me', { token: owner })).body.user.is_admin, false);
  });

  await t.test('un JWT con is_admin inventado no da permiso; revocar el email aplica inmediatamente', async () => {
    const fakeCapability = jwt.sign({ ...jwt.decode(owner), is_admin: true }, process.env.JWT_SECRET);
    assert.equal((await ctx.api('GET', '/api/admin/devices', { token: fakeCapability })).status, 403);
    delete process.env.ADMIN_EMAILS;
    assert.equal((await ctx.api('GET', '/api/admin/devices', { token: admin })).status, 403);
    process.env.ADMIN_EMAILS = 'admin@test.local';
  });

  await t.test('emails reservados no pueden reclamar permisos por el registro público', async () => {
    process.env.ADMIN_EMAILS += ',reserved@test.local';
    const reserved = await ctx.api('POST', '/api/auth/register', {
      body: { email: 'reserved@test.local', password: 'test1234', store_name: 'Intruso' },
    });
    assert.equal(reserved.status, 403);
  });

  await t.test('pestañas, reintentos y renovaciones no duplican el dispositivo', async () => {
    const signup = await deviceRequest('POST', '/api/auth/register', {
      body: { email: 'new@test.local', password: 'test1234', store_name: 'Nueva' },
    });
    assert.equal(signup.status, 201);
    for (let i = 0; i < 3; i++) {
      const login = await deviceRequest('POST', '/api/auth/login', {
        body: { email: 'new@test.local', password: 'test1234' },
      });
      await deviceRequest('GET', '/api/products', { token: login.body.token });
    }
    const row = (await report()).accounts.find(a => a.email === 'new@test.local');
    assert.equal(row.device_count, 1);
    assert.equal(row.devices[0].label, 'Safari · iOS');
    assert.equal(row.recent_device_count, 1);
  });

  await t.test('cuentas de cajero y dueño tienen conteos separados, incluyendo escritorio', async () => {
    await deviceRequest('GET', '/api/products', { token: owner });
    await deviceRequest('GET', '/api/products', { token: cashier.token });
    await deviceRequest('GET', '/api/auth/me', { token: cashier.token, id: 'desk-00000000-0000-0000-0000-000000000001', platform: 'desktop' });
    const data = await report();
    assert.equal(data.accounts.find(a => a.email === 'owner@test.local').device_count, 1);
    const row = data.accounts.find(a => a.email === cashier.email);
    assert.equal(row.device_count, 2);
    assert.equal(row.devices.filter(d => d.platform === 'desktop').length, 1);
    assert.equal(data.unique_device_count, 3, 'un mismo navegador compartido no se cuenta dos veces en el total global');
  });

  await t.test('clientes antiguos, login fallido e identidad inválida no crean equipos ficticios', async () => {
    const legacy = await registerUser(ctx.api, 'legacy@test.local');
    await ctx.api('GET', '/api/products', { token: legacy });
    await deviceRequest('GET', '/api/products', { token: legacy, id: '../../wrong' });
    await deviceRequest('GET', '/api/products', { token: legacy, platform: 'invalid' });
    await deviceRequest('POST', '/api/auth/login', { body: { email: 'legacy@test.local', password: 'incorrect' } });
    assert.equal((await report()).accounts.find(a => a.email === 'legacy@test.local').device_count, 0);
  });

  await t.test('actividad reciente se actualiza al reconectar sin cambiar la primera conexión', async () => {
    await ctx.db.execute({
      sql: "UPDATE account_devices SET first_seen_at = datetime('now', '-60 days'), last_seen_at = datetime('now', '-40 days') WHERE account_id = ?",
      args: [cashier.id],
    });
    assert.equal((await report()).accounts.find(a => a.id === cashier.id).recent_device_count, 0);
    await deviceRequest('GET', '/api/products', { token: cashier.token });
    const row = (await report()).accounts.find(a => a.id === cashier.id);
    assert.equal(row.recent_device_count, 1);
    const device = row.devices.find(d => d.platform === 'web');
    assert.ok(device.last_seen_at > device.first_seen_at);
    await ctx.api('DELETE', `/api/auth/cashiers/${cashier.id}`, { token: owner });
    assert.equal((await ctx.db.execute({ sql: 'SELECT * FROM account_devices WHERE account_id = ?', args: [cashier.id] })).rows.length, 0);
  });

  await t.test('un fallo de telemetría no impide usar una sesión válida', async () => {
    await ctx.db.execute('DROP TABLE account_devices');
    const res = await deviceRequest('GET', '/api/auth/me', { token: owner });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, 'owner@test.local');
  });
});
