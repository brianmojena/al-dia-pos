import test from 'node:test'
import assert from 'node:assert/strict'
import { shiftMonth, monthLabel, dayLabel, closeStatus } from './months.js'

test('shiftMonth se mueve un mes para adelante o atrás', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12', 'cruza el año hacia atrás')
  assert.equal(shiftMonth('2025-12', 1), '2026-01', 'cruza el año hacia adelante')
  assert.equal(shiftMonth('2026-09', -1), '2026-08')
  assert.equal(shiftMonth('2026-09', 1), '2026-10')
})

test('shiftMonth aguanta saltos de varios meses', () => {
  assert.equal(shiftMonth('2026-09', -13), '2025-08')
  assert.equal(shiftMonth('2026-01', 12), '2027-01')
})

test('monthLabel arma "mes año" en español, sin mayúsculas', () => {
  assert.equal(monthLabel('2026-09'), 'septiembre 2026')
  assert.equal(monthLabel('2026-01'), 'enero 2026')
  assert.equal(monthLabel('2025-12'), 'diciembre 2025')
})

test('dayLabel arma "día número mes" sin correrse de fecha', () => {
  // 2026-09-15 es martes — si se parseara con new Date('2026-09-15') (UTC
  // medianoche) y la máquina estuviera detrás de UTC, se leería como lunes 14.
  assert.equal(dayLabel('2026-09-15'), 'martes 15 sep')
  assert.equal(dayLabel('2026-01-01'), 'jueves 1 ene')
  assert.equal(dayLabel('2025-12-31'), 'miércoles 31 dic')
})

test('closeStatus: sin cierre ese día', () => {
  assert.deepEqual(closeStatus(null), { kind: 'none', amount: 0 })
})

test('closeStatus: cuadró (con redondeo de centavos)', () => {
  assert.deepEqual(closeStatus({ count: 1, difference: 0 }), { kind: 'square', amount: 0 })
  assert.deepEqual(closeStatus({ count: 1, difference: 0.0000001 }), { kind: 'square', amount: 0 })
})

test('closeStatus: faltó efectivo', () => {
  assert.deepEqual(closeStatus({ count: 1, difference: -500 }), { kind: 'short', amount: 500 })
})

test('closeStatus: sobró efectivo', () => {
  assert.deepEqual(closeStatus({ count: 1, difference: 300 }), { kind: 'over', amount: 300 })
})
