import { get, update } from 'idb-keyval'
import { read as readAccount, update as updateAccount, accounts as storedAccounts } from './accountStore.js'
import { getToken, isElectron, networkFetch } from './network.js'
import { getCachedUser, getCachedProducts } from './offlineCache.js'
import { accountKeyFromToken, splitByAccount } from './queueOwnership.js'
import { newId } from './newId.js'
import { requestPersistentStorage } from './storagePersistence.js'
import { emptyData, project, prepareOperation, readLocal, acknowledgeOperation, applyOperation, applyChanges, applyHistory, businessDate, CASH_CLOSE_COVERAGE_VERSION } from './offlineModel.js'
import { getSharedDevice, getSharedContext, getSharedCredential, getLastSharedAccount, isSharedLocked, isSharedExpired } from './sharedDevice.js'

const sharedFor = (account) => {
  const device = getSharedContext()
  return device && getSharedCredential(account) ? device : null
}
const keyFor = (account) => {
  const shared = sharedFor(account)
  return shared ? `mypimes_shared_v1:${shared.owner_id}:${shared.id}` : `mypimes_local_v1:${account}`
}
const accountNow = () => accountKeyFromToken(getToken())
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const initialState = (account, device = sharedFor(account)) => ({ base: { ...emptyData(), ...(device ? { shared_device: device } : {}), products: (accountNow() === account && getCachedProducts()) || [] }, outbox: [], nextId: -1, initialized: false, lastSynced: null, syncError: '' })
const readState = async (account, storageKey = keyFor(account)) => readAccount(storageKey, () => initialState(account))
const utcMillis = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim().replace(' ', 'T')
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
  const millis = Date.parse(explicitZone ? normalized : `${normalized}Z`)
  return Number.isFinite(millis) ? millis : null
}
const broadcast = () => {
  window.dispatchEvent(new Event('local:data-changed'))
  channel?.postMessage('changed')
}
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('mypimes-local')
if (channel) channel.onmessage = () => window.dispatchEvent(new Event('local:data-changed'))

export function handlesOffline(path, method) {
  const route = path.split('?')[0]
  if (method === 'GET') return /^\/api\/(products(?:\/day-stock)?$|dashboard$|sales(?:\/(?:-?\d+|rejected))?$|currency-purchases$|cash-withdrawals$|reports\/days$|inventory-counts(?:\/-?\d+)?$|cash-closes(?:\/(?:current|summary))?$|auth\/cashiers$)/.test(route)
  return /^\/api\/(products(?:\/(?:-?\d+|import))?$|sales$|currency-purchases$|cash-withdrawals(?:\/[\w-]+\/void)?$|inventory-counts$|cash-closes$|sales\/rejected\/\d+\/review$)/.test(route)
}

