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
  await t.test('cajero crea productos y edita solo precio de venta mediante el sincronizador', async () => {
    const body = { operation_id: 'cashier-create', method: 'POST', product: { name: 'Agua', stock: 3, sale_price: 5 } };
    assert.equal((await operation(body, cashier.token)).status, 200);
    assert.equal((await operation({ ...body, operation_id: 'cashier-edit-forbidden', method: 'PUT', product_id: product }, cashier.token)).status, 403);
    const before = (await ctx.api('GET', '/api/products', { token })).body.find((p) => Number(p.id) === product);
    const edit = { operation_id: 'cashier-price', method: 'PUT', product_id: product, product: { sale_price: 12.5 }, expected: { sale_price: before.sale_price } };
    const saved = await operation(edit, cashier.token);
    assert.equal(saved.status, 200);
    assert.equal(Number(saved.body.sale_price), 12.5);
    assert.equal(saved.body.stock, before.stock);
    assert.equal(saved.body.name, before.name);
    assert.equal(saved.body.purchase_price, before.purchase_price);
    assert.deepEqual((await operation(edit, cashier.token)).body, saved.body, 'el reintento devuelve el mismo recibo');
    assert.equal((await operation({ ...edit, operation_id: 'stale-price', product: { sale_price: 14 } }, cashier.token)).status, 409);
    for (const sale_price of [-1, '', null, 'abc']) {
      assert.equal((await operation({ ...edit, operation_id: `bad-price-${sale_price}`, product: { sale_price } }, cashier.token)).status, 400);
    }
    assert.equal((await operation({ ...edit, operation_id: 'cashier-delete', method: 'DELETE' }, cashier.token)).status, 403);
    assert.equal((await operation({ ...edit, operation_id: 'missing-product', product_id: 999999, expected: undefined }, cashier.token)).status, 404);
  });
  await t.test('añadir stock sin internet suma encima de las ventas, se anota y no da conflicto', async () => {
    const id = await createProduct(ctx.api, token, { name: 'Harina', stock: 10, sale_price: 20 });
    const sell = (n) => call('/api/sales', { client_sale_id: `harina-${n}`, register_id: 'web', items: [{ product_id: id, quantity: n, unit_price: 20 }] });
    // La caja editó con stock 10; mientras tanto otra vendió 3.
    assert.equal((await sell(3)).status, 201);
    const owner = await operation({ operation_id: 'add-owner', method: 'PUT', product_id: id, expected: { name: 'Harina', sale_price: 20, purchase_price: 60, stock: 10 }, product: { name: 'Harina', purchase_price: 60, sale_price: 20, add_stock: 5 } });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.stock, 12, '10 - 3 vendidas + 5 añadidas');
    assert.equal((await operation({ operation_id: 'add-owner', method: 'PUT', product_id: id, product: { add_stock: 5 } })).body.stock, 12, 'el reintento no suma dos veces');
    const byCashier = await operation({ operation_id: 'add-cashier', method: 'PUT', product_id: id, expected: { sale_price: 20 }, product: { sale_price: 22, add_stock: 2 } }, cashier.token);
    assert.equal(byCashier.status, 200);
    assert.equal(byCashier.body.stock, 14); assert.equal(byCashier.body.sale_price, 22);
    assert.equal((await operation({ operation_id: 'cashier-other', method: 'PUT', product_id: id, product: { name: 'X', add_stock: 1 } }, cashier.token)).status, 403);
    assert.equal((await operation({ operation_id: 'add-bad', method: 'PUT', product_id: id, product: { add_stock: 1.5 } })).status, 400, 'una pieza no admite decimales');
    const entries = await ctx.api('GET', '/api/products/stock-entries', { token });
    const mine = entries.body.filter((e) => e.product_id === id && e.kind !== 'nuevo');
    assert.deepEqual(mine.map((e) => [Number(e.quantity), Number(e.stock_before), Number(e.stock_after)]).sort(), [[2, 12, 14], [5, 7, 12]]);
  });
});
