import { newId } from './newId.js'

const KEY = 'mypimes_device_id'

// No se borra al salir: volver a entrar y abrir pestañas no duplica el equipo.
// Si el almacenamiento está bloqueado, se omite la telemetría y la caja sigue.
export function deviceHeaders() {
  try {
    let id = localStorage.getItem(KEY)
    if (!id || !/^[A-Za-z0-9-]{16,80}$/.test(id)) {
      id = `web-${newId()}`
      localStorage.setItem(KEY, id)
    }
    return { 'X-Device-Id': id, 'X-Device-Platform': 'web' }
  } catch (_) { return {} }
}
