const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

test('delta de sincronización', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('vacío, incremental, paginado y con ítems anidados', async () => {
    const token = await registerUser(ctx.api);
    const empty = await ctx.api('GET', '/api/sync/delta?after_sale=0&after_close=0&after_count=0', { token });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.sales, []);
    assert.deepEqual(empty.body.cursors, { sale: 0, close: 0, count: 0 });
    assert.equal(empty.body.has_more, false);

    const productId = await createProduct(ctx.api, token, { name: 'Pan', stock: 10, sale_price: 100 });
    const sale = await ctx.api('POST', '/api/sales', {
      token,
      body: {
        register_id: 'web',
        client_sale_id: 'delta-sale-1',
        items: [{ product_id: productId, quantity: 2, unit_price: 100 }],
      },
    });
    assert.equal(sale.status, 201);
    const page = await ctx.api('GET', '/api/sync/delta?after_sale=0&limit=1', { token });
    assert.equal(page.status, 200);
    assert.equal(page.body.sales.length, 1);
    assert.equal(page.body.sales[0].items.length, 1);
    assert.equal(page.body.sales[0].items[0].product_id, productId);
    assert.equal(page.body.sales[0].register_id, 'web:1');
    assert.equal(page.body.has_more, true, 'una página llena pide confirmar la siguiente');

    const next = await ctx.api('GET', `/api/sync/delta?after_sale=${page.body.cursors.sale}`, { token });
    assert.deepEqual(next.body.sales, []);
    assert.equal(next.body.cursors.sale, page.body.cursors.sale);
  });

  await t.test('since filtra y los cursores de tablas avanzan por separado', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Leche', stock: 10 });
    await ctx.api('POST', '/api/sales', { token, body: { items: [{ product_id: productId, quantity: 1, unit_price: 100 }], client_sale_id: 'old' } });
    await ctx.api('POST', '/api/sales', { token, body: { items: [{ product_id: productId, quantity: 1, unit_price: 100 }], client_sale_id: 'new' } });
    const me = await ctx.api('GET', '/api/auth/me', { token });
    const rows = await ctx.db.execute({ sql: 'SELECT id FROM sales WHERE user_id = ? ORDER BY id ASC', args: [me.body.user.id] });
    await ctx.db.execute({ sql: "UPDATE sales SET created_at = '2020-01-01 00:00:00' WHERE id = ?", args: [rows.rows[0].id] });
    const delta = await ctx.api('GET', '/api/sync/delta?since=2025-01-01&after_sale=0', { token });
    assert.equal(delta.status, 200);
    assert.equal(delta.body.sales.length, 1);
    assert.equal(delta.body.sales[0].client_sale_id, 'new');
  });

  await t.test('tenant y permisos', async () => {
    const tokenA = await registerUser(ctx.api);
    const tokenB = await registerUser(ctx.api);
    const productB = await createProduct(ctx.api, tokenB, { name: 'Aislado', stock: 2 });
    await ctx.api('POST', '/api/sales', { token: tokenB, body: { items: [{ product_id: productB, quantity: 1, unit_price: 100 }] } });
    const meA = await ctx.api('GET', '/api/auth/me', { token: tokenA });
    const aislado = await ctx.api('GET', '/api/sync/delta', { token: tokenA });
    assert.equal(aislado.status, 200);
    assert.equal(aislado.body.sales.some((sale) => sale.user_id !== meA.body.user.id), false);

    const cashier = await createCashier(ctx.api, tokenA, { email: `sync-cashier-${Date.now()}@test.local` });
    const forbidden = await ctx.api('GET', '/api/sync/delta', { token: cashier.token });
    assert.equal(forbidden.status, 403);
    void tokenB;
  });
});
