import test from 'node:test'
import assert from 'node:assert/strict'
import { dailyStockFor, productDayStockValues } from './dailyStock.js'

test('conserva inicio del snapshot del mismo día y toma el stock actual proyectado', () => {
  const data = {
    daily_stock: { date: '2026-10-16', products: [{ id: 2, opening_stock: 12, entries_stock: 5 }, { id: 3, opening_stock: 4 }] },
    products: [
      { id: 2, stock: 8, pack_size: 5 },
      { id: 3, stock: 2, unit: 'kg', track_stock: 1 },
      { id: 4, stock: 0, unit: 'lb', track_stock: 0 },
    ],
  }
  assert.deepEqual(dailyStockFor(data, '2026-10-16'), {
    date: '2026-10-16',
    products: [
      { id: 2, opening_stock: 12, entries_stock: 5, current_stock: 8, tracked: true },
      { id: 3, opening_stock: 4, entries_stock: null, current_stock: 2, tracked: true },
      { id: 4, opening_stock: null, entries_stock: 0, current_stock: 0, tracked: false },
    ],
  })
})

test('el ejemplo del negocio: inicial + entradas quedan fijos y la venta mueve el disponible', () => {
  // inicial 1, se reciben 24 → disponible 25; se venden 3 → disponible 22,
  // sin tocar inicial (1) ni entradas (24).
  const base = {
    daily_stock: { date: '2026-10-16', products: [{ id: 7, opening_stock: 1, entries_stock: 24, current_stock: 25 }] },
    products: [{ id: 7, stock: 22 }],
  }
  assert.deepEqual(dailyStockFor(base, '2026-10-16').products[0], {
    id: 7, opening_stock: 1, entries_stock: 24, current_stock: 22, tracked: true,
  })
})

test('la ruta offline prefiere el stock del producto proyectado al current_stock del snapshot', () => {
  const result = dailyStockFor({
    daily_stock: { date: '2026-10-16', products: [{ id: 2, opening_stock: 12, entries_stock: 4, current_stock: 12 }] },
    products: [{ id: 2, stock: 8 }],
  }, '2026-10-16')
  assert.deepEqual(result.products[0], {
    id: 2, tracked: true, opening_stock: 12, entries_stock: 4, current_stock: 8,
  })
})

test('no reutiliza el inicio de ayer ni inventa una cifra para el día nuevo', () => {
  const data = {
    daily_stock: { date: '2026-10-15', products: [{ id: 2, opening_stock: 12, entries_stock: 6 }] },
    products: [{ id: 2, stock: 7 }],
  }
  assert.deepEqual(dailyStockFor(data, '2026-10-16').products[0], {
    id: 2, opening_stock: null, entries_stock: null, current_stock: 7, tracked: true,
  })
})

test('descarta el resumen de ayer y usa stock del catálogo como valor actual conocido', () => {
  const product = { id: 2, stock: 7 }
  const expected = { tracked: true, opening_stock: null, entries_stock: null, current_stock: 7 }
  assert.deepEqual(productDayStockValues(
    product,
    { date: '2026-10-15', products: [{ id: 2, opening_stock: 12, entries_stock: 6, current_stock: 9 }] },
    '2026-10-16',
  ), expected)
  assert.deepEqual(productDayStockValues(product, null, '2026-10-16'), expected)
})

test('un producto creado hoy parte de cero aunque aún no exista snapshot diario', () => {
  assert.deepEqual(dailyStockFor({
    products: [{ id: 2, stock: 6, created_at: '2026-10-16T12:00:00.000Z' }],
  }, '2026-10-16').products[0], {
    id: 2, tracked: true, opening_stock: 0, entries_stock: null, current_stock: 6,
  })
})

test('las entradas locales del día se suman al snapshot y no arrastran otro día', () => {
  const data = {
    daily_stock: { date: '2026-10-16', products: [{ id: 2, opening_stock: 1, entries_stock: 24, current_stock: 25 }] },
    products: [{ id: 2, stock: 25 }],
    local_entries: { '2026-10-16': { 2: 6 }, '2026-10-15': { 2: 99 } },
  }
  assert.deepEqual(dailyStockFor(data, '2026-10-16').products[0], {
    id: 2, tracked: true, opening_stock: 1, entries_stock: 30, current_stock: 25,
  })
})

test('sin snapshot diario las entradas locales del día son la cifra a mostrar', () => {
  const data = {
    products: [{ id: 2, stock: 6, created_at: '2026-10-16T12:00:00.000Z' }],
    local_entries: { '2026-10-16': { 2: 6 } },
  }
  assert.deepEqual(dailyStockFor(data, '2026-10-16').products[0], {
    id: 2, tracked: true, opening_stock: 0, entries_stock: 6, current_stock: 6,
  })
})

test('un producto sin control de stock nunca muestra entradas locales', () => {
  const data = {
    daily_stock: { date: '2026-10-16', products: [{ id: 2, opening_stock: 0, entries_stock: 0 }] },
    products: [{ id: 2, stock: 3, unit: 'kg', track_stock: 0 }],
    local_entries: { '2026-10-16': { 2: 5 } },
  }
  assert.deepEqual(dailyStockFor(data, '2026-10-16').products[0], {
    id: 2, tracked: false, opening_stock: null, entries_stock: 0, current_stock: 3,
  })
})
