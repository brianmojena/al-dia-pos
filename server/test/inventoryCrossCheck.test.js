const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startTestServer, registerUser, createProduct } = require('./helpers');

let inventoryCrossCheck;
test.before(async () => {
  inventoryCrossCheck = await import('../lib/audit/inventoryCrossCheck.mjs');
});

const baseClose = (overrides = {}) => ({
  id: 1,
  user_id: 1,
  closed_at: '2026-10-20 18:00:00',
  difference: 0,
  ...overrides,
});

const baseCount = (overrides = {}) => ({
  id: 1,
  user_id: 1,
  counted_at: '2026-10-20 16:00:00',
  account_email: 'contador@test.local',
  ...overrides,
});

const item = (overrides = {}) => ({
  product_id: 1,
  product_name: 'Producto Test',
  expected: 10,
  counted: 10,
  difference: 0,
  unit_cost: 100,
  unit_price: 200,
  ...overrides,
});

test('sin_arqueo: no hay arqueo en la ventana de tiempo', () => {
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose(),
    count: null,
    items: [],
    productsTotal: 10,
  });
  assert.equal(result.available, false);
  assert.equal(result.verdict, 'sin_arqueo');
  assert.match(result.message, /No hay un arqueo de inventario/);
});

test('parcial: cobertura menor al 80%', () => {
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose(),
    count: baseCount(),
    items: [item()], // 1 producto de 10
    productsTotal: 10,
  });
  assert.equal(result.available, true);
  assert.equal(result.verdict, 'parcial');
  assert.match(result.message, /cubrió 1 de 10/);
});

test('cuadra: sin diferencias de inventario y sin faltante de caja', () => {
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose({ difference: 0 }),
    count: baseCount(),
    items: Array.from({ length: 10 }, (_, i) => item({
      product_id: i + 1,
      expected: 10,
      counted: 10,
      difference: 0,
    })),
    productsTotal: 10,
  });
  assert.equal(result.available, true);
  assert.equal(result.verdict, 'cuadra');
  assert.match(result.message, /líneas incluidas en el arqueo coinciden/);
});

test('cuadra con faltante de caja: limita la conclusión al inventario contado', () => {
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose({ difference: -50 }),
    count: baseCount(),
    items: Array.from({ length: 10 }, (_, i) => item({
      product_id: i + 1,
      expected: 10,
      counted: 10,
      difference: 0,
    })),
    productsTotal: 10,
  });
  assert.equal(result.available, true);
  assert.equal(result.verdict, 'cuadra');
  assert.match(result.message, /no demuestra que no haya ventas duplicadas o sin registrar/);
});

test('coincidir en valor no atribuye diferencias a ventas sin registrar', () => {
  // 2 unidades faltan a 200 CUP = 400 CUP faltante
  // Caja falta 500 CUP (en rango 0.6*500=300 a 1.5*500=750)
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose({ difference: -500 }),
    count: baseCount(),
    items: Array.from({ length: 8 }, (_, i) => item({
      product_id: i + 1,
      expected: 10,
      counted: 10,
      difference: 0,
      unit_price: 100,
    })).concat([
      item({ product_id: 9, expected: 10, counted: 8, difference: -2, unit_price: 200 }), // -2 unidades * 200 = -400
    ]),
    productsTotal: 10,
  });
  assert.equal(result.available, true);
  assert.equal(result.verdict, 'diferencias');
  assert.match(result.message, /no demuestra una causa ni ventas duplicadas o sin registrar/);
  assert.match(result.message, /valor neto de mercancía/);
});

test('ajustes previos y productos vendidos sin línea reducen la certeza aunque las líneas cuadren', () => {
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose(),
    count: baseCount(),
    items: [item()],
    productsTotal: 1,
    adjustments: [
      { stock_before: 2, stock_after: 5, created_at: '2026-10-20 15:00:00' },
      { stock_before: 5, stock_after: 4, created_at: '2026-10-20 17:00:00' },
    ],
    uncountedSoldProducts: [{ product_id: 8, product_name: 'Agotado', quantity_sold: 2 }],
  });
  assert.equal(result.verdict, 'parcial');
  assert.equal(result.stock_adjustments_count, 2);
  assert.equal(result.stock_adjustments_before_count, 1);
  assert.equal(result.stock_adjustments_after_count, 1);
  assert.equal(result.stock_adjustment_units_in, 3);
  assert.equal(result.stock_adjustment_units_out, 1);
  assert.equal(result.uncounted_sold_products_count, 1);
  assert.match(result.message, /cruce es incierto/);
  assert.doesNotMatch(result.message, /efectivo perdido|pérdida de caja por ajustes/i);
});

