import test from 'node:test'
import assert from 'node:assert/strict'
import {
  paymentSplit, paymentLabel, maxTransfer, initialTransfer, clampTransfer, mixedPayload,
  offShopRate, foreignBreakdown, foreignNeeded,
} from './payment.js'

const noForeign = { usd: 0, eur: 0, foreign_cup: 0 }

test('el reparto de cada forma de cobro', () => {
  assert.deepEqual(paymentSplit({ total: 300, payment_method: 'efectivo' }), { cash: 300, transfer: 0, ...noForeign })
  assert.deepEqual(paymentSplit({ total: 300, payment_method: 'transferencia' }), { cash: 0, transfer: 300, ...noForeign })
  assert.deepEqual(paymentSplit({ total: 300, payment_method: 'mixto', transfer_amount: 120 }), { cash: 180, transfer: 120, ...noForeign })
  assert.equal(paymentLabel({ payment_method: 'mixto' }), 'Mixto')
})

test('cobro en divisa: 20 USD a 350 por 6000 deja 1000 de vuelto', () => {
  const sale = { total: 6000, payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 20, exchange_rate: 350 }
  assert.deepEqual(paymentSplit(sale), { cash: -1000, transfer: 0, usd: 20, eur: 0, foreign_cup: 7000 })
  assert.equal(paymentLabel(sale), 'Dólares')
  assert.deepEqual(foreignBreakdown(6000, 20, 350), { foreignCup: 7000, cashToCollect: 0, change: 1000 })
  assert.deepEqual(foreignBreakdown(8000, 20, 380), { foreignCup: 7600, cashToCollect: 400, change: 0 })
  assert.equal(foreignNeeded(6000, 350), 17.15)
})

test('se marca la tasa distinta a la de la tienda, y solo esa', () => {
  const sale = { payment_method: 'divisa', exchange_rate: 350 }
  assert.equal(offShopRate({ ...sale, shop_rate: 350 }), false)
  assert.equal(offShopRate({ ...sale, shop_rate: 360 }), true)
  assert.equal(offShopRate({ ...sale, shop_rate: null }), false, 'sin tasa de tienda no hay contra qué comparar')
  assert.equal(offShopRate({ payment_method: 'efectivo' }), false)
})

test('el cobro mixto abre en 50/50, en pesos enteros', () => {
  assert.equal(initialTransfer(2500, null), 1250)
  assert.equal(initialTransfer(2501, null), 1251)
})

test('si el techo no deja llegar a la mitad, abre en el techo', () => {
  assert.equal(maxTransfer(8000, 3000), 3000)
  assert.equal(initialTransfer(8000, 3000), 3000)
  assert.equal(initialTransfer(8000, 5000), 4000, 'con techo holgado sigue siendo 50/50')
})

test('lo que escribe la cajera queda dentro de lo posible', () => {
  assert.equal(clampTransfer(1350, 2500, null), 1350)
  assert.equal(clampTransfer(9999, 2500, null), 2500)
  assert.equal(clampTransfer(9999, 2500, 1000), 1000)
  assert.equal(clampTransfer(-20, 2500, null), 0)
  assert.equal(clampTransfer('', 2500, null), 0)
})

test('con el slider en un extremo no se manda un mixto', () => {
  assert.deepEqual(mixedPayload(2500, 0), { payment_method: 'efectivo' })
  assert.deepEqual(mixedPayload(2500, 2500), { payment_method: 'transferencia' })
  assert.deepEqual(mixedPayload(2500, 1350), { payment_method: 'mixto', transfer_amount: 1350 })
})
