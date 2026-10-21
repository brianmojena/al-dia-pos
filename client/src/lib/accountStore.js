import { get, getMany, update as updateKey, keys } from 'idb-keyval'
import { emptyData } from './offlineModel.js'
import { ACCOUNT_PREFIX as PREFIX, ENTITY_KEYS, LEGACY_PREFIXES, metaKey, outboxKey, entityKey } from './accountKeys.js'

// La clave histórica sigue siendo la fuente de verdad. Una pestaña con la
// versión anterior puede seguir cobrando mientras se actualiza el service
// worker: ambas versiones deben compartir la misma cola y la misma transacción.
// También se pueden leer estados v2 de una instalación que haya probado esa
// versión; la siguiente escritura los conserva en el formato compatible.
const withDefaults = (state) => {
  const base = { ...emptyData(), ...(state?.base || {}) }
  for (const key of ENTITY_KEYS) if (!Array.isArray(base[key])) base[key] = []
  const next = { ...state, base, outbox: Array.isArray(state?.outbox) ? state.outbox : [] }
  let lowest = 0
  for (const key of ENTITY_KEYS) for (const row of base[key]) lowest = Math.min(lowest, Number(row.id) || 0)
  for (const op of next.outbox) lowest = Math.min(lowest, Number(op.result?.id) || 0)
  if (!Number.isFinite(next.nextId) || next.nextId >= lowest) next.nextId = lowest - 1
  return next
}
const fallbackValue = (fallback) => typeof fallback === 'function' ? fallback() : fallback

export async function read(storageKey, fallback = null) {
  const legacy = await get(storageKey)
  if (legacy) return withDefaults(legacy)
  const [meta, outbox, ...rows] = await getMany([metaKey(storageKey), outboxKey(storageKey), ...ENTITY_KEYS.map((key) => entityKey(storageKey, key))])
  if (!meta) return fallbackValue(fallback)
  const state = { ...meta, base: { ...meta.base }, outbox: outbox || [] }
  delete state.version
  for (const [index, key] of ENTITY_KEYS.entries()) state.base[key] = Array.isArray(rows[index]) ? rows[index] : []
  return withDefaults(state)
}

export async function update(storageKey, updater, fallback = null) {
  const previous = await read(storageKey, fallback)
  let next
  // idb-keyval.update hace la lectura y la escritura en una única transacción
  // IndexedDB, incluso entre pestañas y con clientes anteriores a esta versión.
  await updateKey(storageKey, (current) => {
    const state = withDefaults(current || previous || {})
    next = withDefaults(updater(state) || state)
    return next
  })
  return next
}

export function replace(storageKey, state) {
  return update(storageKey, () => state)
}

export async function accounts() {
  const found = new Set()
  for (const key of await keys()) {
    if (typeof key !== 'string') continue
    if (LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))) found.add(key)
    else if (key.startsWith(PREFIX) && key.endsWith(':meta')) found.add(key.slice(PREFIX.length, -5))
  }
  return [...found]
}
