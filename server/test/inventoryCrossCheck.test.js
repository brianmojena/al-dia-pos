const { test } = require('node:test');
const assert = require('node:assert/strict');

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
  assert.match(result.message, /El inventario cuadra/);
});

test('cuadra con faltante de caja: sin diferencias de inventario pero sí en efectivo', () => {
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
  assert.match(result.message, /viene del efectivo/);
});

test('respaldo: faltante de inventario respaldado por faltante de caja', () => {
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
  assert.equal(result.verdict, 'respaldo');
  assert.match(result.message, /ventas sin registrar/);
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
  assert.match(result.message, /no coinciden/);
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