test('diferencias: faltante de inventario no respaldado por caja', () => {
  // 10 unidades faltan pero la caja no falta correspondiente
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose({ difference: 100 }),
    count: baseCount(),
    items: Array.from({ length: 8 }, (_, i) => item({
      product_id: i + 1,
      expected: 10,
      counted: 10,
      difference: 0,
      unit_price: 100,
    })).concat([
      item({ product_id: 9, expected: 10, counted: 0, difference: -10, unit_price: 200 }), // -10 * 200 = -2000
    ]),
    productsTotal: 10,
  });
  assert.equal(result.available, true);
  assert.equal(result.verdict, 'diferencias');
  assert.match(result.message, /coincidencia de valores no demuestra una causa/);
});

test('diferencias: sobrante de inventario', () => {
  // Hay productos que sobran pero la caja no refleja eso
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose({ difference: -50 }),
    count: baseCount(),
    items: Array.from({ length: 8 }, (_, i) => item({
      product_id: i + 1,
      expected: 10,
      counted: 10,
      difference: 0,
      unit_price: 100,
    })).concat([
      item({ product_id: 9, expected: 10, counted: 15, difference: 5, unit_price: 200 }), // 5 extra * 200 = 1000
    ]),
    productsTotal: 10,
  });
  assert.equal(result.available, true);
  assert.equal(result.verdict, 'diferencias');
  assert.match(result.message, /sobran/);
});

test('métricas: calcula units_missing, units_extra y valores', () => {
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose(),
    count: baseCount(),
    items: [
      item({ product_id: 1, expected: 10, counted: 8, difference: -2, unit_price: 100 }),
      item({ product_id: 2, expected: 5, counted: 8, difference: 3, unit_price: 200 }),
    ],
    productsTotal: 5,
  });
  assert.equal(result.available, true);
  assert.equal(result.products_counted, 2);
  assert.equal(result.products_total, 5);
  assert.equal(result.units_missing, 2);
  assert.equal(result.units_extra, 3);
  assert.equal(result.value_missing, 200); // 2 * 100
  assert.equal(result.value_extra, 600); // 3 * 200
  assert.equal(result.net_missing_value, -400); // 200 - 600
});

test('minutos_before_close: calcula correctamente el tiempo entre conteo y cierre', () => {
  const result = inventoryCrossCheck.evaluateCrossCheck({
    close: baseClose({ closed_at: '2026-10-20 18:00:00' }),
    count: baseCount({ counted_at: '2026-10-20 16:00:00' }),
    items: [item()],
    productsTotal: 10,
  });
  assert.equal(result.minutes_before_close, 120); // 2 horas = 120 minutos
});

