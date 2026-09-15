// Pide al navegador que no borre los datos de la app para liberar espacio.
//
// Sin esto, las ventas guardadas sin internet (IndexedDB) son "almacenamiento
// de mejor esfuerzo": si el teléfono se queda casi sin memoria, el sistema
// puede limpiarlas. Con el permiso concedido solo se borran si la persona borra
// los datos a mano.
//
// Chrome y Safari lo conceden (o no) sin preguntar, sobre todo si la web está
// instalada en la pantalla de inicio. Por eso se pide cuando hay ventas que
// proteger y no al abrir la app: en Firefox sí sale un aviso, y no tiene
// sentido mostrarlo en la pantalla de inicio de sesión.
let requested = null

export function requestPersistentStorage() {
  if (requested) return requested
  requested = (async () => {
    try {
      const storage = typeof navigator !== 'undefined' ? navigator.storage : null
      if (!storage?.persist) return false
      if (await storage.persisted?.()) return true
      return await storage.persist()
    } catch (_) {
      return false
    }
  })()
  return requested
}
