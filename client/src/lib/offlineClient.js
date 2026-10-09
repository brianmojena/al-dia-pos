import { get, update, keys } from 'idb-keyval'
import { getToken, isElectron, networkFetch } from './network.js'
import { getCachedUser, getCachedProducts } from './offlineCache.js'
import { accountKeyFromToken, splitByAccount } from './queueOwnership.js'
import { newId } from './newId.js'
import { requestPersistentStorage } from './storagePersistence.js'
import { emptyData, project, prepareOperation, readLocal, acknowledgeOperation, applyOperation } from './offlineModel.js'

const keyFor = (account) => `mypimes_local_v1:${account}`
const accountNow = () => accountKeyFromToken(getToken())
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const initialState = (account) => ({ base: { ...emptyData(), products: (accountNow() === account && getCachedProducts()) || [] }, outbox: [], nextId: -1, initialized: false, lastSynced: null, syncError: '' })
const readState = async (account) => (await get(keyFor(account))) || initialState(account)
const broadcast = () => {
  window.dispatchEvent(new Event('local:data-changed'))
  channel?.postMessage('changed')
}
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('mypimes-local')
if (channel) channel.onmessage = () => window.dispatchEvent(new Event('local:data-changed'))

export function handlesOffline(path, method) {
  const route = path.split('?')[0]
  if (method === 'GET') return /^\/api\/(products$|dashboard$|sales(?:\/(?:-?\d+|rejected))?$|reports\/days$|inventory-counts(?:\/-?\d+)?$|cash-closes(?:\/(?:current|summary))?$|auth\/cashiers$)/.test(route)
  return /^\/api\/(products(?:\/(?:-?\d+|import))?$|sales$|inventory-counts$|cash-closes$|sales\/rejected\/\d+\/review$)/.test(route)
}

