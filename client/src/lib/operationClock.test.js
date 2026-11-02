import test from 'node:test'
import assert from 'node:assert/strict'

test('la hora del servidor corrige un reloj adelantado y sigue disponible al reabrir sin red', async (t) => {
  const values = new Map(), realNow = Date.now
  globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }
  let local = realNow() + 3600000
  Date.now = () => local
  t.after(() => { Date.now = realNow })
  const server = realNow()
  const clock = await import('./operationClock.js?first')
  clock.observeServerTime(new Date(server).toISOString())
  assert.ok(Math.abs(Date.parse(clock.operationNow()) - server) < 1000)
  local += 3600000
  assert.ok(Math.abs(Date.parse(clock.operationNow()) - server) < 1000, 'la referencia monotónica resiste cambios del reloj durante la sesión')
  local -= 3600000
  const reopened = await import('./operationClock.js?reopened')
  assert.equal(Date.parse(reopened.operationNow()), server)
  reopened.observeServerTime(null)
  assert.equal(Date.parse(reopened.operationNow()), server)
  local = server
  assert.equal(Date.parse(reopened.operationNow()), server, 'al atrasar manualmente el reloj se descarta la referencia persistida anterior')
});
