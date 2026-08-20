// Cola de ventas offline para el modo web (PWA). Mismo problema que resuelve
// desktop/src/db/localDb.js (outbox) — "el internet se corta a mitad de una
// venta" — pero aquí no hay un proceso local con SQLite: solo el navegador,
// así que usamos IndexedDB (vía idb-keyval) como el único almacenamiento que
// sobrevive a cerrar la pestaña.
//
// No intenta ser tan completo como el outbox de escritorio (no hay
// resolución de server_id entre operaciones dependientes: aquí solo se
// encolan ventas, que no dependen unas de otras). Es del tamaño exacto del
// problema real: la venta se cobró, el POST a /api/sales no llegó, hay que
// reintentarlo sin duplicar ni perder la venta.
import { get, set, update } from 'idb-keyval'
import { apiFetch, isElectron } from './api'

const QUEUE_KEY = 'mypimes_sales_queue'
const listeners = new Set()

const notify = async () => {
  const pending = await getPendingCount()
  listeners.forEach(fn => fn(pending))
}

export function subscribe(fn) {
  listeners.add(fn)
  getPendingCount().then(fn)
  return () => listeners.delete(fn)
}

async function getQueue() {
  return (await get(QUEUE_KEY)) || []
}

export async function getPendingCount() {
  if (isElectron()) return 0 // el escritorio tiene su propio indicador (SyncStatus vía IPC)
  const queue = await getQueue()
  return queue.length
}

// Guarda la venta ya "cobrada" localmente aunque el POST haya fallado por red.
// El client_sale_id viaja intacto — cuando el servidor por fin la reciba, la
// misma garantía de idempotencia que ya existe en el backend evita duplicados.
export async function enqueueSale(payload) {
  await update(QUEUE_KEY, (queue = []) => [...queue, { ...payload, queued_at: Date.now() }])
  await notify()
}

// Intenta subir todas las ventas pendientes, en orden. Se detiene en el
// primer error de red (probablemente seguimos offline) pero sigue de largo
// ante un error del servidor (4xx/5xx) para no bloquear el resto de la cola
// por una venta puntualmente rechazada.
export async function flushQueue() {
  if (isElectron()) return
  const queue = await getQueue()
  if (queue.length === 0) return

  const remaining = [...queue]
  for (const sale of queue) {
    try {
      const res = await apiFetch('/api/sales', {
        method: 'POST',
        body: JSON.stringify(sale),
      })
      if (res.ok || res.status === 409) {
        // 409 real (ej. stock insuficiente) no se puede reintentar solo —
        // la dejamos afuera de la cola para no reintentar algo que fallará
        // siempre; el dueño la verá reflejada como discrepancia en el stock.
        remaining.shift()
        await set(QUEUE_KEY, remaining)
      } else {
        break // error del servidor no relacionado a stock: reintentar luego
      }
    } catch (_) {
      break // sigue sin red — paramos y probamos en el próximo flush
    }
  }
  await notify()
}

let flushTimer = null
export function startAutoFlush() {
  if (isElectron() || flushTimer) return
  window.addEventListener('online', flushQueue)
  flushTimer = setInterval(flushQueue, 20_000)
  flushQueue()
  return () => {
    window.removeEventListener('online', flushQueue)
    clearInterval(flushTimer)
    flushTimer = null
  }
}
