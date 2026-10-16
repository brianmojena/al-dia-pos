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
const { syncOffline, localSyncStatus, retrySync, resolveProductConflict, handlesOffline, cacheCashCloseCorrection, refreshOfflineSnapshot } = await import('./offlineClient.js')
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
  await t.test('actualizar y reabrir la web del cajero conserva ventas pendientes y su precio original', async () => {
    resetStore(); seed(); navigator.onLine = false
    setToken(tokenFor(1, 2)); cacheUser({ id: 2, email: 'cajero@test.local', role: 'cajero' })
    const key = 'mypimes_local_v1:1:2'
    records.set(key, structuredClone(records.get(stateKey(1))))
    assert.equal((await write('/api/sales', saleBody('cashier-before-update'))).status, 202)
    assert.equal((await write('/api/products/10', { sale_price: 12.5 }, 'PUT')).status, 202)
    const stored = structuredClone(records.get(key))
    const updated = await import('./offlineClient.js?cashier-update')
    assert.equal((await updated.localSyncStatus()).pending, 2)
    assert.equal((await (await updated.offlineRequest('/api/products')).json())[0].stock, 18)
    assert.equal((await (await updated.offlineRequest('/api/products')).json())[0].sale_price, 12.5)
    assert.deepEqual(records.get(key), stored, 'la reapertura no cambia las operaciones guardadas')
    navigator.onLine = true
    const uploaded = []
    const remoteSale = { ...stored.outbox[0].result, id: 45, pending: false }
    const remoteProduct = { ...stored.outbox[1].result, pending: false }
    globalThis.fetch = async (path, options) => {
      if (path === '/api/sales') {
        const body = JSON.parse(options.body); uploaded.push(body)
        assert.equal(body.client_sale_id, 'cashier-before-update')
        assert.equal(body.items[0].unit_price, 10, 'el cambio de catálogo no altera una venta ya cobrada')
        return jsonResponse(remoteSale)
      }
      if (path === '/api/sync/product-operation') {
        assert.deepEqual(JSON.parse(options.body).product, { sale_price: 12.5 })
        return jsonResponse(remoteProduct)
      }
      assert.equal(path, '/api/sync/snapshot')
      return jsonResponse({ products: [remoteProduct], current_period: {} })
    }
    await updated.syncOffline()
    assert.equal((await updated.localSyncStatus()).pending, 0)
    assert.equal(uploaded.length, 1)
  })
  await t.test('cierre offline del cajero sincroniza IDs exactos y sustituye el resultado provisional', async () => {
    resetStore();
    setToken(tokenFor(1, 2));
    cacheUser({ id: 2, email: 'cajero@test.local', role: 'cajero' });
    navigator.onLine = false;
    const key = 'mypimes_local_v1:1:2';
    const syncedSale = { id: 51, client_sale_id: 'synced-before-count', account_id: 2,
      account_email: 'cajero@test.local', register_id: 'web:2', cash_close_id: null,
      total: 300, payment_method: 'efectivo', created_at: '2026-10-14 10:00:00',
      profit: 250, items: [{ id: 1, product_name: 'Pan', quantity: 1, unit_price: 300, unit_cost: 50 }] };
    records.set(key, { base: { ...emptyData(), cash_close_coverage_version: 1, products: [], sales: [syncedSale] }, outbox: [], initialized: true, nextId: -1 });
    const saved = await write('/api/cash-closes', { client_close_id: 'offline-cash-close', register_id: 'web', opening_float: 1000, counted_cash: 1300 });
    assert.equal(saved.status, 202);
    const provisional = await saved.json();
    assert.equal(provisional.expected_cash, 1300);
    assert.equal(provisional.difference, 0);
    assert.deepEqual(records.get(key).outbox[0].body.covered_sale_ids, [51]);

    navigator.onLine = true;
    const confirmed = { ...provisional, id: 80, pending: false, expected_cash: 1300, difference: 0, sales_count: 1 };
    const laterSale = { id: 52, client_sale_id: 'arrived-after-count', account_id: 2,
      account_email: 'cajero@test.local', register_id: 'web:2', cash_close_id: null,
      total: 75, payment_method: 'efectivo', created_at: '2026-10-14 10:05:00', items: [] };
    let uploadedCoverage;
    globalThis.fetch = async (path, options = {}) => {
      if (path === '/api/cash-closes') {
        uploadedCoverage = JSON.parse(options.body).covered_sale_ids;
        return jsonResponse(confirmed);
      }
      assert.equal(path, '/api/sync/snapshot');
      return jsonResponse({ ...emptyData(), cash_close_coverage_version: 1, sales: [{ ...syncedSale, cash_close_id: 80 }, laterSale], cash_closes: [confirmed], current_period: { has_sales: true } });
    };
    await syncOffline();
    assert.deepEqual(uploadedCoverage, [51], 'la venta llegada tras el conteo queda fuera del cierre');
    assert.equal((await localSyncStatus()).pending, 0);
    const history = await (await apiFetch('/api/cash-closes')).json();
    assert.equal(history[0].client_close_id, 'offline-cash-close');
    assert.equal(history[0].expected_cash, 1300, 'el historial reemplaza los importes provisionales por los confirmados');
    assert.equal(history[0].difference, 0);
  })
  await t.test('una caché antigua se refresca antes de enviar el cierre y conserva la respuesta confirmada', async () => {
    resetStore(); setToken(tokenFor(1, 2));
    cacheUser({ id: 2, email: 'cajero@test.local', role: 'cajero' });
    const key = 'mypimes_local_v1:1:2';
    records.set(key, { base: { ...emptyData(), current_period: { has_sales: true }, products: [], sales: [] }, outbox: [], initialized: true, nextId: -1 });
    navigator.onLine = false;
    const local = await write('/api/cash-closes', { client_close_id: 'legacy-cache-close', opening_float: 1000, counted_cash: 1300 });
    const provisional = await local.json();
    assert.equal(provisional.pending, true);
    assert.equal(provisional.coverage_incomplete, true);
    const stored = records.get(key).outbox[0];
    assert.equal(stored.coverageExact, false);
    assert.equal('covered_sale_ids' in stored.body, false);
    const localHistory = await (await apiFetch('/api/cash-closes')).json();
    assert.equal(localHistory[0].pending, true);
    assert.equal(localHistory[0].coverage_incomplete, true);

    const sale = { id: 51, client_sale_id: 'already-synced', account_id: 2, account_email: 'cajero@test.local', register_id: 'web:2', cash_close_id: null, total: 300, payment_method: 'efectivo', created_at: '2026-10-14 10:00:00' };
    const confirmed = { ...provisional, id: 81, expected_cash: 1300, difference: 0, sales_count: 1, pending: false, coverage_incomplete: false };
    navigator.onLine = true;
    let snapshots = 0, postedBody;
    globalThis.fetch = async (path, options = {}) => {
      if (path === '/api/cash-closes') {
        postedBody = JSON.parse(options.body);
        return jsonResponse(confirmed);
      }
      assert.equal(path, '/api/sync/snapshot');
      snapshots++;
      return jsonResponse({ ...emptyData(), cash_close_coverage_version: 1,
        sales: [{ ...sale, ...(snapshots > 1 ? { cash_close_id: 81 } : {}) }],
        cash_closes: snapshots > 1 ? [confirmed] : [], current_period: { has_sales: true } });
    };
    await syncOffline();
    assert.deepEqual(postedBody.covered_sale_ids, [51]);
    assert.ok(snapshots >= 2, 'descarga cobertura antes del POST y estado confirmado después');
    assert.equal((await localSyncStatus()).pending, 0, 'el outbox antiguo no queda bloqueado');
    const finalHistory = await (await apiFetch('/api/cash-closes')).json();
    assert.equal(finalHistory[0].pending, false);
    assert.equal(finalHistory[0].expected_cash, 1300);
    assert.equal(finalHistory[0].difference, 0);
  })
  await t.test('rehidratar cierres viejos respeta el corte UTC y no proyecta ventas posteriores de la cola', async () => {
    resetStore(); setToken(tokenFor(1, 2));
    cacheUser({ id: 2, email: 'cajero@test.local', role: 'cajero' });
    const key = 'mypimes_local_v1:1:2';
    records.set(key, { base: { ...emptyData(), current_period: { has_sales: true }, products: [{ id: 10, name: 'Pan', stock: 20, sale_price: 10, purchase_price: 6 }], sales: [] }, outbox: [], initialized: true, nextId: -1 });
    navigator.onLine = false;
    await write('/api/cash-closes', { client_close_id: 'legacy-close-one', opening_float: 1000, counted_cash: 1300 });
    const state = records.get(key), first = state.outbox[0];
    const firstAt = new Date(Date.now() - 5000).toISOString();
    first.body.closed_at = firstAt; first.result.closed_at = firstAt;
    await write('/api/sales', { ...saleBody('legacy-sale-b'), items: [{ product_id: 10, quantity: 1, unit_price: 75 }] });
    await write('/api/cash-closes', { client_close_id: 'legacy-close-two', counted_cash: 150 });
    assert.deepEqual(records.get(key).outbox.map((op) => op.kind), ['close', 'sale', 'close']);
    assert.equal(records.get(key).outbox[2].body.client_close_id, 'legacy-close-two');

    const saleA = { id: 51, client_sale_id: 'already-synced-a', account_id: 2, account_email: 'cajero@test.local', register_id: 'web:2', cash_close_id: null, total: 300, payment_method: 'efectivo', created_at: new Date(Date.parse(firstAt) - 60000).toISOString() };
    const saleFromOtherDevice = { id: 52, client_sale_id: 'other-device-after-count', account_id: 2, account_email: 'cajero@test.local', register_id: 'web:2', cash_close_id: null, total: 75, payment_method: 'efectivo', created_at: new Date(Date.parse(firstAt) + 1000).toISOString() };
    const saleBAt = records.get(key).outbox[1].body.sold_at;
    const closeOne = { id: 81, client_close_id: 'legacy-close-one', account_id: 2, account_email: 'cajero@test.local', closed_at: firstAt, expected_cash: 1300, counted_cash: 1300, difference: 0, pending: false, sales_count: 1 };
    const closeTwo = { id: 82, client_close_id: 'legacy-close-two', account_id: 2, account_email: 'cajero@test.local', expected_cash: 150, counted_cash: 150, difference: 0, pending: false, sales_count: 2 };
    navigator.onLine = true;
    let snapshotNumber = 0, firstCoverage, secondCoverage;
    globalThis.fetch = async (path, options = {}) => {
      if (path === '/api/cash-closes') {
        const body = JSON.parse(options.body);
        if (body.client_close_id === 'legacy-close-one') { firstCoverage = body.covered_sale_ids; return jsonResponse(closeOne); }
        secondCoverage = body.covered_sale_ids; return jsonResponse(closeTwo);
      }
      if (path === '/api/sales') {
        const body = JSON.parse(options.body);
        return jsonResponse({ ...body, id: 53, total: 75, created_at: body.sold_at, pending: false });
      }
      assert.equal(path, '/api/sync/snapshot');
      snapshotNumber++;
      if (snapshotNumber === 1) return jsonResponse({ ...emptyData(), cash_close_coverage_version: 1, products: [{ id: 10, name: 'Pan', stock: 18, sale_price: 10, purchase_price: 6 }], sales: [saleA, saleFromOtherDevice], current_period: { has_sales: true } });
      const saleB = { id: 53, client_sale_id: 'legacy-sale-b', account_id: 2, account_email: 'cajero@test.local', register_id: 'web:2', cash_close_id: null, total: 75, payment_method: 'efectivo', created_at: saleBAt };
      if (snapshotNumber === 2) return jsonResponse({ ...emptyData(), cash_close_coverage_version: 1, products: [{ id: 10, name: 'Pan', stock: 18, sale_price: 10, purchase_price: 6 }], sales: [{ ...saleA, cash_close_id: 81 }, saleFromOtherDevice, saleB], cash_closes: [closeOne], current_period: { has_sales: true } });
      const finalSales = [{ ...saleA, cash_close_id: 81 }, { ...saleFromOtherDevice, cash_close_id: 82 }, { ...saleB, cash_close_id: 82 }];
      return jsonResponse({ ...emptyData(), cash_close_coverage_version: 1, products: [{ id: 10, name: 'Pan', stock: 18, sale_price: 10, purchase_price: 6 }], sales: finalSales, cash_closes: [closeTwo, closeOne], current_period: { has_sales: false } });
    };
    await syncOffline();
    assert.deepEqual(firstCoverage, [51], 'el primer cierre incluye A y excluye la venta posterior de otro dispositivo');
    assert.deepEqual(secondCoverage, [52, 53], 'el segundo cierre cubre las ventas que quedaron después del primer corte');
    assert.equal((await localSyncStatus()).pending, 0, 'los cierres y dependencias posteriores conservan su orden y sincronizan');
    const history = await (await apiFetch('/api/cash-closes')).json();
    assert.equal(history.find((close) => close.client_close_id === 'legacy-close-one').difference, 0);
    assert.equal(history.find((close) => close.client_close_id === 'legacy-close-two').sales_count, 2);
  })
  await t.test('un 5xx o respuesta perdida conserva la operación hasta el reintento exitoso', async () => {
    resetStore(); login(1); seed(); navigator.onLine = false
    await write('/api/sales', saleBody())
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

test('la ruta de stock diario funciona offline para dueño y queda protegida para cajero', async () => {
  resetStore(); login(1); seed(); navigator.onLine = false
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const stored = records.get(stateKey(1))
  stored.base.daily_stock = { date: today, products: [{ id: 10, opening_stock: 20, current_stock: 20 }] }
  records.set(stateKey(1), stored)
  assert.equal(handlesOffline('/api/products/day-stock', 'GET'), true)
  const sold = await write('/api/sales', saleBody('daily-stock-sale'))
  assert.equal(sold.status, 202)
  const ownerResponse = await (await import('./offlineClient.js?daily-owner')).offlineRequest('/api/products/day-stock')
  assert.equal(ownerResponse.status, 200)
  assert.deepEqual((await ownerResponse.json()).products[0], { id: 10, opening_stock: 20, current_stock: 18, tracked: true })

  setToken(tokenFor(1, 2)); cacheUser({ id: 2, email: 'cashier@test.local', role: 'cajero' })
  records.set('mypimes_local_v1:1:2', structuredClone(records.get(stateKey(1))))
  const cashierResponse = await (await import('./offlineClient.js?daily-cashier')).offlineRequest('/api/products/day-stock')
  assert.equal(cashierResponse.status, 400)
  assert.match((await cashierResponse.json()).error, /Solo el dueño/)
})

test('una edición de cajero guardada con el producto entero por una versión antigua sube sin 403 y no frena las ventas', async () => {
  resetStore(); seed()
  setToken(tokenFor(1, 2)); cacheUser({ id: 2, email: 'cajero@test.local', role: 'cajero' })
  const key = 'mypimes_local_v1:1:2'
  const legacy = { id: 'legacy-edit', kind: 'product', method: 'PUT', path: '/api/products/10', productId: 10, queued_at: new Date().toISOString(), before: { name: 'Pan 1', sale_price: 10, purchase_price: 6, stock: 20, unit: null }, body: { name: 'Pan 1', purchase_price: 6, sale_price: 12, stock: 20, unit: null }, result: { id: 10, name: 'Pan 1', sale_price: 12, purchase_price: 6, stock: 20 }, error: 'El cajero solo puede cambiar el precio de venta y añadir stock', errorStatus: 403 }
  const sale = { id: 'sale-after', kind: 'sale', method: 'POST', path: '/api/sales', queued_at: new Date().toISOString(), body: saleBody('after-legacy'), result: { id: -1, items: saleBody('after-legacy').items } }
  records.set(key, { ...structuredClone(records.get(stateKey(1))), outbox: [legacy, sale] })
  navigator.onLine = true
  const sent = []
  globalThis.fetch = async (path, options) => {
    if (path === '/api/sync/product-operation') {
      const { product } = JSON.parse(options.body)
      if (Object.keys(product).some((k) => k !== 'sale_price' && k !== 'add_stock')) return jsonResponse({ error: 'El cajero solo puede cambiar el precio de venta y añadir stock' }, 403)
      sent.push('product'); return jsonResponse({ id: 10, name: 'Pan 1', sale_price: 12, purchase_price: 6, stock: 20 })
    }
    if (path === '/api/sales') { sent.push('sale'); return jsonResponse({ ...legacy.result, id: 99, pending: false, items: sale.result.items }) }
    return jsonResponse({ products: [], current_period: {} })
  }
  await retrySync()
  assert.deepEqual(sent, ['product', 'sale'])
  assert.equal((await localSyncStatus()).pending, 0)
})

test('corregir un cierre PWA requiere red, no crea outbox y refresca el snapshot confirmado', async () => {
  resetStore(); login(1); seed(); navigator.onLine = false
  assert.equal(handlesOffline('/api/cash-closes/9', 'PUT'), false)
  globalThis.fetch = () => { throw new TypeError('offline') }
  await assert.rejects(apiFetch('/api/cash-closes/9', { method: 'PUT', body: JSON.stringify({ correction_revision: 0 }) }), /offline/)
  assert.equal((await localSyncStatus()).pending, 0, 'no se devuelve un éxito local ni se encola la corrección')

  const key = stateKey(1)
  const confirmed = { id: 9, client_close_id: 'close-9', expected_cash: 150, counted_cash: 150, difference: 0, correction_revision: 1 }
  const ownerIdentity = { account: '1:1', token: tokenFor(1) }
  records.set(key, { base: { ...emptyData(), cash_closes: [
    { id: 8, client_close_id: null, expected_cash: 1 },
    { id: 9, client_close_id: null, expected_cash: 2 },
  ] }, outbox: [], initialized: true })
  await cacheCashCloseCorrection({ cash_close: { ...confirmed, client_close_id: null } }, ownerIdentity)
  assert.equal(records.get(key).base.cash_closes.find((row) => row.id === 8).expected_cash, 1,
    'cierres legacy sin client_close_id no colisionan')
  assert.equal(records.get(key).base.cash_closes.find((row) => row.id === 9).expected_cash, 150)
  setToken(tokenFor(2)); cacheUser({ id: 2, email: 'other@test.local', role: 'dueño' })
  assert.equal(await cacheCashCloseCorrection({ cash_close: { ...confirmed, id: 10 } }, ownerIdentity), false,
    'no aplica la respuesta anterior después de cambiar la cuenta')
  assert.equal((records.get(stateKey(2))?.base.cash_closes || []).length, 0)
  login(1)
  const ownerState = records.get(key)
  ownerState.base.cash_closes = [confirmed]
  records.set(key, ownerState)
  let requested = ''
  globalThis.fetch = async (path) => {
    requested = path
    return jsonResponse({ ...emptyData(), cash_closes: [confirmed], current_period: { has_sales: false } })
  }
  await refreshOfflineSnapshot()
  assert.equal(requested, '/api/sync/snapshot')
  const history = await (await apiFetch('/api/cash-closes')).json()
  assert.equal(history[0].difference, 0)
  assert.equal(records.get(key).outbox.length, 0)
})
