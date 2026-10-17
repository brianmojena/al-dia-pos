import test from 'node:test'
import assert from 'node:assert/strict'

const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
globalThis.window = new EventTarget()
const shared = await import('./sharedDevice.js')
const token = (id, overrides = {}) => `x.${Buffer.from(JSON.stringify({
  userId: 7, accountId: id, role: 'cajero', deviceId: 'device-one', deviceVersion: 1,
  exp: Math.floor(Date.now() / 1000) + 86400, ...overrides,
})).toString('base64url')}.x`
const bundle = () => ({
  device: { id: 'device-one', owner_id: 7, name: 'Mostrador', continuous: true, expires_at: new Date(Date.now() + 86400000).toISOString() },
  cashiers: [12, 13].map((id) => ({ id, email: `${id}@test.local`, display_name: `Cajero ${id}`, token: token(id), user: { id, email: `${id}@test.local`, role: 'cajero', is_admin: false, store_name: 'Tienda' } })),
})
const install = () => shared.installSharedDevice(bundle(), { 12: '123456', 13: '654321' })

test('PIN y autorización local de caja compartida', async (t) => {
  await t.test('instalación retira la sesión administrativa y guarda solo verificadores', async () => {
    values.clear()
    localStorage.setItem('mypimes_token', 'admin-token')
    await install()
    assert.equal(localStorage.getItem('mypimes_token'), null)
    assert.equal(shared.isSharedLocked(), true)
    const stored = localStorage.getItem('mypimes_shared_device_v1')
    assert.ok(!stored.includes('123456') && !stored.includes('654321'))
    const record = JSON.parse(stored)
    assert.notEqual(record.cashiers[0].pin.salt, record.cashiers[1].pin.salt)
    assert.equal(shared.getSharedMembers().length, 2)
  })
  await t.test('cada PIN selecciona su propia identidad y mantiene la caja', async () => {
    const first = await shared.unlockSharedCashier(12, '123456')
    assert.equal(first.user.id, 12)
    assert.equal(shared.isSharedLocked(), false)
    assert.equal(shared.getSharedContext('7:12').id, 'device-one')
    assert.equal(shared.getSharedContext('7:13'), null)
    shared.lockSharedDevice()
    assert.equal(shared.isSharedLocked(), true)
    assert.equal(localStorage.getItem('mypimes_token'), first.token, 'la sincronización conserva su credencial al bloquear')
    await shared.unlockSharedCashier(13, '654321')
    assert.equal(shared.getSharedContext('7:13').id, 'device-one')
    assert.equal(shared.getSharedCredential('7:12').user.id, 12)
    assert.equal(shared.getSharedCredential('8:12'), null)
  })
  await t.test('PIN erróneo no cambia al cajero y cinco fallos sobreviven a recargas', async () => {
    shared.lockSharedDevice()
    const active = localStorage.getItem('mypimes_token')
    for (let i = 0; i < 4; i++) await assert.rejects(shared.unlockSharedCashier(12, '000000'), /PIN incorrecto/)
    await assert.rejects(shared.unlockSharedCashier(12, '000000'), /Espera un minuto/)
    const reopened = await import('./sharedDevice.js?reopened')
    await assert.rejects(reopened.unlockSharedCashier(12, '123456'), /Espera un minuto/)
    assert.equal(reopened.isSharedLocked(), true)
    assert.equal(localStorage.getItem('mypimes_token'), active)
    await assert.rejects(shared.unlockSharedCashier(99, '123456'), /no está autorizado/)
  })
  await t.test('un nuevo contexto siempre vuelve a pedir PIN', async () => {
    await shared.unlockSharedCashier(13, '654321')
    assert.equal(shared.isSharedLocked(), false)
    const reopened = await import('./sharedDevice.js?new-context')
    assert.equal(reopened.isSharedLocked(), true)
  })
  await t.test('configuración inválida no reemplaza una instalación existente', async () => {
    const prior = localStorage.getItem('mypimes_shared_device_v1')
    const bad = bundle()
    bad.cashiers[0].token = token(12, { userId: 99 })
    await assert.rejects(shared.installSharedDevice(bad, { 12: '123456', 13: '654321' }), /no corresponden/)
    await assert.rejects(shared.installSharedDevice(bundle(), { 12: '123456' }), /6 dígitos/)
    assert.equal(localStorage.getItem('mypimes_shared_device_v1'), prior)
  })
  await t.test('renovar preserva los PIN y no admite cambiar caja ni modalidad', async () => {
    const old = JSON.parse(localStorage.getItem('mypimes_shared_device_v1'))
    const next = bundle()
    next.cashiers[1].token = token(13, { exp: Math.floor(Date.now() / 1000) + 172800 })
    shared.refreshSharedEnrollment(next)
    assert.deepEqual(JSON.parse(localStorage.getItem('mypimes_shared_device_v1')).cashiers[1].pin, old.cashiers[1].pin)
    await shared.unlockSharedCashier(13, '654321')
    assert.equal(localStorage.getItem('mypimes_token'), next.cashiers[1].token)
    assert.throws(() => shared.refreshSharedEnrollment({ ...next, device: { ...next.device, continuous: false } }), /no corresponde/)
  })
  await t.test('retirar un cajero conserva sus credenciales pendientes y permite a los demás', async () => {
    shared.disableSharedCashier('7:12')
    assert.deepEqual(shared.getSharedMembers().map((c) => c.id), [13])
    assert.equal(shared.getSharedCredential('7:12').user.id, 12)
    await assert.rejects(shared.unlockSharedCashier(12, '123456'), /no está autorizado/)
    await shared.unlockSharedCashier(13, '654321')
    assert.equal(shared.isSharedLocked(), false)
  })
  await t.test('revocación bloquea nuevos accesos y renovación administrativa los recupera', async () => {
    shared.blockSharedDevice('Caja retirada')
    assert.equal(shared.isSharedExpired(), true)
    assert.equal(shared.isSharedLocked(), true)
    await assert.rejects(shared.unlockSharedCashier(13, '654321'), /Caja retirada/)
    shared.refreshSharedEnrollment(bundle())
    assert.equal(shared.isSharedExpired(), false)
    await shared.unlockSharedCashier(13, '654321')
  })
  await t.test('administración conserva acceso propio para recuperar el aparato', () => {
    localStorage.setItem('mypimes_token', token(1, { deviceId: undefined, role: 'dueño', userId: 1 }))
    assert.equal(shared.getSharedContext(), null)
    assert.equal(shared.isSharedLocked(), false)
  })
})
