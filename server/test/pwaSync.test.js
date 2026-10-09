const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

test('sincronización PWA: snapshot, recibos, fechas y cierre exacto', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await registerUser(ctx.api), other = await registerUser(ctx.api);
  const cashier = await createCashier(ctx.api, token);
  const product = await createProduct(ctx.api, token, { name: 'Pan', stock: 20, sale_price: 10, purchase_price: 5 });
  await createProduct(ctx.api, other, { name: 'Otra tienda', stock: 99 });
  const call = (path, body, auth = token) => ctx.api('POST', path, { token: auth, body });
  const operation = (body, auth) => call('/api/sync/product-operation', body, auth);

  await t.test('recibo de producto evita duplicar altas y sobrescribir cambios posteriores', async () => {
    const body = { operation_id: 'create-pwa', method: 'POST', product: { name: 'Leche', stock: 8, sale_price: 15, purchase_price: 10 } };
    const first = await operation(body), replay = await operation(body);
    assert.equal(first.status, 200); assert.equal(replay.body.id, first.body.id);
    const update = { operation_id: 'edit-pwa', method: 'PUT', product_id: first.body.id, expected: { name: 'Leche', stock: 8, sale_price: 15, purchase_price: 10 }, product: { name: 'Leche', stock: 9, sale_price: 17, purchase_price: 10 } };
    assert.equal((await operation(update)).status, 200);
    await ctx.api('PUT', `/api/products/${first.body.id}`, { token, body: { stock: 6 } });
    assert.equal((await operation(update)).body.stock, 9, 'devuelve el recibo del primer intento');
    const products = await ctx.api('GET', '/api/products', { token });
    assert.equal(products.body.find((p) => p.id === first.body.id).stock, 6, 'no vuelve a escribir el stock');
    assert.equal((await operation({ ...update, operation_id: 'conflict-pwa' })).status, 409);
  });
  let saleId;
  await t.test('venta offline conserva fecha real, detalle e idempotencia', async () => {
    const body = { client_sale_id: 'offline-sept', sold_at: '2026-09-01T02:00:00.000Z', register_id: 'web', payment_method: 'mixto', transfer_amount: 5, items: [{ product_id: product, quantity: 2, unit_price: 10 }] };
    const first = await call('/api/sales', body), replay = await call('/api/sales', body);
    assert.equal(first.status, 201); assert.equal(first.body.created_at, '2026-09-01 02:00:00');
    assert.equal(replay.body.id, first.body.id); saleId = first.body.id;
    const month = await ctx.api('GET', '/api/reports/days?month=2026-08', { token });
    assert.equal(month.body.totals.total, 20);
  });
  await t.test('snapshot descarga historial completo sin filtrar por pantallas visitadas ni por 200 ventas', async () => {
    const snapshot = await ctx.api('GET', '/api/sync/snapshot', { token });
    assert.equal(snapshot.status, 200);
    assert.ok(snapshot.body.products.every((p) => p.name !== 'Otra tienda'));
    assert.equal(snapshot.body.sales[0].items[0].product_name, 'Pan');
    assert.equal(snapshot.body.sales[0].cash_close_id, null);
    assert.equal(snapshot.body.cashiers[0].id, cashier.id);
    const own = await ctx.api('GET', '/api/sync/snapshot', { token: other });
    assert.equal(own.body.sales.length, 0);
    const limited = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
    assert.equal(limited.status, 200); assert.ok(limited.body.products.length);
    for (const key of ['sales', 'cash_closes', 'inventory_counts', 'rejected_sales', 'cashiers']) assert.equal(limited.body[key], undefined);
  });
  await t.test('cierre exacto deja abierta una venta posterior y conserva la fecha offline', async () => {
    const next = await call('/api/sales', { client_sale_id: 'next-sale', register_id: 'web', items: [{ product_id: product, quantity: 1, unit_price: 10 }] });
    assert.equal(next.status, 201);
    const body = { client_close_id: 'close-pwa', register_id: 'web', covered_sale_ids: [saleId], counted_cash: 15, opening_float: 0, closed_at: '2026-09-01T02:05:00.000Z' };
    const close = await call('/api/cash-closes', body);
    assert.equal(close.status, 201); assert.equal(close.body.sales_count, 1); assert.equal(close.body.difference, 0);
    assert.equal(close.body.closed_at, '2026-09-01 02:05:00');
    assert.equal((await call('/api/cash-closes', body)).body.id, close.body.id);
    const snapshot = await ctx.api('GET', '/api/sync/snapshot', { token });
    assert.equal(snapshot.body.sales.find((s) => s.id === next.body.id).cash_close_id, null);
    assert.equal((await call('/api/cash-closes', { ...body, client_close_id: 'invalid-close', covered_sale_ids: [9999999] })).status, 409);
  });
  await t.test('conteo conserva fecha e historial de líneas', async () => {
    const count = await call('/api/inventory-counts', { client_count_id: 'count-pwa', counted_at: '2026-09-01T02:10:00.000Z', items: [{ product_id: product, counted: 15 }] });
    assert.equal(count.status, 201); assert.equal(count.body.counted_at, '2026-09-01 02:10:00');
    const snapshot = await ctx.api('GET', '/api/sync/snapshot', { token });
    assert.equal(snapshot.body.inventory_counts[0].items[0].counted, 15);
  });
  await t.test('cajero puede crear productos pero no editar mediante el sincronizador', async () => {
    const body = { operation_id: 'cashier-create', method: 'POST', product: { name: 'Agua', stock: 3, sale_price: 5 } };
    assert.equal((await operation(body, cashier.token)).status, 200);
    assert.equal((await operation({ ...body, operation_id: 'cashier-edit', method: 'PUT', product_id: product }, cashier.token)).status, 403);
  });
});
