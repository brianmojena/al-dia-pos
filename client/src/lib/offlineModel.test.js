import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyData, project, prepareOperation, acknowledgeOperation, monthlyReport, readLocal, businessDate } from './offlineModel.js'
import { monthCsv } from './offlineExport.js'
const user = { id: 1, role: 'dueño', email: 'owner@test.local', transfer_limit: 200 }
const fixture = () => ({ base: { ...emptyData(), products: [{ id: 10, name: 'Pan', purchase_price: 6, sale_price: 10, stock: 20 }] }, outbox: [], nextId: -1 })
let sequence = 0
const ctx = (state, overrides = {}) => ({ account: '1:1', user, now: '2026-09-15T14:00:00.000Z', newId: () => `test-${++sequence}`, localId: () => state.nextId--, ...overrides })
const add = (state, method, path, body, overrides) => { const op = prepareOperation(project(state), method, path, body, ctx(state, overrides)); if (op.kind !== 'noop') state.outbox.push(op); return op }
const sell = (state, quantity = 2, overrides) => add(state, 'POST', '/api/sales', { client_sale_id: `sale-${++sequence}`, payment_method: 'efectivo', items: [{ product_id: 10, unit_price: 10, quantity }] }, overrides)

test('venta local persiste al reabrir y aparece en stock, historial, detalle e Inicio', () => {
  const state = fixture(), sale = sell(state)
  const reopened = structuredClone(state), data = project(reopened)
  assert.equal(data.products[0].stock, 18)
  assert.equal(readLocal(data, '/api/sales?date=2026-09-15', '1:1', user)[0].id, sale.result.id)
  assert.equal(readLocal(data, `/api/sales/${sale.result.id}`, '1:1', user).items[0].product_name, 'Pan')
  const report = monthlyReport(data, '2026-09')
  assert.deepEqual(report.totals, { sales_count: 1, off_rate_count: 0, total: 20, profit: 8, cash_total: 20, transfer_total: 0, foreign_total: 0, usd_total: 0, eur_total: 0 })
  assert.equal(state.base.products[0].stock, 20, 'la base no se modifica al proyectar')
})
test('producto nuevo → editar → venta → conteo → cierre conserva dependencias al obtener IDs de nube', () => {
  const state = fixture()
  const create = add(state, 'POST', '/api/products', { name: 'Leche', purchase_price: 3, sale_price: 5, stock: 10 })
  const local = create.result.id
  add(state, 'PUT', `/api/products/${local}`, { name: 'Leche', purchase_price: 3, sale_price: 6, stock: 10 })
  const sale = add(state, 'POST', '/api/sales', { client_sale_id: 'new-product-sale', payment_method: 'mixto', transfer_amount: 4, items: [{ product_id: local, unit_price: 6, quantity: 2 }] })
  const count = add(state, 'POST', '/api/inventory-counts', { items: [{ product_id: local, counted: 7 }] })
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 8, opening_float: 0 })
  assert.equal(project(state).products.find((p) => p.id === local).stock, 7)
  assert.equal(count.result.units_missing, 1)
  assert.equal(close.result.difference, 0)
  acknowledgeOperation(state, create.id, { ...create.result, id: 44 })
  assert.equal(state.productIds[local], 44)
  assert.equal(state.outbox[0].path, '/api/products/44')
  assert.equal(sale.body.items[0].product_id, 44)
  assert.equal(count.body.items[0].product_id, 44)
  assert.equal(project(state).products.find((p) => p.id === 44).stock, 7)
  const saleId = sale.result.id
  acknowledgeOperation(state, sale.id, { ...sale.result, id: 50 })
  assert.deepEqual(close.saleIds, [50])
  assert.equal(project(state).sales[0].id, 50)
  assert.notEqual(saleId, 50)
})
test('cierre cubre exactamente sus ventas y no incluye la siguiente venta offline', () => {
  const state = fixture(), first = sell(state)
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 20, opening_float: 0 })
  const second = sell(state, 1)
  const data = project(state)
  assert.equal(data.sales.find((s) => s.id === first.result.id).cash_close_id, close.result.id)
  assert.equal(data.sales.find((s) => s.id === second.result.id).cash_close_id, null)
  assert.equal(readLocal(data, '/api/cash-closes/current', '1:1', user).has_sales, true)
})
test('reintentar el mismo client_sale_id no duplica ni descuenta stock otra vez', () => {
  const state = fixture(), sale = sell(state)
  const replay = add(state, 'POST', '/api/sales', sale.body)
  assert.equal(replay.kind, 'noop')
  assert.equal(state.outbox.length, 1)
  acknowledgeOperation(state, sale.id, { ...sale.result, id: 22, pending: false })
  assert.equal(project(state).products[0].stock, 18)
  assert.equal(project(state).sales.length, 1)
  acknowledgeOperation(state, sale.id, { ...sale.result, id: 22 })
  assert.equal(project(state).products[0].stock, 18)
})
test('no permite sobreventa con líneas repetidas ni superar el límite de transferencia', () => {
  const state = fixture()
  assert.throws(() => sell(state, 21), /Stock insuficiente/)
  assert.throws(() => add(state, 'POST', '/api/sales', { payment_method: 'efectivo', items: [{ product_id: 10, unit_price: 10, quantity: 11 }, { product_id: 10, unit_price: 10, quantity: 10 }] }), /Stock insuficiente/)
  assert.throws(() => add(state, 'POST', '/api/sales', { payment_method: 'transferencia', items: [{ product_id: 10, unit_price: 300, quantity: 1 }] }), /límite/)
  assert.equal(state.outbox.length, 0)
})
test('el día y mes del negocio usan Cuba incluso cerca de medianoche y cambio de horario', () => {
  assert.equal(businessDate('2026-10-01T02:00:00Z'), '2026-09-30')
  assert.equal(businessDate('2026-11-01T05:30:00Z'), '2026-11-01')
  const state = fixture(); sell(state, 1, { now: '2026-10-01T02:00:00.000Z' })
  assert.equal(monthlyReport(project(state), '2026-09').totals.sales_count, 1)
  assert.equal(monthlyReport(project(state), '2026-10').totals.sales_count, 0)
})
test('cajero conserva restricciones locales y no descarga auditoría por una ruta alternativa', () => {
  const state = fixture(), cashier = { ...user, role: 'cajero' }
  const edited = add(state, 'PUT', '/api/products/10', { sale_price: 12.5 }, { user: cashier })
  assert.equal(project(state).products[0].sale_price, 12.5)
  assert.equal(project(state).products[0].stock, 20)
  assert.equal(project(state).products[0].purchase_price, 6)
  assert.deepEqual(edited.body, { sale_price: 12.5 })
  assert.deepEqual(edited.before, { sale_price: 10 })
  for (const body of [{ stock: 90 }, { name: 'Otro' }, { purchase_price: 0 }, { sale_price: 1, stock: 90 }]) {
    assert.throws(() => add(state, 'PUT', '/api/products/10', body, { user: cashier }), /Solo el dueño/)
  }
  for (const sale_price of [-1, null, '', 'abc']) {
    assert.throws(() => add(state, 'PUT', '/api/products/10', { sale_price }, { user: cashier }), /precio de venta/)
  }
  assert.throws(() => add(state, 'DELETE', '/api/products/10', {}, { user: cashier }), /Solo el dueño/)
  assert.throws(() => readLocal(project(state), '/api/dashboard', '1:2', cashier), /Solo el dueño/)
  assert.throws(() => readLocal(project(state), '/api/reports/days', '1:2', cashier), /Solo el dueño/)
  assert.equal(readLocal(project(state), '/api/products', '1:2', cashier).length, 1)
})
test('exportación local contiene líneas y escapa nombres que Excel interpretaría como fórmulas', () => {
  const state = fixture(); state.base.products[0].name = '=1+2;"Pan"'; sell(state)
  const csv = monthCsv(project(state).sales, '2026-09')
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes("'=1+2;"))
  assert.ok(csv.includes('""Pan""'))
  assert.ok(csv.includes('2026-09-15'))
})
test('cobro en divisa sin internet: vuelto en pesos, arqueo por moneda y aviso de tasa', () => {
  const state = fixture()
  state.base.products[0] = { id: 10, name: 'Aceite', purchase_price: 5000, sale_price: 6000, stock: 5 }
  const divisa = (extra) => add(state, 'POST', '/api/sales', { client_sale_id: `usd-${++sequence}`, payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 350, shop_rate: 360, items: [{ product_id: 10, unit_price: 6000, quantity: 1 }], ...extra })
  const sale = divisa()
  assert.equal(sale.body.exchange_rate, 350)
  assert.equal(sale.body.shop_rate, 360)
  assert.throws(() => divisa({ foreign_currency: 'CAD' }), /Moneda/)
  assert.throws(() => divisa({ foreign_amount: 0 }), /dólares o euros/)
  assert.throws(() => divisa({ exchange_rate: null }), /tasa/)
  // El techo de transferencia (200) no aplica a la divisa.
  assert.equal(state.outbox.length, 1)

  const data = project(state)
  const { totals } = monthlyReport(data, '2026-09')
  assert.equal(totals.cash_total, -1000)
  assert.equal(totals.foreign_total, 7000)
  assert.equal(totals.usd_total, 20)
  assert.equal(totals.off_rate_count, 1)

  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 1000, opening_float: 2000, counted_usd: 15 })
  assert.equal(close.result.expected_cash, 1000)
  assert.equal(close.result.difference, 0)
  assert.equal(close.result.expected_usd, 20)
  assert.equal(close.result.difference_usd, -5)
  assert.ok(monthCsv(project(state).sales, '2026-09').includes('20 USD a 350'))
})

