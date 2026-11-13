import test from 'node:test'
import assert from 'node:assert/strict'
import {
  itemLineTotal, mergeReservationItem, parseQuantityInput, reservationTotal,
  updatedAgo, validateCustomer,
} from './catalogoPublico.js'

// Reglas del formulario de la tienda pública: mismas decisiones que el
// servidor (server/routes/catalog.js) aplicadas antes de gastar la petición.

test('parseQuantityInput: por pieza es un entero desde 1', () => {
  assert.equal(parseQuantityInput('3', null), 3)
  assert.equal(parseQuantityInput('3', ''), 3)
  assert.equal(parseQuantityInput(' 3 ', null), 3)
  assert.equal(parseQuantityInput('0', null), null)
  assert.equal(parseQuantityInput('-1', null), null)
  assert.equal(parseQuantityInput('1.5', null), null) // no se pide medio pan
  assert.equal(parseQuantityInput('abc', null), null)
  assert.equal(parseQuantityInput('', null), null)
  assert.equal(parseQuantityInput('10000', null), null) // techado del servidor
})

test('parseQuantityInput: por peso admite fracciones de hasta 3 decimales', () => {
  assert.equal(parseQuantityInput('1.5', 'kg'), 1.5)
  assert.equal(parseQuantityInput('0.001', 'kg'), 0.001) // 1 gramo
  assert.equal(parseQuantityInput('0,5', 'kg'), 0.5) // coma decimal
  assert.equal(parseQuantityInput('1.2345', 'kg'), null) // 4 decimales: la balanza no
  assert.equal(parseQuantityInput('0', 'kg'), null)
})

test('validateCustomer: nombre y teléfono obligatorios, nota opcional', () => {
  assert.equal(validateCustomer('María Pérez', '53123456', ''), null)
  assert.equal(validateCustomer('  María   Pérez ', '53123456', undefined), null)

  const faltan = validateCustomer('', '', '')
  assert.match(faltan.name, /nombre/)
  assert.match(faltan.phone, /teléfono/)
  assert.equal(faltan.note, undefined)

  const largos = validateCustomer('x'.repeat(81), '5', 'y'.repeat(301))
  assert.ok(largos.name)
  assert.ok(largos.note)
})

test('mergeReservationItem junta líneas del mismo producto y refresca el precio', () => {
  const pan = { id: 1, name: 'Pan', sale_price: 100, unit: null, pack_size: null }
  let items = mergeReservationItem([], pan, 2)
  items = mergeReservationItem(items, pan, 3)
  assert.equal(items.length, 1)
  assert.equal(items[0].quantity, 5)

  const panCaro = { ...pan, sale_price: 150 }
  items = mergeReservationItem(items, panCaro, 1)
  assert.equal(items[0].sale_price, 150) // el precio al momento manda

  const arroz = { id: 2, name: 'Arroz', sale_price: 250, unit: 'kg', pack_size: null }
  items = mergeReservationItem(items, arroz, 0.5)
  assert.equal(items.length, 2)
  assert.equal(items[1].quantity, 0.5)
})

test('totales por línea y de la lista', () => {
  assert.equal(itemLineTotal({ quantity: 3, sale_price: 100 }), 300)
  assert.equal(itemLineTotal({ quantity: 1.5, sale_price: 250 }), 375)
  assert.equal(reservationTotal([
    { quantity: 3, sale_price: 100 },
    { quantity: 1.5, sale_price: 250 },
  ]), 675)
})

test('updatedAgo: segundos, minutos y horas', () => {
  const now = 1_000_000_000_000
  assert.equal(updatedAgo(now - 5_000, now), 'hace 5 s')
  assert.equal(updatedAgo(now - 120_000, now), 'hace 2 min')
  assert.equal(updatedAgo(now - 3_600_000 * 2, now), 'hace 2 h')
  assert.equal(updatedAgo(null, now), '')
})
