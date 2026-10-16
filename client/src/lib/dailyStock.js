import { parseServerDate } from './dates.js'

const validStock = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
const dateInCuba = (value) => {
  const date = parseServerDate(value)
  return date ? new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date) : ''
}

export function productDayStockValues(product, dayStock, date) {
  const sameDay = dayStock?.date === date
  const row = sameDay && Array.isArray(dayStock.products)
    ? dayStock.products.find((item) => Number(item.id) === Number(product.id))
    : null
  const tracked = !product.unit || Number(product.track_stock) === 1
  const opening = row && row.opening_stock != null && validStock(row.opening_stock) ? row.opening_stock :
    dateInCuba(product.created_at) === date ? 0 : null
  const current = row && validStock(row.current_stock) ? row.current_stock : product.stock

  return {
    tracked,
    opening_stock: tracked && validStock(opening) ? (opening == null ? null : Number(opening)) : null,
    current_stock: validStock(current) ? Number(current) : null,
  }
}

/** Build the owner-only daily stock response from a downloaded snapshot.
 * Current stock comes from the already projected product list, so queued sales
 * and counts remain visible. An opening value is reused only for its own day.
 */
export function dailyStockFor(data, date) {
  const snapshot = data.daily_stock
  const sameDay = snapshot?.date === date && Array.isArray(snapshot.products)
  return {
    date,
    products: (data.products || []).map((product) => {
      const values = productDayStockValues(product, sameDay ? snapshot : null, date)
      return {
        id: product.id,
        ...values,
        current_stock: validStock(product.stock) ? Number(product.stock) : null,
      }
    }),
  }
}
