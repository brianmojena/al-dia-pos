const KEY = 'mypimes_operation_clock_v1'
let anchor

// La fecha del servidor evita convertir un reloj mal ajustado en ventas futuras.
export function observeServerTime(value) {
  const server = Date.parse(value)
  if (!Number.isFinite(server)) return
  const local = Date.now()
  anchor = { server, tick: performance.now() }
  try { localStorage.setItem(KEY, JSON.stringify({ server, local })) } catch { /* la venta no depende de esta caché */ }
}

export function operationNow() {
  if (anchor) return new Date(anchor.server + Math.max(0, performance.now() - anchor.tick)).toISOString()
  const now = Date.now()
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    if (Number.isFinite(saved?.server) && Number.isFinite(saved?.local) && now >= saved.local - 300_000) {
      return new Date(now + saved.server - saved.local).toISOString()
    }
  } catch { /* sin una referencia válida se conserva la fecha local */ }
  return new Date(now).toISOString()
}
