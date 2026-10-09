import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { records, resetStore, failWrites } from './testSupport/memoryStore.js'
import { emptyData } from './offlineModel.js'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'idb-keyval') return { url: new URL('./testSupport/memoryStore.js', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
} })
const values = new Map()
globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) }
globalThis.window = new EventTarget()
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
globalThis.BroadcastChannel = undefined
const { apiFetch, setToken } = await import('./api.js')
const { cacheUser } = await import('./offlineCache.js')
const { syncOffline, localSyncStatus, retrySync, resolveProductConflict } = await import('./offlineClient.js')
const tokenFor = (shop, account = shop) => `x.${Buffer.from(JSON.stringify({ userId: shop, accountId: account })).toString('base64url')}.x`
const login = (shop) => { setToken(tokenFor(shop)); cacheUser({ id: shop, email: `${shop}@test.local`, role: 'dueño', transfer_limit: null }) }
const stateKey = (shop) => `mypimes_local_v1:${shop}:${shop}`
const seed = (shop = 1) => records.set(stateKey(shop), { base: { ...emptyData(), products: [{ id: 10, name: `Pan ${shop}`, stock: 20, sale_price: 10, purchase_price: 6 }] }, outbox: [], initialized: true, nextId: -1 })
const write = (path, body, method = 'POST') => apiFetch(path, { method, body: JSON.stringify(body) })
const saleBody = (id = 'sale-1') => ({ client_sale_id: id, payment_method: 'efectivo', items: [{ product_id: 10, quantity: 2, unit_price: 10 }] })
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('ciclo real del cliente: guardar, reabrir, sincronizar y recuperarse de fallos', async (t) => {
  await t.test('sin red todas las lecturas y ventas usan solo almacenamiento local', async () => {
    resetStore(); login(1); seed(); navigator.onLine = false
    globalThis.fetch = () => { throw new Error('Nunca debe tocar la red') }
    const res = await write('/api/sales', saleBody()); assert.equal(res.status, 202)
    assert.equal((await localSyncStatus()).pending, 1)
    assert.equal((await (await apiFetch('/api/products')).json())[0].stock, 18)
    assert.equal((await (await apiFetch('/api/dashboard')).json()).today.sales, 20)
    assert.equal((await (await apiFetch('/api/reports/days')).json()).totals.sales_count, 1)
    // Reimportar el cliente equivale a cerrar/reabrir; la memoria de UI no participa.
    const reopened = await import('./offlineClient.js?reopened')
    assert.equal((await (await reopened.offlineRequest('/api/sales')).json()).length, 1)
  })
  await t.test('un 5xx o respuesta perdida conserva la operación hasta el reintento exitoso', async () => {
    navigator.onLine = true
    globalThis.fetch = async () => jsonResponse({ error: 'Servidor caído' }, 503)
    await syncOffline(); assert.equal((await localSyncStatus()).pending, 1)
    let saleCalls = 0
    globalThis.fetch = async (path) => {
      if (path === '/api/sales') { saleCalls++; throw new TypeError('Respuesta perdida') }
      throw new Error('No descargar snapshot mientras haya una respuesta desconocida')
    }
    await syncOffline(); assert.equal((await localSyncStatus()).pending, 1); assert.equal(saleCalls, 1)
    const pending = records.get(stateKey(1)).outbox[0]
    const remote = { ...pending.result, id: 25, pending: false }
    globalThis.fetch = async (path, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${tokenFor(1)}`)
      if (path === '/api/sales') { assert.equal(JSON.parse(options.body).client_sale_id, 'sale-1'); return jsonResponse(remote) }
      assert.equal(path, '/api/sync/snapshot')
      return jsonResponse({ ...emptyData(), products: [{ id: 10, name: 'Pan 1', stock: 18, sale_price: 10, purchase_price: 6 }], sales: [remote] })
    }
    await syncOffline(); assert.equal((await localSyncStatus()).pending, 0)
    assert.equal((await (await apiFetch('/api/products')).json())[0].stock, 18)
    assert.equal((await (await apiFetch('/api/sales')).json()).length, 1)
  })
  await t.test('las cuentas no ven ni suben cambios de otra tienda', async () => {
    navigator.onLine = false
    await write('/api/sales', saleBody('only-shop-1'))
    login(2); seed(2)
    assert.equal((await localSyncStatus()).pending, 0)
    assert.equal((await localSyncStatus()).otherAccounts, 1)
    assert.equal((await (await apiFetch('/api/products')).json())[0].name, 'Pan 2')
    assert.equal((await (await apiFetch('/api/sales')).json()).length, 0)
    navigator.onLine = true
    globalThis.fetch = async (path) => { assert.equal(path, '/api/sync/snapshot'); return jsonResponse(records.get(stateKey(2)).base) }
    await syncOffline(); assert.equal(records.get(stateKey(1)).outbox.length, 1)
  })
  await t.test('fallo de almacenamiento devuelve error y no presenta una venta como guardada', async () => {
    login(1); navigator.onLine = false
    const before = records.get(stateKey(1)).outbox.length
    failWrites(new DOMException('Full', 'QuotaExceededError'))
    const res = await write('/api/sales', saleBody('not-saved'))
    assert.equal(res.status, 507); assert.match((await res.json()).error, /Libera espacio/)
    failWrites(null); assert.equal(records.get(stateKey(1)).outbox.length, before)
  })
  await t.test('importación local es atómica si alguna fila es inválida', async () => {
    const before = records.get(stateKey(1)).outbox.length
    const res = await write('/api/products/import', { items: [{ name: 'Leche', sale_price: 10, stock: 3 }, { name: '', sale_price: 5, stock: -1 }] })
    assert.equal(res.status, 400); assert.equal(records.get(stateKey(1)).outbox.length, before)
    assert.equal((await (await apiFetch('/api/products')).json()).length, 1)
  })
  await t.test('401 de sincronización permite seguir trabajando y conserva la sesión local', async () => {
    navigator.onLine = true; globalThis.fetch = async () => jsonResponse({}, 401)
    await syncOffline(); assert.equal(localStorage.getItem('mypimes_token'), tokenFor(1))
    navigator.onLine = false
    assert.equal((await apiFetch('/api/products')).status, 200)
    assert.match((await localSyncStatus()).error, /sesi[oó]n/)
  })
  await t.test('producto nuevo y venta usan el ID de nube incluso si el carrito guardó el ID local', async () => {
    resetStore(); seed(); login(1); navigator.onLine = false
    const product = await (await write('/api/products', { name: 'Leche', sale_price: 5, stock: 10 })).json()
    const negativeId = product.id
    navigator.onLine = true
    globalThis.fetch = async (path) => {
      if (path === '/api/sync/product-operation') return jsonResponse({ ...product, id: 60, pending: false })
      return jsonResponse({ ...emptyData(), products: [{ ...product, id: 60, pending: false }] })
    }
    await syncOffline(); navigator.onLine = false
    const sale = await write('/api/sales', { payment_method: 'efectivo', items: [{ product_id: negativeId, quantity: 1, unit_price: 5 }] })
    assert.equal(sale.status, 202)
    assert.equal(records.get(stateKey(1)).outbox[0].body.items[0].product_id, 60)
  })
  await t.test('ventas rechazadas se conservan y se avisa al dueño sin bloquear las siguientes', async () => {
    resetStore(); seed(); login(1); navigator.onLine = false
    await write('/api/sales', saleBody('rejected-sale'))
    await write('/api/sales', saleBody('accepted-sale'))
    const state = records.get(stateKey(1)), accepted = { ...state.outbox[1].result, id: 70 }
    navigator.onLine = true
    let reported = false
    globalThis.fetch = async (path, options) => {
      if (path === '/api/sales') return JSON.parse(options.body).client_sale_id === 'rejected-sale' ? jsonResponse({ error: 'Stock insuficiente' }, 409) : jsonResponse(accepted)
      if (path === '/api/sales/rejected') { reported = true; return jsonResponse({ id: 80 }) }
      return jsonResponse({ ...emptyData(), products: [{ id: 10, name: 'Pan', stock: 18, sale_price: 10, purchase_price: 6 }], sales: [accepted] })
    }
    await syncOffline(); assert.equal((await localSyncStatus()).pending, 0)
    assert.ok(reported); assert.equal(records.get('mypimes_rejected_sales')[0].reported, true)
    assert.equal(records.get('mypimes_rejected_sales')[0].items[0].product_name, 'Pan 1')
  })
  await t.test('conflicto de producto conserva el cambio y solo se reintenta al pedirlo', async () => {
    navigator.onLine = false
    await write('/api/products/10', { name: 'Pan', stock: 30, sale_price: 10, purchase_price: 6 }, 'PUT')
    navigator.onLine = true; let calls = 0
    globalThis.fetch = async () => { calls++; return jsonResponse({ error: 'Producto cambió' }, 409) }
    await syncOffline(); assert.equal((await localSyncStatus()).pending, 1); assert.equal((await localSyncStatus()).conflicts, 1)
    await syncOffline(); assert.equal(calls, 1)
    await retrySync(); assert.equal(calls, 2)
  })
  await t.test('dos cobros simultáneos validan el stock dentro de la escritura local atómica', async () => {
    resetStore(); seed(); login(1); navigator.onLine = false
    const body = (id) => ({ ...saleBody(id), items: [{ product_id: 10, quantity: 12, unit_price: 10 }] })
    const results = await Promise.all([write('/api/sales', body('concurrent-a')), write('/api/sales', body('concurrent-b'))])
    assert.deepEqual(results.map((r) => r.status).sort(), [202, 400])
    assert.equal((await (await apiFetch('/api/products')).json())[0].stock, 8)
    assert.equal((await localSyncStatus()).pending, 1)
  })
  await t.test('la primera alta local sigue disponible aunque aún no se descargó el snapshot inicial', async () => {
    resetStore(); login(1); navigator.onLine = false
    const res = await write('/api/products', { name: 'Primer producto', stock: 3, sale_price: 5 })
    assert.equal(res.status, 202)
    assert.equal((await (await apiFetch('/api/products')).json())[0].name, 'Primer producto')
    assert.equal((await apiFetch('/api/reports/days')).status, 200)
  })
  await t.test('migrar la cola anterior conserva ventas y separa las de otras cuentas', async () => {
    resetStore(); seed(); login(1); navigator.onLine = false
    records.set('mypimes_sales_queue', [{ ...saleBody('legacy-own'), account_key: '1:1', queued_at: Date.now() }, { ...saleBody('legacy-other'), account_key: '2:2', queued_at: Date.now() }])
    assert.equal((await (await apiFetch('/api/products')).json())[0].stock, 18)
    assert.equal(records.get('mypimes_sales_queue').length, 1)
    assert.equal(records.get('mypimes_sales_queue')[0].account_key, '2:2')
    await apiFetch('/api/products')
    assert.equal(records.get(stateKey(1)).outbox.length, 1)
  })
  await t.test('un cambio creado durante la descarga no se pierde al reemplazar la base', async () => {
    resetStore(); seed(); login(1); navigator.onLine = true
    let markStarted, release
    const started = new Promise((resolve) => { markStarted = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const snapshot = structuredClone(records.get(stateKey(1)).base)
    globalThis.fetch = async (path) => { assert.equal(path, '/api/sync/snapshot'); markStarted(); await gate; return jsonResponse(snapshot) }
    const sync = syncOffline(); await started
    navigator.onLine = false
    assert.equal((await write('/api/sales', saleBody('during-download'))).status, 202)
    release(); await sync
    assert.equal((await localSyncStatus()).pending, 1)
    assert.equal((await (await apiFetch('/api/products')).json())[0].stock, 18)
  })
  await t.test('cambiar de cuenta durante una subida mantiene el token y la confirmación en la cuenta original', async () => {
    resetStore(); seed(1); seed(2); login(1); navigator.onLine = false
    await write('/api/sales', saleBody('switch-account'))
    const op = records.get(stateKey(1)).outbox[0]
    let markStarted, release
    const started = new Promise((resolve) => { markStarted = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    navigator.onLine = true
    globalThis.fetch = async (path, options) => { assert.equal(path, '/api/sales'); assert.equal(options.headers.Authorization, `Bearer ${tokenFor(1)}`); markStarted(); await gate; return jsonResponse({ ...op.result, id: 99 }) }
    const sync = syncOffline(); await started; login(2); release(); await sync
    assert.equal(records.get(stateKey(1)).outbox.length, 0)
    assert.equal(records.get(stateKey(1)).base.sales[0].id, 99)
    assert.equal(records.get(stateKey(2)).base.sales.length, 0)
    navigator.onLine = false
    assert.equal((await (await apiFetch('/api/products')).json())[0].name, 'Pan 2')
  })
  await t.test('resolver un conflicto con datos de la nube conserva las operaciones posteriores', async () => {
    resetStore(); seed(); login(1); navigator.onLine = false
    await write('/api/products/10', { name: 'Pan local', stock: 30, sale_price: 10, purchase_price: 6 }, 'PUT')
    await write('/api/sales', saleBody('after-conflict'))
    navigator.onLine = true
    globalThis.fetch = async () => jsonResponse({ error: 'Producto cambió' }, 409)
    await syncOffline()
    const sale = records.get(stateKey(1)).outbox[1]
    let posts = 0
    globalThis.fetch = async (path) => {
      if (path === '/api/sales') { posts++; return jsonResponse({ ...sale.result, id: 101 }) }
      return jsonResponse({ ...emptyData(), products: [{ id: 10, name: 'Pan nube', stock: posts ? 13 : 15, purchase_price: 6, sale_price: 10 }], sales: posts ? [{ ...sale.result, id: 101 }] : [] })
    }
    await resolveProductConflict('cloud')
    assert.equal((await localSyncStatus()).pending, 0)
    assert.equal(records.get(stateKey(1)).resolved[0].resolution, 'cloud')
    assert.equal(posts, 1)
    assert.equal((await (await apiFetch('/api/products')).json())[0].stock, 13)
  })
  await t.test('resolver a favor del cambio local obtiene una precondición nueva antes de subir', async () => {
    resetStore(); seed(); login(1); navigator.onLine = false
    await write('/api/products/10', { name: 'Pan local', stock: 30, sale_price: 12, purchase_price: 6 }, 'PUT')
    navigator.onLine = true
    globalThis.fetch = async () => jsonResponse({ error: 'Producto cambió' }, 409)
    await syncOffline(); let uploaded = false
    globalThis.fetch = async (path, options) => {
      if (path === '/api/sync/product-operation') {
        const body = JSON.parse(options.body)
        assert.equal(body.expected.stock, 15); assert.equal(body.product.stock, 30)
        uploaded = true
        return jsonResponse({ ...body.product, id: 10 })
      }
      return jsonResponse({ ...emptyData(), products: [{ id: 10, name: uploaded ? 'Pan local' : 'Pan nube', stock: uploaded ? 30 : 15, sale_price: uploaded ? 12 : 10, purchase_price: 6 }] })
    }
    await resolveProductConflict('local')
    assert.ok(uploaded); assert.equal((await localSyncStatus()).pending, 0)
    assert.equal(records.get(stateKey(1)).resolved[0].resolution, 'local')
  })

})
