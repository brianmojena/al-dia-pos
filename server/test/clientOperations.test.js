const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

const OP = 'op-1';

test('operation_id: idempotencia de escrituras de la app Android', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const { api } = ctx;
  const stockDe = async (token, id) => (await api('GET', '/api/products', { token })).body.find((p) => Number(p.id) === id).stock;
  const almacen = async (token) => (await api('GET', '/api/warehouse', { token })).body;

  await t.test('POST /warehouse: dos veces crea un artículo; sin id sigue dando 409', async () => {
    const dueño = await registerUser(api);
    const body = { name: 'Aceite', cost: 5, quantity: 10, operation_id: OP };
    const a = await api('POST', '/api/warehouse', { token: dueño, body });
    const b = await api('POST', '/api/warehouse', { token: dueño, body });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.deepEqual(b.body, a.body);
    assert.equal((await almacen(dueño)).length, 1);
    // Sin operation_id: comportamiento previo (nombre repetido).
    assert.equal((await api('POST', '/api/warehouse', { token: dueño, body: { name: 'Aceite' } })).status, 409);
    // Mismo id con otro cuerpo: 409 claro, no se reaplica.
    const otro = await api('POST', '/api/warehouse', { token: dueño, body: { ...body, name: 'Arroz' } });
    assert.equal(otro.status, 409);
    assert.match(otro.body.error, /operation_id/);
    assert.equal((await almacen(dueño)).length, 1);
    // operation_id inválido.
    assert.equal((await api('POST', '/api/warehouse', { token: dueño, body: { name: 'X', operation_id: 5 } })).status, 400);
  });

  await t.test('una respuesta de error no es 2xx y no guarda recibo', async () => {
    const dueño = await registerUser(api);
    const malo = await api('POST', '/api/warehouse', { token: dueño, body: { name: '', operation_id: 'e1' } });
    assert.equal(malo.status, 400);
    const bueno = await api('POST', '/api/warehouse', { token: dueño, body: { name: '', operation_id: 'e1' } });
    assert.equal(bueno.status, 400);
  });

  await t.test('PUT /warehouse/:id add_quantity: suma una sola vez; sin id suma cada vez', async () => {
    const dueño = await registerUser(api);
    const item = (await api('POST', '/api/warehouse', { token: dueño, body: { name: 'Harina', quantity: 10 } })).body;
    const body = { add_quantity: 5, operation_id: OP };
    const a = await api('PUT', `/api/warehouse/${item.id}`, { token: dueño, body });
    const b = await api('PUT', `/api/warehouse/${item.id}`, { token: dueño, body });
    assert.equal(a.status, 200);
    assert.deepEqual(b.body, a.body);
    assert.equal((await almacen(dueño))[0].quantity, 15);
    await api('PUT', `/api/warehouse/${item.id}`, { token: dueño, body: { add_quantity: 5 } });
    await api('PUT', `/api/warehouse/${item.id}`, { token: dueño, body: { add_quantity: 5 } });
    assert.equal((await almacen(dueño))[0].quantity, 25);
  });

  await t.test('POST /warehouse/import sumar: una sola vez', async () => {
    const dueño = await registerUser(api);
    await api('POST', '/api/warehouse', { token: dueño, body: { name: 'Sal', quantity: 10 } });
    const body = { stock_mode: 'sumar', items: [{ name: 'Sal', quantity: 4 }], operation_id: OP };
    const a = await api('POST', '/api/warehouse/import', { token: dueño, body });
    const b = await api('POST', '/api/warehouse/import', { token: dueño, body });
    assert.deepEqual(b.body, a.body);
    assert.equal((await almacen(dueño))[0].quantity, 14);
    const sin = { stock_mode: 'sumar', items: [{ name: 'Sal', quantity: 4 }] };
    await api('POST', '/api/warehouse/import', { token: dueño, body: sin });
    await api('POST', '/api/warehouse/import', { token: dueño, body: sin });
    assert.equal((await almacen(dueño))[0].quantity, 22);
  });

  await t.test('POST /products/import sumar: una sola vez', async () => {
    const dueño = await registerUser(api);
    const id = await createProduct(api, dueño, { name: 'Pan', stock: 10 });
    const body = { stock_mode: 'sumar', items: [{ name: 'Pan', sale_price: 100, stock: 4 }], operation_id: OP };
    const a = await api('POST', '/api/products/import', { token: dueño, body });
    const b = await api('POST', '/api/products/import', { token: dueño, body });
    assert.deepEqual(b.body, a.body);
    assert.equal(await stockDe(dueño, id), 14);
    const sin = { stock_mode: 'sumar', items: [{ name: 'Pan', sale_price: 100, stock: 4 }] };
    await api('POST', '/api/products/import', { token: dueño, body: sin });
    assert.equal(await stockDe(dueño, id), 18);
  });

  await t.test('el mismo operation_id en otra cuenta no se cruza', async () => {
    const uno = await registerUser(api);
    const dos = await registerUser(api);
    const body = { name: 'Azúcar', quantity: 3, operation_id: OP };
    assert.equal((await api('POST', '/api/warehouse', { token: uno, body })).status, 201);
    const otra = await api('POST', '/api/warehouse', { token: dos, body });
    assert.equal(otra.status, 201);
    assert.equal((await almacen(dos)).length, 1);
    assert.equal((await almacen(uno)).length, 1);
  });

  await t.test('PUT /inventory-counts/:id: replay devuelve lo mismo y no reaplica', async () => {
    const dueño = await registerUser(api);
    const id = await createProduct(api, dueño, { name: 'Ron', stock: 10 });
    const arqueo = (await api('POST', '/api/inventory-counts', { token: dueño, body: { items: [{ product_id: id, counted: 7 }] } })).body;
    const body = { items: [{ item_id: arqueo.items[0].id, counted: 9 }], operation_id: OP };
    const a = await api('PUT', `/api/inventory-counts/${arqueo.id}`, { token: dueño, body });
    // Entre medias baja el stock: un replay no debe tocarlo.
    await api('POST', '/api/sales', { token: dueño, body: { items: [{ product_id: id, quantity: 2, unit_price: 100 }], payment_method: 'efectivo' } });
    const b = await api('PUT', `/api/inventory-counts/${arqueo.id}`, { token: dueño, body });
    assert.equal(a.status, 200);
    assert.deepEqual(b.body, a.body);
    assert.equal(await stockDe(dueño, id), 7);
    // Sin operation_id sigue funcionando como antes.
    const sin = await api('PUT', `/api/inventory-counts/${arqueo.id}`, { token: dueño, body: { items: [{ item_id: arqueo.items[0].id, counted: 9 }] } });
    assert.equal(sin.status, 200);
    assert.equal(await stockDe(dueño, id), 7);
  });

  await t.test('POST /sales/:id/correct: replay devuelve la misma respuesta; sin id repetir da 404', async () => {
    const dueño = await registerUser(api);
    const id = await createProduct(api, dueño, { name: 'Cerveza', stock: 10 });
    const venta = (await api('POST', '/api/sales', { token: dueño, body: { register_id: 'web', payment_method: 'efectivo', items: [{ product_id: id, quantity: 2, unit_price: 600 }] } })).body;
    const url = `/api/sales/${venta.id}/correct`;
    const body = { action: 'anular', operation_id: OP };
    const a = await api('POST', url, { token: dueño, body });
    const b = await api('POST', url, { token: dueño, body });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body, a.body);
    assert.equal(await stockDe(dueño, id), 10);
    assert.equal((await api('GET', `${url.replace('/correct', '/corrections')}`, { token: dueño })).body.length, 1);
    assert.equal((await api('POST', url, { token: dueño, body: { action: 'anular' } })).status, 404);
    // Mismo id, otra acción: 409.
    assert.equal((await api('POST', url, { token: dueño, body: { action: 'pago', payment_method: 'transferencia', operation_id: OP } })).status, 409);
  });

  await t.test('PUT /cash-closes/:id: replay devuelve lo mismo; sin id repetir da 409', async () => {
    const dueño = await registerUser(api);
    const cierre = (await api('POST', '/api/cash-closes', { token: dueño, body: { opening_float: 1000, counted_cash: 1000, counted_usd: 0, counted_eur: 0, register_id: 'web' } })).body;
    const fix = { opening_float: 1000, counted_cash: 900, counted_usd: 0, counted_eur: 0, note: 'x', correction_revision: 0 };
    const url = `/api/cash-closes/${cierre.id}`;
    const a = await api('PUT', url, { token: dueño, body: { ...fix, operation_id: OP } });
    const b = await api('PUT', url, { token: dueño, body: { ...fix, operation_id: OP } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(b.body, a.body);
    assert.equal(Number(b.body.cash_close.correction_revision), 1);
    assert.equal((await api('PUT', url, { token: dueño, body: fix })).status, 409);
    assert.equal((await api('PUT', url, { token: dueño, body: { ...fix, note: 'otra', operation_id: OP } })).status, 409);
  });
});
