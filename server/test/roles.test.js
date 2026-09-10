const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * El conteo a ciegas del cierre de caja solo vale si el cajero no puede
 * averiguar por otra vía cuánto debería haber. Estos tests fijan esa frontera:
 * un cajero puede cobrar y cerrar la caja, y nada más.
 */

const crearCajero = async (api, tokenDueño, email, password = 'cajero1234') => {
  const res = await api('POST', '/api/auth/cashiers', {
    token: tokenDueño,
    body: { email, password },
  });
  if (res.status !== 201) {
    throw new Error(`No se pudo crear el cajero: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  return { token: login.body.token, user: login.body.user, id: res.body.id };
};

test('roles: dueño y cajero', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('un cajero no puede ver el dashboard, el historial ni los cierres', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño, `caja1${Date.now()}@test.local`);

    // Justo las tres pantallas donde se podría leer el total esperado.
    const prohibidas = [
      ['GET', '/api/dashboard'],
      ['GET', '/api/sales'],
      ['GET', '/api/cash-closes'],
    ];
    for (const [method, path] of prohibidas) {
      const res = await ctx.api(method, path, { token: cajero.token });
      assert.equal(res.status, 403, `${method} ${path} debe estar prohibido para un cajero`);
    }
  });

  await t.test('un cajero no puede crear, editar ni borrar productos', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Ron', stock: 10, sale_price: 500 });
    const cajero = await crearCajero(ctx.api, dueño, `caja2${Date.now()}@test.local`);

    const crear = await ctx.api('POST', '/api/products', {
      token: cajero.token,
      body: { name: 'Inventado', sale_price: 1 },
    });
    assert.equal(crear.status, 403);

    // El caso que importa: bajarse el precio para quedarse con la diferencia.
    const editar = await ctx.api('PUT', `/api/products/${productId}`, {
      token: cajero.token,
      body: { sale_price: 1 },
    });
    assert.equal(editar.status, 403);

    const borrar = await ctx.api('DELETE', `/api/products/${productId}`, { token: cajero.token });
    assert.equal(borrar.status, 403);

    const producto = await ctx.db.execute({ sql: 'SELECT sale_price FROM products WHERE id = ?', args: [productId] });
    assert.equal(Number(producto.rows[0].sale_price), 500, 'el precio no pudo cambiarse');
  });

  await t.test('un cajero sí puede ver el catálogo, cobrar y cerrar la caja', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Café', stock: 10, sale_price: 100 });
    const cajero = await crearCajero(ctx.api, dueño, `caja3${Date.now()}@test.local`);

    // El catálogo de SU tienda, no uno vacío: es la prueba de que el ámbito se
    // resuelve al id del dueño y no al del cajero.
    const catalogo = await ctx.api('GET', '/api/products', { token: cajero.token });
    assert.equal(catalogo.status, 200);
    assert.equal(catalogo.body.length, 1);
    assert.equal(catalogo.body[0].id, productId);

    const venta = await ctx.api('POST', '/api/sales', {
      token: cajero.token,
      body: { items: [{ product_id: productId, quantity: 3, unit_price: 100 }], payment_method: 'efectivo' },
    });
    assert.equal(venta.status, 201);

    const periodo = await ctx.api('GET', '/api/cash-closes/current', { token: cajero.token });
    assert.equal(periodo.status, 200);
    assert.equal(periodo.body.has_sales, true);

    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token: cajero.token,
      body: { counted_cash: 250 },
    });
    assert.equal(cierre.status, 201);
    assert.equal(Number(cierre.body.expected_cash), 300);
    assert.equal(Number(cierre.body.difference), -50, 'el faltante queda registrado a nombre de la tienda');
  });

  await t.test('la venta del cajero pertenece a la tienda, no a su cuenta', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Sal', stock: 10, sale_price: 50 });
    const cajero = await crearCajero(ctx.api, dueño, `caja4${Date.now()}@test.local`);

    await ctx.api('POST', '/api/sales', {
      token: cajero.token,
      body: { items: [{ product_id: productId, quantity: 1, unit_price: 50 }] },
    });

    // El dueño ve la venta en SU historial aunque la haya hecho el cajero.
    const historial = await ctx.api('GET', '/api/sales', { token: dueño });
    assert.equal(historial.status, 200);
    assert.equal(historial.body.length, 1);
    assert.notEqual(Number(historial.body[0].user_id), cajero.id, 'la venta no se guarda contra la cuenta del cajero');
  });

  await t.test('/me devuelve la identidad del cajero con los ajustes de la tienda', async () => {
    const dueño = await registerUser(ctx.api);
    await ctx.api('PUT', '/api/auth/settings', {
      token: dueño,
      body: { transfer_limit: 8000, usd_rate: 640 },
    });

    const email = `caja5${Date.now()}@test.local`;
    const cajero = await crearCajero(ctx.api, dueño, email);

    const me = await ctx.api('GET', '/api/auth/me', { token: cajero.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, email, 'su propia identidad');
    assert.equal(me.body.user.role, 'cajero');
    // Y los ajustes del negocio, que el POS necesita para cobrar.
    assert.equal(Number(me.body.user.transfer_limit), 8000);
    assert.equal(Number(me.body.user.usd_rate), 640);
    assert.equal(me.body.user.store_name, 'Tienda de Prueba');
  });

  await t.test('un cajero no puede cambiar los ajustes del negocio ni crear otros cajeros', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño, `caja6${Date.now()}@test.local`);

    const ajustes = await ctx.api('PUT', '/api/auth/settings', {
      token: cajero.token,
      body: { transfer_limit: 999999 },
    });
    assert.equal(ajustes.status, 403);

    const nuevoCajero = await ctx.api('POST', '/api/auth/cashiers', {
      token: cajero.token,
      body: { email: 'colado@test.local', password: 'colado1234' },
    });
    assert.equal(nuevoCajero.status, 403, 'un cajero no puede fabricarse cuentas');
  });

  await t.test('un dueño no puede borrar el cajero de otra tienda', async () => {
    const dueñoA = await registerUser(ctx.api);
    const dueñoB = await registerUser(ctx.api);
    const cajeroA = await crearCajero(ctx.api, dueñoA, `caja7${Date.now()}@test.local`);

    const intento = await ctx.api('DELETE', `/api/auth/cashiers/${cajeroA.id}`, { token: dueñoB });
    assert.equal(intento.status, 404, 'para B, ese cajero sencillamente no existe');

    const sigueVivo = await ctx.api('GET', '/api/auth/cashiers', { token: dueñoA });
    assert.equal(sigueVivo.body.length, 1);
  });

  await t.test('los tokens emitidos antes de que existieran los roles siguen valiendo como dueño', async () => {
    const jwt = require('jsonwebtoken');
    const dueño = await registerUser(ctx.api);
    const { userId } = jwt.verify(dueño, process.env.JWT_SECRET);

    // Token viejo: solo lleva userId, sin accountId ni role.
    const tokenViejo = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });

    const dashboard = await ctx.api('GET', '/api/dashboard', { token: tokenViejo });
    assert.equal(dashboard.status, 200, 'nadie tiene que volver a iniciar sesión por este cambio');

    const me = await ctx.api('GET', '/api/auth/me', { token: tokenViejo });
    assert.equal(me.body.user.role, 'dueño');
  });
});
