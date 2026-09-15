import test from 'node:test'
import assert from 'node:assert/strict'
import { accountKeyFromToken, belongsToAccount, splitByAccount, logoutBlockers } from './queueOwnership.js'

// Token con la misma forma que firma el servidor (la firma no se comprueba aquí).
const tokenDe = (payload) => {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.firma`
}

const yamila = accountKeyFromToken(tokenDe({ userId: 7, accountId: 12, role: 'cajero' }))
const dueño = accountKeyFromToken(tokenDe({ userId: 7, accountId: 7, role: 'dueño' }))
const otraTienda = accountKeyFromToken(tokenDe({ userId: 30, accountId: 30, role: 'dueño' }))

test('la cuenta sale del token: tienda y quién inició sesión', () => {
  assert.equal(yamila, '7:12')
  assert.equal(dueño, '7:7')
})

test('un token de antes de los roles es del dueño', () => {
  assert.equal(accountKeyFromToken(tokenDe({ userId: 7 })), '7:7')
})

test('sin sesión o con un token dañado no hay cuenta', () => {
  assert.equal(accountKeyFromToken(null), null)
  assert.equal(accountKeyFromToken('basura'), null)
  assert.equal(accountKeyFromToken('a.no-es-json.c'), null)
})

test('los tokens con acentos en los datos se leen bien', () => {
  assert.equal(accountKeyFromToken(tokenDe({ userId: 1, accountId: 2, role: 'dueño' })), '1:2')
})

test('una venta solo la sube la cuenta que la cobró', () => {
  const venta = { client_sale_id: 'a', account_key: yamila }
  assert.equal(belongsToAccount(venta, yamila), true)
  assert.equal(belongsToAccount(venta, dueño), false, 'ni siquiera el dueño de la misma tienda')
  assert.equal(belongsToAccount(venta, otraTienda), false)
  assert.equal(belongsToAccount(venta, null), false, 'sin sesión no se sube nada')
})

test('las ventas encoladas antes del cambio se suben con la sesión que haya', () => {
  assert.equal(belongsToAccount({ client_sale_id: 'vieja' }, dueño), true)
  assert.equal(belongsToAccount({ client_sale_id: 'vieja' }, null), false)
})

test('se separan las ventas propias de las de otras cuentas', () => {
  const cola = [
    { client_sale_id: 'a', account_key: yamila },
    { client_sale_id: 'b', account_key: otraTienda },
    { client_sale_id: 'c', account_key: yamila },
  ]
  const { mine, others } = splitByAccount(cola, yamila)
  assert.deepEqual(mine.map((s) => s.client_sale_id), ['a', 'c'])
  assert.deepEqual(others.map((s) => s.client_sale_id), ['b'])
  assert.deepEqual(splitByAccount(undefined, yamila), { mine: [], others: [] })
})

test('no se puede cerrar sesión con ventas propias sin subir o rechazadas sin avisar', () => {
  const cola = [{ client_sale_id: 'a', account_key: yamila }]
  const rechazadas = [
    { client_sale_id: 'r1', account_key: yamila, reported: false },
    { client_sale_id: 'r2', account_key: yamila, reported: true },
    { client_sale_id: 'r3', account_key: yamila, reported: false, report_failed: true },
    { client_sale_id: 'r4', account_key: otraTienda, reported: false },
  ]
  assert.deepEqual(logoutBlockers(cola, rechazadas, yamila), { pending: 1, unreported: 1, total: 2 })
  assert.deepEqual(logoutBlockers([], [], yamila), { pending: 0, unreported: 0, total: 0 })
  assert.equal(logoutBlockers(cola, rechazadas, otraTienda).total, 1, 'lo de Yamila no bloquea a otra cuenta')
})
