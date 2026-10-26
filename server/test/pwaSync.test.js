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
    assert.equal(snapshot.body.cash_close_coverage_version, 1);
    assert.ok(snapshot.body.products.every((p) => p.name !== 'Otra tienda'));
    assert.equal(snapshot.body.sales[0].items[0].product_name, 'Pan');
    assert.equal(snapshot.body.sales[0].items[0].pack_size, null);
    assert.equal(snapshot.body.sales[0].cash_close_id, null);
    assert.equal(snapshot.body.cashiers[0].id, cashier.id);
    const own = await ctx.api('GET', '/api/sync/snapshot', { token: other });
    assert.equal(own.body.sales.length, 0);
    const limited = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
    assert.equal(limited.body.cash_close_coverage_version, 1);
    assert.equal(limited.body.cash_close_coverage_version, 1);
    assert.equal(limited.status, 200); assert.ok(limited.body.products.length);
    assert.deepEqual(limited.body.sales, [], 'sin ventas cerradas propias, el historial está vacío');
    assert.deepEqual(limited.body.currency_purchases, []);
    assert.deepEqual(limited.body.cash_withdrawals, []);
    assert.deepEqual(limited.body.cash_closes, []);
    for (const key of ['inventory_counts', 'rejected_sales', 'cashiers']) assert.equal(limited.body[key], undefined);
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
    const cashierClose = await ctx.api('POST', '/api/cash-closes', { token: cashier.token, body: { register_id: 'web', counted_cash: 0 } });
    assert.equal(cashierClose.status, 201);
    const cashierSale = await ctx.api('POST', '/api/sales', { token: cashier.token, body: {
      register_id: 'web', items: [{ product_id: product, quantity: 1, unit_price: 300 }],
    } });
    assert.equal(cashierSale.status, 201);
    const beforeCount = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
    assert.equal(beforeCount.body.sales.length, 1, 'el snapshot personal incluye ventas abiertas ya sincronizadas');
    assert.equal(beforeCount.body.sales[0].total, 300);
    assert.equal('profit' in beforeCount.body.sales[0], false);
    assert.equal('unit_cost' in beforeCount.body.sales[0].items[0], false);
    const laterSale = await ctx.api('POST', '/api/sales', { token: cashier.token, body: {
      register_id: 'web', items: [{ product_id: product, quantity: 1, unit_price: 50 }],
    } });
    const cashierSaleClose = await ctx.api('POST', '/api/cash-closes', { token: cashier.token, body: {
      client_close_id: 'cashier-offline-exact', register_id: 'web', covered_sale_ids: [9999999, cashierSale.body.id], // un id obsoleto no debe tumbar el cierre
      opening_float: 1000, counted_cash: 1300,
    } });
    assert.equal(cashierSaleClose.status, 201);
    assert.equal(cashierSaleClose.body.expected_cash, 1300, 'fondo 1000 más venta sincronizada de 300');
    assert.equal(cashierSaleClose.body.difference, 0);
    assert.equal(cashierSaleClose.body.sales_count, 1, 'la venta de otro dispositivo posterior al conteo queda fuera');
    const cashierSales = await ctx.api('GET', '/api/sales', { token: cashier.token });
    assert.deepEqual(cashierSales.body.map((sale) => sale.id).sort((a, b) => a - b), [cashierSale.body.id, laterSale.body.id]);
    assert.ok(cashierSales.body.every((sale) => !('profit' in sale)));
    const cashierDetail = await ctx.api('GET', `/api/sales/${cashierSale.body.id}`, { token: cashier.token });
    assert.equal(cashierDetail.status, 200);
    assert.equal('profit' in cashierDetail.body, false);
    assert.equal('unit_cost' in cashierDetail.body.items[0], false);
    assert.equal((await call('/api/cash-withdrawals', { client_withdrawal_id: 'global-cashier-close', method: 'efectivo', amount: 5, note: 'nota privada' })).status, 201);
    const limited = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
    assert.deepEqual(limited.body.sales.map((sale) => sale.id).sort((a, b) => a - b), [cashierSale.body.id, laterSale.body.id]);
    assert.ok(limited.body.sales.every((sale) => !('profit' in sale) && sale.id !== saleId));
    const cashierLine = limited.body.sales.find((sale) => sale.id === cashierSale.body.id).items[0];
    assert.equal(cashierLine.pack_size, null);
    assert.equal(cashierLine.unit, null);
    assert.equal('unit_cost' in cashierLine, false);
    assert.equal(limited.body.sales.find((sale) => sale.id === cashierSale.body.id).cash_close_id, cashierSaleClose.body.id);
    assert.equal(limited.body.sales.find((sale) => sale.id === laterSale.body.id).cash_close_id, null);
    assert.ok(limited.body.cash_closes.some((close) => close.id === cashierClose.body.id));
    assert.ok(limited.body.cash_closes.some((close) => close.id === cashierSaleClose.body.id));
    assert.equal('corrected_at' in limited.body.cash_closes[0], false);
    assert.equal('original_difference' in limited.body.cash_closes[0], false);
    assert.equal(limited.body.cash_withdrawals[0].amount, 5, 'la cobertura de extracción global se conserva');
    assert.equal('account_email' in limited.body.cash_withdrawals[0], false);
    assert.equal('note' in limited.body.cash_withdrawals[0], false);
    assert.equal('withdrawn_at' in limited.body.cash_withdrawals[0], false);
    const cashierOwnerId = (await ctx.db.execute({ sql: 'SELECT user_id FROM sales WHERE id = ?', args: [cashierSale.body.id] })).rows[0].user_id;
    for (let i = 0; i < 205; i++) {
      await ctx.db.execute({
        sql: 'INSERT INTO sales (user_id, client_sale_id, total, payment_method, account_id, account_email, register_id) VALUES (?, ?, 1, \'efectivo\', ?, ?, \'web\')',
        args: [cashierOwnerId, `open-over-200-${i}`, cashier.id, cashier.email],
      });
    }
    const complete = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
    assert.equal(complete.body.sales.length, 207, 'incluye las 205 abiertas y el historial propio ya cerrado sin truncar');
    assert.equal(complete.body.sales.filter((sale) => sale.cash_close_id == null).length, 206);
    assert.equal((await ctx.api('GET', '/api/sales', { token: cashier.token })).body.length, 207, 'el historial online tampoco se corta en 200');
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
