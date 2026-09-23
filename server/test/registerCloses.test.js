const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

// La cuenta que firmó el token: es la que el servidor usa para completar `web:`.
const accountIdOf = (token) => {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return payload.accountId ?? payload.userId;
};

test('cierres separados por caja', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const owner = await registerUser(ctx.api);
  const cashier = await createCashier(ctx.api, owner, { email: `caja-register-${Date.now()}@test.local` });
  const product = await createProduct(ctx.api, owner, { name: 'Producto', stock: 20, sale_price: 100 });

  await t.test('cada caja web cubre solo su identidad normalizada', async () => {
    const ownerSale = await ctx.api('POST', '/api/sales', {
      token: owner,
      body: { register_id: 'web', client_sale_id: 'owner-sale', items: [{ product_id: product, quantity: 1, unit_price: 100 }] },
    });
    const cashierSale = await ctx.api('POST', '/api/sales', {
      token: cashier.token,
      body: { register_id: 'web', client_sale_id: 'cashier-sale', items: [{ product_id: product, quantity: 2, unit_price: 100 }] },
    });
    assert.equal(ownerSale.body.register_id, `web:${accountIdOf(owner)}`);
    assert.equal(cashierSale.body.register_id, `web:${accountIdOf(cashier.token)}`);
    assert.notEqual(ownerSale.body.register_id, cashierSale.body.register_id);

    const cashierClose = await ctx.api('POST', '/api/cash-closes', {
      token: cashier.token, body: { register_id: 'web', counted_cash: 200 },
    });
    assert.equal(cashierClose.status, 201);
    assert.equal(Number(cashierClose.body.expected_cash), 200);

    const ownerClose = await ctx.api('POST', '/api/cash-closes', {
      token: owner, body: { register_id: 'web', counted_cash: 100 },
    });
    assert.equal(ownerClose.status, 201);
    assert.equal(Number(ownerClose.body.expected_cash), 100);
  });

  await t.test('un cierre por ids no falla si web ya cerró la venta y registra overlap', async () => {
    const sale = await ctx.api('POST', '/api/sales', {
      token: owner,
      body: { register_id: 'web', client_sale_id: 'already-web-closed', items: [{ product_id: product, quantity: 1, unit_price: 100 }] },
    });
    const webClose = await ctx.api('POST', '/api/cash-closes', {
      token: owner, body: { register_id: 'web', counted_cash: 100 },
    });
    assert.equal(webClose.status, 201);

    const desktopClose = await ctx.api('POST', '/api/cash-closes', {
      token: owner,
      body: { register_id: 'desk-test-register', client_sale_ids: ['already-web-closed'], counted_cash: 100 },
    });
    assert.equal(desktopClose.status, 201);
    assert.equal(Number(desktopClose.body.expected_cash), 100);
    assert.equal(Number(desktopClose.body.overlap_sales), 1);
    assert.equal(Number(sale.body.id) > 0, true);
  });

  await t.test('el modo legado sigue cerrando ventas sin identidad', async () => {
    const legacy = await ctx.api('POST', '/api/sales', {
      token: owner,
      body: { client_sale_id: 'legacy-sale', items: [{ product_id: product, quantity: 1, unit_price: 100 }] },
    });
    assert.equal(legacy.status, 201);
    const close = await ctx.api('POST', '/api/cash-closes', { token: owner, body: { counted_cash: 100 } });
    assert.equal(close.status, 201);
    assert.equal(Number(close.body.expected_cash), 100);
  });
});
