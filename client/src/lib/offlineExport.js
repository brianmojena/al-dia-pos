import { businessDate } from './offlineModel.js'
import { formatTime } from './dates.js'
import { paymentSplit } from './payment.js'
const cell = (value) => {
  // CSV abierto en Excel: los textos del catálogo no deben convertirse en fórmulas.
  const text = String(value ?? '')
  return '"' + (/^[=+@-]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"'
}
export function monthCsv(sales, month) {
  const rows = [['Fecha', 'Hora', 'Venta', 'Producto', 'Cantidad', 'Precio unitario', 'Importe', 'Pago', 'Cobró']]
  for (const sale of sales) {
    if (!businessDate(sale.created_at).startsWith(month)) continue
    const split = paymentSplit(sale)
    const payment = sale.payment_method === 'mixto' ? `Mixto: efectivo ${split.cash}, transferencia ${split.transfer}` : sale.payment_method
    for (const item of sale.items || []) rows.push([businessDate(sale.created_at), formatTime(sale.created_at), sale.id, item.product_name, item.quantity, item.unit_price, item.quantity * item.unit_price, payment, sale.account_email])
  }
  return '\uFEFF' + rows.map((row) => row.map(cell).join(';')).join('\r\n')
}
