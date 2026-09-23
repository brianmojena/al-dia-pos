const test = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../src/sync/apiClient');
const llamadas = [];
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    API_BASE: 'http://servidor-falso',
    apiRequest: async (method, path, opts) => {
      llamadas.push({ method, path, body: opts?.body });
      if (method === 'POST' && path === '/api/sales') return { ok: true, status: 201, data: { id: 500 } };
      return { ok: false, status: 404, data: null };
    },
  },
};

const { startLocalDb, crearProductoSincronizado } = require('./helpers');
const { syncOnce } = require('../src/sync/syncWorker');

test('cobro mixto en la caja de escritorio', async (t) => {
  await t.test('el arqueo local cuenta en la gaveta solo el efectivo de la mixta', () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 300 });
      const venta = ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 1, unit_price: 300 }],
        payment_method: 'mixto', transfer_amount: 120,
      });
      assert.equal(venta.payment_method, 'mixto');
      assert.equal(venta.transfer_amount, 120);

      ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 1, unit_price: 300 }],
        payment_method: 'efectivo',
      });

      const cierre = ctx.queries.createCashCloseLocal({ counted_cash: 530, opening_float: 50 });
      assert.equal(cierre.expected_cash, 50 + 180 + 300);
      assert.equal(cierre.expected_transfer, 120);
      assert.equal(cierre.difference, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('rechaza lo mismo que el servidor, sin tocar el stock', () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 300 });
      const cobrar = (extra) => () => ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 1, unit_price: 300 }], ...extra,
      });

      assert.throws(cobrar({ payment_method: 'tarjeta' }), { code: 'BAD_PAYMENT' });
      assert.throws(cobrar({ payment_method: 'mixto' }), { code: 'BAD_PAYMENT' });
      assert.throws(cobrar({ payment_method: 'mixto', transfer_amount: 0 }), { code: 'BAD_PAYMENT' });
      assert.throws(cobrar({ payment_method: 'mixto', transfer_amount: 300 }), { code: 'BAD_PAYMENT' });

      assert.equal(ctx.db.prepare('SELECT stock FROM products WHERE id = ?').get(producto.id).stock, 10);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE op_type = 'sale.create'").get().n, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('el monto transferido sube con la venta y baja con el delta', async () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 300 });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      const venta = ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 1, unit_price: 300 }],
        payment_method: 'mixto', transfer_amount: 75,
      });

      llamadas.length = 0;
      await syncOnce();
      const subida = llamadas.find((c) => c.method === 'POST' && c.path === '/api/sales');
      assert.equal(subida.body.payment_method, 'mixto');
      assert.equal(subida.body.transfer_amount, 75);
      assert.equal(subida.body.client_sale_id, venta.client_sale_id);

      ctx.queries.applyServerDelta({
        sales: [{ id: 800, client_sale_id: 'web-mixta', total: 400, profit: 100, payment_method: 'mixto',
          transfer_amount: 250, created_at: '2026-09-23 16:00:00', register_id: 'web:2', items: [] }],
        cash_closes: [], inventory_counts: [], cursors: { sale: 800, close: 0, count: 0 }, has_more: false,
      });
      const remota = ctx.db.prepare("SELECT transfer_amount FROM sales WHERE client_sale_id = 'web-mixta'").get();
      assert.equal(remota.transfer_amount, 250);
    } finally {
      ctx.close();
    }
  });
});
