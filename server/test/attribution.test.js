const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * Sin atribución, "faltaron 12.000 pesos este mes" no se puede accionar. Con
 * ella, "los faltantes aparecen siempre en el mismo turno" sí. Estos tests
 * cubren que quede registrada y —lo más importante— que SOBREVIVA a que el
 * dueño borre la cuenta del cajero.
 */

const crearCajero = async (api, tokenDueño, email, password = 'cajero1234') => {
  const creado = await api('POST', '/api/auth/cashiers', { token: tokenDueño, body: { email, password } });
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  return { id: creado.body.id, token: login.body.token, email };
};

const vender = (api, token, productId, unit_price = 100) =>
  api('POST', '/api/sales', {
    token,
    body: { items: [{ product_id: productId, quantity: 1, unit_price }], payment_method: 'efectivo' },
  });

// La frontera entre cierres tiene resolución de un segundo (created_at > corte
// anterior), así que entre un turno y el siguiente hay que dejar pasar algo
// más de un segundo para que la venta caiga inequívocamente en el período nuevo.
const cambioDeTurno = () => new Promise((r) => setTimeout(r, 1100));

test('atribución por cuenta', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('cada venta guarda quién la cobró', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Ron', stock: 20, sale_price: 100 });
    const cajero = await crearCajero(ctx.api, dueño, `at1${Date.now()}@test.local`);

    await vender(ctx.api, dueño, productId);
    await vender(ctx.api, cajero.token, productId);

    const historial = await ctx.api('GET', '/api/sales', { token: dueño });
    const porCuenta = Object.fromEntries(historial.body.map(v => [v.account_email, v.total]));

    assert.ok(cajero.email in porCuenta, 'la venta del cajero queda a su nombre');
    assert.equal(Object.keys(porCuenta).length, 2, 'dueño y cajero se distinguen');
  });

  await t.test('el cierre de caja guarda quién contó', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Café', stock: 20, sale_price: 100 });
    const cajero = await crearCajero(ctx.api, dueño, `at2${Date.now()}@test.local`);

    await vender(ctx.api, cajero.token, productId);
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token: cajero.token,
      body: { counted_cash: 80 },   // faltan 20
    });

    assert.equal(cierre.body.account_email, cajero.email);
    assert.equal(Number(cierre.body.difference), -20);
  });

  await t.test('el arqueo de inventario guarda quién contó', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Sal', stock: 10, sale_price: 40 });

    const arqueo = await ctx.api('POST', '/api/inventory-counts', {
      token: dueño,
      body: { items: [{ product_id: productId, counted: 8 }] },
    });

    assert.ok(arqueo.body.account_email, 'queda registrado quién hizo el arqueo');
    assert.equal(Number(arqueo.body.units_missing), 2);
  });

  await t.test('borrar al cajero NO borra la evidencia', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Aceite', stock: 20, sale_price: 100 });
    const cajero = await crearCajero(ctx.api, dueño, `at4${Date.now()}@test.local`);

    await vender(ctx.api, cajero.token, productId);
    await ctx.api('POST', '/api/cash-closes', { token: cajero.token, body: { counted_cash: 50 } });

    // El dueño lo pilla y le quita el acceso.
    const borrado = await ctx.api('DELETE', `/api/auth/cashiers/${cajero.id}`, { token: dueño });
    assert.equal(borrado.status, 200);

    // Justo por esto el email va congelado en la fila y no se resuelve por
    // JOIN: si dependiera de la fila de users, el faltante quedaría huérfano
    // exactamente cuando más importa.
    const cierres = await ctx.api('GET', '/api/cash-closes', { token: dueño });
    assert.equal(cierres.body[0].account_email, cajero.email, 'el cierre sigue diciendo quién fue');
    assert.equal(Number(cierres.body[0].difference), -50);

    const ventas = await ctx.api('GET', '/api/sales', { token: dueño });
    assert.equal(ventas.body[0].account_email, cajero.email, 'la venta también');
  });

  await t.test('el resumen agrupa los descuadres por cajero', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Pan', stock: 100, sale_price: 100 });
    const honesta = await crearCajero(ctx.api, dueño, `ok${Date.now()}@test.local`);
    const sospechoso = await crearCajero(ctx.api, dueño, `mal${Date.now()}@test.local`);

    // Turno 1: cuadra.
    await vender(ctx.api, honesta.token, productId);
    await ctx.api('POST', '/api/cash-closes', { token: honesta.token, body: { counted_cash: 100 } });
    await cambioDeTurno();

    // Turno 2: falta.
    await vender(ctx.api, sospechoso.token, productId);
    await ctx.api('POST', '/api/cash-closes', { token: sospechoso.token, body: { counted_cash: 70 } });
    await cambioDeTurno();

    // Turno 3: vuelve a faltar, el mismo.
    await vender(ctx.api, sospechoso.token, productId);
    await ctx.api('POST', '/api/cash-closes', { token: sospechoso.token, body: { counted_cash: 60 } });

    const resumen = await ctx.api('GET', '/api/cash-closes/summary', { token: dueño });
    assert.equal(resumen.status, 200);

    // Ordenado por saldo acumulado: el peor primero, que es lo que el dueño
    // necesita ver sin tener que leer 100 cierres.
    const peor = resumen.body[0];
    assert.equal(peor.account_email, sospechoso.email);
    assert.equal(Number(peor.closes), 2);
    assert.equal(Number(peor.times_short), 2);
    assert.equal(Number(peor.total_difference), -70, '−30 y −40');
    assert.equal(Number(peor.worst_difference), -40);

    const buena = resumen.body.find(r => r.account_email === honesta.email);
    assert.equal(Number(buena.times_short), 0);
    assert.equal(Number(buena.total_difference), 0);
  });

  await t.test('un cajero no puede ver el resumen', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño, `at6${Date.now()}@test.local`);

    const res = await ctx.api('GET', '/api/cash-closes/summary', { token: cajero.token });
    assert.equal(res.status, 403, 'saber cuánto ha descuadrado es información del dueño');
  });

  await t.test('las ventas viejas sin atribución no rompen nada', async () => {
    const dueño = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, dueño, { name: 'Azúcar', stock: 10, sale_price: 50 });

    // Una venta anterior a esta función: existe, pero nadie sabe quién la hizo.
    await ctx.db.execute({
      sql: `INSERT INTO sales (user_id, total, profit, payment_method) VALUES (?, ?, ?, 'efectivo')`,
      args: [1, 50, 20],
    });

    await vender(ctx.api, dueño, productId, 50);

    const ventas = await ctx.api('GET', '/api/sales', { token: dueño });
    assert.equal(ventas.status, 200, 'el historial sigue cargando');
    assert.ok(ventas.body.length >= 1);
  });
});
