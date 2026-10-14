const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

const crearCajero = async (api, dueño) => {
  const email = `cj${Date.now()}${Math.floor(Math.random() * 1e6)}@test.local`;
  await api('POST', '/api/auth/cashiers', { token: dueño, body: { email, password: 'cajero1234' } });
  return (await api('POST', '/api/auth/login', { body: { email, password: 'cajero1234' } })).body.token;
};

test('almacén', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const { api } = ctx;

  await t.test('cualquiera da de alta y transfiere; el historial es del dueño', async () => {
    const dueño = await registerUser(api);
    const cajero = await crearCajero(api, dueño);
    const alta = await api('POST', '/api/warehouse', { token: cajero, body: { name: 'Aceite', cost: 50, quantity: 10 } });
    assert.equal(alta.status, 201);
    assert.equal((await api('GET', '/api/warehouse', { token: dueño })).body.length, 1);
    assert.equal((await api('GET', '/api/warehouse/transfers', { token: cajero })).status, 403);
    assert.equal((await api('GET', '/api/warehouse/changes', { token: cajero })).status, 403);

    // producto nuevo en la tienda: exige precio de venta
    const sin = await api('POST', '/api/warehouse/transfer', { token: cajero, body: { warehouse_item_id: alta.body.id, quantity: 4 } });
    assert.equal(sin.status, 400);
    const ok = await api('POST', '/api/warehouse/transfer', { token: cajero, body: { warehouse_item_id: alta.body.id, quantity: 4, sale_price: 80, client_transfer_id: 'abc' } });
    assert.equal(ok.status, 201);
    const repetido = await api('POST', '/api/warehouse/transfer', { token: cajero, body: { warehouse_item_id: alta.body.id, quantity: 4, sale_price: 80, client_transfer_id: 'abc' } });
    assert.equal(repetido.status, 200);
    const prod = (await api('GET', '/api/products', { token: dueño })).body.find((p) => p.name === 'Aceite');
    assert.equal(prod.stock, 4);
    assert.equal(prod.purchase_price, 50);
    assert.equal((await api('GET', '/api/warehouse', { token: dueño })).body[0].quantity, 6);
    assert.equal((await api('GET', '/api/warehouse/transfers', { token: dueño })).body.length, 1);
  });

  await t.test('un cajero edita, repone y borra, y queda quién lo hizo', async () => {
    const dueño = await registerUser(api);
    const cajero = await crearCajero(api, dueño);
    const alta = await api('POST', '/api/warehouse', { token: dueño, body: { name: 'Sal', cost: 5, quantity: 2 } });
    assert.equal((await api('PUT', `/api/warehouse/${alta.body.id}`, { token: cajero, body: { cost: 6 } })).status, 200);
    assert.equal((await api('PUT', `/api/warehouse/${alta.body.id}`, { token: cajero, body: { add_quantity: 3 } })).body.quantity, 5);
    assert.equal((await api('DELETE', `/api/warehouse/${alta.body.id}`, { token: cajero })).status, 200);
    const log = (await api('GET', '/api/warehouse/changes', { token: dueño })).body;
    assert.deepEqual(log.map((c) => c.action).sort(), ['alta', 'borrado', 'edición', 'reposición']);
    assert.ok(log.every((c) => c.account_email));
    assert.notEqual(log.find((c) => c.action === 'borrado').account_email, log.find((c) => c.action === 'alta').account_email);
  });

  await t.test('producto existente suma stock; no se pasa más de lo que hay', async () => {
    const dueño = await registerUser(api);
    await createProduct(api, dueño, { name: 'Arroz', stock: 5 });
    const alta = await api('POST', '/api/warehouse', { token: dueño, body: { name: 'arroz', cost: 10, quantity: 3 } });
    const t1 = await api('POST', '/api/warehouse/transfer', { token: dueño, body: { warehouse_item_id: alta.body.id, quantity: 3 } });
    assert.equal(t1.status, 201);
    const prod = (await api('GET', '/api/products', { token: dueño })).body.find((p) => p.name === 'Arroz');
    assert.equal(prod.stock, 8);
    const mas = await api('POST', '/api/warehouse/transfer', { token: dueño, body: { warehouse_item_id: alta.body.id, quantity: 1 } });
    assert.equal(mas.status, 409);
    const rep = await api('PUT', `/api/warehouse/${alta.body.id}`, { token: dueño, body: { add_quantity: 7 } });
    assert.equal(rep.body.quantity, 7);
  });

  await t.test('importación: crea, suma o reemplaza, y cualquier cuenta', async () => {
    const dueño = await registerUser(api);
    const cajero = await crearCajero(api, dueño);
    const items = [{ name: 'Aceite', cost: 50, quantity: 10 }, { name: 'Arroz', unit: 'lb', cost: 90, quantity: 2.5 }];
    const uno = await api('POST', '/api/warehouse/import', { token: cajero, body: { items } });
    assert.deepEqual([uno.body.created, uno.body.updated], [2, 0]);
    const dos = await api('POST', '/api/warehouse/import', { token: dueño, body: { stock_mode: 'sumar', items: [{ name: 'ACEITE', quantity: 5 }, { name: 'Sal', cost: 5 }] } });
    assert.deepEqual([dos.body.created, dos.body.updated], [1, 1]);
    const lista = (await api('GET', '/api/warehouse', { token: dueño })).body;
    const por = (n) => lista.find((i) => i.name === n);
    assert.equal(por('Aceite').quantity, 15);
    assert.equal(por('Aceite').cost, 50, 'costo vacío no cambia');
    await api('POST', '/api/warehouse/import', { token: dueño, body: { stock_mode: 'reemplazar', items: [{ name: 'Aceite', cost: 60, quantity: 4 }] } });
    assert.equal((await api('GET', '/api/warehouse', { token: dueño })).body.find((i) => i.name === 'Aceite').quantity, 4);
    const mala = await api('POST', '/api/warehouse/import', { token: dueño, body: { items: [{ name: 'Arroz', unit: 'kg', cost: 1 }] } });
    assert.equal(mala.status, 400);
  });
});
