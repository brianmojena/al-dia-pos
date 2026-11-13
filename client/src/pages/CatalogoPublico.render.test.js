import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

/**
 * La página pública es lo único que ve el cliente final, así que aquí se
 * prueba lo que le importa: el precio al momento, el badge Disponible/Agotado
 * y que del producto nunca se filtre el costo.
 */
test('catálogo público: tarjeta de producto y hoja de reserva', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })
  const previousBroadcastChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  try {
    const { ProductCard, ReservationSheet } = await vite.ssrLoadModule('/src/pages/CatalogoPublico.jsx')

    // Disponible: precio al momento + botón de reserva.
    const pan = { id: 1, name: 'Pan', sale_price: 100, unit: null, pack_size: null, pack_price: null, available: true }
    const disponible = renderToStaticMarkup(React.createElement(ProductCard, { product: pan }))
    assert.match(disponible, /Pan/)
    assert.match(disponible, /\$ 100/)
    assert.match(disponible, /Disponible/)
    assert.match(disponible, /Reservar/)
    assert.doesNotMatch(disponible, /Agotado/)

    // Agotado: badge gris y sin botón de reserva.
    const agotado = renderToStaticMarkup(React.createElement(ProductCard, { product: { ...pan, available: false } }))
    assert.match(agotado, /Agotado/)
    assert.doesNotMatch(agotado, />Reservar</)

    // Por peso: el precio lleva la unidad.
    const arroz = renderToStaticMarkup(React.createElement(ProductCard, { product: { ...pan, name: 'Arroz', sale_price: 250, unit: 'kg', available: true } }))
    assert.match(arroz, /\/ kg/)

    // Paquete: línea con el precio del paquete y el botón rápido.
    const cigarros = renderToStaticMarkup(React.createElement(ProductCard, { product: { ...pan, name: 'Cigarros', sale_price: 60, pack_size: 20, pack_price: 1100 } }))
    assert.match(cigarros, /Paquete de 20: \$ 1[.,]?100/)
    assert.match(cigarros, /\+1 paquete/)

    // La hoja de reserva muestra líneas y total aproximado, nunca costos.
    const sheet = renderToStaticMarkup(React.createElement(ReservationSheet, {
      slug: 'mi-tienda',
      cart: [
        { product_id: 1, product_name: 'Pan', quantity: 3, unit: null, sale_price: 100, pack_size: null },
        { product_id: 2, product_name: 'Arroz', quantity: 1.5, unit: 'kg', sale_price: 250, pack_size: null },
      ],
      onClose: () => {}, onChangeQty: () => {}, onRemove: () => {},
    }))
    assert.match(sheet, /Tu reserva/)
    assert.match(sheet, /Pan/)
    assert.match(sheet, /subtotal \$ 300/)
    assert.match(sheet, /value="1\.5"/) // el kg se edita con decimales
    assert.match(sheet, /Total aproximado/)
    assert.match(sheet, /\$ 675/)
    assert.match(sheet, /Enviar reserva/)
    assert.doesNotMatch(sheet, /purchase_price|costo de compra/i)
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})
