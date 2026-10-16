import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyData, project, prepareOperation, acknowledgeOperation, monthlyReport, readLocal, businessDate } from './offlineModel.js'
import { monthCsv } from './offlineExport.js'
import { summarizeCashierSales } from './cashierSalesSummary.js'
import { withdrawalSplit } from './payment.js'
import { dailyStockFor } from './dailyStock.js'
const user = { id: 1, role: 'dueño', email: 'owner@test.local', transfer_limit: 200 }
const fixture = () => ({ base: { ...emptyData(), cash_close_coverage_version: 1, products: [{ id: 10, name: 'Pan', purchase_price: 6, sale_price: 10, stock: 20 }] }, outbox: [], nextId: -1 })
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
test('inicio del día local es solo para dueño, conserva la apertura y refleja ventas y conteos pendientes', () => {
  const state = fixture()
  state.base.daily_stock = { date: businessDate(), products: [{ id: 10, opening_stock: 20 }] }
  sell(state, 3)
  const count = add(state, 'POST', '/api/inventory-counts', { items: [{ product_id: 10, counted: 15 }] })
  const ownerRows = readLocal(project(state), '/api/products/day-stock', '1:1', user)
  assert.deepEqual(ownerRows.products[0], { id: 10, opening_stock: 20, current_stock: 15, tracked: true })
  assert.throws(() => readLocal(project(state), '/api/products/day-stock', '1:2', { ...user, id: 2, role: 'cajero' }), /Solo el dueño/)
  assert.equal(count.result.items[0].counted, 15)
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
test('un producto creado localmente guarda timestamp y tiene apertura cero ese día', () => {
  const state = fixture()
  const created = add(state, 'POST', '/api/products', { name: 'Jugo', purchase_price: 2, sale_price: 3, stock: 6 })
  const date = businessDate(created.result.created_at)
  assert.equal(created.result.created_at, '2026-09-15T14:00:00.000Z')
  assert.equal(dailyStockFor({ products: [created.result] }, date).products[0].opening_stock, 0)
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
test('cajero ve su historial personal abierto y cerrado sin datos de costo o ganancia', () => {
  const state = fixture(), cashier = { ...user, id: 2, role: 'cajero', email: 'cashier@test.local' }
  const own = sell(state, 1, { user: cashier, account: '1:2' })
  const other = sell(state, 2, { user, account: '1:1' })
  other.result.cash_close_id = 90

  const openHistory = readLocal(project(state), '/api/sales', '1:2', cashier)
  assert.deepEqual(openHistory.map((sale) => sale.id), [own.result.id], 've su venta abierta, nunca la de otra cuenta')
  assert.equal('profit' in openHistory[0], false)
  assert.equal('unit_cost' in openHistory[0].items[0], false)
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 10 }, { user: cashier, account: '1:2' })
  const data = project(state)
  data.sales.find((sale) => sale.id === own.result.id).account_id = null
  data.cash_closes.find((item) => item.id === close.result.id).account_id = null
  assert.deepEqual(readLocal(data, '/api/sales', '1:2', cashier).map((sale) => sale.id), [own.result.id])
  assert.equal(readLocal(data, `/api/sales/${other.result.id}`, '1:2', cashier), undefined)
  assert.deepEqual(readLocal(data, '/api/cash-closes', '1:2', cashier).map((item) => item.id), [close.result.id])
})
test('resumen de hoy usa la fecha de negocio, pagos en CUP y pendientes del mismo día solamente', () => {
  const state = fixture()
  state.base.sales = [
    { id: 41, account_id: 2, account_email: 'cashier@test.local', total: 20, payment_method: 'mixto', transfer_amount: 5, created_at: '2026-09-15T14:00:00.000Z' },
    { id: 42, account_id: 2, account_email: 'cashier@test.local', total: 30, payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 0.1, exchange_rate: 100, created_at: '2026-09-15T15:00:00.000Z' },
    { id: 43, account_id: 2, account_email: 'cashier@test.local', total: 40, payment_method: 'efectivo', created_at: '2026-09-16T14:00:00.000Z', pending: true },
    { id: 44, account_id: 3, account_email: 'second-cashier@test.local', total: 500, payment_method: 'efectivo', created_at: '2026-09-15T14:00:00.000Z' },
    { id: 45, account_id: 1, account_email: 'owner@test.local', total: 900, payment_method: 'efectivo', created_at: '2026-09-15T14:00:00.000Z' },
  ]
  const cashier = { ...user, id: 2, role: 'cajero', email: 'cashier@test.local' }
  const personal = readLocal(project(state), '/api/sales', '1:2', cashier)
  assert.deepEqual(summarizeCashierSales(personal, '2026-09-15T16:00:00.000Z'), { count: 2, total: 50, pendingCount: 0 })
  assert.equal('profit' in personal[0], false)
  assert.deepEqual(summarizeCashierSales(personal, '2026-09-16T16:00:00.000Z'), { count: 1, total: 40, pendingCount: 1 })

  const filteredDate = readLocal(project(state), '/api/sales?date=2026-09-15', '1:2', cashier)
  assert.deepEqual(summarizeCashierSales(filteredDate, '2026-09-15T16:00:00.000Z'), { count: 2, total: 50, pendingCount: 0 }, 'suma total en CUP y no vuelve a sumar los billetes USD')

  const secondCashier = { ...user, id: 3, role: 'cajero', email: 'second-cashier@test.local' }
  assert.deepEqual(summarizeCashierSales(readLocal(project(state), '/api/sales', '1:3', secondCashier), '2026-09-15T16:00:00.000Z'), { count: 1, total: 500, pendingCount: 0 })
  const emptyCashier = { ...user, id: 4, role: 'cajero', email: 'empty@test.local' }
  assert.deepEqual(summarizeCashierSales(readLocal(project(state), '/api/sales', '1:4', emptyCashier), '2026-09-15T16:00:00.000Z'), { count: 0, total: 0, pendingCount: 0 })
})
test('resumen diario cambia de fecha de negocio a las 04:00 UTC y descarta fechas inválidas', () => {
  const sales = [
    { total: 10.5, pending: true, created_at: '2026-10-15 03:59:00' },
    { total: 25, created_at: '2026-10-15T04:00:00.000Z' },
    { total: 100, created_at: 'fecha inválida' },
    { total: 200, pending: true },
  ]
  assert.deepEqual(summarizeCashierSales(sales, '2026-10-15T03:59:00.000Z'), { count: 1, total: 10.5, pendingCount: 1 }, '03:59 UTC todavía pertenece al día anterior en La Habana')
  assert.deepEqual(summarizeCashierSales(sales, '2026-10-15T04:00:00.000Z'), { count: 1, total: 25, pendingCount: 0 }, '04:00 UTC inicia el nuevo día de negocio')
  assert.deepEqual(summarizeCashierSales(sales, 'not a date'), { count: 0, total: 0, pendingCount: 0 })
})
test('cierre offline del cajero suma venta sincronizada y cobertura exacta para el conteo', () => {
  const state = fixture(), cashier = { ...user, id: 2, role: 'cajero', email: 'cashier@test.local' }
  state.base.sales = [{ id: 101, client_sale_id: 'synced-cash', account_id: 2, account_email: cashier.email,
    register_id: 'web:2', cash_close_id: null, total: 300, payment_method: 'efectivo', created_at: '2026-09-15 10:00:00',
    profit: 250, items: [{ id: 1, product_name: 'Pan', quantity: 1, unit_price: 300, unit_cost: 50 }] }]
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 1300, opening_float: 1000 }, { user: cashier, account: '1:2' })
  assert.equal(close.result.expected_cash, 1300, 'fondo 1000 + venta en efectivo sincronizada 300')
  assert.equal(close.result.difference, 0)
  assert.equal(close.coverageExact, true, 'la cobertura exacta también se envía para cajeros')
  assert.deepEqual(close.body.covered_sale_ids, [101])
  state.base.sales.push({ id: 102, client_sale_id: 'arrived-after-count', account_id: 2, account_email: cashier.email,
    register_id: 'web:2', cash_close_id: null, total: 90, payment_method: 'efectivo', created_at: '2026-09-15 10:05:00' })
  assert.deepEqual(close.body.covered_sale_ids, [101], 'una venta llegada desde otro dispositivo después del conteo queda fuera')
})
test('cierre antiguo con caché sin marcador no declara resultado ni cobertura exacta', () => {
  const state = fixture(), cashier = { ...user, id: 2, role: 'cajero', email: 'cashier@test.local' }
  delete state.base.cash_close_coverage_version
  state.base.current_period = { has_sales: true }
  state.base.sales = []
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 1300, opening_float: 1000, client_close_id: 'legacy-cache-close' }, { user: cashier, account: '1:2' })
  assert.equal(close.coverageComplete, false)
  assert.equal(close.coverageExact, false)
  assert.equal(close.result.coverage_incomplete, true)
  assert.equal(close.result.pending, true)
  assert.equal('covered_sale_ids' in close.body, false)
  assert.equal(readLocal(project(state), '/api/cash-closes/summary', '1:2', user).length, 0, 'un cierre incompleto no contamina el resumen')
})
test('la cobertura exacta incluye todas las ventas abiertas aunque superen 200', () => {
  const state = fixture(), cashier = { ...user, id: 2, role: 'cajero', email: 'cashier@test.local' }
  state.base.sales = Array.from({ length: 237 }, (_, index) => ({ id: index + 1, client_sale_id: `open-${index + 1}`, account_id: 2, account_email: cashier.email, register_id: 'web:2', cash_close_id: null, total: 1, payment_method: 'efectivo' }))
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 1237 }, { user: cashier, account: '1:2' })
  assert.equal(close.saleIds.length, 237)
  assert.equal(close.body.covered_sale_ids.length, 237)
  assert.equal(close.result.expected_cash, 237)
})
test('cierre offline conserva mezcla de pagos, compras y extracciones globales', () => {
  const state = fixture(), cashier = { ...user, id: 2, role: 'cajero', email: 'cashier@test.local' }
  state.base.sales = [
    { id: 201, client_sale_id: 'cash-300', account_id: 2, register_id: 'web:2', cash_close_id: null, total: 300, payment_method: 'efectivo' },
    { id: 202, client_sale_id: 'mixed-200', account_id: 2, register_id: 'web:2', cash_close_id: null, total: 200, payment_method: 'mixto', transfer_amount: 50 },
  ]
  state.base.currency_purchases = [{ id: 31, client_purchase_id: 'usd-buy', register_id: 'web:2', cash_close_id: null, foreign_currency: 'USD', foreign_amount: 1, cup_amount: 100 }]
  state.base.cash_withdrawals = [{ id: 41, client_withdrawal_id: 'owner-withdrawal', register_id: 'web:1', cash_close_id: null, method: 'efectivo', amount: 50, voided_at: null }]
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 1300, opening_float: 1000 }, { user: cashier, account: '1:2' })
  assert.equal(close.result.expected_cash, 1300, '1000 + 300 + (200−50) − 100 − 50')
  assert.equal(close.result.difference, 0)
  assert.deepEqual(close.body.covered_sale_ids, [201, 202])
  assert.deepEqual(close.body.covered_purchase_ids, [31])
  assert.deepEqual(close.withdrawalIds, [41], 'la extracción global se conserva sin ampliar permisos')
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

