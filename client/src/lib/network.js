import { sharedContextForToken, blockSharedDevice, disableSharedCashier, isSharedLocked, lockSharedDevice } from './sharedDevice.js'
import { accountKeyFromToken } from './queueOwnership.js'

const TOKEN_KEY = 'mypimes_token'
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)
export const isElectron = () => typeof window !== 'undefined' && !!window.electronAPI

// Solo esta función toca la red. El sincronizador conserva el token capturado
// al comenzar para no enviar operaciones con la sesión de otra cuenta.
export async function networkFetch(path, options = {}) {
  const token = options.token ?? getToken()
  const { token: _token, preserveSession, ...request } = options
  const headers = { ...(request.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  if (request.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch(path, { ...request, headers, signal: request.signal || controller.signal })
    const shared = sharedContextForToken(token)
    if (shared && res.status === 403) {
      const error = await res.clone().json().catch(() => ({}))
      if (error.code === 'DEVICE_REVOKED') blockSharedDevice(error.error)
      else if (error.code === 'MEMBER_REVOKED') disableSharedCashier(accountKeyFromToken(token), error.error)
    }
    if (shared && res.status === 401 && token === getToken() && !isSharedLocked()) lockSharedDevice()
    if (res.status === 401 && !shared && !preserveSession && token === getToken()) {
      clearToken()
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
    return res
  } finally { clearTimeout(timer) }
}
