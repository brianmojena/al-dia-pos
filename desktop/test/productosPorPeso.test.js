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
    const queso = queries.createProduct({ name: 'Queso', sale_price: 400, purchase_price: 300, stock: 12.5, unit: 'lb', track_stock: true });
    assert.equal(queso.unit, 'lb');
    assert.equal(queso.track_stock, 1);
    assert.equal(fila(db, queso.id).stock, 12.5);

    const [op] = outboxDe('product.create');
    assert.equal(JSON.parse(op.payload).unit, 'lb');
    const req = buildRequest(db, op);
    assert.equal(req.body.unit, 'lb');
    assert.equal(req.body.stock, 12.5);
    assert.equal(req.body.track_stock, 1);
  }));

  await t.test('un producto por unidad guarda unit NULL', () => conCaja(({ queries }) => {
    const sal = queries.createProduct({ name: 'Sal', sale_price: 40, stock: 3 });
    assert.equal(sal.unit, null);
    assert.equal(sal.track_stock, 1);
  }));

  await t.test('rechaza una unidad desconocida y un stock decimal sin unidad', () => conCaja(({ queries }) => {
    assert.throws(() => queries.createProduct({ name: 'X', sale_price: 1, stock: 1, unit: 'litro' }), /unidad/);
    assert.throws(() => queries.createProduct({ name: 'Y', sale_price: 1, stock: 1.5 }), /entero/);
    assert.equal(queries.listProducts().length, 0);
  }));

  await t.test('vender 2.35 lb descuenta el stock y calcula el total a centavos', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 12.5, sale_price: 400, purchase_price: 300, unit: 'lb', track_stock: true });

    const venta = queries.createSaleLocal({ items: [{ product_id: queso.id, quantity: 2.35, unit_price: 400 }] });

    assert.equal(venta.total, 940);        // 2.35 × 400
    assert.equal(venta.profit, 235);       // 2.35 × (400 − 300)
    assert.equal(fila(db, queso.id).stock, 10.15);
    const [item] = queries.getSale(venta.id).items;
    assert.equal(item.quantity, 2.35);
    assert.equal(JSON.parse(outboxDe('sale.create')[0].payload).items[0].quantity, 2.35);
  }));

  await t.test('el total suma líneas redondeadas a centavos', () => conCaja(({ db, queries }) => {
    const cafe = crearProductoSincronizado(queries, { name: 'Café', stock: 5, sale_price: 3.33, purchase_price: 0, unit: 'kg', track_stock: true });

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

  await t.test('un producto por peso con control no bloquea: vender de más lo deja en 0', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 1.2, sale_price: 400, unit: 'lb', track_stock: true });
    const venta = queries.createSaleLocal({ items: [{ product_id: queso.id, quantity: 1.25, unit_price: 400 }] });
    assert.equal(venta.total, 500);
    assert.equal(fila(db, queso.id).stock, 0);
  }));

  await t.test('un producto sin unidad sí bloquea con stock insuficiente', () => conCaja(({ db, queries }) => {
    const sal = crearProductoSincronizado(queries, { name: 'Sal', stock: 2, sale_price: 40 });
    assert.throws(
      () => queries.createSaleLocal({ items: [{ product_id: sal.id, quantity: 3, unit_price: 40 }] }),
      (err) => err.code === 'NO_STOCK'
    );
    assert.equal(fila(db, sal.id).stock, 2);
  }));

  await t.test('un producto por peso sin control: alta con stock 0, vender no descuenta ni bloquea', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 8, sale_price: 400, unit: 'lb' });
    assert.equal(queso.track_stock, 0);       // con unit el default es sin control
    assert.equal(queso.stock, 0);             // y el stock enviado se ignora
    const venta = queries.createSaleLocal({ items: [{ product_id: queso.id, quantity: 5.5, unit_price: 400 }] });
    assert.equal(venta.total, 2200);
    assert.equal(fila(db, queso.id).stock, 0);
    assert.equal(JSON.parse(outboxDe('product.create')[0].payload).track_stock, 0);
  }));

  await t.test('un producto sin unidad siempre lleva control aunque pidan lo contrario', () => conCaja(({ queries }) => {
    const sal = queries.createProduct({ name: 'Sal', sale_price: 40, stock: 3, track_stock: false });
    assert.equal(sal.track_stock, 1);
    assert.equal(sal.stock, 3);
  }));

  await t.test('editar: track_stock undefined conserva el existente y un cambio viaja al servidor', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 5, sale_price: 400, unit: 'lb', track_stock: true });
    queries.updateProduct(queso.id, { sale_price: 450 });
    assert.equal(fila(db, queso.id).track_stock, 1);
    assert.deepEqual(JSON.parse(outboxDe('product.update')[0].payload), { local_product_id: queso.id, sale_price: 450 });

    queries.updateProduct(queso.id, { track_stock: false });
    assert.equal(fila(db, queso.id).track_stock, 0);
    const [, op] = outboxDe('product.update');
    assert.equal(buildRequest(db, op).body.track_stock, 0);
  }));

  await t.test('el conteo de inventario acepta decimales sólo en productos por peso', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 10, sale_price: 400, unit: 'lb', track_stock: true });
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

  await t.test('el conteo rechaza un producto por peso sin control de stock', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', sale_price: 400, unit: 'lb' });
    assert.throws(
      () => queries.createInventoryCountLocal({ items: [{ product_id: queso.id, counted: 3 }] }),
      (err) => err.code === 'NOT_COUNTABLE'
    );
    assert.equal(queries.listInventoryCounts().length, 0);
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
    assert.equal(queso.track_stock, 1);    // un servidor sin la opción = con control
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

  await t.test('el catálogo copia track_stock', () => conCaja(({ db, queries }) => {
    queries.applyServerCatalog([
      { id: 1, name: 'Queso', purchase_price: 300, sale_price: 400, stock: 0, unit: 'lb', track_stock: 0 },
      { id: 2, name: 'Sal', purchase_price: 10, sale_price: 40, stock: 7, unit: null, track_stock: 0 },
    ]);
    const queso = queries.listProducts().find((p) => p.name === 'Queso');
    const sal = queries.listProducts().find((p) => p.name === 'Sal');
    assert.equal(queso.track_stock, 0);
    assert.equal(sal.track_stock, 1);      // sin unit siempre se controla

    db.prepare(`UPDATE outbox SET status = 'synced'`).run();
    const stats = queries.applyServerCatalog([
      { id: 1, name: 'Queso', purchase_price: 300, sale_price: 400, stock: 4.5, unit: 'lb', track_stock: 1 },
      { id: 2, name: 'Sal', purchase_price: 10, sale_price: 40, stock: 7, unit: null, track_stock: 1 },
    ]);
    assert.equal(stats.updated, 1);
    assert.equal(fila(db, queso.id).track_stock, 1);
    assert.equal(fila(db, queso.id).stock, 4.5);
  }));

  await t.test('el sync no pisa el stock de un producto con ventas pendientes', () => conCaja(({ db, queries }) => {
    const queso = crearProductoSincronizado(queries, { name: 'Queso', stock: 10, sale_price: 400, unit: 'lb', track_stock: true });
    db.prepare(`UPDATE outbox SET status = 'synced'`).run();
    queries.createSaleLocal({ items: [{ product_id: queso.id, quantity: 2, unit_price: 400 }] });
    queries.applyServerCatalog([
      { id: queso.id + 1000, name: 'Queso', purchase_price: 60, sale_price: 400, stock: 10, unit: 'lb', track_stock: 1 },
    ]);
    assert.equal(fila(db, queso.id).stock, 8);
  }));

  await t.test('el dashboard cuenta stock bajo y valor del inventario con decimales', () => conCaja(({ db, queries }) => {
    crearProductoSincronizado(queries, { name: 'Queso', stock: 2.5, sale_price: 400, purchase_price: 300, unit: 'lb', track_stock: true });
    const d = queries.getDashboard();
    assert.equal(d.lowStock.length, 1);
    assert.equal(d.inventory.cost, 750);
    assert.equal(d.inventory.retail, 1000);
    assert.equal(d.inventory.units, 0);    // las unidades suman solo productos sin unit
  }));

  await t.test('el dashboard ignora los productos por peso sin control de stock', () => conCaja(({ queries }) => {
    crearProductoSincronizado(queries, { name: 'Queso', sale_price: 400, purchase_price: 300, unit: 'lb' });
    crearProductoSincronizado(queries, { name: 'Sal', stock: 4, sale_price: 40, purchase_price: 10 });
    const d = queries.getDashboard();
    assert.deepEqual(d.lowStock.map((p) => p.name), ['Sal']);
    assert.equal(d.inventory.cost, 40);
    assert.equal(d.inventory.retail, 160);
    assert.equal(d.inventory.units, 4);
  }));

  await t.test('el router acepta unit al crear y rechaza una unidad inválida con 400', () => conCaja(async () => {
    const ok = await routeRequest('POST', '/api/products', { name: 'Arroz', sale_price: 130, stock: 20.5, unit: 'lb' });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.unit, 'lb');
    const mal = await routeRequest('POST', '/api/products', { name: 'Frijol', sale_price: 130, stock: 1, unit: 'tonelada' });
    assert.equal(mal.status, 400);
  }));
});
