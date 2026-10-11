const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');
const { businessCurrentMonth } = require('../lib/businessDay');

/**
 * Cobro en dólares y euros. Lo que no puede fallar:
 *   1. la venta guarda los billetes, la moneda y la tasa con que se tomaron;
 *   2. el arqueo espera los billetes por su lado y descuenta de los pesos el
 *      vuelto que se dio (o suma lo que el cliente completó en pesos);
 *   3. el dueño ve cuándo la tasa del cobro no fue la de la tienda.
 */
test('cobro en divisa', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const vender = (token, productId, price, body) => ctx.api('POST', '/api/sales', {
    token,
    body: {
      register_id: 'web',
      items: [{ product_id: productId, quantity: 1, unit_price: price }],
      ...body,
    },
  });

  await t.test('la tienda guarda la tasa del dólar y la del euro', async () => {
    const token = await registerUser(ctx.api);
    const res = await ctx.api('PUT', '/api/auth/settings', { token, body: { usd_rate: 350, eur_rate: 380 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.usd_rate, 350);
    assert.equal(res.body.user.eur_rate, 380);

    const soloEuro = await ctx.api('PUT', '/api/auth/settings', { token, body: { eur_rate: 390 } });
    assert.equal(soloEuro.body.user.usd_rate, 350, 'cambiar el euro no toca el dólar');
    assert.equal(soloEuro.body.user.eur_rate, 390);
  });

  await t.test('20 USD a 350 por una compra de 6000: vuelto en pesos y arqueo por moneda', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Aceite', stock: 10, sale_price: 6000 });

    const venta = await vender(token, producto, 6000, {
      payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 350, shop_rate: 350,
    });
    assert.equal(venta.status, 201);
    assert.equal(venta.body.payment_method, 'divisa');
    assert.equal(venta.body.foreign_currency, 'USD');
    assert.equal(Number(venta.body.foreign_amount), 20);
    assert.equal(Number(venta.body.exchange_rate), 350);
    assert.equal(Number(venta.body.shop_rate), 350);

    // 8000 de compra: 20 EUR a 380 = 7600 y el cliente completa 400 en pesos.
    const otro = await createProduct(ctx.api, token, { name: 'Leche', stock: 10, sale_price: 8000 });
    const mezcla = await vender(token, otro, 8000, {
      payment_method: 'divisa', foreign_currency: 'EUR', foreign_amount: 20, exchange_rate: 380, shop_rate: 380,
    });
    assert.equal(mezcla.status, 201);

    // Fondo 2000 - 1000 de vuelto + 400 completados = 1400 pesos.
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token, body: { register_id: 'web', opening_float: 2000, counted_cash: 1400, counted_usd: 20, counted_eur: 15 },
    });
    assert.equal(cierre.status, 201);
    assert.equal(Number(cierre.body.expected_cash), 1400);
    assert.equal(Number(cierre.body.difference), 0);
    assert.equal(Number(cierre.body.expected_usd), 20);
    assert.equal(Number(cierre.body.difference_usd), 0);
    assert.equal(Number(cierre.body.expected_eur), 20);
    assert.equal(Number(cierre.body.difference_eur), -5, 'faltan 5 euros');
  });

  await t.test('rechaza un cobro en divisa incompleto sin tocar el stock', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Arroz', stock: 3, sale_price: 500 });
    const base = { payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 2, exchange_rate: 350 };

    for (const malo of [
      { foreign_currency: 'CAD' },
      { foreign_amount: 0 },
      { foreign_amount: null },
      { exchange_rate: 0 },
      { exchange_rate: 'abc' },
    ]) {
      const res = await vender(token, producto, 500, { ...base, ...malo });
      assert.equal(res.status, 400, JSON.stringify(malo));
    }
    const productos = await ctx.api('GET', '/api/products', { token });
    assert.equal(productos.body[0].stock, 3);
  });

  await t.test('el techo de transferencia no frena un cobro en divisa', async () => {
    const token = await registerUser(ctx.api);
    await ctx.api('PUT', '/api/auth/settings', { token, body: { transfer_limit: 100 } });
    const producto = await createProduct(ctx.api, token, { name: 'Ventilador', stock: 1, sale_price: 35000 });
    const res = await vender(token, producto, 35000, {
      payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 100, exchange_rate: 350, shop_rate: null,
    });
    assert.equal(res.status, 201);
  });

  await t.test('sin shop_rate del aparato se compara contra la tasa de la tienda', async () => {
    const token = await registerUser(ctx.api);
    await ctx.api('PUT', '/api/auth/settings', { token, body: { usd_rate: 360 } });
    const producto = await createProduct(ctx.api, token, { name: 'Café', stock: 5, sale_price: 3500 });
    const res = await vender(token, producto, 3500, {
      payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 10, exchange_rate: 350,
    });
    assert.equal(Number(res.body.shop_rate), 360);
  });

  await t.test('el histórico separa la divisa y cuenta las tasas distintas a la de la tienda', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Jabón', stock: 10, sale_price: 7000 });
    await vender(token, producto, 7000, {
      payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 350, shop_rate: 350,
    });
    await vender(token, producto, 7000, {
      payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 400, shop_rate: 350,
    });
    await vender(token, producto, 7000, { payment_method: 'efectivo' });

    const res = await ctx.api('GET', `/api/reports/days?month=${businessCurrentMonth()}`, { token });
    assert.equal(res.status, 200);
    const { totals } = res.body;
    assert.equal(totals.total, 21000);
    assert.equal(totals.usd_total, 40);
    assert.equal(totals.foreign_total, 7000 + 8000);
    // 7000 en efectivo, y la venta a 400 dio 1000 de vuelto.
    assert.equal(totals.cash_total, 7000 - 1000);
    assert.equal(totals.cash_total + totals.transfer_total + totals.foreign_total, totals.total);
    assert.equal(totals.off_rate_count, 1);

    const dashboard = await ctx.api('GET', '/api/dashboard', { token });
    assert.equal(dashboard.body.audit.offRateSales, 1);
  });

  await t.test('la venta rechazada conserva la divisa con que se cobró', async () => {
    const token = await registerUser(ctx.api);
    const res = await ctx.api('POST', '/api/sales/rejected', {
      token,
      body: {
        client_sale_id: 'rechazada-usd',
        items: [{ product_id: 999, product_name: 'Ron', quantity: 1, unit_price: 3500 }],
        payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 10, exchange_rate: 350,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.foreign_currency, 'USD');
    assert.equal(Number(res.body.foreign_amount), 10);
  });
});
