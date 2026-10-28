const test = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../src/sync/apiClient');
const llamadas = [];
let servidor = async () => ({ ok: false, status: 404, data: null });
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    API_BASE: 'http://servidor-falso',
    apiRequest: async (method, path, opts) => {
      llamadas.push({ method, path, body: opts?.body });
      return servidor(method, path, opts);
    },
  },
};

const { startLocalDb, crearProductoSincronizado, outboxDe } = require('./helpers');
const { syncOnce } = require('../src/sync/syncWorker');
const { routeRequest } = require('../src/router');

const extraerEfectivo = (queries, extra = {}) =>
  queries.createWithdrawalLocal({ method: 'efectivo', amount: 500, ...extra });

test('extracción de caja en la caja de escritorio', async (t) => {
  await t.test('guarda la extracción y encola el outbox', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const extraccion = extraerEfectivo(ctx.queries);
      assert.equal(extraccion.method, 'efectivo');
      assert.equal(extraccion.amount, 500);
      assert.equal(extraccion.origin, 'local');
      assert.equal(extraccion.cash_close_id, null);
      assert.equal(extraccion.voided_at, null);
      assert.equal(extraccion.account_email, 'dueno@mitienda.cu');

      const [op] = outboxDe('cash_withdrawal.create');
      assert.equal(op.client_op_id, extraccion.client_withdrawal_id);
      assert.equal(op.local_ref_id, extraccion.id);
      const payload = JSON.parse(op.payload);
      assert.equal(payload.client_withdrawal_id, extraccion.client_withdrawal_id);
      assert.equal(payload.method, 'efectivo');
      assert.equal(payload.amount, 500);
      assert.equal(payload.register_id, ctx.queries.getRegisterId());
      assert.match(payload.withdrawn_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    } finally {
      ctx.close();
    }
  });

  await t.test('rechaza extracciones incompletas sin guardar nada', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      for (const malo of [
        { method: 'XYZ' }, { amount: 0 }, { amount: null }, { amount: 'abc' },
      ]) {
        assert.throws(() => extraerEfectivo(ctx.queries, malo), (error) => error.code === 'BAD_WITHDRAWAL', JSON.stringify(malo));
      }
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM cash_withdrawals').get().n, 0);
      assert.equal(outboxDe('cash_withdrawal.create').length, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('solo el dueño puede extraer; el cajero recibe 403', async () => {
    const ctx = startLocalDb();
    try {
      // Por defecto la sesión es cajero
      const res1 = await routeRequest('POST', '/api/cash-withdrawals', {
        method: 'efectivo', amount: 500,
      });
      assert.equal(res1.status, 403);

      // Como dueño sí puede
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const res2 = await routeRequest('POST', '/api/cash-withdrawals', {
        method: 'efectivo', amount: 500,
      });
      assert.equal(res2.status, 201);

      // Listar es solo para el dueño
      ctx.queries.setSession({
        user_id: 1, email: 'cajera@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'cajero',
      });
      assert.equal((await routeRequest('GET', '/api/cash-withdrawals')).status, 403);

      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const lista = await routeRequest('GET', '/api/cash-withdrawals');
      assert.equal(lista.status, 200);
      assert.equal(lista.data.length, 1);
    } finally {
      ctx.close();
    }
  });

  await t.test('el dashboard cuenta los pesos/dólares extraídos', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      extraerEfectivo(ctx.queries, { amount: 500 });
      ctx.queries.createWithdrawalLocal({ method: 'transferencia', amount: 300 });
      ctx.queries.createWithdrawalLocal({ method: 'USD', amount: 10 });

      const { holdings } = ctx.queries.getDashboard();
      assert.equal(holdings.cash, -500);
      assert.equal(holdings.transfer, -300);
      assert.equal(holdings.usd, -10);
      assert.equal(holdings.eur, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('open_withdrawals en dashboard lista las no cerradas', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const w1 = extraerEfectivo(ctx.queries);
      const w2 = ctx.queries.createWithdrawalLocal({ method: 'EUR', amount: 20 });

      const dash = ctx.queries.getDashboard();
      assert.equal(dash.open_withdrawals.length, 2);
      assert.equal(dash.open_withdrawals[0].id, w2.id, 'más reciente primero');
      assert.equal(dash.open_withdrawals[1].id, w1.id);
    } finally {
      ctx.close();
    }
  });

  await t.test('el cierre la marca y suma lo extraído', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const producto = crearProductoSincronizado(ctx.queries, { stock: 5, sale_price: 1000 });
      ctx.queries.createSaleLocal({ items: [{ product_id: producto.id, quantity: 1, unit_price: 1000 }] });
      const e1 = extraerEfectivo(ctx.queries, { amount: 500 });
      const e2 = ctx.queries.createWithdrawalLocal({ method: 'USD', amount: 10 });

      const cierre = ctx.queries.createCashCloseLocal({
        counted_cash: 1000 + 10000 - 500, opening_float: 10000, counted_usd: 10,
      });
      assert.equal(cierre.expected_cash, 10000 + 1000 - 500, 'esperado baja por la extracción');
      assert.equal(cierre.withdrawn_cash, 500);
      assert.equal(cierre.withdrawn_usd, 10);
      assert.equal(cierre.difference, 0);

      const marcadas = ctx.db.prepare('SELECT cash_close_id FROM cash_withdrawals').all();
      assert.ok(marcadas.every((w) => w.cash_close_id === cierre.id));

      const [op] = outboxDe('cash_close.create');
      assert.deepEqual(
        JSON.parse(op.payload).client_withdrawal_ids.sort(),
        [e1.client_withdrawal_id, e2.client_withdrawal_id].sort()
      );

      // Un segundo cierre no las vuelve a contar y el período queda vacío.
      assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, false);
      const otro = ctx.queries.createCashCloseLocal({ counted_cash: 0 });
      assert.equal(otro.withdrawn_cash, 0);
      assert.deepEqual(JSON.parse(outboxDe('cash_close.create')[1].payload).client_withdrawal_ids, []);
    } finally {
      ctx.close();
    }
  });

  await t.test('anular una extracción que no está cerrada', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const ext = extraerEfectivo(ctx.queries);

      // Anular
      const anulada = ctx.queries.voidWithdrawalLocal(ext.client_withdrawal_id);
      assert.ok(anulada.voided_at);

      // El dashboard la ignora
      const { holdings } = ctx.queries.getDashboard();
      assert.equal(holdings.cash, 0);

      // open_withdrawals está vacío (anuladas no cuentan como abiertas)
      const { open_withdrawals } = ctx.queries.getDashboard();
      assert.equal(open_withdrawals.length, 0);

      // Anular dos veces es idempotente
      const anulada2 = ctx.queries.voidWithdrawalLocal(ext.client_withdrawal_id);
      assert.equal(anulada2.voided_at, anulada.voided_at);
    } finally {
      ctx.close();
    }
  });

  await t.test('no se puede anular si ya está cubierta por un cierre (409)', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const ext = extraerEfectivo(ctx.queries);

      ctx.queries.createCashCloseLocal({ counted_cash: 0, opening_float: 500 });

      // La extracción ahora está cubierta
      assert.throws(
        () => ctx.queries.voidWithdrawalLocal(ext.client_withdrawal_id),
        (error) => error.code === 'COVERED' && error.status === 409
      );
    } finally {
      ctx.close();
    }
  });

  await t.test('no se puede anular una extracción inexistente (404)', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      assert.throws(
        () => ctx.queries.voidWithdrawalLocal('inexistente'),
        (error) => error.code === 'NOT_FOUND' && error.status === 404
      );
    } finally {
      ctx.close();
    }
  });

  await t.test('el sync sube la extracción antes del cierre que la cubre', async () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const ext = extraerEfectivo(ctx.queries);
      ctx.queries.createCashCloseLocal({ counted_cash: 0, opening_float: 500 });
      llamadas.length = 0;

      servidor = async (method, path) => {
        if (method === 'POST' && path === '/api/cash-withdrawals') return { ok: true, status: 201, data: { id: 31 } };
        if (method === 'POST' && path === '/api/cash-closes') return { ok: true, status: 201, data: { id: 41 } };
        if (path === '/api/products') return { ok: true, status: 200, data: [] };
        if (path === '/api/auth/me') return { ok: true, status: 200, data: { user: {} } };
        return { ok: false, status: 404, data: null };
      };
      const resumen = await syncOnce();

      assert.equal(resumen.synced, 2);
      const posts = llamadas.filter((c) => c.method === 'POST');
      assert.deepEqual(posts.map((c) => c.path), ['/api/cash-withdrawals', '/api/cash-closes']);
      assert.equal(posts[0].body.client_withdrawal_id, ext.client_withdrawal_id);
      assert.equal(posts[0].body.method, 'efectivo');
      assert.equal(posts[0].body.amount, 500);
      assert.ok(posts[0].body.withdrawn_at);
      assert.deepEqual(posts[1].body.client_withdrawal_ids, [ext.client_withdrawal_id]);
      assert.equal(ctx.db.prepare('SELECT server_id FROM cash_withdrawals').get().server_id, 31);
    } finally {
      ctx.close();
    }
  });

  await t.test('el delta baja extracciones remotas', async () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      const delta = {
        sales: [], cash_closes: [], inventory_counts: [], currency_purchases: [],
        cash_withdrawals: [{
          id: 55, user_id: 1, client_withdrawal_id: 'web-55', method: 'efectivo', amount: 800,
          note: null, voided_at: null, register_id: 'web:1',
          account_email: 'dueno@mitienda.cu', cash_close_id: null, created_at: '2026-09-23 15:00:00',
        }],
        cursors: { sale: 0, close: 0, count: 0, purchase: 0, withdrawal: 55 }, has_more: false,
      };
      llamadas.length = 0;
      servidor = async (method, path) => {
        if (path.startsWith('/api/sync/delta')) return { ok: true, status: 200, data: delta };
        if (path === '/api/products') return { ok: true, status: 200, data: [] };
        if (path === '/api/auth/me') return { ok: true, status: 200, data: { user: {} } };
        return { ok: false, status: 404, data: null };
      };

      const resumen = await syncOnce();
      await syncOnce();

      assert.equal(resumen.downSync.withdrawals, 1);
      assert.ok(llamadas.find((c) => c.path.startsWith('/api/sync/delta')).path.includes('after_withdrawal=0'));
      assert.ok(llamadas.at(-1) && llamadas.some((c) => c.path.includes('after_withdrawal=55')), 'la segunda pasada pide desde el cursor');
      const fila = ctx.db.prepare('SELECT * FROM cash_withdrawals').get();
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM cash_withdrawals').get().n, 1, 'idempotente');
      assert.equal(fila.origin, 'server');
      assert.equal(fila.server_id, 55);
      assert.equal(fila.method, 'efectivo');
      assert.equal(fila.amount, 800);
      assert.equal(ctx.queries.getSyncState('delta_after_withdrawal'), '55');
      assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, true, 'el dueño cierra la tienda entera');
      assert.equal(ctx.queries.getDashboard().holdings.cash, -800);
    } finally {
      ctx.close();
    }
  });

  await t.test('el void viaja al servidor', async () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const ext = extraerEfectivo(ctx.queries);
      ctx.queries.voidWithdrawalLocal(ext.client_withdrawal_id);

      const ops = outboxDe('cash_withdrawal.void');
      assert.equal(ops.length, 1);
      const payload = JSON.parse(ops[0].payload);
      assert.equal(payload.client_withdrawal_id, ext.client_withdrawal_id);
    } finally {
      ctx.close();
    }
  });

  await t.test('una extracción sinc (origen server) se resta en el cierre de un cajero', () => {
    const ctx = startLocalDb();
    try {
      // Insertar una extracción como si viniera del sync (server origin)
      const db = ctx.db;
      db.prepare(`
        INSERT INTO cash_withdrawals
          (server_id, client_withdrawal_id, origin, register_id, account_email, method, amount, voided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(55, 'web-55', 'server', ctx.queries.getRegisterId(), 'cajero@tienda.cu', 'efectivo', 800, null);

      // El cajero hace un cierre - debe restar la extracción del servidor
      ctx.queries.setSession({
        user_id: 1, email: 'cajero@tienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'cajero',
      });
      const cierre = ctx.queries.createCashCloseLocal({
        counted_cash: 0, opening_float: 800,
      });
      
      assert.equal(cierre.expected_cash, 0, 'la extracción del servidor se resta del esperado');
      assert.equal(cierre.withdrawn_cash, 800, 'withdrawn_cash registra lo extraído');
    } finally {
      ctx.close();
    }
  });

  await t.test('una extracción anulada no se resta', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const ext = extraerEfectivo(ctx.queries, { amount: 500 });
      
      // Anular
      ctx.queries.voidWithdrawalLocal(ext.client_withdrawal_id);

      // El cierre no la cuenta
      const cierre = ctx.queries.createCashCloseLocal({
        counted_cash: 0, opening_float: 500,
      });
      
      assert.equal(cierre.expected_cash, 500, 'la extracción anulada no se resta');
      assert.equal(cierre.withdrawn_cash, 0, 'withdrawn_cash está vacío porque fue anulada');
    } finally {
      ctx.close();
    }
  });
});
