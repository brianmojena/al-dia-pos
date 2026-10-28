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
    assert.deepEqual(empty.body.cursors, { correction: 0, close_correction: 0, sale: 0, sale_state: 0, close: 0, count: 0, purchase: 0, purchase_state: 0, withdrawal: 0, withdrawal_state: 0 });
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

    const close = await ctx.api('POST', '/api/cash-closes', { token, body: { opening_float: 0, counted_cash: 200 } });
    assert.equal(close.status, 201);
    await ctx.db.execute({ sql: 'UPDATE sales SET cash_close_id = ? WHERE id = ?', args: [close.body.id, sale.body.id] });

    const next = await ctx.api('GET', `/api/sync/delta?after_sale=${page.body.cursors.sale}&after_sale_state=0`, { token });
    assert.deepEqual(next.body.sales, []);
    assert.deepEqual(next.body.sale_states, [{ id: Number(sale.body.id), cash_close_id: Number(close.body.id), closed: 1 }]);
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

  await t.test('max_bytes recorta páginas sin repetir ni saltar cursores de estado', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Budget', stock: 30, sale_price: 10 });
    const ids = [];
    for (let i = 0; i < 18; i++) {
      const created = await ctx.api('POST', '/api/sales', { token, body: {
        client_sale_id: `budget-sale-${i}`,
        items: [{ product_id: productId, quantity: 1, unit_price: 10 }],
      } });
      assert.equal(created.status, 201);
      ids.push(Number(created.body.id));
    }
    const keys = ['sale', 'sale_state', 'close', 'count', 'purchase', 'purchase_state', 'withdrawal', 'withdrawal_state', 'correction', 'close_correction'];
    let cursors = Object.fromEntries(keys.map((key) => [key, 0]));
    const observed = new Set();
    let pages = 0;
    for (;;) {
      const params = new URLSearchParams({ limit: '500', max_bytes: '3000', since: '' });
      for (const key of keys) params.set(`after_${key}`, String(cursors[key]));
      const page = await ctx.api('GET', `/api/sync/delta?${params}`, { token });
      assert.equal(page.status, 200);
      assert.ok(Buffer.byteLength(JSON.stringify(page.body)) <= 3000, 'cada página respeta el presupuesto');
      for (const state of page.body.sale_states) observed.add(Number(state.id));
      cursors = page.body.cursors;
      pages++;
      assert.ok(pages < 20, 'los cursores deben terminar');
      if (!page.body.has_more) break;
    }
    assert.ok(pages > 1, 'el presupuesto forzó paginación');
    assert.deepEqual([...observed].sort((a, b) => a - b), ids.sort((a, b) => a - b));
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

  await t.test('las extracciones abiertas no atascan el cursor', async () => {
    const token = await registerUser(ctx.api);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const res = await ctx.api('POST', '/api/cash-withdrawals', {
        token,
        body: {
          client_withdrawal_id: `abierta-${i}-${Date.now()}`,
          method: 'efectivo',
          amount: 10 + i,
        },
      });
      assert.equal(res.status, 201);
      ids.push(Number(res.body.id));
    }

    // Con limit=1 y tres extracciones abiertas, la versión anterior devolvía
    // siempre la primera (id <= cursor OR abierta) y el cursor no avanzaba.
    let cursor = 0;
    let hasMore = true;
    let pages = 0;
    const vistos = new Set();
    while (hasMore && pages < 6) {
      const page = await ctx.api('GET', `/api/sync/delta?after_withdrawal=${cursor}&limit=1`, { token });
      assert.equal(page.status, 200);
      for (const row of page.body.cash_withdrawals) vistos.add(Number(row.id));
      assert.ok(page.body.cursors.withdrawal >= cursor, 'el cursor nunca retrocede');
      cursor = page.body.cursors.withdrawal;
      hasMore = page.body.has_more;
      pages++;
    }

    assert.equal(hasMore, false, 'la paginación termina aunque queden extracciones abiertas');
    assert.equal(cursor, Math.max(...ids), 'el cursor llegó a la última extracción');
    assert.equal(pages, ids.length + 1, 'una página por extracción nueva y una final de recordatorios');
    assert.deepEqual([...vistos].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
  });
});
