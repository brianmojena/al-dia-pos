// La autorización de cada cajero la firma el servidor. El PIN protege el
// acceso cotidiano en este aparato; nunca sustituye esa autorización.
const ENROLLMENT_KEY = 'mypimes_shared_device_v1'
const LOCK_KEY = 'mypimes_shared_locked'
const TOKEN_KEY = 'mypimes_token'
const ITERATIONS = 210000
let locked = true // Recargar o volver a abrir siempre exige PIN.

const readEnrollment = () => {
  try {
    const value = JSON.parse(localStorage.getItem(ENROLLMENT_KEY) || 'null')
    return value?.version === 1 && value.device?.id && Array.isArray(value.cashiers) ? value : null
  } catch { return null }
}
const payloadOf = (token) => {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0))))
  } catch { return null }
}
const changed = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('shared-device:changed'))
}
const writeEnrollment = (record) => {
  // Si el navegador no puede persistirlo, el llamador debe mostrar el error.
  localStorage.setItem(ENROLLMENT_KEY, JSON.stringify(record))
}
const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const hexToBytes = (hex) => {
  if (typeof hex !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(hex)) throw new Error('Acceso local dañado. Contacta al administrador.')
  return Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16))
}
async function derivePin(pin, salt, iterations = ITERATIONS) {
  if (!globalThis.crypto?.subtle) throw new Error('Abre la aplicación mediante una conexión segura para configurar los PIN.')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const result = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(salt), iterations }, key, 256)
  return bytesToHex(new Uint8Array(result))
}
// Cifra un PIN en este navegador. Lo usa la activación remota: el administrador
// cifra los PIN aquí y solo viaja el hash, para que el aparato destino instale
// la caja sin que nadie teclee un PIN.
export async function hashPin(pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) throw new Error('Cada cajero necesita un PIN de 6 dígitos.')
  if (!globalThis.crypto?.subtle) throw new Error('Abre la aplicación mediante una conexión segura para configurar los PIN.')
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  return { salt, hash: await derivePin(pin, salt), iterations: ITERATIONS }
}
const validStoredPin = (pin) => !!pin
  && typeof pin.salt === 'string' && /^(?:[a-f0-9]{2})+$/.test(pin.salt)
  && typeof pin.hash === 'string' && /^[a-f0-9]{64}$/.test(pin.hash)
  && Number.isInteger(pin.iterations) && pin.iterations > 0
const equalHash = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}
function validateBundle(bundle) {
  const { device, cashiers } = bundle || {}
  if (!device?.id || !Number.isInteger(Number(device.owner_id)) || Number(device.owner_id) <= 0
    || typeof device.continuous !== 'boolean' || !Number.isFinite(Date.parse(device.expires_at))
    || !Array.isArray(cashiers) || !cashiers.length) throw new Error('La configuración de la caja no es válida.')
  const ids = new Set()
  for (const member of cashiers) {
    const payload = payloadOf(member.token)
    if (!Number.isInteger(Number(member.id)) || ids.has(Number(member.id))
      || payload?.deviceId !== device.id || Number(payload?.userId) !== Number(device.owner_id)
      || Number(payload?.accountId) !== Number(member.id) || payload?.role !== 'cajero'
      || Number(member.user?.id) !== Number(member.id) || member.user?.role !== 'cajero'
      || member.user?.is_admin || !Number.isFinite(payload?.exp) || payload.exp * 1000 <= Date.now()) {
      throw new Error('Los accesos recibidos no corresponden a esta caja o han vencido.')
    }
    ids.add(Number(member.id))
  }
}

export const getSharedDevice = () => readEnrollment()?.device || null
export const getSharedMembers = () => (readEnrollment()?.cashiers || []).filter((c) => !c.disabled)
  .map(({ id, email, display_name }) => ({ id, email, display_name }))
export const getLastSharedAccount = () => {
  const record = readEnrollment()
  return record?.lastAccountId ? `${record.device.owner_id}:${record.lastAccountId}` : null
}

