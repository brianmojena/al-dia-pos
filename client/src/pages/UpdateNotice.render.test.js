import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

test('aviso de actualización: horario de Cuba, alcance real y recuerdo por cuenta', async () => {
  const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false }, logLevel: 'silent' })
  const previousStorage = globalThis.localStorage
  try {
    const { default: Notice, UpdateNoticeContent, UPDATE_AT } = await vite.ssrLoadModule('/src/components/UpdateNotice.jsx')
    assert.equal(new Date(UPDATE_AT).toISOString(), '2026-11-14T06:00:00.000Z')
    const html = renderToStaticMarkup(createElement(UpdateNoticeContent, { upcoming: true }))
    for (const text of ['Próxima actualización', '14 de noviembre a la 1:00 a. m.', 'hora de Cuba', 'reservas', 'Desde Productos', 'Enterprise', 'sin conexión', 'Seguir trabajando']) assert.ok(html.includes(text), text)
    assert.match(html, /role="dialog"/)
    assert.match(html, /aria-modal="true"/)
    const released = renderToStaticMarkup(createElement(UpdateNoticeContent, { upcoming: false }))
    assert.match(released, /Novedades de Al Día/)
    assert.doesNotMatch(released, /Prevista para/)
    globalThis.localStorage = { getItem: (key) => key.endsWith(':7') ? 'seen' : null }
    assert.equal(renderToStaticMarkup(createElement(Notice, { userId: 7 })), '')
    assert.match(renderToStaticMarkup(createElement(Notice, { userId: 8 })), /role="dialog"/)
    globalThis.localStorage = { getItem() { throw new Error('Storage blocked') } }
    assert.match(renderToStaticMarkup(createElement(Notice, { userId: 7 })), /role="dialog"/)
  } finally {
    globalThis.localStorage = previousStorage
    await vite.close()
  }
})
