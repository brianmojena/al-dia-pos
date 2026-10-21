const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb, crearProductoSincronizado, outboxDe } = require('./helpers');

/**
 * La hora de una operación es la del momento en que se hizo, no la de llegada
 * al servidor. El outbox guarda esa hora en ISO UTC para que el delta y los
 * cierres la respeten aunque la caja suba horas después.
 */

const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const deSqliteAIso = (value) => `${value.replace(' ', 'T')}Z`;

test('operaciones offline: fecha real e idempotencia del cobro', async (t) => {
  await t.test('la venta sube con la hora en que se cobró', () => {
    const ctx = startLocalDb();
    try {
      const pan = crearProductoSincronizado(ctx.queries, { name: 'Pan', stock: 10 });
      const venta = ctx.queries.createSaleLocal({
        items: [{ product_id: pan.id, quantity: 1, unit_price: 100 }],
      });

      const payload = JSON.parse(outboxDe('sale.create')[0].payload);
      assert.match(payload.sold_at, isoUtc);
      assert.equal(payload.sold_at, deSqliteAIso(venta.created_at));
    } finally {
      ctx.close();
    }
  });

  await t.test('repetir el IPC con el mismo client_sale_id devuelve la venta original', () => {
    const ctx = startLocalDb();
    try {
      const pan = crearProductoSincronizado(ctx.queries, { name: 'Pan', stock: 10 });
      const body = {
        client_sale_id: 'cobro-del-pos-1',
        items: [{ product_id: pan.id, quantity: 2, unit_price: 100 }],
      };

      const primera = ctx.queries.createSaleLocal(body);
      const segunda = ctx.queries.createSaleLocal(body);

      assert.equal(segunda.id, primera.id, 'el reintento apunta a la misma venta');
      assert.equal(
        ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,
        1,
        'no se cobra dos veces'
      );
      assert.equal(
        ctx.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE op_type = ?').get('sale.create').n,
        1,
        'tampoco se encola dos veces'
      );
      assert.equal(
        ctx.db.prepare('SELECT stock FROM products WHERE id = ?').get(pan.id).stock,
        8,
        'el stock baja una sola vez'
      );
    } finally {
      ctx.close();
    }
  });

  await t.test('el cierre sube con la hora real en que se contó', () => {
    const ctx = startLocalDb();
    try {
      const cierre = ctx.queries.createCashCloseLocal({ counted_cash: 0, opening_float: 0 });
      const payload = JSON.parse(outboxDe('cash_close.create')[0].payload);
      assert.match(payload.closed_at, isoUtc);
      assert.equal(payload.closed_at, deSqliteAIso(cierre.closed_at));
    } finally {
      ctx.close();
    }
  });

  await t.test('el arqueo sube con la hora real en que se contó', () => {
    const ctx = startLocalDb();
    try {
      const pan = crearProductoSincronizado(ctx.queries, { name: 'Pan', stock: 10 });
      const arqueo = ctx.queries.createInventoryCountLocal({
        items: [{ product_id: pan.id, counted: 8 }],
      });
      const payload = JSON.parse(outboxDe('inventory_count.create')[0].payload);
      assert.match(payload.counted_at, isoUtc);
      assert.equal(payload.counted_at, deSqliteAIso(arqueo.counted_at));
    } finally {
      ctx.close();
    }
  });
});
