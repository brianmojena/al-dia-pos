import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWarehouseImport, toWarehousePayload, WAREHOUSE_TEMPLATE_CSV } from './productImport.js'

test('la plantilla del almacén se interpreta sin errores', () => {
  const { rows, error } = buildWarehouseImport(WAREHOUSE_TEMPLATE_CSV)
  assert.equal(error, undefined)
  assert.equal(rows.length, 3)
  assert.ok(rows.every((r) => r.errors.length === 0))
  assert.deepEqual(toWarehousePayload(rows)[1], { name: 'Arroz', unit: 'lb', cost: 90, quantity: 200 })
})

test('exige costo en los nuevos, valida unidad y decimales, y respeta lo existente', () => {
  const text = 'nombre;unidad;costo;cantidad\nA;;;5\nB;caja;10;1\nC;;10;2,5\nD;kg;10;2,5\nAceite;;;3'
  const { rows } = buildWarehouseImport(text, [{ name: 'aceite', unit: null }])
  assert.match(rows[0].errors[0], /costo/)
  assert.match(rows[1].errors[0], /Unidad/)
  assert.match(rows[2].errors[0], /entero/)
  assert.equal(rows[3].errors.length, 0)
  assert.equal(rows[4].errors.length, 0)
  assert.equal(rows[4].action, 'actualizar')
})

test('sin las columnas del almacén da un aviso claro', () => {
  assert.match(buildWarehouseImport('nombre;precio_venta\nA;1').error, /columnas/)
})
