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
  assert.deepEqual(report.totals, { sales_count: 1, total: 20, profit: 8, cash_total: 20, transfer_total: 0 })
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
  assert.throws(() => add(state, 'PUT', '/api/products/10', { stock: 90 }, { user: cashier }), /Solo el dueño/)
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
