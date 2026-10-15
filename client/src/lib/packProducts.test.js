import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyData, project, prepareOperation, applyOperation } from './offlineModel.js'
import { applyPendingSales } from './offlineStock.js'
import { formatPackStock, packCountTotal } from './units.js'

const user = { id: 1, role: 'dueño', email: 'owner@test.local', transfer_limit: 200 }
const fixture = () => ({ base: { ...emptyData(), products: [{ id: 10, name: 'Popular', purchase_price: 15, sale_price: 20, stock: 60, pack_size: 20, pack_price: 300 }] }, outbox: [], nextId: -1 })
let sequence = 0
const ctx = (state, overrides = {}) => ({ account: '1:1', user, now: '2026-09-15T14:00:00.000Z', newId: () => `test-${++sequence}`, localId: () => state.nextId--, ...overrides })
const add = (state, method, path, body, overrides) => { const op = prepareOperation(project(state), method, path, body, ctx(state, overrides)); if (op.kind !== 'noop') state.outbox.push(op); return op }

test('venta offline de 2 paquetes de 20 + 3 sueltos: stock baja 43, línea lleva nombre y costo correctos', () => {
  const state = fixture()
  const sale = add(state, 'POST', '/api/sales', {
    client_sale_id: 'pack-sale-1',
    payment_method: 'efectivo',
    items: [
      { product_id: 10, unit_price: 300, quantity: 2, pack_size: 20 },
      { product_id: 10, unit_price: 20, quantity: 3, pack_size: null }
    ]
  })
  const data = project(state)
  assert.equal(data.products[0].stock, 17, '60 - (2 * 20) - 3 = 17')
  const packLine = sale.result.items[0]
  assert.equal(packLine.product_name, 'Popular (paquete de 20)')
  assert.equal(packLine.unit_cost, 300, 'purchase_price 15 * 20 = 300')
  const looseLine = sale.result.items[1]
  assert.equal(looseLine.product_name, 'Popular')
  assert.equal(looseLine.unit_cost, 15)
})

test('venta de paquetes que supera el stock falla con Stock insuficiente', () => {
  const state = fixture()
  assert.throws(() => add(state, 'POST', '/api/sales', {
    client_sale_id: 'pack-fail',
    payment_method: 'efectivo',
    items: [{ product_id: 10, unit_price: 300, quantity: 4, pack_size: 20 }]
  }), /Stock insuficiente/)
})

test('applyPendingSales resta unidades en packs', () => {
  // Simula: el servidor tiene stock 60, se vendieron 2 paquetes sin internet.
  const catalogo = [{ id: 10, name: 'Popular', stock: 60, pack_size: 20 }]
  const cola = [{ client_sale_id: 'offline-pack', items: [{ product_id: 10, quantity: 2, pack_size: 20 }] }]
  const actualizado = applyPendingSales(catalogo, cola)
  assert.equal(actualizado.find((p) => p.id === 10).stock, 20, '60 - (2 * 20) = 20')
})

test('dueño crea producto con pack_size 20 y pack_price 300', () => {
  const state = fixture()
  state.base.products = []
  const created = add(state, 'POST', '/api/products', {
    name: 'Cigarrillos',
    purchase_price: 15,
    sale_price: 20,
    stock: 100,
    pack_size: 20,
    pack_price: 300
  })
  assert.equal(created.body.pack_size, 20)
  assert.equal(created.body.pack_price, 300)
  assert.equal(created.result.pack_size, 20)
  assert.equal(created.result.pack_price, 300)
})

test('pack_size 1 o producto por peso con pack se rechaza', () => {
  const state = fixture()
  state.base.products = []
  // pack_size < 2 debe fallar
  assert.throws(() => add(state, 'POST', '/api/products', {
    name: 'Fallo 1',
    purchase_price: 15,
    sale_price: 20,
    stock: 100,
    pack_size: 1,
    pack_price: 100
  }), /paquete/)
  // Producto por peso (unit: 'kg') no puede tener pack
  assert.throws(() => add(state, 'POST', '/api/products', {
    name: 'Arroz',
    purchase_price: 80,
    sale_price: 100,
    stock: 10,
    unit: 'kg',
    pack_size: 5,
    pack_price: 400
  }), /peso no se vende/)
})

test('formatPackStock muestra paquetes y sueltos correctamente', () => {
  assert.equal(formatPackStock(67, 20), '3 paq + 7 sueltos')
  assert.equal(formatPackStock(40, 20), '2 paq')
  assert.equal(formatPackStock(7, 20), '7 sueltos')
  assert.equal(formatPackStock(5, null), '5')
  assert.equal(formatPackStock(0, 20), '0 sueltos')
  assert.equal(formatPackStock(20, 20), '1 paq')
})

test('pack_size null/""/0 normaliza a null/null', () => {
  const state = fixture()
  const clearPack = add(state, 'PUT', `/api/products/10`, {
    name: 'Popular',
    purchase_price: 15,
    sale_price: 20,
    stock: 60,
    pack_size: null,
    pack_price: 100
  })
  assert.equal(clearPack.result.pack_size, null)
  assert.equal(clearPack.result.pack_price, null)
})

test('cajero no puede editar pack fields, solo sale_price y add_stock', () => {
  const state = fixture()
  const cashier = { ...user, role: 'cajero' }
  assert.throws(() => add(state, 'PUT', `/api/products/10`, {
    sale_price: 25,
    pack_size: 15
  }, { user: cashier }), /Solo el dueño/)
})

test('dueño convierte producto con pack a peso: pack_size y pack_price quedan null', () => {
  const state = fixture()
  const edited = add(state, 'PUT', `/api/products/10`, {
    unit: 'lb'
  })
  assert.equal(edited.body.pack_size, null)
  assert.equal(edited.body.pack_price, null)
  assert.equal(edited.result.pack_size, null)
  assert.equal(edited.result.pack_price, null)
  assert.equal(edited.result.unit, 'lb')
})

test('packCountTotal: 3 paquetes de 20 + 7 sueltos = 67', () => {
  assert.equal(packCountTotal(3, 7, 20), 67)
})

test('packCountTotal: solo sueltos (packs vacío) = 5', () => {
  assert.equal(packCountTotal('', 5, 20), 5)
})

test('packCountTotal: solo paquetes (sueltos vacío) = 40', () => {
  assert.equal(packCountTotal(2, '', 20), 40)
})

test('packCountTotal: ambos campos vacíos retorna null', () => {
  assert.equal(packCountTotal('', '', 20), null)
})

test('packCountTotal: valores negativos retornan null', () => {
  assert.equal(packCountTotal(-1, 5, 20), null)
  assert.equal(packCountTotal(2, -3, 20), null)
})

test('packCountTotal: valores decimales retornan null', () => {
  assert.equal(packCountTotal(2.5, 5, 20), null)
  assert.equal(packCountTotal(3, 5.7, 20), null)
})

test('packCountTotal: strings numéricos válidos funcionan', () => {
  assert.equal(packCountTotal('2', '5', 20), 45)
})

test('packCountTotal: strings con espacios se tratan', () => {
  assert.equal(packCountTotal('  3  ', '  7  ', 20), 67)
})
