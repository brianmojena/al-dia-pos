import test from 'node:test'
import assert from 'node:assert/strict'
import { splitMobileNav, isMoreActive } from './mobileNav.js'

// Ítems de ejemplo que reproducen navItems reales
const items = {
  venta: { to: '/pos', label: 'Venta' },
  caja: { to: '/caja', label: 'Caja' },
  divisas: { to: '/divisas', label: 'Divisas' },
  inicio: { to: '/dashboard', label: 'Inicio' },
  productos: { to: '/products', label: 'Productos' },
  almacen: { to: '/almacen', label: 'Almacén' },
  historial: { to: '/sales', label: 'Historial' },
  admin: { to: '/admin', label: 'Admin' },
}

test('dueño con 5 ítems: todos en primary, more vacío', () => {
  const nav = [items.venta, items.caja, items.divisas, items.inicio, items.productos]
  const { primary, more } = splitMobileNav(nav, { isOwner: true })

  assert.deepEqual(primary, nav)
  assert.deepEqual(more, [])
})

test('dueño con 7 ítems: los 4 principales + Divisas/Almacén/Historial en more', () => {
  const nav = [
    items.venta,
    items.caja,
    items.divisas,
    items.inicio,
    items.productos,
    items.almacen,
    items.historial,
  ]
  const { primary, more } = splitMobileNav(nav, { isOwner: true })

  // Dueño: principal es [/dashboard, /pos, /caja, /products] en ese orden
  assert.deepEqual(primary, [items.inicio, items.venta, items.caja, items.productos])
  // More debe tener los demás en su orden original: divisas, almacen, historial
  assert.deepEqual(more, [items.divisas, items.almacen, items.historial])
})

test('dueño con 8 ítems (incluyendo admin): admin va a more', () => {
  const nav = [
    items.venta,
    items.caja,
    items.divisas,
    items.inicio,
    items.productos,
    items.almacen,
    items.historial,
    items.admin,
  ]
  const { primary, more } = splitMobileNav(nav, { isOwner: true })

  assert.deepEqual(primary, [items.inicio, items.venta, items.caja, items.productos])
  // More: divisas, almacen, historial, admin en su orden original
  assert.deepEqual(more, [items.divisas, items.almacen, items.historial, items.admin])
})

test('cajero con 6 ítems: principal [/pos,/caja,/divisas,/products], more [/almacen,/sales]', () => {
  const nav = [items.venta, items.caja, items.divisas, items.productos, items.almacen, items.historial]
  const { primary, more } = splitMobileNav(nav, { isOwner: false })

  // Cajero: principal es [/pos, /caja, /divisas, /products] en ese orden
  assert.deepEqual(primary, [items.venta, items.caja, items.divisas, items.productos])
  // More: almacen, historial
  assert.deepEqual(more, [items.almacen, items.historial])
})

test('cajero con 5 ítems (sin almacén): todos en primary, more vacío', () => {
  const nav = [items.venta, items.caja, items.divisas, items.productos, items.historial]
  const { primary, more } = splitMobileNav(nav, { isOwner: false })

  assert.deepEqual(primary, nav)
  assert.deepEqual(more, [])
})

test('nunca pierde ni duplica ítems', () => {
  const navs = [
    [items.venta, items.caja, items.divisas, items.inicio, items.productos],
    [
      items.venta,
      items.caja,
      items.divisas,
      items.inicio,
      items.productos,
      items.almacen,
      items.historial,
    ],
    [
      items.venta,
      items.caja,
      items.divisas,
      items.productos,
      items.almacen,
      items.historial,
    ],
  ]

  for (const nav of navs) {
    const { primary, more } = splitMobileNav(nav, { isOwner: true })
    const combined = primary.concat(more)
    const navPaths = nav.map((i) => i.to)
    const combinedPaths = combined.map((i) => i.to)

    assert.equal(combined.length, nav.length, `esperado ${nav.length}, obtenido ${combined.length}`)
    // Verificar que combinedPaths contiene exactamente los mismos items que navPaths
    // (puede haber reorden en primary, pero no pérdidas ni duplicados)
    assert.deepEqual(
      combinedPaths.sort(),
      navPaths.sort(),
      'los items no deben perderse ni duplicarse',
    )
  }
})

test('isMoreActive: true para rutas en more', () => {
  const more = [items.almacen, items.historial, items.admin]

  assert.equal(isMoreActive(more, '/almacen'), true)
  assert.equal(isMoreActive(more, '/sales'), true)
  assert.equal(isMoreActive(more, '/admin'), true)
})

test('isMoreActive: true para subrutas de more', () => {
  const more = [items.historial]

  assert.equal(isMoreActive(more, '/sales/123'), true)
  assert.equal(isMoreActive(more, '/sales/detail/456'), true)
})

test('isMoreActive: false para rutas no en more', () => {
  const more = [items.almacen, items.historial]

  assert.equal(isMoreActive(more, '/pos'), false)
  assert.equal(isMoreActive(more, '/caja'), false)
  assert.equal(isMoreActive(more, '/divisas'), false)
})

test('isMoreActive: false para rutas similares pero distintas', () => {
  const more = [items.historial]

  assert.equal(isMoreActive(more, '/salesx'), false)
  assert.equal(isMoreActive(more, '/sale'), false)
})

// Auditoría se añadió después del menú original: también debe quedar accesible.
test('Auditoría queda en Más sin superar cinco controles en la barra', () => {
  const items = ['/pos', '/caja', '/dashboard', '/products', '/sales', '/auditoria', '/admin'].map(to => ({ to }));
  const { primary, more } = splitMobileNav(items, { isOwner: true });
  assert.ok(primary.length + (more.length ? 1 : 0) <= 5);
  assert.ok(more.some(item => item.to === '/auditoria'));
  assert.equal(new Set([...primary, ...more].map(item => item.to)).size, items.length);
});
