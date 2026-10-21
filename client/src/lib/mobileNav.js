// Divide la navegación móvil en 4 botones principales + un botón "Más"
// para evitar saturación en pantallas pequeñas.

export function splitMobileNav(visibleNav, { isOwner }) {
  // Si hay 5 o menos ítems, todos caben en la barra principal
  if (visibleNav.length <= 5) {
    return {
      primary: visibleNav,
      more: [],
    }
  }

  // Más de 5: elegir 4 principales según el rol, el resto en "Más"
  const primaryPaths = isOwner
    ? ['/dashboard', '/pos', '/caja', '/products']
    : ['/pos', '/caja', '/divisas', '/products']

  const primary = []
  const usedIndices = new Set()

  // Tomar los ítems en el orden de primaryPaths que existan en visibleNav
  for (const path of primaryPaths) {
    const idx = visibleNav.findIndex((item) => item.to === path)
    if (idx !== -1) {
      primary.push(visibleNav[idx])
      usedIndices.add(idx)
    }
  }

  // Todos los demás van a "Más", en su orden original
  const more = visibleNav.filter((_, idx) => !usedIndices.has(idx))

  return { primary, more }
}

// Determina si una ruta pertenece al menú "Más"
export function isMoreActive(more, pathname) {
  return more.some((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))
}
