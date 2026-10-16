import { businessDate } from './offlineModel.js'

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
