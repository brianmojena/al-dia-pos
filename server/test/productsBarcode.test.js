const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

/**
 * Código de barras del fabricante (leído con la cámara al dar de alta un
 * producto). Reglas del negocio: un código pertenece a UN producto por tienda
 * (colisión → 409 con el nombre del rival); un producto sin código no compite;
 * re-registrar con el escáner un producto que ya existe por nombre le asigna
 * el código si no lo tenía; el código es un dato interno que NUNCA sale por el
 * catálogo público; y viaja igual por la sincronización offline.
 */

const crear = (api, token, body) => api('POST', '/api/products', { token, body });
const catalogo = async (api, token) => (await api('GET', '/api/products', { token })).body;

test('código de barras de productos', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('el alta guarda el código y lo devuelve normalizado', async () => {
    const dueño = await registerUser(ctx.api);
    const res = await crear(ctx.api, dueño, {
      name: 'Cepillo dental', sale_price: 150, purchase_price: 100, stock: 5, barcode: '  7501234567895  ',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.barcode, '7501234567895');

    const fila = await ctx.db.execute({ sql: 'SELECT barcode FROM products WHERE id = ?', args: [res.body.id] });
    assert.equal(fila.rows[0].barcode, '7501234567895');
  });

  await t.test('sin código o vacío se guarda como NULL', async () => {
    const dueño = await registerUser(ctx.api);
    const sin = await crear(ctx.api, dueño, { name: 'Manzanas', sale_price: 80, stock: 12 });
    const vacio = await crear(ctx.api, dueño, { name: 'Peras', sale_price: 80, stock: 12, barcode: '' });

    assert.equal(sin.status, 201);
    assert.equal(vacio.status, 201);
    const filas = await ctx.db.execute({ sql: 'SELECT barcode FROM products WHERE id IN (?, ?)', args: [sin.body.id, vacio.body.id] });
    for (const fila of filas.rows) assert.equal(fila.barcode, null);
  });

  await t.test('rechaza códigos ilegibles', async () => {
    const dueño = await registerUser(ctx.api);
    assert.equal((await crear(ctx.api, dueño, { name: 'A', sale_price: 1, barcode: 12345 })).status, 400, 'número, no texto');
    assert.equal((await crear(ctx.api, dueño, { name: 'B', sale_price: 1, barcode: 'x'.repeat(65) })).status, 400, 'demasiado largo');
    assert.equal((await catalogo(ctx.api, dueño)).length, 0);
  });

  await t.test('un código que ya pertenece a otro producto da 409 con su nombre', async () => {
    const dueño = await registerUser(ctx.api);
    await crear(ctx.api, dueño, { name: 'Fideos', sale_price: 200, stock: 10, barcode: '7790012345678' });

    const res = await crear(ctx.api, dueño, { name: 'Sopa', sale_price: 150, stock: 3, barcode: '7790012345678' });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /Fideos/, 'el mensaje nombra al dueño del código');
    assert.equal((await catalogo(ctx.api, dueño)).length, 1, 'no se creó el segundo');
  });

  await t.test('el mismo código en otra tienda es válido', async () => {
    const tiendaA = await registerUser(ctx.api);
    const tiendaB = await registerUser(ctx.api);
    await crear(ctx.api, tiendaA, { name: 'Fideos', sale_price: 200, barcode: '7790012345678' });

    const res = await crear(ctx.api, tiendaB, { name: 'Sopa', sale_price: 150, barcode: '7790012345678' });
    assert.equal(res.status, 201);
  });

  await t.test('re-registrar por nombre le asigna el código al existente', async () => {
    const dueño = await registerUser(ctx.api);
    const original = await createProduct(ctx.api, dueño, { name: 'Arroz (1 lb)', stock: 40, sale_price: 130 });

    const res = await crear(ctx.api, dueño, {
      name: '  arroz   (1 LB) ', sale_price: 90, stock: 999, barcode: '7501234567895',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.merged, true);
    assert.equal(Number(res.body.id), original);
    assert.equal(res.body.barcode, '7501234567895', 'la respuesta ya lleva el código asignado');
    assert.equal(Number(res.body.sale_price), 130, 'el precio del existente manda');

    const productos = await catalogo(ctx.api, dueño);
    assert.equal(productos.length, 1);
    assert.equal(productos[0].barcode, '7501234567895');
  });

  await t.test('el dueño asigna, cambia y quita el código por PUT', async () => {
    const dueño = await registerUser(ctx.api);
    const id = await createProduct(ctx.api, dueño, { name: 'Jabón', sale_price: 90 });

    const asignar = await ctx.api('PUT', `/api/products/${id}`, { token: dueño, body: { barcode: '7509998887776' } });
    assert.equal(asignar.status, 200);
    assert.equal(asignar.body.barcode, '7509998887776');

    const quitar = await ctx.api('PUT', `/api/products/${id}`, { token: dueño, body: { barcode: '' } });
    assert.equal(quitar.status, 200);
    assert.equal(quitar.body.barcode, null);
  });

  await t.test('el cajero no puede cambiar el código de un producto existente', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await createCashier(ctx.api, dueño, {});
    const id = await createProduct(ctx.api, dueño, { name: 'Jabón', sale_price: 90 });

    const res = await ctx.api('PUT', `/api/products/${id}`, { token: cajero.token, body: { barcode: '7509998887776' } });
    assert.equal(res.status, 403);

    const productos = await catalogo(ctx.api, dueño);
    assert.equal(productos[0].barcode, null);
  });

  await t.test('PUT con el código de otro producto da 409', async () => {
    const dueño = await registerUser(ctx.api);
    await crear(ctx.api, dueño, { name: 'Fideos', sale_price: 200, barcode: '7790012345678' });
    const otro = await createProduct(ctx.api, dueño, { name: 'Sopa', sale_price: 150 });

    const res = await ctx.api('PUT', `/api/products/${otro}`, { token: dueño, body: { barcode: '7790012345678' } });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /Fideos/);
  });

  await t.test('la sincronización offline da de alta con código', async () => {
    const dueño = await registerUser(ctx.api);

    const res = await ctx.api('POST', '/api/sync/product-operation', {
      token: dueño,
      body: {
        operation_id: 'op-alta-codigo-1',
        method: 'POST',
        product: { name: 'Detergente', sale_price: 300, purchase_price: 220, stock: 8, barcode: '7501234500015' },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.barcode, '7501234500015');
    const fila = await ctx.db.execute({ sql: 'SELECT barcode FROM products WHERE id = ?', args: [res.body.id] });
    assert.equal(fila.rows[0].barcode, '7501234500015');
  });

  await t.test('la sync aplica la edición del código y detecta el conflicto por expected', async () => {
    const dueño = await registerUser(ctx.api);
    const id = await createProduct(ctx.api, dueño, { name: 'Cloro', sale_price: 180, stock: 6, purchase_price: 0 });

    const ok = await ctx.api('POST', '/api/sync/product-operation', {
      token: dueño,
      body: {
        operation_id: 'op-put-codigo-1',
        method: 'PUT',
        product_id: id,
        product: { name: 'Cloro', purchase_price: 0, sale_price: 180, stock: 6, unit: null, track_stock: 1, barcode: '7505550003339' },
        expected: { name: 'Cloro', sale_price: 180, purchase_price: 0, stock: 6, unit: null, barcode: null },
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.barcode, '7505550003339');

    const conflicto = await ctx.api('POST', '/api/sync/product-operation', {
      token: dueño,
      body: {
        operation_id: 'op-put-codigo-2',
        method: 'PUT',
        product_id: id,
        product: { name: 'Cloro', purchase_price: 0, sale_price: 180, stock: 6, unit: null, track_stock: 1, barcode: '7505550004440' },
        expected: { name: 'Cloro', sale_price: 180, purchase_price: 0, stock: 6, unit: null, barcode: 'OTRO' },
      },
    });
    assert.equal(conflicto.status, 409, 'el expected del código no coincide');
  });

  await t.test('una operación antigua sin barcode en expected no choca', async () => {
    const dueño = await registerUser(ctx.api);
    const id = await createProduct(ctx.api, dueño, { name: 'Cloro', sale_price: 180, stock: 6, purchase_price: 0 });
    await ctx.api('PUT', `/api/products/${id}`, { token: dueño, body: { barcode: '7505550003339' } });

    const res = await ctx.api('POST', '/api/sync/product-operation', {
      token: dueño,
      body: {
        operation_id: 'op-vieja-1',
        method: 'PUT',
        product_id: id,
        product: { name: 'Cloro', purchase_price: 0, sale_price: 200, stock: 6, unit: null, track_stock: 1 },
        expected: { name: 'Cloro', sale_price: 180, purchase_price: 0, stock: 6, unit: null },
      },
    });

    assert.equal(res.status, 200, 'sin barcode en expected, el código no se compara');
    assert.equal(res.body.barcode, '7505550003339', 'y sin barcode en el payload, el código no se toca');
  });

  await t.test('el catálogo público nunca expone el código', async () => {
    const dueño = await registerUser(ctx.api);
    await crear(ctx.api, dueño, {
      name: 'Cepillo dental', sale_price: 150, stock: 5, barcode: '7501234567895', catalog_visible: 1,
    });
    await ctx.api('PUT', '/api/catalog', { token: dueño, body: { catalog_enabled: true } });
    const { body } = await ctx.api('GET', '/api/catalog', { token: dueño });
    assert.ok(body.catalog_slug, 'el catálogo quedó activado con su slug');

    const publico = await ctx.api('GET', `/api/public/catalog/${body.catalog_slug}`);
    assert.equal(publico.status, 200);
    assert.equal(publico.body.products.length, 1);
    assert.equal('barcode' in publico.body.products[0], false, 'el código no sale al público');
  });
});