test('producto por peso: se vende en fracciones, el total se redondea y el stock decimal se descuenta', () => {
  const state = fixture()
  const created = add(state, 'POST', '/api/products', { name: 'Frijoles', purchase_price: 80, sale_price: 120, stock: 10, unit: 'lb', track_stock: true })
  assert.equal(created.body.unit, 'lb')
  const local = created.result.id
  const sale = add(state, 'POST', '/api/sales', { client_sale_id: 'peso-1', payment_method: 'efectivo', items: [{ product_id: local, unit_price: 120, quantity: 2.35 }] })
  assert.equal(sale.result.total, 282)
  assert.equal(sale.result.profit, 94)
  assert.equal(project(state).products.find((p) => p.id === local).stock, 7.65)
  const oversell = add(state, 'POST', '/api/sales', { client_sale_id: 'peso-2', payment_method: 'efectivo', items: [{ product_id: local, unit_price: 120, quantity: 8 }] })
  assert.equal(oversell.result.total, 960, 'un producto por peso no bloquea por stock')
  assert.equal(project(state).products.find((p) => p.id === local).stock, 0, 'y el stock queda en 0, no negativo')
  const free = add(state, 'POST', '/api/products', { name: 'Queso', sale_price: 100, stock: 9, unit: 'lb' })
  assert.equal(free.result.track_stock, 0, 'por defecto un producto por peso no lleva stock')
  assert.equal(free.result.stock, 0)
  add(state, 'POST', '/api/sales', { client_sale_id: 'peso-4', payment_method: 'efectivo', items: [{ product_id: free.result.id, unit_price: 100, quantity: 1.5 }] })
  assert.equal(project(state).products.find((p) => p.id === free.result.id).stock, 0)
  assert.throws(() => add(state, 'POST', '/api/inventory-counts', { items: [{ product_id: free.result.id, counted: 3 }] }), /no lleva control/)
  assert.throws(() => add(state, 'POST', '/api/sales', { client_sale_id: 'peso-3', payment_method: 'efectivo', items: [{ product_id: 10, unit_price: 10, quantity: 1.5 }] }), /unidades enteras/)
  assert.throws(() => add(state, 'POST', '/api/products', { name: 'Raro', sale_price: 1, stock: 1, unit: 'oz' }), /unidad/)
  const count = add(state, 'POST', '/api/inventory-counts', { items: [{ product_id: local, counted: 2.25 }] })
  assert.equal(count.result.units_extra, 2.25)
})

