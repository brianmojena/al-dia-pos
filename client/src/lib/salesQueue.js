// Cola de ventas offline para el modo web (PWA). Mismo problema que resuelve
// desktop/src/db/localDb.js (outbox) — "el internet se corta a mitad de una
// venta" — pero aquí no hay un proceso local con SQLite: solo el navegador,
// así que usamos IndexedDB (vía idb-keyval) como el único almacenamiento que
// sobrevive a cerrar la pestaña.
//
// Es del tamaño exacto del problema real: la venta se cobró, el POST a
// /api/sales no llegó, hay que reintentarlo sin duplicar ni perder la venta.
//
// Ventas rechazadas. Si al subir una venta el servidor la rechaza por algo que
// reintentar no arregla (casi siempre: ya no quedaba stock porque otra caja
// vendió las últimas unidades), antes se DESCARTABA en silencio — el dinero se
// había cobrado y la venta no quedaba en ningún lado. Decisión del negocio: se
// guarda aparte como "rechazada", el empleado la ve en su pantalla y se le avisa
// al servidor para que el dueño la revise.
//
// Cada venta guarda la cuenta que la cobró y solo la sube esa misma cuenta
// (ver lib/queueOwnership.js): la cola es del teléfono, no de la sesión.
import { get, update } from 'idb-keyval'
import { apiFetch, getToken, isElectron } from './api'
import { accountKeyFromToken, splitByAccount, logoutBlockers } from './queueOwnership'
import { requestPersistentStorage } from './storagePersistence'

const QUEUE_KEY = 'mypimes_sales_queue'
const REJECTED_KEY = 'mypimes_rejected_sales'
const listeners = new Set()

// Respuestas definitivas para ESA venta: reintentarla daría lo mismo. Todo lo
// demás (sin red, 401 por sesión vencida, 5xx) se reintenta más tarde.
//
// Además de rechazarla, sacarla de la cola es lo que evita el otro problema:
// antes una venta con un error así se quedaba primera en la cola y bloqueaba
// para siempre todas las que venían detrás.
const DEFINITIVE_REJECTIONS = new Set([400, 403, 409])

const currentAccountKey = () => accountKeyFromToken(getToken())

// Listas completas del teléfono, de todas las cuentas.
const getQueue = async () => (await get(QUEUE_KEY)) || []
const getAllRejected = async () => (await get(REJECTED_KEY)) || []

/** Ventas cobradas sin internet por la cuenta abierta que todavía no subieron. */
export async function getPendingSales() {
  if (isElectron()) return []
  return splitByAccount(await getQueue(), currentAccountKey()).mine
}

/** Ventas de la cuenta abierta que el servidor rechazó, con `reported` = ya se le avisó al servidor. */
export async function getRejected() {
  if (isElectron()) return []
  return splitByAccount(await getAllRejected(), currentAccountKey()).mine
}

/**
 * Lo que impide cerrar sesión ahora mismo. En escritorio nunca bloquea: allí las
 * ventas viven en la base local de la caja, no dependen de la sesión.
 */
export async function getLogoutBlockers() {
  if (isElectron()) return { pending: 0, unreported: 0, total: 0 }
  const [queue, rejected] = await Promise.all([getQueue(), getAllRejected()])
  return logoutBlockers(queue, rejected, currentAccountKey())
}

async function snapshot() {
  if (isElectron()) return { pending: 0, rejected: [], otherAccounts: 0 }
  const [queue, rejected] = await Promise.all([getQueue(), getAllRejected()])
  const key = currentAccountKey()
  const ownQueue = splitByAccount(queue, key)
  const ownRejected = splitByAccount(rejected, key)
  return {
    pending: ownQueue.mine.length,
    rejected: ownRejected.mine,
    // Ventas de otra cuenta que esperan en este teléfono a que esa cuenta entre.
    otherAccounts: ownQueue.others.length + ownRejected.others.filter((r) => !r.reported).length,
  }
}

const notify = async () => {
  const state = await snapshot()
  listeners.forEach((fn) => fn(state))
}

/** Vuelve a leer el estado: al entrar o salir cambia qué ventas son "mías". */
export const refreshQueueStatus = notify

/** El callback recibe `{ pending, rejected: [ventas rechazadas], otherAccounts }`. */
export function subscribe(fn) {
  listeners.add(fn)
  snapshot().then(fn)
  return () => listeners.delete(fn)
}

// Guarda la venta ya "cobrada" localmente aunque el POST haya fallado por red.
// El client_sale_id viaja intacto — cuando el servidor por fin la reciba, la
// misma garantía de idempotencia que ya existe en el backend evita duplicados.
export async function enqueueSale(payload) {
  const sale = { ...payload, account_key: currentAccountKey(), queued_at: Date.now() }
  await update(QUEUE_KEY, (queue = []) => [...queue, sale])
  requestPersistentStorage()
  await notify()
}

const removeFromQueue = (clientSaleId) =>
  update(QUEUE_KEY, (queue = []) => queue.filter((s) => s.client_sale_id !== clientSaleId))

