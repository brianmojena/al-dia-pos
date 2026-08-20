import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { apiFetch, getToken, setToken, clearToken, isElectron } from '../lib/api'
import { cacheUser, getCachedUser } from '../lib/offlineCache'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadMe = useCallback(async () => {
    // En modo Electron, /api/auth/me no usa red (lee la sesión SQLite local vía
    // IPC) — siempre vale la pena preguntarle, en vez de confiar en localStorage,
    // que podría haberse limpiado sin que la sesión local realmente se perdiera.
    if (!isElectron() && !getToken()) { setLoading(false); return }
    try {
      const res = await apiFetch('/api/auth/me')
      if (res.ok) {
        const data = await res.json()
        setUser(data.user)
        cacheUser(data.user)
      } else {
        // 401/403 reales: la sesión no vale, no hay nada que rescatar del cache.
        clearToken()
        setUser(null)
      }
    } catch (_) {
      // Sin red (PWA offline al abrir): confiamos en el último usuario
      // conocido en vez de dejar al cajero sin poder vender.
      const cached = getCachedUser()
      if (cached) setUser(cached)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadMe() }, [loadMe])

  useEffect(() => {
    const onUnauthorized = () => setUser(null)
    window.addEventListener('auth:unauthorized', onUnauthorized)
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized)
  }, [])

  // Solo en escritorio: el límite de transferencia y la tasa del dólar los
  // cambia el dueño desde su teléfono, no desde esta caja. El sync worker
  // (desktop/src/sync/syncWorker.js) los refresca contra el servidor en cada
  // pasada y avisa por el mismo evento que ya usa el indicador de sincronía
  // — nos enganchamos ahí para no abrir un segundo canal solo para esto.
  useEffect(() => {
    if (!isElectron()) return
    return window.electronAPI.onSyncStatus((status) => {
      if (status.settingsRefreshed) loadMe()
    })
  }, [loadMe])

  const login = async (email, password) => {
    // apiFetch (no fetch directo): en modo Electron esto se enruta por IPC y
    // el propio proceso principal habla con el servidor real para autenticar
    // (login siempre necesita red la primera vez, aunque el resto de la app no).
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión')
    setToken(data.token)
    setUser(data.user)
    cacheUser(data.user)
    return data.user
  }

  const register = async ({ email, password, store_name, plan }) => {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, store_name, plan }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'No se pudo crear la cuenta')
    setToken(data.token)
    setUser(data.user)
    cacheUser(data.user)
    return data.user
  }

  const logout = () => {
    clearToken()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