test('añadir stock sin internet sube como cantidad a sumar, no como stock final', () => {
  const state = fixture()
  const op = add(state, 'PUT', '/api/products/10', { name: 'Pan', purchase_price: 6, sale_price: 10, stock: 20, add_stock: 5 })
  assert.equal(op.result.stock, 25)
  assert.equal(op.body.add_stock, 5)
  assert.equal('stock' in op.body, false)
  const cashier = { ...user, role: 'cajero' }
  const byCashier = add(state, 'PUT', '/api/products/10', { sale_price: 11, add_stock: 2 }, { user: cashier })
  assert.deepEqual(byCashier.body, { sale_price: 11, add_stock: 2 })
  assert.equal(project(state).products[0].stock, 27)
  assert.throws(() => add(state, 'PUT', '/api/products/10', { add_stock: 0 }), /no es válida/)
})

test('cajero offline consulta solo ventas de hoy sin costes ni ganancias', () => {
  const cashier = { ...user, role: 'cajero' }
  const data = emptyData()
  const sale = { id: 1, created_at: new Date().toISOString(), total: 100, profit: 40, items: [{ id: 1, product_name: 'Pan', quantity: 1, unit_price: 100, unit_cost: 60 }] }
  data.sales = [sale, { ...sale, id: 2, created_at: '2000-01-01 12:00:00' }]
  const visible = readLocal(data, '/api/sales', '1:2', cashier)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].id, 1)
  assert.equal('profit' in visible[0], false)
  assert.equal('unit_cost' in visible[0].items[0], false)
  assert.equal(readLocal(data, '/api/sales/1', '1:2', cashier).items[0].product_name, 'Pan')
  assert.equal(readLocal(data, '/api/sales/2', '1:2', cashier), undefined)
  assert.throws(() => readLocal(data, '/api/sales?date=2000-01-01', '1:2', cashier), /historial de hoy/)
  assert.throws(() => readLocal(data, '/api/reports/days', '1:2', cashier), /Solo el dueño/)
  assert.equal(data.sales[0].profit, 40)
})

test('cajero realiza arqueo offline con atribución, ajuste e idempotencia sin acceso al historial', () => {
  const state = fixture(), cashier = { ...user, id: 2, role: 'cajero', email: 'caja@test.local' }
  const overrides = { user: cashier, account: '1:2' }
  const body = { client_count_id: 'cashier-count', items: [{ product_id: 10, counted: 17 }], note: 'Cierre del turno' }
  const count = add(state, 'POST', '/api/inventory-counts', body, overrides)
  const data = project(state)
  assert.equal(count.result.account_email, cashier.email)
  assert.equal(count.result.units_missing, 3)
  assert.equal(data.products[0].stock, 17)
  assert.equal(data.inventory_counts[0].note, body.note)
  const replay = add(state, 'POST', '/api/inventory-counts', body, overrides)
  assert.equal(replay.kind, 'noop')
  assert.equal(project(state).inventory_counts.length, 1)
  assert.throws(() => readLocal(data, '/api/inventory-counts', '1:2', cashier), /Solo el dueño/)
})
