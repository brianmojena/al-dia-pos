// Regresión de la incidencia: el dueño cierra ventas ya descargadas por un
// cajero, que además tiene un cobro nuevo guardado sin conexión.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { resetStore } from '../src/lib/testSupport/memoryStore.js'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'idb-keyval') return { url: new URL('../src/lib/testSupport/memoryStore.js', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
} })
const values = new Map()
globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) }
globalThis.window = new EventTarget()
globalThis.BroadcastChannel = undefined
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
const require = createRequire(import.meta.url)
const { startTestServer, registerUser, createCashier, createProduct } = require('../../server/test/helpers.js')
const { apiFetch, setToken } = await import('../src/lib/api.js')
const { cacheUser } = await import('../src/lib/offlineCache.js')
const { syncOffline, localSyncStatus } = await import('../src/lib/offlineClient.js')

test('cierre consolidado del dueño actualiza la PWA del cajero sin perder el cobro offline posterior', async (t) => {
  process.env.MYPIMES_TEST_TRANSPORT = 'in-process'
  const ctx = await startTestServer()
  const transport = globalThis.fetch
  globalThis.fetch = (url, options) => {
    assert.equal(navigator.onLine, true, 'una operación offline debe guardarse sin red')
    return transport(String(url).startsWith('/api/') ? `${ctx.baseUrl}${url}` : url, options)
  }
  t.after(async () => { globalThis.fetch = transport; await ctx.close() })
  resetStore()
  values.clear()
  const owner = await registerUser(ctx.api)
  const cashier = await createCashier(ctx.api, owner)
  const product = await createProduct(ctx.api, owner, { stock: 10, sale_price: 100 })
  const saleBody = (id) => ({ client_sale_id: id, register_id: 'web', payment_method: 'efectivo', items: [{ product_id: product, quantity: 1, unit_price: 100 }] })
  for (const id of ['cached-before-owner-1', 'cached-before-owner-2']) {
    assert.equal((await ctx.api('POST', '/api/sales', { token: cashier.token, body: saleBody(id) })).status, 201)
  }
  setToken(cashier.token)
  cacheUser({ id: cashier.id, email: cashier.email, role: 'cajero' })
  await syncOffline()
  assert.equal((await localSyncStatus()).initialized, true)
  const localRead = async (path) => {
    const response = await apiFetch(path)
    assert.ok(response.ok, `${path}: ${response.status}`)
    return response.json()
  }
  assert.equal((await localRead('/api/sales')).filter((s) => s.cash_close_id == null).length, 2)

  const consolidated = await ctx.api('POST', '/api/cash-closes', {
    token: owner, body: { client_close_id: 'owner-consolidated', register_id: 'web', opening_float: 0, counted_cash: 200 },
  })
  assert.equal(consolidated.status, 201, JSON.stringify(consolidated.body))
  assert.equal(Number(consolidated.body.difference), 0)

  navigator.onLine = false
  const pending = await apiFetch('/api/sales', { method: 'POST', body: JSON.stringify(saleBody('offline-after-owner-close')) })
  assert.equal(pending.status, 202)
  assert.equal((await localSyncStatus()).pending, 1)
  navigator.onLine = true
  await syncOffline()
  assert.equal((await localSyncStatus()).pending, 0, (await localSyncStatus()).error)
  const rows = await localRead('/api/sales')
  assert.deepEqual(rows.filter((s) => s.cash_close_id == null).map((s) => s.client_sale_id), ['offline-after-owner-close'])
  assert.equal(rows.filter((s) => s.cash_close_id != null).length, 2)
  assert.deepEqual(await localRead('/api/cash-closes'), [], 'el cajero no recibe el conteo ni los totales del cierre del dueño')

  const ownClose = await apiFetch('/api/cash-closes', { method: 'POST', body: JSON.stringify({ client_close_id: 'cashier-after-owner', register_id: 'web', opening_float: 0, counted_cash: 100 }) })
  assert.equal(ownClose.status, 202)
  const provisional = await ownClose.json()
  assert.equal(Number(provisional.expected_cash), 100)
  assert.equal(Number(provisional.sales_count), 1)
  await syncOffline()
  assert.equal((await localSyncStatus()).pending, 0, (await localSyncStatus()).error)
  const saved = (await ctx.db.execute({ sql: 'SELECT * FROM cash_closes WHERE client_close_id = ?', args: ['cashier-after-owner'] })).rows[0]
  assert.equal(Number(saved.sales_count), 1)
  assert.equal(Number(saved.difference), 0)
  assert.equal((await ctx.db.execute('SELECT COUNT(*) AS n FROM sales')).rows[0].n, 3, 'cada cobro se guarda una sola vez')
})
