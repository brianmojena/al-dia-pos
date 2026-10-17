// Ciclo offline de la caja compartida (PWA tablet): un solo inventario y un
// solo outbox para todos los cajeros del aparato. Sin red ni servidor: aqui se
// ejercita el motor local contra las mismas piezas que usa la app
// (sharedDevice.js instala/desbloquea, offlineModel.js proyecta y offlineClient.js
// enruta) usando el almacenamiento de memoria de los tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { records, resetStore } from './testSupport/memoryStore.js'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'idb-keyval') return { url: new URL('./testSupport/memoryStore.js', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
} })

const values = new Map()
globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) }
globalThis.window = new EventTarget()
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
globalThis.BroadcastChannel = undefined

const { installSharedDevice, unlockSharedCashier, lockSharedDevice } = await import('./sharedDevice.js')
const { registerFor, emptyData, prepareOperation } = await import('./offlineModel.js')
const { apiFetch } = await import('./api.js')
const { syncOffline, localSyncStatus } = await import('./offlineClient.js')
const { getRejected } = await import('./salesQueue.js')

const OWNER = 1
const CASHIER_A = 2
const CASHIER_B = 3
const TENANT = 'caja-tablet'
const SHARED_KEY = `mypimes_shared_v1:${OWNER}:${TENANT}`
const future = () => new Date(Date.now() + 86_400_000).toISOString()

const tokenFor = (accountId) => `x.${Buffer.from(JSON.stringify({
  userId: OWNER, accountId, role: 'cajero', deviceId: TENANT, deviceVersion: 1,
  exp: Math.floor(Date.now() / 1000) + 86_400,
})).toString('base64')}.x`
const TOKEN_A = tokenFor(CASHIER_A)
const TOKEN_B = tokenFor(CASHIER_B)
const memberFor = (id, email, displayName) => {
  const token = id === CASHIER_A ? TOKEN_A : TOKEN_B
  return { id, email, display_name: displayName, token, user: { id, email, role: 'cajero', display_name: displayName, is_admin: false } }
}
const bundleFor = (continuous = true) => ({
  device: { id: TENANT, owner_id: OWNER, name: 'Mostrador', continuous, expires_at: future() },
  cashiers: [
    memberFor(CASHIER_A, 'a@test.local', 'Ana'),
    memberFor(CASHIER_B, 'b@test.local', 'Bea'),
  ],
})
const deviceFor = (continuous) => ({ id: TENANT, owner_id: OWNER, name: 'Mostrador', continuous, expires_at: future() })
const seedShared = (device, products = [{ id: 10, name: 'Pan', stock: 20, sale_price: 10, purchase_price: 6 }]) =>
  records.set(SHARED_KEY, { base: { ...emptyData(), shared_device: device, products }, outbox: [], nextId: -1, initialized: true })
const installAndOpen = async (continuous, cashierId, pin) => {
  await installSharedDevice(bundleFor(continuous), { [CASHIER_A]: '123456', [CASHIER_B]: '654321' })
  await unlockSharedCashier(cashierId, pin)
}

const read = async (path) => {
  const res = await apiFetch(path)
  assert.ok(res.ok, `${path}: ${res.status}`)
  return res.json()
}
const write = async (path, body) => {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
  const value = await res.json()
  assert.ok(res.ok, `${path}: ${res.status} ${JSON.stringify(value)}`)
  return value
}
const saleBody = (id, quantity = 1) => ({ client_sale_id: id, payment_method: 'efectivo', items: [{ product_id: 10, quantity, unit_price: 10 }] })
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('registerFor usa la caja compartida y deja intacto el registro web normal', () => {
  assert.equal(registerFor('1:5'), 'web:5')
  assert.equal(registerFor('1:5', { id: TENANT, continuous: true }), `shared:${TENANT}`)
  assert.equal(registerFor('1:5', { id: TENANT, continuous: false }), `shared:${TENANT}:5`)
})

