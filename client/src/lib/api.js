const TOKEN_KEY = 'mypimes_token'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

// window.electronAPI solo existe cuando este mismo código corre dentro del
// shell de escritorio (ver desktop/preload.js) — en el navegador es undefined
// y todo el resto del archivo se comporta exactamente igual que siempre.
export const isElectron = () => typeof window !== 'undefined' && !!window.electronAPI

// Fetch wrapper for authenticated API calls. Attaches the bearer token and
// broadcasts 'auth:unauthorized' on a 401 so AuthContext can log the user out
// from anywhere in the app (e.g. an expired session mid-session).
//
// En modo Electron, la misma llamada se enruta por IPC hacia la base local
// (desktop/src/router.js) en vez de ir por red — así el resto de la app
// (POS.jsx, AuthContext, etc.) no necesita saber en qué modo está corriendo.
export async function apiFetch(path, options = {}) {
  if (isElectron()) {
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : undefined
    const { ok, status, data } = await window.electronAPI.request(method, path, body)

    if (status === 401) {
      clearToken()
      window.dispatchEvent(new Event('auth:unauthorized'))
    }

    return { ok, status, json: async () => data }
  }

  const token = getToken()
  const headers = { ...(options.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, { ...options, headers })

  if (res.status === 401) {
    clearToken()
    window.dispatchEvent(new Event('auth:unauthorized'))
  }

  return res
}
