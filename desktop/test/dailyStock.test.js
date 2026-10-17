const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb, crearProductoSincronizado } = require('./helpers');
const { routeRequest } = require('../src/router');
const { businessToday } = require('../src/lib/businessDay');
const { createdBusinessDate } = require('../src/lib/dailyStock');

const setOwner = (queries) => queries.setSession({
  user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 'token', role: 'dueño',
});

test('creation timestamps with an existing UTC suffix parse once in Havana time', () => {
  assert.equal(createdBusinessDate('2026-01-01T02:00:00Z'), '2025-12-31');
  assert.equal(createdBusinessDate('not-a-timestamp'), null);
});

test('GET /api/products/day-stock is owner-only and maps server ids to local ids', async () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Arroz', stock: 10 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday(), products: [
      { id: serverId, opening_stock: 7, current_stock: 10, tracked: true },
    ] });

    const owner = await routeRequest('GET', '/api/products/day-stock');
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.data.products, [
      { id: product.id, opening_stock: 7, entries_stock: 0, current_stock: 10, tracked: true },
    ]);

    ctx.queries.setSession({
      user_id: 1, email: 'cajera@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 'token', role: 'cajero',
    });
    const cashier = await routeRequest('GET', '/api/products/day-stock');
    assert.equal(cashier.status, 403);
  } finally { ctx.close(); }
});

test('local sales, stock entries and inventory counts adjust current stock without changing opening', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Leche', stock: 10 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday(), products: [
      { id: serverId, opening_stock: 8, current_stock: 10, tracked: true },
    ] });

    ctx.queries.createSaleLocal({ items: [{ product_id: product.id, quantity: 2, unit_price: 100 }] });
    ctx.queries.updateProduct(product.id, { add_stock: 3 });
    ctx.db.prepare('INSERT INTO warehouse_items (id, name, unit, cost, quantity) VALUES (44, ?, NULL, 50, 5)').run('Leche');
    ctx.queries.transferWarehouseLocal({ warehouse_item_id: 44, quantity: 2 });
    ctx.queries.createInventoryCountLocal({ items: [{ product_id: product.id, counted: 17 }] });

    const row = ctx.queries.getDayStock().products[0];
    assert.equal(row.opening_stock, 8);
    assert.equal(row.current_stock, 17);
    assert.equal(row.tracked, true);
  } finally { ctx.close(); }
});

test('inicial + entradas se muestran aparte y la venta solo mueve el disponible', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Refresco', stock: 25 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 1, entries_stock: 24, current_stock: 25, tracked: true },
    ] });

    let row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [1, 24, 25]);

    ctx.queries.createSaleLocal({ items: [{ product_id: product.id, quantity: 3, unit_price: 100 }] });
    row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [1, 24, 22]);
  } finally { ctx.close(); }
});

test('las entradas locales pendientes se suman al resumen del servidor sin duplicarse', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Aceite', stock: 10 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 10, entries_stock: 4, current_stock: 10, tracked: true },
    ] });

    ctx.queries.updateProduct(product.id, { add_stock: 5 });
    ctx.queries.updateProduct(product.id, { add_stock: 6 });
    let row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.entries_stock, 15, '4 del servidor + 11 pendientes en esta caja');
    assert.equal(row.current_stock, 21);

    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 10, entries_stock: 15, current_stock: 21, tracked: true },
    ] });
    row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.entries_stock, 15, 'ya sincronizadas, no se cuentan dos veces');
    assert.equal(row.opening_stock, 10);
  } finally { ctx.close(); }
});

test('correcciones y anulaciones ajustan el disponible pero no son entradas', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Café', stock: 20 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 20, entries_stock: 0, current_stock: 20, tracked: true },
    ] });

    ctx.queries.updateProduct(product.id, { add_stock: 4 });
    ctx.queries.updateProduct(product.id, { stock: 21, stock_reason: 'conteo' });

    const row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.entries_stock, 4, 'solo la mercancía recibida cuenta como entrada');
    assert.equal(row.current_stock, 21);
    assert.equal(row.opening_stock, 20);
  } finally { ctx.close(); }
});

test('un producto creado hoy sin resumen del servidor deriva sus entradas del alta pendiente', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = ctx.queries.createProduct({ name: 'Nuevo hoy', sale_price: 10, stock: 6 });
    const row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.opening_stock, 0);
    assert.equal(row.entries_stock, 6, 'el stock con que nace es su entrada del día');
    assert.equal(row.current_stock, 6);
  } finally { ctx.close(); }
});

test('a stale or missing server day never fabricates opening stock', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = ctx.queries.createProduct({ name: 'Nuevo', sale_price: 20, stock: 4 });
    const withoutSnapshot = ctx.queries.getDayStock().products.find((row) => row.id === product.id);
    assert.equal(withoutSnapshot.opening_stock, 0, 'a valid creation timestamp today establishes zero opening');
    assert.equal(withoutSnapshot.current_stock, 4, 'opening is not copied from current stock');
    const invalidDateProduct = ctx.queries.createProduct({ name: 'Fecha inválida', sale_price: 10, stock: 6 });
    ctx.db.prepare("UPDATE products SET created_at = 'not-a-timestamp' WHERE id = ?").run(invalidDateProduct.id);
    assert.equal(ctx.queries.getDayStock().products.find((row) => row.id === invalidDateProduct.id).opening_stock, null);

    ctx.queries.applyServerDayStock({ date: '2000-01-01', products: [] });
    const data = ctx.queries.getDayStock();
    assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(data.products.find((row) => row.id === product.id).opening_stock, 0);

    ctx.queries.applyServerDayStock({ date: data.date, products: [] });
    const newProduct = ctx.queries.getDayStock().products.find((row) => row.id === product.id);
    assert.equal(newProduct.opening_stock, 0, 'a locally created product today starts from a known zero');
    assert.equal(newProduct.current_stock, 4);
  } finally { ctx.close(); }
});

