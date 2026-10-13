import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyData, project, prepareOperation, acknowledgeOperation, readLocal } from './offlineModel.js'

const user = { id: 1, role: 'dueño', email: 'owner@test.local', transfer_limit: 200 }
const fixture = () => ({ base: { ...emptyData(), products: [{ id: 10, name: 'Pan', purchase_price: 6, sale_price: 10, stock: 20 }] }, outbox: [], nextId: -1 })
let sequence = 0
const ctx = (state) => ({ account: '1:1', user, now: '2026-09-15T14:00:00.000Z', newId: () => `test-${++sequence}`, localId: () => state.nextId-- })
const add = (state, path, body) => {
  const op = prepareOperation(project(state), 'POST', path, body, ctx(state))
  if (op.kind !== 'noop') state.outbox.push(op)
  return op
}

test('compra de divisa sin internet: resta pesos, suma billetes, entra en el arqueo y en Inicio', () => {
  const state = fixture()
  const compra = (extra) => add(state, '/api/currency-purchases', {
    client_purchase_id: `buy-${++sequence}`, foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 340, shop_rate: 350, cup_amount: 1, ...extra,
  })
  const first = compra()
  assert.equal(first.result.cup_amount, 6800, 'los pesos los calcula el modelo, no el cliente')
  assert.throws(() => compra({ foreign_currency: 'CAD' }), /Moneda/)
  assert.throws(() => compra({ foreign_amount: 0 }), /dólares o euros/)
  assert.throws(() => compra({ exchange_rate: null }), /tasa/)
  const same = prepareOperation(project(state), 'POST', '/api/currency-purchases', first.body, ctx(state))
  assert.equal(same.kind, 'noop', 'reenviar el mismo client_purchase_id no la duplica')

  const data = project(state)
  const dashboard = readLocal(data, '/api/dashboard', '1:1', user)
  assert.equal(dashboard.holdings.cash, -6800)
  assert.equal(dashboard.holdings.usd, 20)
  assert.equal(readLocal(data, '/api/cash-closes/current', '1:1', user).has_sales, true)
  assert.equal(readLocal(data, '/api/currency-purchases', '1:1', user).length, 1)

  const close = add(state, '/api/cash-closes', { counted_cash: 3200, opening_float: 10000, counted_usd: 20 })
  assert.equal(close.result.expected_cash, 3200)
  assert.equal(close.result.expected_usd, 20)
  assert.equal(close.result.difference, 0)
  assert.deepEqual(close.body.covered_purchase_ids, [first.result.id])
  assert.equal(project(state).currency_purchases[0].cash_close_id, close.result.id)

  acknowledgeOperation(state, first.id, { ...first.result, id: 77 })
  assert.deepEqual(state.outbox[0].purchaseIds, [77], 'el cierre apunta al id de nube de la compra')
})
