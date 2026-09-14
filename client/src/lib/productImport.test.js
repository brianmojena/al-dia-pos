import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildImport, parseNumber, decodeBytes, looksLikeExcelBinary, normalizeName, toPayload, TEMPLATE_CSV,
} from './productImport.js'

// Estos casos salen de cómo llegan de verdad las listas de una tienda cubana:
// hechas en Excel en español, guardadas en Windows, o copiadas y pegadas.

test('números escritos por una persona', () => {
  assert.equal(parseNumber('1.500'), 1500, 'punto de miles, como en Excel en español')
  assert.equal(parseNumber('1,5'), 1.5, 'coma decimal')
  assert.equal(parseNumber('12.50'), 12.5, 'dos decimales no son miles')
  assert.equal(parseNumber('1.234,50'), 1234.5)
  assert.equal(parseNumber('1,234.50'), 1234.5)
  assert.equal(parseNumber('1.234.567'), 1234567)
  assert.equal(parseNumber('$ 990'), 990)
  assert.equal(parseNumber('990 CUP'), 990)
  assert.equal(parseNumber('0.500'), 0.5, 'un cero delante no es un grupo de miles')
  assert.equal(parseNumber(''), null, 'vacío es "no lo dijeron", no cero')
  assert.equal(parseNumber('   '), null)
  assert.ok(Number.isNaN(parseNumber('diez')))
  assert.ok(Number.isNaN(parseNumber('1.2.3')))
})

test('CSV de Excel en español: punto y coma y miles con punto', () => {
  const csv = 'Nombre;Precio de venta;Precio de compra;Stock\r\nArroz (1 lb);1.500;1.100;50\r\n'
  const { error, rows } = buildImport(csv)
  assert.equal(error, undefined)
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { name: rows[0].name, sale: rows[0].sale_price, purchase: rows[0].purchase_price, stock: rows[0].stock },
    { name: 'Arroz (1 lb)', sale: 1500, purchase: 1100, stock: 50 }
  )
})

test('celdas copiadas de Excel o Google Sheets (tabuladores)', () => {
  const pegado = 'producto\tprecio\tcantidad\nCafé Serrano\t750\t12\nAzúcar\t110\t40\n'
  const { rows } = buildImport(pegado)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'Café Serrano')
  assert.equal(rows[1].stock, 40)
})

test('CSV con coma y campos entre comillas', () => {
  const csv = 'nombre,precio_venta,stock\n"Galletas, paquete",500,14\n"Queso ""Kraft""",780,10\n'
  const { rows } = buildImport(csv)
  assert.equal(rows[0].name, 'Galletas, paquete', 'la coma dentro de comillas no parte la columna')
  assert.equal(rows[1].name, 'Queso "Kraft"')
})

test('archivo de Excel en Windows (no UTF-8) conserva los acentos', () => {
  // "Azúcar;110" codificado en Windows-1252: la ú es el byte 0xFA.
  const bytes = new Uint8Array([
    ...Buffer.from('nombre;precio\r\nAz'), 0xfa, ...Buffer.from('car;110\r\n'),
  ])
  const { rows } = buildImport(decodeBytes(bytes))
  assert.equal(rows[0].name, 'Azúcar')
})

test('reconoce un .xlsx subido directamente', () => {
  assert.equal(looksLikeExcelBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14])), true)
  assert.equal(looksLikeExcelBinary(new TextEncoder().encode('nombre;precio')), false)
})

test('errores fila por fila, con el número de fila de la hoja', () => {
  const csv = [
    'nombre;precio_venta;precio_compra;stock',
    'Arroz;130;90;50',          // fila 2: bien
    ';200;;10',                 // fila 3: sin nombre
    'Pan;diez;;5',              // fila 4: precio ilegible
    'Leche;1000;;2,5',          // fila 5: stock con decimales
    'arroz ;140;;3',            // fila 6: repite la fila 2 (mayúsculas y espacios aparte)
    'Aceite;-5;;1',             // fila 7: negativo
  ].join('\n')
  const { rows } = buildImport(csv)
  const porFila = Object.fromEntries(rows.map((r) => [r.line, r.errors]))

  assert.deepEqual(porFila[2], [])
  assert.match(porFila[3][0], /Falta el nombre/)
  assert.match(porFila[4][0], /Precio de venta no válido: "diez"/)
  assert.match(porFila[5][0], /entero/)
  assert.match(porFila[6][0], /Repetido: ya aparece en la fila 2/)
  assert.match(porFila[7][0], /negativo/)

  assert.equal(toPayload(rows).length, 1, 'al servidor solo viajan las filas sin errores')
})

test('las filas vacías del medio no cuentan pero no corren la numeración', () => {
  const { rows } = buildImport('nombre;precio\n\nArroz;130\n;\nPan;50\n')
  assert.deepEqual(rows.map((r) => r.line), [3, 5])
})

test('marca qué productos ya existen y se van a actualizar', () => {
  const existentes = [{ id: 1, name: 'Azúcar (1 lb)' }]
  const { rows } = buildImport('nombre;precio\nazucar (1 LB);120\nSal;40\n', existentes)
  assert.equal(rows[0].action, 'actualizar', 'mismo producto aunque cambien acentos y mayúsculas')
  assert.equal(rows[1].action, 'crear')
})

test('sin títulos reconocibles explica qué espera', () => {
  const { error } = buildImport('Arroz;130;50\nPan;50;10\n')
  assert.match(error, /primera fila tiene que tener los títulos/)
})

test('la plantilla que se descarga se importa sin errores', () => {
  const { error, rows } = buildImport(TEMPLATE_CSV)
  assert.equal(error, undefined)
  assert.equal(rows.length, 3)
  assert.ok(rows.every((r) => r.errors.length === 0))
})

test('precio de compra y stock vacíos quedan como "no indicado", no como cero', () => {
  const { rows } = buildImport('nombre;precio_venta;precio_compra;stock\nArroz;130;;\n')
  assert.equal(rows[0].purchase_price, null)
  assert.equal(rows[0].stock, null)
  assert.equal(normalizeName('  Azúcar   (1 LB) '), 'azucar (1 lb)')
})
