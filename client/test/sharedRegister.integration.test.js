// Ejercita la PWA contra Express y SQLite reales, sin red externa ni puertos.
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
const { installSharedDevice, unlockSharedCashier, lockSharedDevice, hashPin } = await import('../src/lib/sharedDevice.js')
const { apiFetch } = await import('../src/lib/api.js')
const { syncOffline, localSyncStatus, sharedHandoverStatus, canReplaceSharedDevice } = await import('../src/lib/offlineClient.js')
const read = async (path) => {
  const res = await apiFetch(path)
  assert.ok(res.ok, `${path}: ${res.status} ${JSON.stringify(await res.clone().json())}`)
  return res.json()
}
const write = async (path, body) => {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
  const value = await res.json()
  assert.ok(res.ok, `${path}: ${res.status} ${JSON.stringify(value)}`)
  return value
}

test('caja compartida: relevo offline, SQLite real y respuesta perdida', async (t) => {
  process.env.MYPIMES_TEST_TRANSPORT = 'in-process'
  process.env.ADMIN_EMAILS = 'brianadmin@aldia.cu'
  const ctx = await startTestServer()
  const transport = globalThis.fetch
  let loseNextSaleResponse = false
  globalThis.fetch = async (url, options) => {
    assert.equal(navigator.onLine, true, 'el modo offline nunca debe hacer una petición')
    const result = await transport(String(url).startsWith('/api/') ? `${ctx.baseUrl}${url}` : url, options)
    if (loseNextSaleResponse && String(url) === '/api/sales' && options?.method === 'POST' && result.ok) {
      loseNextSaleResponse = false
      throw new TypeError('Respuesta perdida después de guardar la venta')
    }
    return result
  }
  t.after(() => ctx.close())
  resetStore()
  values.clear()
  const owner = await registerUser(ctx.api, 'shared-owner@test.local')
  // La administración ya no se obtiene registrando un correo de ADMIN_EMAILS:
  // la cuenta se crea normal y el privilegio se concede con el flag controlado.
  const admin = await registerUser(ctx.api, 'shared-admin@test.local')
  await ctx.db.execute({ sql: 'UPDATE users SET is_admin = 1 WHERE lower(email) = ?', args: ['shared-admin@test.local'] })
  const a = await createCashier(ctx.api, owner, { email: 'shared-a@test.local' })
  const b = await createCashier(ctx.api, owner, { email: 'shared-b@test.local' })
  const product = await createProduct(ctx.api, owner, { name: 'Pan compartido', stock: 10 })
  const ownerId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).userId
  const denied = await ctx.api('POST', '/api/admin/shared-devices', { token: owner, body: { owner_id: ownerId, name: 'No autorizado', cashiers: [{ id: a.id, display_name: 'Ana' }] } })
  assert.equal(denied.status, 403, 'solo administración puede preparar dispositivos')
  const enrollment = await ctx.api('POST', '/api/admin/shared-devices', {
    token: admin, body: { owner_id: ownerId, name: 'Mostrador', continuous: true, cashiers: [{ id: a.id, display_name: 'Ana' }, { id: b.id, display_name: 'Bea' }] },
  })
  assert.equal(enrollment.status, 201, JSON.stringify(enrollment.body))
  const withdrawal = await ctx.api('POST', '/api/cash-withdrawals', {
    token: owner, body: { client_withdrawal_id: 'owner-phone-withdrawal', method: 'efectivo', amount: 50, register_id: 'web' },
  })
  assert.equal(withdrawal.status, 201)
  await installSharedDevice(enrollment.body, { [a.id]: '123456', [b.id]: '654321' })
  await unlockSharedCashier(a.id, '123456')
  await syncOffline()
  assert.equal((await localSyncStatus()).initialized, true)
  const sale = (id, quantity) => ({ client_sale_id: id, payment_method: 'efectivo', items: [{ product_id: product, quantity, unit_price: 100 }] })
  let close

  await t.test('A vende, B ve el stock descontado y cierra el acumulado sin conexión', async () => {
    navigator.onLine = false
    await write('/api/sales', sale('shared-a-1', 2))
    lockSharedDevice()
    await unlockSharedCashier(b.id, '654321')
    assert.equal((await read('/api/products'))[0].stock, 8)
    assert.equal((await read('/api/sales')).length, 0, 'B no ve el historial personal de A')
    await write('/api/sales', sale('shared-b-1', 1))
    assert.equal((await read('/api/products'))[0].stock, 7)
    assert.equal((await read('/api/cash-closes/current?register_id=web')).has_sales, true)
    close = await write('/api/cash-closes', { client_close_id: 'shared-close-1', counted_cash: 250, opening_float: 0 })
    assert.equal(Number(close.sales_count), 2)
    assert.equal(Number(close.expected_cash), 250, 'se descuenta la extracción del dueño desde su teléfono')
    await unlockSharedCashier(a.id, '123456')
    await write('/api/sales', sale('shared-a-after-close', 1))
    assert.equal((await read('/api/products'))[0].stock, 6)
  })

  await t.test('reconectar conserva autores y el cierre no absorbe ventas posteriores', async () => {
    navigator.onLine = true
    await syncOffline()
    const status = await localSyncStatus()
    assert.equal(status.pending, 0, status.error)
    const sales = (await ctx.db.execute('SELECT * FROM sales ORDER BY id')).rows
    assert.deepEqual(sales.map((s) => Number(s.account_id)), [a.id, b.id, a.id])
    const closes = (await ctx.db.execute('SELECT * FROM cash_closes')).rows
    assert.equal(closes.length, 1)
    assert.equal(Number(closes[0].account_id), b.id)
    assert.equal(Number(closes[0].expected_cash), 250)
    assert.equal(Number(closes[0].withdrawn_cash), 50)
    assert.equal(Number(closes[0].sales_count), 2)
    const summary = await ctx.api('GET', '/api/cash-closes/summary', { token: owner })
    assert.equal(summary.body[0].attribution, 'register')
    assert.equal(summary.body[0].account_id, null, 'el descuadre compartido no se atribuye al último cajero')
    assert.equal(Number(sales[0].cash_close_id), Number(closes[0].id))
    assert.equal(Number(sales[1].cash_close_id), Number(closes[0].id))
    assert.equal(sales[2].cash_close_id, null)
    assert.equal((await read('/api/products'))[0].stock, 6)
  })

  await t.test('un recibo cuya respuesta se pierde se reintenta sin descontar dos veces', async () => {
    navigator.onLine = false
    await write('/api/sales', sale('shared-lost-response', 1))
    loseNextSaleResponse = true
    navigator.onLine = true
    await syncOffline()
    assert.equal((await localSyncStatus()).pending, 1)
    await unlockSharedCashier(b.id, '654321')
    await syncOffline()
    assert.equal((await localSyncStatus()).pending, 0)
    const saved = (await ctx.db.execute({ sql: 'SELECT * FROM sales WHERE client_sale_id = ?', args: ['shared-lost-response'] })).rows
    assert.equal(saved.length, 1)
    assert.equal(Number(saved[0].account_id), a.id)
    assert.equal((await read('/api/products'))[0].stock, 5)
  })

  await t.test('sin caja continua el stock se comparte pero cada cierre cubre solo a su cajero', async () => {
    const perTurn = await ctx.api('POST', '/api/admin/shared-devices', {
      token: admin, body: { owner_id: ownerId, name: 'Caja por turno', continuous: false, cashiers: [{ id: a.id, display_name: 'Ana' }, { id: b.id, display_name: 'Bea' }] },
    })
    assert.equal(perTurn.status, 201, JSON.stringify(perTurn.body))
    await installSharedDevice(perTurn.body, { [a.id]: '123456', [b.id]: '654321' })
    await unlockSharedCashier(a.id, '123456')
    await syncOffline()
    navigator.onLine = false
    await write('/api/sales', sale('turn-a-1', 1))
    assert.equal((await sharedHandoverStatus()).hasOpenOperations, true)
    assert.equal((await canReplaceSharedDevice()).allowed, false, 'la instalación no se reemplaza con recibos pendientes')
    // Ejercitar el motor directamente permite comprobar aislamiento incluso
    // cuando la interfaz normalmente exige cerrar antes de este relevo.
    await unlockSharedCashier(b.id, '654321')
    assert.equal((await read('/api/products'))[0].stock, 4)
    await write('/api/sales', sale('turn-b-1', 1))
    const bClose = await write('/api/cash-closes', { client_close_id: 'turn-b-close', counted_cash: 100, opening_float: 0 })
    assert.equal(Number(bClose.sales_count), 1)
    assert.equal(Number(bClose.expected_cash), 100)
    await unlockSharedCashier(a.id, '123456')
    assert.equal((await read('/api/cash-closes/current?register_id=web')).has_sales, true)
    await write('/api/cash-closes', { client_close_id: 'turn-a-close', counted_cash: 100, opening_float: 0 })
    assert.equal((await sharedHandoverStatus()).hasOpenOperations, false, 'un cierre guardado permite el relevo sin esperar la red')
    navigator.onLine = true
    await syncOffline()
    const status = await localSyncStatus()
    assert.equal(status.pending, 0, status.error)
    const aSale = (await ctx.db.execute({ sql: 'SELECT * FROM sales WHERE client_sale_id = ?', args: ['turn-a-1'] })).rows[0]
    const bSale = (await ctx.db.execute({ sql: 'SELECT * FROM sales WHERE client_sale_id = ?', args: ['turn-b-1'] })).rows[0]
    assert.notEqual(aSale.cash_close_id, bSale.cash_close_id)
    assert.notEqual(aSale.register_id, bSale.register_id)
    assert.equal((await read('/api/products'))[0].stock, 3)
    assert.equal((await canReplaceSharedDevice()).allowed, true)
  })

  await t.test('activar con un código remoto instala el PIN ya cifrado sin teclearlo', async () => {
    navigator.onLine = true
    assert.equal((await canReplaceSharedDevice()).allowed, true)
    // El administrador cifra el PIN en su navegador y pide un código de un solo uso.
    const created = await ctx.api('POST', '/api/admin/shared-devices', {
      token: admin,
      body: {
        owner_id: ownerId, name: 'Tablet remota', continuous: true, enroll: true,
        cashiers: [{ id: a.id, display_name: 'Ana', pin: await hashPin('123456') }],
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.match(created.body.code, /^[0-9A-Z]{12}$/)

    // El aparato destino canjea el código (sin sesión) e instala con el PIN cifrado.
    const redeemed = await ctx.api('POST', '/api/shared', { body: { code: created.body.code } })
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body))
    assert.ok(redeemed.body.cashiers[0].pin?.hash, 'el bundle trae el PIN cifrado')
    await installSharedDevice(redeemed.body)
    await unlockSharedCashier(a.id, '123456')
    await syncOffline()
    assert.equal((await localSyncStatus()).initialized, true)
    const before = (await read('/api/products'))[0].stock
    await write('/api/sales', sale('remote-1', 1))
    assert.equal((await read('/api/products'))[0].stock, before - 1)
    await syncOffline()
    assert.equal((await localSyncStatus()).pending, 0, 'la venta remota se sube antes de seguir')
    assert.equal((await ctx.api('POST', '/api/shared', { body: { code: created.body.code } })).status, 404, 'el código no se reutiliza')
  })

  await t.test('revocar el dispositivo conserva los recibos offline y bloquea nuevos cobros', async () => {
    navigator.onLine = false
    await write('/api/sales', sale('receipt-before-revocation', 1))
    navigator.onLine = true
    const { getSharedDevice } = await import('../src/lib/sharedDevice.js')
    const revoked = await ctx.api('DELETE', `/api/admin/shared-devices/${getSharedDevice().id}`, { token: admin })
    assert.equal(revoked.status, 200)
    await syncOffline()
    const status = await localSyncStatus()
    assert.equal(status.pending, 1)
    assert.match(status.error, /retirado/)
    const refused = await apiFetch('/api/sales', { method: 'POST', body: JSON.stringify(sale('after-revocation', 1)) })
    assert.equal(refused.status, 423)
    const saved = await ctx.db.execute({ sql: 'SELECT id FROM sales WHERE client_sale_id = ?', args: ['receipt-before-revocation'] })
    assert.equal(saved.rows.length, 0, 'el servidor no recibe operaciones de una caja retirada')
  })
})
