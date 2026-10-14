const test = require('node:test');
const assert = require('node:assert/strict');

const { startLocalDb, crearProductoSincronizado } = require('./helpers');

const venta = (id, extra = {}) => ({
  id, user_id: 1, client_sale_id: `web-${id}`, total: 1200, profit: 400,
  payment_method: 'efectivo', created_at: '2026-10-14 15:00:00', register_id: 'web:1',
  account_email: 'cajero@mitienda.cu', cash_close_id: 7, items: [], ...extra,
});
const cierre = (extra = {}) => ({
  id: 7, client_close_id: 'cierre-7', register_id: 'web:1', opened_at: '2026-10-14 12:00:00',
  closed_at: '2026-10-14 20:00:00', opening_float: 0, expected_cash: 2400, counted_cash: 1200,
  difference: -1200, expected_transfer: 0, sales_count: 2, account_email: 'cajero@mitienda.cu', ...extra,
});
const pagina = (extra) => ({
  sales: [], cash_closes: [], inventory_counts: [],
  cursors: { sale: 0, close: 0, count: 0 }, has_more: false, ...extra,
});

test('correcciones de ventas en el escritorio', async (t) => {
  await t.test('cambio de pago y anulación llegan con el delta y recalculan el cierre', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.prepareDeltaSession(1);
      crearProductoSincronizado(ctx.queries, { stock: 10 });
      ctx.queries.applyServerDelta(pagina({
        sales: [venta(41), venta(42)],
        cash_closes: [{ ...cierre(), covered_sale_ids: [41, 42] }],
        cursors: { sale: 42, close: 7, count: 0 },
      }));

      ctx.queries.applyServerDelta(pagina({
        cursors: { sale: 42, close: 7, count: 0, correction: 2 },
        sale_corrections: [
          { id: 1, action: 'pago', sale_id: 41, client_sale_id: 'web-41',
            sale: venta(41, { payment_method: 'transferencia' }),
            cash_close: cierre({ expected_cash: 1200, difference: 0, expected_transfer: 1200, corrected_at: '2026-10-15 10:00:00', original_difference: -1200 }) },
          { id: 2, action: 'anular', sale_id: 42, client_sale_id: 'web-42', sale: null,
            cash_close: cierre({ expected_cash: 0, difference: 1200, expected_transfer: 1200, sales_count: 1 }) },
        ],
      }));

      const ventas = ctx.queries.listSales();
      assert.equal(ventas.length, 1);
      assert.equal(ventas[0].payment_method, 'transferencia');
      const close = ctx.db.prepare("SELECT * FROM cash_closes WHERE client_close_id = 'cierre-7'").get();
      assert.equal(close.difference, 1200);
      assert.equal(close.sales_count, 1);
      assert.equal(ctx.queries.getSyncState('delta_after_correction'), '2');
      assert.equal(ctx.queries.prepareDeltaSession(1).correction, 2);
    } finally { ctx.close(); }
  });

  await t.test('la cuenta principal pone el stock a mano y queda anotado con el motivo', () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 58 });
      ctx.queries.updateProduct(producto.id, { sale_price: 120 });
      ctx.queries.updateProduct(producto.id, { stock: 55, stock_reason: 'conteo' });
      const [entrada] = ctx.queries.listStockEntries();
      assert.equal(entrada.kind, 'correccion');
      assert.equal(entrada.quantity, -3);
      assert.equal(entrada.reason, 'conteo');
      const op = ctx.db.prepare("SELECT payload FROM outbox WHERE op_type = 'product.update' ORDER BY id DESC").get();
      assert.equal(JSON.parse(op.payload).stock_reason, 'conteo');
      assert.equal(ctx.queries.listStockEntries().length, 1);
    } finally { ctx.close(); }
  });
});
