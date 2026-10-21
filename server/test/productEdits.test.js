const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

/**
 * Editar un producto no puede pisar el stock que movieron las ventas.
 *
 * Antes el PUT leía el producto fuera de la transacción y reescribía todas las
 * columnas: una venta cobrada entre la lectura y el UPDATE resucitaba el stock.
 * Además, una entrada de mercancía reintentada por pérdida de respuesta se
 * sumaba dos veces. Estas pruebas fijan las dos garantías.
 */

const precio = (api, token, productId, salePrice, extra = {}) =>
  api('PUT', `/api/products/${productId}`, {
    token,
    body: { sale_price: salePrice, ...extra },
  });

const stock = async (ctx, productId) => {
  const row = await ctx.db.execute({
    sql: 'SELECT stock FROM products WHERE id = ?',
    args: [productId],
  });
  return Number(row.rows[0].stock);
};

test('editar productos: el stock no resucita y las entradas no se duplican', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('editar solo el precio mientras se venden unidades no restaura el stock', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Refresco', stock: 100 });

    const ventas = Array.from({ length: 30 }, () =>
      ctx.api('POST', '/api/sales', {
        token,
        body: { items: [{ product_id: productId, quantity: 1, unit_price: 100 }] },
      })
    );
    const ediciones = Array.from({ length: 20 }, () => precio(ctx.api, token, productId, 250));

    const respuestas = await Promise.all([...ventas, ...ediciones]);
    const ventasCreadas = respuestas.slice(0, 30).filter((r) => r.status === 201);
    const edicionesOk = respuestas.slice(30).filter((r) => r.status === 200);

    assert.equal(ventasCreadas.length, 30, 'las 30 ventas deben registrarse');
    assert.equal(edicionesOk.length, 20, 'las 20 ediciones de precio deben aplicarse');
    assert.equal(await stock(ctx, productId), 70, '100 - 30 ventas: ninguna edición puede devolver stock');
  });

  await t.test('dos entradas simultáneas se suman las dos, sin pisarse', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Harina', stock: 10 });

    const [a, b] = await Promise.all([
      precio(ctx.api, token, productId, 100, { add_stock: 5 }),
      precio(ctx.api, token, productId, 100, { add_stock: 7 }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await stock(ctx, productId), 22, '10 + 5 + 7: la segunda entrada ve la primera ya aplicada');

    const entradas = (await ctx.db.execute({
      sql: "SELECT quantity, stock_before, stock_after FROM stock_entries WHERE product_id = ? AND kind = 'entrada' ORDER BY id ASC",
      args: [productId],
    })).rows.map((row) => ({
      quantity: Number(row.quantity),
      before: Number(row.stock_before),
      after: Number(row.stock_after),
    }));

    assert.equal(entradas.length, 2, 'cada entrada deja su propio registro');
    assert.equal(entradas[0].before, 10);
    assert.equal(entradas[1].before, entradas[0].after, 'la segunda entrada parte del stock que dejó la primera');
    assert.equal(entradas[1].after, 22);
    assert.equal(
      entradas.reduce((sum, e) => sum + e.quantity, 0),
      12,
      'la suma de cantidades registradas es la mercancía recibida'
    );
  });

  await t.test('reintentar la misma entrada no vuelve a sumar stock', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Café', stock: 10 });
    const operationId = randomUUID();

    const entrada = () =>
      precio(ctx.api, token, productId, 100, { add_stock: 5, operation_id: operationId });

    const [a, b] = await Promise.all([entrada(), entrada()]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await stock(ctx, productId), 15, 'el reintento devuelve el recibo, no suma otra vez');
    assert.equal(a.body.stock, b.body.stock, 'las dos respuestas describen el mismo estado');

    const recibos = await ctx.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM pwa_product_operations WHERE operation_id = ?',
      args: [operationId],
    });
    assert.equal(Number(recibos.rows[0].n), 1, 'se guarda un solo recibo por operación');
  });

  await t.test('el recibo viejo no se confunde con los cambios posteriores', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Aceite', stock: 10 });
    const operationId = randomUUID();

    const primera = await precio(ctx.api, token, productId, 100, { add_stock: 5, operation_id: operationId });
    assert.equal(primera.status, 200);
    assert.equal(await stock(ctx, productId), 15);

    const venta = await ctx.api('POST', '/api/sales', {
      token,
      body: { items: [{ product_id: productId, quantity: 3, unit_price: 100 }] },
    });
    assert.equal(venta.status, 201);
    assert.equal(await stock(ctx, productId), 12);

    const replay = await precio(ctx.api, token, productId, 999, { add_stock: 5, operation_id: operationId });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.stock, 15, 'la réplica devuelve el recibo original');
    assert.equal(await stock(ctx, productId), 12, 'pero no reaplica ni la entrada ni el precio viejo');
  });

  await t.test('el cajero puede mandar operation_id junto al precio y la entrada', async () => {
    const ownerToken = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, ownerToken, { name: 'Jabón', stock: 4 });
    const { token: cashierToken } = await createCashier(ctx.api, ownerToken);

    const operationId = randomUUID();
    const entrada = () => ctx.api('PUT', `/api/products/${productId}`, {
      token: cashierToken,
      body: { sale_price: 150, add_stock: 2, operation_id: operationId },
    });

    const [a, b] = await Promise.all([entrada(), entrada()]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await stock(ctx, productId), 6, '4 + 2, una sola vez');

    const intruso = await ctx.api('PUT', `/api/products/${productId}`, {
      token: cashierToken,
      body: { purchase_price: 1, operation_id: randomUUID() },
    });
    assert.equal(intruso.status, 403, 'operation_id no abre la puerta a otros campos');
  });
});
