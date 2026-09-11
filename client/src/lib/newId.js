// Identificador de operación generado en el cliente, para que un reintento sea
// reconocible como tal por el servidor (ventas y cierres de caja).
//
// crypto.randomUUID solo existe en contextos seguros (HTTPS o localhost); el
// fallback cubre el caso de abrir el dev server por IP en la red local.
export const newId = () =>
  globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`