test('weighted over-sale stays clamped locally and a retry cannot subtract it twice', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Queso', stock: 2, unit: 'lb', track_stock: 1 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 2, current_stock: 2, tracked: true },
    ] });

    ctx.queries.createSaleLocal({ items: [{ product_id: product.id, quantity: 5, unit_price: 100 }] });
    ctx.db.prepare("UPDATE outbox SET status = 'syncing' WHERE op_type = 'sale.create'").run();

    const first = ctx.queries.getDayStock().products[0];
    const retry = ctx.queries.getDayStock().products[0];
    assert.equal(first.current_stock, 0, 'weighted stock is clamped to zero in the local product row');
    assert.equal(retry.current_stock, 0, 'reading/retrying does not apply the sale delta again');
    assert.equal(retry.opening_stock, 2);
  } finally { ctx.close(); }
});

test('las entradas de ayer no se arrastran al día de hoy', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Pan', stock: 10 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 10, entries_stock: 0, current_stock: 10, tracked: true },
    ] });

    ctx.queries.updateProduct(product.id, { add_stock: 5 });
    ctx.db.prepare("UPDATE outbox SET created_at = datetime('now', '-1 day') WHERE op_type = 'product.update'").run();

    const row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.entries_stock, 0, 'una entrada de ayer no se arrastra al día de hoy');
  } finally { ctx.close(); }
});

test('una entrada confirmada sigue contando si el resumen no se pudo refrescar', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Aceite', stock: 10 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 10, entries_stock: 0, current_stock: 10, tracked: true },
    ] });

    // Recibe 5 y se confirma, pero el GET del resumen falla y no baja snapshot nuevo.
    ctx.queries.updateProduct(product.id, { add_stock: 5 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced' WHERE op_type = 'product.update'").run();
    let row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.entries_stock, 5, 'la entrada confirmada no desaparece si falla el resumen');

    // Al bajar por fin el resumen confirmado queda cubierta y no se duplica.
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 10, entries_stock: 5, current_stock: 15, tracked: true },
    ] });
    row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.entries_stock, 5, 'el resumen confirmado sustituye la cifra local');
  } finally { ctx.close(); }
});

test('una entrada pendiente creada antes del resumen no desaparece al confirmarse sin refrescar', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Frijol', stock: 10 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 10, entries_stock: 0, current_stock: 10, tracked: true },
    ] });

    ctx.queries.updateProduct(product.id, { add_stock: 3 });
    // El resumen se refresca mientras la entrada sigue pendiente: no la cubre.
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 10, entries_stock: 0, current_stock: 10, tracked: true },
    ] });
    // Y luego se confirma sin bajar otro resumen.
    ctx.db.prepare("UPDATE outbox SET status = 'synced' WHERE op_type = 'product.update'").run();

    const row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.entries_stock, 3, 'no se pierde una entrada pendiente que se confirma tarde');
  } finally { ctx.close(); }
});

test('la transferencia del almacén a la tienda cuenta como entrada del día', () => {
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const product = crearProductoSincronizado(ctx.queries, { name: 'Azúcar', stock: 10 });
    ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
    const serverId = ctx.db.prepare('SELECT server_id FROM products WHERE id = ?').get(product.id).server_id;
    ctx.queries.applyServerDayStock({ date: businessToday('America/Havana'), products: [
      { id: serverId, opening_stock: 10, entries_stock: 0, current_stock: 10, tracked: true },
    ] });

    ctx.db.prepare('INSERT INTO warehouse_items (id, name, unit, cost, quantity) VALUES (44, ?, NULL, 50, 5)').run('Azúcar');
    ctx.queries.transferWarehouseLocal({ warehouse_item_id: 44, quantity: 2 });

    const row = ctx.queries.getDayStock().products.find((r) => r.id === product.id);
    assert.equal(row.entries_stock, 2, 'la mercancía recibida del almacén es entrada del día');
  } finally { ctx.close(); }
});

test('owner sync persists the canonical day stock response', async () => {
  const apiPath = require.resolve('../src/sync/apiClient');
  const calls = [];
  require.cache[apiPath] = {
    id: apiPath, filename: apiPath, loaded: true,
    exports: {
      API_BASE: 'http://servidor-falso',
      apiRequest: async (_method, path) => {
        calls.push(path);
        if (path === '/api/products') return { ok: true, status: 200, data: [] };
        if (path === '/api/warehouse') return { ok: true, status: 200, data: [] };
        if (path.startsWith('/api/sync/delta')) return { ok: true, status: 200, data: {
          sales: [], cash_closes: [], inventory_counts: [], cursors: { sale: 0, close: 0, count: 0 }, has_more: false,
        } };
        if (path === '/api/products/day-stock') return { ok: true, status: 200, data: {
          date: businessToday(), products: [],
        } };
        if (path === '/api/auth/me') return { ok: true, status: 200, data: { user: {} } };
        return { ok: false, status: 404, data: null };
      },
    },
  };
  const { syncOnce } = require('../src/sync/syncWorker');
  const ctx = startLocalDb();
  try {
    setOwner(ctx.queries);
    const result = await syncOnce();
    assert.equal(result.dayStockRefreshed, true);
    assert.ok(calls.includes('/api/products/day-stock'));
    assert.deepEqual(JSON.parse(ctx.queries.getSyncState('daily_stock_snapshot')), {
      date: businessToday(), products: [],
    });
  } finally { ctx.close(); }
});