const markRejected = (clientSaleId, changes) =>
  update(REJECTED_KEY, (list = []) =>
    list.map((r) => (r.client_sale_id === clientSaleId ? { ...r, ...changes } : r))
  )

/**
 * Avisa al servidor de las ventas rechazadas que todavía no se reportaron.
 * Sin red se detiene y lo reintenta en el próximo intento.
 */
async function reportRejected(accountKey) {
  const rejected = splitByAccount(await getAllRejected(), accountKey).mine
  for (const sale of rejected.filter((r) => !r.reported)) {
    let res
    try {
      res = await apiFetch('/api/sales/rejected', {
        method: 'POST',
        body: JSON.stringify({
          client_sale_id: sale.client_sale_id,
          items: sale.items,
          payment_method: sale.payment_method,
          error: sale.error,
          sold_at: sale.queued_at ? new Date(sale.queued_at).toISOString() : null,
        }),
      })
    } catch (_) {
      return // sin red
    }

    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      // Si resulta que sí se había registrado, no hay nada que mostrar.
      if (data.already_registered) {
        await update(REJECTED_KEY, (list = []) => list.filter((r) => r.client_sale_id !== sale.client_sale_id))
      } else {
        await markRejected(sale.client_sale_id, { reported: true, report_failed: false })
      }
    } else if (res.status === 401 || res.status >= 500) {
      return // sesión vencida o servidor caído: se reintenta después
    } else {
      // Otro 4xx: el servidor no acepta el aviso y reintentar no lo arregla.
      // Queda a la vista del empleado, pero ya no le impide cerrar sesión.
      await markRejected(sale.client_sale_id, { report_failed: true })
    }
  }
}

// Evita dos subidas a la vez (el evento 'online' y el intervalo pueden coincidir).
let flushing = false

// Intenta subir las ventas pendientes de la cuenta abierta, en orden. Se detiene
// ante un problema pasajero (sin red, sesión vencida, servidor caído); una venta
// rechazada de forma definitiva pasa a la lista de rechazadas y la cola sigue.
// Las ventas de otras cuentas no se tocan: esperan a que esa cuenta entre.
export async function flushQueue() {
  if (isElectron() || flushing) return
  flushing = true
  try {
    const accountKey = currentAccountKey()
    const queue = splitByAccount(await getQueue(), accountKey).mine
    for (const sale of queue) {
      // Si la sesión cambió a mitad de la subida, lo que queda ya no es de esta cuenta.
      if (currentAccountKey() !== accountKey) break

      // account_key y queued_at son datos del teléfono; /api/sales los ignora.
      const { account_key, queued_at, ...body } = sale
      let res
      try {
        res = await apiFetch('/api/sales', { method: 'POST', body: JSON.stringify(body) })
      } catch (_) {
        break // sigue sin red — paramos y probamos en el próximo intento
      }

      if (res.ok) {
        await removeFromQueue(sale.client_sale_id)
        continue
      }

      if (DEFINITIVE_REJECTIONS.has(res.status)) {
        const data = await res.json().catch(() => ({}))
        // Primero se guarda como rechazada y DESPUÉS se saca de la cola: si la
        // app se cierra entre medias, la venta queda en las dos listas y el
        // próximo intento la vuelve a rechazar sin duplicarla — nunca en ninguna.
        await update(REJECTED_KEY, (list = []) =>
          list.some((r) => r.client_sale_id === sale.client_sale_id)
            ? list
            : [...list, {
                ...sale,
                error: data.error || `El servidor rechazó la venta (${res.status})`,
                rejected_at: Date.now(),
                reported: false,
              }]
        )
        await removeFromQueue(sale.client_sale_id)
        continue
      }

      break // 401, 5xx u otro problema pasajero: reintentar luego
    }

    if (accountKey && currentAccountKey() === accountKey) await reportRejected(accountKey)
  } finally {
    flushing = false
    await notify()
  }
}

/**
 * El empleado ya vio la venta rechazada. Solo se quita del teléfono si el
 * servidor ya tiene el aviso: si no, sería perderla justo antes de que el
 * dueño se entere. Devuelve si se quitó.
 */
export async function acknowledgeRejected(clientSaleId) {
  const rejected = await getRejected()
  const sale = rejected.find((r) => r.client_sale_id === clientSaleId)
  if (!sale || !sale.reported) return false
  // update sobre la lista completa: las rechazadas de otras cuentas se quedan.
  await update(REJECTED_KEY, (list = []) => list.filter((r) => r.client_sale_id !== clientSaleId))
  await notify()
  return true
}

let flushTimer = null
export function startAutoFlush() {
  if (isElectron() || flushTimer) return
  window.addEventListener('online', flushQueue)
  flushTimer = setInterval(flushQueue, 20_000)
  // Si al abrir ya hay ventas guardadas, que el teléfono no las borre por falta de espacio.
  Promise.all([getQueue(), getAllRejected()])
    .then(([queue, rejected]) => { if (queue.length || rejected.length) requestPersistentStorage() })
    .catch(() => {})
  flushQueue()
  return () => {
    window.removeEventListener('online', flushQueue)
    clearInterval(flushTimer)
    flushTimer = null
  }
}
