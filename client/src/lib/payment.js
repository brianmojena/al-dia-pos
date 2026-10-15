// Formas de cobro. Misma regla que server/lib/payment.js: una venta 'mixto'
// guarda solo la parte transferida y el efectivo es el resto del total; una
// venta 'divisa' guarda los billetes en dólares o euros y la tasa con que se
// tomaron, y el efectivo en pesos es el total menos lo que valen esos billetes
// (negativo cuando se dio vuelto).

export const CURRENCIES = ['USD', 'EUR']

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

export function paymentSplit(sale) {
  const total = Number(sale.total) || 0
  const split = { cash: total, transfer: 0, usd: 0, eur: 0, foreign_cup: 0 }
  if (sale.payment_method === 'transferencia') return { ...split, cash: 0, transfer: total }
  if (sale.payment_method === 'mixto') {
    const transfer = Number(sale.transfer_amount) || 0
    return { ...split, cash: total - transfer, transfer }
  }
  if (sale.payment_method === 'divisa') {
    const amount = round2(sale.foreign_amount)
    const foreignCup = round2(amount * (Number(sale.exchange_rate) || 0))
    return {
      ...split,
      cash: round2(total - foreignCup),
      usd: sale.foreign_currency === 'USD' ? amount : 0,
      eur: sale.foreign_currency === 'EUR' ? amount : 0,
      foreign_cup: foreignCup,
    }
  }
  return split
}

export function paymentLabel(sale) {
  if (sale.payment_method === 'transferencia') return 'Transferencia'
  if (sale.payment_method === 'mixto') return 'Mixto'
  if (sale.payment_method === 'divisa') return sale.foreign_currency === 'EUR' ? 'Euros' : 'Dólares'
  return 'Efectivo'
}

// La tasa del cobro no fue la de la tienda. Sin tasa de tienda conocida no hay
// contra qué comparar.
export function offShopRate(sale) {
  if (sale.payment_method !== 'divisa' || sale.shop_rate == null) return false
  return Math.abs(Number(sale.exchange_rate) - Number(sale.shop_rate)) > 0.005
}

// Lo que ve el cajero al cobrar en divisa: cuánto valen los billetes en pesos,
// y si falta (el cliente completa en pesos) o sobra (se da vuelto en pesos).
export function foreignBreakdown(total, amount, rate) {
  const foreignCup = round2((Number(amount) || 0) * (Number(rate) || 0))
  const rest = round2(total - foreignCup)
  return { foreignCup, cashToCollect: Math.max(0, rest), change: Math.max(0, -rest) }
}

// Cuántos billetes hacen falta para cubrir el total, con dos decimales.
export const foreignNeeded = (total, rate) => (Number(rate) > 0 ? Math.ceil((total / rate) * 100) / 100 : 0)

// "20 USD a 350": así se lee un cobro en divisa en todas las pantallas.
export const fmtForeign = (n) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(Number(n) || 0)

export function maxTransfer(total, transferLimit) {
  const cap = transferLimit === null || transferLimit === undefined ? total : Number(transferLimit)
  return Math.max(0, Math.min(total, cap))
}

// Cada vez que se abre el cobro mixto arranca en 50/50, en pesos enteros. Si
// el techo no deja llegar a la mitad, arranca en el techo.
export function initialTransfer(total, transferLimit) {
  return Math.min(Math.round(total / 2), maxTransfer(total, transferLimit))
}

// Lo que escribe o arrastra la cajera, dentro de lo posible: ni negativo, ni
// más que el total, ni por encima del techo.
export function clampTransfer(value, total, transferLimit) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(Math.max(0, n), maxTransfer(total, transferLimit))
}

// Extracciones de caja
export const WITHDRAWAL_METHODS = ['efectivo', 'transferencia', 'USD', 'EUR']

// Lo que una extracción le quita a cada apartado. Anulada = no quita nada.
export function withdrawalSplit(w) {
  const amount = w.voided_at ? 0 : round2(w.amount)
  const neg = (n) => round2(-n) // Handle -0 issue
  return {
    cash: w.method === 'efectivo' ? neg(amount) : 0,
    transfer: w.method === 'transferencia' ? neg(amount) : 0,
    usd: w.method === 'USD' ? neg(amount) : 0,
    eur: w.method === 'EUR' ? neg(amount) : 0,
  }
}

// Valida y normaliza; lanza Error con mensaje en español para el dueño.
export function withdrawalFields(body) {
  if (!WITHDRAWAL_METHODS.includes(body.method)) throw new Error('Apartado inválido')
  const amount = Number(body.amount)
  if (body.amount == null || body.amount === '' || !Number.isFinite(amount) || round2(amount) <= 0) throw new Error('Falta cuánto dinero se extrae')
  const note = body.note == null ? null : String(body.note).trim().slice(0, 200) || null
  return { method: body.method, amount: round2(amount), note }
}

// Lo que se manda al servidor. Con el slider en un extremo el cobro no es
// mixto: todo en efectivo o todo por transferencia, como si se hubiera tocado
// ese botón (el servidor rechaza un mixto con una parte en cero).
export function mixedPayload(total, transfer) {
  if (transfer <= 0) return { payment_method: 'efectivo' }
  if (transfer >= total) return { payment_method: 'transferencia' }
  return { payment_method: 'mixto', transfer_amount: transfer }
}

// Compra de divisa (la tienda compra billetes y paga en pesos de la gaveta):
// la gaveta pierde los pesos y gana los billetes. Misma cuenta que
// purchaseSplit de server/lib/payment.js.
export function purchaseSplit(purchase) {
  const amount = round2(purchase.foreign_amount)
  return {
    cash: -round2(purchase.cup_amount),
    transfer: 0,
    usd: purchase.foreign_currency === 'USD' ? amount : 0,
    eur: purchase.foreign_currency === 'EUR' ? amount : 0,
  }
}

// Pesos que se pagan por esos billetes a esa tasa.
export const purchaseCup = (amount, rate) => round2(round2(amount) * (Number(rate) || 0))

// La tasa de la compra no fue la de la tienda.
export function offShopPurchase(purchase) {
  if (purchase.shop_rate == null) return false
  return Math.abs(Number(purchase.exchange_rate) - Number(purchase.shop_rate)) > 0.005
}
