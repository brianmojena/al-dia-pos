const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * El arqueo de caja es la función que le da sentido comercial al POS frente al
 * dueño: contesta "¿está todo el dinero que debería estar?". Estos tests cubren
 * las garantías de las que depende esa respuesta:
 *
 *   1. El monto esperado NO llega al navegador antes de que el cajero declare
 *      (si se filtrara, el conteo a ciegas dejaría de serlo).
 *   2. Solo el efectivo cuenta; las transferencias no están en la gaveta.
 *   3. Los cierres son contiguos: ningún tramo de ventas se cuenta dos veces.
 *   4. Un doble toque en "Cerrar caja" no produce dos arqueos.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const venta = (api, token, { productId, quantity = 1, unit_price = 100, payment_method = 'efectivo' }) =>
  api('POST', '/api/sales', {
    token,
    body: { items: [{ product_id: productId, quantity, unit_price }], payment_method },
  });

test('cierre de caja', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('GET /current no revela el efectivo esperado', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Ron', stock: 20 });

    await venta(ctx.api, token, { productId, quantity: 4, unit_price: 500 });

    const res = await ctx.api('GET', '/api/cash-closes/current', { token });
    assert.equal(res.status, 200);

    // Guarda explícita: el día que alguien agregue expected_cash aquí "para
    // mostrarlo más cómodo", este test tiene que fallar. Sin esto, cualquiera
    // puede leer el total en la pestaña de red antes de declarar lo contado.
    assert.deepEqual(
      Object.keys(res.body).sort(),
      ['has_sales', 'is_first_close', 'opened_at'],
      'el período abierto solo puede describir CUÁNDO empieza, nunca CUÁNTO se espera'
    );

    const serializado = JSON.stringify(res.body);
    assert.ok(!serializado.includes('2000'), 'el total de las ventas no puede aparecer en la respuesta');
  });

  await t.test('el esperado suma fondo + efectivo, y deja fuera las transferencias', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Cerveza', stock: 50 });

    await venta(ctx.api, token, { productId, quantity: 5, unit_price: 100, payment_method: 'efectivo' });
    await venta(ctx.api, token, { productId, quantity: 3, unit_price: 100, payment_method: 'transferencia' });

    const res = await ctx.api('POST', '/api/cash-closes', {
      token,
      body: { opening_float: 1000, counted_cash: 1500 },
    });

    assert.equal(res.status, 201);
    assert.equal(Number(res.body.expected_cash), 1500, 'fondo 1000 + 500 en efectivo');
    assert.equal(Number(res.body.expected_transfer), 300, 'las transferencias se registran aparte');
    assert.equal(Number(res.body.difference), 0, 'la caja cuadra');
    assert.equal(Number(res.body.sales_count), 2);
  });

  await t.test('detecta un faltante y un sobrante', async () => {
    const tokenFalta = await registerUser(ctx.api);
    const p1 = await createProduct(ctx.api, tokenFalta, { name: 'Pan', stock: 20 });
    await venta(ctx.api, tokenFalta, { productId: p1, quantity: 10, unit_price: 100 });

    const falta = await ctx.api('POST', '/api/cash-closes', {
      token: tokenFalta,
      body: { counted_cash: 700 },   // deberían ser 1000
    });
    assert.equal(Number(falta.body.expected_cash), 1000);
    assert.equal(Number(falta.body.difference), -300, 'faltan 300 pesos');

    const tokenSobra = await registerUser(ctx.api);
    const p2 = await createProduct(ctx.api, tokenSobra, { name: 'Sal', stock: 20 });
    await venta(ctx.api, tokenSobra, { productId: p2, quantity: 2, unit_price: 100 });

    const sobra = await ctx.api('POST', '/api/cash-closes', {
      token: tokenSobra,
      body: { counted_cash: 250 },   // deberían ser 200
    });
    assert.equal(Number(sobra.body.difference), 50, 'sobran 50 pesos');
  });

  await t.test('el segundo cierre no vuelve a contar las ventas del primero', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Aceite', stock: 50 });

    // Dos ventas sueltas, no una de dos unidades: sales_count cuenta ventas.
    await venta(ctx.api, token, { productId, unit_price: 100 });
    await venta(ctx.api, token, { productId, unit_price: 100 });
    const primero = await ctx.api('POST', '/api/cash-closes', {
      token,
      body: { counted_cash: 200 },
    });
    assert.equal(Number(primero.body.expected_cash), 200);
    assert.equal(Number(primero.body.sales_count), 2);

    // created_at y closed_at tienen resolución de un segundo, y la frontera del
    // período es estricta (created_at > corte anterior). Esperamos algo más de
    // un segundo para que esta venta caiga inequívocamente en el período nuevo.
    // En producción la dirección del redondeo es la segura: una venta hecha en
    // el mismo segundo del cierre se cuenta en el período siguiente, nunca dos veces.
    await sleep(1100);

    await venta(ctx.api, token, { productId, unit_price: 100 });
    await venta(ctx.api, token, { productId, unit_price: 100 });
    await venta(ctx.api, token, { productId, unit_price: 100 });
    const segundo = await ctx.api('POST', '/api/cash-closes', {
      token,
      body: { counted_cash: 300 },
    });

    assert.equal(Number(segundo.body.expected_cash), 300, 'solo las ventas posteriores al primer cierre');
    assert.equal(Number(segundo.body.sales_count), 3);
    assert.equal(Number(segundo.body.difference), 0);
    assert.equal(segundo.body.opened_at, primero.body.closed_at, 'el período arranca donde cerró el anterior');
  });

  await t.test('un doble toque con el mismo client_close_id deja un solo cierre', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Café', stock: 20 });
    await venta(ctx.api, token, { productId, quantity: 5, unit_price: 100 });

    const clientCloseId = randomUUID();
    const cerrar = () =>
      ctx.api('POST', '/api/cash-closes', {
        token,
        body: { client_close_id: clientCloseId, counted_cash: 500 },
      });

    const [a, b] = await Promise.all([cerrar(), cerrar()]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201], 'uno crea el cierre y el otro recibe la réplica');
    assert.equal(a.body.id, b.body.id, 'ambas respuestas describen el mismo cierre');

    const filas = await ctx.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM cash_closes WHERE client_close_id = ?',
      args: [clientCloseId],
    });
    assert.equal(Number(filas.rows[0].n), 1, 'solo puede existir una fila para ese client_close_id');
  });

  await t.test('los cierres de una tienda no se ven ni afectan a otra', async () => {
    const tokenA = await registerUser(ctx.api);
    const tokenB = await registerUser(ctx.api);
    const productoA = await createProduct(ctx.api, tokenA, { name: 'Azúcar', stock: 20 });
    const productoB = await createProduct(ctx.api, tokenB, { name: 'Azúcar', stock: 20 });

    await venta(ctx.api, tokenA, { productId: productoA, quantity: 7, unit_price: 100 });
    await venta(ctx.api, tokenB, { productId: productoB, quantity: 2, unit_price: 100 });

    const cierreA = await ctx.api('POST', '/api/cash-closes', { token: tokenA, body: { counted_cash: 700 } });
    assert.equal(Number(cierreA.body.expected_cash), 700, 'A solo cuenta sus propias ventas');

    // El cierre de A no debe consumir el período de B.
    const cierreB = await ctx.api('POST', '/api/cash-closes', { token: tokenB, body: { counted_cash: 200 } });
    assert.equal(Number(cierreB.body.expected_cash), 200, 'B conserva sus ventas sin contar');

    const listaB = await ctx.api('GET', '/api/cash-closes', { token: tokenB });
    assert.equal(listaB.body.length, 1, 'B solo ve su propio cierre');
    assert.equal(listaB.body[0].id, cierreB.body.id);
  });

  await t.test('rechaza un efectivo contado inválido', async () => {
    const token = await registerUser(ctx.api);

    const negativo = await ctx.api('POST', '/api/cash-closes', { token, body: { counted_cash: -50 } });
    assert.equal(negativo.status, 400);

    const noNumero = await ctx.api('POST', '/api/cash-closes', { token, body: { counted_cash: 'mucho' } });
    assert.equal(noNumero.status, 400);
  });
});
