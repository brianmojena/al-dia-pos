import { syncOffline, sharedHandoverStatus } from '../lib/offlineClient.js'
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch, getToken, setToken, clearToken, isElectron } from '../lib/api'
import { cacheUser, getCachedUser } from '../lib/offlineCache'
import { refreshQueueStatus } from '../lib/salesQueue'
import { getSharedDevice, getSharedContext, getLastSharedAccount, isSharedLocked, unlockSharedCashier, lockSharedDevice, refreshSharedEnrollment } from '../lib/sharedDevice.js'

// Al cambiar de sesión cambia qué ventas guardadas en el teléfono son de quien
// está dentro: se recalcula el contador y, al entrar, se suben las suyas ya.
const onSessionChanged = ({ signedIn }) => {
  if (isElectron()) return
  refreshQueueStatus().catch(() => {})
  if (signedIn) void syncOffline()
}

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sharedDevice, setSharedDevice] = useState(getSharedDevice)
  const [sharedLocked, setSharedLocked] = useState(isSharedLocked)
  const sharedGuard = useRef({ hasCart: false, busy: false })
  const setSharedGuard = useCallback((guard) => { sharedGuard.current = guard }, [])

  useEffect(() => {
    const refresh = () => {
      setSharedDevice(getSharedDevice())
      setSharedLocked(isSharedLocked())
      const cached = getCachedUser()
      if (getToken() && cached) setUser(cached)
      else if (!getToken()) setUser(null)
    }
    window.addEventListener('shared-device:changed', refresh)
    return () => window.removeEventListener('shared-device:changed', refresh)
  }, [])

  useEffect(() => {
    if (!sharedDevice || sharedLocked || !getSharedContext()) return
    let timer
    const expire = () => {
      if (sharedGuard.current.busy) { timer = setTimeout(expire, 1000); return }
      lockSharedDevice()
    }
    const active = () => { clearTimeout(timer); timer = setTimeout(expire, 5 * 60 * 1000) }
    active()
    for (const event of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(event, active, { passive: true })
    return () => { clearTimeout(timer); for (const event of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(event, active) }
  }, [sharedDevice, sharedLocked, user?.id])

  const loadMe = useCallback(async () => {
    // En modo Electron, /api/auth/me no usa red (lee la sesión SQLite local vía
    // IPC) — siempre vale la pena preguntarle, en vez de confiar en localStorage,
    // que podría haberse limpiado sin que la sesión local realmente se perdiera.
    if (!isElectron() && !getToken()) { setLoading(false); return }
    const sessionToken = getToken()
    const cached = !isElectron() && getCachedUser()
    if (cached) {
      setUser(cached)
      setLoading(false)
      void syncOffline()
      if (navigator.onLine === false) return
    }
    try {
      const res = await apiFetch('/api/auth/me', { preserveSession: !!cached })
      if (!isElectron() && getToken() !== sessionToken) { setLoading(false); return }
      if (res.ok) {
        const data = await res.json()
        if (!isElectron() && getToken() !== sessionToken) { setLoading(false); return }
        setUser(data.user)
        cacheUser(data.user)
        if (!isElectron()) void syncOffline()
        if (getSharedContext() && navigator.onLine !== false) {
          const renewal = await apiFetch('/api/auth/shared-device', { preserveSession: true })
          if (renewal.ok && getToken() === sessionToken) refreshSharedEnrollment(await renewal.json())
        }
      } else if (!cached) {
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
    if (!sharedDevice || !getSharedContext()) return
    const renew = () => { if (navigator.onLine !== false) void loadMe() }
    const timer = setInterval(renew, 12 * 60 * 60 * 1000)
    window.addEventListener('online', renew)
    return () => { clearInterval(timer); window.removeEventListener('online', renew) }
  }, [loadMe, sharedDevice?.id, user?.id])

  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null)
      onSessionChanged({ signedIn: false })
    }
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
    if (getSharedDevice() && !data.user.is_admin) throw new Error('Esta caja usa acceso por PIN. Para configurar o recuperar el equipo, entra con la cuenta de administración.')
    setToken(data.token)
    setUser(data.user)
    setLoading(false)
    cacheUser(data.user)
    setSharedLocked(false)
    onSessionChanged({ signedIn: true })
    return data.user
  }

  const register = async ({ email, password, store_name, plan }) => {
    if (getSharedDevice()) throw new Error('Este dispositivo ya está vinculado a una tienda. Usa el acceso por PIN o la administración del dispositivo.')
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, store_name, plan }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'No se pudo crear la cuenta')
    setToken(data.token)
    setUser(data.user)
    setLoading(false)
    cacheUser(data.user)
    onSessionChanged({ signedIn: true })
    return data.user
  }

  // Los ajustes de la tienda (tasas, techo) cambiaron en el servidor: se
  // reflejan ya y quedan en el cache para abrir sin internet con ellos.
  const updateUser = (next) => {
    setUser(next)
    if (!isElectron()) cacheUser(next)
  }

  // Quien llama es responsable de comprobar antes que no queden ventas sin
  // subir (ver getLogoutBlockers en Layout.jsx).
  const logout = () => {
    if (getSharedContext()) { lockSharedDevice(); return }
    clearToken()
    setUser(null)
    onSessionChanged({ signedIn: false })
  }

  const completeSharedSetup = () => {
    clearToken()
    sharedGuard.current = { hasCart: false, busy: false }
    setUser(null)
    setLoading(false)
    lockSharedDevice()
    setSharedDevice(getSharedDevice())
    setSharedLocked(true)
  }
  const ensureHandover = async (nextId) => {
    const prior = getLastSharedAccount()?.split(':')[1]
    if (!prior || (nextId != null && Number(prior) === Number(nextId))) return
    if (sharedGuard.current.busy) throw new Error('Espera a que termine el cobro.')
    const draftKey = `mypimes_shared_cart:${getSharedDevice().id}:${prior}`
    let draft
    try { draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null') } catch { /* la protección en memoria sigue activa */ }
    if (sharedGuard.current.hasCart || draft?.cart?.length) throw new Error('Cobra o vacía el carrito antes de cambiar de cajero. Puedes volver a entrar con el PIN del cajero anterior.')
    if ((await sharedHandoverStatus()).hasOpenOperations) throw new Error('Cierra la caja del cajero anterior antes del relevo. La caja continua está desactivada.')
  }
  const unlockCashier = async (id, pin) => {
    await ensureHandover(id)
    const result = await unlockSharedCashier(id, pin)
    sharedGuard.current = { hasCart: false, busy: false }
    setUser(result.user)
    setSharedLocked(false)
    setLoading(false)
    onSessionChanged({ signedIn: true })
    void loadMe()
    return result.user
  }
  const lockShared = () => {
    if (sharedGuard.current.busy) throw new Error('Espera a que termine el cobro.')
    lockSharedDevice()
  }
  const switchCashier = async () => { await ensureHandover(); lockShared() }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser, refreshUser: loadMe,
      sharedDevice, sharedLocked, unlockCashier, lockShared, switchCashier, completeSharedSetup, setSharedGuard }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
