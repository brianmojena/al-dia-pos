import { records } from './memoryStore.js'
import { ACCOUNT_PREFIX, ENTITY_KEYS, metaKey, outboxKey, entityKey } from '../accountKeys.js'

const clearKeys = (storageKey) => {
  records.delete(metaKey(storageKey))
  records.delete(outboxKey(storageKey))
  for (const key of ENTITY_KEYS) records.delete(entityKey(storageKey, key))
}
const clone = (value) => value === undefined ? undefined : structuredClone(value)

// Reconstruye sincrónicamente el estado que accountStore escribiría. Sirve para
// que los tests puedan sembrar y leer sin esperar a IndexedDB.
export function stateAt(storageKey) {
  if (records.has(storageKey)) return clone(records.get(storageKey))
  const meta = clone(records.get(metaKey(storageKey)))
  if (!meta) return clone(records.get(storageKey))
  const base = clone(meta.base) || {}
  delete meta.version
  delete meta.base
  for (const key of ENTITY_KEYS) {
    const rows = clone(records.get(entityKey(storageKey, key)))
    base[key] = Array.isArray(rows) ? rows : []
  }
  return { ...meta, base, outbox: clone(records.get(outboxKey(storageKey))) || [] }
}

export function seedState(storageKey, state) {
  clearKeys(storageKey)
  records.set(storageKey, clone(state))
}

export function clearState(storageKey) {
  clearKeys(storageKey)
  records.delete(storageKey)
}
