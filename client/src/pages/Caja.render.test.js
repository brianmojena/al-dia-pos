import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

test('el detalle confirmado de Caja renderiza su estado de carga real', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })

  const previousBroadcastChannel = globalThis.BroadcastChannel
  // offlineClient abre este canal al importarse; en la prueba de render no se
  // usa y mantenerlo vivo impediría que node --test finalice.
  globalThis.BroadcastChannel = undefined
  try {
    const { CashCloseDetail } = await vite.ssrLoadModule('/src/pages/Caja.jsx')
    const markup = renderToStaticMarkup(React.createElement(CashCloseDetail, {
      close: { id: 42, server_id: 42, pending: false, correction_revision: 0 },
      isOwner: true,
      onBack() {},
      onSaved() {},
    }))

    assert.match(markup, /Detalle del cierre/)
    assert.match(markup, /Cargando cierre/)
    assert.match(markup, /<svg/, 'el botón de volver debe renderizar su icono ArrowLeft')
  } finally {
    globalThis.BroadcastChannel = previousBroadcastChannel
    await vite.close()
  }
})
