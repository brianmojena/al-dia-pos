const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb, crearProductoSincronizado, outboxDe } = require('./helpers');
const { buildRequest } = require('../src/sync/syncWorker');
const { routeRequest } = require('../src/router');

/**
 * El catálogo baja del servidor a la caja. Decisiones del negocio que fijan
 * estos tests:
 *   - lo que carga el dueño en la web llega a la caja;
 *   - nunca se pierde una venta hecha sin internet que todavía no subió;
 *   - un empleado da de alta productos nuevos pero no toca los existentes;
 *   - si se crea uno que ya existe, se une con el existente.
 */

const colaSincronizada = (db) => db.prepare(`UPDATE outbox SET status = 'synced'`).run();
const fila = (db, id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);

// Cómo devolvería el servidor un producto que en la caja tiene server_id 1000 + id
// (ver crearProductoSincronizado).
const delServidor = (local, cambios = {}) => ({
  id: 1000 + local.id,
  name: local.name,
  purchase_price: local.purchase_price,
  sale_price: local.sale_price,
  stock: local.stock,
  created_at: '2026-09-14 10:00:00',
  ...cambios,
});

const conCaja = async (fn) => {
  const ctx = startLocalDb();
  try { await fn(ctx); } finally { ctx.close(); }
};

test('el catálogo baja del servidor a la caja', async (t) => {
  await t.test('una caja nueva recibe el catálogo completo', () => conCaja(({ queries }) => {
    const stats = queries.applyServerCatalog([
      { id: 1, name: 'Arroz (1 lb)', purchase_price: 90, sale_price: 130, stock: 50 },
      { id: 2, name: 'Aceite', purchase_price: 750, sale_price: 990, stock: 20 },
      { id: 3, name: 'Sal', purchase_price: 0, sale_price: 40, stock: 0 },
    ]);

    assert.equal(stats.created, 3);
    assert.equal(stats.changed, true);
    const productos = queries.listProducts();
    assert.equal(productos.length, 3);
    assert.ok(productos.every((p) => p.server_id != null), 'quedan enlazados al servidor');
  }));

  await t.test('un precio cambiado en la web llega a la caja', () => conCaja(({ db, queries }) => {
    const arroz = crearProductoSincronizado(queries, { name: 'Arroz', stock: 40, sale_price: 130 });
    colaSincronizada(db);

    const stats = queries.applyServerCatalog([delServidor(arroz, { sale_price: 150 })]);

    assert.equal(stats.updated, 1);
    assert.equal(fila(db, arroz.id).sale_price, 150);
  }));

  await t.test('un producto nuevo cargado en la web aparece en la caja', () => conCaja(({ db, queries }) => {
    const arroz = crearProductoSincronizado(queries, { name: 'Arroz' });
    colaSincronizada(db);

    queries.applyServerCatalog([
      delServidor(arroz),
      { id: 77, name: 'Ron Havana Club 7', purchase_price: 2100, sale_price: 2800, stock: 12 },
    ]);

    assert.deepEqual(queries.listProducts().map((p) => p.name).sort(), ['Arroz', 'Ron Havana Club 7']);
  }));

  await t.test('no pisa una venta hecha sin internet que todavía no subió', () => conCaja(({ db, queries }) => {
    const cafe = crearProductoSincronizado(queries, { name: 'Café', stock: 10, sale_price: 100 });
    colaSincronizada(db);

    // Sin internet: se venden 2. La caja queda en 8; el servidor aún no lo sabe.
    queries.createSaleLocal({ items: [{ product_id: cafe.id, quantity: 2, unit_price: 100 }] });
    assert.equal(fila(db, cafe.id).stock, 8);

    const primera = queries.applyServerCatalog([delServidor(cafe, { stock: 10, sale_price: 150 })]);
    assert.equal(primera.skipped, 1);
    assert.equal(fila(db, cafe.id).stock, 8, 'la venta local sigue descontada');

    // La venta sube; el servidor ya la incluye y la próxima pasada actualiza todo.
    colaSincronizada(db);
    queries.applyServerCatalog([delServidor(cafe, { stock: 8, sale_price: 150 })]);
    assert.equal(fila(db, cafe.id).stock, 8);
    assert.equal(fila(db, cafe.id).sale_price, 150, 'y el precio nuevo llega en cuanto no hay nada pendiente');
  }));

  await t.test('una operación que el servidor rechazó no bloquea el producto para siempre', () => conCaja(({ db, queries }) => {
    const leche = crearProductoSincronizado(queries, { name: 'Leche', stock: 10 });
    colaSincronizada(db);
    queries.createSaleLocal({ items: [{ product_id: leche.id, quantity: 3, unit_price: 100 }] });
    db.prepare(`UPDATE outbox SET status = 'conflict' WHERE op_type = 'sale.create'`).run();

    queries.applyServerCatalog([delServidor(leche, { stock: 10 })]);
    assert.equal(fila(db, leche.id).stock, 10, 'rechazada en el servidor: manda el stock de allá');
  }));

  await t.test('un producto borrado en la web desaparece de la caja', () => conCaja(({ db, queries }) => {
    const pan = crearProductoSincronizado(queries, { name: 'Pan' });
    const sal = crearProductoSincronizado(queries, { name: 'Sal' });
    colaSincronizada(db);

    const stats = queries.applyServerCatalog([delServidor(pan)]);

    assert.equal(stats.removed, 1);
    assert.deepEqual(queries.listProducts().map((p) => p.name), ['Pan']);
    assert.equal(fila(db, sal.id).deleted, 1, 'se oculta, no se borra: las ventas viejas lo siguen referenciando');
  }));

  await t.test('si el servidor devuelve la lista vacía no se borra nada', () => conCaja(({ db, queries }) => {
    crearProductoSincronizado(queries, { name: 'Pan' });
    crearProductoSincronizado(queries, { name: 'Sal' });
    colaSincronizada(db);

    const stats = queries.applyServerCatalog([]);
    assert.equal(stats.removed, 0);
    assert.equal(queries.listProducts().length, 2);
  }));

  await t.test('un producto creado en la caja que aún no subió no se toca', () => conCaja(({ db, queries }) => {
    const pan = crearProductoSincronizado(queries, { name: 'Pan' });
    colaSincronizada(db);
    queries.createProduct({ name: 'Galletas María', sale_price: 250, stock: 24 });

    queries.applyServerCatalog([delServidor(pan)]);
    assert.deepEqual(queries.listProducts().map((p) => p.name).sort(), ['Galletas María', 'Pan']);
  }));

  await t.test('la caja no deja crear un producto que ya tiene', () => conCaja(({ queries }) => {
    queries.createProduct({ name: 'Arroz (1 lb)', sale_price: 130, stock: 10 });
    assert.throws(
      () => queries.createProduct({ name: '  ARROZ   (1 lb) ', sale_price: 90, stock: 5 }),
      (err) => err.code === 'DUPLICATE_NAME' && /Ya existe «Arroz \(1 lb\)»/.test(err.message)
    );
    assert.equal(queries.listProducts().length, 1);
  }));

  await t.test('si el servidor lo une con uno que ya existe, la caja no muestra dos', () => conCaja(({ db, queries }) => {
    // Sin internet, la cajera crea "pan"; mientras, el dueño cargó "Pan" en la web.
    const local = queries.createProduct({ name: 'pan', sale_price: 50, stock: 5 });
    // Llega el catálogo (con el "Pan" del dueño) antes de que suba el alta local.
    queries.applyServerCatalog([{ id: 555, name: 'Pan', purchase_price: 30, sale_price: 60, stock: 20 }]);
    assert.equal(queries.listProducts().length, 2, 'por un momento conviven');

    // Sube el alta; el servidor la une y devuelve el existente.
    const alta = outboxDe('product.create')[0];
    buildRequest(db, alta).onSuccess({ id: 555, name: 'Pan', merged: true });

    const visibles = queries.listProducts();
    assert.equal(visibles.length, 1);
    assert.equal(visibles[0].name, 'Pan', 'queda el del dueño');
    assert.equal(fila(db, local.id).server_id, 555, 'la copia oculta conserva el enlace para sus ventas');
  }));

  await t.test('editar solo el precio no reenvía el stock', () => conCaja(({ db, queries }) => {
    const aceite = crearProductoSincronizado(queries, { name: 'Aceite', stock: 20, sale_price: 990, purchase_price: 750 });
    colaSincronizada(db);

    // El formulario manda todos los campos, aunque solo cambió el precio.
    queries.updateProduct(aceite.id, { name: 'Aceite', purchase_price: 750, sale_price: 1000, stock: 20 });

    const [op] = outboxDe('product.update');
    const payload = JSON.parse(op.payload);
    assert.equal(payload.sale_price, 1000);
    assert.ok(!('stock' in payload), 'si viajara, pisaría las ventas que entraron en el servidor mientras tanto');
  }));

  await t.test('guardar sin cambios no encola nada', () => conCaja(({ db, queries }) => {
    const sal = crearProductoSincronizado(queries, { name: 'Sal', stock: 5, sale_price: 40, purchase_price: 20 });
    colaSincronizada(db);
    queries.updateProduct(sal.id, { name: 'Sal', purchase_price: 20, sale_price: 40, stock: 5 });
    assert.equal(outboxDe('product.update').length, 0);
  }));

  await t.test('una operación que quedó a medio subir se vuelve a intentar', () => conCaja(({ db, queries }) => {
    queries.createProduct({ name: 'Ron', sale_price: 500, stock: 3 });
    db.prepare(`UPDATE outbox SET status = 'syncing'`).run();

    assert.equal(queries.resetStuckSyncing(), 1);
    assert.equal(outboxDe('product.create')[0].status, 'pending');
  }));

  await t.test('un empleado da de alta productos pero no toca los existentes', () => conCaja(async ({ db, queries }) => {
    // La sesión de prueba es de una cajera (ver helpers.js).
    const ron = crearProductoSincronizado(queries, { name: 'Ron', stock: 10, sale_price: 500 });

    const editar = await routeRequest('PUT', `/api/products/${ron.id}`, { sale_price: 1 });
    assert.equal(editar.status, 403);
    const borrar = await routeRequest('DELETE', `/api/products/${ron.id}`);
    assert.equal(borrar.status, 403);
    assert.equal(fila(db, ron.id).sale_price, 500);
    assert.equal(fila(db, ron.id).deleted, 0);

    const alta = await routeRequest('POST', '/api/products', { name: 'Galletas', sale_price: 250, stock: 24 });
    assert.equal(alta.status, 201);

    const repetido = await routeRequest('POST', '/api/products', { name: 'GALLETAS', sale_price: 1, stock: 1 });
    assert.equal(repetido.status, 409);
    assert.match(repetido.data.error, /Ya existe «Galletas»/);
  }));
});
