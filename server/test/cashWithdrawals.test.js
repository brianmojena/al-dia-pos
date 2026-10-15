const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');
const { businessToday } = require('../lib/businessDay');

/**
 * Extracciones de caja. Lo que no puede fallar:
 *   1. solo el dueño puede crear o anular extracciones;
 *   2. el arqueo resta las extracciones abiertas de lo esperado;
 *   3. una extracción anulada antes del cierre vuelve a abrir el efectivo;
 *   4. una extracción cubierta por cierre no se puede anular;
 *   5. es idempotente y propaga al desktop/PWA en el sync.
 */
test('extracciones de caja', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const extraer = (token, body) => ctx.api('POST', '/api/cash-withdrawals', {
    token, body: { register_id: 'web', ...body },
  });

  const anular = (token, clientWithdrawalId) => ctx.api('POST', `/api/cash-withdrawals/${clientWithdrawalId}/void`, {
    token,
  });

  await t.test('guarda la extracción con idempotencia', async () => {
    const token = await registerUser(ctx.api);
    const body = { client_withdrawal_id: 'ext-1', method: 'efectivo', amount: 1000, note: 'Cambio' };
    const first = await extraer(token, body);
    const second = await extraer(token, body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(first.body.id, second.body.id);
    assert.ok(second.body.idempotent_replay);
    assert.equal(first.body.method, 'efectivo');
    assert.equal(Number(first.body.amount), 1000);
    assert.equal(first.body.note, 'Cambio');
    assert.equal(first.body.cash_close_id, null);
    assert.equal(first.body.voided_at, null);
  });

  await t.test('rechaza extracciones incompletas', async () => {
    const token = await registerUser(ctx.api);
    for (const malo of [
      { method: 'CAD', amount: 100 },
      { method: 'efectivo', amount: 0 },
      { method: 'efectivo', amount: -100 },
      { method: 'transferencia', amount: null },
    ]) {
      const res = await extraer(token, { client_withdrawal_id: `ext-${Math.random()}`, ...malo });
      assert.equal(res.status, 400, JSON.stringify(malo));
    }
  });

  await t.test('requiere client_withdrawal_id', async () => {
    const token = await registerUser(ctx.api);
    const res = await ctx.api('POST', '/api/cash-withdrawals', {
      token, body: { method: 'efectivo', amount: 100 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('client_withdrawal_id'));
  });

  await t.test('solo el dueño puede extraer', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);
    const res = await extraer(cashier, { client_withdrawal_id: 'ext-1', method: 'efectivo', amount: 100 });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Solo el dueño puede extraer dinero');
  });

  await t.test('(a) el caso real: cajero vende 10000, dueño retira 2000, cierre cuadra', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);

    // Cajero registra 10000 en ventas en su caja
    const producto = await createProduct(ctx.api, owner, { name: 'Pan', stock: 100, sale_price: 1000 });
    const venta = await ctx.api('POST', '/api/sales', {
      token: cashier,
      body: { register_id: 'web', items: [{ product_id: producto, quantity: 10, unit_price: 1000 }], payment_method: 'efectivo' },
    });
    assert.equal(venta.status, 201);

    // Dueño retira 2000
    const ext = await extraer(owner, { client_withdrawal_id: 'ext-real', method: 'efectivo', amount: 2000 });
    assert.equal(ext.status, 201);

    // Cajero cierra caja con counted_cash 8000 (10000 - 2000)
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token: cashier, body: { register_id: 'web', opening_float: 0, counted_cash: 8000 },
    });
    assert.equal(cierre.status, 201);
    assert.equal(Number(cierre.body.expected_cash), 8000); // 0 float + 10000 sales - 2000 withdrawn
    assert.equal(Number(cierre.body.difference), 0); // cuadra perfecto
    assert.equal(Number(cierre.body.withdrawn_cash), 2000);

    // La extracción está cubierta por el cierre del cajero
    const list = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
    const found = list.body.find((w) => w.client_withdrawal_id === 'ext-real');
    assert.equal(Number(found.cash_close_id), cierre.body.id);
  });

  await t.test('(b) cashier obtiene 403 en POST y void con mensaje exacto', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);

    // POST
    const postRes = await extraer(cashier, { client_withdrawal_id: 'ext-403-post', method: 'efectivo', amount: 100 });
    assert.equal(postRes.status, 403);
    assert.equal(postRes.body.error, 'Solo el dueño puede extraer dinero');

    // void
    const ext = await extraer(owner, { client_withdrawal_id: 'ext-403-void', method: 'efectivo', amount: 100 });
    const voidRes = await anular(cashier, 'ext-403-void');
    assert.equal(voidRes.status, 403);
    assert.equal(voidRes.body.error, 'Solo el dueño puede extraer dinero');
  });

  await t.test('(c) extracción anulada NO se cubre, no baja holdings', async () => {
    const token = await registerUser(ctx.api);

    // Crear dos extracciones
    const ext1 = await extraer(token, { client_withdrawal_id: 'ext-void-a', method: 'efectivo', amount: 1000 });
    const ext2 = await extraer(token, { client_withdrawal_id: 'ext-void-b', method: 'efectivo', amount: 500 });

    // Anular la primera
    await anular(token, 'ext-void-a');

    // Dashboard no debe tener la anulada
    const dash1 = await ctx.api('GET', '/api/dashboard', { token });
    assert.equal(dash1.body.holdings.cash, -500); // solo la segunda
    assert.equal(dash1.body.open_withdrawals.length, 1); // solo la segunda

    // Cerrar caja
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token, body: { register_id: 'web', opening_float: 0, counted_cash: 0 },
    });
    assert.equal(Number(cierre.body.withdrawn_cash), 500); // solo la segunda

    // La anulada no quedó cubierta
    const list = await ctx.api('GET', '/api/cash-withdrawals', { token });
    const voided = list.body.find((w) => w.client_withdrawal_id === 'ext-void-a');
    assert.equal(voided.cash_close_id, null);
  });

  await t.test('(d) GET /current no expone amounts ni withdrawn al cajero', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);

    // Dueño retira
    await extraer(owner, { client_withdrawal_id: 'ext-blind', method: 'efectivo', amount: 2000 });

    // Cashier pide current: no debe tener amounts
    const current = await ctx.api('GET', '/api/cash-closes/current?register_id=web', { token: cashier });
    assert.equal(current.status, 200);
    assert.ok('has_sales' in current.body);
    assert.ok(!('expected_cash' in current.body));
    assert.ok(!('withdrawn_cash' in current.body));
    assert.ok(!('difference' in current.body));
  });

  await t.test('el dashboard resta extracciones del efectivo disponible', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Pan', stock: 5, sale_price: 1000 });
    await ctx.api('POST', '/api/sales', {
      token, body: { register_id: 'web', items: [{ product_id: producto, quantity: 2, unit_price: 1000 }], payment_method: 'efectivo' },
    });
    await extraer(token, { client_withdrawal_id: 'ext-1', method: 'efectivo', amount: 500 });

    const dashboard = await ctx.api('GET', '/api/dashboard', { token });
    assert.equal(dashboard.body.holdings.cash, 2000 - 500); // 2 ventas de 1000 menos 500 extraído
    assert.equal(dashboard.body.open_withdrawals.length, 1);
    assert.equal(Number(dashboard.body.open_withdrawals[0].amount), 500);
  });

  await t.test('extracciones en USD, EUR y transferencia también restan del dashboard', async () => {
    const token = await registerUser(ctx.api);
    await extraer(token, { client_withdrawal_id: 'ext-usd', method: 'USD', amount: 100 });
    await extraer(token, { client_withdrawal_id: 'ext-eur', method: 'EUR', amount: 50 });
    await extraer(token, { client_withdrawal_id: 'ext-tr', method: 'transferencia', amount: 5000 });

    const dashboard = await ctx.api('GET', '/api/dashboard', { token });
    assert.equal(dashboard.body.holdings.cash, 0);
    assert.equal(dashboard.body.holdings.transfer, -5000);
    assert.equal(dashboard.body.holdings.usd, -100);
    assert.equal(dashboard.body.holdings.eur, -50);
  });

  await t.test('anular abre la extracción antes del cierre', async () => {
    const token = await registerUser(ctx.api);
    const res = await extraer(token, { client_withdrawal_id: 'ext-void', method: 'efectivo', amount: 2000 });
    assert.equal(res.status, 201);

    const anulada = await anular(token, 'ext-void');
    assert.equal(anulada.status, 200);
    assert.ok(anulada.body.voided_at);

    const dashboard = await ctx.api('GET', '/api/dashboard', { token });
    assert.equal(dashboard.body.holdings.cash, 0); // ya no se resta si está anulada
  });

  await t.test('anular después del cierre es idempotente pero devuelve 409', async () => {
    const token = await registerUser(ctx.api);
    const producto = await createProduct(ctx.api, token, { name: 'Pan', stock: 5, sale_price: 1000 });
    await ctx.api('POST', '/api/sales', {
      token, body: { register_id: 'web', items: [{ product_id: producto, quantity: 1, unit_price: 1000 }], payment_method: 'efectivo' },
    });
    const ext = await extraer(token, { client_withdrawal_id: 'ext-after-close', method: 'efectivo', amount: 500 });

    // Cerrar la caja
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token, body: { register_id: 'web', opening_float: 0, counted_cash: 500 },
    });
    assert.equal(cierre.status, 201);
    assert.equal(Number(cierre.body.withdrawn_cash), 500);

    // Ahora el cierre cubrió la extracción, no se puede anular
    const res = await anular(token, 'ext-after-close');
    assert.equal(res.status, 409);
    assert.ok(res.body.error.includes('cierre de caja'));
  });

  await t.test('el arqueo cubre extracciones y llena withdrawn_*', async () => {
    const token = await registerUser(ctx.api);

    await extraer(token, { client_withdrawal_id: 'ext-cash', method: 'efectivo', amount: 2000 });
    await extraer(token, { client_withdrawal_id: 'ext-usd', method: 'USD', amount: 50 });

    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token, body: { register_id: 'web', opening_float: 10000, counted_cash: 8000, counted_usd: 50 },
    });
    assert.equal(cierre.status, 201);
    assert.equal(Number(cierre.body.withdrawn_cash), 2000);
    assert.equal(Number(cierre.body.withdrawn_usd), 50);
    assert.equal(Number(cierre.body.withdrawn_transfer), 0);
    assert.equal(Number(cierre.body.withdrawn_eur), 0);
  });

  await t.test('el día incluye las extracciones creadas ese día', async () => {
    const token = await registerUser(ctx.api);
    await extraer(token, { client_withdrawal_id: 'ext-day', method: 'efectivo', amount: 500 });

    const today = businessToday();
    const day = await ctx.api('GET', `/api/dashboard/day?date=${today}`, { token });
    assert.equal(day.body.withdrawals.length, 1);
    assert.equal(Number(day.body.withdrawals[0].amount), 500);
  });

  await t.test('el sincronizador desktop incluye las extracciones', async () => {
    const token = await registerUser(ctx.api);
    await extraer(token, { client_withdrawal_id: 'ext-sync', method: 'efectivo', amount: 1000 });

    const snapshot = await ctx.api('GET', '/api/sync/snapshot', { token });
    assert.ok(Array.isArray(snapshot.body.cash_withdrawals));

    const delta = await ctx.api('GET', '/api/sync/delta?after_withdrawal=0', { token });
    assert.ok(Array.isArray(delta.body.cash_withdrawals));
    assert.ok(Number.isInteger(delta.body.cursors.withdrawal));
  });

  await t.test('cierre cubre extracciones de toda la tienda', async () => {
    const token = await registerUser(ctx.api);

    // Extracción (se hace en cualquier lado)
    const ext = await extraer(token, { client_withdrawal_id: 'ext-coverage', method: 'efectivo', amount: 500 });
    assert.equal(ext.body.cash_close_id, null);

    // Cierre en otra caja también la cubre
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token, body: { register_id: 'caja2', opening_float: 0, counted_cash: 0 },
    });
    assert.equal(cierre.status, 201);

    // Verificar que la extracción quedó cubierta
    const list = await ctx.api('GET', '/api/cash-withdrawals', { token });
    const found = list.body.find((w) => w.client_withdrawal_id === 'ext-coverage');
    assert.ok(found);
    assert.equal(Number(found.cash_close_id), cierre.body.id);
  });

  await t.test('(e) dashboard open_withdrawals tiene client_withdrawal_id, note, created_at, newest first', async () => {
    const token = await registerUser(ctx.api);

    // Crear varias extracciones con delays para que tengan timestamps diferentes
    const ext1 = await extraer(token, { client_withdrawal_id: 'ext-list-1', method: 'efectivo', amount: 100, note: 'Cambio 1' });
    const ext2 = await extraer(token, { client_withdrawal_id: 'ext-list-2', method: 'efectivo', amount: 200, note: 'Cambio 2' });
    const ext3 = await extraer(token, { client_withdrawal_id: 'ext-list-3', method: 'efectivo', amount: 300, note: 'Cambio 3' });

    const dashboard = await ctx.api('GET', '/api/dashboard', { token });
    assert.ok(Array.isArray(dashboard.body.open_withdrawals));
    assert.equal(dashboard.body.open_withdrawals.length, 3);

    // Verificar que cada uno tiene los campos requeridos
    for (const w of dashboard.body.open_withdrawals) {
      assert.ok('client_withdrawal_id' in w, `falta client_withdrawal_id en ${JSON.stringify(w)}`);
      assert.ok('note' in w);
      assert.ok('created_at' in w);
      assert.ok('amount' in w);
      assert.ok('method' in w);
    }

    // Verificar que están ordenados por newest first (id descendente es proxy de created_at DESC)
    const ids = dashboard.body.open_withdrawals.map((w) => w.id);
    assert.ok(ids[0] > ids[1], 'primera debe tener id mayor (más nueva)');
    assert.ok(ids[1] > ids[2], 'segunda debe tener id mayor que tercera');
  });

  await t.test('el cajero solo obtiene 403, no puede extraer', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);

    const res = await ctx.api('GET', '/api/cash-withdrawals', { token: cashier });
    assert.equal(res.status, 403);
  });
});
