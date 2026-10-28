const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

process.env.ADMIN_EMAILS = 'brianadmin@aldia.cu';
const ADMIN_EMAIL = 'brianadmin@aldia.cu';
const suffix = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;
const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const pin = () => ({ salt: 'a'.repeat(32), hash: 'b'.repeat(64), iterations: 100000 });

test('caja centralizada: el dueño como miembro del aparato', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  await ctx.db.execute({
    sql: `INSERT INTO users (email, password_hash, store_name, plan, plan_status, is_admin) VALUES (?, ?, 'Admin', 'enterprise', 'active', 1)`,
    args: [ADMIN_EMAIL, bcrypt.hashSync('test1234', 10)],
  });
  const adminToken = (await ctx.api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'test1234' } })).body.token;

  const makeShop = async () => {
    const s = suffix();
    const ownerToken = await registerUser(ctx.api, `dueno-${s}@test.local`);
    const ownerId = Number((await ctx.api('GET', '/api/auth/me', { token: ownerToken })).body.user.id);
    const cashier = await createCashier(ctx.api, ownerToken, { email: `cajero-${s}@test.local` });
    const productId = await createProduct(ctx.api, ownerToken, { name: `Pan ${s}`, stock: 100, sale_price: 100, purchase_price: 60 });
    return { ownerToken, ownerId, cashier, productId };
  };
  const provision = (shop, extra = {}) => ctx.api('POST', '/api/admin/shared-devices', {
    token: adminToken,
    body: { owner_id: shop.ownerId, name: 'Caja', continuous: true, cashiers: [{ id: Number(shop.cashier.id), display_name: 'Ana' }], ...extra },
  });
  const central = { central: true, owner: { display_name: 'Dueño' } };
  const items = (shop) => [{ product_id: shop.productId, quantity: 1, unit_price: 100 }];
  const ownerOf = (bundle) => bundle.cashiers.find((c) => c.role === 'dueño');
  const cashierOf = (bundle) => bundle.cashiers.find((c) => c.role === 'cajero');

  await t.test('emite token de dueño solo en aparato central; claims correctos', async () => {
    const shop = await makeShop();
    const res = await provision(shop, central);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.device.central, true);
    const claims = payloadOf(ownerOf(res.body).token);
    assert.equal(claims.role, 'dueño');
    assert.equal(claims.deviceMode, 'central');
    assert.equal(claims.accountId, shop.ownerId);
    assert.ok(claims.deviceId && claims.deviceVersion && claims.exp);
    assert.equal(payloadOf(cashierOf(res.body).token).deviceMode, undefined);
    assert.equal(cashierOf(res.body).pin, undefined);
  });

  await t.test('aparato no central rechaza al dueño como miembro y no lo emite', async () => {
    const shop = await makeShop();
    assert.equal((await provision(shop, { owner: { display_name: 'Dueño' } })).status, 400);
    assert.equal((await provision(shop, { central: true })).status, 400);
    assert.equal((await provision(shop, { ...central, continuous: false })).status, 400);
    const plain = await provision(shop);
    assert.equal(plain.status, 201);
    assert.equal(plain.body.cashiers.some((c) => c.role === 'dueño'), false);
    assert.equal(plain.body.device.central, false);
    // Aunque alguien inserte la fila a mano, un aparato no central no la honra.
    await ctx.db.execute({ sql: "INSERT INTO shared_device_cashiers (device_id, account_id, display_name, member_role) VALUES (?, ?, 'x', 'dueño')", args: [plain.body.device.id, shop.ownerId] });
    const renewed = await ctx.api('GET', '/api/auth/shared-device', { token: cashierOf(plain.body).token });
    assert.equal(renewed.body.cashiers.some((c) => c.role === 'dueño'), false);
    // Un token de dueño forjado con la clave tampoco vale: rol/aparato se releen de la base.
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ userId: shop.ownerId, accountId: shop.ownerId, role: 'dueño', deviceId: plain.body.device.id, deviceVersion: 1 }, require('../config').JWT_SECRET, { expiresIn: '1d' });
    const r = await ctx.api('GET', '/api/sync/snapshot?limit=5', { token: forged });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'DEVICE_REVOKED');
  });

  await t.test('solo una caja central activa por tienda', async () => {
    const shop = await makeShop();
    assert.equal((await provision(shop, central)).status, 201);
    assert.equal((await provision(shop, central)).status, 409);
  });

  await t.test('PIN del dueño en activación remota: exige derivación válida y no hay PIN en claro', async () => {
    const shop = await makeShop();
    const cashiers = [{ id: Number(shop.cashier.id), display_name: 'Ana', pin: pin() }];
    assert.equal((await provision(shop, { ...central, enroll: true, cashiers })).status, 400);
    const ok = await provision(shop, { central: true, owner: { display_name: 'Dueño', pin: pin() }, enroll: true, cashiers });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const redeem = await ctx.api('POST', '/api/shared', { body: { code: ok.body.code } });
    assert.equal(redeem.status, 200, JSON.stringify(redeem.body));
    assert.deepEqual(ownerOf(redeem.body).pin, pin());
  });

  await t.test('dueño ve costos y ganancia, cajero no, en el mismo aparato', async () => {
    const shop = await makeShop();
    const bundle = (await provision(shop, central)).body;
    const ownerT = ownerOf(bundle).token;
    const cashT = cashierOf(bundle).token;
    const saleOwner = await ctx.api('POST', '/api/sales', { token: ownerT, body: { client_sale_id: 'dueno-1', items: items(shop) } });
    assert.equal(saleOwner.status, 201, JSON.stringify(saleOwner.body));
    assert.equal(saleOwner.body.profit, 40);
    const saleCash = await ctx.api('POST', '/api/sales', { token: cashT, body: { client_sale_id: 'caj-1', items: items(shop) } });
    assert.equal(saleCash.status, 201);
    assert.equal(saleCash.body.profit, undefined);

    const o = await ctx.api('GET', '/api/sync/snapshot?limit=50', { token: ownerT });
    assert.equal(o.status, 200);
    assert.equal(o.body.products[0].purchase_price, 60);
    assert.ok(o.body.sales.every((s) => 'profit' in s));
    assert.equal(o.body.shared_device.central, true);
    assert.ok(o.body.current_period);
    const c = await ctx.api('GET', '/api/sync/snapshot?limit=50', { token: cashT });
    assert.equal('purchase_price' in c.body.products[0], false);
    assert.ok(c.body.sales.every((s) => !('profit' in s)));
    assert.equal(c.body.cashiers, undefined);
    // Snapshot completo (sin paginar) también respeta el rol.
    const full = await ctx.api('GET', '/api/sync/snapshot', { token: ownerT });
    assert.equal(full.body.products[0].purchase_price, 60);
    assert.equal(full.body.shared_device.central, true);
  });

  await t.test('register_id: dueño comparte shared:<dev> con cajeros y no con la web', async () => {
    const shop = await makeShop();
    const bundle = (await provision(shop, central)).body;
    const dev = `shared:${bundle.device.id}`;
    await ctx.api('POST', '/api/sales', { token: ownerOf(bundle).token, body: { client_sale_id: 'o-dev', register_id: 'web:999', items: items(shop) } });
    await ctx.api('POST', '/api/sales', { token: cashierOf(bundle).token, body: { client_sale_id: 'c-dev', items: items(shop) } });
    await ctx.api('POST', '/api/sales', { token: shop.ownerToken, body: { client_sale_id: 'o-web', register_id: 'web', items: items(shop) } });
    const reg = async (id) => (await ctx.db.execute({ sql: 'SELECT register_id FROM sales WHERE client_sale_id = ?', args: [id] })).rows[0].register_id;
    assert.equal(await reg('o-dev'), dev);
    assert.equal(await reg('c-dev'), dev);
    assert.equal(await reg('o-web'), `web:${shop.ownerId}`);
    // Reintento idempotente del dueño pasa sharedOperationMatches; el de otro registro no.
    const replay = await ctx.api('POST', '/api/sales', { token: ownerOf(bundle).token, body: { client_sale_id: 'o-dev', items: items(shop) } });
    assert.equal(replay.status, 200);
    assert.equal((await ctx.api('POST', '/api/sales', { token: ownerOf(bundle).token, body: { client_sale_id: 'o-web', items: items(shop) } })).status, 409);
    // Extracción del dueño en el aparato cae en la misma gaveta.
    const w = await ctx.api('POST', '/api/cash-withdrawals', { token: ownerOf(bundle).token, body: { client_withdrawal_id: 'w1', method: 'efectivo', amount: 10, register_id: 'web' } });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assert.equal(w.body.register_id, dev);
  });

  await t.test('la web del dueño sigue igual (sin shared, proyección completa)', async () => {
    const shop = await makeShop();
    const r = await ctx.api('GET', '/api/sync/snapshot?limit=50', { token: shop.ownerToken });
    assert.equal(r.status, 200);
    assert.equal(r.body.shared_device, undefined);
    assert.equal(r.body.products[0].purchase_price, 60);
  });

  await t.test('renovación en lote: dueño y cajeros; también desde el token del dueño', async () => {
    const shop = await makeShop();
    const bundle = (await provision(shop, central)).body;
    const res = await ctx.api('GET', '/api/auth/shared-device', { token: ownerOf(bundle).token });
    assert.equal(res.status, 200);
    assert.equal(res.body.cashiers.length, 2);
    const o = ownerOf(res.body);
    assert.equal(payloadOf(o.token).role, 'dueño');
    assert.ok(payloadOf(o.token).exp > payloadOf(ownerOf(bundle).token).exp - 5);
    assert.equal(cashierOf(res.body).role, 'cajero');
    const adminRenew = await ctx.api('POST', `/api/admin/shared-devices/${bundle.device.id}/renew`, { token: adminToken });
    assert.equal(adminRenew.body.cashiers.length, 2);
  });

  await t.test('revocar miembro o aparato corta el token del dueño', async () => {
    const shop = await makeShop();
    const bundle = (await provision(shop, central)).body;
    const ownerT = ownerOf(bundle).token;
    await ctx.db.execute({ sql: "UPDATE shared_device_cashiers SET active = 0 WHERE device_id = ? AND member_role = 'dueño'", args: [bundle.device.id] });
    const a = await ctx.api('GET', '/api/sync/snapshot?limit=5', { token: ownerT });
    assert.equal(a.status, 403);
    assert.equal(a.body.code, 'MEMBER_REVOKED');
    assert.equal((await ctx.api('GET', '/api/sync/snapshot?limit=5', { token: cashierOf(bundle).token })).status, 200);
    await ctx.db.execute({ sql: "UPDATE shared_device_cashiers SET active = 1 WHERE device_id = ? AND member_role = 'dueño'", args: [bundle.device.id] });
    assert.equal((await ctx.api('GET', '/api/sync/snapshot?limit=5', { token: ownerT })).status, 200);
    assert.equal((await ctx.api('DELETE', `/api/admin/shared-devices/${bundle.device.id}`, { token: adminToken })).status, 200);
    const b = await ctx.api('GET', '/api/sync/snapshot?limit=5', { token: ownerT });
    assert.equal(b.status, 403);
    assert.equal(b.body.code, 'DEVICE_REVOKED');
  });
});
