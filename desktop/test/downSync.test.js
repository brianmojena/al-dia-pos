const test = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../src/sync/apiClient');
let servidor = async () => ({ ok: false, status: 500, data: null });
const llamadas = [];
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    API_BASE: 'http://servidor-falso',
    apiRequest: async (method, path, opts) => {
      llamadas.push({ method, path, opts });
      return servidor(method, path, opts);
    },
  },
};

const { startLocalDb, crearProductoSincronizado } = require('./helpers');
const queries = require('../src/db/queries');
const { syncOnce } = require('../src/sync/syncWorker');

const catalog = () => ({ ok: true, status: 200, data: [] });
const me = () => ({ ok: true, status: 200, data: { user: { transfer_limit: null, usd_rate: null } } });

function ownerSession() {
  queries.setSession({
    user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev',
    token: 'token', role: 'dueño',
  });
}

test('down-sync del escritorio', async (t) => {
  await t.test('baja ventas con ítems, no toca stock y es idempotente', async () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10 });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      const delta = {
        sales: [{
          id: 41, user_id: 1, client_sale_id: 'web-41', total: 200, profit: 80,
          payment_method: 'efectivo', created_at: '2026-09-23 15:00:00',
          register_id: 'web:1', account_email: 'dueno@mitienda.cu',
          items: [{ product_id: 1000 + producto.id, product_name: 'Producto', quantity: 2, unit_price: 100, unit_cost: 60 }],
        }],
        cash_closes: [], inventory_counts: [],
        cursors: { sale: 41, close: 0, count: 0, close_correction: 0 }, has_more: false,
      };
      servidor = async (method, path) => {
        if (path.startsWith('/api/sync/delta')) return { ok: true, status: 200, data: delta };
        if (path === '/api/products') return catalog();
        if (path === '/api/auth/me') return me();
        return { ok: false, status: 404, data: null };
      };

      await syncOnce();
      await syncOnce();

      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
      assert.equal(ctx.db.prepare('SELECT origin, server_id FROM sales').get().origin, 'server');
      assert.equal(ctx.db.prepare('SELECT stock FROM products WHERE id = ?').get(producto.id).stock, 10);
      assert.equal(ctx.db.prepare('SELECT product_id FROM sale_items').get().product_id, producto.id);
      assert.equal(ctx.queries.getSyncState('delta_after_sale'), '41');
    } finally {
      ctx.close();
    }
  });

  await t.test('una venta propia solo se completa con server_id', async () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10 });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      const sale = ctx.queries.createSaleLocal({ items: [{ product_id: producto.id, quantity: 1, unit_price: 100 }] });
      const delta = {
        sales: [{ id: 77, client_sale_id: sale.client_sale_id, total: 100, profit: 40,
          payment_method: 'efectivo', created_at: sale.created_at, register_id: 'desk-x', account_email: 'dueno@mitienda.cu', items: [] }],
        cash_closes: [], inventory_counts: [], cursors: { sale: 77, close: 0, count: 0, close_correction: 0 }, has_more: false,
      };
      servidor = async (_method, path) => path.startsWith('/api/sync/delta') ? { ok: true, status: 200, data: delta } : path === '/api/products' ? catalog() : path === '/api/auth/me' ? me() : { ok: false, status: 404, data: null };
      await syncOnce();
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
      assert.equal(ctx.db.prepare('SELECT server_id FROM sales WHERE client_sale_id = ?').get(sale.client_sale_id).server_id, 77);
    } finally {
      ctx.close();
    }
  });

  await t.test('un estado remoto no cierra una venta local cuyo id colisiona y sin server_id', () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10 });
      const pending = ctx.queries.createSaleLocal({ items: [{ product_id: producto.id, quantity: 1, unit_price: 100 }] });
      const collisionId = Number(pending.id);
      assert.ok(collisionId > 0);
      assert.equal(ctx.db.prepare('SELECT server_id FROM sales WHERE id = ?').get(collisionId).server_id, null);

      queries.applyServerDelta({ sales: [], sale_states: [{ id: collisionId, cash_close_id: 901, closed: 1 }],
        cash_closes: [], inventory_counts: [], cursors: { sale: 0, sale_state: collisionId, close: 0, count: 0, close_correction: 0 }, has_more: false });

      assert.equal(ctx.db.prepare('SELECT cash_close_id FROM sales WHERE id = ?').get(collisionId).cash_close_id, null,
        'el estado solo se aplica a una fila que tenga ese server_id');
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE op_type = 'sale.create' AND status != 'synced'").get().n, 1,
        'la operación local queda pendiente');
    } finally {
      ctx.close();
    }
  });

  await t.test('estados remotos preservan ventas, compras y retiros de un cierre local pendiente', () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10 });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      const sale = ctx.queries.createSaleLocal({ items: [{ product_id: producto.id, quantity: 1, unit_price: 1000 }] });
      const purchase = ctx.queries.createCurrencyPurchaseLocal({ foreign_currency: 'USD', foreign_amount: 1, exchange_rate: 350 });
      const withdrawal = ctx.queries.createWithdrawalLocal({ method: 'efectivo', amount: 20, note: 'compra' });
      ctx.db.prepare('UPDATE sales SET server_id = 501 WHERE id = ?').run(sale.id);
      ctx.db.prepare('UPDATE currency_purchases SET server_id = 502 WHERE id = ?').run(purchase.id);
      ctx.db.prepare('UPDATE cash_withdrawals SET server_id = 503 WHERE id = ?').run(withdrawal.id);
      const close = ctx.queries.createCashCloseLocal({ opening_float: 0, counted_cash: 630 });
      assert.ok(close.id > 0, 'el cierre offline usa su id AUTOINCREMENT positivo');

      const delta = { sales: [], sale_states: [{ id: 501, cash_close_id: 900, closed: 1 }],
        currency_purchases: [], purchase_states: [{ id: 502, cash_close_id: 900, closed: 1 }],
        cash_withdrawals: [], withdrawal_states: [{ id: 503, cash_close_id: 900, voided_at: null, closed: 1, voided: 0 }],
        cash_closes: [], inventory_counts: [], cursors: { sale: 0, sale_state: 501, purchase: 0,
          purchase_state: 502, withdrawal: 0, withdrawal_state: 503, close: 0, count: 0,
          correction: 0, close_correction: 0 }, has_more: false };
      queries.applyServerDelta(delta);
      for (const [table, row] of [['sales', sale], ['currency_purchases', purchase], ['cash_withdrawals', withdrawal]]) {
        assert.equal(ctx.db.prepare(`SELECT cash_close_id FROM ${table} WHERE id = ?`).get(row.id).cash_close_id, close.id,
          `${table} conserva el cierre local pendiente ante estados remotos`);
      }

      ctx.db.prepare('UPDATE sales SET cash_close_id = NULL WHERE id = ?').run(sale.id);
      ctx.db.prepare('UPDATE currency_purchases SET cash_close_id = NULL WHERE id = ?').run(purchase.id);
      ctx.db.prepare('UPDATE cash_withdrawals SET cash_close_id = NULL WHERE id = ?').run(withdrawal.id);
      queries.applyServerDelta(delta);
      for (const [table, row] of [['sales', sale], ['currency_purchases', purchase], ['cash_withdrawals', withdrawal]]) {
        assert.equal(ctx.db.prepare(`SELECT cash_close_id FROM ${table} WHERE id = ?`).get(row.id).cash_close_id, close.id,
          `${table} restaura su vínculo desde las referencias del outbox pendiente`);
      }

      ctx.db.prepare('UPDATE cash_closes SET server_id = 900 WHERE id = ?').run(close.id);
      ctx.db.prepare("UPDATE outbox SET status = 'synced' WHERE op_type = 'cash_close.create' AND local_ref_id = ?").run(close.id);
      queries.applyServerDelta(delta);
      for (const [table, row] of [['sales', sale], ['currency_purchases', purchase], ['cash_withdrawals', withdrawal]]) {
        assert.equal(ctx.db.prepare(`SELECT cash_close_id FROM ${table} WHERE id = ?`).get(row.id).cash_close_id, close.id,
          `${table} mapea el cash_close_id remoto al cierre local conocido`);
      }

      queries.applyServerDelta({ ...delta,
        sale_states: [{ id: 501, cash_close_id: null, closed: 0 }],
        purchase_states: [{ id: 502, cash_close_id: null, closed: 0 }],
        withdrawal_states: [{ id: 503, cash_close_id: null, voided_at: null, closed: 0, voided: 0 }],
      });
      for (const [table, row] of [['sales', sale], ['currency_purchases', purchase], ['cash_withdrawals', withdrawal]]) {
        assert.equal(ctx.db.prepare(`SELECT cash_close_id FROM ${table} WHERE id = ?`).get(row.id).cash_close_id, null,
          `${table} se reabre cuando el servidor elimina su vínculo confirmado`);
      }
    } finally {
      ctx.close();
    }
  });

  await t.test('conserva la línea aunque el producto remoto no exista localmente', async () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      queries.applyServerDelta({
        sales: [{ id: 91, client_sale_id: null, total: 50, profit: 10, payment_method: 'efectivo', created_at: '2026-09-23 16:00:00', register_id: 'web:9', account_email: 'otra@tienda.cu',
          items: [{ product_id: 9999, product_name: 'Producto remoto borrado', quantity: 1, unit_price: 50, unit_cost: 40 }] }],
        cash_closes: [], inventory_counts: [], cursors: { sale: 91, close: 0, count: 0, close_correction: 0 }, has_more: false,
      });
      const item = ctx.db.prepare('SELECT product_id, product_name FROM sale_items').get();
      assert.equal(item.product_id, null);
      assert.equal(item.product_name, 'Producto remoto borrado');
    } finally {
      ctx.close();
    }
  });

  await t.test('si falla una página posterior, conserva la primera y su cursor', async () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      servidor = async (_method, path) => {
        if (path.startsWith('/api/sync/delta')) {
          const query = new URLSearchParams(path.split('?')[1]);
          if (query.get('after_sale') === '0') {
            return { ok: true, status: 200, data: {
              sales: [{ id: 1, client_sale_id: 'page-1', total: 10, profit: 1, payment_method: 'efectivo', created_at: '2026-09-23 16:00:00', register_id: 'web:1', account_email: 'otra@tienda.cu', items: [] }],
              cash_closes: [], inventory_counts: [], cursors: { sale: 1, close: 0, count: 0, close_correction: 0 }, has_more: true,
            } };
          }
          throw Object.assign(new Error('Sin conexión'), { isNetworkError: true });
        }
        if (path === '/api/products') return catalog();
        if (path === '/api/auth/me') return me();
        return { ok: false, status: 404, data: null };
      };
      const summary = await syncOnce();
      assert.equal(summary.downSync.more, true);
      assert.equal(summary.downSync.error, null, 'un corte de red no es un error: se retoma sola');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
      assert.equal(ctx.queries.getSyncState('delta_after_sale'), '1');
    } finally {
      ctx.close();
    }
  });

  await t.test('5.000 ventas se aplican en diez páginas sin dejar outbox a medias', async () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      servidor = async (_method, path) => {
        if (path.startsWith('/api/sync/delta')) {
          const query = new URLSearchParams(path.split('?')[1]);
          const after = Number(query.get('after_sale'));
          const start = after + 1;
          const end = Math.min(start + 499, 5000);
          const sales = [];
          for (let id = start; id <= end; id++) {
            sales.push({ id, client_sale_id: `load-${id}`, total: 1, profit: 0, payment_method: 'efectivo', created_at: '2026-09-23 16:00:00', register_id: 'web:1', account_email: 'otra@tienda.cu', items: [] });
          }
          return { ok: true, status: 200, data: { sales, cash_closes: [], inventory_counts: [], cursors: { sale: end, close: 0, count: 0, close_correction: 0 }, has_more: end < 5000 } };
        }
        if (path === '/api/products') return catalog();
        if (path === '/api/auth/me') return me();
        return { ok: false, status: 404, data: null };
      };
      const summary = await syncOnce();
      assert.deepEqual(summary.downSync, { sales: 5000, closes: 0, counts: 0, purchases: 0, withdrawals: 0, close_corrections: 0, more: false, error: null });
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 5000);
      assert.equal(ctx.queries.getSyncState('delta_after_sale'), '5000');
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'syncing'").get().n, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('un cierre remoto no mueve el período local y un cajero no baja delta', async () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10 });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      const delta = {
        sales: [],
        cash_closes: [{ id: 9, client_close_id: 'web-close', register_id: 'web:2', opened_at: '2026-09-23 10:00:00', closed_at: '2026-09-23 11:00:00', opening_float: 0, expected_cash: 0, counted_cash: 0, difference: 0, expected_transfer: 0, sales_count: 0, note: null, account_email: 'otra@tienda.cu' }],
        inventory_counts: [], cursors: { sale: 0, close: 9, count: 0, close_correction: 0 }, has_more: false,
      };
      servidor = async (_method, path) => path.startsWith('/api/sync/delta') ? { ok: true, status: 200, data: delta } : path === '/api/products' ? catalog() : path === '/api/auth/me' ? me() : { ok: false, status: 404, data: null };
      await syncOnce();
      assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, false);
      assert.equal(ctx.db.prepare("SELECT origin FROM cash_closes WHERE server_id = 9").get().origin, 'server');

      ctx.queries.setSession({ user_id: 1, email: 'cajero@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 'token', role: 'cajero' });
      llamadas.length = 0;
      servidor = async (_method, path) => path === '/api/sync/snapshot'
        ? { ok: true, status: 200, data: { sales: [], cash_closes: [], currency_purchases: [], cash_withdrawals: [] } }
        : path === '/api/products' ? catalog() : path === '/api/auth/me' ? me() : { ok: false, status: 404, data: null };
      await syncOnce();
      assert.equal(llamadas.some((call) => call.path.startsWith('/api/sync/delta')), false);
      assert.equal(llamadas.some((call) => call.path === '/api/sync/snapshot'), true, 'baja solo la proyección personal autorizada');
      void producto;
    } finally {
      ctx.close();
    }
  });

  await t.test('cajero baja sus ventas sincronizadas sin ganancias y las incluye en su cierre', async () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({ user_id: 1, email: 'cajero@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 'token', role: 'cajero' });
      const sale = { id: 61, client_sale_id: 'cashier-cloud-sale', total: 300, payment_method: 'efectivo',
        created_at: '2026-10-14 10:00:00', register_id: 'web:2', account_email: 'cajero@mitienda.cu',
        cash_close_id: null, items: [{ id: 1, product_id: null, product_name: 'Pan', quantity: 1, unit_price: 300 }] };
      servidor = async (_method, path) => path === '/api/sync/snapshot'
        ? { ok: true, status: 200, data: { sales: [sale], cash_closes: [], currency_purchases: [], cash_withdrawals: [] } }
        : path === '/api/products' ? catalog() : path === '/api/auth/me' ? me() : { ok: false, status: 404, data: null };
      const summary = await syncOnce();
      assert.equal(summary.downSync.sales, 1);
      assert.equal(llamadas.some((call) => call.path.startsWith('/api/sync/delta')), false);
      const own = ctx.queries.listSales({ accountEmail: 'cajero@mitienda.cu' });
      assert.equal(own.length, 1);
      assert.equal('profit' in own[0], false);
      assert.equal('unit_cost' in own[0].items[0], false);
      const close = ctx.queries.createCashCloseLocal({ opening_float: 1000, counted_cash: 1300 });
      assert.equal(close.expected_cash, 1300);
      assert.equal(close.difference, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('al refrescar una venta existente aplica cierre del dueño y también reapertura', async () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({ user_id: 1, email: 'cajero@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 'token', role: 'cajero' });
      const sale = { id: 72, client_sale_id: 'cached-sale', total: 100, payment_method: 'efectivo',
        created_at: '2026-10-14 10:00:00', register_id: 'web:2', account_email: 'cajero@mitienda.cu',
        cash_close_id: null, items: [] };
      ctx.queries.applyServerDelta({ sales: [sale], cash_closes: [], inventory_counts: [],
        currency_purchases: [], cash_withdrawals: [], cursors: { sale: 72 }, has_more: false });

      let closed = true;
      servidor = async (_method, path) => path === '/api/sync/snapshot'
        ? { ok: true, status: 200, data: { sales: [{ ...sale, cash_close_id: closed ? 909 : null }],
          cash_closes: [], currency_purchases: [], cash_withdrawals: [], purchase_states: [], withdrawal_states: [] } }
        : path === '/api/products' ? catalog() : path === '/api/auth/me' ? me() : { ok: false, status: 404, data: null };
      await syncOnce();
      let row = ctx.db.prepare('SELECT cash_close_id FROM sales WHERE server_id = 72').get();
      assert.notEqual(row.cash_close_id, null, 'la venta existente queda cerrada aunque no baje la fila del cierre');
      assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, false);

      closed = false;
      await syncOnce();
      row = ctx.db.prepare('SELECT cash_close_id FROM sales WHERE server_id = 72').get();
      assert.equal(row.cash_close_id, null, 'una reapertura remota vuelve a abrir la venta');
      assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, true);
    } finally {
      ctx.close();
    }
  });

  await t.test('una página que la caja no puede aplicar queda informada, no en silencio', async () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      servidor = async (_method, path) => {
        // Respuesta rota: sin listas. Reintentarla no la arregla, así que el
        // resumen tiene que decirlo en vez de repetirla callada cada 30 s.
        if (path.startsWith('/api/sync/delta')) return { ok: true, status: 200, data: { cursors: {} } };
        if (path === '/api/products') return catalog();
        if (path === '/api/auth/me') return me();
        return { ok: false, status: 404, data: null };
      };
      const summary = await syncOnce();
      assert.match(String(summary.downSync.error), /Delta del servidor inválido/);
      assert.equal(ctx.queries.getSyncState('delta_after_sale'), '0', 'el cursor no avanza');
    } finally {
      ctx.close();
    }
  });

  await t.test('si inicia sesión otra tienda, los cursores vuelven a cero', async () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.prepareDeltaSession(1);
      ctx.queries.setSyncState('delta_after_sale', 50);
      ctx.queries.setSyncState('delta_after_close', 7);
      ctx.queries.setSyncState('delta_after_count', 3);
      ctx.queries.setSyncState('delta_after_purchase', 9);
      ctx.queries.setSyncState('delta_after_correction', 4);
      assert.deepEqual(ctx.queries.prepareDeltaSession(1), { sale: 50, sale_state: 0, purchase_state: 0, withdrawal_state: 0, purchase: 9, withdrawal: 0, close: 7, count: 3, correction: 4, close_correction: 0 });
      assert.deepEqual(ctx.queries.prepareDeltaSession(2), { sale: 0, sale_state: 0, purchase_state: 0, withdrawal_state: 0, purchase: 0, withdrawal: 0, close: 0, count: 0, correction: 0, close_correction: 0 });
    } finally {
      ctx.close();
    }
  });

  await t.test('una extracción abierta recibe anulación y cobertura del cierre remoto', async () => {
    const ctx = startLocalDb();
    try {
      ownerSession();
      const withdrawal = ctx.queries.createWithdrawalLocal({ method: 'efectivo', amount: 20, note: 'prueba' });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      assert.equal(withdrawal.server_id, null);

      const base = {
        sales: [], inventory_counts: [],
        cursors: { sale: 0, close: 0, count: 0, close_correction: 0 }, has_more: false,
      };
      queries.applyServerDelta({
        ...base,
        cash_closes: [],
        cash_withdrawals: [{
          id: 501, client_withdrawal_id: withdrawal.client_withdrawal_id,
          method: 'efectivo', amount: 20, note: 'prueba',
          created_at: withdrawal.created_at, voided_at: '2026-10-19 10:00:00',
        }],
      });
      let row = ctx.db.prepare('SELECT * FROM cash_withdrawals WHERE id = ?').get(withdrawal.id);
      assert.equal(row.server_id, 501);
      assert.equal(row.voided_at, '2026-10-19 10:00:00', 'la anulación hecha en otro aparato se refleja');
      assert.equal(row.cash_close_id, null);

      queries.applyServerDelta({
        ...base,
        cash_withdrawals: [{
          id: 501, client_withdrawal_id: withdrawal.client_withdrawal_id,
          method: 'efectivo', amount: 20, created_at: withdrawal.created_at,
          voided_at: '2026-10-19 10:00:00',
        }],
        cash_closes: [{
          id: 900, client_close_id: 'srv-cierre-900',
          opened_at: '2026-10-19 09:00:00', closed_at: '2026-10-19 18:00:00',
          opening_float: 0, expected_cash: 0, counted_cash: 0, difference: 0,
          expected_transfer: 0, sales_count: 0,
          covered_sale_ids: [], covered_purchase_ids: [], covered_withdrawal_ids: [501],
        }],
      });

      const closeId = ctx.db.prepare("SELECT id FROM cash_closes WHERE client_close_id = 'srv-cierre-900'").get().id;
      row = ctx.db.prepare('SELECT * FROM cash_withdrawals WHERE id = ?').get(withdrawal.id);
      assert.equal(row.cash_close_id, closeId, 'la extracción queda cubierta por el cierre remoto');
      assert.equal(row.voided_at, '2026-10-19 10:00:00');
    } finally {
      ctx.close();
    }
  });
});

