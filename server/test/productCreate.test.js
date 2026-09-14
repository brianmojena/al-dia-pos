const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * Alta de productos. Decisión del negocio: un empleado puede dar de alta
 * productos nuevos (el dueño delega la carga de mercancía), pero no cambiar
 * los que ya existen. Y si alguien crea uno que ya existe, se une con el
 * existente y mandan su precio y su stock.
 */

const crearCajero = async (api, tokenDueño) => {
  const email = `alta${Date.now()}${Math.random().toString(36).slice(2)}@test.local`;
  await api('POST', '/api/auth/cashiers', { token: tokenDueño, body: { email, password: 'caja1234' } });
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'caja1234' } });
  return { token: login.body.token, email };
};

const crear = (api, token, body) => api('POST', '/api/products', { token, body });
const catalogo = async (api, token) => (await api('GET', '/api/products', { token })).body;

test('alta de productos', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('un empleado puede dar de alta un producto nuevo', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño);

    const res = await crear(ctx.api, cajero.token, {
      name: 'Galletas María', sale_price: 250, purchase_price: 180, stock: 24,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.created_by_email, cajero.email, 'queda registrado quién lo dio de alta');

    const productos = await catalogo(ctx.api, dueño);
    assert.equal(productos.length, 1, 'el dueño lo ve en su catálogo');
    assert.equal(Number(productos[0].stock), 24);
    assert.equal(Number(productos[0].purchase_price), 180);
  });

  await t.test('si ya existe con el mismo nombre, se une y manda lo que ya había', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño);
    const original = await createProduct(ctx.api, dueño, { name: 'Arroz (1 lb)', stock: 40, sale_price: 130 });

    const res = await crear(ctx.api, cajero.token, { name: '  ARROZ   (1 lb) ', sale_price: 90, stock: 500 });

    assert.equal(res.status, 200);
    assert.equal(res.body.merged, true);
    assert.equal(Number(res.body.id), original, 'devuelve el existente, para que la caja lo enlace');

    const productos = await catalogo(ctx.api, dueño);
    assert.equal(productos.length, 1, 'no se duplicó');
    // Si no, crear el producto "otra vez" sería una forma de cambiar un precio
    // que el empleado no tiene permitido cambiar.
    assert.equal(Number(productos[0].sale_price), 130, 'el precio del existente se mantiene');
    assert.equal(Number(productos[0].stock), 40, 'y el stock también');
  });

  await t.test('un alta reintentada por la caja no crea un duplicado', async () => {
    const dueño = await registerUser(ctx.api);
    const cuerpo = { name: 'Refresco de lata', sale_price: 200, stock: 48 };

    // Primer intento: llegó al servidor, pero la respuesta se perdió.
    const primero = await crear(ctx.api, dueño, cuerpo);
    // La caja no lo sabe y reintenta.
    const segundo = await crear(ctx.api, dueño, cuerpo);

    assert.equal(primero.status, 201);
    assert.equal(segundo.status, 200);
    assert.equal(segundo.body.id, primero.body.id);
    assert.equal((await catalogo(ctx.api, dueño)).length, 1);
  });

  await t.test('el mismo nombre en otra tienda es otro producto', async () => {
    const tiendaA = await registerUser(ctx.api);
    const tiendaB = await registerUser(ctx.api);
    await createProduct(ctx.api, tiendaA, { name: 'Café', stock: 10, sale_price: 700 });

    const res = await crear(ctx.api, tiendaB, { name: 'Café', sale_price: 800 });
    assert.equal(res.status, 201, 'no se une con productos de otra tienda');
  });

  await t.test('valida precio, costo y stock', async () => {
    const dueño = await registerUser(ctx.api);
    for (const [cuerpo, motivo] of [
      [{ name: 'Pan' }, 'sin precio de venta'],
      [{ name: 'Pan', sale_price: 'diez' }, 'precio ilegible'],
      [{ name: 'Pan', sale_price: -5 }, 'precio negativo'],
      [{ name: 'Pan', sale_price: 50, purchase_price: -1 }, 'costo negativo'],
      [{ name: 'Pan', sale_price: 50, stock: 2.5 }, 'stock con decimales'],
      [{ name: '   ', sale_price: 50 }, 'nombre vacío'],
    ]) {
      const res = await crear(ctx.api, dueño, cuerpo);
      assert.equal(res.status, 400, motivo);
    }
    assert.equal((await catalogo(ctx.api, dueño)).length, 0);
  });
});
