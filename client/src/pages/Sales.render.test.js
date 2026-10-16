import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

test('el resumen visible de cajero conserva centavos y muestra cero cuando no hay ventas', async () => {
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
    const { CashierSalesSummary } = await vite.ssrLoadModule('/src/pages/Sales.jsx')
    const markup = renderToStaticMarkup(React.createElement(CashierSalesSummary, {
      now: '2026-10-15T15:00:00.000Z',
      sales: [
        { total: 5.25, payment_method: 'mixto', transfer_amount: 1.25, created_at: '2026-10-15 12:00:00' },
        { total: 5.25, payment_method: 'divisa', foreign_currency: 'USD', foreign_amount: 0.1, exchange_rate: 100, pending: true, created_at: '2026-10-15T13:00:00.000Z' },
        { total: 999, payment_method: 'efectivo', created_at: '2026-10-15T03:59:00.000Z' },
      ],
    }))
    assert.match(markup, /Mis ventas de hoy/)
    assert.match(markup, /Importe total \(CUP\)/)
    assert.match(markup, />2</)
    assert.match(markup, /\$ 10,50/, 'conserva centavos y no vuelve a sumar el importe extranjero')
    assert.match(markup, /Incluye 1 venta pendiente de sincronizar/)
    assert.doesNotMatch(markup, /Ganancia|profit|costo/i)

    const emptyMarkup = renderToStaticMarkup(React.createElement(CashierSalesSummary, { sales: [], now: '2026-10-15T15:00:00.000Z' }))
    assert.match(emptyMarkup, />0</)
    assert.match(emptyMarkup, /\$ 0,00/)
    assert.doesNotMatch(emptyMarkup, /pendiente/)
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})