// Copiar primero y retirar después: un cierre de la app entre ambas escrituras
// no pierde ventas. El client_sale_id evita copiarlas o cobrarlas dos veces.
async function migrateLegacy(account) {
  const legacy = splitByAccount((await get('mypimes_sales_queue')) || [], account).mine
  if (!legacy.length) return
  await update(keyFor(account), (state = initialState(account)) => {
    for (const sale of legacy) {
      if (state.outbox.some((o) => o.body.client_sale_id === sale.client_sale_id) || state.base.sales.some((s) => s.client_sale_id === sale.client_sale_id)) continue
      const data = project(state)
      const items = sale.items.map((i, index) => ({ ...i, id: index, product_name: i.product_name || data.products.find((p) => p.id === i.product_id)?.name || 'Producto', unit_cost: data.products.find((p) => p.id === i.product_id)?.purchase_price || 0 }))
      const { account_key, queued_at, ...body } = sale
      body.sold_at = new Date(queued_at || Date.now()).toISOString()
      body.register_id = 'web'
      state.outbox.push({ id: newId(), kind: 'sale', path: '/api/sales', method: 'POST', body, queued_at: body.sold_at, result: { ...body, id: state.nextId--, items, total: items.reduce((n, i) => n + i.unit_price * i.quantity, 0), profit: items.reduce((n, i) => n + (i.unit_price - i.unit_cost) * i.quantity, 0), created_at: body.sold_at, register_id: `web:${account.split(':')[1]}`, pending: true } })
    }
    return state
  })
  const migrated = new Set(legacy.map((s) => s.client_sale_id))
  await update('mypimes_sales_queue', (queue = []) => queue.filter((s) => !migrated.has(s.client_sale_id)))
  broadcast()
}
export async function offlineRequest(path, options = {}) {
  const account = accountNow(), user = getCachedUser()
  if (!account || !user) return response({ error: 'Inicia sesión para acceder a tus datos locales' }, 401)
  await migrateLegacy(account)
  let state = await readState(account)
  // Primer acceso: preparar toda la tienda, incluso las pantallas no visitadas.
  // Después las lecturas no esperan ninguna petición de red.
  if (!state.initialized && !state.base.products.length && !state.outbox.length && navigator.onLine !== false && !syncing) {
    await syncOffline()
    state = await readState(account)
  }
  if (accountNow() !== account) return response({ error: 'La sesión cambió' }, 401)
  const method = options.method || 'GET', route = path.split('?')[0]
  try {
    if (method === 'GET') {
      if (!state.initialized && !state.base.products.length && !state.outbox.length) return response({ error: 'Conéctate una vez para descargar los datos de esta tienda' }, 503)
      const data = readLocal(project(state), path, account, user)
      return data === undefined ? response({ error: 'Registro no encontrado' }, 404) : response(data)
    }
    const body = options.body ? JSON.parse(options.body) : {}
    let result
    await update(keyFor(account), (current = initialState(account)) => {
      if (accountNow() !== account) throw new Error('La sesión cambió')
      const data = project(current)
      const ctx = { account, user, newId, localId: () => current.nextId-- }
      if (route === '/api/products/import') {
        if (user.role === 'cajero') throw new Error('Solo el dueño puede importar')
        if (!Array.isArray(body.items) || !body.items.length || body.items.length > 2000) throw new Error('La importación debe contener entre 1 y 2000 productos')
        result = { created: 0, updated: 0, total: body.items.length, pending: true }
        const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
        for (const item of body.items) {
          const existing = data.products.find((p) => norm(p.name) === norm(item.name))
          const clean = { ...item, purchase_price: item.purchase_price ?? existing?.purchase_price ?? 0, stock: item.stock ?? existing?.stock ?? 0 }
          const op = prepareOperation(data, existing ? 'PUT' : 'POST', existing ? `/api/products/${existing.id}` : '/api/products', clean, ctx)
          current.outbox.push(op); applyOperation(data, op)
          result[existing ? 'updated' : 'created']++
        }
      } else {
        const resolveId = (id) => current.productIds?.[id] ?? id
        if (body.items) body.items = body.items.map((i) => ({ ...i, product_id: resolveId(i.product_id) }))
        const localRoute = /^\/api\/products\/-?\d+$/.test(route) ? `/api/products/${resolveId(Number(route.split('/').pop()))}` : route
        const op = prepareOperation(data, method, localRoute, body, ctx)
        result = { ...op.result, pending: op.kind !== 'noop' }
        if (op.kind !== 'noop') current.outbox.push(op)
      }
      return current
    })
    requestPersistentStorage()
    broadcast()
    void syncOffline()
    return response(result, 202)
  } catch (error) {
    // IndexedDB/quota errors must never be interpreted as a saved operation.
    const storageError = ['QuotaExceededError', 'UnknownError', 'InvalidStateError'].includes(error.name)
    return response({ error: storageError ? 'No se pudo guardar en este dispositivo. Libera espacio y vuelve a intentar.' : error.message }, storageError ? 507 : 400)
  }
}
let syncing = null
export async function syncOffline() {
  if (isElectron() || navigator.onLine === false || !accountNow() || !getCachedUser()) return
  if (syncing) return syncing
  const run = async () => {
    const account = accountNow(), token = getToken()
    const stillCurrent = () => accountNow() === account && getToken() === token
    const request = (path, options = {}) => networkFetch(path, { ...options, token, preserveSession: true })
    try {
      await migrateLegacy(account)
      const { flushQueue } = await import('./salesQueue.js')
      await flushQueue()
      if (!stillCurrent()) return
      while (stillCurrent()) {
        const state = await readState(account), op = state.outbox[0]
        if (!op) break
        if (op.error) throw new Error(op.error)
        const path = op.kind === 'product' ? '/api/sync/product-operation' : op.path
        const body = op.kind === 'product' ? { operation_id: op.id, method: op.method, product_id: op.productId, product: op.body, expected: op.before } : { ...op.body }
        if (op.kind === 'close' && op.coverageExact) body.covered_sale_ids = op.saleIds
        const res = await request(path, { method: op.kind === 'product' ? 'POST' : op.method, body: JSON.stringify(body) })
        const result = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (op.kind === 'sale' && [400, 403, 409].includes(res.status)) {
            // El dinero ya se cobró: conservar el recibo y avisar al dueño,
            // como hacía la cola anterior, sin bloquear las ventas posteriores.
            await update('mypimes_rejected_sales', (list = []) => list.some((sale) => sale.client_sale_id === op.body.client_sale_id) ? list : [...list, { ...op.body, items: op.result.items, account_key: account, queued_at: Date.parse(op.queued_at), error: result.error || 'Venta rechazada al sincronizar', rejected_at: Date.now(), reported: false }])
            await update(keyFor(account), (state) => {
              state.outbox = state.outbox.filter((pending) => pending.id !== op.id)
              for (const pending of state.outbox) if (pending.saleIds) pending.saleIds = pending.saleIds.filter((id) => id !== op.result.id)
              return state
            })
            const { refreshQueueStatus } = await import('./salesQueue.js')
            await refreshQueueStatus()
            broadcast()
            continue
          }
          if (res.status === 401) throw new Error('La sesión necesita renovarse. Tus cambios siguen guardados; inicia sesión con esta misma cuenta.')
          const error = result.error || `No se pudo sincronizar (${res.status})`
          // Nunca descartar una operación cobrada o sobrepasar una dependencia.
          if ([400, 403, 404, 409, 422].includes(res.status)) await update(keyFor(account), (s) => { const pending = s.outbox.find((o) => o.id === op.id); if (pending) { pending.error = error; pending.errorStatus = res.status } return s })
          throw new Error(error)
        }
        await update(keyFor(account), (s) => acknowledgeOperation(s, op.id, { ...result, pending: false }))
        broadcast()
      }
      if (!stillCurrent()) return
      await flushQueue() // Reportar también los rechazos de esta pasada.
      if (!stillCurrent()) return
      // Snapshot consistente del servidor: catálogo, todo el historial con sus
      // líneas y cobertura de cierres. Solo se reemplaza la base, nunca la cola.
      const res = await request('/api/sync/snapshot')
      if (!res.ok) throw new Error(res.status === 401 ? 'Renueva tu sesión para sincronizar. Los datos locales siguen disponibles.' : 'No se pudieron descargar los datos de la tienda')
      const snapshot = await res.json()
      if (!stillCurrent()) return
      await update(keyFor(account), (s = initialState(account)) => ({ ...s, base: { ...emptyData(), ...snapshot }, initialized: true, lastSynced: Date.now(), syncError: '' }))
      requestPersistentStorage()
      broadcast()
    } catch (error) {
      try { await update(keyFor(account), (s = initialState(account)) => ({ ...s, syncError: error.message || 'Sin conexión con el servidor' })) } catch {}
      broadcast()
    }
  }
  syncing = (navigator.locks ? navigator.locks.request('mypimes-sync', run) : run()).finally(() => { syncing = null })
  return syncing
}
export async function localSyncStatus() {
  const account = accountNow()
  if (!account || isElectron()) return { pending: 0 }
  const state = await readState(account)
  const otherKeys = (await keys()).filter((key) => typeof key === 'string' && key.startsWith('mypimes_local_v1:') && key !== keyFor(account))
  const others = await Promise.all(otherKeys.map((key) => get(key)))
  const otherAccounts = others.reduce((count, state) => count + (state?.outbox?.length || 0), 0)
  return { otherAccounts, pending: state.outbox.length, error: state.syncError, conflicts: state.outbox.filter((o) => o.error).length, problem: state.outbox.find((o) => o.error), initialized: state.initialized, lastSynced: state.lastSynced }
}
export async function retrySync() {
  const account = accountNow()
  if (!account) return
  await update(keyFor(account), (s = initialState(account)) => ({ ...s, outbox: s.outbox.map(({ error, ...op }) => op), syncError: '' }))
  return syncOffline()
}
export async function resolveProductConflict(choice) {
  const resolve = async () => {
    const account = accountNow(), token = getToken()
    const state = await readState(account), op = state.outbox[0]
    if (!op?.error || op.kind !== 'product' || !(op.productId > 0)) throw new Error('No hay un conflicto de producto para resolver')
    const res = await networkFetch('/api/sync/snapshot', { token, preserveSession: true })
    if (!res.ok) throw new Error('No se pudieron consultar los datos de la nube. Vuelve a intentar.')
    const snapshot = await res.json()
    if (accountNow() !== account || getToken() !== token) throw new Error('La sesión cambió')
    const product = snapshot.products.find((p) => Number(p.id) === op.productId)
    if (choice === 'local' && !product) throw new Error('El producto ya no existe en la nube. Usa los datos de la nube y créalo de nuevo si hace falta.')
    await update(keyFor(account), (current) => {
      const pending = current.outbox.find((p) => p.id === op.id)
      if (!pending) return current
      current.resolved ||= []
      current.resolved.push({ ...pending, resolution: choice, resolved_at: Date.now() })
      current.base = { ...emptyData(), ...snapshot }
      if (choice === 'cloud') current.outbox = current.outbox.filter((p) => p.id !== op.id)
      else {
        pending.before = { name: product.name, stock: product.stock, purchase_price: product.purchase_price, sale_price: product.sale_price }
        delete pending.error; delete pending.errorStatus
      }
      current.syncError = ''
      return current
    })
    broadcast()
  }
  if (navigator.locks) await navigator.locks.request('mypimes-sync', resolve)
  else { if (syncing) await syncing; await resolve() }
  return syncOffline()
}
export function startOfflineSync() {
  if (isElectron()) return
  window.addEventListener('online', syncOffline)
  window.addEventListener('focus', syncOffline)
  setInterval(syncOffline, 20_000)
  void syncOffline()
}
