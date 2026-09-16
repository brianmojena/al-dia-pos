import test from 'node:test'
import assert from 'node:assert/strict'
import { parseServerDate } from './dates.js'

// El servidor guarda siempre en UTC. Lo que cambia es CÓMO viene escrito el
// texto, y de ahí salía que la misma venta tuviera una hora en la pantalla y
// otra en el Excel del mes.

test('la fecha de SQLite ("2026-07-14 09:10:00") se lee como UTC', () => {
  assert.equal(parseServerDate('2026-07-14 09:10:00').toISOString(), '2026-07-14T09:10:00.000Z')
})

test('una fecha con la T de ISO pero sin zona también es UTC', () => {
  // Antes se le pasaba tal cual a new Date(), que la leía como hora local: en
  // Cuba la venta aparecía 4 horas más tarde de lo que fue.
  assert.equal(parseServerDate('2026-07-14T09:10:00').toISOString(), '2026-07-14T09:10:00.000Z')
})

test('si el texto ya dice su zona, se respeta', () => {
  assert.equal(parseServerDate('2026-07-14T09:10:00Z').toISOString(), '2026-07-14T09:10:00.000Z')
  assert.equal(parseServerDate('2026-07-14T05:10:00-04:00').toISOString(), '2026-07-14T09:10:00.000Z')
})

test('sin fecha o con basura no explota', () => {
  assert.equal(parseServerDate(null), null)
  assert.equal(parseServerDate(''), null)
  assert.equal(parseServerDate('no es una fecha'), null)
})
