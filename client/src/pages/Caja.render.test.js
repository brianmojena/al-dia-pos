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

test('Caja.jsx contiene la sección de salidas de efectivo', async () => {
  const fs = await import('fs')
  const path = await import('path')

  const filePath = path.resolve('src/pages/Caja.jsx')
  const content = fs.readFileSync(filePath, 'utf-8')

  // Verificar que se añadieron los elementos de salidas
  assert.match(content, /Dinero que sacaste de la caja/, 'debe contener el título de sección de salidas')
  assert.match(content, /Anotar salida de efectivo/, 'debe contener el botón para anotar salida')
  assert.match(content, /handleWithdrawalSubmit/, 'debe contener el manejador de envío de salida')
  assert.match(content, /handleVoidWithdrawal/, 'debe contener el manejador de anulación')
  assert.match(content, /Salidas anotadas:/, 'debe mostrar el total de salidas anotadas')
  assert.match(content, /!isOwner/, 'la sección solo debe mostrarse para cajeros, no dueños')
})