test('el cierre continuo agrupa a todos los actores y nunca absorbe otro registro', () => {
  const device = deviceFor(true)
  const data = {
    ...emptyData(),
    shared_device: device,
    cash_close_coverage_version: 1,
    sales: [
      { id: 1, client_sale_id: 'a', account_id: CASHIER_A, register_id: `shared:${TENANT}`, cash_close_id: null, total: 100, payment_method: 'efectivo', created_at: '2026-10-14T10:00:00Z' },
      { id: 2, client_sale_id: 'b', account_id: CASHIER_B, register_id: `shared:${TENANT}`, cash_close_id: null, total: 100, payment_method: 'efectivo', created_at: '2026-10-14T10:01:00Z' },
      { id: 3, client_sale_id: 'ajena', account_id: CASHIER_A, register_id: 'shared:otra-caja', cash_close_id: null, total: 999, payment_method: 'efectivo', created_at: '2026-10-14T10:02:00Z' },
      { id: 4, client_sale_id: 'legacy', account_id: CASHIER_A, register_id: null, cash_close_id: null, total: 888, payment_method: 'efectivo', created_at: '2026-10-14T10:03:00Z' },
    ],
    cash_withdrawals: [{ id: 90, method: 'efectivo', amount: 50, cash_close_id: null, voided_at: null, register_id: 'web:1' }],
  }
  const op = prepareOperation(data, 'POST', '/api/cash-closes',
    { client_close_id: 'close-continuo', opening_float: 0, counted_cash: 150 },
    { account: `1:${CASHIER_A}`, user: { role: 'cajero', email: 'a@test.local' }, newId: () => 'op-close-c', localId: () => -1 })
  assert.deepEqual(op.saleIds, [1, 2], 'A y B quedan cubiertos por el mismo cierre')
  assert.equal(op.result.register_id, `shared:${TENANT}`)
  assert.equal(op.body.register_id, `shared:${TENANT}`)
  assert.equal(op.result.sales_count, 2)
  assert.ok(op.withdrawalIds.includes(90), 'la extraccion del dueño entra en el cierre compartido')
})

test('el cierre no continuo cubre solo al actor activo y su registro', () => {
  const device = deviceFor(false)
  const data = {
    ...emptyData(),
    shared_device: device,
    cash_close_coverage_version: 1,
    sales: [
      { id: 1, client_sale_id: 'a', account_id: CASHIER_A, register_id: `shared:${TENANT}:${CASHIER_A}`, cash_close_id: null, total: 100, payment_method: 'efectivo', created_at: '2026-10-14T10:00:00Z' },
      { id: 2, client_sale_id: 'b', account_id: CASHIER_B, register_id: `shared:${TENANT}:${CASHIER_B}`, cash_close_id: null, total: 100, payment_method: 'efectivo', created_at: '2026-10-14T10:01:00Z' },
      { id: 3, client_sale_id: 'legacy', account_id: CASHIER_A, register_id: null, cash_close_id: null, total: 888, payment_method: 'efectivo', created_at: '2026-10-14T10:02:00Z' },
      { id: 4, client_sale_id: 'ajena', account_id: CASHIER_A, register_id: 'shared:otra-caja', cash_close_id: null, total: 777, payment_method: 'efectivo', created_at: '2026-10-14T10:03:00Z' },
    ],
    cash_withdrawals: [],
  }
  const op = prepareOperation(data, 'POST', '/api/cash-closes',
    { client_close_id: 'close-turno-a', opening_float: 0, counted_cash: 100 },
    { account: `1:${CASHIER_A}`, user: { role: 'cajero', email: 'a@test.local' }, newId: () => 'op-close-a', localId: () => -1 })
  assert.deepEqual(op.saleIds, [1], 'solo el turno de A')
  assert.equal(op.result.register_id, `shared:${TENANT}:${CASHIER_A}`)
  assert.equal(op.result.sales_count, 1)
})