export function sharedContextForToken(token) {
  const record = readEnrollment()
  if (!record) return null
  const payload = payloadOf(token || '')
  if (payload?.deviceId !== record.device.id || Number(payload.userId) !== Number(record.device.owner_id)) return null
  return record.cashiers.some((c) => Number(c.id) === Number(payload.accountId)) ? record.device : null
}

export function getSharedContext(account) {
  const token = localStorage.getItem(TOKEN_KEY) || ''
  const context = sharedContextForToken(token)
  const payload = payloadOf(token)
  if (account && account !== `${payload?.userId}:${payload?.accountId}`) return null
  return context
}

export function getSharedCredential(account) {
  const record = readEnrollment()
  if (!record || typeof account !== 'string' || !/^\d+:\d+$/.test(account)) return null
  const [shop, id] = account.split(':')
  if (Number(shop) !== Number(record.device.owner_id)) return null
  const member = record.cashiers.find((c) => Number(c.id) === Number(id))
  // Incluso un acceso deshabilitado conserva su identidad para no perder ni
  // reasignar recibos pendientes. El servidor decide si admite su subida.
  return member ? { token: member.token, user: member.user } : null
}

export function isSharedLocked() {
  if (!getSharedDevice()) return false
  const token = localStorage.getItem(TOKEN_KEY)
  if (token && !getSharedContext()) return false // Administración usa su propio login.
  return locked || localStorage.getItem(LOCK_KEY) === '1'
}

export function isSharedExpired() {
  const record = readEnrollment()
  return !!record && (!!record.blocked || Date.parse(record.device.expires_at) <= Date.now())
}

export function lockSharedDevice() {
  locked = true
  localStorage.setItem(LOCK_KEY, '1')
  changed()
}

export async function installSharedDevice(bundle, pins) {
  validateBundle(bundle)
  const cashiers = []
  for (const member of bundle.cashiers) {
    // Prioridad al PIN ya cifrado que trae el bundle (activación remota): si
    // viene, se adopta tal cual y no se pide ninguno. Si no, se deriva del PIN
    // que tecleó el administrador en este navegador.
    let pin = validStoredPin(member.pin)
      ? { salt: member.pin.salt, hash: member.pin.hash, iterations: member.pin.iterations }
      : null
    if (!pin) {
      const raw = pins?.[member.id]
      if (typeof raw !== 'string' || !/^\d{6}$/.test(raw)) throw new Error('Cada cajero necesita un PIN de 6 dígitos.')
      const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
      pin = { salt, hash: await derivePin(raw, salt), iterations: ITERATIONS }
    }
    const { pin: _bundlePin, ...rest } = member
    cashiers.push({ ...rest, pin, failures: 0, blockedUntil: 0 })
  }
  writeEnrollment({ version: 1, device: { ...bundle.device }, cashiers })
  // Se termina la sesión administrativa, sin eliminar datos de negocio.
  localStorage.removeItem(TOKEN_KEY)
  lockSharedDevice()
}

