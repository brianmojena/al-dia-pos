import { get, getMany, setMany, keys } from 'idb-keyval'
import { emptyData } from './offlineModel.js'
import { ACCOUNT_PREFIX as PREFIX, ENTITY_KEYS, LEGACY_PREFIXES, metaKey, outboxKey, entityKey } from './accountKeys.js'

// Cada cuenta se guarda en varias claves para que una venta no reescriba todo
// el historial. Las entidades grandes van por separado; meta y outbox se
// escriben juntos con `setMany` para que un corte no deje cursores sin cola.
const BASE_FIELDS = ['daily_stock', 'current_period', 'current_periods', 'shared_device', 'cash_close_coverage_version', 'local_entries']
const STATE_FIELDS = ['nextId', 'initialized', 'lastSynced', 'syncError', 'cursors', 'productIds', 'resolved', 'historyMonths', 'syncSince']

const withDefaults = (state) => {
  const base = { ...emptyData(), ...(state?.base || {}) }
  for (const key of ENTITY_KEYS) if (!Array.isArray(base[key])) base[key] = []
  const next = { ...state, base, outbox: Array.isArray(state?.outbox) ? state.outbox : [] }
  // Los ids provisionales se derivan de nextId; si un estado viejo no lo trae,
  // sin este valor `nextId--` produce NaN y las operaciones no se pueden mapear.
  if (!Number.isFinite(next.nextId)) next.nextId = -1
  return next
}
const serializeMeta = (state) => {
  const meta = { version: 2, base: {} }
  for (const field of STATE_FIELDS) if (state[field] !== undefined) meta[field] = state[field]
  for (const field of BASE_FIELDS) if (state.base[field] !== undefined) meta.base[field] = state.base[field]
  return meta
}
const deserialize = (meta, outbox, rows) => {
  const state = { ...meta, outbox: outbox || [] }
  delete state.version
  const base = { ...emptyData(), ...(meta.base || {}) }
  for (const [index, key] of ENTITY_KEYS.entries()) base[key] = Array.isArray(rows[index]) ? rows[index] : []
  state.base = base
  return withDefaults(state)
}
const entriesFor = (storageKey, state) => {
  const entries = [[metaKey(storageKey), serializeMeta(state)], [outboxKey(storageKey), state.outbox]]
  for (const key of ENTITY_KEYS) entries.push([entityKey(storageKey, key), state.base[key]])
  return entries
}
const queues = new Map()
const localLock = (storageKey, run) => {
  const previous = queues.get(storageKey) || Promise.resolve()
  const next = previous.catch(() => {}).then(run)
  queues.set(storageKey, next)
  return next.finally(() => { if (queues.get(storageKey) === next) queues.delete(storageKey) })
}
const locked = (storageKey, run) => typeof navigator !== 'undefined' && navigator.locks
  ? navigator.locks.request(`mypimes-store:${storageKey}`, run)
  : localLock(storageKey, run)

export async function read(storageKey, fallback = null) {
  const [meta, outbox, ...rows] = await getMany([metaKey(storageKey), outboxKey(storageKey), ...ENTITY_KEYS.map((key) => entityKey(storageKey, key))])
  if (meta) return deserialize(meta, outbox, rows)
  const legacy = await get(storageKey)
  if (!legacy) return typeof fallback === 'function' ? fallback() : fallback
  const state = withDefaults(legacy)
  await setMany(entriesFor(storageKey, state))
  return state
}

export async function replace(storageKey, state) {
  return locked(storageKey, () => setMany(entriesFor(storageKey, withDefaults(state))))
}

export async function update(storageKey, updater, fallback = null) {
  return locked(storageKey, async () => {
    const existing = await read(storageKey, null)
    const state = withDefaults(existing || (typeof fallback === 'function' ? fallback() : fallback) || {})
    const before = {}
    for (const key of ENTITY_KEYS) before[key] = state.base[key]
    const beforeMeta = existing ? JSON.stringify(serializeMeta(state)) : null
    const next = withDefaults(updater(state) || state)
    const entries = []
    if (!existing || JSON.stringify(serializeMeta(next)) !== beforeMeta) entries.push([metaKey(storageKey), serializeMeta(next)])
    entries.push([outboxKey(storageKey), next.outbox])
    for (const key of ENTITY_KEYS) if (!existing || next.base[key] !== before[key]) entries.push([entityKey(storageKey, key), next.base[key]])
    if (entries.length) await setMany(entries)
    return next
  })
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