// Copiar primero y retirar después: un cierre de la app entre ambas escrituras
// no pierde ventas. El client_sale_id evita copiarlas o cobrarlas dos veces.
async function migrateLegacy(account) {
  const legacy = splitByAccount((await get('mypimes_sales_queue')) || [], account).mine
  if (!legacy.length) return
  await updateAccount(keyFor(account), (state = initialState(account)) => {
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
  if (getSharedContext() && (isSharedLocked() || isSharedExpired())) return response({ error: 'Desbloquea la caja con tu PIN para continuar' }, 423)
  if (method === 'GET') {
    const month = monthFor(path)
    if (month && state.cursors && !state.historyMonths?.[month] && navigator.onLine !== false) {
      try {
        await syncHistoryMonth(account, month, keyFor(account))
        state = await readState(account)
      } catch { /* la lectura local sigue disponible con lo ya descargado */ }
    }
  }
  try {
    if (method === 'GET') {
      if (!state.initialized && !state.base.products.length && !state.outbox.length) return response({ error: 'Conéctate una vez para descargar los datos de esta tienda' }, 503)
      const data = readLocal(project(state), path, account, user)
      return data === undefined ? response({ error: 'Registro no encontrado' }, 404) : response(data)
    }
    const body = options.body ? JSON.parse(options.body) : {}
    let result
    await updateAccount(keyFor(account), (current = initialState(account)) => {
      if (accountNow() !== account) throw new Error('La sesión cambió')
      let data = project(current)
      if (route === '/api/products/import') {
        // La importación encadena operaciones y necesita ver el stock/alta
        // anterior, pero no debe tocar la base: el outbox las proyecta después.
        data = { ...data, products: (data.products || []).map((p) => ({ ...p })), local_entries: structuredClone(data.local_entries || {}) }
      }
      const ctx = { account, user, newId, localId: () => current.nextId-- }
      if (route === '/api/products/import') {
        if (user.role === 'cajero') throw new Error('Solo el dueño puede importar')
        if (!Array.isArray(body.items) || !body.items.length || body.items.length > 2000) throw new Error('La importación debe contener entre 1 y 2000 productos')
        result = { created: 0, updated: 0, total: body.items.length, pending: true }
        const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
        for (const item of body.items) {
          const existing = data.products.find((p) => norm(p.name) === norm(item.name))
          const clean = { ...item, purchase_price: item.purchase_price ?? existing?.purchase_price ?? 0 }
          // Sumar es una recepción: entra como cantidad a añadir (y cuenta como
          // entrada del día). Reemplazar es un ajuste: viaja como stock final.
          if (existing && body.stock_mode === 'sumar') {
            delete clean.stock
            const add = Number(item.stock ?? 0)
            if (add > 0) clean.add_stock = add
          } else {
            clean.stock = existing ? (item.stock ?? existing.stock) : (item.stock ?? 0)
          }
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
// Las versiones antiguas de la app guardaban la edición de un cajero con el
// producto entero; el servidor solo admite precio de venta y entrada de stock
// y rechazaba (403) la operación, dejando parada toda la cola detrás de ella.
const cashierEdit = (op) => op.method === 'PUT' && (getSharedContext() ? getSharedCredential(op.account_key)?.user : getCachedUser())?.role === 'cajero'
const priceAndStockOnly = ({ sale_price, add_stock }) => ({ ...(sale_price !== undefined && { sale_price }), ...(add_stock !== undefined && { add_stock }) })
const CURSOR_PARAMS = {
  sale: 'after_sale',
  close: 'after_close',
  count: 'after_count',
  purchase: 'after_purchase',
  withdrawal: 'after_withdrawal',
  correction: 'after_correction',
  close_correction: 'after_close_correction',
}
const emptyCursors = () => Object.fromEntries(Object.keys(CURSOR_PARAMS).map((key) => [key, 0]))
const INITIAL_SYNC_DAYS = 7
const changesPath = (cursors, since = null) => {
  const params = new URLSearchParams({ limit: '200', max_bytes: String(512 * 1024) })
  for (const [key, param] of Object.entries(CURSOR_PARAMS)) params.set(param, String(cursors[key] ?? 0))
  if (since) params.set('since', since)
  return `/api/sync/snapshot?${params}`
}
const monthBounds = (month) => {
  const first = new Date(`${month}-01T00:00:00Z`)
  if (!Number.isFinite(first.getTime())) return null
  const from = new Date(first); from.setUTCDate(from.getUTCDate() - 1)
  const to = new Date(first); to.setUTCMonth(to.getUTCMonth() + 1); to.setUTCDate(to.getUTCDate() + 1)
  return { from: from.toISOString(), to: to.toISOString() }
}
const historyPath = (month, cursors) => {
  const bounds = monthBounds(month)
  if (!bounds) return null
  const params = new URLSearchParams({ history_from: bounds.from, history_until: bounds.to, limit: '500', max_bytes: String(1024 * 1024) })
  for (const [key, param] of Object.entries(CURSOR_PARAMS)) params.set(param, String(cursors[key] ?? 0))
  return `/api/sync/snapshot?${params}`
}
const historyLoading = new Map()
async function syncHistoryMonth(account, month, storageKey) {
  const key = `${storageKey}:${month}`
  if (historyLoading.has(key)) return historyLoading.get(key)
  const load = (async () => {
    const token = getSharedContext() ? getSharedCredential(account)?.token || getToken() : getToken()
    let cursors = emptyCursors()
    for (;;) {
      const path = historyPath(month, cursors)
      if (!path) return false
      const res = await networkFetch(path, { token, preserveSession: true })
      const page = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(page.error || (res.status === 401 ? 'Renueva tu sesión para consultar el historial.' : 'No se pudo descargar el historial.'))
      if (!page.cursors) return false
      if (page.has_more && JSON.stringify(page.cursors) === JSON.stringify(cursors)) throw new Error('La nube no pudo avanzar el historial; vuelve a intentar')
      await updateAccount(storageKey, (state = initialState(account)) => {
        state.base = applyHistory(state.base, page)
        if (!page.has_more) {
          state.historyMonths ||= {}
          state.historyMonths[month] = true
        }
        return state
      })
      broadcast()
      if (!page.has_more) return true
      cursors = page.cursors
    }
  })()
  historyLoading.set(key, load)
  try { return await load } finally { historyLoading.delete(key) }
}
const monthFor = (path) => {
  const url = new URL(path, 'http://local')
  if (url.pathname === '/api/reports/days') return url.searchParams.get('month') || businessDate().slice(0, 7)
  if (['/api/sales', '/api/sales/corrections', '/api/cash-withdrawals', '/api/currency-purchases'].includes(url.pathname)) {
    const date = url.searchParams.get('date')
    return date && /^\d{4}-\d{2}$/.test(date.slice(0, 7)) ? date.slice(0, 7) : null
  }
  return null
}
const cursorsFromSnapshot = (snapshot) => {
  const max = (rows) => (rows || []).reduce((n, row) => Math.max(n, Number(row.id) || 0), 0)
  return {
    sale: max(snapshot.sales),
    close: max(snapshot.cash_closes),
    count: max(snapshot.inventory_counts),
    purchase: max(snapshot.currency_purchases),
    withdrawal: max(snapshot.cash_withdrawals),
    correction: 0,
    close_correction: 0,
  }
}
let syncing = null
export async function syncOffline() {
  if (isElectron() || navigator.onLine === false || !accountNow() || !getCachedUser()) return
  if (syncing) return syncing
  const run = async () => {
    const account = accountNow(), token = getToken(), shared = getSharedContext(), storageKey = keyFor(account)
    const stillCurrent = () => shared ? getSharedContext()?.id === shared.id : accountNow() === account && getToken() === token
    const request = (path, options = {}) => networkFetch(path, { token, ...options, preserveSession: true })
    try {
      await migrateLegacy(account)
      const { flushQueue } = await import('./salesQueue.js')
      await flushQueue()
      if (!stillCurrent()) return
      while (stillCurrent()) {
        const state = await readState(account, storageKey), op = state.outbox[0]
        if (!op) break
        if (op.kind === 'close' && !shared && getCachedUser()?.role === 'cajero' && op.coverageVersion !== CASH_CLOSE_COVERAGE_VERSION) {
          // Las instalaciones que ya tenían IndexedDB podían declarar has_sales
          // sin haber descargado ventas. Rehidratar antes de cerrar y reconstruir
          // la misma operación conservando su client_close_id y su lugar en cola.
          const snapshotResponse = await request('/api/sync/snapshot')
          if (!snapshotResponse.ok) throw new Error(snapshotResponse.status === 401 ? 'Renueva tu sesión para sincronizar. Los datos locales siguen disponibles.' : 'No se pudo actualizar la cobertura de caja; el cierre sigue pendiente')
          const snapshot = await snapshotResponse.json()
          if (snapshot.cash_close_coverage_version !== CASH_CLOSE_COVERAGE_VERSION) throw new Error('La nube no confirmó una cobertura completa de caja; el cierre sigue pendiente')
          if (!stillCurrent()) return
          await updateAccount(storageKey, (current = initialState(account, shared)) => {
            current.base = { ...emptyData(), ...snapshot }
            const closeIndex = current.outbox.findIndex((pending) => pending.id === op.id)
            const prefix = current.outbox.slice(0, Math.max(0, closeIndex))
            const cutoff = utcMillis(op.body.closed_at || op.result.closed_at || op.queued_at)
            const baseAtCut = structuredClone(current.base)
            if (cutoff != null) {
              baseAtCut.sales = (baseAtCut.sales || []).filter((sale) => {
                const created = utcMillis(sale.created_at)
                return created != null && created <= cutoff
              })
              baseAtCut.currency_purchases = (baseAtCut.currency_purchases || []).filter((purchase) => {
                const created = utcMillis(purchase.created_at)
                return created != null && created <= cutoff
              })
            }
            // Solo se proyecta lo que estaba antes del cierre en la cola. Las
            // operaciones posteriores permanecen intactas y no alteran su corte.
            const data = project({ ...current, base: baseAtCut, outbox: prefix })
            data.cash_closes = data.cash_closes.filter((close) => close.client_close_id !== op.body.client_close_id)
            const rebuilt = prepareOperation(data, op.method, op.path, op.body, {
              account, user: getCachedUser(), now: op.result.closed_at || op.body.closed_at || op.queued_at,
              newId: () => op.id, localId: () => op.result.id ?? current.nextId--,
            })
            rebuilt.id = op.id
            rebuilt.queued_at = op.queued_at
            rebuilt.result.id = op.result.id
            rebuilt.result.pending = true
            current.outbox = current.outbox.map((pending) => pending.id === op.id ? rebuilt : pending)
            current.initialized = true
            return current
          })
          broadcast()
          continue
        }
        if (op.error) throw new Error(op.error)
        const credential = shared ? getSharedCredential(op.account_key) : null
        if (shared && !credential) throw new Error('Falta la autorización del cajero original. Los cambios siguen guardados.')
        const path = op.kind === 'product' ? '/api/sync/product-operation' : op.path
        const body = op.kind === 'product' ? { operation_id: op.id, method: op.method, product_id: op.productId, product: cashierEdit(op) ? priceAndStockOnly(op.body) : op.body, expected: op.before } : { ...op.body }
        if (op.kind === 'close' && op.coverageExact) { body.covered_sale_ids = op.saleIds; body.covered_purchase_ids = op.purchaseIds || [] }
        const res = await request(path, { ...(credential ? { token: credential.token } : {}), method: op.kind === 'product' ? 'POST' : op.method, body: JSON.stringify(body) })
        const result = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (shared && (res.status === 401 || (res.status === 403 && ['DEVICE_REVOKED', 'MEMBER_REVOKED'].includes(result.code)))) throw new Error(result.error || 'Renueva los accesos de esta caja. Las operaciones siguen guardadas.')
          if (op.kind === 'sale' && [400, 403, 409].includes(res.status)) {
            // El dinero ya se cobró: conservar el recibo y avisar al dueño,
            // como hacía la cola anterior, sin bloquear las ventas posteriores.
            await update('mypimes_rejected_sales', (list = []) => list.some((sale) => sale.client_sale_id === op.body.client_sale_id) ? list : [...list, { ...op.body, items: op.result.items, account_key: op.account_key || account, shared_device_id: shared?.id, queued_at: Date.parse(op.queued_at), error: result.error || 'Venta rechazada al sincronizar', rejected_at: Date.now(), reported: false }])
            await updateAccount(storageKey, (state) => {
              state.outbox = state.outbox.filter((pending) => pending.id !== op.id)
              for (const pending of state.outbox) if (pending.saleIds) pending.saleIds = pending.saleIds.filter((id) => id !== op.result.id)
              return state
            })
            const { refreshQueueStatus } = await import('./salesQueue.js')
            await refreshQueueStatus()
            broadcast()
            continue
          }
          if (op.kind === 'withdrawal_void' && [404, 409].includes(res.status)) {
            // El servidor ya anuló esta extracción desde otro aparato,
            // o entró en cierre: ignorar y seguir. El snapshot al final restaura el estado real.
            await updateAccount(storageKey, (state) => {
              state.outbox = state.outbox.filter((pending) => pending.id !== op.id)
              return state
            })
            broadcast()
            continue
          }
          if (res.status === 401) throw new Error('La sesión necesita renovarse. Tus cambios siguen guardados; inicia sesión con esta misma cuenta.')
          const error = result.error || `No se pudo sincronizar (${res.status})`
          // Nunca descartar una operación cobrada o sobrepasar una dependencia.
          if ([400, 403, 404, 409, 422].includes(res.status)) await updateAccount(storageKey, (s) => { const pending = s.outbox.find((o) => o.id === op.id); if (pending) { pending.error = error; pending.errorStatus = res.status } return s })
          throw new Error(error)
        }
        await updateAccount(storageKey, (s) => acknowledgeOperation(s, op.id, { ...result, pending: false }))
        broadcast()
      }
      if (!stillCurrent()) return
      await flushQueue() // Reportar también los rechazos de esta pasada.
      if (!stillCurrent()) return
      // Descarga consistente del servidor en páginas. La base se actualiza
      // página a página y los cursores se guardan tras cada una: si se corta la
      // conexión, la siguiente pasada continúa donde quedó en vez de rehacer
      // todo el historial.
      const saved = await readState(account, storageKey)
      let cursors = { ...emptyCursors(), ...(saved.cursors || {}) }
      const since = saved.syncSince || (!saved.initialized && !saved.cursors
        ? new Date(Date.now() - INITIAL_SYNC_DAYS * 86_400_000).toISOString()
        : null)
      for (;;) {
        const res = await request(changesPath(cursors, since), shared ? { token: getSharedCredential(accountNow())?.token || token } : {})
        if (!res.ok) throw new Error(res.status === 401 ? 'Renueva tu sesión para sincronizar. Los datos locales siguen disponibles.' : 'No se pudieron descargar los datos de la tienda')
        const page = await res.json()
        if (!stillCurrent()) return
        if (!page.cursors) {
          // Servidor anterior al protocolo paginado: una última descarga
          // completa y cursores derivados de lo recibido.
          await updateAccount(storageKey, (s = initialState(account, shared)) => ({
            ...s, base: { ...emptyData(), ...page }, cursors: cursorsFromSnapshot(page),
            initialized: true, lastSynced: Date.now(), syncError: '', syncSince: null,
          }))
          break
        }
        if (page.has_more && JSON.stringify(page.cursors) === JSON.stringify(cursors)) {
          throw new Error('La nube no pudo avanzar la sincronización; vuelve a intentar')
        }
        await updateAccount(storageKey, (s = initialState(account, shared)) => {
          s.base = applyChanges(s.base, page)
          s.cursors = page.cursors
          s.initialized = true
          s.lastSynced = Date.now()
          s.syncError = ''
          s.syncSince = page.has_more ? since : null
          return s
        })
        broadcast()
        if (!page.has_more) break
        cursors = page.cursors
      }
      requestPersistentStorage()
    } catch (error) {
      try { await updateAccount(storageKey, (s = initialState(account, shared)) => ({ ...s, syncError: error.message || 'Sin conexión con el servidor' })) } catch {}
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
  const otherKeys = (await storedAccounts()).filter((key) => key !== keyFor(account))
  const others = await Promise.all(otherKeys.map((key) => readAccount(key)))
  const otherAccounts = others.reduce((count, state) => count + (state?.outbox?.length || 0), 0)
  return { otherAccounts, pending: state.outbox.length, error: state.syncError, conflicts: state.outbox.filter((o) => o.error).length, problem: state.outbox.find((o) => o.error), initialized: state.initialized, lastSynced: state.lastSynced }
}

// Administración puede estar abierta con otra cuenta. Comprobar los datos
// persistidos, no solo la cola de la sesión del administrador.
export async function canReplaceSharedDevice() {
  if (isElectron()) return { allowed: false, error: 'Configura la caja compartida en la aplicación web de la tablet o teléfono.' }
  try {
    const allKeys = await storedAccounts()
    const states = await Promise.all(allKeys.map((key) => readAccount(key)))
    if (states.some((s) => s?.outbox?.length) || ((await get('mypimes_sales_queue')) || []).length
      || ((await get('mypimes_rejected_sales')) || []).some((s) => !s.reported && !s.report_failed)) {
      return { allowed: false, error: 'Sincroniza todos los cambios pendientes de este dispositivo antes de configurarlo. Los datos se conservan.' }
    }
    const device = getSharedDevice()
    if (device) {
      const old = await readAccount(`mypimes_shared_v1:${device.owner_id}:${device.id}`)
      if (old) {
        const data = project(old)
        if ([...(data.sales || []), ...(data.currency_purchases || [])].some((row) => row.cash_close_id == null)) return { allowed: false, error: 'Cierra y sincroniza la caja instalada antes de cambiar su configuración.' }
      }
    }
    return { allowed: true }
  } catch { return { allowed: false, error: 'No se pudieron comprobar los datos pendientes. Vuelve a intentar sin borrar el almacenamiento.' } }
}

export async function sharedHandoverStatus(account = getLastSharedAccount()) {
  const device = getSharedDevice()
  if (!device || device.continuous || !account) return { hasOpenOperations: false }
  const state = await readAccount(`mypimes_shared_v1:${device.owner_id}:${device.id}`)
  if (!state) return { hasOpenOperations: false }
  const user = getSharedCredential(account)?.user
  if (!user) throw new Error('No se pudo comprobar la caja del cajero anterior.')
  return { hasOpenOperations: readLocal(project(state), '/api/cash-closes/current?register_id=web', account, user).has_sales }
}
export async function retrySync() {
  const account = accountNow()
  if (!account) return
  await updateAccount(keyFor(account), (s = initialState(account)) => ({ ...s, outbox: s.outbox.map(({ error, ...op }) => op), syncError: '' }))
  return syncOffline()
}

// Una corrección de cierre nunca va al outbox. Tras respuesta 2xx actualizamos
// la base local con el valor confirmado y refrescamos el snapshot del servidor.
export async function cacheCashCloseCorrection(payload, expectedIdentity = null) {
  const current = { account: accountNow(), token: getToken() };
  const identity = expectedIdentity || current;
  if (!identity.account || !identity.token || identity.account !== current.account || identity.token !== current.token
      || isElectron() || !payload?.cash_close) return false;
  await updateAccount(keyFor(identity.account), (state = initialState(identity.account)) => {
    const close = payload.cash_close;
    const index = (state.base.cash_closes || []).findIndex((row) =>
      (Boolean(close.client_close_id) && row.client_close_id === close.client_close_id)
      || Number(row.id) === Number(close.id));
    if (index < 0) state.base.cash_closes = [close, ...(state.base.cash_closes || [])];
    else state.base.cash_closes = state.base.cash_closes.map((row, i) => i === index ? { ...row, ...close } : row);
    return state;
  });
  broadcast();
  return true;
}

export async function refreshOfflineSnapshot(expectedIdentity = null) {
  const current = { account: accountNow(), token: getToken() };
  const identity = expectedIdentity || current;
  const { account, token } = identity;
  if (!account || !token || isElectron()) return;
  const stillCurrent = () => accountNow() === account && getToken() === token;
  if (!stillCurrent()) throw new Error('La sesión cambió antes de actualizar el historial.');
  // Sincronización incremental: una corrección no debe obligar a bajar de
  // nuevo todo el historial de la tienda (puede pesar decenas de MB).
  await syncOffline();
  if (!stillCurrent()) throw new Error('La sesión cambió antes de actualizar el historial.');
  const state = await readState(account);
  if (state.syncError) throw new Error(state.syncError);
  broadcast();
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
    await updateAccount(keyFor(account), (current) => {
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
