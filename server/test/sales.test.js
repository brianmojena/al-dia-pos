const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * Estos tests cubren las dos garantías que el POS necesita para no perder ni
 * duplicar dinero, y que hasta ahora solo estaban afirmadas en el README:
 *
 *   1. El stock nunca queda negativo, por muchas ventas simultáneas que entren.
 *   2. Una venta con el mismo client_sale_id se registra exactamente una vez.
 */

test('ventas: concurrencia e idempotencia', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('8 ventas simultáneas contra 5 de stock: 5 pasan, 3 dan 409, el stock queda en 0', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Arroz', stock: 5 });

    const intentos = 8;
    const respuestas = await Promise.all(
      Array.from({ length: intentos }, () =>
        ctx.api('POST', '/api/sales', {
          token,
          body: {
            items: [{ product_id: productId, quantity: 1, unit_price: 100 }],
          },
        })
      )
    );

    const creadas = respuestas.filter((r) => r.status === 201);
    const rechazadas = respuestas.filter((r) => r.status === 409);
    const inesperadas = respuestas.filter((r) => r.status !== 201 && r.status !== 409);

    assert.deepEqual(
      inesperadas.map((r) => ({ status: r.status, body: r.body })),
      [],
      'ninguna petición debería fallar con un status distinto de 201 o 409'
    );
    assert.equal(creadas.length, 5, 'solo deberían registrarse 5 ventas (el stock disponible)');
    assert.equal(rechazadas.length, 3, 'las 3 ventas sobrantes deberían rechazarse con 409');

    // La garantía de verdad: el stock nunca puede quedar negativo.
    const producto = await ctx.db.execute({
      sql: 'SELECT stock FROM products WHERE id = ?',
      args: [productId],
    });
    assert.equal(Number(producto.rows[0].stock), 0, 'el stock final debe ser exactamente 0');

    // Y las líneas de venta tienen que cuadrar con lo descontado.
    const vendidas = await ctx.db.execute({
      sql: 'SELECT COALESCE(SUM(quantity), 0) AS total FROM sale_items WHERE product_id = ?',
      args: [productId],
    });
    assert.equal(Number(vendidas.rows[0].total), 5, 'la suma de unidades vendidas debe ser 5');
  });

  await t.test('dos peticiones simultáneas con el mismo client_sale_id registran una sola venta', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Aceite', stock: 10 });
    const clientSaleId = randomUUID();

    const venta = () =>
      ctx.api('POST', '/api/sales', {
        token,
        body: {
          client_sale_id: clientSaleId,
          items: [{ product_id: productId, quantity: 2, unit_price: 150 }],
        },
      });

    const [a, b] = await Promise.all([venta(), venta()]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201], 'una petición crea la venta (201) y la otra recibe la réplica (200)');

    const replay = [a, b].find((r) => r.status === 200);
    assert.equal(replay.body.idempotent_replay, true, 'la respuesta repetida debe venir marcada como réplica');

    // Ambas respuestas describen la MISMA venta.
    assert.equal(a.body.id, b.body.id, 'las dos respuestas deben apuntar a la misma venta');

    const filas = await ctx.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM sales WHERE client_sale_id = ?',
      args: [clientSaleId],
    });
    assert.equal(Number(filas.rows[0].n), 1, 'solo puede existir una fila de venta para ese client_sale_id');

    // El stock se descontó una sola vez: 10 - 2 = 8, no 6.
    const producto = await ctx.db.execute({
      sql: 'SELECT stock FROM products WHERE id = ?',
      args: [productId],
    });
    assert.equal(Number(producto.rows[0].stock), 8, 'el stock solo debe descontarse una vez');
  });

  await t.test('reintentar una venta ya registrada devuelve la original sin cobrar de nuevo', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Café', stock: 10 });
    const clientSaleId = randomUUID();

    const body = {
      client_sale_id: clientSaleId,
      items: [{ product_id: productId, quantity: 3, unit_price: 200 }],
    };

    const primera = await ctx.api('POST', '/api/sales', { token, body });
    assert.equal(primera.status, 201);

    // Mismo caso que cuando el POS no recibe la respuesta y reintenta.
    const reintento = await ctx.api('POST', '/api/sales', { token, body });
    assert.equal(reintento.status, 200, 'el reintento no debe crear una venta nueva');
    assert.equal(reintento.body.idempotent_replay, true);
    assert.equal(reintento.body.id, primera.body.id, 'debe devolver la venta original');

    const producto = await ctx.db.execute({
      sql: 'SELECT stock FROM products WHERE id = ?',
      args: [productId],
    });
    assert.equal(Number(producto.rows[0].stock), 7, 'el stock solo debe descontarse una vez (10 - 3)');
  });

  await t.test('el mismo client_sale_id en dos tiendas distintas no colisiona', async () => {
    const tokenA = await registerUser(ctx.api);
    const tokenB = await registerUser(ctx.api);
    const productoA = await createProduct(ctx.api, tokenA, { name: 'Sal', stock: 5 });
    const productoB = await createProduct(ctx.api, tokenB, { name: 'Sal', stock: 5 });

    // El índice UNIQUE es (user_id, client_sale_id): dos tenants pueden generar
    // el mismo UUID sin bloquearse entre ellos.
    const clientSaleId = randomUUID();

    const ventaA = await ctx.api('POST', '/api/sales', {
      token: tokenA,
      body: { client_sale_id: clientSaleId, items: [{ product_id: productoA, quantity: 1, unit_price: 50 }] },
    });
    const ventaB = await ctx.api('POST', '/api/sales', {
      token: tokenB,
      body: { client_sale_id: clientSaleId, items: [{ product_id: productoB, quantity: 1, unit_price: 50 }] },
    });

    assert.equal(ventaA.status, 201, 'la venta de la tienda A debe crearse');
    assert.equal(ventaB.status, 201, 'la venta de la tienda B debe crearse pese al mismo client_sale_id');
    assert.notEqual(ventaA.body.id, ventaB.body.id, 'deben ser dos ventas distintas');
  });

  await t.test('una venta rechazada por stock no deja media venta registrada', async () => {
    const token = await registerUser(ctx.api);
    const conStock = await createProduct(ctx.api, token, { name: 'Leche', stock: 5 });
    const sinStock = await createProduct(ctx.api, token, { name: 'Pan', stock: 0 });

    const antes = await ctx.db.execute({ sql: 'SELECT COUNT(*) AS n FROM sales WHERE user_id IS NOT NULL' });

    // El segundo item no tiene stock: la transacción entera debe revertirse,
    // incluido el descuento que ya se aplicó al primero.
    const res = await ctx.api('POST', '/api/sales', {
      token,
      body: {
        items: [
          { product_id: conStock, quantity: 1, unit_price: 100 },
          { product_id: sinStock, quantity: 1, unit_price: 100 },
        ],
      },
    });

    assert.equal(res.status, 409, 'la venta debe rechazarse');

    const producto = await ctx.db.execute({
      sql: 'SELECT stock FROM products WHERE id = ?',
      args: [conStock],
    });
    assert.equal(Number(producto.rows[0].stock), 5, 'el descuento del primer item debe revertirse');

    const despues = await ctx.db.execute({ sql: 'SELECT COUNT(*) AS n FROM sales WHERE user_id IS NOT NULL' });
    assert.equal(
      Number(despues.rows[0].n),
      Number(antes.rows[0].n),
      'no debe quedar ninguna venta registrada'
    );
  });
});
