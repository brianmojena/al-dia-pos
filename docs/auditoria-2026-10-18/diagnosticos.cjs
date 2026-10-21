// Auditoría reproducible. Solo usa SQLite temporal y transporte Express sin puertos.
// node docs/auditoria-2026-10-18/diagnosticos.cjs [ruta-resultados.json]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
process.env.MYPIMES_TEST_TRANSPORT = 'in-process';
process.env.ADMIN_EMAILS = 'audit-admin@test.local';
const { startTestServer, registerUser, createCashier, createProduct } = require(path.join(root, 'server/test/helpers'));
const results = { environment: { node: process.version, platform: process.platform, arch: process.arch, date: new Date().toISOString(), transport: 'Express in-process + libSQL file, sin red ni Turso' }, diagnostics: {}, measurements: [] };
let stats = null;
function instrument(target) {
  for (const method of ['execute', 'executeMultiple', 'batch', 'commit', 'rollback']) {
    if (!target[method]) continue;
    const original = target[method].bind(target);
    target[method] = async (...args) => {
      if (stats) stats[method] = (stats[method] || 0) + 1;
      try { return await original(...args); }
      catch (error) { if (stats) stats.errors = (stats.errors || 0) + 1; throw error; }
    };
  }
  if (target.transaction) {
    const original = target.transaction.bind(target);
    target.transaction = async (...args) => {
      if (stats) stats.transaction = (stats.transaction || 0) + 1;
      const tx = await original(...args); instrument(tx); return tx;
    };
  }
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
async function measure(name, fn, repetitions = 5) {
  const samples = [], counts = [];
  let value;
  for (let i = 0; i < repetitions; i++) {
    stats = {};
    const started = performance.now();
    value = await fn(i);
    samples.push(performance.now() - started);
    counts.push(stats); stats = null;
  }
  const row = { name, repetitions, p50_ms: +percentile(samples, 0.5).toFixed(2), p95_ms: +percentile(samples, 0.95).toFixed(2), calls: counts[0], bytes_json: Buffer.byteLength(JSON.stringify(value.body ?? value)), status: value.status ?? null };
  results.measurements.push(row);
  console.log(JSON.stringify(row));
  return value;
}
async function main() {
  const ctx = await startTestServer();
  const db = ctx.db; instrument(db);
  try {
    const owner = await registerUser(ctx.api, 'audit-owner@test.local');
    const ownerId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).userId;
    const cashier = await createCashier(ctx.api, owner, { email: 'audit-cashier@test.local' });
    const productId = await createProduct(ctx.api, owner, { name: 'Producto auditoría', stock: 10000 });
    const sale = (id, token = owner, quantity = 1) => ctx.api('POST', '/api/sales', { token, body: { client_sale_id: id, payment_method: 'efectivo', items: [{ product_id: productId, quantity, unit_price: 100 }] } });

    const admin = await registerUser(ctx.api, 'audit-admin@test.local');
    const adminRead = await ctx.api('GET', '/api/admin/shops', { token: admin });
    results.diagnostics.admin_email_claim = { registration: 'registro público sin verificación de correo', admin_endpoint_status: adminRead.status, shops_visible: adminRead.body.shops.length, conditional: 'Requiere que el correo configurado en ADMIN_EMAILS todavía no esté registrado' };

    const products = await ctx.api('GET', '/api/products', { token: cashier.token });
    const snapshot = await ctx.api('GET', '/api/sync/snapshot', { token: cashier.token });
    const cashierSale = await sale('audit-cashier-cost', cashier.token);
    results.diagnostics.cashier_cost_projection = { products_purchase_price: products.body[0].purchase_price, snapshot_purchase_price: snapshot.body.products[0].purchase_price, create_sale_profit: cashierSale.body.profit };

    await ctx.api('DELETE', `/api/auth/cashiers/${cashier.id}`, { token: owner });
    const deletedRead = await ctx.api('GET', '/api/products', { token: cashier.token });
    const deletedSale = await sale('audit-deleted-cashier', cashier.token);
    results.diagnostics.deleted_cashier = { read_status: deletedRead.status, sale_status: deletedSale.status, saved_account_id: deletedSale.body.account_id, saved_account_email: deletedSale.body.account_email };

    await db.execute({ sql: "UPDATE users SET plan_status = 'pending', trial_ends_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", args: [ownerId] });
    const profile = await ctx.api('GET', '/api/auth/me', { token: owner });
    const lockedSale = await sale('audit-locked-shop');
    results.diagnostics.expired_trial = { profile_locked: profile.body.user.locked, sale_status: lockedSale.status };
    await db.execute({ sql: "UPDATE users SET plan_status = 'active' WHERE id = ?", args: [ownerId] });

    // Intercalación determinista: el PUT lee stock=100; una venta confirma 99;
    // después el PUT continúa con el resultado anterior, sin alterar producción.
    await db.execute({ sql: 'UPDATE products SET stock = 100 WHERE id = ?', args: [productId] });
    const originalExecute = db.execute;
    let interleavedSale;
    db.execute = async (...args) => {
      const value = await originalExecute(...args);
      if (args[0]?.sql === 'SELECT * FROM products WHERE id = ? AND user_id = ?') {
        db.execute = originalExecute;
        interleavedSale = await sale('audit-interleaved-price');
      }
      return value;
    };
    const priceUpdate = await ctx.api('PUT', `/api/products/${productId}`, { token: owner, body: { sale_price: 120 } });
    db.execute = originalExecute;
    results.diagnostics.price_update_lost_stock = { sale_status: interleavedSale.status, update_status: priceUpdate.status, expected_stock: 99, actual_stock: Number(priceUpdate.body.stock) };

    await db.execute({ sql: 'UPDATE products SET stock = 100 WHERE id = ?', args: [productId] });
    for (let i = 0; i < 2; i++) await ctx.api('PUT', `/api/products/${productId}`, { token: owner, body: { add_stock: 5 } });
    const retried = await db.execute({ sql: 'SELECT stock FROM products WHERE id = ?', args: [productId] });
    results.diagnostics.desktop_add_stock_retry_endpoint = { initial_stock: 100, intended_addition: 5, requests: 2, actual_stock: Number(retried.rows[0].stock), note: 'Electron usa PUT sin operation_id; dos entregas equivalentes suman dos veces' };

    // Extracciones abiertas antiguas llenan LIMIT antes de las nuevas.
    const method = 'efectivo';
    for (const id of ['audit-w-1', 'audit-w-2', 'audit-w-3']) await ctx.api('POST', '/api/cash-withdrawals', { token: owner, body: { client_withdrawal_id: id, method, amount: 1 } });
    const w1 = await ctx.api('GET', '/api/sync/delta?limit=2', { token: owner });
    const w2 = await ctx.api('GET', `/api/sync/delta?limit=2&after_withdrawal=${w1.body.cursors.withdrawal}`, { token: owner });
    results.diagnostics.withdrawal_cursor_starvation = { first_ids: w1.body.cash_withdrawals.map(w => Number(w.id)), second_ids: w2.body.cash_withdrawals.map(w => Number(w.id)), first_cursor: w1.body.cursors.withdrawal, second_cursor: w2.body.cursors.withdrawal, has_more: w2.body.has_more, actual_desktop_threshold: 500 };

    await measure('initDb warm sobre esquema existente', () => require(path.join(root, 'server/db/database')).initDb().then(() => ({ ok: true })), 3);
    await measure('venta 1 línea', i => sale(`audit-counted-${i}`));
    await measure('venta 5 líneas', i => ctx.api('POST', '/api/sales', { token: owner, body: { client_sale_id: `audit-counted-five-${i}`, items: Array.from({ length: 5 }, () => ({ product_id: productId, quantity: 1, unit_price: 100 })) } }));

    // Invariantes positivas: aislamiento, stock condicional e idempotencia.
    const outsider = await registerUser(ctx.api, 'audit-outsider@test.local');
    const outsiderSale = await sale('audit-wrong-shop', outsider);
    await db.execute({ sql: 'UPDATE products SET stock = 5 WHERE id = ?', args: [productId] });
    const competing = await Promise.all(Array.from({ length: 8 }, (_, i) => sale(`audit-stock-${i}`)));
    const remaining = Number((await db.execute({ sql: 'SELECT stock FROM products WHERE id = ?', args: [productId] })).rows[0].stock);
    await db.execute({ sql: 'UPDATE products SET stock = 10 WHERE id = ?', args: [productId] });
    const repeated = await Promise.all(Array.from({ length: 5 }, () => sale('audit-repeat')));
    const unique = (await db.execute("SELECT COUNT(*) AS n FROM sales WHERE client_sale_id = 'audit-repeat'")).rows[0].n;
    assert.equal(remaining, 0); assert.equal(competing.filter(r => r.status === 201).length, 5); assert.equal(Number(unique), 1);
    results.diagnostics.positive_invariants = { cross_shop_sale: outsiderSale.status, concurrent_sales_statuses: competing.map(r => r.status), final_stock: remaining, repeat_statuses: repeated.map(r => r.status), repeat_rows: Number(unique) };

    // Datos sintéticos SQL: 200 ventas/día/tienda, 5 líneas/venta, 100 productos.
    // Se pueblan TODOS los tenants a 30 días; a un año se expande uno y se
    // declara explícitamente para no fingir una prueba de 100 tiendas-año.
    // Un único driver evita mezclar versiones SQLite y sus conexiones/cachés.
    let fixtureTx = null;
    const fixture = {
      async exec(sql) {
        if (sql === 'BEGIN') { fixtureTx = await db.transaction('write'); return; }
        if (sql === 'COMMIT') { await fixtureTx.commit(); fixtureTx = null; return; }
        return (fixtureTx || db).execute(sql);
      },
      prepare(sql) { return {
        run: (...args) => (fixtureTx || db).execute({ sql, args }),
        get: async (...args) => (await (fixtureTx || db).execute({ sql, args })).rows[0],
        all: async (...args) => (await (fixtureTx || db).execute({ sql, args })).rows,
      }; },
    };
    let populated = 0;
    for (const stores of [10, 50, 100]) {
      console.log(`Preparando fixture: ${stores} tiendas`);
      await fixture.exec('BEGIN');
      for (let store = populated; store < stores; store++) {
        const userId = 1000 + store;
        await fixture.prepare("INSERT INTO users (id,email,password_hash,store_name,plan_status) VALUES (?,?,'no-login','Sintética','active')").run(userId, `synthetic-${store}@test.local`);
        await fixture.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100)
          INSERT INTO products(user_id,name,purchase_price,sale_price,stock) SELECT ?, 'Producto '||n,60,100,10000 FROM seq`).run(userId);
        await fixture.prepare(`INSERT INTO cash_closes(user_id,client_close_id,opened_at,expected_cash,counted_cash,difference,sales_count,register_id,account_id)
          VALUES (?, ?, datetime('now','-30 days'),3000000,3000000,0,6000,'web',?)`).run(userId, `synthetic-close-${userId}`, userId);
        await fixture.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<6000)
          INSERT INTO sales(user_id,client_sale_id,total,profit,created_at,account_id,account_email,register_id,cash_close_id)
          SELECT ?, 'synthetic-'||?||'-'||n,500,200,datetime('now','-'||CAST((n-1)/200 AS INTEGER)||' days'),?,?,'web',(SELECT id FROM cash_closes WHERE user_id=? LIMIT 1) FROM seq`).run(userId, userId, userId, `synthetic-${store}@test.local`, userId);
        await fixture.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<5)
          INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,unit_cost)
          SELECT s.id,(SELECT MIN(id) FROM products WHERE user_id=?),'Producto sintético',1,100,60 FROM sales s CROSS JOIN seq WHERE s.user_id=?`).run(userId,userId);
      }
      await fixture.exec('COMMIT'); populated = stores;
      // Solo tokens de fixtures creados aquí; no son credenciales reales.
      const jwt = require(path.join(root, 'server/node_modules/jsonwebtoken'));
      const token = jwt.sign({ userId: 1000, accountId: 1000, role: 'dueño' }, 'test-secret');
      const snap = await measure(`snapshot ${stores} tiendas / 30 días`, () => ctx.api('GET', '/api/sync/snapshot', { token }), 3);
      assert.equal(snap.status, 200); assert.equal(snap.body.sales.length, 6000);
      if (stores === 100) {
        const { project } = await import(pathToFileURL(path.join(root, 'client/src/lib/offlineModel.js')));
        await measure('project PWA 6000 ventas sin pendientes', () => { project({ base:snap.body, outbox:[] }); return { ok:true }; });
      }
      await measure(`dashboard ${stores} tiendas / 30 días`, () => ctx.api('GET', '/api/dashboard', { token }));
      await measure(`delta ${stores} tiendas / 30 días`, () => ctx.api('GET', '/api/sync/delta?limit=500', { token }));
      for (const concurrency of [10, 50, 100]) {
        const started = performance.now();
        const latency = [];
        const responses = await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
          const t = performance.now();
          const scoped = jwt.sign({ userId: 1000 + i % stores, accountId: 1000 + i % stores, role: 'dueño' }, 'test-secret');
          const r = await ctx.api('GET', '/api/dashboard', { token: scoped }); latency.push(performance.now() - t); return r;
        }));
        results.measurements.push({ name: `ráfaga dashboard ${stores} tiendas`, concurrency, repetitions: 1, p50_ms: +percentile(latency,0.5).toFixed(2), p95_ms: +percentile(latency,0.95).toFixed(2), wall_ms: +(performance.now()-started).toFixed(2), statuses: responses.reduce((a,r) => ({ ...a, [r.status]: (a[r.status]||0)+1 }), {}) });
      }
    }
    const firstProduct = (await fixture.prepare('SELECT MIN(id) AS id FROM products WHERE user_id=1000').get()).id;
    await fixture.exec('BEGIN');
    await fixture.exec(`WITH RECURSIVE seq(n) AS (SELECT 6001 UNION ALL SELECT n+1 FROM seq WHERE n<73000)
      INSERT INTO sales(user_id,client_sale_id,total,profit,created_at,account_id,account_email,register_id,cash_close_id)
      SELECT 1000,'synthetic-year-'||n,500,200,datetime('now','-'||CAST((n-1)/200 AS INTEGER)||' days'),1000,'synthetic-0@test.local','web',(SELECT id FROM cash_closes WHERE user_id=1000 LIMIT 1) FROM seq`);
    await fixture.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<5)
      INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,unit_cost)
      SELECT s.id,?,'Producto sintético',1,100,60 FROM sales s CROSS JOIN seq WHERE s.user_id=1000 AND s.client_sale_id LIKE 'synthetic-year-%'`).run(firstProduct);
    await fixture.exec("UPDATE cash_closes SET opened_at=datetime('now','-365 days'), expected_cash=36500000, counted_cash=36500000, sales_count=73000 WHERE user_id=1000");
    await fixture.exec('COMMIT');
    const jwt = require(path.join(root, 'server/node_modules/jsonwebtoken'));
    const token = jwt.sign({ userId: 1000, accountId: 1000, role: 'dueño' }, 'test-secret');
    const year = await measure('snapshot 100 tiendas / 1 tienda con 365 días', async () => { const r = await ctx.api('GET', '/api/sync/snapshot', { token }); assert.equal(r.status, 200); assert.equal(r.body.sales.length, 73000); return r; }, 3);
    const { project } = await import(pathToFileURL(path.join(root,'client/src/lib/offlineModel.js')));
    const state = { base: year.body, outbox: [] };
    await measure('project PWA 73000 ventas sin pendientes', () => { project(state); return { ok: true }; });
    results.fixture = { stores: 100, days_other_stores: 30, days_first_store: 365, daily_sales: 200, items_per_sale: 5, total_sales: Number((await fixture.prepare('SELECT COUNT(*) n FROM sales WHERE user_id >= 1000').get()).n), total_items: Number((await fixture.prepare('SELECT COUNT(*) n FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.user_id>=1000').get()).n) };
    results.query_plans = {
      delta: await fixture.prepare('EXPLAIN QUERY PLAN SELECT * FROM sales WHERE user_id=? AND id>? ORDER BY id LIMIT 500').all(1000,0),
      sale_items_snapshot: await fixture.prepare('EXPLAIN QUERY PLAN SELECT i.* FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.user_id=? ORDER BY i.id').all(1000),
      products: await fixture.prepare('EXPLAIN QUERY PLAN SELECT * FROM products WHERE user_id=? ORDER BY name').all(1000),
    };
  } finally {
    await ctx.close();
  }
  const output = path.resolve(process.argv[2] || '/private/tmp/mypimes-audit-results.json');
  fs.writeFileSync(output, JSON.stringify(results,null,2)+'\n');
  console.log(`Resultados: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode=1; });
