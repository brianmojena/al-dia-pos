const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * Ventas cobradas sin internet que el servidor rechazó al subirlas. Decisión del
 * negocio: no se descartan — el dinero se cobró — sino que quedan a la vista del
 * dueño para que las revise.
 */

const crearCajero = async (api, tokenDueño) => {
  const email = `rech${Date.now()}${Math.random().toString(36).slice(2)}@test.local`;
  await api('POST', '/api/auth/cashiers', { token: tokenDueño, body: { email, password: 'caja1234' } });
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'caja1234' } });
  return { token: login.body.token, email };
};

const reportar = (api, token, body) => api('POST', '/api/sales/rejected', { token, body });

test('ventas rechazadas', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('el caso real: la última unidad se vendió en otra caja', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño);
    const ron = await createProduct(ctx.api, dueño, { name: 'Ron Havana Club 7', stock: 1, sale_price: 2800 });

    // La caja de escritorio vende la última botella.
    const escritorio = await ctx.api('POST', '/api/sales', {
      token: dueño,
      body: { items: [{ product_id: ron, quantity: 1, unit_price: 2800 }] },
    });
    assert.equal(escritorio.status, 201);

    // El teléfono, sin internet, también la había vendido. Al subirla: rechazada.
    const clientSaleId = randomUUID();
    const telefono = await ctx.api('POST', '/api/sales', {
      token: cajero.token,
      body: { items: [{ product_id: ron, quantity: 1, unit_price: 2800 }], client_sale_id: clientSaleId },
    });
    assert.equal(telefono.status, 409);

    // En vez de perderla, el teléfono la reporta.
    const res = await reportar(ctx.api, cajero.token, {
      client_sale_id: clientSaleId,
      items: [{ product_id: ron, quantity: 1, unit_price: 2800 }],
      payment_method: 'efectivo',
      error: telefono.body.error,
      sold_at: '2026-09-15T14:30:00.000Z',
    });

    assert.equal(res.status, 201);
    assert.equal(Number(res.body.total), 2800);
    assert.equal(res.body.account_email, cajero.email, 'se sabe quién la cobró');
    assert.equal(res.body.items[0].product_name, 'Ron Havana Club 7', 'el nombre sale del catálogo si el teléfono no lo mandó');
    assert.match(res.body.error, /Stock insuficiente/);
  });

  await t.test('el total lo calcula el servidor, no el teléfono', async () => {
    const dueño = await registerUser(ctx.api);
    const res = await reportar(ctx.api, dueño, {
      client_sale_id: randomUUID(),
      total: 1,
      items: [
        { product_id: 1, product_name: 'Aceite', quantity: 2, unit_price: 990 },
        { product_id: 2, product_name: 'Arroz', quantity: 3, unit_price: 130 },
      ],
    });
    assert.equal(Number(res.body.total), 2370);
  });

  await t.test('reportar dos veces la misma venta deja una sola fila', async () => {
    const dueño = await registerUser(ctx.api);
    const body = { client_sale_id: randomUUID(), items: [{ product_id: 1, product_name: 'Pan', quantity: 1, unit_price: 50 }] };

    const primero = await reportar(ctx.api, dueño, body);
    const segundo = await reportar(ctx.api, dueño, body);

    assert.equal(primero.status, 201);
    assert.equal(segundo.status, 200);
    assert.equal(segundo.body.id, primero.body.id);
    assert.equal((await ctx.api('GET', '/api/sales/rejected', { token: dueño })).body.length, 1);
  });

  await t.test('si la venta sí se registró, no queda como rechazada', async () => {
    const dueño = await registerUser(ctx.api);
    const pan = await createProduct(ctx.api, dueño, { name: 'Pan', stock: 10, sale_price: 50 });
    const clientSaleId = randomUUID();
    await ctx.api('POST', '/api/sales', {
      token: dueño,
      body: { items: [{ product_id: pan, quantity: 1, unit_price: 50 }], client_sale_id: clientSaleId },
    });

    const res = await reportar(ctx.api, dueño, {
      client_sale_id: clientSaleId,
      items: [{ product_id: pan, quantity: 1, unit_price: 50 }],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.already_registered, true);
    assert.equal((await ctx.api('GET', '/api/sales/rejected', { token: dueño })).body.length, 0);
  });

  await t.test('el dueño las ve, las marca revisadas, y el Inicio cuenta las pendientes', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño);
    const linea = [{ product_id: 1, product_name: 'Sal', quantity: 1, unit_price: 40 }];
    const a = await reportar(ctx.api, cajero.token, { client_sale_id: randomUUID(), items: linea });
    await reportar(ctx.api, cajero.token, { client_sale_id: randomUUID(), items: linea });

    let inicio = await ctx.api('GET', '/api/dashboard', { token: dueño });
    assert.equal(inicio.body.audit.rejectedSales, 2);

    // Un empleado no ve la lista: dice cuánto dinero se cobró fuera del sistema.
    assert.equal((await ctx.api('GET', '/api/sales/rejected', { token: cajero.token })).status, 403);
    assert.equal((await ctx.api('POST', `/api/sales/rejected/${a.body.id}/review`, { token: cajero.token })).status, 403);

    const revisada = await ctx.api('POST', `/api/sales/rejected/${a.body.id}/review`, { token: dueño });
    assert.equal(revisada.status, 200);
    assert.ok(revisada.body.reviewed_at);

    inicio = await ctx.api('GET', '/api/dashboard', { token: dueño });
    assert.equal(inicio.body.audit.rejectedSales, 1);

    const lista = (await ctx.api('GET', '/api/sales/rejected', { token: dueño })).body;
    assert.equal(lista[0].reviewed_at, null, 'las pendientes de revisar aparecen primero');
  });

  await t.test('otra tienda no las ve ni las puede marcar', async () => {
    const tiendaA = await registerUser(ctx.api);
    const tiendaB = await registerUser(ctx.api);
    const a = await reportar(ctx.api, tiendaA, {
      client_sale_id: randomUUID(),
      items: [{ product_id: 1, product_name: 'Café', quantity: 1, unit_price: 750 }],
    });

    assert.equal((await ctx.api('GET', '/api/sales/rejected', { token: tiendaB })).body.length, 0);
    assert.equal((await ctx.api('POST', `/api/sales/rejected/${a.body.id}/review`, { token: tiendaB })).status, 404);
  });

  await t.test('rechaza avisos mal formados', async () => {
    const dueño = await registerUser(ctx.api);
    for (const [body, motivo] of [
      [{ items: [{ quantity: 1, unit_price: 1 }] }, 'sin id de venta'],
      [{ client_sale_id: randomUUID(), items: [] }, 'sin líneas'],
      [{ client_sale_id: randomUUID(), items: [{ quantity: 0, unit_price: 1 }] }, 'cantidad cero'],
      [{ client_sale_id: randomUUID(), items: [{ quantity: 1, unit_price: -1 }] }, 'precio negativo'],
    ]) {
      assert.equal((await reportar(ctx.api, dueño, body)).status, 400, motivo);
    }
  });

  await t.test('la ruta /rejected no la captura el detalle de venta /:id', async () => {
    const dueño = await registerUser(ctx.api);
    const res = await ctx.api('GET', '/api/sales/rejected', { token: dueño });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });
});
