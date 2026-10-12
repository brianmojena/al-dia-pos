const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');
const push = require('../lib/push');

/**
 * El dueño recibe un aviso en el teléfono por cada venta. Los transportes de
 * Apple/Google se sustituyen por espías: aquí se prueba el cableado (quién
 * recibe qué), no la red.
 */
test('avisos push de venta', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const enviados = { ios: [], android: [] };
  const original = { ...push.transports };
  push.transports.ios = async (tokens, message) => { enviados.ios.push({ tokens, message }); return []; };
  push.transports.android = async (tokens, message) => { enviados.android.push({ tokens, message }); return []; };
  t.after(() => Object.assign(push.transports, original));

  const token = await registerUser(ctx.api);
  const productId = await createProduct(ctx.api, token, { stock: 10 });
  const vender = (tk, extra = {}) => ctx.api('POST', '/api/sales', {
    token: tk,
    body: { items: [{ product_id: productId, quantity: 1, unit_price: 100 }], payment_method: 'efectivo', ...extra },
  });

  await t.test('registrar valida plataforma y token', async () => {
    assert.equal((await ctx.api('POST', '/api/push/register', { token, body: { platform: 'web', token: 'x' } })).status, 400);
    assert.equal((await ctx.api('POST', '/api/push/register', { token, body: { platform: 'ios' } })).status, 400);
  });

  await t.test('sin dispositivos registrados no se envía nada', async () => {
    assert.equal((await vender(token)).status, 201);
    assert.equal(enviados.ios.length + enviados.android.length, 0);
  });

  await t.test('cada venta avisa a los teléfonos del dueño, por plataforma', async () => {
    await ctx.api('POST', '/api/push/register', { token, body: { platform: 'ios', token: 'tok-ios' } });
    await ctx.api('POST', '/api/push/register', { token, body: { platform: 'android', token: 'tok-and' } });
    assert.equal((await vender(token)).status, 201);
    assert.deepEqual(enviados.ios[0].tokens, ['tok-ios']);
    assert.deepEqual(enviados.android[0].tokens, ['tok-and']);
    assert.match(enviados.ios[0].message.title, /^Venta \$ 100$/);
  });

  await t.test('registrar dos veces el mismo token no lo duplica', async () => {
    await ctx.api('POST', '/api/push/register', { token, body: { platform: 'ios', token: 'tok-ios' } });
    const rows = (await ctx.db.execute("SELECT * FROM push_devices WHERE token = 'tok-ios'")).rows;
    assert.equal(rows.length, 1);
  });

  await t.test('un reintento idempotente no vuelve a avisar', async () => {
    const antes = enviados.ios.length;
    const body = { client_sale_id: 'abc-1' };
    await vender(token, body);
    await vender(token, body);
    assert.equal(enviados.ios.length, antes + 1);
  });

  await t.test('un cajero no puede registrar teléfono', async () => {
    await ctx.api('POST', '/api/auth/cashiers', { token, body: { email: 'caj@test.local', password: 'cajero1234' } });
    const login = await ctx.api('POST', '/api/auth/login', { body: { email: 'caj@test.local', password: 'cajero1234' } });
    const res = await ctx.api('POST', '/api/push/register', { token: login.body.token, body: { platform: 'ios', token: 'tok-caj' } });
    assert.equal(res.status, 403);
  });

  await t.test('cerrar sesión borra el token', async () => {
    await ctx.api('DELETE', '/api/push/register', { token, body: { token: 'tok-and' } });
    const rows = (await ctx.db.execute("SELECT * FROM push_devices WHERE token = 'tok-and'")).rows;
    assert.equal(rows.length, 0);
  });
});
