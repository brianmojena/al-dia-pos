const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createCashier } = require('./helpers');
const { initStateSync, stateCursor } = require('../lib/stateSync');
const { syncChanges } = require('../lib/syncChanges');

const cursorParams = { sale: 'after_sale', sale_state: 'after_sale_state', purchase: 'after_purchase', purchase_state: 'after_purchase_state',
  withdrawal: 'after_withdrawal', withdrawal_state: 'after_withdrawal_state', close: 'after_close', count: 'after_count',
  correction: 'after_correction', close_correction: 'after_close_correction' };
const params = (cursors = {}, extra = {}) => ({ limit: '200', state_changes: '1', state_cursor_version: '1',
  ...Object.fromEntries(Object.entries(cursorParams).map(([key, param]) => [param, String(cursors[key] || 0)])), ...extra });
const path = (cursors, extra) => `/api/sync/snapshot?${new URLSearchParams(params(cursors, extra))}`;

test('estados incrementales: bootstrap, privacidad, transacciones y trabajo acotado', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const owner = await registerUser(ctx.api);
  const ownerId = Number(JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).userId);
  const cashier = await createCashier(ctx.api, owner);
  const otherCashier = await createCashier(ctx.api, owner);
  const otherOwner = await registerUser(ctx.api);
  const insertSale = async (account, clientId) => Number((await ctx.db.execute({
    sql: `INSERT INTO sales (user_id, total, account_id, account_email, register_id, client_sale_id, created_at)
          VALUES (?, 20, ?, ?, ?, ?, '2020-01-01 12:00:00')`,
    args: [ownerId, account.id, account.email, `web:${account.id}`, clientId],
  })).lastInsertRowid);
  const saleId = await insertSale(cashier, 'state-sale');
  const otherSaleId = await insertSale(otherCashier, 'state-other-sale');

  await t.test('un cursor antiguo no se interpreta como secuencia; después no se reenvía el historial', async () => {
    const initial = await ctx.api('GET', path({ sale_state: 999999 }, { state_cursor_version: '0' }), { token: cashier.token });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.state_changes_version, 1);
    assert.deepEqual(initial.body.sale_states.map((row) => row.id), [saleId]);
    const quiet = await ctx.api('GET', path(initial.body.cursors), { token: cashier.token });
    assert.deepEqual(quiet.body.sale_states, []);
    assert.equal(quiet.body.has_more, false);
    assert.ok(quiet.body.cursors.sale_state >= initial.body.cursors.sale_state);
    const foreign = await ctx.api('GET', path(), { token: otherOwner });
    assert.deepEqual(foreign.body.sale_states, []);
  });

  await t.test('cierres y reaperturas llegan sin retroceder el cursor, sin revelar el cierre del dueño', async () => {
    const initial = (await ctx.api('GET', path(), { token: cashier.token })).body;
    await ctx.db.execute({ sql: 'UPDATE sales SET cash_close_id = 777 WHERE id IN (?, ?)', args: [saleId, otherSaleId] });
    const closed = (await ctx.api('GET', path(initial.cursors), { token: cashier.token })).body;
    assert.equal(closed.sale_states.length, 1);
    assert.equal(closed.sale_states[0].id, saleId);
    assert.equal(closed.sale_states[0].cash_close_id, 777);
    assert.deepEqual(Object.keys(closed.sale_states[0]).sort(), ['cash_close_id', 'change_id', 'closed', 'id']);
    await ctx.db.execute({ sql: 'UPDATE sales SET cash_close_id = NULL WHERE id = ?', args: [saleId] });
    const opened = (await ctx.api('GET', path(closed.cursors), { token: cashier.token })).body;
    assert.equal(opened.sale_states[0].cash_close_id, null);
    assert.ok(opened.cursors.sale_state > closed.cursors.sale_state);
    const delta = await ctx.api('GET', `/api/sync/delta?${new URLSearchParams(params())}`, { token: owner });
    assert.equal(delta.body.state_changes_version, 1);
    assert.ok(delta.body.sale_states.some((row) => row.id === saleId));
  });

  await t.test('rollback y escrituras sin cambios no crean estados nuevos; el bootstrap no se repite', async () => {
    const before = (await ctx.db.execute('SELECT MAX(seq) AS seq FROM sync_state_changes')).rows[0].seq;
    const tx = await ctx.db.transaction('write');
    await tx.execute({ sql: 'UPDATE sales SET cash_close_id = 888 WHERE id = ?', args: [saleId] });
    await tx.rollback();
    await ctx.db.execute({ sql: 'UPDATE sales SET cash_close_id = cash_close_id WHERE id = ?', args: [saleId] });
    await initStateSync(ctx.db);
    assert.equal((await ctx.db.execute('SELECT MAX(seq) AS seq FROM sync_state_changes')).rows[0].seq, before);
    assert.equal((await ctx.db.execute({ sql: "SELECT COUNT(*) AS n FROM sync_state_changes WHERE kind = 'sale' AND entity_id = ?", args: [saleId] })).rows[0].n, 1);
  });

  await t.test('retiros anulados y compras reabiertas respetan el alcance del cajero', async () => {
    const purchaseId = Number((await ctx.db.execute({ sql: `INSERT INTO currency_purchases
      (user_id, foreign_currency, foreign_amount, exchange_rate, cup_amount, account_id, account_email, register_id, cash_close_id)
      VALUES (?, 'USD', 1, 800, 800, ?, ?, ?, 777)`, args: [ownerId, cashier.id, cashier.email, `web:${cashier.id}`] })).lastInsertRowid);
    const withdrawalId = Number((await ctx.db.execute({ sql: `INSERT INTO cash_withdrawals
      (user_id, method, amount, account_id, account_email) VALUES (?, 'efectivo', 10, NULL, ?)`, args: [ownerId, cashier.email] })).lastInsertRowid);
    const initial = (await ctx.api('GET', path(), { token: cashier.token })).body;
    await ctx.db.batch([
      { sql: 'UPDATE currency_purchases SET cash_close_id = NULL WHERE id = ?', args: [purchaseId] },
      { sql: "UPDATE cash_withdrawals SET voided_at = '2026-11-01 12:00:00' WHERE id = ?", args: [withdrawalId] },
    ], 'write');
    const changed = (await ctx.api('GET', path(initial.cursors), { token: cashier.token })).body;
    assert.equal(changed.purchase_states[0].cash_close_id, null);
    assert.equal(changed.withdrawal_states[0].voided, 1);
    const other = (await ctx.api('GET', path(), { token: otherCashier.token })).body;
    assert.deepEqual(other.purchase_states, []);
    assert.deepEqual(other.withdrawal_states, []);
  });

  await t.test('3000 ventas antiguas se concilian una vez; stock e historial no se recalculan por página', async () => {
    await ctx.db.execute({ sql: `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000)
      INSERT INTO sales (user_id, total, created_at, cash_close_id)
      SELECT ?, 10, '2020-01-01 12:00:00', 777 FROM n`, args: [ownerId] });
    let cursors = {}, pages = 0, dailyCalls = 0, rows = 0;
    const tx = await ctx.db.transaction('read');
    const tracked = { execute: (stmt) => {
      if (/SELECT id, stock, unit, track_stock/.test(stmt.sql || stmt)) dailyCalls++;
      return tx.execute(stmt);
    } };
    try {
      for (;;) {
        const page = await syncChanges(tracked, { userId: ownerId, accountId: ownerId, role: 'dueño',
          query: params(cursors, { since: '2026-01-01', include_daily_stock: pages === 0 ? '1' : '0' }) });
        rows += page.sale_states.length;
        cursors = page.cursors;
        pages++;
        assert.ok(pages < 30);
        if (!page.has_more) break;
      }
      assert.ok(rows >= 3000);
      assert.equal(dailyCalls, 1);
      const quiet = await syncChanges(tracked, { userId: ownerId, accountId: ownerId, role: 'dueño', query: params(cursors, { since: '2026-01-01', include_daily_stock: '0' }) });
      assert.deepEqual(quiet.sale_states, []);
      assert.equal(quiet.has_more, false);
      assert.equal(dailyCalls, 1);
    } finally { await tx.rollback(); }
    const datePlan = await ctx.db.execute({ sql: 'EXPLAIN QUERY PLAN SELECT id FROM sales WHERE user_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)', args: [ownerId, '2026-01-01', '2026-01-02'] });
    assert.ok(datePlan.rows.some((row) => /idx_sales_sync_date.*<expr>/.test(row.detail)), JSON.stringify(datePlan.rows));
    const cursorPlan = await ctx.db.execute({ sql: 'EXPLAIN QUERY PLAN SELECT * FROM sales WHERE user_id = ? AND id > ? ORDER BY id LIMIT 200', args: [ownerId, 999999] });
    assert.ok(cursorPlan.rows.some((row) => /idx_sales_sync_cursor.*id>/.test(row.detail)), JSON.stringify(cursorPlan.rows));
  });

  await t.test('el recorte por bytes conserva cada cambio aunque su secuencia no coincida con el id de venta', async () => {
    await ctx.db.execute({ sql: 'UPDATE sales SET cash_close_id = 999 WHERE id = ?', args: [saleId] });
    const expected = (await ctx.db.execute({ sql: "SELECT entity_id, seq FROM sync_state_changes WHERE user_id = ? AND kind = 'sale' ORDER BY seq", args: [ownerId] })).rows;
    let cursors = { sale: 999999 }, pages = 0;
    const seen = [];
    const tx = await ctx.db.transaction('read');
    try {
      for (;;) {
        const page = await syncChanges(tx, { userId: ownerId, accountId: ownerId, role: 'dueño',
          query: params(cursors, { max_bytes: '5000', include_daily_stock: '0' }) });
        seen.push(...page.sale_states.map((row) => [row.id, row.change_id]));
        if (page.sale_states.length) assert.equal(page.cursors.sale_state, page.sale_states.at(-1).change_id);
        assert.ok(++pages < 500, 'el recorte no puede atascar la paginación');
        cursors = page.cursors;
        if (!page.has_more) break;
      }
    } finally { await tx.rollback(); }
    assert.ok(pages > 1);
    assert.deepEqual(seen, expected.map((row) => [row.entity_id, row.seq]));
    assert.equal(seen.at(-1)[0], saleId, 'una venta antigua modificada llega al final por su secuencia nueva');
    assert.equal(stateCursor([], 10, { count: 1, cursor: 20 }), 10, 'un recorte completo no debe saltar cambios');
    assert.equal(stateCursor([], 10, { count: 0, cursor: 20 }), 20, 'una consulta vacía puede avanzar sobre cambios ajenos');
  });

  await t.test('migrar una base existente concilia los estados y tolera registros antiguos sin tienda', async () => {
    const db = require('@libsql/client').createClient({ url: 'file::memory:' });
    try {
      await db.executeMultiple(`CREATE TABLE schema_migrations (key TEXT PRIMARY KEY);
        CREATE TABLE sales (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL,
          account_id INTEGER, account_email TEXT, register_id TEXT, cash_close_id INTEGER);
        CREATE TABLE currency_purchases (id INTEGER PRIMARY KEY, user_id INTEGER,
          account_id INTEGER, account_email TEXT, register_id TEXT, cash_close_id INTEGER);
        CREATE TABLE cash_withdrawals (id INTEGER PRIMARY KEY, user_id INTEGER,
          account_id INTEGER, account_email TEXT, register_id TEXT, cash_close_id INTEGER, voided_at TEXT);
        INSERT INTO sales (id, user_id, total, cash_close_id) VALUES (1, 1, 10, 999), (2, NULL, 10, NULL);`);
      await initStateSync(db);
      const migrated = (await db.execute("SELECT * FROM sync_state_changes WHERE kind = 'sale' AND entity_id = 1")).rows[0];
      assert.equal(migrated.cash_close_id, 999);
      assert.equal((await db.execute('SELECT COUNT(*) AS n FROM sync_state_changes')).rows[0].n, 1);
      const before = (await db.execute('SELECT MAX(seq) AS seq FROM sync_state_changes')).rows[0].seq;
      await initStateSync(db);
      assert.equal((await db.execute('SELECT MAX(seq) AS seq FROM sync_state_changes')).rows[0].seq, before);
      await db.execute('UPDATE sales SET cash_close_id = NULL WHERE id = 1');
      const changed = (await db.execute("SELECT * FROM sync_state_changes WHERE kind = 'sale' AND entity_id = 1")).rows[0];
      assert.equal(changed.cash_close_id, null);
      assert.ok(changed.seq > before);
      await db.execute('INSERT INTO sales (total) VALUES (10)');
    } finally { db.close(); }
  });
});
