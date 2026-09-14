import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPendingSales } from './offlineStock.js'

const catalogo = [
  { id: 1, name: 'Café', stock: 10 },
  { id: 2, name: 'Arroz', stock: 40 },
  { id: 3, name: 'Ron', stock: 1 },
]

test('sin ventas pendientes se muestra el stock del servidor tal cual', () => {
  assert.equal(applyPendingSales(catalogo, []), catalogo)
})

test('las ventas hechas sin internet se descuentan al volver a abrir la app', () => {
  // Dos ventas en la cola (cobradas sin conexión), y la app se reabrió con el
  // catálogo de la última vez que hubo internet.
  const cola = [
    { client_sale_id: 'a', items: [{ product_id: 1, quantity: 2 }, { product_id: 2, quantity: 5 }] },
    { client_sale_id: 'b', items: [{ product_id: 1, quantity: 1 }] },
  ]
  const visto = applyPendingSales(catalogo, cola)
  assert.equal(visto.find((p) => p.id === 1).stock, 7, 'café: 10 − 2 − 1')
  assert.equal(visto.find((p) => p.id === 2).stock, 35)
  assert.equal(visto.find((p) => p.id === 3).stock, 1, 'lo que no se vendió no cambia')
})

test('nunca muestra stock negativo', () => {
  const visto = applyPendingSales(catalogo, [{ items: [{ product_id: 3, quantity: 2 }] }])
  assert.equal(visto.find((p) => p.id === 3).stock, 0)
})

test('no modifica el catálogo original ni se rompe con datos raros', () => {
  const copia = structuredClone(catalogo)
  applyPendingSales(catalogo, [{ items: [{ product_id: 1, quantity: 3 }] }])
  assert.deepEqual(catalogo, copia)

  assert.deepEqual(applyPendingSales({ error: 'No autenticado' }, []), [], 'una respuesta de error no rompe la pantalla')
  assert.equal(applyPendingSales(catalogo, [{ items: [{ product_id: 1, quantity: 'x' }] }]).find((p) => p.id === 1).stock, 10)
})
