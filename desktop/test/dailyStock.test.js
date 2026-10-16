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
      { id: product.id, opening_stock: 7, current_stock: 10, tracked: true },
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
