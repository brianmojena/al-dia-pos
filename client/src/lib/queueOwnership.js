// De quién es cada venta guardada sin internet.
//
// La cola vive en el teléfono, no en la sesión: si alguien cierra sesión (o se
// le vence) con ventas por subir y en ese teléfono entra OTRA cuenta, antes esas
// ventas se subían con el token nuevo — a nombre de otra persona o, si la cuenta
// es de otra tienda, a la tienda equivocada. Ahora cada venta lleva la cuenta
// que la cobró y solo se sube cuando esa misma cuenta tiene la sesión abierta.
//
// La identidad sale del propio token (tienda + cuenta), sin pedir nada a la red:
// justo cuando esto importa, no hay internet.

/** Lee los datos del JWT sin verificarlo (eso lo hace el servidor). */
function decodeTokenPayload(token) {
  if (typeof token !== 'string') return null
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    )
    return JSON.parse(json)
  } catch (_) {
    return null
  }
}

/**
 * "tienda:cuenta" de la sesión abierta, o null si no hay sesión válida.
 * Los tokens anteriores a los roles solo traen userId: eran del dueño, igual
 * que los interpreta el servidor (middleware/auth.js).
 */
export function accountKeyFromToken(token) {
  const payload = decodeTokenPayload(token)
  if (!payload || payload.userId == null) return null
  return `${payload.userId}:${payload.accountId ?? payload.userId}`
}

/**
 * ¿Puede subir esta venta la sesión abierta? Las ventas encoladas antes de este
 * cambio no traen cuenta: se suben con la sesión que haya, como hasta ahora.
 */
export function belongsToAccount(sale, accountKey) {
  if (!accountKey) return false
  return !sale?.account_key || sale.account_key === accountKey
}

/** Separa una lista en las ventas de la sesión abierta y las de otras cuentas. */
export function splitByAccount(list, accountKey) {
  const mine = []
  const others = []
  for (const sale of Array.isArray(list) ? list : []) {
    (belongsToAccount(sale, accountKey) ? mine : others).push(sale)
  }
  return { mine, others }
}

/**
 * Lo que impide cerrar sesión: ventas sin subir y ventas rechazadas de las que
 * el dueño todavía no se enteró. Las rechazadas cuyo aviso el servidor no acepta
 * (report_failed) no bloquean: reintentar no lo arregla y dejarían al empleado
 * sin poder salir nunca.
 */
export function logoutBlockers(queue, rejected, accountKey) {
  const pending = splitByAccount(queue, accountKey).mine.length
  const unreported = splitByAccount(rejected, accountKey).mine
    .filter((r) => !r.reported && !r.report_failed).length
  return { pending, unreported, total: pending + unreported }
}