test('actualizar desde 1.2.1 conserva el período abierto de la caja', () => {
  const Database = require('better-sqlite3');
  const { initLocalDb, closeLocalDb, getLocalDb } = require('../src/db/localDb');
  const ctx = startLocalDb();
  const dbPath = ctx.db.name;
  closeLocalDb();

  // Se lleva la base a la forma que tenía en 1.2.1: sin las columnas nuevas y
  // sin la marca del backfill. Después se cargan datos como los dejaba esa versión.
  const old = new Database(dbPath);
  old.exec(`
    ALTER TABLE sales DROP COLUMN origin;
    ALTER TABLE sales DROP COLUMN register_id;
    ALTER TABLE sales DROP COLUMN cash_close_id;
    ALTER TABLE sales DROP COLUMN account_email;
    ALTER TABLE cash_closes DROP COLUMN origin;
    ALTER TABLE cash_closes DROP COLUMN register_id;
    ALTER TABLE inventory_counts DROP COLUMN origin;
    DELETE FROM sync_state WHERE key = 'local_backfill_v1';
    INSERT INTO sales (client_sale_id, total, payment_method, created_at)
      VALUES ('cerrada', 100, 'efectivo', '2026-09-20 10:00:00'),
             ('abierta', 250, 'efectivo', '2026-09-20 12:00:00');
    INSERT INTO cash_closes (client_close_id, opened_at, closed_at, expected_cash, counted_cash, difference)
      VALUES ('cierre-viejo', '2026-09-20 09:00:00', '2026-09-20 11:00:00', 100, 100, 0);
  `);
  old.close();

  try {
    initLocalDb(dbPath);
    const registerId = ctx.queries.getRegisterId();
    const db = getLocalDb();
    const ventas = db.prepare('SELECT client_sale_id, origin, register_id, cash_close_id, account_email FROM sales ORDER BY id').all();
    const cierre = db.prepare("SELECT id, account_email FROM cash_closes WHERE client_close_id = 'cierre-viejo'").get();

    assert.equal(ventas[0].cash_close_id, cierre.id, 'la venta anterior al cierre queda cubierta por él');
    assert.equal(ventas[1].cash_close_id, null, 'la posterior sigue en el período abierto');
    assert.equal(ventas[1].account_email, null, 'la migración no inventa autoría en una PC compartida');
    assert.equal(cierre.account_email, null, 'el cierre legado conserva autoría desconocida');
    assert.equal(ctx.queries.getCurrentCashPeriod().has_sales, true, 'la caja local conserva su venta legado abierta');
    const cierreNuevo = ctx.queries.createCashCloseLocal({ counted_cash: 250 });
    assert.equal(cierreNuevo.expected_cash, 250, 'la venta legado sin autor sigue entrando en el cajón local');
    assert.ok(ventas.every((v) => v.origin === 'local' && v.register_id === registerId));
    assert.equal(cierreNuevo.sales_count, 1, 'el próximo cierre solo cubre lo que seguía abierto');
    assert.equal(cierreNuevo.expected_cash, 250);
  } finally {
    ctx.close();
  }
});