export async function unlockSharedCashier(id, pin) {
  const record = readEnrollment()
  if (!record) throw new Error('Este dispositivo todavía no está configurado.')
  if (isSharedExpired()) throw new Error(record.blocked || 'Los accesos de esta caja vencieron. Conéctate y contacta al administrador; los datos pendientes siguen guardados.')
  const member = record.cashiers.find((c) => Number(c.id) === Number(id) && !c.disabled)
  if (!member) throw new Error('Este cajero no está autorizado en esta caja.')
  if (member.blockedUntil > Date.now()) throw new Error('Demasiados intentos. Espera un minuto y vuelve a intentar.')
  const payload = payloadOf(member.token)
  if (!payload?.exp || payload.exp * 1000 <= Date.now()) throw new Error('El acceso de este cajero venció. Conéctate para renovarlo.')
  const actual = typeof pin === 'string' && /^\d{6}$/.test(pin) ? await derivePin(pin, member.pin.salt, member.pin.iterations) : ''
  // Otra pestaña puede haber cambiado la instalación mientras se derivaba el PIN.
  const latest = readEnrollment()
  const current = latest?.cashiers.find((c) => Number(c.id) === Number(id))
  if (latest?.device.id !== record.device.id || current?.pin.hash !== member.pin.hash || current?.disabled || latest.blocked) {
    throw new Error('La configuración cambió. Vuelve a seleccionar al cajero.')
  }
  if (current.blockedUntil > Date.now()) throw new Error('Demasiados intentos. Espera un minuto y vuelve a intentar.')
  if (!equalHash(actual, member.pin.hash)) {
    current.failures = (current.failures || 0) + 1
    if (current.failures >= 5) { current.failures = 0; current.blockedUntil = Date.now() + 60000 }
    writeEnrollment(latest)
    throw new Error(current.blockedUntil > Date.now() ? 'Demasiados intentos. Espera un minuto y vuelve a intentar.' : 'PIN incorrecto.')
  }
  current.failures = 0
  current.blockedUntil = 0
  latest.lastAccountId = current.id
  writeEnrollment(latest)
  localStorage.setItem(`mypimes_user_cache:${record.device.owner_id}:${current.id}`, JSON.stringify(current.user))
  localStorage.setItem(TOKEN_KEY, current.token)
  localStorage.removeItem(LOCK_KEY)
  locked = false
  changed()
  return { user: current.user, token: current.token }
}

export function refreshSharedEnrollment(bundle) {
  validateBundle(bundle)
  const record = readEnrollment()
  if (!record || record.device.id !== bundle.device.id || Number(record.device.owner_id) !== Number(bundle.device.owner_id)
    || record.device.continuous !== bundle.device.continuous) throw new Error('La renovación no corresponde a la caja instalada.')
  const incoming = new Map(bundle.cashiers.map((c) => [Number(c.id), c]))
  const cashiers = record.cashiers.map((old) => {
    const member = incoming.get(Number(old.id))
    return member ? { ...old, ...member, disabled: false } : { ...old, disabled: true }
  })
  writeEnrollment({ ...record, blocked: '', device: { ...bundle.device }, cashiers })
  const payload = payloadOf(localStorage.getItem(TOKEN_KEY) || '')
  if (payload?.deviceId === record.device.id) {
    const current = cashiers.find((c) => Number(c.id) === Number(payload.accountId) && !c.disabled)
    if (current) {
      localStorage.setItem(TOKEN_KEY, current.token)
      localStorage.setItem(`mypimes_user_cache:${record.device.owner_id}:${current.id}`, JSON.stringify(current.user))
    } else lockSharedDevice()
  }
  changed()
}

export function blockSharedDevice(reason = 'El acceso de esta caja fue retirado. Contacta al administrador; los cambios pendientes siguen guardados.') {
  const record = readEnrollment()
  if (!record) return
  writeEnrollment({ ...record, blocked: reason })
  lockSharedDevice()
}

export function disableSharedCashier(account, reason) {
  const record = readEnrollment()
  const [shop, id] = String(account || '').split(':')
  if (!record || Number(shop) !== Number(record.device.owner_id)) return
  const member = record.cashiers.find((c) => Number(c.id) === Number(id))
  if (!member) return
  member.disabled = true
  member.access_error = reason || 'El acceso de este cajero fue retirado.'
  writeEnrollment(record)
  const payload = payloadOf(localStorage.getItem(TOKEN_KEY) || '')
  if (payload?.deviceId === record.device.id && Number(payload.accountId) === Number(id)) lockSharedDevice()
  else changed()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if ([ENROLLMENT_KEY, LOCK_KEY, TOKEN_KEY].includes(event.key)) {
      locked = true // Nunca heredar un desbloqueo hecho en otra pestaña.
      changed()
    }
  })
}