test('withdrawalSplit resta solo del método extractado y respeta voided_at', () => {
  const w = { method: 'efectivo', amount: 100, voided_at: null }
  assert.deepEqual(withdrawalSplit(w), { cash: -100, transfer: 0, usd: 0, eur: 0 })
  const voided = { ...w, voided_at: '2026-09-15T14:00:00Z' }
  assert.deepEqual(withdrawalSplit(voided), { cash: 0, transfer: 0, usd: 0, eur: 0 })
  const transfer = { method: 'transferencia', amount: 250, voided_at: null }
  assert.deepEqual(withdrawalSplit(transfer), { cash: 0, transfer: -250, usd: 0, eur: 0 })
  const usd = { method: 'USD', amount: 50, voided_at: null }
  assert.deepEqual(withdrawalSplit(usd), { cash: 0, transfer: 0, usd: -50, eur: 0 })
})

test('extracción offline reduce holdings y cierre la cubre', () => {
  const state = fixture()
  sell(state, 1) // 10 en efectivo
  const w = add(state, 'POST', '/api/cash-withdrawals', { method: 'efectivo', amount: 4, note: 'prueba' })
  assert.equal(w.kind, 'withdrawal')
  assert.equal(w.result.amount, 4)
  assert.equal(w.result.note, 'prueba')
  const dashboard = readLocal(project(state), '/api/dashboard', '1:1', user)
  assert.equal(dashboard.holdings.cash, 6)
  assert.equal(dashboard.open_withdrawals.length, 1)
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 6, opening_float: 0 })
  assert.equal(close.result.expected_cash, 6)
  assert.equal(close.result.withdrawn_cash, 4)
  assert.equal(project(state).cash_withdrawals[0].cash_close_id, close.result.id)
})

