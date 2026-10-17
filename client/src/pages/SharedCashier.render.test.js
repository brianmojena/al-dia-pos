import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { StaticRouter } from 'react-router-dom/server.js'

test('la entrada compartida identifica la caja y los cajeros sin mostrar credenciales', async () => {
  const values = new Map()
  globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) }
  const previousChannel = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  const vite = await createServer({ configFile: false, plugins: [reactPlugin()], root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
  try {
    const { default: SharedCashier } = await vite.ssrLoadModule('/src/pages/SharedCashier.jsx')
    const { AuthProvider } = await vite.ssrLoadModule('/src/context/AuthContext.jsx')
    const record = {
      version: 1, device: { id: 'test-device', owner_id: 7, name: 'Mostrador central', continuous: true, expires_at: new Date(Date.now() + 86400000).toISOString() },
      cashiers: [{ id: 12, display_name: 'Ana', email: 'ana@test.local', token: 'token-privado', pin: { hash: 'hash-privado' } }, { id: 13, display_name: 'Bea', email: 'bea@test.local' }],
    }
    const render = () => renderToStaticMarkup(React.createElement(StaticRouter, null, React.createElement(AuthProvider, null, React.createElement(SharedCashier))))
    values.set('mypimes_shared_device_v1', JSON.stringify(record))
    const continuous = render()
    assert.match(continuous, /Mostrador central/)
    assert.match(continuous, /Caja continua/)
    assert.match(continuous, /Ana/)
    assert.match(continuous, /Bea/)
    assert.match(continuous, /Administración del dispositivo/)
    assert.doesNotMatch(continuous, /token-privado|hash-privado|ana@test.local/)
    record.device.continuous = false
    values.set('mypimes_shared_device_v1', JSON.stringify(record))
    assert.match(render(), /Caja por turno/)
  } finally { globalThis.BroadcastChannel = previousChannel; await vite.close() }
})
