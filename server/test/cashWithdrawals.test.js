const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');
const { businessToday } = require('../lib/businessDay');
const { withdrawalInScope, withdrawalScopeSql } = require('../lib/withdrawalScope');

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

  await t.test('cajero puede crear salida en efectivo con nota', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);
    const res = await extraer(cashier, { client_withdrawal_id: 'ext-cashier-1', method: 'efectivo', amount: 500, note: 'Compra de pan' });
    assert.equal(res.status, 201);
    assert.equal(res.body.method, 'efectivo');
    assert.equal(Number(res.body.amount), 500);
    assert.equal(res.body.note, 'Compra de pan');
  });

  await t.test('cajero sin nota → 400 Escribe para qué fue el dinero', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);
    const res = await extraer(cashier, { client_withdrawal_id: 'ext-no-note', method: 'efectivo', amount: 100 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Escribe para qué fue el dinero');
  });

  await t.test('cajero con nota muy corta (< 3 caracteres) → 400', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);
    const res = await extraer(cashier, { client_withdrawal_id: 'ext-short-note', method: 'efectivo', amount: 100, note: 'ab' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Escribe para qué fue el dinero');
  });

  await t.test('cajero con method USD → 403 Los cajeros solo pueden sacar efectivo', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);
    const res = await extraer(cashier, { client_withdrawal_id: 'ext-usd-cashier', method: 'USD', amount: 50, note: 'Cambio USD' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Los cajeros solo pueden sacar efectivo');
  });

  await t.test('cajero con method transferencia → 403', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);
    const res = await extraer(cashier, { client_withdrawal_id: 'ext-transfer-cashier', method: 'transferencia', amount: 1000, note: 'Transferencia' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Los cajeros solo pueden sacar efectivo');
  });

  await t.test('retiro legado de cuenta propia entra; retiro global ambiguo queda para el dueño', async () => {
    const ownerEmail = `owner-${Date.now()}@test.local`;
    const owner = await registerUser(ctx.api, ownerEmail);
    const { token: cashier, email: cashierEmail } = await createCashier(ctx.api, owner);
    const ownLegacy = await extraer(cashier, {
      client_withdrawal_id: 'legacy-own-cashier', register_id: null,
      method: 'efectivo', amount: 40, note: 'Legado propio',
    });
    assert.equal(ownLegacy.status, 201);

    const user = await ctx.db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [ownerEmail] });
    await ctx.db.execute({
      sql: `INSERT INTO cash_withdrawals
              (user_id, client_withdrawal_id, method, amount, register_id, account_id, account_email)
            VALUES (?, 'legacy-email-only', 'efectivo', 7, NULL, NULL, ?)`,
      args: [Number(user.rows[0].id), cashierEmail],
    });
    await ctx.db.execute({
      sql: `INSERT INTO cash_withdrawals
              (user_id, client_withdrawal_id, method, amount, note, register_id, account_id, account_email)
            VALUES (?, ?, 'efectivo', 60, 'Sin origen', NULL, NULL, NULL)`,
      args: [Number(user.rows[0].id), 'legacy-ambiguous'],
    });

    const current = await ctx.api('GET', '/api/cash-closes/current?register_id=web', { token: cashier });
    assert.equal(current.status, 200);
    assert.equal(current.body.has_sales, true); // solo el retiro legado atribuible a su cuenta
    const snapshot = await ctx.api('GET', '/api/sync/snapshot', { token: cashier });
    assert.equal(snapshot.body.cash_withdrawals.reduce((sum, row) => sum + Number(row.amount), 0), 47, 'la sincronización y el cierre reconocen el mismo legado verificado por correo');
    const cashierClose = await ctx.api('POST', '/api/cash-closes', {
      token: cashier, body: { register_id: 'web', opening_float: 0, counted_cash: 0 },
    });
    assert.equal(cashierClose.status, 201);
    assert.equal(Number(cashierClose.body.withdrawn_cash), 47);

    const ownerClose = await ctx.api('POST', '/api/cash-closes', {
      token: owner, body: { register_id: 'web', opening_float: 0, counted_cash: 0 },
    });
    assert.equal(ownerClose.status, 201);
    assert.equal(Number(ownerClose.body.withdrawn_cash), 60);
  });

  await t.test('shared register exige coincidencia exacta y no incorpora legado de la cuenta', async () => {
    const scope = { registerId: 'shared:device-1:7', accountId: null, includeLegacy: false };
    assert.equal(withdrawalInScope({ register_id: 'shared:device-1:7', account_id: 7 }, scope), true);
    assert.equal(withdrawalInScope({ register_id: null, account_id: 7 }, scope), false);
    assert.equal(withdrawalInScope({ register_id: 'shared:device-2:7', account_id: 7 }, scope), false);
    assert.deepEqual(withdrawalScopeSql(scope), { sql: 'register_id = ?', args: ['shared:device-1:7'] });
  });

  await t.test('cierre desktop cubre solo client_withdrawal_ids capturados offline', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);
    const productId = await createProduct(ctx.api, owner, { name: 'Pan offline', stock: 10, sale_price: 100 });
    const saleId = 'desktop-close-sale-snapshot';
    const sale = await ctx.api('POST', '/api/sales', {
      token: cashier,
      body: { client_sale_id: saleId, register_id: 'web', items: [{ product_id: productId, quantity: 1, unit_price: 100 }], payment_method: 'efectivo' },
    });
    assert.equal(sale.status, 201);
    const captured = await extraer(cashier, { client_withdrawal_id: 'desktop-captured', amount: 20, method: 'efectivo', note: 'Antes corte' });
    const later = await extraer(cashier, { client_withdrawal_id: 'desktop-later', amount: 30, method: 'efectivo', note: 'Después corte' });

    const close = await ctx.api('POST', '/api/cash-closes', {
      token: cashier,
      body: {
        client_close_id: 'desktop-explicit-withdrawals', register_id: 'web', client_sale_ids: [saleId],
        client_withdrawal_ids: [captured.body.client_withdrawal_id], counted_cash: 80,
      },
    });
    assert.equal(close.status, 201);
    assert.equal(Number(close.body.expected_cash), 80);
    assert.equal(Number(close.body.withdrawn_cash), 20);
    const rows = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
    assert.equal(Number(rows.body.find((w) => w.client_withdrawal_id === 'desktop-captured').cash_close_id), close.body.id);
    assert.equal(rows.body.find((w) => w.client_withdrawal_id === 'desktop-later').cash_close_id, null);
    assert.ok(later.body.id);
  });

  await t.test('covered_withdrawal_ids web fija el conjunto fotografiado y rechaza IDs ajenos', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashierA } = await createCashier(ctx.api, owner);
    const { token: cashierB } = await createCashier(ctx.api, owner);
    const captured = await extraer(cashierA, { client_withdrawal_id: 'web-captured', amount: 20, method: 'efectivo', note: 'Antes corte' });
    const later = await extraer(cashierA, { client_withdrawal_id: 'web-later', amount: 30, method: 'efectivo', note: 'Después corte' });
    const foreign = await extraer(cashierB, { client_withdrawal_id: 'web-foreign', amount: 40, method: 'efectivo', note: 'Otra caja' });

    const close = await ctx.api('POST', '/api/cash-closes', {
      token: cashierA,
      body: { register_id: 'web', counted_cash: 0, covered_withdrawal_ids: [captured.body.id] },
    });
    assert.equal(close.status, 201);
    assert.equal(Number(close.body.withdrawn_cash), 20);
    const conflict = await ctx.api('POST', '/api/cash-closes', {
      token: cashierA,
      body: { register_id: 'web', counted_cash: 0, covered_withdrawal_ids: [foreign.body.id] },
    });
    assert.equal(conflict.status, 409);
    const rows = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
    assert.equal(rows.body.find((w) => w.client_withdrawal_id === 'web-later').cash_close_id, null);
    assert.equal(rows.body.find((w) => w.client_withdrawal_id === 'web-foreign').cash_close_id, null);
    assert.ok(later.body.id);
  });

  await t.test('un client_withdrawal_id de otra cuenta no devuelve ni reutiliza su fila', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashierA } = await createCashier(ctx.api, owner);
    const { token: cashierB } = await createCashier(ctx.api, owner);
    const first = await extraer(cashierA, {
      client_withdrawal_id: 'replay-cross-account', method: 'efectivo', amount: 100, note: 'Caja A',
    });
    assert.equal(first.status, 201);
    const replay = await extraer(cashierB, {
      client_withdrawal_id: 'replay-cross-account', method: 'efectivo', amount: 900, note: 'Caja B',
    });
    assert.equal(replay.status, 409);
    assert.match(replay.body.error, /otra caja o cuenta/);
  });

  await t.test('(a) un retiro del dueño sin origen de gaveta no se asigna al cajero', async () => {
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

    // La extracción del dueño no tiene origen de gaveta y queda fuera del
    // cierre del cajero; no se debe adjudicar al primer cierre que ocurra.
    const cierre = await ctx.api('POST', '/api/cash-closes', {
      token: cashier, body: { register_id: 'web', opening_float: 0, counted_cash: 10000 },
    });
    assert.equal(cierre.status, 201);
    assert.equal(Number(cierre.body.expected_cash), 10000);
    assert.equal(Number(cierre.body.difference), 0);
    assert.equal(Number(cierre.body.withdrawn_cash), 0);

    // La extracción sigue abierta y el dueño la consolida en su cierre.
    const list = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
    const found = list.body.find((w) => w.client_withdrawal_id === 'ext-real');
    assert.equal(found.cash_close_id, null);
    const cierreDueno = await ctx.api('POST', '/api/cash-closes', {
      token: owner, body: { register_id: 'web', opening_float: 0, counted_cash: 0 },
    });
    assert.equal(cierreDueno.status, 201);
    assert.equal(Number(cierreDueno.body.withdrawn_cash), 2000);
    const listAfter = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
    assert.equal(Number(listAfter.body.find((w) => w.client_withdrawal_id === 'ext-real').cash_close_id), cierreDueno.body.id);
  });

  await t.test('cierres A y B dan el mismo resultado en cualquier orden y no se roban retiros ajenos', async (t) => {
    for (const order of [['A', 'B'], ['B', 'A']]) {
      await t.test(order.join(' luego '), async () => {
        const owner = await registerUser(ctx.api);
        const { token: cashierA } = await createCashier(ctx.api, owner);
        const { token: cashierB } = await createCashier(ctx.api, owner);
        const productId = await createProduct(ctx.api, owner, { name: 'Galleta', stock: 20, sale_price: 100 });
        const tokens = { A: cashierA, B: cashierB };
        const withdrawals = { A: 50, B: 20 };
        for (const box of ['A', 'B']) {
          const sale = await ctx.api('POST', '/api/sales', {
            token: tokens[box],
            body: { register_id: 'web', items: [{ product_id: productId, quantity: 1, unit_price: 100 }], payment_method: 'efectivo' },
          });
          assert.equal(sale.status, 201);
          const withdrawal = await extraer(tokens[box], {
            client_withdrawal_id: `order-${order.join('')}-${box}`,
            method: 'efectivo', amount: withdrawals[box], note: `Retiro caja ${box}`,
          });
          assert.equal(withdrawal.status, 201);
        }

        const results = {};
        for (const box of order) {
          const close = await ctx.api('POST', '/api/cash-closes', {
            token: tokens[box],
            body: { register_id: 'web', opening_float: 0, counted_cash: 100 - withdrawals[box] },
          });
          assert.equal(close.status, 201);
          results[box] = {
            expected: Number(close.body.expected_cash),
            withdrawn: Number(close.body.withdrawn_cash),
            difference: Number(close.body.difference),
          };
        }
        assert.deepEqual(results, {
          A: { expected: 50, withdrawn: 50, difference: 0 },
          B: { expected: 80, withdrawn: 20, difference: 0 },
        });
        const list = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
        for (const box of ['A', 'B']) {
          assert.ok(list.body.find((row) => row.client_withdrawal_id === `order-${order.join('')}-${box}`).cash_close_id);
        }
      });
    }
  });

  await t.test('cajero anula su propia salida → 200', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);

    // Cajero crea su salida
    const ext = await extraer(cashier, { client_withdrawal_id: 'ext-void-own', method: 'efectivo', amount: 100, note: 'Compra' });
    assert.equal(ext.status, 201);

    // Cajero anula la suya
    const voidRes = await anular(cashier, 'ext-void-own');
    assert.equal(voidRes.status, 200);
    assert.ok(voidRes.body.voided_at);
  });

  await t.test('cajero no puede anular la del dueño → 403 Solo puedes anular tus propias salidas', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);

    // Dueño crea extracción
    const ext = await extraer(owner, { client_withdrawal_id: 'ext-owner-other', method: 'efectivo', amount: 100, note: 'Cambio' });
    assert.equal(ext.status, 201);

    // Cajero intenta anularla
    const voidRes = await anular(cashier, 'ext-owner-other');
    assert.equal(voidRes.status, 403);
    assert.equal(voidRes.body.error, 'Solo puedes anular tus propias salidas');
  });

  await t.test('cajero A no puede anular la de cajero B → 403', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashierA } = await createCashier(ctx.api, owner);
    const { token: cashierB } = await createCashier(ctx.api, owner);

    // Cajero B crea salida
    const ext = await extraer(cashierB, { client_withdrawal_id: 'ext-cashier-b', method: 'efectivo', amount: 200, note: 'Compra B' });
    assert.equal(ext.status, 201);

    // Cajero A intenta anularla
    const voidRes = await anular(cashierA, 'ext-cashier-b');
    assert.equal(voidRes.status, 403);
    assert.equal(voidRes.body.error, 'Solo puedes anular tus propias salidas');
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

  await t.test('GET: cajero solo ve sus propias salidas', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashier } = await createCashier(ctx.api, owner);

    // Dueño crea una salida
    const ownerExt = await extraer(owner, { client_withdrawal_id: 'ext-owner-list', method: 'efectivo', amount: 100, note: 'Dueño' });
    assert.equal(ownerExt.status, 201);

    // Cajero crea su salida
    const cashierExt = await extraer(cashier, { client_withdrawal_id: 'ext-cashier-list', method: 'efectivo', amount: 200, note: 'Cajero' });
    assert.equal(cashierExt.status, 201);

    // Cajero hace GET: solo debe ver la suya
    const res = await ctx.api('GET', '/api/cash-withdrawals', { token: cashier });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].client_withdrawal_id, 'ext-cashier-list');
    assert.equal(Number(res.body[0].amount), 200);

    // Dueño hace GET: ve todas
    const ownerRes = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
    assert.equal(ownerRes.status, 200);
    assert.equal(ownerRes.body.length, 2);
  });

  await t.test('cierre de cajero A cubre su salida, pero deja retiros de dueño y cajero B para consolidación', async () => {
    const owner = await registerUser(ctx.api);
    const { token: cashierA } = await createCashier(ctx.api, owner);
    const { token: cashierB } = await createCashier(ctx.api, owner);
    const producto = await createProduct(ctx.api, owner, { name: 'Pan', stock: 100, sale_price: 1000 });

    // Dueño retira 100
    const ownerExt = await extraer(owner, { client_withdrawal_id: 'ext-owner-close', method: 'efectivo', amount: 100, note: 'Cambio dueño' });
    assert.equal(ownerExt.status, 201);

    // Cajero A retira 50
    const extA = await extraer(cashierA, { client_withdrawal_id: 'ext-a-close', method: 'efectivo', amount: 50, note: 'Compra A' });
    assert.equal(extA.status, 201);

    // Cajero B retira 30
    const extB = await extraer(cashierB, { client_withdrawal_id: 'ext-b-close', method: 'efectivo', amount: 30, note: 'Compra B' });
    assert.equal(extB.status, 201);

    // Cajero A vende 500
    await ctx.api('POST', '/api/sales', {
      token: cashierA,
      body: { register_id: 'web', items: [{ product_id: producto, quantity: 1, unit_price: 500 }], payment_method: 'efectivo' },
    });

    // Cajero A solo cubre su retiro asociado a su gaveta.
    const closeA = await ctx.api('POST', '/api/cash-closes', {
      token: cashierA, body: { register_id: 'web', opening_float: 0, counted_cash: 450 },
    });
    assert.equal(closeA.status, 201);
    assert.equal(Number(closeA.body.expected_cash), 450); // 0 + 500 - 50
    assert.equal(Number(closeA.body.difference), 0); // cuadra
    assert.equal(Number(closeA.body.withdrawn_cash), 50);

    // Verificar que la salida de A está cubierta
    const listA = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
    const coveredA = listA.body.find((w) => w.client_withdrawal_id === 'ext-a-close');
    assert.equal(Number(coveredA.cash_close_id), closeA.body.id);

    // El retiro del dueño y el de B siguen abiertos: el dueño consolida tienda.
    const coveredOwner = listA.body.find((w) => w.client_withdrawal_id === 'ext-owner-close');
    assert.equal(coveredOwner.cash_close_id, null);

    // Verificar que la salida de B NO está cubierta (sigue abierta)
    const coveredB = listA.body.find((w) => w.client_withdrawal_id === 'ext-b-close');
    assert.equal(coveredB.cash_close_id, null);

    const ownerClose = await ctx.api('POST', '/api/cash-closes', {
      token: owner, body: { register_id: 'web', opening_float: 0, counted_cash: 0 },
    });
    assert.equal(ownerClose.status, 201);
    assert.equal(Number(ownerClose.body.withdrawn_cash), 130);
    const listAfter = await ctx.api('GET', '/api/cash-withdrawals', { token: owner });
    assert.equal(Number(listAfter.body.find((w) => w.client_withdrawal_id === 'ext-owner-close').cash_close_id), ownerClose.body.id);
    assert.equal(Number(listAfter.body.find((w) => w.client_withdrawal_id === 'ext-b-close').cash_close_id), ownerClose.body.id);
  });
});
