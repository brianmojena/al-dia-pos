import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

/**
 * La tarjeta de reserva del panel del dueño: acciones según el estado y el
 * aviso cuando el producto ya no está disponible (la reserva guarda su copia
 * congelada, pero al confirmar el dueño necesita saber si hoy hay).
 */
test('tienda online: tarjeta de reserva del dueño', async () => {
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
    const { ReservationCard } = await vite.ssrLoadModule('/src/pages/TiendaOnline.jsx')

    const base = {
      id: 7,
      client_reservation_id: 'res-1',
      customer_name: 'María Pérez',
      customer_phone: '53123456',
      customer_note: 'Para mañana',
      status: 'pendiente',
      created_at: '2026-11-09 14:33:21',
      items: JSON.stringify([
        { product_id: 1, product_name: 'Pan', quantity: 3, unit: null, sale_price: 100, pack_size: null, current_available: true },
        { product_id: 2, product_name: 'Arroz', quantity: 1.5, unit: 'kg', sale_price: 250, pack_size: null, current_available: false },
      ]),
    }

    // Pendiente: acciones de confirmar/anular, teléfono clicable, aviso de faltantes.
    const pendiente = renderToStaticMarkup(React.createElement(ReservationCard, { row: base }))
    assert.match(pendiente, /María Pérez/)
    assert.match(pendiente, /53123456/)
    assert.match(pendiente, /Pendiente/)
    assert.match(pendiente, /3 × Pan/)
    assert.match(pendiente, /1,5 kg × Arroz/)
    assert.match(pendiente, /ya no hay/)
    assert.match(pendiente, /Algunos productos ya no están disponibles/)
    assert.match(pendiente, /Confirmar/)
    assert.match(pendiente, /Anular/)
    assert.match(pendiente, /«Para mañana»/)

    // Confirmada: pasa a Entregada/Anular.
    const confirmada = renderToStaticMarkup(React.createElement(ReservationCard, { row: { ...base, status: 'confirmada' } }))
    assert.match(confirmada, /Entregada/)
    assert.doesNotMatch(confirmada, />Confirmar</)

    // Entregada es terminal: ya no hay botones de estado.
    const entregada = renderToStaticMarkup(React.createElement(ReservationCard, { row: { ...base, status: 'entregada' } }))
    assert.match(entregada, /Entregada/)
    assert.doesNotMatch(entregada, />Anular</)
    // El aviso de faltantes no se pinta en una reserva anulada.
    const anulada = renderToStaticMarkup(React.createElement(ReservationCard, { row: { ...base, status: 'anulada' } }))
    assert.doesNotMatch(anulada, /Algunos productos ya no están disponibles/)

    // El server también manda los items ya parseados (con current_available
    // enriquecido): la tarjeta no puede quedarse en blanco con esa forma.
    const conArray = renderToStaticMarkup(React.createElement(ReservationCard, { row: {
      ...base,
      items: JSON.parse(base.items),
    } }))
    assert.match(conArray, /3 × Pan/)
    assert.match(conArray, /1,5 kg × Arroz/)
    assert.match(conArray, /ya no hay/)
    const sinItemsValidos = renderToStaticMarkup(React.createElement(ReservationCard, { row: { ...base, items: null } }))
    assert.match(sinItemsValidos, /María Pérez/)
    assert.doesNotMatch(sinItemsValidos, /3 × Pan/)
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})
