const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * El dueño mira su teléfono desde otro lado y lo que necesita saber no es solo
 * "cuánto se vendió" sino "¿cuadró todo?". Ese estado viaja dentro de
 * /api/dashboard para que la app resuelva su pantalla con una sola petición.
 */

const crearCajero = async (api, tokenDueño, email, password = 'cajero1234') => {
  await api('POST', '/api/auth/cashiers', { token: tokenDueño, body: { email, password } });
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  return { token: login.body.token, email };
};

const vender = (api, token, productId, unit_price = 100) =>
  api('POST', '/api/sales', {
    token,
    body: { items: [{ product_id: productId, quantity: 1, unit_price }], payment_method: 'efectivo' },
  });

const cambioDeTurno = () => new Promise((r) => setTimeout(r, 1100));

test('estado de arqueos en el dashboard', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('sin arqueos todavía, viene vacío pero presente', async () => {
    const token = await registerUser(ctx.api);
    const res = await ctx.api('GET', '/api/dashboard', { token });

    assert.equal(res.status, 200);
    assert.equal(res.body.audit.lastCashClose, null);
    assert.equal(res.body.audit.lastInventoryCount, null);
    assert.deepEqual(res.body.audit.cashierSummary, [], 'la app no tiene que lidiar con campos ausentes');
  });

  await t.test('trae el último descuadre de caja con quién lo hizo', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Ron', stock: 20, sale_price: 100 });
    const cajero = await crearCajero(ctx.api, dueño, `da1${Date.now()}@test.local`);

    await vender(ctx.api, cajero.token, productId);
    await ctx.api('POST', '/api/cash-closes', { token: cajero.token, body: { counted_cash: 75 } });

    const res = await ctx.api('GET', '/api/dashboard', { token: dueño });
    const cierre = res.body.audit.lastCashClose;

    assert.equal(Number(cierre.difference), -25);
    assert.equal(cierre.account_email, cajero.email, 'el dueño ve de un vistazo en qué turno pasó');
  });

  await t.test('trae el último arqueo de inventario con lo que falta', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Café', stock: 10, sale_price: 750 });

    await ctx.api('POST', '/api/inventory-counts', {
      token: dueño,
      body: { items: [{ product_id: productId, counted: 8 }] },
    });

    const res = await ctx.api('GET', '/api/dashboard', { token: dueño });
    const arqueo = res.body.audit.lastInventoryCount;

    assert.equal(Number(arqueo.units_missing), 2);
    assert.equal(Number(arqueo.value_missing), 1500);
  });

  await t.test('el resumen por cajero solo aparece si hay más de uno', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Pan', stock: 50, sale_price: 100 });
    const uno = await crearCajero(ctx.api, dueño, `da4a${Date.now()}@test.local`);

    // Con un solo cajero, el "patrón" es la misma información que el último
    // cierre: mostrarlo sería ruido.
    await vender(ctx.api, uno.token, productId);
    await ctx.api('POST', '/api/cash-closes', { token: uno.token, body: { counted_cash: 100 } });

    let res = await ctx.api('GET', '/api/dashboard', { token: dueño });
    assert.deepEqual(res.body.audit.cashierSummary, []);

    await cambioDeTurno();

    const dos = await crearCajero(ctx.api, dueño, `da4b${Date.now()}@test.local`);
    await vender(ctx.api, dos.token, productId);
    await ctx.api('POST', '/api/cash-closes', { token: dos.token, body: { counted_cash: 60 } });

    res = await ctx.api('GET', '/api/dashboard', { token: dueño });
    const resumen = res.body.audit.cashierSummary;
    assert.equal(resumen.length, 2, 'con dos turnos el patrón ya dice algo');
    assert.equal(resumen[0].account_email, dos.email, 'el peor saldo primero');
    assert.equal(Number(resumen[0].total_difference), -40);
  });

  await t.test('un cajero no puede pedir el dashboard', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño, `da5${Date.now()}@test.local`);

    const res = await ctx.api('GET', '/api/dashboard', { token: cajero.token });
    assert.equal(res.status, 403, 'el estado de los arqueos es información del dueño');
  });
});
