import { businessDate } from './offlineModel.js'
import { formatTime } from './dates.js'
import { paymentSplit, offShopRate, EXPENSE_CATEGORY_LABELS } from './payment.js'
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
    const payment = sale.payment_method === 'mixto' ? `Mixto: efectivo ${split.cash}, transferencia ${split.transfer}`
      : sale.payment_method === 'divisa' ? `${sale.foreign_amount} ${sale.foreign_currency} a ${sale.exchange_rate}${split.cash > 0 ? ` + efectivo ${split.cash}` : split.cash < 0 ? `, vuelto ${-split.cash}` : ''}${offShopRate(sale) ? ` (tasa tienda ${sale.shop_rate})` : ''}`
      : sale.payment_method
    for (const item of sale.items || []) rows.push([businessDate(sale.created_at), formatTime(sale.created_at), sale.id, item.product_name, item.quantity, item.unit_price, item.quantity * item.unit_price, payment, sale.account_email])
  }
  return '\uFEFF' + rows.map((row) => row.map(cell).join(';')).join('\r\n')
}

// Resumen contable del mes para descargar sin conexión (mismo orden de columnas
// que la hoja "Resumen por día" del Excel, más la lista de gastos).
export function accountingCsv(summary, expenses, month) {
  const rows = [['Fecha', 'Ingresos', 'Ganancia', 'Gastos CUP', 'Gastos USD', 'Gastos EUR', 'Resultado']]
  for (const day of summary?.days || []) {
    rows.push([day.date, day.income, day.profit, day.expenses_cup, day.expenses_usd, day.expenses_eur, day.result_cup])
  }
  const t = summary?.totals || {}
  rows.push([`Total ${month}`, t.income || 0, t.profit || 0, t.expenses_cup || 0, t.expenses_usd || 0, t.expenses_eur || 0, t.result_cup || 0])
  rows.push([])
  rows.push(['Fecha', 'Hora', 'Concepto', 'Categoría', 'Apartado', 'Monto', 'Estado'])
  for (const expense of expenses || []) {
    if (!businessDate(expense.created_at).startsWith(month)) continue
    rows.push([
      businessDate(expense.created_at),
      formatTime(expense.created_at),
      expense.concept,
      EXPENSE_CATEGORY_LABELS[expense.category] || 'Sin categoría',
      expense.method,
      expense.amount,
      expense.voided_at ? 'Anulado' : 'Activo',
    ])
  }
  return '\uFEFF' + rows.map((row) => row.map(cell).join(';')).join('\r\n')
}
