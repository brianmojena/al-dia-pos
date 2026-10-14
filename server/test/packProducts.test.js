const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser } = require('./helpers');

/**
 * Venta por paquete: "Popular" se cuenta en cigarros sueltos y además se vende
 * la cajetilla entera de 20 a su propio precio.
 */
test('productos por paquete', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const { api } = ctx;

  const crear = (token, body) => api('POST', '/api/products', { token, body });
  const vender = (token, items) => api('POST', '/api/sales', { token, body: { items, payment_method: 'efectivo' } });
  const leer = async (token, id) => (await api('GET', '/api/products', { token })).body.find((p) => p.id === id);
  const popular = { name: 'Popular', purchase_price: 12.5, sale_price: 20, stock: 60, pack_size: 20, pack_price: 300 };

  await t.test('se crea con paquete; datos de paquete inválidos se rechazan', async () => {
    const token = await registerUser(api);
    const ok = await crear(token, popular);
    assert.equal(ok.status, 201);
    assert.equal(Number(ok.body.pack_size), 20);
    assert.equal(Number(ok.body.pack_price), 300);

    assert.equal((await crear(token, { ...popular, name: 'A', pack_size: 1 })).status, 400);
    assert.equal((await crear(token, { ...popular, name: 'B', pack_size: 2.5 })).status, 400);
    assert.equal((await crear(token, { ...popular, name: 'C', pack_price: '' })).status, 400, 'falta el precio del paquete');
    assert.equal((await crear(token, { ...popular, name: 'D', unit: 'lb' })).status, 400, 'por peso no lleva paquete');
    const suelto = await crear(token, { name: 'Galleta', sale_price: 5, stock: 3 });
    assert.equal(suelto.body.pack_size, null);
  });

  await t.test('vender una cajetilla cobra su precio y descuenta 20 sueltos', async () => {
    const token = await registerUser(api);
    const p = (await crear(token, popular)).body;
    const res = await vender(token, [
      { product_id: p.id, quantity: 2, unit_price: 300, pack_size: 20 },
      { product_id: p.id, quantity: 3, unit_price: 20 },
    ]);
    assert.equal(res.status, 201);
    assert.equal(Number(res.body.total), 660);
    // 2 × (300 − 250) + 3 × (20 − 12.5)
    assert.equal(Number(res.body.profit), 122.5);
    assert.equal(Number((await leer(token, p.id)).stock), 17);

    const venta = await api('GET', `/api/sales/${res.body.id}`, { token });
    const linea = venta.body.items.find((i) => i.pack_size);
    assert.equal(linea.product_name, 'Popular (paquete de 20)');
    assert.equal(Number(linea.unit_cost), 250);
  });

  await t.test('no se vende una cajetilla si no quedan 20 sueltos', async () => {
    const token = await registerUser(api);
    const p = (await crear(token, { ...popular, stock: 19 })).body;
    assert.equal((await vender(token, [{ product_id: p.id, quantity: 1, unit_price: 300, pack_size: 20 }])).status, 409);
    assert.equal((await vender(token, [{ product_id: p.id, quantity: 1.5, unit_price: 300, pack_size: 20 }])).status, 400, 'paquetes enteros');
    assert.equal(Number((await leer(token, p.id)).stock), 19);
  });

  await t.test('anular la venta devuelve todos los sueltos del paquete', async () => {
    const token = await registerUser(api);
    const p = (await crear(token, popular)).body;
    const venta = await vender(token, [{ product_id: p.id, quantity: 1, unit_price: 300, pack_size: 20 }]);
    assert.equal(Number((await leer(token, p.id)).stock), 40);
    const fix = await api('POST', `/api/sales/${venta.body.id}/correct`, { token, body: { action: 'anular' } });
    assert.equal(fix.status, 200);
    assert.equal(Number((await leer(token, p.id)).stock), 60);
  });

  await t.test('una edición sin datos de paquete lo conserva; mandar 0 lo quita', async () => {
    const token = await registerUser(api);
    const p = (await crear(token, popular)).body;
    await api('PUT', `/api/products/${p.id}`, { token, body: { sale_price: 25 } });
    assert.equal(Number((await leer(token, p.id)).pack_size), 20);
    await api('PUT', `/api/products/${p.id}`, { token, body: { pack_size: 0 } });
    const sin = await leer(token, p.id);
    assert.equal(sin.pack_size, null);
    assert.equal(sin.pack_price, null);
  });

  await t.test('la web sincroniza el paquete y una app que no lo manda no lo borra', async () => {
    const token = await registerUser(api);
    const op = (body) => api('POST', '/api/sync/product-operation', { token, body });
    const alta = await op({ operation_id: 'pk-1', method: 'POST', product: { name: 'Galletas María', sale_price: 10, purchase_price: 6, stock: 48, pack_size: 12, pack_price: 100 } });
    assert.equal(alta.status, 200);
    assert.equal(Number(alta.body.pack_size), 12);
    const edit = await op({ operation_id: 'pk-2', method: 'PUT', product_id: alta.body.id, product: { name: 'Galletas María', sale_price: 11, purchase_price: 6, stock: 48 } });
    assert.equal(edit.status, 200);
    assert.equal(Number(edit.body.pack_size), 12);
    assert.equal(Number(edit.body.pack_price), 100);
  });

  await t.test('venta suelta sin redondear costo compra de decimales', async () => {
    const token = await registerUser(api);
    const p = (await crear(token, { name: 'Fardo', purchase_price: 12.3456, sale_price: 20, stock: 10 })).body;
    const res = await vender(token, [{ product_id: p.id, quantity: 3, unit_price: 20 }]);
    assert.equal(res.status, 201);
    // 3 × 20 = 60
    assert.equal(Number(res.body.total), 60);
    // round2(3 × (20 − 12.3456)) = round2(22.9632) = 22.96
    assert.equal(Number(res.body.profit), 22.96);
  });
});
