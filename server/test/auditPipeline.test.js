// Los flags se leen al cargar config.js: hay que fijarlos antes de helpers.
process.env.AUDIT_ENABLED = '1';
process.env.CRON_SECRET = 'test-cron-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createCashier, createProduct } = require('./helpers');

test('flujo de auditoría', async (t) => {
  // getDb() memoiza el cliente: todos los casos comparten un solo servidor y
  // una sola base temporal, igual que el resto de las suites.
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const ownerEmail = `audit-owner-${Date.now()}@test.local`;
  const ownerToken = await registerUser(ctx.api, ownerEmail);
  const cashier = await createCashier(ctx.api, ownerToken, {
    email: `audit-cashier-${Date.now()}@test.local`,
  });

  await t.test('un cierre encola, el worker guarda el informe y la API lo expone', async () => {
    const close = await ctx.api('POST', '/api/cash-closes', {
      token: cashier.token,
      body: { counted_cash: 100, register_id: 'web' },
    });
    assert.equal(close.status, 201);

    const jobs = await ctx.db.execute({
      sql: 'SELECT * FROM audit_jobs WHERE cash_close_id = ? ORDER BY id',
      args: [close.body.id],
    });
    assert.equal(jobs.rows.length, 1);
    assert.equal(jobs.rows[0].status, 'pending');
    assert.equal(Number(jobs.rows[0].source_revision), 0);

    const { recoverStaleJobs, claimAuditJobs, processAuditJob } = await import(
      '../lib/audit/auditProcessor.mjs'
    );
    await recoverStaleJobs(ctx.db);
    let claimed = await claimAuditJobs(ctx.db, 5);
    assert.equal(claimed.length, 1);
    const first = await processAuditJob(ctx.db, claimed[0], { callModel: null });
    assert.equal(first.status, 'ready');

    const reports = await ctx.api('GET', '/api/audit/reports', { token: ownerToken });
    assert.equal(reports.status, 200);
    assert.equal(reports.body.length, 1);
    assert.equal(reports.body[0].cash_close_id, close.body.id);
    assert.equal(reports.body[0].source_revision, 0);
    assert.equal(reports.body[0].model, null);
    assert.equal(reports.body[0].metrics.close.id, close.body.id);

    // Un cajero no puede leer los informes de la tienda, aunque sean suyos.
    assert.equal((await ctx.api('GET', '/api/audit/reports', { token: cashier.token })).status, 403);

    // Corregir el cierre crea una revisión nueva y encola otro trabajo.
    const correction = await ctx.api('PUT', `/api/cash-closes/${close.body.id}`, {
      token: ownerToken,
      body: {
        opening_float: 0,
        counted_cash: 50,
        counted_usd: 0,
        counted_eur: 0,
        note: 'Corrección de prueba',
        correction_revision: 0,
      },
    });
    assert.equal(correction.status, 200);
    assert.ok(correction.body.correction);

    const revisedJobs = await ctx.db.execute({
      sql: 'SELECT * FROM audit_jobs WHERE cash_close_id = ? ORDER BY id',
      args: [close.body.id],
    });
    assert.equal(revisedJobs.rows.length, 2);
    assert.equal(Number(revisedJobs.rows[1].source_revision), 1);

    claimed = await claimAuditJobs(ctx.db, 5);
    assert.equal(claimed.length, 1);
    const second = await processAuditJob(ctx.db, claimed[0], { callModel: null });
    assert.equal(second.status, 'ready');

    const revisedReports = await ctx.api('GET', '/api/audit/reports', { token: ownerToken });
    assert.equal(revisedReports.body.length, 2);
    assert.equal(revisedReports.body[0].source_revision, 1);
    assert.equal(revisedReports.body[0].findings.length > 0, true);
    assert.equal(Array.isArray(revisedReports.body[0].questions), true);
    assert.equal(typeof revisedReports.body[0].next_step, 'string');

    // El panel de administración exige is_admin, no solo ser dueño.
    assert.equal((await ctx.api('GET', '/api/admin/audit/reports', { token: ownerToken })).status, 403);
    await ctx.db.execute({ sql: 'UPDATE users SET is_admin = 1 WHERE email = ?', args: [ownerEmail] });

    const adminReports = await ctx.api('GET', '/api/admin/audit/reports', { token: ownerToken });
    assert.equal(adminReports.status, 200);
    assert.equal(adminReports.body.length, 2);
    assert.equal(adminReports.body[0].store_name, 'Tienda de Prueba');

    const health = await ctx.api('GET', '/api/admin/audit/health', { token: ownerToken });
    assert.equal(health.status, 200);
    assert.equal(health.body.reports, 2);
    assert.equal(health.body.done, 2);
    assert.equal(health.body.failed, 0);

    // Reintentar un trabajo fallido no duplica el informe: el procesador ve el
    // informe 'ready' y solo vuelve a marcar el trabajo como hecho.
    await ctx.db.execute({
      sql: "UPDATE audit_jobs SET status = 'failed', attempts = 3 WHERE id = ?",
      args: [revisedJobs.rows[0].id],
    });
    const retry = await ctx.api('POST', '/api/admin/audit/jobs/retry-failed', { token: ownerToken });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.retried, 1);

    claimed = await claimAuditJobs(ctx.db, 5);
    assert.equal(claimed.length, 1);
    const skipped = await processAuditJob(ctx.db, claimed[0], { callModel: null });
    assert.equal(skipped.status, 'skipped');

    const finalReports = await ctx.api('GET', '/api/audit/reports', { token: ownerToken });
    assert.equal(finalReports.body.length, 2);
  });

  await t.test('un informe de respaldo se reencola y se regenera sin duplicarse', async () => {
    const secondEmail = `audit-retry-${Date.now()}@test.local`;
    const secondOwnerToken = await registerUser(ctx.api, secondEmail);
    const secondCashier = await createCashier(ctx.api, secondOwnerToken, {
      email: `audit-retry-cashier-${Date.now()}@test.local`,
    });
    const secondUser = await ctx.db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [secondEmail],
    });
    const secondUserId = Number(secondUser.rows[0].id);

    const productId = await createProduct(ctx.api, secondOwnerToken, {
      name: 'Producto de auditoría',
      stock: 5,
      sale_price: 1000,
    });
    const sale = await ctx.api('POST', '/api/sales', {
      token: secondCashier.token,
      body: {
        register_id: 'web',
        items: [{ product_id: productId, quantity: 1, unit_price: 1000 }],
        payment_method: 'efectivo',
        client_sale_id: `audit-sale-${Date.now()}`,
      },
    });
    assert.equal(sale.status, 201);

    const close = await ctx.api('POST', '/api/cash-closes', {
      token: secondCashier.token,
      body: { counted_cash: 0, register_id: 'web' },
    });
    assert.equal(close.status, 201);
    assert.ok(Number(close.body.difference) < -500);

    const { claimAuditJobs, processAuditJob } = await import(
      '../lib/audit/auditProcessor.mjs'
    );
    let claimed = await claimAuditJobs(ctx.db, 5);
    assert.equal(claimed.length, 1);
    const fallback = await processAuditJob(ctx.db, claimed[0], {
      callModel: async () => ({ content: { headline: 'Incompleto' }, model: 'test' }),
    });
    assert.equal(fallback.status, 'fallback');

    const fallbackReports = await ctx.api(
      'GET', `/api/admin/audit/reports?user_id=${secondUserId}`, { token: ownerToken },
    );
    assert.equal(fallbackReports.body.length, 1);
    assert.equal(fallbackReports.body[0].status, 'fallback');

    const retry = await ctx.api(
      'POST', `/api/admin/audit/reports/${fallbackReports.body[0].id}/retry`, { token: ownerToken },
    );
    assert.equal(retry.status, 200);

    const jobs = await ctx.db.execute({
      sql: 'SELECT status FROM audit_jobs WHERE cash_close_id = ?',
      args: [close.body.id],
    });
    assert.equal(jobs.rows[0].status, 'pending');

    claimed = await claimAuditJobs(ctx.db, 5);
    assert.equal(claimed.length, 1);
    const ready = await processAuditJob(ctx.db, claimed[0], { callModel: null });
    assert.equal(ready.status, 'ready');

    const reports = await ctx.api(
      'GET', `/api/admin/audit/reports?user_id=${secondUserId}`, { token: ownerToken },
    );
    assert.equal(reports.body.length, 1);
    assert.equal(reports.body[0].status, 'ready');
    assert.equal(reports.body[0].model, null);
  });

  await t.test('la prueba de Gemini exige el secreto y no procesa trabajos pendientes', async () => {
    const before = await ctx.db.execute('SELECT id, status, attempts FROM audit_jobs ORDER BY id');
    const unauthorized = await fetch(`${ctx.baseUrl}/api/cron/audit?probe=1`);
    assert.equal(unauthorized.status, 401);
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const probe = await fetch(`${ctx.baseUrl}/api/cron/audit?probe=1`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      assert.equal(probe.status, 502);
      const result = await probe.json();
      assert.equal(result.probe, true);
      assert.equal(result.code, 'MISSING_KEY');
      assert.equal(result.provider_status, null);
    } finally {
      if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
    }
    const after = await ctx.db.execute('SELECT id, status, attempts FROM audit_jobs ORDER BY id');
    assert.deepEqual(after.rows, before.rows);
  });

  await t.test('el cron protegido procesa la cola sin una sesión de usuario', async () => {
    const close = await ctx.api('POST', '/api/cash-closes', {
      token: cashier.token,
      body: { counted_cash: 100, register_id: 'web' },
    });
    assert.equal(close.status, 201);

    const unauthorized = await fetch(`${ctx.baseUrl}/api/cron/audit`, {
      headers: { 'x-audit-secret': 'secreto-incorrecto' },
    });
    assert.equal(unauthorized.status, 401);

    const cron = await fetch(`${ctx.baseUrl}/api/cron/audit?limit=5`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    assert.equal(cron.status, 200);
    const result = await cron.json();
    assert.equal(result.ok, true);
    assert.equal(result.processed, 1);
    assert.equal(result.results[0].status, 'ready');

    const job = await ctx.db.execute({
      sql: 'SELECT status FROM audit_jobs WHERE cash_close_id = ?',
      args: [close.body.id],
    });
    assert.equal(job.rows[0].status, 'done');

    const reports = await ctx.api('GET', '/api/audit/reports', { token: ownerToken });
    assert.ok(reports.body.some((report) => Number(report.cash_close_id) === Number(close.body.id)));
  });
});
