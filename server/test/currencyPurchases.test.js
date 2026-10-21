const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

/**
 * Compra de divisa. Lo que no puede fallar:
 *   1. los pesos que salen de la gaveta se calculan en el servidor (monto × tasa);
 *   2. el arqueo espera menos pesos y más billetes, y se lleva la compra;
 *   3. la pantalla de inicio del dueño refleja el mismo movimiento;
 *   4. es idempotente y la puede hacer cualquier cuenta, pero solo el dueño ve el historial.
 */
test('compra de divisa', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const comprar = (token, body) => ctx.api('POST', '/api/currency-purchases', {
    token, body: { register_id: 'web', ...body },
  });

  await t.test('guarda la compra y calcula los pesos pagados', async () => {
    const token = await registerUser(ctx.api);
    await ctx.api('PUT', '/api/auth/settings', { token, body: { usd_rate: 350 } });
    const res = await comprar(token, { foreign_currency: 'USD', foreign_amount: 100, exchange_rate: 340, cup_amount: 1 });
    assert.equal(res.status, 201);
    assert.equal(Number(res.body.cup_amount), 34000, 'no se acepta el monto en pesos del cliente');
    assert.equal(Number(res.body.shop_rate), 350, 'sin shop_rate se compara contra la tasa de la tienda');
    assert.equal(res.body.cash_close_id, null);
  });

  await t.test('rechaza compras incompletas', async () => {
    const token = await registerUser(ctx.api);
    for (const malo of [
      { foreign_currency: 'CAD' },
      { foreign_amount: 0 },
      { foreign_amount: null },
      { exchange_rate: 0 },
      { exchange_rate: 'abc' },
    ]) {
      const res = await comprar(token, { foreign_currency: 'USD', foreign_amount: 10, exchange_rate: 350, ...malo });
      assert.equal(res.status, 400, JSON.stringify(malo));
    }
  });

  await t.test('es idempotente por client_purchase_id', async () => {
    const token = await registerUser(ctx.api);
    const body = { client_purchase_id: 'compra-1', foreign_currency: 'EUR', foreign_amount: 10, exchange_rate: 380 };
    const first = await comprar(token, body);
    const second = await comprar(token, body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    const list = await ctx.api('GET', '/api/currency-purchases', { token });
    assert.equal(list.body.length, 1);
  });

  await t.test('el arqueo descuenta los pesos, suma los billetes y se lleva la compra', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Pan', stock: 5, sale_price: 1000 });
    await ctx.api('POST', '/api/sales', {
      token, body: { register_id: 'web', items: [{ product_id: producto, quantity: 1, unit_price: 1000 }], payment_method: 'efectivo' },
    });
    await comprar(token, { foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 350 });
    await comprar(token, { foreign_currency: 'EUR', foreign_amount: 10, exchange_rate: 380 });

    const current = await ctx.api('GET', '/api/cash-closes/current?register_id=web', { token });
    assert.equal(current.body.has_sales, true);

    // 5000 de fondo + 1000 de la venta - 7000 - 3800 = -4800: se contó lo que quedó.
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token, body: { register_id: 'web', opening_float: 12000, counted_cash: 2200, counted_usd: 20, counted_eur: 10 },
    });
    assert.equal(cierre.status, 201);
    assert.equal(Number(cierre.body.expected_cash), 12000 + 1000 - 7000 - 3800);
    assert.equal(Number(cierre.body.difference), 0);
    assert.equal(Number(cierre.body.expected_usd), 20);
    assert.equal(Number(cierre.body.expected_eur), 10);
    assert.equal(Number(cierre.body.difference_usd), 0);

    const list = await ctx.api('GET', '/api/currency-purchases', { token });
    assert.ok(list.body.every((p) => p.cash_close_id === cierre.body.id));

    // Un segundo cierre ya no vuelve a contarlas.
    const otro = await ctx.api('POST', '/api/cash-closes', {
      token, body: { register_id: 'web', counted_cash: 0, counted_usd: 0, counted_eur: 0 },
    });
    assert.equal(Number(otro.body.expected_usd), 0);
  });

  await t.test('una caja que solo compró divisa también se puede cerrar', async () => {
    const token = await registerUser(ctx.api);
    await comprar(token, { foreign_currency: 'USD', foreign_amount: 5, exchange_rate: 350 });
    const current = await ctx.api('GET', '/api/cash-closes/current?register_id=web', { token });
    assert.equal(current.body.has_sales, true);
    assert.ok(current.body.opened_at);
  });

  await t.test('el inicio del dueño muestra los pesos que salieron y los billetes que entraron', async () => {
    const token = await registerUser(ctx.api);
    await comprar(token, { foreign_currency: 'USD', foreign_amount: 10, exchange_rate: 350 });
    const dashboard = await ctx.api('GET', '/api/dashboard', { token });
    assert.equal(dashboard.body.holdings.cash, -3500);
    assert.equal(dashboard.body.holdings.usd, 10);
  });

  await t.test('el cajero compra, pero solo el dueño ve el historial', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);
    const res = await comprar(cashier, { foreign_currency: 'USD', foreign_amount: 10, exchange_rate: 350 });
    assert.equal(res.status, 201);
    assert.ok(res.body.account_email);
    assert.equal((await ctx.api('GET', '/api/currency-purchases', { token: cashier })).status, 403);
    const list = await ctx.api('GET', '/api/currency-purchases', { token: owner });
    assert.equal(list.body.length, 1);
  });

  await t.test('la descarga de la PWA y el delta del escritorio incluyen las compras', async () => {
    const token = await registerUser(ctx.api);
    await comprar(token, { foreign_currency: 'USD', foreign_amount: 10, exchange_rate: 350 });
    const snapshot = await ctx.api('GET', '/api/sync/snapshot', { token });
    assert.equal(snapshot.body.currency_purchases.length, 1);
    const delta = await ctx.api('GET', '/api/sync/delta?after_purchase=0', { token });
    assert.equal(delta.body.currency_purchases.length, 1);
    assert.equal(delta.body.cursors.purchase, delta.body.currency_purchases[0].id);
  });
});