test('anular extracción restaura holdings, pero no si ya entró en cierre', () => {
  const state = fixture()
  sell(state, 1)
  const w = add(state, 'POST', '/api/cash-withdrawals', { method: 'efectivo', amount: 4 })
  let dashboard = readLocal(project(state), '/api/dashboard', '1:1', user)
  assert.equal(dashboard.holdings.cash, 6)
  const void1 = add(state, 'POST', `/api/cash-withdrawals/${w.result.client_withdrawal_id}/void`, {})
  assert.equal(void1.kind, 'withdrawal_void')
  dashboard = readLocal(project(state), '/api/dashboard', '1:1', user)
  assert.equal(dashboard.holdings.cash, 10)
  assert.equal(dashboard.open_withdrawals.length, 0)
  const w2 = add(state, 'POST', '/api/cash-withdrawals', { method: 'efectivo', amount: 3 })
  const close = add(state, 'POST', '/api/cash-closes', { counted_cash: 7, opening_float: 0 })
  assert.throws(() => add(state, 'POST', `/api/cash-withdrawals/${w2.result.client_withdrawal_id}/void`, {}), /ya entró en un cierre/)
})

test('cajero no puede extraer dinero', () => {
  const state = fixture()
  const cashier = { ...user, role: 'cajero' }
  assert.throws(() => add(state, 'POST', '/api/cash-withdrawals', { method: 'efectivo', amount: 100 }, { user: cashier }), /Solo el dueño/)
  // Create a withdrawal first
  const w = add(state, 'POST', '/api/cash-withdrawals', { method: 'efectivo', amount: 100 })
  assert.throws(() => add(state, 'POST', `/api/cash-withdrawals/${w.result.client_withdrawal_id}/void`, {}, { user: cashier }), /Solo el dueño/)
})
