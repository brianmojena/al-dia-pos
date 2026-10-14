const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser } = require('./helpers');

/**
 * Productos por peso: el precio y el stock van por kg, g o lb, y la venta
 * admite fracciones (2.35 lb). Un producto por pieza sigue siendo entero.
 */
test('productos fraccionados', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const { api } = ctx;

  const crear = (token, body) => api('POST', '/api/products', { token, body });
  const vender = (token, items) => api('POST', '/api/sales', { token, body: { items, payment_method: 'efectivo' } });
  const producto = async (token, id) => (await api('GET', '/api/products', { token })).body.find((p) => p.id === id);

  await t.test('se crea con unidad y stock decimal; unidad inválida se rechaza', async () => {
    const token = await registerUser(api);
    const ok = await crear(token, { name: 'Pollo', sale_price: 300, purchase_price: 220, stock: 12.5, unit: 'lb', track_stock: true });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.unit, 'lb');
    assert.equal(Number(ok.body.stock), 12.5);

    assert.equal((await crear(token, { name: 'X', sale_price: 1, unit: 'oz' })).status, 400);
    assert.equal((await crear(token, { name: 'Pieza', sale_price: 1, stock: 2.5 })).status, 400, 'por pieza no admite decimales');
  });

  await t.test('vender 2.35 lb cobra por peso y descuenta el stock decimal', async () => {
    const token = await registerUser(api);
    const { body } = await crear(token, { name: 'Frijoles', sale_price: 120, purchase_price: 80, stock: 10, unit: 'lb', track_stock: true });
    const res = await vender(token, [{ product_id: body.id, quantity: 2.35, unit_price: 120 }]);
    assert.equal(res.status, 201);
    assert.equal(Number(res.body.total), 282);
    assert.equal(Number(res.body.profit), 94);
    assert.equal(Number((await producto(token, body.id)).stock), 7.65);
  });

  await t.test('no se admiten fracciones de una pieza ni pesos menores a 1 g; el peso no bloquea por stock', async () => {
    const token = await registerUser(api);
    const peso = (await crear(token, { name: 'Harina', sale_price: 50, stock: 1, unit: 'kg', track_stock: true })).body;
    const pieza = (await crear(token, { name: 'Refresco', sale_price: 100, stock: 5 })).body;
    assert.equal((await vender(token, [{ product_id: pieza.id, quantity: 1.5, unit_price: 100 }])).status, 400);
    assert.equal((await vender(token, [{ product_id: pieza.id, quantity: 6, unit_price: 100 }])).status, 409, 'la pieza sí bloquea por stock');
    assert.equal((await vender(token, [{ product_id: peso.id, quantity: 0.0004, unit_price: 50 }])).status, 400);
    assert.equal((await vender(token, [{ product_id: peso.id, quantity: 1.001, unit_price: 50 }])).status, 201);
    assert.equal(Number((await producto(token, peso.id)).stock), 0, 'queda en 0, no negativo');
  });

  await t.test('conteo de inventario admite decimales sólo en productos por peso', async () => {
    const token = await registerUser(api);
    const peso = (await crear(token, { name: 'Azúcar', sale_price: 40, stock: 5, unit: 'kg', track_stock: true })).body;
    const pieza = (await crear(token, { name: 'Jabón', sale_price: 40, stock: 5 })).body;
    const bad = await api('POST', '/api/inventory-counts', { token, body: { items: [{ product_id: pieza.id, counted: 4.5 }] } });
    assert.equal(bad.status, 400);
    const ok = await api('POST', '/api/inventory-counts', { token, body: { items: [{ product_id: peso.id, counted: 4.25 }] } });
    assert.equal(ok.status, 201);
    assert.equal(Number((await producto(token, peso.id)).stock), 4.25);
  });

  // --- stock opcional ---
  const ventaDe = (token, id, quantity, price = 100) => api('POST', '/api/sales', { token, body: { items: [{ product_id: id, quantity, unit_price: price }], payment_method: 'efectivo' } });
  const leer = async (token, id) => (await api('GET', '/api/products', { token })).body.find((p) => p.id === id);

  await t.test('por defecto no lleva stock: se vende siempre y el stock no se toca', async () => {
    const token = await registerUser(api);
    const q = (await crear(token, { name: 'Queso', sale_price: 100, stock: 50, unit: 'lb' })).body;
    assert.equal(Number(q.track_stock), 0);
    assert.equal(Number(q.stock), 0, 'el stock que mande el cliente se ignora');
    assert.equal((await ventaDe(token, q.id, 3.2)).status, 201);
    assert.equal(Number((await leer(token, q.id)).stock), 0);
    const add = await api('PUT', `/api/products/${q.id}`, { token, body: { add_stock: 5 } });
    assert.equal(add.status, 400);
  });

  await t.test('con control: suma entradas, descuenta y nunca bloquea (queda en 0)', async () => {
    const token = await registerUser(api);
    const l = (await crear(token, { name: 'Lomo', sale_price: 100, stock: 10, unit: 'lb', track_stock: true })).body;
    assert.equal(Number(l.track_stock), 1);
    assert.equal((await api('PUT', `/api/products/${l.id}`, { token, body: { add_stock: 4.2 } })).status, 200);
    assert.equal(Number((await leer(token, l.id)).stock), 14.2);
    assert.equal((await ventaDe(token, l.id, 3)).status, 201);
    assert.equal(Number((await leer(token, l.id)).stock), 11.2);
    assert.equal((await ventaDe(token, l.id, 20)).status, 201, 'vender más de lo que hay no bloquea');
    assert.equal(Number((await leer(token, l.id)).stock), 0);
  });

  await t.test('un producto sin control no sale en stock bajo ni se puede contar', async () => {
    const token = await registerUser(api);
    const q = (await crear(token, { name: 'Queso', sale_price: 100, unit: 'lb' })).body;
    const dash = await api('GET', '/api/dashboard', { token });
    assert.equal(dash.body.lowStock.some((p) => p.id === q.id), false);
    const count = await api('POST', '/api/inventory-counts', { token, body: { items: [{ product_id: q.id, counted: 2 }] } });
    assert.equal(count.status, 400);
  });
});
