// Productos por peso. Mismas reglas que server/lib/units.js: un producto con
// `unit` tiene precio, costo y stock por esa unidad y admite fracciones (hasta
// 3 decimales); sin `unit` todo es entero.
export const UNITS = [
  { value: 'lb', label: 'Libras (lb)' },
  { value: 'kg', label: 'Kilogramos (kg)' },
  { value: 'g',  label: 'Gramos (g)' },
]

export const roundQty = (n) => Math.round(Number(n) * 1000) / 1000
export const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100
export const lineTotal = (quantity, price) => roundMoney(Number(quantity) * Number(price))

export const isValidUnit = (unit) => unit == null || unit === '' || UNITS.some((u) => u.value === unit)

export function validQuantity(value, unit, min = 0) {
  const n = Number(value)
  if (value === null || value === '' || !Number.isFinite(n) || n < min) return false
  return unit ? Math.abs(roundQty(n) - n) < 1e-9 : Number.isInteger(n)
}

// "2.35 lb", "12 uds" — sin ceros de relleno.
export function formatQty(quantity, unit) {
  const text = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 3 }).format(roundQty(quantity))
  return unit ? `${text} ${unit}` : text
}

// Precio con su medida: "$ 300 / lb".
export const priceSuffix = (unit) => (unit ? ` / ${unit}` : '')

// Cantidad que se puede vender de un golpe al tocar "+": 1 pieza, o 0.5 de unidad de peso.
export const quantityStep = (unit) => (unit === 'g' ? 100 : unit ? 0.5 : 1)

// Venta por paquete (mismas reglas que server/lib/units.js): el stock, el costo
// y el precio de venta son del suelto; pack_size dice cuántos trae el paquete.
export const hasPack = (p) => !p?.unit && Number(p?.pack_size) > 1

// Sueltos que salen del stock por una línea: 2 paquetes de 20 son 40.
export const lineUnits = (item) => roundQty(Number(item.quantity) * (Number(item.pack_size) > 1 ? Number(item.pack_size) : 1))

// "3 paq + 7 sueltos" (67 cigarros, paquete de 20). Sin paquete, el número tal cual.
export function formatPackStock(stock, packSize) {
  const n = Number(stock) || 0
  const size = Number(packSize)
  if (!(size > 1)) return formatQty(n, null)
  const packs = Math.floor(n / size)
  const loose = roundQty(n - packs * size)
  if (!packs) return `${formatQty(loose, null)} sueltos`
  return loose ? `${packs} paq + ${formatQty(loose, null)} sueltos` : `${packs} paq`
}
