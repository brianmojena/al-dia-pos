import test from 'node:test'
import assert from 'node:assert/strict'

const values = new Map()
globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) }
globalThis.window = new EventTarget()
const { installSharedDevice, unlockSharedCashier, getSharedCredential, getSharedMembers, isSharedLocked, isSharedExpired, refreshSharedEnrollment } = await import('./sharedDevice.js')
const { networkFetch, getToken, setToken } = await import('./network.js')
const token = (accountId, deviceId = 'net-device') => `x.${Buffer.from(JSON.stringify({ userId: 7, accountId, deviceId, role: 'cajero', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.x`
const enrollment = {
  device: { id: 'net-device', owner_id: 7, name: 'Caja', continuous: true, expires_at: new Date(Date.now() + 86400000).toISOString() },
  cashiers: [12, 13].map((id) => ({ id, email: `${id}@test.local`, display_name: `Cajero ${id}`, token: token(id), user: { id, role: 'cajero', is_admin: false } })),
}

test('las respuestas de autenticación nunca reasignan ni borran credenciales de caja', async (t) => {
  await installSharedDevice(enrollment, { 12: '123456', 13: '654321' })
  await unlockSharedCashier(13, '654321')
  await t.test('revocar A durante sincronización no cierra a B ni permite volver a entrar a A', async () => {
    const active = getToken()
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'MEMBER_REVOKED', error: 'Cajero retirado' }), { status: 403 })
    const result = await networkFetch('/api/sales', { token: getSharedCredential('7:12').token, preserveSession: true })
    assert.equal(result.status, 403)
    assert.equal(getToken(), active)
    assert.equal(isSharedLocked(), false)
    assert.deepEqual(getSharedMembers().map((c) => c.id), [13])
    assert.ok(getSharedCredential('7:12'), 'el recibo pendiente conserva una credencial atribuida a A')
    await assert.rejects(unlockSharedCashier(12, '123456'), /no está autorizado/)
  })
  await t.test('401 compartido bloquea la pantalla y conserva el token para recuperación', async () => {
    const active = getToken()
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    await networkFetch('/api/auth/me')
    assert.equal(getToken(), active)
    assert.equal(isSharedLocked(), true)
  })
  await t.test('revocación del dispositivo bloquea todos los PIN sin eliminar el registro', async () => {
    refreshSharedEnrollment(enrollment)
    await unlockSharedCashier(13, '654321')
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'DEVICE_REVOKED', error: 'Caja retirada' }), { status: 403 })
    await networkFetch('/api/sales')
    assert.equal(isSharedExpired(), true)
    assert.equal(isSharedLocked(), true)
    assert.ok(getSharedCredential('7:13'))
    await assert.rejects(unlockSharedCashier(13, '654321'), /Caja retirada/)
  })
  await t.test('login normal conserva su comportamiento ante 401', async () => {
    // Token de otra instalación: no recibe los permisos de la caja local.
    setToken(token(99, 'other-device'))
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    await networkFetch('/api/auth/me')
    assert.equal(getToken(), null)
  })
})
