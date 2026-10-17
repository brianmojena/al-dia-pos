const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

/**
 * Separación del día en stock inicial, entradas y disponible:
 *   - inicial (opening_stock) es la base con que amanece el producto;
 *   - entradas (entries_stock) acumula la mercancía recibida hoy (a mano, alta
 *     de producto nuevo e importación), no las correcciones ni las anulaciones;
 *   - disponible (current_stock) es el stock vivo, que baja con las ventas y
 *     sube al anular o recibir.
 * Quien lo ve es el dueño en la vista Productos/Entradas.
 */
test('stock del día separa inicial, entradas y disponible', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const owner = await registerUser(ctx.api);
  const cashier = await createCashier(ctx.api, owner);

  await t.test('inicial y entradas quedan fijos; las ventas mueven el disponible', async () => {
    const product = (await ctx.api('POST', '/api/products', { token: owner, body: {
      name: 'Refresco', stock: 1, sale_price: 10,
    } })).body.id;
    // El producto ya existía al empezar el día: su carga inicial no es de hoy.
    await ctx.db.execute({ sql: 'UPDATE products SET created_at = ? WHERE id = ?', args: ['2020-01-01 12:00:00', product] });
    await ctx.db.execute({ sql: 'UPDATE stock_entries SET created_at = ? WHERE product_id = ?', args: ['2020-01-01 12:00:00', product] });

    // Llega mercancía en dos tandas: las entradas se acumulan.
    assert.equal((await ctx.api('PUT', `/api/products/${product}`, { token: owner, body: { add_stock: 20 } })).status, 200);
    assert.equal((await ctx.api('PUT', `/api/products/${product}`, { token: owner, body: { add_stock: 4 } })).status, 200);

    const rowOf = async () => (await ctx.api('GET', '/api/products/day-stock', { token: owner })).body.products.find((p) => p.id === product);
    let row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [1, 24, 25], JSON.stringify(row));

    // Inicial 1 + entradas 24 = disponible 25; una venta de 3 deja disponible
    // 22 sin tocar el inicial ni las entradas.
    const sale = await ctx.api('POST', '/api/sales', { token: cashier.token, body: {
      items: [{ product_id: product, quantity: 3, unit_price: 10 }],
    } });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [1, 24, 22], JSON.stringify(row));

    // Un ajuste a mano y una anulación ajustan el disponible, no las entradas.
    assert.equal((await ctx.api('PUT', `/api/products/${product}`, { token: owner, body: { stock: 20, stock_reason: 'conteo' } })).status, 200);
    assert.equal((await ctx.api('POST', `/api/sales/${sale.body.id}/correct`, { token: owner, body: { action: 'anular', reason: 'prueba' } })).status, 200);
    row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [1, 24, 23], JSON.stringify(row));
  });

  await t.test('el alta de un producto nuevo y la importación cuentan como entradas', async () => {
    const nuevo = await createProduct(ctx.api, owner, { name: 'Nuevo', stock: 7 });
    const rowOf = async () => (await ctx.api('GET', '/api/products/day-stock', { token: owner })).body.products.find((p) => p.id === nuevo);

    let row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [0, 7, 7]);

    const imported = await ctx.api('POST', '/api/products/import', { token: owner, body: {
      stock_mode: 'sumar', items: [{ name: 'Nuevo', sale_price: 100, stock: 5 }],
    } });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [0, 12, 12]);
  });

  await t.test('importar con sumar es recepción y reemplazar el stock es corrección', async () => {
    const product = await createProduct(ctx.api, owner, { name: 'Importable', stock: 0 });
    const rowOf = async () => (await ctx.api('GET', '/api/products/day-stock', { token: owner })).body.products.find((p) => p.id === product);

    // Reemplazar 0 → 50 cambia el disponible pero es un ajuste, no mercancía
    // que llegó: las entradas siguen en cero.
    const replaced = await ctx.api('POST', '/api/products/import', { token: owner, body: {
      items: [{ name: 'Importable', sale_price: 10, stock: 50 }],
    } });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    let row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [0, 0, 50]);

    // Sumar 20 sí es recepción: entra a las entradas del día.
    const summed = await ctx.api('POST', '/api/products/import', { token: owner, body: {
      stock_mode: 'sumar', items: [{ name: 'Importable', sale_price: 10, stock: 20 }],
    } });
    assert.equal(summed.status, 200, JSON.stringify(summed.body));
    row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [0, 20, 70]);
  });

  await t.test('recibir del almacén cuenta como entrada; devolver al almacén no', async () => {
    const created = await ctx.api('POST', '/api/warehouse', { token: owner, body: { name: 'Azúcar', quantity: 30, cost: 5 } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const items = (await ctx.api('GET', '/api/warehouse', { token: owner })).body;
    const warehouseItem = items.find((item) => item.name === 'Azúcar');

    // Almacén → tienda: entra mercancía a la tienda y sube el disponible.
    const transfer = await ctx.api('POST', '/api/warehouse/transfer', { token: owner, body: {
      warehouse_item_id: warehouseItem.id, quantity: 10, sale_price: 15,
    } });
    assert.equal(transfer.status, 201, JSON.stringify(transfer.body));
    const product = transfer.body.product_id;
    const rowOf = async () => (await ctx.api('GET', '/api/products/day-stock', { token: owner })).body.products.find((p) => p.id === product);

    let row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [0, 10, 10]);

    // Tienda → almacén: saca mercancía; no es una entrada nueva.
    const back = await ctx.api('POST', '/api/warehouse/from-store', { token: owner, body: {
      product_id: product, quantity: 4,
    } });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    row = await rowOf();
    assert.deepEqual([row.opening_stock, row.entries_stock, row.current_stock], [0, 10, 6]);
  });
});
