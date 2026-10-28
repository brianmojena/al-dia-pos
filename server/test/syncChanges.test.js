const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

const CURSOR_PARAMS = [
  ['sale', 'after_sale'], ['sale_state', 'after_sale_state'], ['close', 'after_close'], ['count', 'after_count'],
  ['purchase', 'after_purchase'], ['purchase_state', 'after_purchase_state'],
  ['withdrawal', 'after_withdrawal'], ['withdrawal_state', 'after_withdrawal_state'],
  ['correction', 'after_correction'], ['close_correction', 'after_close_correction'],
];

const pagePath = (cursors = {}, { limit = 2, maxBytes = 512 * 1024 } = {}) => {
  const params = new URLSearchParams({ limit: String(limit), max_bytes: String(maxBytes) });
  for (const [key, param] of CURSOR_PARAMS) params.set(param, String(cursors[key] ?? 0));
  return `/api/sync/snapshot?${params}`;
};

const pageBytes = (body) => Buffer.byteLength(JSON.stringify(body));

test('sincronización incremental paginada: cursores, bytes, correcciones y alcance', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await registerUser(ctx.api);
  const ownerId = Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).userId);
  const cashier = await createCashier(ctx.api, token);
  const product = await createProduct(ctx.api, token, { name: 'Pan', stock: 1000, sale_price: 10, purchase_price: 5 });
  const sale = (clientId, auth = token) => ctx.api('POST', '/api/sales', {
    token: auth,
    body: { client_sale_id: clientId, register_id: 'web', items: [{ product_id: product, quantity: 1, unit_price: 10 }] },
  });
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const created = await sale(`page-sale-${i}`);
    assert.equal(created.status, 201);
    ids.push(created.body.id);
  }
  const close = await ctx.api('POST', '/api/cash-closes', {
    token,
    body: { client_close_id: 'page-close', register_id: 'web', covered_sale_ids: ids.slice(0, 2), opening_float: 0, counted_cash: 20 },
  });
  assert.equal(close.status, 201);
  assert.equal((await ctx.api('POST', '/api/cash-withdrawals', {
    token, body: { client_withdrawal_id: 'page-withdrawal', method: 'efectivo', amount: 5 },
  })).status, 201);

  await t.test('la carga inicial pagina todo el historial sin duplicar ni perder ventas', async () => {
    let cursors = {}, pages = 0, seen = [], closesSeen = [], withdrawalsSeen = [];
    for (;;) {
      const response = await ctx.api('GET', pagePath(cursors), { token });
      assert.equal(response.status, 200);
      pages++;
      assert.ok(pages < 50, 'la paginación debe terminar');
      assert.ok(Array.isArray(response.body.products) && response.body.products.length >= 1, 'el catálogo llega completo en cada página');
      seen.push(...response.body.sales.map((row) => Number(row.id)));
      closesSeen.push(...response.body.cash_closes);
      withdrawalsSeen.push(...response.body.cash_withdrawals);
      cursors = response.body.cursors;
      if (!response.body.has_more) break;
    }
    assert.deepEqual(seen, ids, 'cada venta aparece una sola vez y en orden de cursor');
    assert.equal(new Set(seen).size, ids.length);
    const coveredClose = closesSeen.find((row) => Number(row.id) === Number(close.body.id));
    assert.ok(coveredClose, 'el cierre llega en alguna página');
    assert.deepEqual(coveredClose.covered_sale_ids.sort((a, b) => a - b), ids.slice(0, 2).sort((a, b) => a - b));
    assert.ok(withdrawalsSeen.some((row) => row.client_withdrawal_id === 'page-withdrawal'));
    const quiet = await ctx.api('GET', pagePath(cursors), { token });
    assert.equal(quiet.body.has_more, false);
    assert.deepEqual(quiet.body.sales, []);
    assert.deepEqual(quiet.body.cash_closes, []);
    assert.deepEqual(quiet.body.cursors, cursors, 'sin cambios los cursores no retroceden');
  });

  let afterCorrection;
  await t.test('una corrección de pago llega con la venta y el cierre recalculado', async () => {
    const before = await ctx.api('GET', pagePath({}, { limit: 500 }), { token });
    const correct = await ctx.api('POST', `/api/sales/${ids[0]}/correct`, {
      token, body: { action: 'pago', payment_method: 'transferencia', reason: 'prueba' },
    });
    assert.equal(correct.status, 200);
    const response = await ctx.api('GET', pagePath(before.body.cursors, { limit: 500 }), { token });
    assert.equal(response.body.sale_corrections.length, 1);
    const correction = response.body.sale_corrections[0];
    assert.equal(correction.action, 'pago');
    assert.equal(correction.sale.payment_method, 'transferencia');
    assert.ok(correction.cash_close, 'la corrección trae el cierre afectado');
    assert.equal(correction.cash_close.id, close.body.id);
    afterCorrection = response.body.cursors;
  });

  await t.test('anular una venta se representa sin venta y el cursor de corrección avanza', async () => {
    const correct = await ctx.api('POST', `/api/sales/${ids[2]}/correct`, {
      token, body: { action: 'anular', reason: 'prueba' },
    });
    assert.equal(correct.status, 200);
    const response = await ctx.api('GET', pagePath(afterCorrection, { limit: 500 }), { token });
    const voided = response.body.sale_corrections.find((row) => Number(row.sale_id) === Number(ids[2]));
    assert.ok(voided);
    assert.equal(voided.sale, null);
    assert.equal(voided.action, 'anular');
    assert.ok(response.body.cursors.correction > afterCorrection.correction);
  });

  await t.test('el cajero recibe solo sus ventas y correcciones, sin ganancia ni costos', async () => {
    const own = await sale('page-cashier-sale', cashier.token);
    assert.equal(own.status, 201);
    const before = await ctx.api('GET', pagePath({}, { limit: 500 }), { token: cashier.token });
    assert.deepEqual(before.body.sales.map((row) => Number(row.id)), [Number(own.body.id)]);
    assert.equal('profit' in before.body.sales[0], false);
    assert.equal('unit_cost' in before.body.sales[0].items[0], false);
    assert.equal(before.body.inventory_counts, undefined);
    assert.equal(before.body.rejected_sales, undefined);
    assert.equal(before.body.cashiers, undefined);
    const correct = await ctx.api('POST', `/api/sales/${own.body.id}/correct`, {
      token, body: { action: 'anular', reason: 'prueba cajero' },
    });
    assert.equal(correct.status, 200);
    const after = await ctx.api('GET', pagePath(before.body.cursors, { limit: 500 }), { token: cashier.token });
    assert.equal(after.body.sale_corrections.length, 1);
    assert.equal(Number(after.body.sale_corrections[0].sale_id), Number(own.body.id));
    assert.equal(after.body.sale_corrections[0].sale, null);
    assert.equal('before' in after.body.sale_corrections[0], false);
    assert.equal('after' in after.body.sale_corrections[0], false);
    assert.equal('profit' in (after.body.sale_corrections[0].sale || {}), false);
  });

  await t.test('las extracciones nuevas avanzan aunque haya recordatorios abiertos', async () => {
    const before = await ctx.api('GET', pagePath({}, { limit: 500 }), { token });
    const created = [];
    for (let i = 0; i < 3; i++) {
      const response = await ctx.api('POST', '/api/cash-withdrawals', {
        token, body: { client_withdrawal_id: `page-reminder-${i}`, method: 'efectivo', amount: 1 },
      });
      assert.equal(response.status, 201);
      created.push(Number(response.body.id));
    }
    let cursors = before.body.cursors, seen = [], pages = 0;
    for (;;) {
      const response = await ctx.api('GET', pagePath(cursors, { limit: 2 }), { token });
      pages++;
      assert.ok(pages < 20, 'la paginación de extracciones debe terminar');
      for (const row of response.body.cash_withdrawals) if (Number(row.id) > Number(cursors.withdrawal || 0)) seen.push(Number(row.id));
      cursors = response.body.cursors;
      if (!response.body.has_more) break;
    }
    assert.deepEqual(seen, created, 'las tres extracciones nuevas se descargan una sola vez');
    assert.ok(pages >= 2, 'los recordatorios abiertos no ocultan las extracciones nuevas');
  });

  await t.test('el presupuesto de bytes recorta páginas sin atascar el cursor', async () => {
    await ctx.db.execute({
      sql: `INSERT INTO sales (user_id, client_sale_id, total, payment_method, register_id, account_id, account_email, created_at)
            VALUES (?, ?, 10, 'efectivo', 'web', ?, ?, '2026-10-01 12:00:00')`,
      args: [ownerId, 'seed-before-bytes', ownerId, 'owner@test.local'],
    });
    for (let i = 0; i < 250; i++) {
      await ctx.db.execute({
        sql: `INSERT INTO sales (user_id, client_sale_id, total, payment_method, register_id, account_id, account_email, created_at)
              VALUES (?, ?, 10, 'efectivo', 'web', ?, ?, '2026-10-01 12:00:00')`,
        args: [ownerId, `byte-sale-${i}`, ownerId, 'owner@test.local'],
      });
    }
    const maxBytes = 24 * 1024;
    let cursors = {}, seen = new Set(), pages = 0;
    for (;;) {
      const response = await ctx.api('GET', pagePath(cursors, { limit: 500, maxBytes }), { token });
      pages++;
      assert.ok(pages < 50, 'el recorte debe avanzar');
      assert.ok(pageBytes(response.body) <= maxBytes, `página de ${pageBytes(response.body)} bytes supera el límite`);
      for (const row of response.body.sales) seen.add(Number(row.id));
      assert.ok(response.body.cursors.sale > (cursors.sale || 0) || !response.body.has_more, 'el cursor de ventas avanza');
      cursors = response.body.cursors;
      if (!response.body.has_more) break;
    }
    const total = await ctx.db.execute({ sql: 'SELECT COUNT(*) AS n FROM sales WHERE user_id = ?', args: [ownerId] });
    assert.equal(seen.size, Number(total.rows[0].n), 'todas las ventas se descargan aunque la página se recorte');
    assert.ok(pages > 1, 'se necesitaron varias páginas');
  });

  await t.test('la carga inicial acotada conserva abiertas y el historial se pide por rango', async () => {
    const oldOpen = await ctx.db.execute({
      sql: `INSERT INTO sales (user_id, client_sale_id, total, payment_method, register_id, account_id, account_email, created_at)
            VALUES (?, 'bounded-old-open', 10, 'efectivo', 'web', ?, ?, '2020-01-06 12:00:00')`,
      args: [ownerId, ownerId, 'owner@test.local'],
    });
    const oldClosed = await ctx.db.execute({
      sql: `INSERT INTO sales (user_id, client_sale_id, total, payment_method, register_id, account_id, account_email, created_at, cash_close_id)
            VALUES (?, 'bounded-old-closed', 10, 'efectivo', 'web', ?, ?, '2020-01-07 12:00:00', ?)`,
      args: [ownerId, ownerId, 'owner@test.local', Number(close.body.id)],
    });
    await ctx.db.execute({
      sql: `INSERT INTO sales (user_id, client_sale_id, total, payment_method, register_id, account_id, account_email, created_at)
            VALUES (?, 'history-old-sale', 10, 'efectivo', 'web', ?, ?, '2020-02-05 12:00:00')`,
      args: [ownerId, ownerId, 'owner@test.local'],
    });
    const params = new URLSearchParams({ limit: '500', max_bytes: String(512 * 1024), since: '2026-10-01 00:00:00' });
    for (const [, param] of CURSOR_PARAMS) params.set(param, '0');
    const bounded = await ctx.api('GET', `/api/sync/snapshot?${params}`, { token });
    assert.equal(bounded.status, 200);
    const boundedIds = bounded.body.sales.map((row) => row.client_sale_id);
    assert.ok(boundedIds.includes('bounded-old-open'), 'una venta abierta antigua sigue en la carga acotada');
    assert.equal(boundedIds.includes('bounded-old-closed'), false, 'una venta cerrada antigua queda para el historial');

    const history = new URLSearchParams({
      history_from: '2020-02-01T00:00:00Z', history_until: '2020-03-01T00:00:00Z',
      limit: '500', max_bytes: String(512 * 1024),
    });
    for (const [, param] of CURSOR_PARAMS) history.set(param, '0');
    const page = await ctx.api('GET', `/api/sync/snapshot?${history}`, { token });
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.history, { from: '2020-02-01 00:00:00', to: '2020-03-01 00:00:00' });
    assert.deepEqual(page.body.sales.map((row) => row.client_sale_id), ['history-old-sale']);
    assert.deepEqual(page.body.products, [], 'el historial no reenvía el catálogo completo');
    assert.equal(page.body.daily_stock, undefined);
    assert.equal(page.body.has_more, false);
    assert.ok(oldOpen.rowsAffected >= 1 && oldClosed.rowsAffected >= 1);
  });

  await t.test('el dueño cierra ventas descargadas y el cajero refresca sin datos del cierre', async () => {
    const cashierB = await createCashier(ctx.api, token, { email: 'sync-b@test.local' });
    const makeSale = (auth, id) => ctx.api('POST', '/api/sales', { token: auth, body: {
      client_sale_id: id, items: [{ product_id: product, quantity: 1, unit_price: 10 }],
    } });
    const saleA = await makeSale(cashier.token, 'sync-sale-a');
    const saleB = await makeSale(cashierB.token, 'sync-sale-b');
    assert.equal(saleA.status, 201);
    assert.equal(saleB.status, 201);

    const initial = await ctx.api('GET', pagePath({}, { limit: 500 }), { token: cashier.token });
    assert.ok(initial.body.sales.some((row) => row.client_sale_id === 'sync-sale-a'));
    const ownerCached = await ctx.api('GET', pagePath({}, { limit: 500 }), { token });
    assert.ok(ownerCached.body.sales.some((row) => row.client_sale_id === 'sync-sale-a'));
    const advanced = { ...initial.body.cursors, sale_state: 0 };
    const closeResult = await ctx.api('POST', '/api/cash-closes', {
      token, body: { opening_float: 0, counted_cash: 0 },
    });
    assert.equal(closeResult.status, 201);

    const refreshed = await ctx.api('GET', pagePath(advanced, { limit: 500 }), { token: cashier.token });
    assert.equal(refreshed.body.sales.some((row) => Number(row.id) === Number(saleA.body.id)), false,
      'el cursor de ventas ya puede estar avanzado');
    assert.equal(refreshed.body.sale_states.some((row) => Number(row.id) === Number(saleA.body.id) && row.closed === 1), true);
    assert.equal(refreshed.body.sale_states.some((row) => Number(row.id) === Number(saleB.body.id)), false);
    assert.equal(refreshed.body.cash_closes.some((row) => Number(row.id) === Number(closeResult.body.id)), false);
    const state = refreshed.body.sale_states.find((row) => Number(row.id) === Number(saleA.body.id));
    assert.equal(Number(state.cash_close_id), Number(closeResult.body.id));
    assert.deepEqual(Object.keys(state).sort(), ['cash_close_id', 'closed', 'id']);
    assert.equal(refreshed.body.current_period.has_sales, false);

    const laterSale = await sale('sync-sale-after-owner-close', cashier.token);
    assert.equal(laterSale.status, 201);
    const ownerDelta = await ctx.api('GET', pagePath({}, { limit: 500 }), { token });
    assert.equal(ownerDelta.body.current_period.has_sales, true,
      'el período del dueño incluye la venta abierta en la gaveta del cajero');
    assert.equal(ownerDelta.body.current_period.opened_at, closeResult.body.closed_at,
      'la apertura del dueño parte del cierre global más reciente');
    const ownerSnapshot = await ctx.api('GET', '/api/sync/snapshot', { token });
    assert.equal(ownerSnapshot.body.current_period.has_sales, true);
    assert.equal(ownerSnapshot.body.current_period.opened_at, closeResult.body.closed_at,
      'el snapshot PWA mantiene el mismo período global que el preview del cierre');

    const ownerAfterClose = await ctx.api('GET', pagePath({ ...ownerCached.body.cursors, sale_state: 0 }, { limit: 500 }), { token });
    assert.equal(ownerAfterClose.body.sale_states.find((state) => Number(state.id) === Number(saleA.body.id)).cash_close_id,
      Number(closeResult.body.id), 'el dueño PWA recibe el vínculo de cierre en el cursor de estado');
    await ctx.db.execute({ sql: 'UPDATE sales SET cash_close_id = NULL WHERE id = ?', args: [saleA.body.id] });
    await ctx.db.execute({ sql: 'DELETE FROM cash_closes WHERE id = ?', args: [closeResult.body.id] });
    const ownerAfterDelete = await ctx.api('GET', pagePath({ ...ownerCached.body.cursors, sale_state: 0 }, { limit: 500 }), { token });
    assert.equal(ownerAfterDelete.body.sales.some((row) => Number(row.id) === Number(saleA.body.id)), false,
      'el cursor de venta ya está avanzado');
    assert.equal(ownerAfterDelete.body.sale_states.find((state) => Number(state.id) === Number(saleA.body.id)).cash_close_id, null,
      'el estado del dueño permite restaurar la venta tras borrar el cierre cacheado');

    const ownerWithdrawal = await ctx.api('POST', '/api/cash-withdrawals', { token, body: {
      client_withdrawal_id: 'sync-owner-withdrawal', method: 'efectivo', amount: 25,
    } });
    assert.equal(ownerWithdrawal.status, 201);
    const ownCashier = await ctx.db.execute({ sql: 'SELECT id, email FROM users WHERE email = ?', args: [cashier.email] });
    const otherCashier = await ctx.db.execute({ sql: 'SELECT id, email FROM users WHERE email = ?', args: [cashierB.email] });
    const legacyIds = [];
    for (const [label, account] of [['legacy-own', ownCashier.rows[0]], ['legacy-other', otherCashier.rows[0]]]) {
      const inserted = await ctx.db.execute({
        sql: `INSERT INTO cash_withdrawals (user_id, client_withdrawal_id, method, amount, account_id, account_email, created_at)
              VALUES (?, ?, 'efectivo', 5, ?, ?, '2026-10-27 10:00:00')`,
        args: [ownerId, label, Number(account.id), account.email],
      });
      legacyIds.push(Number(inserted.lastInsertRowid));
    }
    const emailFallback = await ctx.db.execute({
      sql: `INSERT INTO cash_withdrawals (user_id, client_withdrawal_id, method, amount, account_id, account_email, created_at)
            VALUES (?, 'legacy-email-own', 'efectivo', 5, NULL, ?, '2026-10-27 10:01:00')`,
      args: [ownerId, ownCashier.rows[0].email],
    });
    legacyIds.push(Number(emailFallback.lastInsertRowid));
    const cashierSnapshot = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
    assert.equal(cashierSnapshot.status, 200);
    assert.deepEqual(cashierSnapshot.body.cash_withdrawals.map((row) => row.client_withdrawal_id).sort(), ['legacy-email-own', 'legacy-own']);
    assert.equal(cashierSnapshot.body.current_period.has_sales, true, 'el legado propio sí participa en has_sales');
    assert.equal(cashierSnapshot.body.cash_withdrawals.some((row) => row.client_withdrawal_id === 'sync-owner-withdrawal'), false);
    assert.equal(cashierSnapshot.body.cash_withdrawals.some((row) => row.client_withdrawal_id === 'legacy-other'), false);
    assert.deepEqual(cashierSnapshot.body.withdrawal_states.map((state) => state.id).sort((a, b) => a - b), legacyIds.filter((id) => id !== legacyIds[1]).sort((a, b) => a - b));
  });
});
