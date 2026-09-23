import test from 'node:test'
import assert from 'node:assert/strict'
import { paymentSplit, paymentLabel, maxTransfer, initialTransfer, clampTransfer, mixedPayload } from './payment.js'

test('el reparto de cada forma de cobro', () => {
  assert.deepEqual(paymentSplit({ total: 300, payment_method: 'efectivo' }), { cash: 300, transfer: 0 })
  assert.deepEqual(paymentSplit({ total: 300, payment_method: 'transferencia' }), { cash: 0, transfer: 300 })
  assert.deepEqual(paymentSplit({ total: 300, payment_method: 'mixto', transfer_amount: 120 }), { cash: 180, transfer: 120 })
  assert.equal(paymentLabel({ payment_method: 'mixto' }), 'Mixto')
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
