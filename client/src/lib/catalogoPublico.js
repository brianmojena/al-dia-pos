// Reglas puras de la tienda pública (/t/<slug>): mismas decisiones que
// server/routes/catalog.js, pero del lado del cliente para poder dar feedback
// antes de gastar la petición. Sin React ni red — se prueba directo.
import { roundQty, roundMoney } from './units.js'

export const POLL_MS = 30_000

export const catalogCacheKey = (slug) => `catalogo_publico_v1:${slug}`

export const LANDING_URL = 'https://al-dia-landing-nine.vercel.app'

// Misma techada que el servidor: una reserva de 30 líneas no es un pedido, es un ataque.
export const MAX_ITEMS = 30

/**
 * Cantidades del formulario de reserva. Igual que el servidor: por pieza un
 * entero desde 1, por peso fracción de hasta 3 decimales desde 1 g. Acepta
 * coma decimal (el teclado de algunos teléfonos no tiene punto).
 * Devuelve la cantidad redondeada o null si no es válida.
 */
export function parseQuantityInput(text, unit) {
  const raw = String(text ?? '').replace(',', '.').trim()
  if (raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 9999) return null
  if (!unit) {
    if (!Number.isInteger(n)) return null
    return n
  }
  if (Math.abs(roundQty(n) - n) >= 1e-9) return null
  return roundQty(n)
}

/** Errores del formulario del cliente ({name?, phone?, note?}) o null si todo bien. */
export function validateCustomer(name, phone, note) {
  const errors = {}
  const n = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!n || n.length > 80) errors.name = 'Escribe tu nombre (máximo 80 caracteres)'
  const p = String(phone ?? '').trim().replace(/\s+/g, ' ')
  if (!p || p.length > 30) errors.phone = 'Escribe un teléfono para contactarte (máximo 30 caracteres)'
  if (String(note ?? '').trim().length > 300) errors.note = 'La nota no puede pasar de 300 caracteres'
  return Object.keys(errors).length ? errors : null
}

// Línea y total de la lista: aproximados, el dueño confirma el precio final.
export const itemLineTotal = (item) => roundMoney(Number(item.quantity) * Number(item.sale_price))
export const reservationTotal = (items) => roundMoney(items.reduce((sum, i) => sum + itemLineTotal(i), 0))

/** Junta dos entradas del mismo producto en una sola línea. */
export function mergeReservationItem(items, product, quantity) {
  const existing = items.find((i) => i.product_id === product.id)
  if (!existing) {
    return [...items, {
      product_id: product.id,
      product_name: product.name,
      quantity: roundQty(quantity),
      unit: product.unit ?? null,
      sale_price: product.sale_price,
      pack_size: product.pack_size ?? null,
    }]
  }
  return items.map((i) => (i.product_id === product.id
    ? { ...i, quantity: roundQty(i.quantity + quantity), sale_price: product.sale_price, pack_size: product.pack_size ?? null }
    : i))
}

/** "hace 5 s" / "hace 2 min" para el indicador de actualización. */
export function updatedAgo(updatedAt, now) {
  if (!updatedAt) return ''
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
  if (seconds < 60) return `hace ${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `hace ${minutes} min`
  return `hace ${Math.floor(minutes / 60)} h`
}
