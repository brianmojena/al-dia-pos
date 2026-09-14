const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * La carga masiva es lo primero que se hace en una tienda nueva. Tiene que
 * aguantar volver a subir la lista corregida sin duplicar, y no dejar nunca
 * el catálogo a medias.
 */

const importar = (api, token, items) =>
  api('POST', '/api/products/import', { token, body: { items } });

const catalogo = async (api, token) =>
  (await api('GET', '/api/products', { token })).body;

test('importación masiva de productos', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('crea todos los productos de la lista', async () => {
    const token = await registerUser(ctx.api);
    const res = await importar(ctx.api, token, [
      { name: 'Arroz (1 lb)', sale_price: 130, purchase_price: 90, stock: 50 },
      { name: 'Aceite vegetal', sale_price: 990, purchase_price: 750, stock: 20 },
      { name: 'Sal', sale_price: 40, purchase_price: null, stock: null },
    ]);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { created: 3, updated: 0, total: 3 });

    const productos = await catalogo(ctx.api, token);
    const sal = productos.find((p) => p.name === 'Sal');
    assert.equal(productos.length, 3);
    assert.equal(Number(sal.purchase_price), 0, 'sin precio de compra, un producto nuevo queda en 0');
    assert.equal(Number(sal.stock), 0);
  });

  await t.test('volver a subir la lista corregida actualiza en vez de duplicar', async () => {
    const token = await registerUser(ctx.api);
    await importar(ctx.api, token, [{ name: 'Azúcar (1 lb)', sale_price: 110, purchase_price: 80, stock: 40 }]);

    // Misma lista, con otro precio y escrita distinto (acentos, mayúsculas, espacios).
    const res = await importar(ctx.api, token, [{ name: '  azucar   (1 LB) ', sale_price: 120, purchase_price: null, stock: null }]);
    assert.deepEqual(res.body, { created: 0, updated: 1, total: 1 });

    const productos = await catalogo(ctx.api, token);
    assert.equal(productos.length, 1, 'no se duplicó');
    assert.equal(Number(productos[0].sale_price), 120, 'el precio nuevo entró');
    assert.equal(Number(productos[0].purchase_price), 80, 'costo vacío = no tocar el que había');
    assert.equal(Number(productos[0].stock), 40, 'stock vacío = no tocar el que había');
  });

  await t.test('actualiza productos que se cargaron a mano antes', async () => {
    const token = await registerUser(ctx.api);
    await createProduct(ctx.api, token, { name: 'Café Serrano', stock: 5, sale_price: 700, purchase_price: 500 });

    const res = await importar(ctx.api, token, [
      { name: 'cafe serrano', sale_price: 750, purchase_price: 520, stock: 12 },
      { name: 'Pan', sale_price: 50, purchase_price: 30, stock: 30 },
    ]);
    assert.deepEqual(res.body, { created: 1, updated: 1, total: 2 });

    const cafe = (await catalogo(ctx.api, token)).find((p) => p.name === 'cafe serrano');
    assert.equal(Number(cafe.stock), 12, 'el stock del archivo reemplaza al actual');
  });

  await t.test('una sola fila mala y no entra NADA', async () => {
    const token = await registerUser(ctx.api);
    const res = await importar(ctx.api, token, [
      { name: 'Arroz', sale_price: 130, stock: 50 },
      { name: 'Pan', sale_price: 'diez', stock: 10 },
      { name: '', sale_price: 20 },
    ]);

    assert.equal(res.status, 400);
    assert.equal(res.body.errors.length, 2);
    assert.equal(res.body.errors[0].index, 1, 'dice cuál fila, para poder corregirla');
    assert.equal((await catalogo(ctx.api, token)).length, 0, 'el catálogo no queda a medias');
  });

  await t.test('rechaza stock negativo, con decimales y nombres repetidos', async () => {
    const token = await registerUser(ctx.api);
    for (const [items, motivo] of [
      [[{ name: 'Leche', sale_price: 1000, stock: -1 }], 'stock negativo'],
      [[{ name: 'Leche', sale_price: 1000, stock: 2.5 }], 'stock con decimales'],
      [[{ name: 'Leche', sale_price: -5 }], 'precio negativo'],
      [[{ name: 'Leche', sale_price: 1000 }, { name: 'LECHE', sale_price: 900 }], 'repetido'],
    ]) {
      const res = await importar(ctx.api, token, items);
      assert.equal(res.status, 400, motivo);
    }
    assert.equal((await catalogo(ctx.api, token)).length, 0);
  });

  await t.test('un cajero no puede importar', async () => {
    const dueño = await registerUser(ctx.api);
    const email = `imp${Date.now()}@test.local`;
    await ctx.api('POST', '/api/auth/cashiers', { token: dueño, body: { email, password: 'caja1234' } });
    const cajero = (await ctx.api('POST', '/api/auth/login', { body: { email, password: 'caja1234' } })).body.token;

    const res = await importar(ctx.api, cajero, [{ name: 'Ron', sale_price: 1 }]);
    assert.equal(res.status, 403, 'cargar precios es del dueño');
  });

  await t.test('no toca el catálogo de otra tienda con productos del mismo nombre', async () => {
    const tiendaA = await registerUser(ctx.api);
    const tiendaB = await registerUser(ctx.api);
    await createProduct(ctx.api, tiendaA, { name: 'Arroz', stock: 10, sale_price: 130 });

    const res = await importar(ctx.api, tiendaB, [{ name: 'Arroz', sale_price: 999, stock: 1 }]);
    assert.deepEqual(res.body, { created: 1, updated: 0, total: 1 }, 'para B es un producto nuevo');

    const arrozA = (await catalogo(ctx.api, tiendaA))[0];
    assert.equal(Number(arrozA.sale_price), 130, 'el arroz de A sigue igual');
  });

  await t.test('aguanta una lista grande de una sola vez', async () => {
    const token = await registerUser(ctx.api);
    const items = Array.from({ length: 500 }, (_, i) => ({
      name: `Producto ${i + 1}`, sale_price: 100 + i, purchase_price: 50, stock: i % 30,
    }));
    const res = await importar(ctx.api, token, items);
    assert.deepEqual(res.body, { created: 500, updated: 0, total: 500 });
    assert.equal((await catalogo(ctx.api, token)).length, 500);
  });
});
