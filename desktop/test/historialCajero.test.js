const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb, crearProductoSincronizado } = require('./helpers');
const { routeRequest } = require('../src/router');
const { todayBounds } = require('../src/lib/businessDay');

test('historial de cajero en escritorio: hoy, solo lectura y detalles', async () => {
  const ctx = startLocalDb();
  try {
    const product = crearProductoSincronizado(ctx.queries);
    const sale = ctx.queries.createSaleLocal({ items: [{ product_id: product.id, quantity: 1, unit_price: 100 }] });
    const old = ctx.queries.createSaleLocal({ items: [{ product_id: product.id, quantity: 1, unit_price: 100 }] });
    ctx.db.prepare("UPDATE sales SET created_at = datetime(?, '-1 second') WHERE id = ?").run(todayBounds().start, old.id);
    const list = await routeRequest('GET', '/api/sales');
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.map((s) => s.id), [sale.id]);
    assert.equal('profit' in list.data[0], false);
    const detail = await routeRequest('GET', `/api/sales/${sale.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.items.length, 1);
    assert.equal('unit_cost' in detail.data.items[0], false);
    assert.equal((await routeRequest('GET', `/api/sales/${old.id}`)).status, 404);
    assert.equal((await routeRequest('GET', '/api/sales?date=2000-01-01')).status, 403);
    assert.equal((await routeRequest('POST', `/api/sales/${sale.id}/correct`, { action: 'anular' })).status, 403);
  } finally { ctx.close(); }
});

test('historial remoto conserva otras cajas offline, refleja correcciones y no afecta el arqueo', async () => {
  const ctx = startLocalDb();
  try {
    const { saveHistory } = require('../src/cashierHistory');
    const session = ctx.queries.getSession();
    const product = crearProductoSincronizado(ctx.queries);
    const local = ctx.queries.createSaleLocal({ items: [{ product_id: product.id, quantity: 1, unit_price: 100 }] });
    const remote = { id: 9000, client_sale_id: 'other-register', created_at: new Date().toISOString(), total: 200, profit: 80, payment_method: 'efectivo', items: [{ id: 1, product_name: 'Pan', quantity: 2, unit_price: 100, unit_cost: 60 }] };
    saveHistory(session, [remote]);
    const list = await routeRequest('GET', '/api/sales');
    assert.equal(list.data.length, 2);
    assert.ok(list.data.some((s) => s.id === local.id));
    const detail = await routeRequest('GET', '/api/sales/-9000');
    assert.equal(detail.status, 200);
    assert.equal(detail.data.items[0].product_name, 'Pan');
    assert.equal('unit_cost' in detail.data.items[0], false);
    assert.equal(ctx.queries.listSales().length, 1, 'la copia remota no modifica ventas contables');
    saveHistory(session, [{ ...remote, payment_method: 'transferencia' }]);
    assert.equal((await routeRequest('GET', '/api/sales/-9000')).data.payment_method, 'transferencia');
    saveHistory(session, []);
    assert.equal((await routeRequest('GET', '/api/sales/-9000')).status, 404);
    assert.equal((await routeRequest('GET', '/api/sales')).data.length, 1, 'la venta local pendiente permanece');
  } finally { ctx.close(); }
});