test('consulta SQL: considera vendidos agotados y ajustes históricos sin leer stock actual', async (t) => {
  const previousTransport = process.env.MYPIMES_TEST_TRANSPORT;
  process.env.MYPIMES_TEST_TRANSPORT = 'in-process';
  t.after(() => {
    if (previousTransport == null) delete process.env.MYPIMES_TEST_TRANSPORT;
    else process.env.MYPIMES_TEST_TRANSPORT = previousTransport;
  });
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const email = `crosscheck-${randomUUID()}@test.local`;
  const token = await registerUser(ctx.api, email);
  const userId = Number((await ctx.db.execute({
    sql: 'SELECT id FROM users WHERE email = ?', args: [email],
  })).rows[0].id);
  const countedProduct = await createProduct(ctx.api, token, { name: 'Contado', stock: 5 });
  const soldOutProduct = await createProduct(ctx.api, token, { name: 'Agotado histórico', stock: 1 });
  const untrackedProduct = await createProduct(ctx.api, token, { name: 'Sin control', stock: 0 });
  const countAt = '2026-10-20 17:00:00';
  const previousAt = '2026-10-19 17:00:00';
  await ctx.db.execute({
    sql: 'UPDATE products SET created_at = ?, stock = 0 WHERE id = ?',
    args: [previousAt, soldOutProduct],
  });
  await ctx.db.execute({
    sql: 'UPDATE products SET created_at = ? WHERE id = ?', args: [previousAt, countedProduct],
  });
  await ctx.db.execute({
    sql: 'UPDATE products SET created_at = ?, track_stock = 0 WHERE id = ?', args: [previousAt, untrackedProduct],
  });
  await ctx.db.execute({
    sql: 'INSERT INTO inventory_counts (user_id, counted_at) VALUES (?, ?)', args: [userId, previousAt],
  });
  const count = await ctx.db.execute({
    sql: 'INSERT INTO inventory_counts (user_id, counted_at, account_email) VALUES (?, ?, ?)',
    args: [userId, countAt, email],
  });
  await ctx.db.execute({
    sql: `INSERT INTO inventory_count_items
          (count_id, product_id, product_name, expected, counted, difference, unit_price)
          VALUES (?, ?, 'Contado', 5, 5, 0, 100)`,
    args: [count.lastInsertRowid, countedProduct],
  });
  for (const adjustment of [
    [2, 5, '2026-10-20 16:00:00'],
    [5, 4, '2026-10-20 17:30:00'],
  ]) {
    await ctx.db.execute({
      sql: `INSERT INTO stock_entries
            (user_id, product_id, product_name, quantity, stock_before, stock_after, kind, created_at)
            VALUES (?, ?, 'Contado', ?, ?, ?, 'correccion', ?)`,
      args: [userId, countedProduct, adjustment[1] - adjustment[0], ...adjustment],
    });
  }
  const sale = await ctx.db.execute({
    // Se usa el vínculo al cierre aunque la fecha offline guardada sea anterior
    // a la apertura de período.
    sql: `INSERT INTO sales (user_id, cash_close_id, total, created_at) VALUES (?, 500, 50, '2026-10-19 12:00:00')`,
    args: [userId],
  });
  await ctx.db.execute({
    sql: `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, pack_size)
          VALUES (?, ?, 'Agotado histórico', 1, 50, 6)`,
    args: [sale.lastInsertRowid, soldOutProduct],
  });
  const untrackedSale = await ctx.db.execute({
    sql: `INSERT INTO sales (user_id, cash_close_id, total, created_at) VALUES (?, 500, 10, '2026-10-20 17:15:00')`,
    args: [userId],
  });
  await ctx.db.execute({
    sql: `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price)
          VALUES (?, ?, 'Sin control', 1, 10)`,
    args: [untrackedSale.lastInsertRowid, untrackedProduct],
  });

  const result = await inventoryCrossCheck.computeInventoryCrossCheck(ctx.db, {
    id: 500,
    user_id: userId,
    opened_at: '2026-10-20 08:00:00',
    closed_at: '2026-10-20 18:00:00',
    difference: -50,
  });
  assert.equal(result.products_total, 2);
  assert.equal(result.products_counted, 1);
  assert.equal(result.verdict, 'parcial');
  assert.equal(result.uncounted_sold_products_count, 1);
  assert.equal(result.uncounted_sold_products[0].product_name, 'Agotado histórico');
  assert.equal(result.uncounted_sold_products[0].quantity_sold, 6);
  assert.equal(result.linked_sales_count, 2);
  assert.equal(result.stock_tracking_history_known, false);
  assert.equal(result.timing_uncertain, true);
  assert.match(result.message, /no se conserva el historial de qué productos tenían control de stock/);
  assert.match(result.message, /fechas offline no siempre reflejan el orden físico/);
  assert.equal(result.stock_adjustments_count, 2);
  assert.equal(result.stock_adjustments_before_count, 1);
  assert.equal(result.stock_adjustments_after_count, 1);
  assert.equal(result.stock_adjustment_units_in, 3);
  assert.equal(result.stock_adjustment_units_out, 1);
});
