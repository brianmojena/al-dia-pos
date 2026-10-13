const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb, crearProductoSincronizado, outboxDe } = require('./helpers');
const { buildRequest } = require('../src/sync/syncWorker');
const { routeRequest } = require('../src/router');

/**
 * Productos fraccionados / vendidos por peso. Reglas que fijan estos tests:
 *   - un producto con unidad (kg, g, lb) tiene stock y ventas decimales, y su
 *     precio es por esa unidad;
 *   - un producto sin unidad sigue siendo entero, como siempre;
 *   - la unidad y los decimales viajan al servidor y vuelven del catálogo.
 */

const fila = (db, id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);

const conCaja = async (fn) => {
  const ctx = startLocalDb();
  try { await fn(ctx); } finally { ctx.close(); }
};

test('productos vendidos por peso', async (t) => {
  await t.test('se crea un producto en libras con stock decimal y la unidad viaja al servidor', () => conCaja(({ db, queries }) => {
    const queso = queries.createProduct({ name: 'Queso', sale_price: 400, purchase_price: 300, stock: 12.5, unit: 'lb' });
    assert.equal(queso.unit, 'lb');
    assert.equal(fila(db, queso.id).stock, 12.5);

    const [op] = outboxDe('product.create');
    assert.equal(JSON.parse(op.payload).unit, 'lb');
    const req = buildRequest(db, op);
    assert.equal(req.body.unit, 'lb');
    assert.equal(req.body.stock, 12.5);
  }));

  await t.test('un producto por unidad guarda unit NULL', () => conCaja(({ queries }) => {
    const sal = queries.createProduct({ name: 'Sal', sale_price: 40, stock: 3 });
    assert.equal(sal.unit, null);
  }));

  await t.test('rechaza una unidad desconocida y un stock decimal sin unidad', () => conCaja(({ queries }) => {
    assert.throws(() => queries.createProduct({ name: 'X', sale_price: 1, stock: 1, unit: 'litro' }), /unidad/);
    assert.throws(() => queries.createProduct({ name: 'Y', sale_price: 1, stock: 1.5 }), /entero/);
    assert.equal(queries.listProducts().length, 0);
  }));

  await t.test('vender 2.35 lb descuenta el stock y calcula el total a centavos', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 12.5, sale_price: 400, purchase_price: 300, unit: 'lb' });

    const venta = queries.createSaleLocal({ items: [{ product_id: queso.id, quantity: 2.35, unit_price: 400 }] });

    assert.equal(venta.total, 940);        // 2.35 × 400
    assert.equal(venta.profit, 235);       // 2.35 × (400 − 300)
    assert.equal(fila(db, queso.id).stock, 10.15);
    const [item] = queries.getSale(venta.id).items;
    assert.equal(item.quantity, 2.35);
    assert.equal(JSON.parse(outboxDe('sale.create')[0].payload).items[0].quantity, 2.35);
  }));

  await t.test('el total suma líneas redondeadas a centavos', () => conCaja(({ db, queries }) => {
    const cafe = crearProductoSincronizado(queries, { name: 'Café', stock: 5, sale_price: 3.33, purchase_price: 0, unit: 'kg' });

    // 0.333 kg × 3.33 = 1.10889 → 1.11 por línea; dos líneas del mismo producto no hacen 2.21778.
    const venta = queries.createSaleLocal({ items: [
      { product_id: cafe.id, quantity: 0.333, unit_price: 3.33 },
      { product_id: cafe.id, quantity: 0.333, unit_price: 3.33 },
    ] });
    assert.equal(venta.total, 2.22);
    assert.equal(fila(db, cafe.id).stock, 4.334);
  }));

  await t.test('una cantidad decimal en un producto sin unidad se rechaza y no toca nada', () => conCaja(({ db, queries }) => {
    const sal = crearProductoSincronizado(queries, { name: 'Sal', stock: 10, sale_price: 40 });
    assert.throws(
      () => queries.createSaleLocal({ items: [{ product_id: sal.id, quantity: 1.5, unit_price: 40 }] }),
      (err) => err.code === 'BAD_QUANTITY'
    );
    assert.equal(fila(db, sal.id).stock, 10);
    assert.equal(queries.listSales().length, 0);

    const res = routeRequest('POST', '/api/sales', { items: [{ product_id: sal.id, quantity: 0.5, unit_price: 40 }] });
    return Promise.resolve(res).then((r) => assert.equal(r.status, 400));
  }));

  await t.test('no se vende más peso del que hay', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 1.2, sale_price: 400, unit: 'lb' });
    assert.throws(
      () => queries.createSaleLocal({ items: [{ product_id: queso.id, quantity: 1.25, unit_price: 400 }] }),
      (err) => err.code === 'NO_STOCK'
    );
    assert.equal(fila(db, queso.id).stock, 1.2);
  }));

  await t.test('el conteo de inventario acepta decimales sólo en productos por peso', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 10, sale_price: 400, unit: 'lb' });
    const sal = crearProductoSincronizado(queries, { name: 'Sal', stock: 10, sale_price: 40 });

    assert.throws(
      () => queries.createInventoryCountLocal({ items: [{ product_id: sal.id, counted: 9.5 }] }),
      (err) => err.code === 'BAD_COUNT'
    );

    const conteo = queries.createInventoryCountLocal({ items: [{ product_id: queso.id, counted: 9.25 }] });
    assert.equal(fila(db, queso.id).stock, 9.25);
    assert.equal(conteo.units_missing, 0.75);
    assert.equal(conteo.value_missing, 300);
    assert.equal(conteo.items[0].difference, -0.75);
  }));

  await t.test('editar la unidad se encola; pasar a "por unidad" con decimales se rechaza', () => conCaja(({ db, queries }) => {
    const sal = crearProductoSincronizado(queries, { name: 'Sal', stock: 10, sale_price: 40 });
    queries.updateProduct(sal.id, { unit: 'kg', stock: 10.5 });
    assert.equal(fila(db, sal.id).unit, 'kg');
    assert.deepEqual(JSON.parse(outboxDe('product.update')[0].payload), { local_product_id: sal.id, unit: 'kg', stock: 10.5 });
    assert.equal(buildRequest(db, outboxDe('product.update')[0]).body.unit, 'kg');

    assert.throws(() => queries.updateProduct(sal.id, { unit: null }), /entero/);
    assert.equal(fila(db, sal.id).unit, 'kg');
  }));

  await t.test('el catálogo del servidor conserva decimales y unit', () => conCaja(({ db, queries }) => {
    queries.applyServerCatalog([
      { id: 1, name: 'Queso', purchase_price: 300, sale_price: 400, stock: 12.5, unit: 'lb' },
      { id: 2, name: 'Sal', purchase_price: 10, sale_price: 40, stock: 7.9, unit: null },
    ]);
    const queso = queries.listProducts().find((p) => p.name === 'Queso');
    const sal = queries.listProducts().find((p) => p.name === 'Sal');
    assert.equal(queso.stock, 12.5);
    assert.equal(queso.unit, 'lb');
    assert.equal(sal.stock, 7);          // sin unit sigue entero
    assert.equal(sal.unit, null);

    // Un cambio posterior sólo de decimales o de unidad también baja.
    db.prepare(`UPDATE outbox SET status = 'synced'`).run();
    const stats = queries.applyServerCatalog([
      { id: 1, name: 'Queso', purchase_price: 300, sale_price: 400, stock: 10.15, unit: 'lb' },
      { id: 2, name: 'Sal', purchase_price: 10, sale_price: 40, stock: 7, unit: 'kg' },
    ]);
    assert.equal(stats.updated, 2);
    assert.equal(fila(db, queso.id).stock, 10.15);
    assert.equal(fila(db, sal.id).unit, 'kg');
  }));

  await t.test('el dashboard cuenta stock bajo y valor del inventario con decimales', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 2.5, sale_price: 400, purchase_price: 300, unit: 'lb' });
    const d = queries.getDashboard();
    assert.equal(d.lowStock.length, 1);
    assert.equal(d.inventory.cost, 750);
    assert.equal(d.inventory.retail, 1000);
    assert.equal(d.inventory.units, 2.5);
  }));

  await t.test('el router acepta unit al crear y rechaza una unidad inválida con 400', () => conCaja(async () => {
    const ok = await routeRequest('POST', '/api/products', { name: 'Arroz', sale_price: 130, stock: 20.5, unit: 'lb' });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.unit, 'lb');
    const mal = await routeRequest('POST', '/api/products', { name: 'Frijol', sale_price: 130, stock: 1, unit: 'tonelada' });
    assert.equal(mal.status, 400);
  }));
});
