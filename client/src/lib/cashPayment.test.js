import test from 'node:test'
import assert from 'node:assert/strict'
import { cashPaymentBreakdown, isMontevaldesCashEnabled, parseCupCents } from './cashPayment.js'

const token = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

test('solo habilita efectivo guiado cuando userId del JWT es la tienda Montevaldes', () => {
  const owner = token({ userId: 10, accountId: 10, role: 'dueño' })
  const cashier = token({ userId: 10, accountId: 48, role: 'cajero' })
  const otherOwner = token({ userId: 11, accountId: 11, role: 'dueño', store_name: 'Monte Valdes' })
  const otherCashier = token({ userId: 11, accountId: 10, role: 'cajero' })

  assert.equal(isMontevaldesCashEnabled(owner), true)
  assert.equal(isMontevaldesCashEnabled(cashier), true, 'el accountId del cajero no identifica la tienda')
  assert.equal(isMontevaldesCashEnabled(otherOwner), false, 'el nombre de tienda no activa la pantalla')
  assert.equal(isMontevaldesCashEnabled(otherCashier), false)
  assert.equal(isMontevaldesCashEnabled(null), false)
  assert.equal(isMontevaldesCashEnabled('token-inválido'), false)
})

test('parsea CUP a centavos, con punto o coma, y rechaza formatos inválidos', () => {
  assert.equal(parseCupCents('12'), 1200)
  assert.equal(parseCupCents('12.3'), 1230)
  assert.equal(parseCupCents('12,34'), 1234)
  assert.equal(parseCupCents(' 0,01 '), 1)
  assert.equal(parseCupCents('0'), 0, 'cero es un importe parseable, aunque insuficiente para cobrar')
  for (const value of ['', '   ', '-1', '1.005', '1,', '.50', '1e2', '1 000', 'NaN']) {
    assert.equal(parseCupCents(value), null, `${JSON.stringify(value)} debe rechazarse`)
  }
})

test('calcula vuelto, faltante y pago exacto en centavos', () => {
  assert.deepEqual(cashPaymentBreakdown(10.1, '12,00'), {
    totalCents: 1010, receivedCents: 1200, changeCents: 190, shortfallCents: 0,
    validAmount: true, canConfirm: true,
  })
  assert.deepEqual(cashPaymentBreakdown(10.1, '9,99'), {
    totalCents: 1010, receivedCents: 999, changeCents: 0, shortfallCents: 11,
    validAmount: true, canConfirm: false,
  })
  assert.deepEqual(cashPaymentBreakdown(10.1, '10.10'), {
    totalCents: 1010, receivedCents: 1010, changeCents: 0, shortfallCents: 0,
    validAmount: true, canConfirm: true,
  })
})

test('bloquea confirmación para importe vacío o inválido y total inválido', () => {
  for (const value of ['', 'no válido', '10.001']) {
    assert.equal(cashPaymentBreakdown(10, value).canConfirm, false)
  }
  assert.equal(cashPaymentBreakdown(Number.NaN, '10').canConfirm, false)
})
