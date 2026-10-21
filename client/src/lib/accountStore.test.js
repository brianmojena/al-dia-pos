import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { records, resetStore } from './testSupport/memoryStore.js'
import { emptyData } from './offlineModel.js'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'idb-keyval') return { url: new URL('./testSupport/memoryStore.js', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
} })
const { read, update } = await import('./accountStore.js')
const { metaKey } = await import('./accountKeys.js')

test('accountStore: el estado siempre conserva nextId para los ids provisionales', async (t) => {
  const key = 'mypimes_local_v1:1:1'
  t.beforeEach(() => resetStore())

  await t.test('un estado guardado sin nextId recupera -1 al leer', async () => {
    records.set(key, { base: { ...emptyData(), products: [{ id: 10, name: 'Pan', stock: 1 }] }, outbox: [] })
    const state = await read(key)
    assert.equal(state.nextId, -1)
  })

  await t.test('una meta vieja sin nextId también se normaliza al leer', async () => {
    records.set(metaKey(key), { version: 2, base: {}, initialized: true })
    const state = await read(key)
    assert.equal(state.nextId, -1)
  })

  await t.test('la primera escritura de una cuenta nueva persiste nextId', async () => {
    const state = await update(key, (s = { base: emptyData(), outbox: [] }) => ({ ...s, initialized: true }))
    assert.equal(state.nextId, -1)
    assert.equal(records.get(key).nextId, -1)
    assert.equal((await read(key)).nextId, -1)
  })
})

test('actualizar la PWA conserva las operaciones de pestañas antiguas', async () => {
  resetStore()
  const key = 'mypimes_local_v1:tienda:cajero'
  const old = { initialized: true, base: { ...emptyData(), products: [{ id: 10, stock: 8 }] },
    outbox: [{ id: 'venta-anterior', result: { id: -7 }, body: { client_sale_id: 'venta-anterior' } }] }
  records.set(key, structuredClone(old))
  const imported = await read(key)
  assert.equal(imported.nextId, -8, 'no reutiliza el ID de una venta pendiente')
  assert.deepEqual(records.get(key), old, 'leer no reemplaza la cola de la pestaña anterior')
  const { update: oldClientUpdate } = await import('./testSupport/memoryStore.js')
  await Promise.all(Array.from({ length: 20 }, (_, n) => n % 2
    ? oldClientUpdate(key, (state) => ({ ...state, outbox: [...state.outbox, { id: `anterior-${n}` }] }))
    : update(key, (state) => ({ ...state, outbox: [...state.outbox, { id: `nueva-${n}` }] }))))
  const state = await read(key)
  assert.equal(state.outbox.length, 21)
  assert.equal(new Set(state.outbox.map((op) => op.id)).size, 21)
  assert.deepEqual(records.get(key).outbox, state.outbox, 'la versión anterior ve también los cambios nuevos')
  assert.equal(state.base.products[0].stock, 8)
})

test('un estado v2 también se recupera sin perder base, cursores ni cola', async () => {
  resetStore()
  const { entityKey, outboxKey } = await import('./accountKeys.js')
  const key = 'mypimes_shared_v1:1:tablet'
  records.set(metaKey(key), { version: 2, initialized: true, nextId: -3,
    cursors: { sale: 20 }, base: { cash_close_coverage_version: 1, shared_device: { id: 'tablet' } } })
  records.set(entityKey(key, 'sales'), [{ id: 20, total: 100 }])
  records.set(outboxKey(key), [{ id: 'pendiente', result: { id: -2 } }])
  await update(key, (state) => ({ ...state, syncError: 'Sin red' }))
  const state = await read(key)
  assert.deepEqual(state.outbox, [{ id: 'pendiente', result: { id: -2 } }])
  assert.equal(state.base.sales[0].id, 20)
  assert.equal(state.base.shared_device.id, 'tablet')
  assert.equal(state.base.cash_close_coverage_version, 1)
  assert.equal(state.cursors.sale, 20)
  assert.equal(state.nextId, -3)
  assert.ok(records.has(key), 'la siguiente apertura también es compatible con el formato anterior')
})
