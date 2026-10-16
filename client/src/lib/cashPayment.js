import { accountKeyFromToken } from './queueOwnership.js'

const MONTEVALDES_USER_ID = '10'

/** El userId del JWT es el id de la tienda para dueños y cajeros. */
export function isMontevaldesCashEnabled(token) {
  const accountKey = accountKeyFromToken(token)
  return accountKey?.split(':')[0] === MONTEVALDES_USER_ID
}

/** Convierte un importe CUP escrito con punto o coma a centavos, o null si no vale. */
export function parseCupCents(value) {
  if (typeof value !== 'string') return null
  const amount = value.trim()
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(amount)
  if (!match) return null
  const whole = Number(match[1])
  if (!Number.isSafeInteger(whole)) return null
  const cents = Number((match[2] || '').padEnd(2, '0') || '0')
  const total = whole * 100 + cents
  return Number.isSafeInteger(total) ? total : null
}

/** Calcula la diferencia en centavos para evitar ruido de punto flotante. */
export function cashPaymentBreakdown(total, amountReceived) {
  const totalCents = Number.isFinite(total) && total >= 0
    ? Math.round(total * 100)
    : null
  const receivedCents = parseCupCents(amountReceived)
  const validAmount = receivedCents != null && receivedCents > 0
  if (totalCents == null || !validAmount) {
    return { totalCents, receivedCents, changeCents: 0, shortfallCents: 0, validAmount, canConfirm: false }
  }
  const difference = receivedCents - totalCents
  return {
    totalCents,
    receivedCents,
    changeCents: Math.max(0, difference),
    shortfallCents: Math.max(0, -difference),
    validAmount,
    canConfirm: difference >= 0,
  }
}
