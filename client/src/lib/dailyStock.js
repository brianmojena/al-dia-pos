import { parseServerDate } from './dates.js'

const validStock = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
const dateInCuba = (value) => {
  const date = parseServerDate(value)
  return date ? new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date) : ''
}

/** Cantidad recibida hoy en esta caja para un producto, según las operaciones
 * locales (altas con stock y "añadir stock") que aún no están en el snapshot.
 * Se acepta clave numérica o en texto porque las operaciones locales usan ids
 * negativos y el snapshot del servidor usa ids positivos. */
const localEntriesFor = (localEntries, product) => {
  if (!localEntries) return 0
  const raw = localEntries[product.id] ?? localEntries[String(product.id)]
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function productDayStockValues(product, dayStock, date, localEntries = null) {
  const sameDay = dayStock?.date === date
  const row = sameDay && Array.isArray(dayStock.products)
    ? dayStock.products.find((item) => Number(item.id) === Number(product.id))
    : null
  const tracked = !product.unit || Number(product.track_stock) === 1
  const opening = row && row.opening_stock != null && validStock(row.opening_stock) ? row.opening_stock :
    dateInCuba(product.created_at) === date ? 0 : null
  const snapshotEntries = row && validStock(row.entries_stock) ? Number(row.entries_stock) : null
  const local = tracked ? localEntriesFor(localEntries, product) : 0
  // Las entradas son lo recibido hoy: lo que ya confirmó el servidor más lo
  // que esta caja recibió y todavía no bajó en el snapshot. Cuando el snapshot
  // vuelve con la cifra confirmada, la parte local desaparece y no se duplica.
  const entries = !tracked ? 0
    : snapshotEntries != null ? snapshotEntries + local
    : local > 0 ? local
    : null
  const current = row && validStock(row.current_stock) ? row.current_stock : product.stock

  return {
    tracked,
    opening_stock: tracked && validStock(opening) ? (opening == null ? null : Number(opening)) : null,
    entries_stock: tracked ? entries : 0,
    current_stock: validStock(current) ? Number(current) : null,
  }
}

/** Build the owner-only daily stock response from a downloaded snapshot.
 * Current stock comes from the already projected product list, so queued sales
 * and counts remain visible. An opening value is reused only for its own day.
 * `data.local_entries` guarda lo recibido en esta caja por día (aún sin
 * confirmar), para que "Entradas" sea correcta sin conexión.
 */
export function dailyStockFor(data, date) {
  const snapshot = data.daily_stock
  const sameDay = snapshot?.date === date && Array.isArray(snapshot.products)
  const localEntries = data.local_entries?.[date] || null
  return {
    date,
    products: (data.products || []).map((product) => {
      const values = productDayStockValues(product, sameDay ? snapshot : null, date, localEntries)
      return {
        id: product.id,
        ...values,
        current_stock: validStock(product.stock) ? Number(product.stock) : null,
      }
    }),
  }
}
