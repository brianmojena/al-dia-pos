const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb, crearProductoSincronizado, outboxDe } = require('./helpers');
const { buildRequest } = require('../src/sync/syncWorker');

/**
 * Mercancía recibida: se suma al stock como cantidad (no como total), queda en
 * el registro de entradas y la importación puede sumar o reemplazar el stock.
 */
const conCaja = async (fn) => {
  const ctx = startLocalDb();
  try { await fn(ctx); } finally { ctx.close(); }
};

test('entradas de stock', async (t) => {
  await t.test('add_stock suma, viaja como cantidad y deja registro', () => conCaja(({ db, queries }) => {
    const p = crearProductoSincronizado(queries, { name: 'Arroz', sale_price: 10, stock: 5 });
    const out = queries.updateProduct(p.id, { add_stock: 3 });
    assert.equal(out.stock, 8);
    const op = outboxDe('product.update').pop();
    const body = buildRequest(db, op).body;
    assert.equal(body.add_stock, 3);
    assert.equal(body.stock, undefined);
    const [e] = queries.listStockEntries();
    assert.deepEqual([e.product_name, e.quantity, e.stock_before, e.stock_after], ['Arroz', 3, 5, 8]);
  }));

  await t.test('cantidad inválida se rechaza', () => conCaja(({ queries }) => {
    const p = queries.createProduct({ name: 'Sal', sale_price: 10, stock: 5 });
    assert.throws(() => queries.updateProduct(p.id, { add_stock: 1.5 }));
    assert.throws(() => queries.updateProduct(p.id, { add_stock: 0 }));
  }));

  await t.test('importación: sumar vs reemplazar', () => conCaja(({ queries }) => {
    queries.createProduct({ name: 'Café', sale_price: 10, stock: 4 });
    queries.importProducts([{ name: 'café', sale_price: 10, stock: 6 }], 'sumar');
    assert.equal(queries.listProducts().find((p) => p.name === 'Café').stock, 10);
    queries.importProducts([{ name: 'Café', sale_price: 10, stock: 2 }], 'reemplazar');
    assert.equal(queries.listProducts().find((p) => p.name === 'Café').stock, 2);
  }));
});
