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
    const ok = await crear(token, { name: 'Pollo', sale_price: 300, purchase_price: 220, stock: 12.5, unit: 'lb' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.unit, 'lb');
    assert.equal(Number(ok.body.stock), 12.5);

    assert.equal((await crear(token, { name: 'X', sale_price: 1, unit: 'oz' })).status, 400);
    assert.equal((await crear(token, { name: 'Pieza', sale_price: 1, stock: 2.5 })).status, 400, 'por pieza no admite decimales');
  });

  await t.test('vender 2.35 lb cobra por peso y descuenta el stock decimal', async () => {
    const token = await registerUser(api);
    const { body } = await crear(token, { name: 'Frijoles', sale_price: 120, purchase_price: 80, stock: 10, unit: 'lb' });
    const res = await vender(token, [{ product_id: body.id, quantity: 2.35, unit_price: 120 }]);
    assert.equal(res.status, 201);
    assert.equal(Number(res.body.total), 282);
    assert.equal(Number(res.body.profit), 94);
    assert.equal(Number((await producto(token, body.id)).stock), 7.65);
  });

  await t.test('no se puede vender más de lo que hay ni fracciones de una pieza', async () => {
    const token = await registerUser(api);
    const peso = (await crear(token, { name: 'Harina', sale_price: 50, stock: 1, unit: 'kg' })).body;
    const pieza = (await crear(token, { name: 'Refresco', sale_price: 100, stock: 5 })).body;
    assert.equal((await vender(token, [{ product_id: peso.id, quantity: 1.001, unit_price: 50 }])).status, 409);
    assert.equal((await vender(token, [{ product_id: pieza.id, quantity: 1.5, unit_price: 100 }])).status, 400);
    assert.equal((await vender(token, [{ product_id: peso.id, quantity: 0.0004, unit_price: 50 }])).status, 400);
    assert.equal(Number((await producto(token, peso.id)).stock), 1, 'nada se descontó');
  });

  await t.test('conteo de inventario admite decimales sólo en productos por peso', async () => {
    const token = await registerUser(api);
    const peso = (await crear(token, { name: 'Azúcar', sale_price: 40, stock: 5, unit: 'kg' })).body;
    const pieza = (await crear(token, { name: 'Jabón', sale_price: 40, stock: 5 })).body;
    const bad = await api('POST', '/api/inventory-counts', { token, body: { items: [{ product_id: pieza.id, counted: 4.5 }] } });
    assert.equal(bad.status, 400);
    const ok = await api('POST', '/api/inventory-counts', { token, body: { items: [{ product_id: peso.id, counted: 4.25 }] } });
    assert.equal(ok.status, 201);
    assert.equal(Number((await producto(token, peso.id)).stock), 4.25);
  });
});
