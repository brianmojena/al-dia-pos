import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

/**
 * El lector de código de barras: en el servidor solo se pinta el esqueleto —
 * la cámara arranca en un efecto, del lado del navegador. Lo que debe estar
 * SIEMPRE, incluso sin cámara, es la entrada manual: cubre el permiso
 * denegado, el equipo sin cámara y el contexto no seguro (HTTP).
 */
test('lector de código de barras: esqueleto con entrada manual', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [reactPlugin()],
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  })
  try {
    const mod = await vite.ssrLoadModule('/src/components/BarcodeScanner.jsx')
    assert.equal(typeof mod.BarcodeScanner, 'function', 'exporta el componente con nombre')
    assert.equal(typeof mod.default, 'function', 'y como default para las páginas')

    const html = renderToStaticMarkup(React.createElement(mod.BarcodeScanner, {
      title: 'Escanear código del producto',
      onScan: () => {},
      onClose: () => {},
    }))

    assert.match(html, /Escanear código del producto/)
    assert.match(html, /Abriendo la cámara…/)
    assert.match(html, /Escribe el código a mano…/, 'la entrada manual está desde el primer render')
    assert.match(html, /aria-label="Código de barras a mano"/)
    assert.match(html, />Usar</, 'el botón de la entrada manual')
    assert.match(html, /aria-label="Cerrar"/)
    assert.match(html, /<video/, 'el hueco de la cámara está en el markup')

    // El texto de error sale cuando la cámara no puede abrirse; el estado
    // inicial es "abriendo", así que aún no aparece.
    assert.doesNotMatch(html, /Permiso de cámara denegado/)
  } finally {
    await vite.close()
  }
})
