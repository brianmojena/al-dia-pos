const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

test('actividad de un día en el dashboard', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const { api } = ctx;

  await t.test('trae ventas con quién cobró, pases de almacén y el almacén en el resumen', async () => {
    const dueño = await registerUser(api);
    const prodId = await createProduct(api, dueño, { name: 'Arroz', stock: 10, sale_price: 100 });
    const venta = await api('POST', '/api/sales', {
      token: dueño,
      body: { items: [{ product_id: prodId, quantity: 2, unit_price: 100 }], payment_method: 'efectivo' },
    });
    assert.equal(venta.status, 201);
    const alta = await api('POST', '/api/warehouse', { token: dueño, body: { name: 'Aceite', cost: 50, quantity: 10 } });
    await api('POST', '/api/warehouse/transfer', { token: dueño, body: { warehouse_item_id: alta.body.id, quantity: 4, sale_price: 80 } });

    const dia = await api('GET', '/api/dashboard/day', { token: dueño });
    assert.equal(dia.status, 200);
    assert.equal(dia.body.summary.count, 1);
    assert.equal(dia.body.sales[0].items[0].product_name, 'Arroz');
    assert.ok(dia.body.sales[0].account_email);
    assert.match(dia.body.sales[0].time, /^\d{2}:\d{2}$/);
    assert.equal(dia.body.transfers.length, 1);
    assert.ok(dia.body.transfers[0].account_email);
    assert.equal(dia.body.next, null, 'hoy no tiene día siguiente');
    assert.ok(dia.body.prev);

    const resumen = await api('GET', '/api/dashboard', { token: dueño });
    assert.equal(resumen.body.warehouse.items, 1);
    assert.equal(resumen.body.warehouse.lastTransfer.item_name, 'Aceite');
  });

  await t.test('solo los últimos 90 días y nunca el futuro', async () => {
    const dueño = await registerUser(api);
    let date = (await api('GET', '/api/dashboard/day', { token: dueño })).body.date;
    let steps = 0;
    for (let d = await api('GET', `/api/dashboard/day?date=${date}`, { token: dueño }); d.body.prev; steps++) {
      d = await api('GET', `/api/dashboard/day?date=${d.body.prev}`, { token: dueño });
      assert.equal(d.status, 200);
      date = d.body.date;
    }
    assert.equal(steps, 89);
    assert.equal((await api('GET', '/api/dashboard/day?date=2000-01-01', { token: dueño })).status, 400);
    assert.equal((await api('GET', '/api/dashboard/day?date=2999-01-01', { token: dueño })).status, 400);
    assert.equal((await api('GET', '/api/dashboard/day?date=hola', { token: dueño })).status, 400);
  });

  await t.test('un cajero no puede verlo', async () => {
    const dueño = await registerUser(api);
    const email = `cj${Date.now()}@test.local`;
    await api('POST', '/api/auth/cashiers', { token: dueño, body: { email, password: 'cajero1234' } });
    const cajero = (await api('POST', '/api/auth/login', { body: { email, password: 'cajero1234' } })).body.token;
    assert.equal((await api('GET', '/api/dashboard/day', { token: cajero })).status, 403);
  });
});
