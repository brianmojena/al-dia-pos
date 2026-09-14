// Stock que muestra la web: la última foto del servidor MENOS las ventas que
// se cobraron sin internet y todavía no subieron.
//
// Antes el descuento de una venta sin conexión solo vivía en la pantalla: si el
// empleado cerraba la app y la volvía a abrir sin internet, el stock volvía al
// último número descargado y se podía vender lo que ya no había.
//
// Por qué no guardar directamente el stock ya descontado: la foto del servidor
// y la cola de ventas pendientes son dos fuentes que se corrigen solas. Sin
// internet, la foto no cambia y la cola descuenta. Con internet y ventas aún
// sin subir, el servidor todavía no las incluye y la cola las descuenta. Cuando
// suben, salen de la cola y el servidor ya las incluye. En los tres casos el
// número es el correcto, sin llevar la cuenta a mano en ningún sitio.
export function applyPendingSales(products, pendingSales) {
  if (!Array.isArray(products)) return []

  const pending = new Map()
  for (const sale of pendingSales || []) {
    for (const item of sale?.items || []) {
      const id = Number(item.product_id)
      const quantity = Number(item.quantity)
      if (Number.isFinite(id) && Number.isInteger(quantity) && quantity > 0) {
        pending.set(id, (pending.get(id) || 0) + quantity)
      }
    }
  }
  if (pending.size === 0) return products

  return products.map((p) => {
    const sold = pending.get(Number(p.id))
    return sold ? { ...p, stock: Math.max(0, Number(p.stock) - sold) } : p
  })
}
