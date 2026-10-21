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
    assert.equal(records.get(metaKey(key)).nextId, -1)
    assert.equal((await read(key)).nextId, -1)
  })
})
