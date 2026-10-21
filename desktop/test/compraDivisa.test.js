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

const comprarUsd = (queries, extra = {}) =>
  queries.createCurrencyPurchaseLocal({ foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 350, ...extra });

test('compra de divisa en la caja de escritorio', async (t) => {
  await t.test('guarda la compra, calcula los pesos y encola el outbox', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.updateSessionSettings({ transfer_limit: null, usd_rate: 360, eur_rate: 390 });
      const compra = comprarUsd(ctx.queries, { cup_amount: 1 });
      assert.equal(compra.cup_amount, 7000, 'no se acepta el monto en pesos del cliente');
      assert.equal(compra.shop_rate, 360, 'sin shop_rate usa la tasa de la tienda de la sesión');
      assert.equal(compra.origin, 'local');
      assert.equal(compra.cash_close_id, null);
      assert.equal(compra.account_email, 'cajera@mitienda.cu');

      const [op] = outboxDe('currency_purchase.create');
      assert.equal(op.client_op_id, compra.client_purchase_id);
      assert.equal(op.local_ref_id, compra.id);
      const payload = JSON.parse(op.payload);
      assert.equal(payload.client_purchase_id, compra.client_purchase_id);
      assert.equal(payload.foreign_currency, 'USD');
      assert.equal(payload.foreign_amount, 20);
      assert.equal(payload.exchange_rate, 350);
      assert.equal(payload.shop_rate, 360);
      assert.equal(payload.register_id, ctx.queries.getRegisterId());
      assert.match(payload.sold_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    } finally {
      ctx.close();
    }
  });

  await t.test('rechaza compras incompletas sin guardar nada', () => {
    const ctx = startLocalDb();
    try {
      for (const malo of [
        { foreign_currency: 'CAD' }, { foreign_amount: 0 }, { foreign_amount: null },
        { exchange_rate: 0 }, { exchange_rate: 'abc' },
      ]) {
        assert.throws(() => comprarUsd(ctx.queries, malo), (error) => error.code === 'BAD_PURCHASE', JSON.stringify(malo));
      }
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM currency_purchases').get().n, 0);
      assert.equal(outboxDe('currency_purchase.create').length, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('el router deja comprar a un cajero pero solo el dueño ve el historial', async () => {
    const ctx = startLocalDb();
    try {
      const creada = await routeRequest('POST', '/api/currency-purchases', {
        foreign_currency: 'EUR', foreign_amount: 10, exchange_rate: 380,
      });
      assert.equal(creada.status, 201);
      assert.equal(creada.data.cup_amount, 3800);

      const mala = await routeRequest('POST', '/api/currency-purchases', { foreign_currency: 'USD' });
      assert.equal(mala.status, 400);

      assert.equal((await routeRequest('GET', '/api/currency-purchases')).status, 403);

      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      const lista = await routeRequest('GET', '/api/currency-purchases');
      assert.equal(lista.status, 200);
      assert.equal(lista.data.length, 1);
    } finally {
      ctx.close();
    }
  });

  await t.test('el inicio cuenta los pesos que salieron y los billetes que entraron', () => {
    const ctx = startLocalDb();
    try {
      comprarUsd(ctx.queries, { foreign_amount: 10 });
      comprarUsd(ctx.queries, { foreign_currency: 'EUR', foreign_amount: 5, exchange_rate: 380 });
      const { holdings } = ctx.queries.getDashboard();
      assert.equal(holdings.cash, -3500 - 1900);
      assert.equal(holdings.usd, 10);
      assert.equal(holdings.eur, 5);
    } finally {
      ctx.close();
    }
  });

  await t.test('el cierre las descuenta, las marca y las lista en el outbox', () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 5, sale_price: 1000 });
      ctx.queries.createSaleLocal({ items: [{ product_id: producto.id, quantity: 1, unit_price: 1000 }] });
      const usd = comprarUsd(ctx.queries);
      const eur = ctx.queries.createCurrencyPurchaseLocal({ foreign_currency: 'EUR', foreign_amount: 10, exchange_rate: 380 });

      assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, true);

      const cierre = ctx.queries.createCashCloseLocal({
        counted_cash: 12000 + 1000 - 7000 - 3800, opening_float: 12000, counted_usd: 20, counted_eur: 10,
      });
      assert.equal(cierre.expected_cash, 12000 + 1000 - 7000 - 3800);
      assert.equal(cierre.difference, 0);
      assert.equal(cierre.expected_usd, 20);
      assert.equal(cierre.expected_eur, 10);
      assert.equal(cierre.difference_usd, 0);

      const marcadas = ctx.db.prepare('SELECT cash_close_id FROM currency_purchases').all();
      assert.ok(marcadas.every((p) => p.cash_close_id === cierre.id));

      const [op] = outboxDe('cash_close.create');
      assert.deepEqual(
        JSON.parse(op.payload).client_purchase_ids.sort(),
        [usd.client_purchase_id, eur.client_purchase_id].sort()
      );

      // Un segundo cierre no las vuelve a contar y el período queda vacío.
      assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, false);
      const otro = ctx.queries.createCashCloseLocal({ counted_cash: 0 });
      assert.equal(otro.expected_usd, 0);
      assert.deepEqual(JSON.parse(outboxDe('cash_close.create')[1].payload).client_purchase_ids, []);
    } finally {
      ctx.close();
    }
  });

  await t.test('una caja que solo compró divisa también se puede cerrar', () => {
    const ctx = startLocalDb();
    try {
      comprarUsd(ctx.queries);
      const periodo = ctx.queries.getCurrentCashPeriod();
      assert.equal(periodo.has_sales, true);
      assert.ok(periodo.opened_at);
      const cierre = ctx.queries.createCashCloseLocal({ counted_cash: 0, opening_float: 7000, counted_usd: 20 });
      assert.equal(cierre.expected_cash, 0);
      assert.equal(cierre.opened_at, periodo.opened_at);
    } finally {
      ctx.close();
    }
  });

  await t.test('el sync sube la compra antes del cierre que la cubre', async () => {
    const ctx = startLocalDb();
    try {
      const compra = comprarUsd(ctx.queries);
      ctx.queries.createCashCloseLocal({ counted_cash: 0, counted_usd: 20 });
      llamadas.length = 0;

      // El cierre se encoló DESPUÉS de la compra: la compra sube primero y el
      // cierre ya viaja con su client_purchase_id.
      servidor = async (method, path) => {
        if (method === 'POST' && path === '/api/currency-purchases') return { ok: true, status: 201, data: { id: 31 } };
        if (method === 'POST' && path === '/api/cash-closes') return { ok: true, status: 201, data: { id: 41 } };
        if (path === '/api/products') return { ok: true, status: 200, data: [] };
        if (path === '/api/auth/me') return { ok: true, status: 200, data: { user: {} } };
        return { ok: false, status: 404, data: null };
      };
      const resumen = await syncOnce();

      assert.equal(resumen.synced, 2);
      const posts = llamadas.filter((c) => c.method === 'POST');
      assert.deepEqual(posts.map((c) => c.path), ['/api/currency-purchases', '/api/cash-closes']);
      assert.equal(posts[0].body.client_purchase_id, compra.client_purchase_id);
      assert.equal(posts[0].body.foreign_amount, 20);
      assert.ok(posts[0].body.sold_at);
      assert.deepEqual(posts[1].body.client_purchase_ids, [compra.client_purchase_id]);
      assert.equal(ctx.db.prepare('SELECT server_id FROM currency_purchases').get().server_id, 31);
    } finally {
      ctx.close();
    }
  });

  await t.test('el cierre espera si su compra todavía no subió', () => {
    const ctx = startLocalDb();
    try {
      const { buildRequest } = require('../src/sync/syncWorker');
      comprarUsd(ctx.queries);
      ctx.queries.createCashCloseLocal({ counted_cash: 0 });
      const [op] = outboxDe('cash_close.create');
      assert.equal(buildRequest(ctx.db, op).skip, true);
      ctx.db.prepare('UPDATE currency_purchases SET server_id = 5').run();
      assert.equal(buildRequest(ctx.db, op).skip, undefined);
    } finally {
      ctx.close();
    }
  });

  await t.test('una compra repetida (idempotent_replay) cuenta como subida', async () => {
    const ctx = startLocalDb();
    try {
      comprarUsd(ctx.queries);
      servidor = async (method, path) => {
        if (method === 'POST' && path === '/api/currency-purchases') {
          return { ok: false, status: 200, data: { id: 8, idempotent_replay: true } };
        }
        if (path === '/api/products') return { ok: true, status: 200, data: [] };
        return { ok: false, status: 404, data: null };
      };
      const resumen = await syncOnce();
      assert.equal(resumen.synced, 1);
      assert.equal(ctx.db.prepare('SELECT server_id FROM currency_purchases').get().server_id, 8);
    } finally {
      ctx.close();
    }
  });

  await t.test('el delta baja compras remotas como historial, sin tocar el arqueo local', async () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({
        user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 't', role: 'dueño',
      });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      const delta = {
        sales: [], cash_closes: [], inventory_counts: [],
        currency_purchases: [{
          id: 55, user_id: 1, client_purchase_id: 'web-55', foreign_currency: 'USD', foreign_amount: 30,
          exchange_rate: 350, shop_rate: 350, cup_amount: 10500, register_id: 'web:1',
          account_email: 'dueno@mitienda.cu', cash_close_id: null, created_at: '2026-09-23 15:00:00',
        }],
        cursors: { sale: 0, close: 0, count: 0, purchase: 55 }, has_more: false,
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

      assert.equal(resumen.downSync.purchases, 1);
      assert.ok(llamadas.find((c) => c.path.startsWith('/api/sync/delta')).path.includes('after_purchase=0'));
      assert.ok(llamadas.at(-1) && llamadas.some((c) => c.path.includes('after_purchase=55')), 'la segunda pasada pide desde el cursor');
      const fila = ctx.db.prepare('SELECT * FROM currency_purchases').get();
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM currency_purchases').get().n, 1, 'idempotente');
      assert.equal(fila.origin, 'server');
      assert.equal(fila.server_id, 55);
      assert.equal(fila.cup_amount, 10500);
      assert.equal(ctx.queries.getSyncState('delta_after_purchase'), '55');
      assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, false);
      assert.equal(ctx.queries.getDashboard().holdings.cash, 0);
      assert.equal(ctx.queries.listCurrencyPurchases().length, 1);
    } finally {
      ctx.close();
    }
  });

  await t.test('una base anterior sin la tabla la recibe al abrir', () => {
    const Database = require('better-sqlite3');
    const { initLocalDb, closeLocalDb } = require('../src/db/localDb');
    const ctx = startLocalDb();
    const dbPath = ctx.db.name;
    closeLocalDb();
    const old = new Database(dbPath);
    old.exec('DROP TABLE currency_purchases');
    old.close();
    const db = initLocalDb(dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM currency_purchases').get().n, 0);
    } finally {
      closeLocalDb();
      require('fs').rmSync(require('path').dirname(dbPath), { recursive: true, force: true });
    }
  });
});
