import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { paymentSplit, paymentLabel, foreignBreakdown, foreignNeeded, maxTransfer, initialTransfer, clampTransfer, mixedPayload, withdrawalSplit, withdrawalFields as clientWithdrawalFields, purchaseSplit, purchaseCup as clientPurchaseCup, offShopRate, offShopPurchase } from '../../client/src/lib/payment.js'
import { cashPaymentBreakdown, parseCupCents } from '../../client/src/lib/cashPayment.js'

const require = createRequire(import.meta.url)
const serverPayment = require('../../server/lib/payment.js')
const cases = JSON.parse(await readFile(new URL('../fixtures/payment-cases.json', import.meta.url), 'utf8'))

function run(item) {
  const x = revive(item.input)
  switch (item.op) {
    case 'paymentSplit': return paymentSplit({ total: x.total, payment_method: x.method, transfer_amount: x.transferAmount, foreign_currency: x.currency, foreign_amount: x.foreignAmount, exchange_rate: x.rate })
    case 'paymentLabel': return paymentLabel({ payment_method: x.method, foreign_currency: x.currency })
    case 'serverPaymentSplit': return serverPayment.paymentSplit({ total: x.total, payment_method: x.method, transfer_amount: x.transferAmount, foreign_currency: x.currency, foreign_amount: x.foreignAmount, exchange_rate: x.rate })
    case 'foreignBreakdown': return foreignBreakdown(x.total, x.amount, x.rate)
    case 'round2': return serverPayment.round2(x.value)
    case 'foreignNeeded': return foreignNeeded(x.total, x.rate)
    case 'maxTransfer': return maxTransfer(x.total, x.limit)
    case 'initialTransfer': return initialTransfer(x.total, x.limit)
    case 'clampTransfer': return clampTransfer(x.value, x.total, x.limit)
    case 'mixedPayload': return mixedPayload(x.total, x.transfer)
    case 'withdrawalSplit': return withdrawalSplit({ method: x.method, amount: x.amount, voided_at: x.voided ? 'voided' : null })
    case 'withdrawalFields': return serverPayment.withdrawalFields({ method: x.method, amount: x.amount, note: x.note })
    case 'purchaseSplit': return purchaseSplit({ foreign_currency: x.currency, foreign_amount: x.foreignAmount, cup_amount: x.cupAmount })
    case 'purchaseCup': return serverPayment.purchaseFields({ foreign_currency: 'USD', foreign_amount: x.amount, exchange_rate: x.rate }).cup_amount
    case 'foreignFields': return serverPayment.foreignFields({ payment_method: x.method, foreign_currency: x.currency, foreign_amount: x.amount, exchange_rate: x.rate, shop_rate: x.shopRate })
    case 'purchaseFields': return serverPayment.purchaseFields({ foreign_currency: x.currency, foreign_amount: x.amount, exchange_rate: x.rate, shop_rate: x.shopRate })
    case 'parseCupCents': return parseCupCents(x.value)
    case 'cashPaymentBreakdown': return cashPaymentBreakdown(x.total, x.received)
    case 'offShopRate': return offShopRate({ payment_method: x.method, exchange_rate: x.rate, shop_rate: x.shopRate })
    case 'offShopPurchase': return offShopPurchase({ exchange_rate: x.rate, shop_rate: x.shopRate })
    default: throw new Error(`Unknown operation ${item.op}`)
  }
}

for (const item of cases) {
  test(`shared payment fixture: ${item.name}`, () => {
    if (item.expectedError) {
      assert.throws(() => run(item), (error) => error.message === item.expectedError)
    } else {
      const expected = revive(item.expected)
      assert.deepEqual(run(item), expected)
      const x = revive(item.input)
      if (item.op === 'paymentSplit' && x.method !== 'mixto') {
        assert.deepEqual(serverPayment.paymentSplit({ total: x.total, payment_method: x.method, transfer_amount: x.transferAmount, foreign_currency: x.currency, foreign_amount: x.foreignAmount, exchange_rate: x.rate }), expected, 'server paymentSplit parity')
      }
      if (item.op === 'purchaseSplit') {
        assert.deepEqual(serverPayment.purchaseSplit({ foreign_currency: x.currency, foreign_amount: x.foreignAmount, cup_amount: x.cupAmount }), expected, 'server purchaseSplit parity')
      }
      if (item.op === 'purchaseCup') assert.equal(clientPurchaseCup(x.amount, x.rate), expected, 'client purchaseCup parity')
      if (item.op === 'withdrawalSplit') {
        const serverResult = serverPayment.withdrawalSplit({ method: x.method, amount: x.amount, voided_at: x.voided ? 'voided' : null })
        // The server can produce -0 for an annulled bucket; JSON wire format turns it into 0.
        assert.deepEqual(JSON.parse(JSON.stringify(serverResult)), expected, 'server withdrawalSplit JSON parity')
      }
      if (item.op === 'withdrawalFields') {
        assert.deepEqual(clientWithdrawalFields({ method: x.method, amount: x.amount, note: x.note }), expected, 'client withdrawalFields parity')
      }
    }
  })
}

function revive(value) {
  if (value === '$NaN') return Number.NaN
  if (Array.isArray(value)) return value.map(revive)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, revive(child)]))
  return value
}
