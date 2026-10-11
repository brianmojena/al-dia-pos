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
      if (method === 'POST' && path === '/api/sales') return { ok: true, status: 201, data: { id: 600 } };
      if (method === 'POST' && path === '/api/cash-closes') return { ok: true, status: 201, data: { id: 700 } };
      return { ok: false, status: 404, data: null };
    },
  },
};

const { startLocalDb, crearProductoSincronizado } = require('./helpers');
const { syncOnce } = require('../src/sync/syncWorker');

const usd = (amount, rate, extra = {}) => ({
  payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: amount, exchange_rate: rate, ...extra,
});

test('cobro en divisa en la caja de escritorio', async (t) => {
  await t.test('el arqueo local descuenta el vuelto y espera los dólares aparte', () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 6000 });
      const venta = ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 1, unit_price: 6000 }],
        ...usd(20, 350, { shop_rate: 360 }),
      });
      assert.equal(venta.foreign_currency, 'USD');
      assert.equal(venta.exchange_rate, 350);
      assert.equal(venta.shop_rate, 360);

      const cierre = ctx.queries.createCashCloseLocal({ counted_cash: 1000, opening_float: 2000, counted_usd: 20 });
      assert.equal(cierre.expected_cash, 1000, 'fondo 2000 menos 1000 de vuelto');
      assert.equal(cierre.difference, 0);
      assert.equal(cierre.expected_usd, 20);
      assert.equal(cierre.difference_usd, 0);
      assert.equal(cierre.expected_eur, 0);

      assert.equal(ctx.queries.getDashboard().audit.offRateSales, 1, 'cobró a 350 con la tienda a 360');
    } finally {
      ctx.close();
    }
  });

  await t.test('sin shop_rate usa la tasa de la tienda guardada en la sesión', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.updateSessionSettings({ transfer_limit: null, usd_rate: 355, eur_rate: 390 });
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 3550 });
      const venta = ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 1, unit_price: 3550 }], ...usd(10, 355),
      });
      assert.equal(venta.shop_rate, 355);
    } finally {
      ctx.close();
    }
  });

  await t.test('rechaza lo mismo que el servidor, sin tocar el stock', () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 300 });
      const cobrar = (extra) => () => ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 1, unit_price: 300 }], ...usd(1, 350), ...extra,
      });
      assert.throws(cobrar({ foreign_currency: 'CAD' }), { code: 'BAD_PAYMENT' });
      assert.throws(cobrar({ foreign_amount: 0 }), { code: 'BAD_PAYMENT' });
      assert.throws(cobrar({ exchange_rate: null }), { code: 'BAD_PAYMENT' });
      assert.equal(ctx.db.prepare('SELECT stock FROM products WHERE id = ?').get(producto.id).stock, 10);
    } finally {
      ctx.close();
    }
  });

  await t.test('la divisa sube con la venta y el conteo con el cierre, y baja con el delta', async () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 8000 });
      ctx.db.prepare("UPDATE outbox SET status = 'synced'").run();
      ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 1, unit_price: 8000 }],
        payment_method: 'divisa', foreign_currency: 'EUR', foreign_amount: 20, exchange_rate: 380, shop_rate: 380,
      });
      ctx.queries.createCashCloseLocal({ counted_cash: 400, counted_eur: 20 });

      llamadas.length = 0;
      await syncOnce();
      await syncOnce();
      const venta = llamadas.find((c) => c.path === '/api/sales');
      assert.equal(venta.body.payment_method, 'divisa');
      assert.equal(venta.body.foreign_currency, 'EUR');
      assert.equal(venta.body.foreign_amount, 20);
      assert.equal(venta.body.exchange_rate, 380);
      assert.equal(venta.body.shop_rate, 380);
      const cierre = llamadas.find((c) => c.path === '/api/cash-closes');
      assert.equal(cierre.body.counted_eur, 20);
      assert.equal(cierre.body.counted_usd, 0);

      ctx.queries.applyServerDelta({
        sales: [{ id: 801, client_sale_id: 'web-usd', total: 7000, profit: 100, payment_method: 'divisa',
          foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 350, shop_rate: 350,
          created_at: '2026-10-10 16:00:00', register_id: 'web:2', items: [] }],
        cash_closes: [{ id: 901, client_close_id: 'web-cierre', opened_at: '2026-10-10 10:00:00',
          closed_at: '2026-10-10 18:00:00', expected_cash: 0, counted_cash: 0, difference: 0,
          expected_usd: 20, counted_usd: 15, difference_usd: -5 }],
        inventory_counts: [], cursors: { sale: 801, close: 901, count: 0 }, has_more: false,
      });
      const remota = ctx.db.prepare("SELECT * FROM sales WHERE client_sale_id = 'web-usd'").get();
      assert.equal(remota.foreign_currency, 'USD');
      assert.equal(remota.exchange_rate, 350);
      const cierreRemoto = ctx.db.prepare("SELECT * FROM cash_closes WHERE client_close_id = 'web-cierre'").get();
      assert.equal(cierreRemoto.difference_usd, -5);
    } finally {
      ctx.close();
    }
  });
});