test('A vende sin conexion, B ve el stock al instante y cada recibo sube con su token', async () => {
  resetStore(); values.clear(); navigator.onLine = false
  const device = deviceFor(true)
  await installAndOpen(true, CASHIER_A, '123456')
  seedShared(device)
  globalThis.fetch = () => { throw new Error('sin red no debe tocar la red') }

  const saved = await write('/api/sales', saleBody('shared-a-1', 2))
  assert.equal(saved.pending, true)
  const stored = records.get(SHARED_KEY)
  assert.equal(stored.outbox.length, 1)
  assert.equal(stored.outbox[0].account_key, `1:${CASHIER_A}`, 'la venta congela a su actor')
  assert.equal(stored.outbox[0].result.register_id, `shared:${TENANT}`)
  assert.equal((await read('/api/products'))[0].stock, 18)

  lockSharedDevice()
  await unlockSharedCashier(CASHIER_B, '654321')
  assert.equal((await read('/api/products'))[0].stock, 18, 'B ve el mismo inventario que descontó A')
  assert.equal((await read('/api/sales')).length, 0, 'B no ve el historial personal de A')
  assert.equal((await write('/api/sales', saleBody('shared-b-1', 1))).pending, true)
  assert.equal((await read('/api/products'))[0].stock, 17)
  assert.equal((await read('/api/cash-closes/current?register_id=web')).has_sales, true)

  navigator.onLine = true
  const tokens = []
  const registers = []
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/sales') {
      tokens.push(options.headers.Authorization)
      const body = JSON.parse(options.body)
      registers.push(body.register_id)
      return jsonResponse({ id: body.client_sale_id === 'shared-a-1' ? 61 : 62, client_sale_id: body.client_sale_id, pending: false })
    }
    assert.equal(path, '/api/sync/snapshot')
    return jsonResponse({ ...emptyData(), shared_device: device, products: [{ id: 10, name: 'Pan', stock: 17, sale_price: 10, purchase_price: 6 }], sales: [] })
  }
  await syncOffline()
  assert.equal((await localSyncStatus()).pending, 0)
  assert.deepEqual(tokens, [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`], 'cada recibo sube con el token del cajero que lo cobró')
  assert.deepEqual(registers, [`shared:${TENANT}`, `shared:${TENANT}`], 'el registro enviado es el de la caja, no "web"')
  assert.equal(records.get(SHARED_KEY).base.products[0].stock, 17)
})

test('un 403 conserva el recibo y lo reporta con el autor original aunque B esté activo', async () => {
  resetStore(); values.clear(); navigator.onLine = false
  const device = deviceFor(true)
  await installAndOpen(true, CASHIER_A, '123456')
  seedShared(device)
  await write('/api/sales', saleBody('shared-a-403', 1))
  lockSharedDevice()
  await unlockSharedCashier(CASHIER_B, '654321')
  navigator.onLine = true
  const saleTokens = []
  let reportToken = null
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/sales') { saleTokens.push(options.headers.Authorization); return jsonResponse({ error: 'La caja no admite esta venta', code: 'SALE_REJECTED' }, 403) }
    if (path === '/api/sales/rejected') { reportToken = options.headers.Authorization; return jsonResponse({ id: 1 }) }
    assert.equal(path, '/api/sync/snapshot')
    return jsonResponse({ ...emptyData(), shared_device: device })
  }
  await syncOffline()
  assert.equal((await localSyncStatus()).pending, 0)
  assert.deepEqual(saleTokens, [`Bearer ${TOKEN_A}`], 'el intento de subida usa la credencial de A')
  assert.equal(reportToken, `Bearer ${TOKEN_A}`, 'el aviso de rechazo también va con el token de A')
  const rejected = records.get('mypimes_rejected_sales')
  assert.equal(rejected.length, 1, 'el recibo cobrado no se pierde')
  assert.equal(rejected[0].account_key, `1:${CASHIER_A}`)
  assert.equal(rejected[0].shared_device_id, TENANT)
  assert.equal(rejected[0].reported, true)
  assert.equal((await getRejected()).length, 1, 'B puede ver el recibo rechazado de A')
})

test('una credencial revocada deja la operación guardada y bloqueada, sin reasignarla', async () => {
  resetStore(); values.clear(); navigator.onLine = false
  const device = deviceFor(true)
  await installAndOpen(true, CASHIER_A, '123456')
  seedShared(device)
  await write('/api/sales', saleBody('shared-a-revoked', 1))
  lockSharedDevice()
  await unlockSharedCashier(CASHIER_B, '654321')
  navigator.onLine = true
  globalThis.fetch = async (path) => {
    if (path === '/api/sales') return jsonResponse({ error: 'Acceso retirado', code: 'MEMBER_REVOKED' }, 403)
    assert.fail(`no debería llamar a ${path} tras revocar`)
  }
  await syncOffline()
  const state = records.get(SHARED_KEY)
  assert.equal(state.outbox.length, 1, 'la operación sigue guardada, no se destruye')
  assert.equal(state.outbox[0].account_key, `1:${CASHIER_A}`, 'no se reasigna al cajero activo')
  assert.equal((await localSyncStatus()).pending, 1)
  assert.match((await localSyncStatus()).error, /retirado/i)
  assert.equal((records.get('mypimes_rejected_sales') || []).length, 0, 'no se marca como rechazada definitiva')
})
