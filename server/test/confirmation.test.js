const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestServer, registerUser, createCashier } = require('./helpers');

// El panel de administración se protege con el flag is_admin de la cuenta; el
// correo de ADMIN_EMAILS queda reservado y se aprovisiona con el script
// admin:grant (aquí se simula insertando la fila directamente).
// Se fija aquí, antes de que cualquier módulo lea la config, para que el test
// no dependa del entorno de quien lo corra.
process.env.ADMIN_EMAILS = 'brianadmin@aldia.cu';
const ADMIN_EMAIL = 'brianadmin@aldia.cu';

const sufijo = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;

const register = (api, email, extra = {}) => api('POST', '/api/auth/register', {
  body: { email, password: 'test1234', store_name: 'Tienda Nueva', ...extra },
});

/**
 * Confirmación de tiendas: toda cuenta nueva nace 'pending' con 7 días de
 * prueba completa. Si la prueba vence sin que el administrador confirme (el
 * pago es en persona), la tienda entera — dueño y cajeros — queda bloqueada
 * hasta que la confirme desde /admin.
 */
test('confirmación: prueba de 7 días, bloqueo al vencer y panel de administración', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  // La cuenta de administración se crea una sola vez para todo el test, como
  // lo haría `npm run admin:grant`.
  let adminToken = null;
  const adminLogin = async () => {
    if (adminToken) return adminToken;
    await ctx.db.execute({
      sql: `INSERT INTO users (email, password_hash, store_name, plan, plan_status, is_admin)
            VALUES (?, ?, 'Administración', 'enterprise', 'active', 1)`,
      args: [ADMIN_EMAIL, bcrypt.hashSync('test1234', 10)],
    });
    const login = await ctx.api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'test1234' } });
    adminToken = login.body.token;
    return adminToken;
  };

  await t.test('la tienda recién registrada nace pendiente, con 7 días de prueba', async () => {
    const res = await register(ctx.api, `nueva-${sufijo()}@test.local`);
    assert.equal(res.status, 201);
    const u = res.body.user;
    assert.equal(u.plan_status, 'pending');
    assert.equal(u.locked, false);
    assert.equal(u.trial_days_left, 7);
    assert.equal(u.is_admin, false);
    const dias = (new Date(u.trial_ends_at).getTime() - Date.now()) / 86400000;
    assert.ok(dias > 6.9 && dias <= 7.01, `la prueba debe durar ~7 días (fue ${dias})`);
  });

  await t.test('el registro público no puede reclamar el correo de administración', async () => {
    const res = await register(ctx.api, ADMIN_EMAIL);
    assert.equal(res.status, 403);
    const row = await ctx.db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [ADMIN_EMAIL] });
    assert.equal(row.rows.length, 0, 'no debe quedar ninguna cuenta creada con el correo reservado');

    const dueño = await registerUser(ctx.api, `dueno-reservado-${sufijo()}@test.local`);
    const cajero = await ctx.api('POST', '/api/auth/cashiers', {
      token: dueño,
      body: { email: ADMIN_EMAIL, password: 'test1234' },
    });
    assert.equal(cajero.status, 403, 'tampoco un dueño puede crear un cajero con ese correo');
  });

  await t.test('vencida la prueba, la tienda (dueño y cajeros) queda bloqueada; confirmarla desbloquea', async () => {
    const email = `vence-${sufijo()}@test.local`;
    const reg = await register(ctx.api, email);
    const ownerToken = reg.body.token;
    const cajero = await createCashier(ctx.api, ownerToken, {});

    // La prueba vence (no se puede esperar 7 días dentro de un test).
    await ctx.db.execute({
      sql: 'UPDATE users SET trial_ends_at = ? WHERE email = ?',
      args: [new Date(Date.now() - 1000).toISOString(), email],
    });

    const me = await ctx.api('GET', '/api/auth/me', { token: ownerToken });
    assert.equal(me.body.user.locked, true);
    assert.equal(me.body.user.trial_days_left, 0);

    const loginCajero = await ctx.api('POST', '/api/auth/login', { body: { email: cajero.email, password: 'caja1234' } });
    assert.equal(loginCajero.body.user.locked, true, 'el cajero hereda el bloqueo de la tienda');

    // El administrador la ve pendiente y bloqueada en su panel.
    const lista = await ctx.api('GET', '/api/admin/shops', { token: await adminLogin() });
    assert.equal(lista.status, 200);
    const tienda = lista.body.shops.find((s) => s.email === email);
    assert.ok(tienda, 'la tienda vencida aparece en el panel');
    assert.equal(tienda.locked, true);
    assert.equal(tienda.plan_label, 'Basic');

    const confirm = await ctx.api('POST', `/api/admin/shops/${tienda.id}/confirm`, { token: adminToken });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.shop.plan_status, 'active');
    assert.equal(confirm.body.shop.locked, false);

    const me2 = await ctx.api('GET', '/api/auth/me', { token: ownerToken });
    assert.equal(me2.body.user.plan_status, 'active');
    assert.equal(me2.body.user.locked, false);

    const loginCajero2 = await ctx.api('POST', '/api/auth/login', { body: { email: cajero.email, password: 'caja1234' } });
    assert.equal(loginCajero2.body.user.locked, false, 'el cajero también queda desbloqueado');
  });

  await t.test('el panel es solo para administración', async () => {
    const normalToken = await registerUser(ctx.api, `normal-${sufijo()}@test.local`);
    assert.equal((await ctx.api('GET', '/api/admin/shops', { token: normalToken })).status, 403);
    assert.equal((await ctx.api('POST', '/api/admin/shops/1/confirm', { token: normalToken })).status, 403);
    assert.equal((await ctx.api('GET', '/api/admin/shops')).status, 401, 'sin token ni se llega');
  });

  await t.test('la cuenta de administración no aparece en su propio panel', async () => {
    const lista = await ctx.api('GET', '/api/admin/shops', { token: await adminLogin() });
    assert.ok(!lista.body.shops.some((s) => s.email === ADMIN_EMAIL));
    // Y confirmar un id inexistente (o de un cajero) no inventa tiendas.
    assert.equal((await ctx.api('POST', '/api/admin/shops/999999/confirm', { token: adminToken })).status, 404);
  });
});
