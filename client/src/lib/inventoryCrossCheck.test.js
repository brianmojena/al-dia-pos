import test from 'node:test'
import assert from 'node:assert/strict'
import { crossCheckTone, crossCheckRows } from './inventoryCrossCheck.js'

test('crossCheckTone devuelve el tono correcto según el veredicto', () => {
  const cuadra = crossCheckTone('cuadra')
  assert.equal(cuadra.textColor, 'text-green-800')
  assert.equal(cuadra.bg, 'bg-green-50')

  const respaldo = crossCheckTone('respaldo')
  assert.equal(respaldo.textColor, 'text-red-800')
  assert.equal(respaldo.bg, 'bg-red-50')

  const diferencias = crossCheckTone('diferencias')
  assert.equal(diferencias.textColor, 'text-amber-800')
  assert.equal(diferencias.bg, 'bg-amber-50')

  const parcial = crossCheckTone('parcial')
  assert.equal(parcial.textColor, 'text-gray-700')
  assert.equal(parcial.bg, 'bg-gray-50')

  const sinArqueo = crossCheckTone('sin_arqueo')
  assert.equal(sinArqueo.textColor, 'text-gray-700')
  assert.equal(sinArqueo.bg, 'bg-gray-50')

  const desconocido = crossCheckTone('unknown')
  assert.equal(desconocido.textColor, 'text-gray-700')
})

test('crossCheckRows devuelve array vacío si check es null', () => {
  assert.deepEqual(crossCheckRows(null), [])
  assert.deepEqual(crossCheckRows(undefined), [])
})

test('crossCheckRows devuelve array vacío si check.available es false', () => {
  const check = { available: false }
  assert.deepEqual(crossCheckRows(check), [])
})

test('crossCheckRows incluye todos los datos cuando están disponibles', () => {
  const check = {
    available: true,
    counted_at: '2026-10-22 14:30:00',
    counted_by: 'yamila@tienda.cu',
    products_counted: 120,
    products_total: 150,
    units_missing: 5,
    value_missing: 250,
    units_extra: 2,
    value_extra: 100,
    cash_difference: -150,
  }

  const rows = crossCheckRows(check)
  assert.equal(rows.length, 5)

  // Arqueo
  assert(rows[0].label.includes('Arqueo'))
  assert(rows[0].value.includes('yamila'))

  // Productos contados
  assert.equal(rows[1].label, 'Productos contados')
  assert.equal(rows[1].value, '120 de 150')

  // Faltan
  assert.equal(rows[2].label, 'Faltan')
  assert(rows[2].value.includes('5 unidades'))
  assert.equal(rows[2].tone, 'text-red-600')

  // Sobran
  assert.equal(rows[3].label, 'Sobran')
  assert(rows[3].value.includes('2 unidades'))
  assert.equal(rows[3].tone, 'text-orange-600')

  // Diferencia de caja
  assert.equal(rows[4].label, 'Diferencia de caja')
  assert.equal(rows[4].tone, 'text-red-600')
})

test('crossCheckRows oculta filas Faltan y Sobran cuando son 0', () => {
  const check = {
    available: true,
    counted_at: '2026-10-22 14:30:00',
    counted_by: 'yamila@tienda.cu',
    products_counted: 150,
    products_total: 150,
    units_missing: 0,
    value_missing: 0,
    units_extra: 0,
    value_extra: 0,
    cash_difference: 0,
  }

  const rows = crossCheckRows(check)

  // Solo 3 filas: Arqueo, Productos contados, Diferencia de caja
  assert.equal(rows.length, 3)
  assert.equal(rows[0].label, 'Arqueo')
  assert.equal(rows[1].label, 'Productos contados')
  assert.equal(rows[2].label, 'Diferencia de caja')

  // Sin Faltan ni Sobran
  const hasNoFaltaSobra = !rows.some((r) => r.label === 'Faltan' || r.label === 'Sobran')
  assert(hasNoFaltaSobra)
})

test('crossCheckRows colorea la diferencia de caja según su valor', () => {
  const positiva = crossCheckRows({ available: true, cash_difference: 100 })
  assert(positiva.some((r) => r.label === 'Diferencia de caja' && r.tone === 'text-orange-600'))

  const negativa = crossCheckRows({ available: true, cash_difference: -100 })
  assert(negativa.some((r) => r.label === 'Diferencia de caja' && r.tone === 'text-red-600'))

  const cero = crossCheckRows({ available: true, cash_difference: 0 })
  assert(cero.some((r) => r.label === 'Diferencia de caja' && r.tone === 'text-green-600'))
})
