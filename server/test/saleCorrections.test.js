const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

const crearCajero = async (api, dueño) => {
  const email = `cj${Date.now()}${Math.floor(Math.random() * 1e6)}@test.local`;
  await api('POST', '/api/auth/cashiers', { token: dueño, body: { email, password: 'cajero1234' } });
  return (await api('POST', '/api/auth/login', { body: { email, password: 'cajero1234' } })).body.token;
};

/**
 * La cuenta principal corrige ventas ya hechas: cambia la forma de pago o la
 * anula (el stock vuelve). Si la venta ya estaba en un cierre, el cierre se
 * recalcula y queda marcado. Todo queda registrado.
 */
test('correcciones de ventas', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const { api } = ctx;
  const vender = (token, productId, body = {}) => api('POST', '/api/sales', {
    token,
    body: { register_id: 'web', payment_method: 'efectivo', items: [{ product_id: productId, quantity: 2, unit_price: 600 }], ...body },
  });

  await t.test('cambiar a transferencia arregla el faltante del cierre', async () => {
    const dueño = await registerUser(api);
    const prod = await createProduct(api, dueño, { name: 'Cerveza', stock: 10, sale_price: 600 });
    const venta = await vender(dueño, prod);
    // En la gaveta solo había 0: la venta en realidad fue por transferencia.
    const cierre = await api('POST', '/api/cash-closes', { token: dueño, body: { register_id: 'web', counted_cash: 0 } });
    assert.equal(Number(cierre.body.difference), -1200);

    const fix = await api('POST', `/api/sales/${venta.body.id}/correct`, { token: dueño, body: { action: 'pago', payment_method: 'transferencia', reason: 'se equivocó' } });
    assert.equal(fix.status, 200);
    assert.equal(fix.body.sale.payment_method, 'transferencia');
    assert.equal(Number(fix.body.cash_close.difference), 0);
    assert.equal(Number(fix.body.cash_close.expected_transfer), 1200);
    assert.equal(Number(fix.body.cash_close.original_difference), -1200);
    assert.ok(fix.body.cash_close.corrected_at);

    const log = await api('GET', `/api/sales/${venta.body.id}/corrections`, { token: dueño });
    assert.equal(log.body.length, 1);
    assert.equal(log.body[0].before.payment_method, 'efectivo');
    assert.equal(log.body[0].after.payment_method, 'transferencia');
    assert.equal(log.body[0].close_before.difference, -1200);
    assert.equal(log.body[0].reason, 'se equivocó');

    const igual = await api('POST', `/api/sales/${venta.body.id}/correct`, { token: dueño, body: { action: 'pago', payment_method: 'transferencia' } });
    assert.equal(igual.status, 400);
  });

  await t.test('mixto y divisa se validan como al cobrar', async () => {
    const dueño = await registerUser(api);
    const prod = await createProduct(api, dueño, { name: 'Ron', stock: 10, sale_price: 600 });
    const venta = await vender(dueño, prod);
    const url = `/api/sales/${venta.body.id}/correct`;
    assert.equal((await api('POST', url, { token: dueño, body: { action: 'pago', payment_method: 'mixto', transfer_amount: 1200 } })).status, 400);
    const mixto = await api('POST', url, { token: dueño, body: { action: 'pago', payment_method: 'mixto', transfer_amount: 500 } });
    assert.equal(mixto.status, 200);
    assert.equal(Number(mixto.body.sale.transfer_amount), 500);
    const divisa = await api('POST', url, { token: dueño, body: { action: 'pago', payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 3, exchange_rate: 400 } });
    assert.equal(divisa.status, 200);
    assert.equal(divisa.body.sale.transfer_amount, null);
    assert.equal(Number(divisa.body.sale.foreign_amount), 3);
  });

  await t.test('anular devuelve el stock, quita la venta y recalcula el cierre', async () => {
    const dueño = await registerUser(api);
    const prod = await createProduct(api, dueño, { name: 'Galletas', stock: 10, sale_price: 600 });
    const venta = await vender(dueño, prod);
    await vender(dueño, prod);
    const cierre = await api('POST', '/api/cash-closes', { token: dueño, body: { register_id: 'web', counted_cash: 1200 } });
    assert.equal(Number(cierre.body.difference), -1200);
    assert.equal(Number(cierre.body.sales_count), 2);

    const anular = await api('POST', `/api/sales/${venta.body.id}/correct`, { token: dueño, body: { action: 'anular' } });
    assert.equal(anular.status, 200);
    assert.equal(anular.body.sale, null);
    assert.equal(Number(anular.body.cash_close.difference), 0);
    assert.equal(Number(anular.body.cash_close.sales_count), 1);
    assert.equal((await api('GET', `/api/sales/${venta.body.id}`, { token: dueño })).status, 404);

    const stock = (await api('GET', '/api/products', { token: dueño })).body.find((p) => p.id === prod).stock;
    assert.equal(stock, 8);
    const entradas = (await api('GET', '/api/products/stock-entries', { token: dueño })).body;
    assert.equal(entradas[0].kind, 'anulacion');
    assert.equal(entradas[0].quantity, 2);

    const delDia = (await api('GET', '/api/sales/corrections', { token: dueño })).body;
    assert.equal(delDia[0].action, 'anular');
    assert.equal(delDia[0].before.items.length, 1);

    const delta = (await api('GET', '/api/sync/delta', { token: dueño })).body;
    assert.equal(delta.sale_corrections.length, 1);
    assert.equal(delta.sale_corrections[0].sale, null);
    assert.equal(Number(delta.sale_corrections[0].cash_close.difference), 0);
    assert.equal(delta.cursors.correction, delta.sale_corrections[0].id);

    assert.equal((await api('POST', `/api/sales/${venta.body.id}/correct`, { token: dueño, body: { action: 'anular' } })).status, 404);
  });

  await t.test('un cajero no puede corregir ni ver correcciones', async () => {
    const dueño = await registerUser(api);
    const cajero = await crearCajero(api, dueño);
    const prod = await createProduct(api, dueño, { name: 'Agua', stock: 10, sale_price: 600 });
    const venta = await vender(cajero, prod);
    assert.equal((await api('POST', `/api/sales/${venta.body.id}/correct`, { token: cajero, body: { action: 'anular' } })).status, 403);
    assert.equal((await api('GET', '/api/sales/corrections', { token: cajero })).status, 403);
  });

  await t.test('la cuenta principal pone el stock a mano y queda anotado', async () => {
    const dueño = await registerUser(api);
    const prod = await createProduct(api, dueño, { name: 'Jabas', stock: 58, sale_price: 20 });
    await api('PUT', `/api/products/${prod}`, { token: dueño, body: { sale_price: 25 } });
    await api('PUT', `/api/products/${prod}`, { token: dueño, body: { stock: 55, stock_reason: 'conteo' } });
    const entradas = (await api('GET', '/api/products/stock-entries', { token: dueño })).body;
    assert.equal(entradas.length, 1);
    assert.equal(entradas[0].kind, 'correccion');
    assert.equal(entradas[0].quantity, -3);
    assert.equal(entradas[0].stock_before, 58);
    assert.equal(entradas[0].stock_after, 55);
    assert.equal(entradas[0].reason, 'conteo');
  });
});
