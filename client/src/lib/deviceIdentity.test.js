import test from 'node:test'
import assert from 'node:assert/strict'
import { deviceHeaders } from './deviceIdentity.js'

test('identidad del navegador sobrevive a renovar sesión y cambiar de cuenta', () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  const first = deviceHeaders()
  assert.match(first['X-Device-Id'], /^web-/)
  values.set('mypimes_token', 'otra-cuenta')
  assert.deepEqual(deviceHeaders(), first)
  assert.equal(first['X-Device-Platform'], 'web')
  values.delete('mypimes_device_id')
  assert.notEqual(deviceHeaders()['X-Device-Id'], first['X-Device-Id'])
})

test('almacenamiento bloqueado omite telemetría sin impedir operar', () => {
  globalThis.localStorage = { getItem: () => { throw new Error('Almacenamiento bloqueado') } }
  assert.deepEqual(deviceHeaders(), {})
})
