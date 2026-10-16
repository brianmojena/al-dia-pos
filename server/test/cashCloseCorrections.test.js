const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startTestServer, registerUser, createProduct } = require('./helpers');

const cashier = async (api, ownerToken, email) => {
  const created = await api('POST', '/api/auth/cashiers', { token: ownerToken, body: { email, password: 'test1234' } });
  assert.equal(created.status, 201);
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'test1234' } });
  assert.equal(login.status, 200);
  return login.body.token;
};

const correctionBody = (revision, extra = {}) => ({
  opening_float: 1000, counted_cash: 0, counted_usd: 0, counted_eur: 0,
  note: 'corregido', correction_revision: revision, ...extra,
});

test('correcciones históricas de cierres de caja', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('recalcula solo cobertura cerrada, conserva fecha/conteo y audita antes/después', async () => {
    const ownerToken = await registerUser(ctx.api);
    const userId = jwt.decode(ownerToken).userId;
    const productId = await createProduct(ctx.api, ownerToken, { name: 'Caja multi', stock: 100, sale_price: 100 });
    const sell = async (price, payment_method, extra = {}) => ctx.api('POST', '/api/sales', {
      token: ownerToken,
      body: { items: [{ product_id: productId, quantity: 1, unit_price: price }], payment_method, ...extra },
    });
    assert.equal((await sell(100, 'efectivo')).status, 201);
    assert.equal((await sell(40, 'transferencia')).status, 201);
    assert.equal((await sell(5, 'divisa', { foreign_currency: 'USD', foreign_amount: 10, exchange_rate: 2 })).status, 201);
    assert.equal((await ctx.api('POST', '/api/currency-purchases', { token: ownerToken,
      body: { client_purchase_id: 'purchase-covered', foreign_currency: 'USD', foreign_amount: 5, exchange_rate: 2, register_id: 'web' },
    })).status, 201);
    assert.equal((await ctx.api('POST', '/api/cash-withdrawals', { token: ownerToken,
      body: { client_withdrawal_id: 'cash-covered', method: 'efectivo', amount: 20 },
    })).status, 201);
    assert.equal((await ctx.api('POST', '/api/cash-withdrawals', { token: ownerToken,
      body: { client_withdrawal_id: 'eur-covered', method: 'EUR', amount: 2 },
    })).status, 201);
    const closeResponse = await ctx.api('POST', '/api/cash-closes', { token: ownerToken,
      body: { opening_float: 1000, counted_cash: 1100, counted_usd: 0, counted_eur: 0, register_id: 'web' },
    });
    assert.equal(closeResponse.status, 201);
    const close = closeResponse.body;
    assert.equal(close.expected_cash, 1055);
    assert.equal(close.expected_transfer, 40);
    assert.equal(close.expected_usd, 15);
    assert.equal(close.expected_eur, -2);
    assert.equal(close.sales_count, 3);

    // Movimientos abiertos quedan fuera por carecer de asociación, aunque
    // tengan fecha anterior al cierre.
    await ctx.db.execute({ sql: `INSERT INTO sales
      (user_id, client_sale_id, total, profit, payment_method, created_at, cash_close_id)
      VALUES (?, 'open-old-sale', 900, 0, 'efectivo', ?, NULL)`, args: [userId, close.closed_at.slice(0, 10) + ' 00:00:00'] });
    await ctx.db.execute({ sql: `INSERT INTO cash_withdrawals
      (user_id, client_withdrawal_id, method, amount, created_at)
      VALUES (?, 'open-old-withdrawal', 'efectivo', 700, ?)`, args: [userId, close.closed_at.slice(0, 10) + ' 00:00:00'] });
    // Una venta cubierta puede llegar al servidor después del cierre: el ID
    // asociado manda aunque created_at esté adelantado.
    const laterSale = await sell(500, 'efectivo', { client_sale_id: 'linked-post-cutoff-sale' });
    await ctx.db.execute({ sql: "UPDATE sales SET created_at = '2099-01-01 00:00:00', cash_close_id = ? WHERE id = ?", args: [close.id, laterSale.body.id] });

    const detail = await ctx.api('GET', `/api/cash-closes/${close.id}`, { token: ownerToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.correction_revision, 0);
    const saved = await ctx.api('PUT', `/api/cash-closes/${close.id}`, { token: ownerToken,
      body: correctionBody(0, { opening_float: 1100, counted_cash: 1655, counted_usd: 12, counted_eur: 0 }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.cash_close.expected_cash, 1655);
    assert.equal(saved.body.cash_close.difference, 0);
    assert.equal(saved.body.cash_close.expected_transfer, 40);
    assert.equal(saved.body.cash_close.expected_usd, 15);
    assert.equal(saved.body.cash_close.difference_usd, -3);
    assert.equal(saved.body.cash_close.expected_eur, -2);
    assert.equal(saved.body.cash_close.difference_eur, 2);
    assert.equal(saved.body.cash_close.sales_count, 4, 'incluye la venta asociada tardía y excluye la venta abierta');
    assert.equal(saved.body.cash_close.withdrawn_cash, 20);
    assert.equal(saved.body.cash_close.withdrawn_eur, 2);
    assert.equal(saved.body.cash_close.opening_float, 1100);
    assert.equal(saved.body.cash_close.counted_cash, 1655);
    assert.equal(saved.body.cash_close.closed_at, close.closed_at);
    assert.equal(saved.body.cash_close.opened_at, close.opened_at);
    assert.equal(saved.body.cash_close.original_expected_cash, 1055);
    assert.equal(saved.body.cash_close.original_difference, close.difference);
    assert.equal(saved.body.cash_close.correction_revision, 1);
    assert.equal(saved.body.correction.correction_revision, 1);
    assert.equal(saved.body.correction.before.expected_cash, 1055);
    assert.equal(saved.body.correction.after.expected_cash, 1655);
    const delta = await ctx.api('GET', '/api/sync/delta?after_close_correction=0', { token: ownerToken });
    assert.equal(delta.status, 200);
    assert.equal(delta.body.cash_close_corrections.length, 1);
    assert.equal(delta.body.cash_close_corrections[0].cash_close.expected_cash, 1655);
    assert.equal(delta.body.cursors.close_correction, saved.body.correction.id);
    const openRows = await ctx.db.execute({ sql: "SELECT cash_close_id FROM sales WHERE client_sale_id = 'open-old-sale'" });
    assert.equal(openRows.rows[0].cash_close_id, null, 'corregir no cambia la cobertura de movimientos abiertos');
    const linkedLater = await ctx.db.execute({ sql: "SELECT cash_close_id FROM sales WHERE client_sale_id = ?", args: [laterSale.body.client_sale_id] });
    assert.equal(linkedLater.rows[0].cash_close_id, close.id, 'la venta asociada conserva su cierre');
    const counts = await ctx.db.execute({ sql: 'SELECT COUNT(*) AS n FROM cash_close_corrections WHERE user_id = ? AND cash_close_id = ?', args: [userId, close.id] });
    assert.equal(Number(counts.rows[0].n), 1);
    const saleJournal = await ctx.db.execute({ sql: 'SELECT COUNT(*) AS n FROM sale_corrections WHERE user_id = ?', args: [userId] });
    assert.equal(Number(saleJournal.rows[0].n), 0, 'la auditoría de cierre no se falsifica como corrección de venta');
    await assert.rejects(ctx.db.execute({ sql: "UPDATE cash_close_corrections SET before = '{}' WHERE cash_close_id = ?", args: [close.id] }));
  });

  await t.test('solo dueño corrige; cajero ve solo su detalle y tenant ajeno recibe 404', async () => {
    const owner = await registerUser(ctx.api);
    const userId = jwt.decode(owner).userId;
    const cashierToken = await cashier(ctx.api, owner, `close-cashier-${Date.now()}@test.local`);
    const close = await ctx.api('POST', '/api/cash-closes', { token: cashierToken,
      body: { counted_cash: 0, opening_float: 10, register_id: 'web' },
    });
    assert.equal(close.status, 201);
    assert.equal((await ctx.api('GET', `/api/cash-closes/${close.body.id}`, { token: cashierToken })).status, 200);
    assert.equal((await ctx.api('GET', `/api/cash-closes/${close.body.id}`, { token: owner })).status, 200);
    const cashierEdit = await ctx.api('PUT', `/api/cash-closes/${close.body.id}`, { token: cashierToken, body: correctionBody(0) });
    assert.equal(cashierEdit.status, 403);
    const other = await registerUser(ctx.api);
    assert.equal((await ctx.api('GET', `/api/cash-closes/${close.body.id}`, { token: other })).status, 404);
    assert.equal((await ctx.api('PUT', `/api/cash-closes/${close.body.id}`, { token: other, body: correctionBody(0) })).status, 404);
  });

  await t.test('rechaza campos y valores inválidos, y revisión obsoleta no pisa cambios', async () => {
    const owner = await registerUser(ctx.api);
    const close = await ctx.api('POST', '/api/cash-closes', { token: owner, body: { counted_cash: 50, opening_float: 50 } });
    assert.equal(close.status, 201);
    for (const bad of [
      correctionBody(0, { counted_cash: null }), correctionBody(0, { opening_float: '' }),
      correctionBody(0, { counted_usd: 'NaN' }), correctionBody(0, { counted_eur: -0.01 }),
      correctionBody(0, { expected_cash: 50 }), correctionBody(null),
      correctionBody(false), correctionBody(''),
      correctionBody(0, { opening_float: Number.MAX_VALUE }),
      (() => { const body = correctionBody(0); delete body.note; return body; })(),
    ]) {
      const result = await ctx.api('PUT', `/api/cash-closes/${close.body.id}`, { token: owner, body: bad });
      assert.equal(result.status, 400, JSON.stringify(bad));
    }
    const good = await ctx.api('PUT', `/api/cash-closes/${close.body.id}`, { token: owner, body: correctionBody(0, { counted_cash: 40 }) });
    assert.equal(good.status, 200);
    const stale = await ctx.api('PUT', `/api/cash-closes/${close.body.id}`, { token: owner, body: correctionBody(0, { counted_cash: 30 }) });
    assert.equal(stale.status, 409);
    const audit = await ctx.api('GET', `/api/cash-closes/${close.body.id}`, { token: owner });
    assert.equal(audit.body.correction_revision, 1);
    assert.equal(audit.body.counted_cash, 40);
    assert.equal(audit.body.corrections.length, 1);
    const invalidIds = await ctx.api('GET', '/api/cash-closes/not-a-number', { token: owner });
    assert.equal(invalidIds.status, 400);
  });

  await t.test('legacy overlap conserva el esperado y modifica solo el fondo', async () => {
    const owner = await registerUser(ctx.api);
    const close = await ctx.api('POST', '/api/cash-closes', { token: owner,
      body: { counted_cash: 1300, opening_float: 1000, register_id: 'web' },
    });
    await ctx.db.execute({ sql: 'UPDATE cash_closes SET overlap_sales = 2, expected_cash = 1280, expected_transfer = 325, expected_usd = 7, expected_eur = 4, sales_count = 5 WHERE id = ?', args: [close.body.id] });
    const fixed = await ctx.api('PUT', `/api/cash-closes/${close.body.id}`, { token: owner,
      body: correctionBody(0, { opening_float: 1200, counted_cash: 1300, counted_usd: 7, counted_eur: 4 }),
    });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.cash_close.expected_cash, 1480);
    assert.equal(fixed.body.cash_close.expected_transfer, 325);
    assert.equal(fixed.body.cash_close.expected_usd, 7);
    assert.equal(fixed.body.cash_close.expected_eur, 4);
    assert.equal(fixed.body.cash_close.sales_count, 5);
    assert.equal(fixed.body.cash_close.difference, -180);
  });
});
