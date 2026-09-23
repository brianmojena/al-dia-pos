import test from 'node:test'
import assert from 'node:assert/strict'
import { isTransferBlocked } from './transferGuard.js'

test('el total exacto en el techo pasa, por encima se bloquea', () => {
  assert.equal(isTransferBlocked(150, 150), false)
  assert.equal(isTransferBlocked(151, 150), true)
})

test('sin techo configurado nada se bloquea', () => {
  assert.equal(isTransferBlocked(999999, null), false)
  assert.equal(isTransferBlocked(999999, undefined), false)
})

test('el techo solo limita transferencias, no el efectivo', () => {
  assert.equal(isTransferBlocked(500, 150, 'efectivo'), false)
  assert.equal(isTransferBlocked(500, 150, 'transferencia'), true)
})
