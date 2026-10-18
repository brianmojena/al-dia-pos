const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

// El panel de administración se protege por correo (ADMIN_EMAILS en config).
// Se fija antes de que cualquier módulo lea la config para no depender del entorno.
process.env.ADMIN_EMAILS = 'brianadmin@aldia.cu';
const ADMIN_EMAIL = 'brianadmin@aldia.cu';

const DAY_MS = 24 * 60 * 60 * 1000;
const suffix = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;
const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

/**
 * Caja compartida (PWA): el administrador (ADMIN_EMAILS) aprovisiona los
 * aparatos de una tienda; los cajeros usan un token JWT de dispositivo, no de
 * cuenta, y el servidor resuelve la caja `shared:<deviceId>[:accountId]`.
 */
test('caja compartida (shared device) — servidor', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  // El administrador se crea una sola vez para todo el archivo.
  let adminToken = null;
  const admin = async () => {
    if (adminToken) return adminToken;
    const res = await ctx.api('POST', '/api/auth/register', {
      body: { email: ADMIN_EMAIL, password: 'test1234', store_name: 'Administración' },
    });
    adminToken = res.status === 201
      ? res.body.token
      : (await ctx.api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'test1234' } })).body.token;
    return adminToken;
  };

  /** Dueño + un cajero + un producto con stock. */
  const makeShop = async () => {
    const s = suffix();
    const ownerToken = await registerUser(ctx.api, `dueno-${s}@test.local`);
    const me = await ctx.api('GET', '/api/auth/me', { token: ownerToken });
    const ownerId = Number(me.body.user.id);
    const owner = await createCashier(ctx.api, ownerToken, { email: `cajero-${s}@test.local` });
    const productId = await createProduct(ctx.api, ownerToken, { name: `Pan ${s}`, stock: 100, sale_price: 100, purchase_price: 60 });
    return { ownerToken, ownerId, owner, productId };
  };

  /** Aprovisiona una caja y devuelve el bundle (device + cashiers con token). */
  const provision = async (ownerId, cashiers, { name = 'Caja', continuous = false } = {}) => {
    const res = await ctx.api('POST', '/api/admin/shared-devices', {
      token: await admin(),
      body: { owner_id: ownerId, name, continuous, cashiers },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const member = (bundle, cashier) => bundle.cashiers.find((c) => Number(c.id) === Number(cashier.id));
  const tokenOf = (bundle, cashier) => member(bundle, cashier).token;

  const sell = (token, body) => ctx.api('POST', '/api/sales', { token, body });
  const item = (productId, quantity = 1) => [{ product_id: productId, quantity, unit_price: 100 }];
  const closeRowOf = async (ownerId, clientSaleId) => (await ctx.db.execute({
    sql: 'SELECT cash_close_id, register_id FROM sales WHERE user_id = ? AND client_sale_id = ?',
    args: [ownerId, clientSaleId],
  })).rows[0];

  await t.test('aprovisionar es solo del administrador; lista cajeros solo de la tienda', async () => {
    const shop = await makeShop();
    const cashiers = [{ id: Number(shop.owner.id), display_name: 'Ana' }];

    // Dueño y cajero de la tienda no pueden aprovisionar (ni listar).
    for (const token of [shop.ownerToken, shop.owner.token]) {
      assert.equal((await ctx.api('POST', '/api/admin/shared-devices', { token, body: { owner_id: shop.ownerId, name: 'X', cashiers } })).status, 403);
      assert.equal((await ctx.api('GET', `/api/admin/shared-devices/shops/${shop.ownerId}/cashiers`, { token })).status, 403);
    }
    assert.equal((await ctx.api('POST', '/api/admin/shared-devices', { body: { owner_id: shop.ownerId, name: 'X', cashiers } })).status, 401);

    // El admin ve exactamente los cajeros de esa tienda.
    const lista = await ctx.api('GET', `/api/admin/shared-devices/shops/${shop.ownerId}/cashiers`, { token: await admin() });
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.body.cashiers.map((c) => Number(c.id)), [Number(shop.owner.id)]);
    assert.equal(lista.body.cashiers[0].email, shop.owner.email);

    const bundle = await provision(shop.ownerId, cashiers, { name: 'Mostrador' });
    assert.equal(bundle.device.owner_id, shop.ownerId);
    assert.equal(bundle.device.continuous, false);
    assert.equal(bundle.device.name, 'Mostrador');
    assert.ok(Number.isFinite(Date.parse(bundle.device.expires_at)));
    assert.equal(bundle.cashiers.length, 1);
    assert.equal(bundle.cashiers[0].display_name, 'Ana');
    assert.equal(bundle.cashiers[0].user.role, 'cajero');
    assert.equal(bundle.cashiers[0].user.is_admin, false);
    assert.equal(bundle.cashiers[0].user.store_name, (await ctx.api('GET', '/api/auth/me', { token: shop.ownerToken })).body.user.store_name);
    const p = payloadOf(bundle.cashiers[0].token);
    assert.equal(p.role, 'cajero');
    assert.equal(p.deviceId, bundle.device.id);
    assert.equal(Number(p.userId), shop.ownerId);
    assert.equal(Number(p.accountId), Number(shop.owner.id));
  });

  await t.test('rechaza cajeros de otra tienda', async () => {
    const a = await makeShop();
    const b = await makeShop();
    const res = await ctx.api('POST', '/api/admin/shared-devices', {
      token: await admin(),
      body: { owner_id: a.ownerId, name: 'Caja', cashiers: [{ id: Number(b.owner.id), display_name: 'Ajeno' }] },
    });
    assert.equal(res.status, 400);
  });

  await t.test('un register_id falsificado no escapa del dispositivo', async () => {
    const a = await makeShop();
    const bundle = await provision(a.ownerId, [{ id: Number(a.owner.id), display_name: 'Ana' }]);
    const token = tokenOf(bundle, a.owner);
    const expected = `shared:${bundle.device.id}:${Number(a.owner.id)}`;

    for (const forged of ['web', 'desk-hack-1']) {
      const res = await sell(token, { register_id: forged, client_sale_id: `forge-${forged}`, items: item(a.productId) });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.register_id, expected, `register_id ${forged} no debe escapar`);
      assert.ok(!('profit' in res.body), 'el token compartido no recibe ganancia');
    }
  });

  await t.test('modo continuo: dos actores venden y el cierre cubre solo esta caja', async () => {
    const shop = await makeShop();
    const dos = await createCashier(ctx.api, shop.ownerToken, { email: `c2-${suffix()}@test.local` });
    const bundle = await provision(shop.ownerId, [
      { id: Number(shop.owner.id), display_name: 'Ana' },
      { id: Number(dos.id), display_name: 'Beto' },
    ], { continuous: true, name: 'Kiosco' });
    const ana = tokenOf(bundle, shop.owner);
    const beto = tokenOf(bundle, dos);
    const reg = `shared:${bundle.device.id}`;

    assert.equal((await sell(ana, { client_sale_id: 'cont-a', items: item(shop.productId) })).status, 201);
    assert.equal((await sell(beto, { client_sale_id: 'cont-b', items: item(shop.productId, 2) })).status, 201);
    assert.equal((await closeRowOf(shop.ownerId, 'cont-a')).register_id, reg);
    assert.equal((await closeRowOf(shop.ownerId, 'cont-b')).register_id, reg);

    const otro = await provision(shop.ownerId, [{ id: Number(shop.owner.id), display_name: 'Ana' }], { continuous: true, name: 'Otra' });
    assert.equal((await sell(tokenOf(otro, shop.owner), { client_sale_id: 'otro-dev', items: item(shop.productId) })).status, 201);

    const cierre = await ctx.api('POST', '/api/cash-closes', { token: ana, body: { counted_cash: 300 } });
    assert.equal(cierre.status, 201, JSON.stringify(cierre.body));
    assert.equal(Number(cierre.body.sales_count), 2, 'cubre las ventas de ambos actores del mismo aparato');
    assert.equal(Number(cierre.body.expected_cash), 300);
    assert.ok(cierre.body.cash_close_id === undefined || Number(cierre.body.cash_close_id) > 0 || cierre.body.id > 0);

    assert.equal((await closeRowOf(shop.ownerId, 'cont-a')).cash_close_id, cierre.body.id);
    assert.equal((await closeRowOf(shop.ownerId, 'cont-b')).cash_close_id, cierre.body.id);
    assert.equal((await closeRowOf(shop.ownerId, 'otro-dev')).cash_close_id, null, 'otra caja del mismo dueño queda fuera');
  });

  await t.test('modo no continuo: cada actor cierra solo lo suyo', async () => {
    const shop = await makeShop();
    const dos = await createCashier(ctx.api, shop.ownerToken, { email: `nc-${suffix()}@test.local` });
    const bundle = await provision(shop.ownerId, [
      { id: Number(shop.owner.id), display_name: 'Ana' },
      { id: Number(dos.id), display_name: 'Beto' },
    ], { continuous: false, name: 'Dos turnos' });
    const ana = tokenOf(bundle, shop.owner);
    const beto = tokenOf(bundle, dos);

    assert.equal((await sell(ana, { client_sale_id: 'nc-a', items: item(shop.productId) })).status, 201);
    assert.equal((await sell(beto, { client_sale_id: 'nc-b', items: item(shop.productId, 2) })).status, 201);

    const cierreAna = await ctx.api('POST', '/api/cash-closes', { token: ana, body: { counted_cash: 100 } });
    assert.equal(cierreAna.status, 201);
    assert.equal(Number(cierreAna.body.sales_count), 1, 'el cierre no continuo no toca al otro actor');
    assert.equal((await closeRowOf(shop.ownerId, 'nc-a')).cash_close_id, cierreAna.body.id);
    assert.equal((await closeRowOf(shop.ownerId, 'nc-b')).cash_close_id, null);

    const cierreBeto = await ctx.api('POST', '/api/cash-closes', { token: beto, body: { counted_cash: 200 } });
    assert.equal(cierreBeto.status, 201);
    assert.equal(Number(cierreBeto.body.sales_count), 1);
    assert.equal((await closeRowOf(shop.ownerId, 'nc-b')).cash_close_id, cierreBeto.body.id);
  });

  await t.test('expiración (401), revocación (403) y renovación 30d', async () => {
    const shop = await makeShop();
    const dos = await createCashier(ctx.api, shop.ownerToken, { email: `rev-${suffix()}@test.local` });
    const bundle = await provision(shop.ownerId, [
      { id: Number(shop.owner.id), display_name: 'Ana' },
      { id: Number(dos.id), display_name: 'Beto' },
    ], { continuous: true, name: 'Reversible' });
    const ana = tokenOf(bundle, shop.owner);
    const beto = tokenOf(bundle, dos);

    // Renovación: el bundle refresca el token y mantiene la config (30 días).
    const refreshed = await ctx.api('GET', '/api/auth/shared-device', { token: ana });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.device.id, bundle.device.id);
    assert.equal(refreshed.body.device.continuous, true);
    const exp = payloadOf(member(refreshed.body, shop.owner).token).exp * 1000;
    assert.ok(exp - Date.now() > 29 * DAY_MS, 'el token renovado dura 30 días');
    assert.equal((await ctx.api('POST', `/api/admin/shared-devices/${bundle.device.id}/renew`, { token: await admin() })).status, 200);

    // El cajero revocado individualmente recibe 403; el otro sigue dentro.
    await ctx.db.execute({ sql: 'UPDATE shared_device_cashiers SET active = 0 WHERE device_id = ? AND account_id = ?', args: [bundle.device.id, Number(shop.owner.id)] });
    const kick = await ctx.api('GET', '/api/auth/shared-device', { token: ana });
    assert.equal(kick.status, 403);
    assert.equal(kick.body.code, 'MEMBER_REVOKED');
    assert.equal((await ctx.api('GET', '/api/auth/shared-device', { token: beto })).status, 200);
    await ctx.db.execute({ sql: 'UPDATE shared_device_cashiers SET active = 1 WHERE device_id = ? AND account_id = ?', args: [bundle.device.id, Number(shop.owner.id)] });

    // Expiración: 401 (distinto de la revocación 403). El token normal sigue intacto.
    await ctx.db.execute({ sql: 'UPDATE shared_devices SET expires_at = ? WHERE id = ?', args: [new Date(Date.now() - 1000).toISOString(), bundle.device.id] });
    const expired = await ctx.api('GET', '/api/auth/shared-device', { token: ana });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, 'DEVICE_EXPIRED');
    assert.equal((await ctx.api('GET', '/api/sales', { token: ana })).status, 401);

    // Revocación del dispositivo: 403 y deja de aceptarse para operar.
    await ctx.db.execute({ sql: 'UPDATE shared_devices SET expires_at = ? WHERE id = ?', args: [new Date(Date.now() + DAY_MS).toISOString(), bundle.device.id] });
    const del = await ctx.api('DELETE', `/api/admin/shared-devices/${bundle.device.id}`, { token: await admin() });
    assert.equal(del.status, 200);
    assert.equal(del.body.success, true);
    const revoked = await ctx.api('GET', '/api/auth/shared-device', { token: ana });
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.code, 'DEVICE_REVOKED');
    assert.equal((await ctx.api('POST', '/api/cash-closes', { token: ana, body: { counted_cash: 0 } })).status, 403);
  });

  await t.test('snapshot compartido: datos del aparato sin privilegios del dueño', async () => {
    const shop = await makeShop();
    const dos = await createCashier(ctx.api, shop.ownerToken, { email: `snap-${suffix()}@test.local` });
    const bundle = await provision(shop.ownerId, [
      { id: Number(shop.owner.id), display_name: 'Ana' },
      { id: Number(dos.id), display_name: 'Beto' },
    ], { continuous: true, name: 'Kiosco' });
    const ana = tokenOf(bundle, shop.owner);

    await sell(ana, { client_sale_id: 'snap-a', items: item(shop.productId) });
    await sell(tokenOf(bundle, dos), { client_sale_id: 'snap-b', items: item(shop.productId) });

    const snap = await ctx.api('GET', '/api/sync/snapshot', { token: ana });
    assert.equal(snap.status, 200, JSON.stringify(snap.body));
    assert.equal(snap.body.shared_device.id, bundle.device.id);
    assert.equal(snap.body.current_period.register_id, `shared:${bundle.device.id}`);
    assert.ok(snap.body.current_periods, 'incluye el período por caja para la cobertura');

    // Lo necesario para proyectar inventario y cubrir la caja, sin costos ni ganancia.
    assert.ok(snap.body.products.length > 0);
    assert.ok(snap.body.products.every((p) => !('purchase_price' in p)), 'sin costos');
    assert.ok(snap.body.sales.some((s) => s.client_sale_id === 'snap-a'));
    assert.ok(snap.body.sales.some((s) => s.client_sale_id === 'snap-b'), 'las ventas del aparato entran para la cobertura');
    assert.ok(snap.body.sales.every((s) => !('profit' in s)), 'sin ganancia');

    // Nada de reportes/auditoría del dueño.
    for (const key of ['daily_stock', 'cashiers', 'inventory_counts', 'rejected_sales']) {
      assert.ok(!(key in snap.body), `el snapshot compartido no expone ${key}`);
    }
    assert.equal((await ctx.api('GET', '/api/dashboard', { token: ana })).status, 403);
    assert.equal((await ctx.api('GET', '/api/cash-closes/summary', { token: ana })).status, 403);
  });

  await t.test('duplicados y reconexión; el JWT normal se conserva', async () => {
    const shop = await makeShop();
    const dos = await createCashier(ctx.api, shop.ownerToken, { email: `dup-${suffix()}@test.local` });
    const bundle = await provision(shop.ownerId, [
      { id: Number(shop.owner.id), display_name: 'Ana' },
      { id: Number(dos.id), display_name: 'Beto' },
    ], { continuous: true, name: 'Kiosco' });
    const ana = tokenOf(bundle, shop.owner);

    const first = await sell(ana, { client_sale_id: 'dup-1', items: item(shop.productId) });
    assert.equal(first.status, 201);
    const replay = await sell(ana, { client_sale_id: 'dup-1', items: item(shop.productId) });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(replay.body.register_id, first.body.register_id);
    const count = await ctx.db.execute({ sql: 'SELECT COUNT(*) AS n FROM sales WHERE user_id = ? AND client_sale_id = ?', args: [shop.ownerId, 'dup-1'] });
    assert.equal(Number(count.rows[0].n), 1, 'un reintento no duplica la venta');

    // Otro actor del aparato no puede reclamar el mismo identificador.
    const stolen = await sell(tokenOf(bundle, dos), { client_sale_id: 'dup-1', items: item(shop.productId) });
    assert.equal(stolen.status, 409);

    // El token JWT de siempre (rol cajero) sigue funcionando con su caja web.
    const normal = await sell(shop.owner.token, { register_id: 'web', client_sale_id: 'normal-1', items: item(shop.productId) });
    assert.equal(normal.status, 201);
    assert.equal(normal.body.register_id, `web:${Number(shop.owner.id)}`);
  });

  // PIN ya cifrado por el navegador del administrador (PBKDF2): 16 bytes de sal
  // y 32 de hash en hex. El servidor nunca ve el PIN en claro.
  const encryptedPin = () => ({ salt: 'ab'.repeat(16), hash: 'cd'.repeat(32), iterations: 210000 });

  await t.test('activación remota: el código de un solo uso entrega el PIN ya cifrado', async () => {
    const shop = await makeShop();
    const pin = encryptedPin();
    const created = await ctx.api('POST', '/api/admin/shared-devices', {
      token: await admin(),
      body: { owner_id: shop.ownerId, name: 'Remota', continuous: true, enroll: true, cashiers: [{ id: Number(shop.owner.id), display_name: 'Ana', pin }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.code, /^[0-9A-Z]{12}$/);
    assert.ok(Date.parse(created.body.code_expires_at) - Date.now() > 25 * 60 * 1000, 'el código dura unos 30 minutos');
    assert.ok(!('cashiers' in created.body), 'el código no devuelve los accesos directamente');

    // El aparato destino no tiene sesión: el código es la única credencial.
    const redeemed = await ctx.api('POST', '/api/shared', { body: { code: created.body.code } });
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    assert.equal(redeemed.body.device.id, created.body.device.id);
    assert.equal(redeemed.body.cashiers.length, 1);
    assert.deepEqual(redeemed.body.cashiers[0].pin, pin, 'devuelve el PIN cifrado para instalar sin teclearlo');
    assert.equal((await sell(redeemed.body.cashiers[0].token, { client_sale_id: `remote-${suffix()}`, items: item(shop.productId) })).status, 201);

    // El mismo código no vuelve a servir.
    assert.equal((await ctx.api('POST', '/api/shared', { body: { code: created.body.code } })).status, 404);
    assert.equal((await ctx.api('POST', '/api/shared', { body: { code: 'ZZZZZZZZZZZZ' } })).status, 404);
    assert.equal((await ctx.api('POST', '/api/shared', { body: {} })).status, 400);

    // Activar una caja nueva retira la anterior de la misma tienda.
    const again = await ctx.api('POST', '/api/admin/shared-devices', {
      token: await admin(),
      body: { owner_id: shop.ownerId, name: 'Remota 2', continuous: true, enroll: true, cashiers: [{ id: Number(shop.owner.id), display_name: 'Ana', pin }] },
    });
    assert.equal(again.status, 201);
    assert.equal((await ctx.api('GET', '/api/auth/shared-device', { token: redeemed.body.cashiers[0].token })).status, 403);
    assert.equal((await ctx.api('POST', '/api/shared', { body: { code: again.body.code } })).status, 200);
  });

  await t.test('el código de activación caduca', async () => {
    const shop = await makeShop();
    const created = await ctx.api('POST', '/api/admin/shared-devices', {
      token: await admin(),
      body: { owner_id: shop.ownerId, name: 'Vencida', enroll: true, cashiers: [{ id: Number(shop.owner.id), display_name: 'Ana', pin: encryptedPin() }] },
    });
    await ctx.db.execute({ sql: 'UPDATE shared_devices SET enroll_expires_at = ? WHERE id = ?', args: [new Date(Date.now() - 1000).toISOString(), created.body.device.id] });
    assert.equal((await ctx.api('POST', '/api/shared', { body: { code: created.body.code } })).status, 404);
  });

  await t.test('sin PIN cifrado válido no se genera código', async () => {
    const shop = await makeShop();
    const base = { owner_id: shop.ownerId, name: 'X', cashiers: [{ id: Number(shop.owner.id), display_name: 'Ana' }] };
    assert.equal((await ctx.api('POST', '/api/admin/shared-devices', { token: await admin(), body: { ...base, enroll: true } })).status, 400);
    assert.equal((await ctx.api('POST', '/api/admin/shared-devices', { token: await admin(), body: { ...base, enroll: 'sí' } })).status, 400);
    const bad = { ...base, enroll: true, cashiers: [{ id: Number(shop.owner.id), display_name: 'Ana', pin: { salt: 'x', hash: 'y', iterations: 1 } }] };
    assert.equal((await ctx.api('POST', '/api/admin/shared-devices', { token: await admin(), body: bad })).status, 400);
  });
});
