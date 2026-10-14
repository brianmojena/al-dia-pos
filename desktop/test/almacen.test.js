const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb, crearProductoSincronizado, outboxDe } = require('./helpers');
const { buildRequest } = require('../src/sync/syncWorker');

/**
 * Almacén: la caja lo lee de su espejo y transfiere sin red; la transferencia
 * baja el almacén, sube el stock de la tienda y viaja al servidor como cantidad.
 */
const conCaja = async (fn) => {
  const ctx = startLocalDb();
  try { await fn(ctx); } finally { ctx.close(); }
};
const aceite = [{ id: 7, name: 'Aceite', unit: null, cost: 50, quantity: 10 }];

test('almacén en la caja de escritorio', async (t) => {
  await t.test('transferir un producto que ya está en la tienda suma stock', () => conCaja(({ db, queries }) => {
    crearProductoSincronizado(queries, { name: 'aceite', stock: 2 });
    queries.applyServerWarehouse(aceite);
    queries.transferWarehouseLocal({ warehouse_item_id: 7, quantity: 4 });
    assert.equal(queries.listWarehouse()[0].quantity, 6);
    assert.equal(queries.listProducts()[0].stock, 6);
    const [op] = outboxDe('warehouse.transfer');
    const req = buildRequest(db, op);
    assert.equal(req.path, '/api/warehouse/transfer');
    assert.equal(req.body.quantity, 4);
    assert.equal(req.body.warehouse_item_id, 7);
  }));

  await t.test('producto nuevo exige precio de venta y se crea antes en la cola', () => conCaja(({ queries }) => {
    queries.applyServerWarehouse(aceite);
    assert.throws(() => queries.transferWarehouseLocal({ warehouse_item_id: 7, quantity: 3 }), /precio de venta/);
    queries.transferWarehouseLocal({ warehouse_item_id: 7, quantity: 3, sale_price: 80 });
    const p = queries.listProducts()[0];
    assert.equal(p.stock, 3);
    assert.equal(p.purchase_price, 50);
    assert.equal(outboxDe('product.create').length, 1);
    assert.equal(JSON.parse(outboxDe('product.create')[0].payload).stock, 0);
  }));

  await t.test('no se pasa más de lo que hay y el espejo descuenta lo pendiente', () => conCaja(({ queries }) => {
    queries.applyServerWarehouse(aceite);
    assert.throws(() => queries.transferWarehouseLocal({ warehouse_item_id: 7, quantity: 11, sale_price: 1 }), /solo hay/);
    queries.transferWarehouseLocal({ warehouse_item_id: 7, quantity: 4, sale_price: 1 });
    queries.applyServerWarehouse(aceite); // el servidor aún dice 10
    assert.equal(queries.listWarehouse()[0].quantity, 6);
  }));
});

test('Inicio: lo cobrado aquí y aún sin subir se suma a lo que informa el servidor', async () => conCaja(({ queries }) => {
  const p = crearProductoSincronizado(queries, { name: 'A', stock: 50, sale_price: 100 });
  queries.createSaleLocal({ items: [{ product_id: p.id, quantity: 2, unit_price: 100 }], payment_method: 'efectivo' });
  assert.equal(queries.pendingHoldings().cash, 200);
}));

test('cierre del dueño con lo bajado: cuenta ventas de teléfonos y respeta las ya cerradas', async () => conCaja(({ db, queries }) => {
  queries.setSession({ user_id: 1, email: 'd@t.cu', store_name: 'T', plan: 'dev', token: 't', role: 'dueño' });
  const venta = (id, extra = {}) => ({ id, client_sale_id: `ph-${id}`, total: 100, profit: 40, payment_method: 'efectivo', created_at: '2026-10-13 10:00:00', register_id: 'web:1', items: [], cash_close_id: null, ...extra });
  const page = (sales, closes = []) => ({ sales, cash_closes: closes, inventory_counts: [], currency_purchases: [], cursors: { sale: 99, close: 99, count: 0, purchase: 0 }, has_more: false });
  queries.applyServerDelta(page([venta(1), venta(2), venta(3, { cash_close_id: 50 })]));
  const cierre = queries.createCashCloseLocal({ counted_cash: 200 });
  assert.equal(cierre.expected_cash, 200, 'cuenta las 2 abiertas, no la que ya cerró otra caja');
  // un cierre posterior de otra caja cubre una venta que ya teníamos abierta
  queries.applyServerDelta(page([venta(4)]));
  queries.applyServerDelta(page([], [{ id: 51, client_close_id: 'x', opened_at: '2026-10-13 09:00:00', closed_at: '2026-10-13 11:00:00', expected_cash: 100, counted_cash: 100, difference: 0, covered_sale_ids: [4], covered_purchase_ids: [] }]));
  assert.equal(queries.getCurrentCashPeriod().has_sales, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sales WHERE cash_close_id IS NULL').get().n, 0);
}));
