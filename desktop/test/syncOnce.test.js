const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Una pasada completa del sync worker contra un servidor falso: sube la cola
 * y después baja el catálogo, en ese orden. Se reemplaza apiClient ANTES de
 * cargar nada que lo use; node --test corre cada archivo en su propio proceso,
 * así que el reemplazo no afecta a los demás tests.
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

const { startLocalDb, crearProductoSincronizado } = require('./helpers');
const { syncOnce } = require('../src/sync/syncWorker');

const sinRed = () => { throw Object.assign(new Error('Sin conexión'), { isNetworkError: true }); };
const yo = { ok: true, status: 200, data: { user: { transfer_limit: null, usd_rate: null } } };

test('pasada completa de sincronización', async (t) => {
  await t.test('sube la venta y después baja el catálogo que ya la incluye', async () => {
    const ctx = startLocalDb();
    try {
      const cafe = crearProductoSincronizado(ctx.queries, { name: 'Café', stock: 10, sale_price: 100 });
      ctx.db.prepare(`UPDATE outbox SET status = 'synced'`).run();
      ctx.queries.createSaleLocal({ items: [{ product_id: cafe.id, quantity: 2, unit_price: 100 }] });
      llamadas.length = 0;

      servidor = async (method, path) => {
        if (method === 'POST' && path === '/api/sales') return { ok: true, status: 201, data: { id: 77 } };
        if (method === 'GET' && path === '/api/products') {
          // El servidor ya descontó la venta y el dueño subió el precio.
          return { ok: true, status: 200, data: [{ id: 1000 + cafe.id, name: 'Café', purchase_price: 60, sale_price: 150, stock: 8 }] };
        }
        if (path === '/api/auth/me') return yo;
        return { ok: false, status: 404, data: null };
      };

      const resumen = await syncOnce();

      assert.equal(resumen.synced, 1);
      assert.equal(resumen.catalogChanged, true);
      assert.ok(
        llamadas.indexOf('POST /api/sales') < llamadas.indexOf('GET /api/products'),
        'primero se sube, después se baja'
      );
      const fila = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(cafe.id);
      assert.equal(fila.stock, 8);
      assert.equal(fila.sale_price, 150);
    } finally {
      ctx.close();
    }
  });

  await t.test('una operación que quedó a medio subir se sube en la pasada siguiente', async () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.createProduct({ name: 'Ron', sale_price: 500, stock: 3 });
      // La app se cerró en plena petición.
      ctx.db.prepare(`UPDATE outbox SET status = 'syncing'`).run();

      servidor = async (method, path) => {
        if (method === 'POST' && path === '/api/products') return { ok: true, status: 201, data: { id: 900 } };
        if (method === 'GET' && path === '/api/products') {
          return { ok: true, status: 200, data: [{ id: 900, name: 'Ron', purchase_price: 0, sale_price: 500, stock: 3 }] };
        }
        if (path === '/api/auth/me') return yo;
        return { ok: false, status: 404, data: null };
      };

      const resumen = await syncOnce();

      assert.equal(resumen.recovered, 1);
      assert.equal(resumen.synced, 1);
      assert.equal(ctx.db.prepare(`SELECT status FROM outbox`).get().status, 'synced');
      assert.equal(ctx.queries.listProducts().length, 1, 'no quedó duplicado al bajar el catálogo');
    } finally {
      ctx.close();
    }
  });

  await t.test('sin internet no rompe nada y la caja sigue con su catálogo', async () => {
    const ctx = startLocalDb();
    try {
      crearProductoSincronizado(ctx.queries, { name: 'Pan' });
      ctx.db.prepare(`UPDATE outbox SET status = 'synced'`).run();
      servidor = async () => sinRed();

      const resumen = await syncOnce();

      assert.equal(resumen.catalogChanged, undefined);
      assert.equal(ctx.queries.listProducts().length, 1);
    } finally {
      ctx.close();
    }
  });

  await t.test('un 403 del servidor queda como conflicto, no se reintenta para siempre', async () => {
    const ctx = startLocalDb();
    try {
      const pan = crearProductoSincronizado(ctx.queries, { name: 'Pan', sale_price: 50 });
      ctx.db.prepare(`UPDATE outbox SET status = 'synced'`).run();
      // Una edición encolada por una versión anterior de la caja, sin permiso en el servidor.
      ctx.queries.updateProduct(pan.id, { sale_price: 10 });

      servidor = async (method, path) => {
        if (method === 'PUT') return { ok: false, status: 403, data: { error: 'Solo el dueño puede ver esto' } };
        if (path === '/api/products') return { ok: true, status: 200, data: [] };
        if (path === '/api/auth/me') return yo;
        return { ok: false, status: 404, data: null };
      };

      const resumen = await syncOnce();
      assert.equal(resumen.conflicts, 1);
      assert.equal(
        ctx.db.prepare(`SELECT status FROM outbox WHERE op_type = 'product.update'`).get().status,
        'conflict'
      );
    } finally {
      ctx.close();
    }
  });
});
