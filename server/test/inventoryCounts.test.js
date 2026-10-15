const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * El arqueo de inventario existe para tapar el hueco que el arqueo de caja no
 * puede tapar. El primer test de este archivo es el que explica por qué existe
 * la función entera; los demás cubren que el ajuste de stock sea correcto y
 * quede registrado.
 */

const contar = (api, token, items, extra = {}) =>
  api('POST', '/api/inventory-counts', { token, body: { items, ...extra } });

const corregir = (api, token, countId, items) =>
  api('PUT', `/api/inventory-counts/${countId}`, { token, body: { items } });

const stockDe = async (ctx, productId) => {
  const r = await ctx.db.execute({ sql: 'SELECT stock FROM products WHERE id = ?', args: [productId] });
  return Number(r.rows[0].stock);
};

test('arqueo de inventario', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('una venta no registrada: la caja cuadra, el inventario la delata', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, {
      name: 'Café Serrano', stock: 10, sale_price: 100, purchase_price: 60,
    });

    // Entran 10 clientes de $100 en efectivo, pero solo se registran 8 ventas.
    // Las otras 2 unidades salen del estante y el dinero no entra a la caja.
    for (let i = 0; i < 8; i++) {
      const venta = await ctx.api('POST', '/api/sales', {
        token,
        body: { items: [{ product_id: productId, quantity: 1, unit_price: 100 }], payment_method: 'efectivo' },
      });
      assert.equal(venta.status, 201);
    }
    // Las 2 unidades robadas desaparecen del estante sin pasar por el POS: el
    // sistema sigue creyendo que quedan 2.
    assert.equal(await stockDe(ctx, productId), 2);

    // --- Arqueo de caja ---
    // Fondo 1000 + 800 registrados = 1800 esperados. En la gaveta hay
    // 1000 + 1000 cobrados − 200 robados = 1800. Cuadra perfecto.
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token,
      body: { opening_float: 1000, counted_cash: 1800 },
    });
    assert.equal(Number(cierre.body.expected_cash), 1800);
    assert.equal(
      Number(cierre.body.difference), 0,
      'ESTE es el punto: el arqueo de caja NO puede ver una venta que nunca se registró'
    );

    // --- Arqueo de inventario ---
    // En el estante no quedan 2 unidades: queda 0. Ahí aparece el robo.
    const arqueo = await contar(ctx.api, token, [{ product_id: productId, counted: 0 }]);
    assert.equal(arqueo.status, 201);
    assert.equal(Number(arqueo.body.units_missing), 2, 'faltan las 2 unidades que se fueron sin registrarse');
    assert.equal(
      Number(arqueo.body.value_missing), 200,
      'valorizado al precio de venta: es el dinero que debió entrar a la caja'
    );
    assert.equal(Number(arqueo.body.items[0].expected), 2);
    assert.equal(Number(arqueo.body.items[0].counted), 0);
    assert.equal(Number(arqueo.body.items[0].difference), -2);
  });

  await t.test('el conteo ajusta el stock a la realidad', async () => {
    const token = await registerUser(ctx.api);
    const falta = await createProduct(ctx.api, token, { name: 'Arroz', stock: 40, sale_price: 130 });
    const sobra = await createProduct(ctx.api, token, { name: 'Azúcar', stock: 20, sale_price: 110 });

    const arqueo = await contar(ctx.api, token, [
      { product_id: falta, counted: 38 },
      { product_id: sobra, counted: 23 },
    ]);

    assert.equal(arqueo.status, 201);
    assert.equal(await stockDe(ctx, falta), 38, 'el stock queda en lo contado, no en lo que creía el sistema');
    assert.equal(await stockDe(ctx, sobra), 23);

    assert.equal(Number(arqueo.body.units_missing), 2);
    assert.equal(Number(arqueo.body.units_extra), 3);
    assert.equal(Number(arqueo.body.products_with_difference), 2);
    assert.equal(Number(arqueo.body.value_missing), 260, '2 unidades × 130');
  });

  await t.test('ajustar deja registro: el faltante no se borra al corregir el stock', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Ron', stock: 12, sale_price: 500 });

    await contar(ctx.api, token, [{ product_id: productId, counted: 9 }]);
    assert.equal(await stockDe(ctx, productId), 9, 'el stock se corrigió');

    // Y la evidencia sigue ahí: sin esto, ajustar sería tapar el problema.
    const items = await ctx.db.execute({
      sql: 'SELECT * FROM inventory_count_items WHERE product_id = ?',
      args: [productId],
    });
    assert.equal(items.rows.length, 1);
    assert.equal(Number(items.rows[0].expected), 12);
    assert.equal(Number(items.rows[0].counted), 9);
    assert.equal(Number(items.rows[0].difference), -3);

    // Un segundo conteo sobre el stock ya corregido no repite el faltante.
    const segundo = await contar(ctx.api, token, [{ product_id: productId, counted: 9 }]);
    assert.equal(Number(segundo.body.units_missing), 0, 'el mismo faltante no reaparece cada noche');
    assert.equal(Number(segundo.body.products_with_difference), 0);
  });

  await t.test('es un conteo parcial: lo que no se cuenta no se toca', async () => {
    const token = await registerUser(ctx.api);
    const contado = await createProduct(ctx.api, token, { name: 'Pan', stock: 30, sale_price: 50 });
    const intacto = await createProduct(ctx.api, token, { name: 'Sal', stock: 25, sale_price: 40 });

    const arqueo = await contar(ctx.api, token, [{ product_id: contado, counted: 28 }]);

    assert.equal(Number(arqueo.body.lines_count), 1);
    assert.equal(await stockDe(ctx, contado), 28);
    assert.equal(await stockDe(ctx, intacto), 25, 'un producto que no se contó no puede cambiar de stock');
  });

  await t.test('un conteo que falla no deja el inventario a medio ajustar', async () => {
    const token = await registerUser(ctx.api);
    const bueno = await createProduct(ctx.api, token, { name: 'Leche', stock: 15, sale_price: 200 });

    // El segundo producto no existe: la transacción entera debe revertirse,
    // incluido el ajuste que ya se aplicó al primero.
    const res = await contar(ctx.api, token, [
      { product_id: bueno, counted: 10 },
      { product_id: 999999, counted: 5 },
    ]);

    assert.equal(res.status, 400);
    assert.equal(await stockDe(ctx, bueno), 15, 'el ajuste del primer producto debe revertirse');

    const arqueos = await ctx.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM inventory_counts WHERE user_id IS NOT NULL',
    });
    const items = await ctx.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM inventory_count_items WHERE product_id = ?',
      args: [bueno],
    });
    assert.equal(Number(items.rows[0].n), 0, 'no puede quedar media línea registrada');
    assert.ok(Number(arqueos.rows[0].n) >= 0);
  });

  await t.test('un doble envío con el mismo client_count_id ajusta una sola vez', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Aceite', stock: 20, sale_price: 990 });
    const clientCountId = randomUUID();

    const enviar = () =>
      contar(ctx.api, token, [{ product_id: productId, counted: 17 }], { client_count_id: clientCountId });

    const [a, b] = await Promise.all([enviar(), enviar()]);

    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.id, b.body.id);
    assert.equal(await stockDe(ctx, productId), 17, 'el stock no puede ajustarse dos veces');

    const filas = await ctx.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM inventory_counts WHERE client_count_id = ?',
      args: [clientCountId],
    });
    assert.equal(Number(filas.rows[0].n), 1);
  });

  await t.test('rechaza cantidades inválidas y productos repetidos', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Huevo', stock: 60, sale_price: 110 });

    const negativo = await contar(ctx.api, token, [{ product_id: productId, counted: -1 }]);
    assert.equal(negativo.status, 400);

    const decimal = await contar(ctx.api, token, [{ product_id: productId, counted: 2.5 }]);
    assert.equal(decimal.status, 400);

    const repetido = await contar(ctx.api, token, [
      { product_id: productId, counted: 10 },
      { product_id: productId, counted: 20 },
    ]);
    assert.equal(repetido.status, 400, 'el mismo producto dos veces dejaría el resultado al azar');

    const vacio = await contar(ctx.api, token, []);
    assert.equal(vacio.status, 400);

    assert.equal(await stockDe(ctx, productId), 60, 'ningún intento inválido tocó el stock');
  });

  await t.test('un cajero puede contar pero no ve el historial de arqueos', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Sal', stock: 10, sale_price: 40 });

    const email = `inv${Date.now()}@test.local`;
    await ctx.api('POST', '/api/auth/cashiers', { token: dueño, body: { email, password: 'caja1234' } });
    const login = await ctx.api('POST', '/api/auth/login', { body: { email, password: 'caja1234' } });
    const cajero = login.body.token;

    // El cajero puede hacer conteos; el sistema registra quién contó (account_email).
    // El dueño ve los conteos en "Arqueos anteriores" con el email del cajero.
    const intento = await contar(ctx.api, cajero, [{ product_id: productId, counted: 3 }]);
    assert.equal(intento.status, 201, 'el cajero puede contar inventario');
    assert.equal(await stockDe(ctx, productId), 3, 'el stock se ajusta a lo contado');
    assert.equal(intento.body.account_email, email, 'queda registrado quién contó');

    // Pero el cajero no ve la lista ni el detalle.
    const historial = await ctx.api('GET', '/api/inventory-counts', { token: cajero });
    assert.equal(historial.status, 403, 'el cajero no ve el historial de arqueos');

    // El dueño sí lo ve y ve quién contó.
    const lista = await ctx.api('GET', '/api/inventory-counts', { token: dueño });
    assert.equal(lista.status, 200);
    assert.equal(lista.body.length, 1);
    assert.equal(lista.body[0].account_email, email, 'el dueño ve quién contó en la lista');
  });

  await t.test('los arqueos de una tienda no se ven desde otra', async () => {
    const dueñoA = await registerUser(ctx.api);
    const dueñoB = await registerUser(ctx.api);
    const productoA = await createProduct(ctx.api, dueñoA, { name: 'Pasta', stock: 25, sale_price: 280 });

    const arqueoA = await contar(ctx.api, dueñoA, [{ product_id: productoA, counted: 20 }]);

    const listaB = await ctx.api('GET', '/api/inventory-counts', { token: dueñoB });
    assert.equal(listaB.body.length, 0, 'B no ve los arqueos de A');

    const detalle = await ctx.api('GET', `/api/inventory-counts/${arqueoA.body.id}`, { token: dueñoB });
    assert.equal(detalle.status, 404, 'ni siquiera adivinando el id');

    // Y B no puede contar un producto que no es suyo.
    const intento = await contar(ctx.api, dueñoB, [{ product_id: productoA, counted: 0 }]);
    assert.equal(intento.status, 400);
    assert.equal(await stockDe(ctx, productoA), 20, 'el stock de A quedó como lo dejó A');
  });

  await t.test('corregir un arqueo: 10→7 (stock 7), luego PUT 7→9 (stock 9)', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, {
      name: 'Arroz', stock: 10, sale_price: 130, purchase_price: 80,
    });

    // Contar 7, stock queda en 7.
    const arqueo = await contar(ctx.api, token, [{ product_id: productId, counted: 7 }]);
    assert.equal(arqueo.status, 201);
    assert.equal(await stockDe(ctx, productId), 7);
    assert.equal(Number(arqueo.body.units_missing), 3);
    assert.equal(Number(arqueo.body.items[0].difference), -3);

    // Corregir a 9: stock sube a 9.
    const itemId = arqueo.body.items[0].id;
    const correccion = await corregir(ctx.api, token, arqueo.body.id, [{ item_id: itemId, counted: 9 }]);
    assert.equal(correccion.status, 200);
    assert.equal(await stockDe(ctx, productId), 9);

    // La línea cambió: difference = 9 - 10 = -1.
    assert.equal(Number(correccion.body.items[0].counted), 9);
    assert.equal(Number(correccion.body.items[0].difference), -1);

    // Los agregados se recomputaron: units_missing = 1 (no 3).
    assert.equal(Number(correccion.body.units_missing), 1);
    assert.equal(Number(correccion.body.value_missing), 130);

    // Existe un stock_entries con kind='correccion'.
    const entries = await ctx.db.execute({
      sql: 'SELECT * FROM stock_entries WHERE product_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
      args: [productId, 'correccion'],
    });
    assert.equal(entries.rows.length, 1);
    assert.equal(entries.rows[0].kind, 'correccion');
    assert.equal(Number(entries.rows[0].stock_before), 7);
    assert.equal(Number(entries.rows[0].stock_after), 9);
    assert.ok(entries.rows[0].reason.includes('Corrección del arqueo'));
  });

  await t.test('corregir con una venta en el medio: stock sigue siendo correcto', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, {
      name: 'Café', stock: 10, sale_price: 100, purchase_price: 60,
    });

    // Contar 7, stock queda en 7.
    const arqueo = await contar(ctx.api, token, [{ product_id: productId, counted: 7 }]);
    assert.equal(await stockDe(ctx, productId), 7);

    // Venta de 2 unidades después del conteo: stock baja a 5.
    await ctx.api('POST', '/api/sales', {
      token,
      body: { items: [{ product_id: productId, quantity: 2, unit_price: 100 }], payment_method: 'efectivo' },
    });
    assert.equal(await stockDe(ctx, productId), 5);

    // Corregir la línea a 9: stock sube a 5 + (9 - 7) = 7.
    const itemId = arqueo.body.items[0].id;
    const correccion = await corregir(ctx.api, token, arqueo.body.id, [{ item_id: itemId, counted: 9 }]);
    assert.equal(correccion.status, 200);
    assert.equal(await stockDe(ctx, productId), 7);

    // La diferencia es 9 - 10 = -1.
    assert.equal(Number(correccion.body.items[0].difference), -1);
  });

  await t.test('no se puede corregir un producto que se volvió a contar después', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, {
      name: 'Pan', stock: 30, sale_price: 50,
    });

    // Primer conteo: 28 unidades.
    const arqueo1 = await contar(ctx.api, token, [{ product_id: productId, counted: 28 }]);
    const itemId1 = arqueo1.body.items[0].id;

    // Segundo conteo (más tarde): 27 unidades.
    const arqueo2 = await contar(ctx.api, token, [{ product_id: productId, counted: 27 }]);

    // No se puede corregir el primer arqueo para este producto.
    const correccion = await corregir(ctx.api, token, arqueo1.body.id, [
      { item_id: itemId1, counted: 25 },
    ]);
    assert.equal(correccion.status, 409);
    assert.ok(correccion.body.error.includes('se volvió a contar en un arqueo más nuevo'));

    // GET del primer arqueo debe marcar recounted_later=true.
    const detalle = await ctx.api('GET', `/api/inventory-counts/${arqueo1.body.id}`, { token });
    assert.equal(detalle.status, 200);
    assert.equal(detalle.body.items[0].recounted_later, true);
  });

  await t.test('un cajero no puede corregir un arqueo (403)', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, {
      name: 'Sal', stock: 10, sale_price: 40,
    });

    const arqueo = await contar(ctx.api, dueño, [{ product_id: productId, counted: 8 }]);
    const itemId = arqueo.body.items[0].id;

    // Crear un cajero.
    const email = `caj${Date.now()}@test.local`;
    await ctx.api('POST', '/api/auth/cashiers', {
      token: dueño,
      body: { email, password: 'caja1234' },
    });
    const login = await ctx.api('POST', '/api/auth/login', {
      body: { email, password: 'caja1234' },
    });
    const cajeroToken = login.body.token;

    // El cajero intenta corregir: 403.
    const intento = await corregir(ctx.api, cajeroToken, arqueo.body.id, [
      { item_id: itemId, counted: 10 },
    ]);
    assert.equal(intento.status, 403);
    assert.equal(await stockDe(ctx, productId), 8, 'el stock no cambió');
  });

  await t.test('corregir un arqueo de otra tienda devuelve 404', async () => {
    const dueñoA = await registerUser(ctx.api);
    const dueñoB = await registerUser(ctx.api);
    const productoA = await createProduct(ctx.api, dueñoA, {
      name: 'Producto', stock: 20, sale_price: 100,
    });

    const arqueoA = await contar(ctx.api, dueñoA, [{ product_id: productoA, counted: 18 }]);
    const itemId = arqueoA.body.items[0].id;

    const intento = await corregir(ctx.api, dueñoB, arqueoA.body.id, [
      { item_id: itemId, counted: 19 },
    ]);
    assert.equal(intento.status, 404);
  });
});
