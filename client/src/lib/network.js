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
    if (res.status === 401 && !preserveSession && token === getToken()) {
      clearToken()
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
    return res
  } finally { clearTimeout(timer) }
}
