import { businessDate } from './offlineModel.js'
import { paymentSplit } from './payment.js'

// Resume exactamente la lista personal que recibe el historial del cajero.
// sale.total ya está expresado en CUP incluso si el cobro fue en USD/EUR.
export function summarizeCashierSales(sales, now = new Date()) {
  const rows = Array.isArray(sales) ? sales : []
  const today = businessDate(now)
  if (!today) return { count: 0, total: 0, pendingCount: 0 }
  let count = 0
  let totalCents = 0
  let pendingCount = 0
  for (const sale of rows) {
    if (!sale?.created_at) continue
    const saleDay = businessDate(sale?.created_at)
    if (!saleDay || saleDay !== today) continue
    count++
    const amount = Number(sale?.total)
    if (Number.isFinite(amount)) totalCents += Math.round(amount * 100)
    if (sale?.pending === true || (sale?.origin === 'local' && sale?.server_id == null)) pendingCount++
  }
  return { count, total: totalCents / 100, pendingCount }
}

// Cómo se repartió lo cobrado HOY entre las cuatro formas de pago, sobre la
// misma lista personal del cajero (incluidas las ventas sin subir). Efectivo y
// transferencia van en CUP; dólares y euros, en billetes sin convertir.
export function summarizeCashierPayments(sales, now = new Date()) {
  const rows = Array.isArray(sales) ? sales : []
  const today = businessDate(now)
  const totals = { cash: 0, transfer: 0, usd: 0, eur: 0 }
  if (!today) return totals
  for (const sale of rows) {
    if (!sale?.created_at) continue
    if (businessDate(sale.created_at) !== today) continue
    const split = paymentSplit(sale)
    totals.cash += split.cash
    totals.transfer += split.transfer
    totals.usd += split.usd
    totals.eur += split.eur
  }
  return totals
}
