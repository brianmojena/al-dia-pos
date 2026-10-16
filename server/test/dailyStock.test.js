const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

test('day stock reconstruye apertura y se mantiene solo para dueño', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const owner = await registerUser(ctx.api);
  const cashier = await createCashier(ctx.api, owner);
  const otherOwner = await registerUser(ctx.api);
  const tracked = (await ctx.api('POST', '/api/products', { token: owner, body: {
    name: 'Cajas', stock: 20, sale_price: 1, pack_size: 3, pack_price: 2,
  } })).body.id;
  const weighted = (await ctx.api('POST', '/api/products', { token: owner, body: {
    name: 'Harina', stock: 12, unit: 'kg', track_stock: true, sale_price: 10,
  } })).body.id;
  const untracked = (await ctx.api('POST', '/api/products', { token: owner, body: {
    name: 'Peso libre', unit: 'kg', stock: 99, sale_price: 10,
  } })).body.id;
  const createdToday = await createProduct(ctx.api, owner, { name: 'Nuevo', stock: 7 });
  assert.ok(tracked, 'producto con pack_size creado');
  assert.ok(weighted, 'producto pesado controlado creado');
  assert.ok(untracked, 'producto pesado sin control creado');
  await ctx.db.execute({ sql: 'UPDATE products SET created_at = ? WHERE id IN (?, ?)', args: ['2020-01-01 12:00:00', tracked, weighted] });
  assert.equal((await ctx.db.execute({ sql: 'SELECT created_at FROM products WHERE id = ?', args: [tracked] })).rows[0].created_at, '2020-01-01 12:00:00');
  await ctx.db.execute({ sql: 'UPDATE stock_entries SET created_at = ? WHERE product_id IN (?, ?)', args: ['2020-01-01 12:00:00', tracked, weighted] });

  // Ventas unitarias, por paquete y por peso (en sueltos/unidad base).
  const sale = await ctx.api('POST', '/api/sales', { token: cashier.token, body: { items: [
    { product_id: tracked, quantity: 2, unit_price: 1 },
    { product_id: weighted, quantity: 1.25, unit_price: 10 },
    { product_id: tracked, quantity: 1, unit_price: 2, pack_size: 3 },
  ] } });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));

  // Ajuste por conteo: el delta de stock_entries es la diferencia autoritativa.
  await ctx.db.execute({ sql: `UPDATE products SET stock = stock - 2 WHERE id = ?`, args: [tracked] });
  await ctx.db.execute({ sql: `INSERT INTO stock_entries (user_id, product_id, product_name, quantity, stock_before, stock_after, kind)
    SELECT user_id, id, name, -2, 18, 16, 'correccion' FROM products WHERE id = ?`, args: [tracked] });

  // Transferencias desde y hacia tienda alteran el stock de venta.
  await ctx.db.execute({ sql: `UPDATE products SET stock = stock + 5 WHERE id = ?`, args: [tracked] });
  await ctx.db.execute({ sql: `INSERT INTO warehouse_transfers (user_id, product_id, item_name, quantity, direction)
    SELECT user_id, id, name, 5, 'to_store' FROM products WHERE id = ?`, args: [tracked] });
  await ctx.db.execute({ sql: 'UPDATE products SET stock = stock - 2 WHERE id = ?', args: [tracked] });
  await ctx.db.execute({ sql: `INSERT INTO warehouse_transfers (user_id, product_id, item_name, quantity, direction)
    SELECT user_id, id, name, 2, 'to_warehouse' FROM products WHERE id = ?`, args: [tracked] });

  // Anular venta restaura unidades con una entrada positiva; el before JSON archivado no vuelve a contarse.
  const cancelled = await ctx.api('POST', `/api/sales/${sale.body.id}/correct`, { token: owner, body: { action: 'anular', reason: 'prueba' } });
  assert.equal(cancelled.status, 200);

  const result = await ctx.api('GET', '/api/products/day-stock', { token: owner });
  assert.equal(result.status, 200);
  const rows = new Map(result.body.products.map((p) => [p.id, p]));
  assert.equal(rows.get(tracked).opening_stock, 20, `corrige apertura; date=${result.body.date} row=${JSON.stringify(rows.get(tracked))}`);
  assert.equal(rows.get(tracked).current_stock, 21);
  assert.equal(rows.get(weighted).opening_stock, 12, 'anulación devuelve la cantidad pesada');
  assert.equal(rows.get(weighted).current_stock, 12);
  assert.equal(rows.get(untracked).tracked, false);
  assert.equal(rows.get(untracked).opening_stock, null);
  assert.equal(rows.get(createdToday).opening_stock, 0);
  assert.equal((await ctx.api('GET', '/api/products/day-stock', { token: cashier.token })).status, 403);
  assert.equal((await ctx.api('GET', '/api/products/day-stock', { token: otherOwner })).body.products.length, 0);

  const clampedWeight = await ctx.api('POST', '/api/products', { token: owner, body: {
    name: 'Venta pesada con clamp', unit: 'kg', track_stock: true, stock: 2, sale_price: 10,
  } });
  assert.equal(clampedWeight.status, 201);
  const clampedId = Number(clampedWeight.body.id);
  await ctx.db.execute({ sql: 'UPDATE products SET created_at = ? WHERE id = ?', args: ['2020-01-01 12:00:00', clampedId] });
  await ctx.db.execute({ sql: 'UPDATE stock_entries SET created_at = ? WHERE product_id = ?', args: ['2020-01-01 12:00:00', clampedId] });
  const clampedSale = await ctx.api('POST', '/api/sales', { token: cashier.token, body: {
    items: [{ product_id: clampedId, quantity: 5, unit_price: 10 }],
  } });
  assert.equal(clampedSale.status, 201);
  const soldLine = (await ctx.db.execute({ sql: 'SELECT stock_delta FROM sale_items WHERE sale_id = ?', args: [clampedSale.body.id] })).rows[0];
  assert.equal(soldLine.stock_delta, -2, 'persiste el descuento aplicado, no las 5 unidades cobradas');
  let stockResult = await ctx.api('GET', '/api/products/day-stock', { token: owner });
  let clampedRow = stockResult.body.products.find((product) => product.id === clampedId);
  assert.equal(clampedRow.current_stock, 0);
  assert.equal(clampedRow.opening_stock, 2);
  assert.equal((await ctx.api('POST', `/api/sales/${clampedSale.body.id}/correct`, { token: owner, body: { action: 'anular' } })).status, 200);
  stockResult = await ctx.api('GET', '/api/products/day-stock', { token: owner });
  clampedRow = stockResult.body.products.find((product) => product.id === clampedId);
  assert.equal(clampedRow.current_stock, 5, 'se conserva el comportamiento actual de anulación');
  assert.equal(clampedRow.opening_stock, 2, 'la venta archivada usa stock_delta y la restauración su movimiento real');

  const legacyWeight = await ctx.api('POST', '/api/products', { token: owner, body: {
    name: 'Venta pesada legacy', unit: 'kg', track_stock: true, stock: 2, sale_price: 10,
  } });
  const legacyWeightId = Number(legacyWeight.body.id);
  await ctx.db.execute({ sql: 'UPDATE products SET created_at = ? WHERE id = ?', args: ['2020-01-01 12:00:00', legacyWeightId] });
  await ctx.db.execute({ sql: 'UPDATE stock_entries SET created_at = ? WHERE product_id = ?', args: ['2020-01-01 12:00:00', legacyWeightId] });
  const legacyWeightSale = await ctx.api('POST', '/api/sales', { token: cashier.token, body: {
    items: [{ product_id: legacyWeightId, quantity: 5, unit_price: 10 }],
  } });
  await ctx.db.execute({ sql: 'UPDATE sale_items SET stock_delta = NULL WHERE sale_id = ?', args: [legacyWeightSale.body.id] });
  stockResult = await ctx.api('GET', '/api/products/day-stock', { token: owner });
  const legacyWeightRow = stockResult.body.products.find((product) => product.id === legacyWeightId);
  assert.equal(legacyWeightRow.opening_stock, null);
  assert.match(legacyWeightRow.opening_stock_reason, /pudo aplicarse el límite de stock cero/);

  const ownerSnapshot = await ctx.api('GET', '/api/sync/snapshot', { token: owner });
  assert.deepEqual(ownerSnapshot.body.daily_stock, (await ctx.api('GET', '/api/products/day-stock', { token: owner })).body);
  const cashierSnapshot = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
  assert.equal(cashierSnapshot.body.daily_stock, undefined);

  const countedProduct = await createProduct(ctx.api, owner, { name: 'Conteo corregible', stock: 20 });
  await ctx.db.execute({ sql: 'UPDATE products SET created_at = ? WHERE id = ?', args: ['2020-01-01 12:00:00', countedProduct] });
  await ctx.db.execute({ sql: 'UPDATE stock_entries SET created_at = ? WHERE product_id = ?', args: ['2020-01-01 12:00:00', countedProduct] });
  const count = await ctx.api('POST', '/api/inventory-counts', { token: owner, body: { items: [{ product_id: countedProduct, counted: 17 }] } });
  assert.equal(count.status, 201);
  const line = count.body.items[0];
  assert.equal(line.initial_difference, -3);
  let afterCount = await ctx.api('GET', '/api/products/day-stock', { token: owner });
  assert.equal(afterCount.body.products.find((product) => product.id === countedProduct).opening_stock, 20);

  const corrected = await ctx.api('PUT', `/api/inventory-counts/${count.body.id}`, { token: owner, body: { items: [{ item_id: line.id, counted: 18 }] } });
  assert.equal(corrected.status, 200);
  const persistedLine = (await ctx.db.execute({ sql: 'SELECT initial_difference, difference FROM inventory_count_items WHERE id = ?', args: [line.id] })).rows[0];
  assert.equal(persistedLine.initial_difference, -3, 'la diferencia inicial permanece inmutable');
  assert.equal(persistedLine.difference, -2, 'difference refleja el arqueo corregido');
  afterCount = await ctx.api('GET', '/api/products/day-stock', { token: owner });
  assert.equal(afterCount.body.products.find((product) => product.id === countedProduct).opening_stock, 20,
    'diferencia inicial más la entrada de corrección reconstruyen el stock inicial');

  // Simular una fila histórica previa a la migración: sin columna inicial,
  // difference sirve solo si no existe un indicio de corrección de arqueo.
  await ctx.db.execute({ sql: 'UPDATE inventory_count_items SET initial_difference = NULL WHERE id = ?', args: [line.id] });
  afterCount = await ctx.api('GET', '/api/products/day-stock', { token: owner });
  const legacyCorrected = afterCount.body.products.find((product) => product.id === countedProduct);
  assert.equal(legacyCorrected.opening_stock, null);
  assert.match(legacyCorrected.opening_stock_reason, /histórico corregido/);

  const legacyUncorrected = await createProduct(ctx.api, owner, { name: 'Conteo legado simple', stock: 10 });
  await ctx.db.execute({ sql: 'UPDATE products SET created_at = ? WHERE id = ?', args: ['2020-01-01 12:00:00', legacyUncorrected] });
  await ctx.db.execute({ sql: 'UPDATE stock_entries SET created_at = ? WHERE product_id = ?', args: ['2020-01-01 12:00:00', legacyUncorrected] });
  const legacyCount = await ctx.api('POST', '/api/inventory-counts', { token: owner, body: { items: [{ product_id: legacyUncorrected, counted: 7 }] } });
  const legacyLine = legacyCount.body.items[0];
  await ctx.db.execute({ sql: 'UPDATE inventory_count_items SET initial_difference = NULL WHERE id = ?', args: [legacyLine.id] });
  afterCount = await ctx.api('GET', '/api/products/day-stock', { token: owner });
  assert.equal(afterCount.body.products.find((product) => product.id === legacyUncorrected).opening_stock, 10,
    'legacy sin indicio de corrección puede reconstruirse con difference');
});
