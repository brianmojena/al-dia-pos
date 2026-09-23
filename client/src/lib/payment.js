// Formas de cobro. Misma regla que server/lib/payment.js: una venta 'mixto'
// guarda solo la parte transferida y el efectivo es el resto del total.

export function paymentSplit(sale) {
  const total = Number(sale.total) || 0
  if (sale.payment_method === 'transferencia') return { cash: 0, transfer: total }
  if (sale.payment_method === 'mixto') {
    const transfer = Number(sale.transfer_amount) || 0
    return { cash: total - transfer, transfer }
  }
  return { cash: total, transfer: 0 }
}

export function paymentLabel(sale) {
  if (sale.payment_method === 'transferencia') return 'Transferencia'
  if (sale.payment_method === 'mixto') return 'Mixto'
  return 'Efectivo'
}

// Hasta dónde puede llegar la transferencia en un cobro mixto: el total, o el
// techo del dueño si es menor (el techo mira solo la parte transferida).
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

// Lo que se manda al servidor. Con el slider en un extremo el cobro no es
// mixto: todo en efectivo o todo por transferencia, como si se hubiera tocado
// ese botón (el servidor rechaza un mixto con una parte en cero).
export function mixedPayload(total, transfer) {
  if (transfer <= 0) return { payment_method: 'efectivo' }
  if (transfer >= total) return { payment_method: 'transferencia' }
  return { payment_method: 'mixto', transfer_amount: transfer }
}
