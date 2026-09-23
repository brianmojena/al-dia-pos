const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');
const { businessCurrentMonth } = require('../lib/businessDay');

/**
 * Cobro mixto: el cliente paga una parte por transferencia y el resto en
 * efectivo. Lo que no puede fallar:
 *   1. el efectivo de la parte mixta llega a la gaveta del arqueo, y la parte
 *      transferida no;
 *   2. el techo de transferencia mira solo la parte transferida;
 *   3. nunca queda efectivo negativo ni una "mixta" que en realidad no lo es.
 */
test('cobro mixto', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const vender = (token, productId, body) => ctx.api('POST', '/api/sales', {
    token,
    body: {
      register_id: 'web',
      items: [{ product_id: productId, quantity: 1, unit_price: 300 }],
      ...body,
    },
  });

  await t.test('se guarda la parte transferida y el arqueo reparte el total', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Aceite', stock: 10, sale_price: 300 });

    const mixta = await vender(token, producto, { payment_method: 'mixto', transfer_amount: 100 });
    assert.equal(mixta.status, 201);
    assert.equal(mixta.body.payment_method, 'mixto');
    assert.equal(Number(mixta.body.transfer_amount), 100);

    const enEfectivo = await vender(token, producto, { payment_method: 'efectivo' });
    assert.equal(enEfectivo.status, 201);
    assert.equal(enEfectivo.body.transfer_amount, null, 'solo el cobro mixto guarda monto transferido');

    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token, body: { register_id: 'web', counted_cash: 550, opening_float: 50 },
    });
    assert.equal(cierre.status, 201);
    assert.equal(Number(cierre.body.expected_cash), 50 + 200 + 300, 'fondo + efectivo de la mixta + venta en efectivo');
    assert.equal(Number(cierre.body.expected_transfer), 100, 'solo lo transferido de la mixta');
    assert.equal(Number(cierre.body.difference), 0);
  });

  await t.test('el histórico por días reparte la venta mixta entre las dos columnas', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Arroz', stock: 10, sale_price: 300 });
    await vender(token, producto, { payment_method: 'mixto', transfer_amount: 120 });

    const dias = await ctx.api('GET', `/api/reports/days?month=${businessCurrentMonth()}`, { token });
    assert.equal(dias.status, 200);
    assert.equal(dias.body.totals.total, 300);
    assert.equal(dias.body.totals.cash_total, 180);
    assert.equal(dias.body.totals.transfer_total, 120);
  });

  await t.test('el techo de transferencia solo mira la parte transferida', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Café', stock: 10, sale_price: 300 });
    await ctx.api('PUT', '/api/auth/settings', { token, body: { transfer_limit: 150 } });

    // $300 en total supera el techo, pero solo se transfieren $150: pasa.
    const dentro = await vender(token, producto, { payment_method: 'mixto', transfer_amount: 150 });
    assert.equal(dentro.status, 201);

    const fuera = await vender(token, producto, { payment_method: 'mixto', transfer_amount: 200 });
    assert.equal(fuera.status, 403);
    assert.match(fuera.body.error, /parte en transferencia/);

    const productos = await ctx.api('GET', '/api/products', { token });
    assert.equal(productos.body.find((p) => p.name === 'Café').stock, 9, 'la venta bloqueada no descontó stock');
  });

  await t.test('rechaza montos que no dejan un cobro mixto de verdad', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Leche', stock: 10, sale_price: 300 });

    for (const transfer_amount of [undefined, null, 0, -5, 'abc', 300, 450]) {
      const res = await vender(token, producto, { payment_method: 'mixto', transfer_amount });
      assert.equal(res.status, 400, `transfer_amount=${transfer_amount} debería rechazarse`);
    }
    const productos = await ctx.api('GET', '/api/products', { token });
    assert.equal(productos.body.find((p) => p.name === 'Leche').stock, 10, 'ningún rechazo descontó stock');
  });

  await t.test('el delta y la venta rechazada conservan el reparto', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Pan', stock: 10, sale_price: 300 });
    await vender(token, producto, { payment_method: 'mixto', transfer_amount: 75 });

    const delta = await ctx.api('GET', '/api/sync/delta', { token });
    assert.equal(Number(delta.body.sales[0].transfer_amount), 75);

    const rechazada = await ctx.api('POST', '/api/sales/rejected', {
      token,
      body: {
        client_sale_id: 'mixta-rechazada', payment_method: 'mixto', transfer_amount: 40,
        items: [{ product_id: producto, quantity: 1, unit_price: 300 }],
      },
    });
    assert.equal(rechazada.status, 201);
    assert.equal(rechazada.body.payment_method, 'mixto');
    assert.equal(Number(rechazada.body.transfer_amount), 40);
  });
});
