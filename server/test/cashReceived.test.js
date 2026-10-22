const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * Efectivo recibido del cliente en ventas pagadas 100% en efectivo.
 * Lo que no puede fallar:
 *   1. venta en efectivo con cash_received >= total se guarda y se devuelve;
 *   2. cash_received menor que total -> la venta se cobra y el dato se descarta (NULL);
 *   3. venta en transferencia con cash_received -> se guarda NULL;
 *   4. venta en efectivo sin cash_received -> NULL y sigue funcionando.
 */
test('efectivo recibido', async (t) => {
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

  const leerVenta = (token, saleId) => ctx.api('GET', `/api/sales/${saleId}`, { token });

  await t.test('venta en efectivo con cash_received >= total se guarda y se devuelve', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Producto A', stock: 10, sale_price: 5000 });

    // Exacto
    const venta1 = await vender(token, producto, 5000, {
      payment_method: 'efectivo', cash_received: 5000,
    });
    assert.equal(venta1.status, 201);
    assert.equal(Number(venta1.body.cash_received), 5000);

    // Con vuelto
    const venta2 = await vender(token, producto, 5000, {
      payment_method: 'efectivo', cash_received: 10000,
    });
    assert.equal(venta2.status, 201);
    assert.equal(Number(venta2.body.cash_received), 10000);

    // Verificar que se devuelve en GET
    const leido = await leerVenta(token, venta2.body.id);
    assert.equal(leido.status, 200);
    assert.equal(Number(leido.body.cash_received), 10000);
  });

  await t.test('cash_received menor que total no pierde la venta: se guarda sin el dato', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Producto B', stock: 5, sale_price: 3000 });

    const venta = await vender(token, producto, 3000, {
      payment_method: 'efectivo', cash_received: 2500,
    });
    assert.equal(venta.status, 201);
    assert.equal(venta.body.cash_received, null);

    const productos = await ctx.api('GET', '/api/products', { token });
    assert.equal(productos.body[0].stock, 4);
  });

  await t.test('venta en transferencia con cash_received guarda NULL (se ignora)', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Producto C', stock: 8, sale_price: 4000 });

    const venta = await vender(token, producto, 4000, {
      payment_method: 'transferencia', cash_received: 4000,
    });
    assert.equal(venta.status, 201);
    assert.equal(venta.body.cash_received, null);

    // Verificar en GET
    const leido = await leerVenta(token, venta.body.id);
    assert.equal(leido.status, 200);
    assert.equal(leido.body.cash_received, null);
  });

  await t.test('venta en efectivo sin cash_received guarda NULL y funciona normalmente', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Producto D', stock: 6, sale_price: 2500 });

    const venta = await vender(token, producto, 2500, {
      payment_method: 'efectivo',
      // sin cash_received
    });
    assert.equal(venta.status, 201);
    assert.equal(venta.body.cash_received, null);

    // Verificar stock descuento
    const productos = await ctx.api('GET', '/api/products', { token });
    assert.equal(productos.body[0].stock, 5);

    // Verificar en GET
    const leido = await leerVenta(token, venta.body.id);
    assert.equal(leido.status, 200);
    assert.equal(leido.body.cash_received, null);
  });

  await t.test('cash_received inválido rechaza la venta', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Producto E', stock: 4, sale_price: 1500 });

    for (const malo of [
      { cash_received: 'abc' },
      { cash_received: 'NaN' },
      { cash_received: 'Infinity' },
    ]) {
      const venta = await vender(token, producto, 1500, {
        payment_method: 'efectivo', ...malo,
      });
      assert.equal(venta.status, 400, JSON.stringify(malo));
      assert.match(venta.body.error, /Efectivo recibido inválido/);
    }

    // Stock no cambió
    const productos = await ctx.api('GET', '/api/products', { token });
    assert.equal(productos.body[0].stock, 4);
  });

  await t.test('cash_received se redondea a 2 decimales', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Producto F', stock: 10, sale_price: 1234.567 });

    const venta = await vender(token, producto, 1234.567, {
      payment_method: 'efectivo', cash_received: 2000.005,
    });
    assert.equal(venta.status, 201);
    assert.equal(Number(venta.body.cash_received), 2000.01);
  });

  await t.test('cobro mixto con cash_received guarda NULL (se ignora)', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Producto G', stock: 10, sale_price: 5000 });

    const venta = await vender(token, producto, 5000, {
      payment_method: 'mixto', transfer_amount: 2500, cash_received: 5000,
    });
    assert.equal(venta.status, 201);
    assert.equal(venta.body.cash_received, null);

    // Verificar en GET
    const leido = await leerVenta(token, venta.body.id);
    assert.equal(leido.status, 200);
    assert.equal(leido.body.cash_received, null);
  });
});
