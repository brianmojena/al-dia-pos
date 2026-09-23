const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Jornada offline completa de la caja: todo ocurre sin red (producto, venta,
 * cierre) y una sola pasada de sync lo sube en orden FIFO con el mismo
 * client_sale_id — el servidor aplica idempotencia y recalcula el cierre.
 */

const apiPath = require.resolve('../src/sync/apiClient');
const llamadas = [];
let servidor = async () => ({ ok: false, status: 500, data: null });
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    API_BASE: 'http://servidor-falso',
    apiRequest: async (method, path, opts) => {
      llamadas.push(`${method} ${path}`);
      return servidor(method, path, opts);
    },
  },
};

const { startLocalDb } = require('./helpers');
const { syncOnce } = require('../src/sync/syncWorker');

test('jornada offline: vende y cierra sin red, todo sube en una pasada', async () => {
  const ctx = startLocalDb();
  try {
    // Sin red: el servidor falso falla en todo.
    servidor = async () => { throw Object.assign(new Error('Sin conexión'), { isNetworkError: true }); };

    const pan = ctx.queries.createProduct({ name: 'Pan', stock: 10, sale_price: 100, purchase_price: 60 });
    const venta = ctx.queries.createSaleLocal({
      items: [{ product_id: pan.id, quantity: 2, unit_price: 100 }],
      payment_method: 'efectivo',
    });
    const cierre = ctx.queries.createCashCloseLocal({ counted_cash: 200, opening_float: 0 });

    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).get().n, 3);
    assert.equal(ctx.queries.listProducts()[0].stock, 8, 'el stock local ya se descontó');

    // Vuelve la red: el servidor acepta todo y manda catálogo + ajustes.
    llamadas.length = 0;
    const subidas = [];
    servidor = async (method, path, opts) => {
      if (method === 'POST' && path === '/api/products') { subidas.push('producto'); return { ok: true, status: 201, data: { id: 501 } }; }
      if (method === 'POST' && path === '/api/sales') {
        subidas.push('venta');
        assert.equal(opts.body.client_sale_id, venta.client_sale_id, 'el id de idempotencia viaja intacto');
        return { ok: true, status: 201, data: { id: 601 } };
      }
      if (method === 'POST' && path === '/api/cash-closes') { subidas.push('cierre'); return { ok: true, status: 201, data: { id: 701 } }; }
      if (method === 'GET' && path === '/api/products') {
        return { ok: true, status: 200, data: [{ id: 501, name: 'Pan', purchase_price: 60, sale_price: 100, stock: 8 }] };
      }
      if (path === '/api/auth/me') return { ok: true, status: 200, data: { user: { transfer_limit: 500, usd_rate: 400 } } };
      return { ok: false, status: 404, data: null };
    };

    const resumen = await syncOnce();

    assert.deepEqual(subidas, ['producto', 'venta', 'cierre'], 'orden FIFO: el cierre espera al server_id de la venta');
    assert.equal(resumen.synced, 3);
    assert.equal(resumen.settingsRefreshed, true, 'la tasa y el techo bajan del servidor');
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).get().n, 0);
    const sesion = ctx.db.prepare('SELECT transfer_limit, usd_rate FROM session WHERE id = 1').get();
    assert.equal(sesion.transfer_limit, 500);
    assert.equal(sesion.usd_rate, 400);
    void cierre;
  } finally {
    ctx.close();
  }
});

test('jornada offline: el servidor rechaza la venta y queda como conflicto visible', async () => {
  const ctx = startLocalDb();
  try {
    const pan = ctx.queries.createProduct({ name: 'Pan', stock: 10, sale_price: 100 });
    ctx.db.prepare(`UPDATE outbox SET status = 'synced' WHERE op_type = 'product.create'`).run();
    ctx.db.prepare('UPDATE products SET server_id = 501 WHERE id = ?').run(pan.id);
    ctx.queries.createSaleLocal({
      items: [{ product_id: pan.id, quantity: 2, unit_price: 100 }],
      payment_method: 'efectivo',
    });

    // El servidor dice stock insuficiente (se vendió en otra caja).
    servidor = async (method, path) => {
      if (method === 'POST' && path === '/api/sales') {
        return { ok: false, status: 409, data: { error: 'Stock insuficiente para Pan' } };
      }
      if (method === 'GET' && path === '/api/products') return { ok: true, status: 200, data: [] };
      if (path === '/api/auth/me') return { ok: true, status: 200, data: { user: {} } };
      return { ok: false, status: 404, data: null };
    };

    const resumen = await syncOnce();

    assert.equal(resumen.conflicts, 1);
    const fila = ctx.db.prepare(`SELECT status, last_error FROM outbox WHERE op_type = 'sale.create'`).get();
    assert.equal(fila.status, 'conflict');
    assert.match(String(fila.last_error), /Stock insuficiente/);
  } finally {
    ctx.close();
  }
});
