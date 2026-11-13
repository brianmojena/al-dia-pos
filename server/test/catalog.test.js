const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createCashier, createProduct } = require('./helpers');
const push = require('../lib/push');

/**
 * Tienda online por negocio: catálogo público (/api/public/catalog/<slug>) y
 * reservas del cliente. El payload público jamás incluye el costo de compra ni
 * el stock exacto; la reserva es una solicitud que no bloquea stock.
 *
 * Un solo test de primer nivel: getDb() memoiza la base en el proceso, así que
 * todas las pruebas comparten esta instancia (como en accounting.test.js).
 */
test('tienda online: catálogo público y reservas', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const enviados = [];
  const original = { ...push.transports };
  push.transports.ios = async (tokens, message) => { enviados.push(message); return []; };
  push.transports.android = async (tokens, message) => { enviados.push(message); return []; };
  t.after(() => Object.assign(push.transports, original));

  const suffix_ = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;

  /** Tienda con catálogo de prueba: la activa y devuelve tokens + ids de productos. */
  const setupStore = async ({ storeName = 'Tienda de Prueba', email } = {}) => {
    const res = await ctx.api('POST', '/api/auth/register', {
      body: { email: email || `dueno-${suffix_()}@test.local`, password: 'test1234', store_name: storeName },
    });
    const token = res.body.token;
    const panId = await createProduct(ctx.api, token, { name: 'Pan', stock: 10, sale_price: 100, purchase_price: 60 });
    const arroz = await ctx.api('POST', '/api/products', {
      token,
      body: { name: 'Arroz', stock: 0, sale_price: 250, purchase_price: 150, unit: 'kg', track_stock: true },
    });
    assert.equal(arroz.status, 201);
    const pollo = await ctx.api('POST', '/api/products', {
      token,
      body: { name: 'Pollo', stock: 0, sale_price: 900, purchase_price: 500, unit: 'kg' },
    });
    assert.equal(pollo.status, 201);
    const ocultoId = await createProduct(ctx.api, token, { name: 'Secreto', stock: 5, sale_price: 50, purchase_price: 20 });

    // Publicar: Pan disponible, Arroz agotado, Pollo sin control de stock.
    for (const id of [panId, Number(arroz.body.id), Number(pollo.body.id)]) {
      const put = await ctx.api('PUT', `/api/products/${id}`, { token, body: { catalog_visible: true } });
      assert.equal(put.status, 200);
    }
    const enable = await ctx.api('PUT', '/api/catalog', { token, body: { catalog_enabled: true } });
    assert.equal(enable.status, 200);
    return {
      token,
      panId,
      arrozId: Number(arroz.body.id),
      polloId: Number(pollo.body.id),
      ocultoId,
      slug: enable.body.catalog_slug,
    };
  };

  await t.test('catálogo público: 404 si el slug no existe o el catálogo está apagado', async () => {
    const store = await setupStore({ storeName: 'Tienda Apagada' });
    const off = await ctx.api('PUT', '/api/catalog', { token: store.token, body: { catalog_enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.catalog_enabled, false);

    const apagada = await ctx.api('GET', `/api/public/catalog/${store.slug}`);
    assert.equal(apagada.status, 404);
    assert.match(apagada.body.error, /no tiene catálogo/);

    const desconocida = await ctx.api('GET', '/api/public/catalog/no-existe-ni-por-asomo');
    assert.equal(desconocida.status, 404);
  });

  await t.test('payload público: precios al momento, disponible/agotado, sin costos ni stock', async () => {
    const store = await setupStore();
    const res = await ctx.api('GET', `/api/public/catalog/${store.slug}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.store.name, 'Tienda de Prueba');

    const porId = new Map(res.body.products.map((p) => [p.id, p]));
    assert.equal(res.body.products.length, 3); // "Secreto" está oculto

    const pan = porId.get(store.panId);
    assert.equal(pan.available, true);
    assert.equal(pan.sale_price, 100);
    const arroz = porId.get(store.arrozId);
    assert.equal(arroz.available, false); // kg con control de stock y stock 0
    const pollo = porId.get(store.polloId);
    assert.equal(pollo.available, true); // kg sin control de stock: siempre hay

    // La regla de oro: al cliente nunca se le escapa el costo ni el stock exacto.
    for (const p of res.body.products) {
      assert.ok(!('purchase_price' in p), 'purchase_price no puede salir en el payload público');
      assert.ok(!('stock' in p), 'el stock exacto no puede salir en el payload público');
      assert.ok(!('track_stock' in p));
    }
  });

  await t.test('el precio se refleja al momento: cambiar el precio cambia el catálogo', async () => {
    const store = await setupStore({ storeName: 'Tienda Precios' });
    await ctx.api('PUT', `/api/products/${store.panId}`, { token: store.token, body: { sale_price: 150 } });
    const res = await ctx.api('GET', `/api/public/catalog/${store.slug}`);
    const pan = res.body.products.find((p) => p.id === store.panId);
    assert.equal(pan.sale_price, 150);
  });

  await t.test('reserva: items congelados y aviso push al dueño', async () => {
    const store = await setupStore({ storeName: 'Tienda Reservas' });
    await ctx.api('POST', '/api/push/register', { token: store.token, body: { platform: 'android', token: 'tok-tienda' } });
    const antes = enviados.length;
    const reservar = (body) => ctx.api('POST', `/api/public/catalog/${store.slug}/reservations`, { body });

    const rechazada = await reservar({
      client_reservation_id: `res-${suffix_()}`,
      customer_name: 'María Pérez',
      customer_phone: '53123456',
      items: [{ product_id: store.panId, quantity: 3 }, { product_id: store.arrozId, quantity: 1 }],
    });
    // El arroz está agotado: la reserva entera se rechaza (todo o nada).
    assert.equal(rechazada.status, 400);
    assert.equal(rechazada.body.items.length, 1);
    assert.match(rechazada.body.items[0].error, /Arroz.*agotado/);

    const ok = await reservar({
      client_reservation_id: `res-${suffix_()}`,
      customer_name: 'María Pérez',
      customer_phone: '53123456',
      customer_note: 'Para mañana en la tarde',
      items: [{ product_id: store.panId, quantity: 3 }],
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.status, 'pendiente');
    assert.equal(ok.body.items[0].product_name, 'Pan');
    assert.equal(ok.body.items[0].sale_price, 100);
    assert.ok(!('purchase_price' in ok.body.items[0]));

    assert.equal(enviados.length, antes + 1);
    assert.match(enviados[enviados.length - 1].title, /Reserva de María Pérez/);
  });

  await t.test('idempotencia: el mismo client_reservation_id no duplica', async () => {
    const store = await setupStore({ storeName: 'Tienda Idempotente' });
    const id = `res-idem-${suffix_()}`;
    const body = {
      client_reservation_id: id,
      customer_name: 'Luis',
      customer_phone: '53222333',
      items: [{ product_id: store.panId, quantity: 1 }],
    };
    const first = await ctx.api('POST', `/api/public/catalog/${store.slug}/reservations`, { body });
    assert.equal(first.status, 201);
    const retry = await ctx.api('POST', `/api/public/catalog/${store.slug}/reservations`, { body });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, first.body.id);

    const rows = await ctx.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM product_reservations WHERE client_reservation_id = ?',
      args: [id],
    });
    assert.equal(rows.rows[0].n, 1);
  });

  await t.test('validaciones de la reserva: nombre, teléfono, items y cantidades', async () => {
    const store = await setupStore({ storeName: 'Tienda Validaciones' });
    const reservar = (body) => ctx.api('POST', `/api/public/catalog/${store.slug}/reservations`, { body });
    assert.equal((await reservar({ customer_name: '', customer_phone: '123', items: [{ product_id: store.panId, quantity: 1 }] })).status, 400);
    assert.equal((await reservar({ customer_name: 'Ana', customer_phone: '', items: [{ product_id: store.panId, quantity: 1 }] })).status, 400);
    assert.equal((await reservar({ customer_name: 'Ana', customer_phone: '123', items: [] })).status, 400);
    // Por pieza la cantidad es entera desde 1.
    assert.equal((await reservar({ customer_name: 'Ana', customer_phone: '123', items: [{ product_id: store.panId, quantity: 0 }] })).status, 400);
    assert.equal((await reservar({ customer_name: 'Ana', customer_phone: '123', items: [{ product_id: store.panId, quantity: 1.5 }] })).status, 400);
    // Producto oculto o que no existe: fuera.
    assert.equal((await reservar({ customer_name: 'Ana', customer_phone: '123', items: [{ product_id: store.ocultoId, quantity: 1 }] })).status, 400);
    assert.equal((await reservar({ customer_name: 'Ana', customer_phone: '123', items: [{ product_id: 999999, quantity: 1 }] })).status, 400);
  });

  await t.test('límite de peticiones anónimas por IP y slug', async () => {
    const store = await setupStore({ storeName: 'Tienda Limitada' });
    for (let i = 0; i < 20; i += 1) {
      const res = await ctx.api('POST', `/api/public/catalog/${store.slug}/reservations`, { body: { customer_name: 'x' } });
      assert.equal(res.status, 400); // la validación rechaza, pero la petición cuenta
    }
    const block = await ctx.api('POST', `/api/public/catalog/${store.slug}/reservations`, { body: { customer_name: 'x' } });
    assert.equal(block.status, 429);
    assert.match(block.body.error, /Demasiadas solicitudes/);
  });

  await t.test('activar genera el slug del nombre de la tienda; dos tiendas iguales se desempatan', async () => {
    await setupStore({ storeName: 'La Esquina' });
    const b = await ctx.api('POST', '/api/auth/register', {
      body: { email: `otro-${suffix_()}@test.local`, password: 'test1234', store_name: 'La Esquina' },
    });
    const bToken = b.body.token;
    const bEnable = await ctx.api('PUT', '/api/catalog', { token: bToken, body: { catalog_enabled: true } });
    assert.equal(bEnable.status, 200);
    assert.equal(bEnable.body.catalog_slug, 'la-esquina-2');
  });

  await t.test('slug reservado, inválido y repetido', async () => {
    const store = await setupStore({ storeName: 'Tienda Slugs' });
    assert.equal((await ctx.api('PUT', '/api/catalog', { token: store.token, body: { catalog_slug: 'login' } })).status, 400);
    assert.equal((await ctx.api('PUT', '/api/catalog', { token: store.token, body: { catalog_slug: 'api' } })).status, 400);
    assert.equal((await ctx.api('PUT', '/api/catalog', { token: store.token, body: { catalog_slug: 'ab' } })).status, 400);

    const otro = await setupStore({ storeName: 'Otra Tienda Slugs' });
    const take = await ctx.api('PUT', '/api/catalog', { token: otro.token, body: { catalog_slug: store.slug } });
    assert.equal(take.status, 409);

    const ok = await ctx.api('PUT', '/api/catalog', {
      token: store.token,
      body: { catalog_slug: 'Mi  Tienda Nueva!', catalog_note: 'Aviso: entregamos en la tarde', catalog_phone: '53123456' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.catalog_slug, 'mi-tienda-nueva');
    assert.equal(ok.body.catalog_note, 'Aviso: entregamos en la tarde');
  });

  await t.test('permisos: anónimo 401, cajero 403', async () => {
    const store = await setupStore({ storeName: 'Tienda Permisos' });
    assert.equal((await ctx.api('GET', '/api/catalog')).status, 401);
    assert.equal((await ctx.api('PUT', '/api/catalog', { body: { catalog_enabled: true } })).status, 401);
    // La página pública en cambio no pide sesión (no es un 401).
    assert.notEqual((await ctx.api('GET', `/api/public/catalog/${store.slug}`)).status, 401);

    const cashier = await createCashier(ctx.api, store.token, { email: `cajero-${suffix_()}@test.local` });
    assert.equal((await ctx.api('GET', '/api/catalog', { token: cashier.token })).status, 403);
    assert.equal((await ctx.api('GET', '/api/catalog/reservations', { token: cashier.token })).status, 403);
    // Y el cajero no puede publicar productos desde el PUT de productos.
    const put = await ctx.api('PUT', `/api/products/${store.panId}`, { token: cashier.token, body: { catalog_visible: true } });
    assert.equal(put.status, 403);
  });

  await t.test('lista de reservas con el estado actual de cada producto', async () => {
    const store = await setupStore({ storeName: 'Tienda Lista' });
    const id = `res-list-${suffix_()}`;
    await ctx.api('POST', `/api/public/catalog/${store.slug}/reservations`, {
      body: { client_reservation_id: id, customer_name: 'Ana', customer_phone: '53111222', items: [{ product_id: store.panId, quantity: 2 }] },
    });

    const list = await ctx.api('GET', '/api/catalog/reservations', { token: store.token });
    assert.equal(list.status, 200);
    const row = list.body.find((r) => r.client_reservation_id === id);
    assert.equal(row.status, 'pendiente');
    assert.equal(row.items[0].current_available, true);

    // El pan se agota después: la copia congelada no cambia, pero el dueño ya ve que hoy no hay.
    await ctx.api('PUT', `/api/products/${store.panId}`, { token: store.token, body: { stock: 0 } });
    const despues = await ctx.api('GET', '/api/catalog/reservations', { token: store.token });
    const rowDespues = despues.body.find((r) => r.client_reservation_id === id);
    assert.equal(rowDespues.items[0].quantity, 2);
    assert.equal(rowDespues.items[0].sale_price, 100);
    assert.equal(rowDespues.items[0].current_available, false);

    const filtrada = await ctx.api('GET', '/api/catalog/reservations?status=pendiente', { token: store.token });
    assert.ok(filtrada.body.every((r) => r.status === 'pendiente'));
    assert.equal((await ctx.api('GET', '/api/catalog/reservations?status=raro', { token: store.token })).status, 400);
  });

  await t.test('transiciones de estado: válidas y rechazadas', async () => {
    const store = await setupStore({ storeName: 'Tienda Transiciones' });
    const crear = () => ctx.api('POST', `/api/public/catalog/${store.slug}/reservations`, {
      body: { customer_name: 'Beto', customer_phone: '53444444', items: [{ product_id: store.panId, quantity: 1 }] },
    });
    const r1 = await crear();
    const r2 = await crear();
    const r3 = await crear();
    const r4 = await crear();

    // camino feliz: pendiente -> confirmada -> entregada
    assert.equal((await ctx.api('PATCH', `/api/catalog/reservations/${r1.body.id}`, { token: store.token, body: { status: 'confirmada' } })).status, 200);
    assert.equal((await ctx.api('PATCH', `/api/catalog/reservations/${r1.body.id}`, { token: store.token, body: { status: 'entregada' } })).status, 200);
    // entregada es terminal
    assert.equal((await ctx.api('PATCH', `/api/catalog/reservations/${r1.body.id}`, { token: store.token, body: { status: 'anulada' } })).status, 400);

    // pendiente -> entregada directamente, no
    assert.equal((await ctx.api('PATCH', `/api/catalog/reservations/${r2.body.id}`, { token: store.token, body: { status: 'entregada' } })).status, 400);
    // pendiente -> anulada, sí
    assert.equal((await ctx.api('PATCH', `/api/catalog/reservations/${r3.body.id}`, { token: store.token, body: { status: 'anulada' } })).status, 200);
    // anulada no se reabre
    assert.equal((await ctx.api('PATCH', `/api/catalog/reservations/${r3.body.id}`, { token: store.token, body: { status: 'confirmada' } })).status, 400);

    assert.equal((await ctx.api('PATCH', `/api/catalog/reservations/${r4.body.id}`, { token: store.token, body: { status: 'raro' } })).status, 400);
    assert.equal((await ctx.api('PATCH', '/api/catalog/reservations/999999', { token: store.token, body: { status: 'confirmada' } })).status, 404);
    // La reserva de otra tienda no se toca.
    const otra = await setupStore({ storeName: 'Tienda Ajena' });
    assert.equal((await ctx.api('PATCH', `/api/catalog/reservations/${r2.body.id}`, { token: otra.token, body: { status: 'confirmada' } })).status, 404);
  });
});
