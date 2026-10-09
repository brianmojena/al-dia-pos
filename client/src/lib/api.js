import { clearToken, isElectron, networkFetch } from './network.js'
import { getCachedUser } from './offlineCache.js'
import { offlineRequest, handlesOffline } from './offlineClient.js'
export { getToken, setToken, clearToken, isElectron } from './network.js'

export async function apiFetch(path, options = {}) {
  if (isElectron()) {
    const { ok, status, data } = await window.electronAPI.request(options.method || 'GET', path, options.body ? JSON.parse(options.body) : undefined)
    if (status === 401) {
      clearToken()
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
    return { ok, status, json: async () => data }
  }
  if (handlesOffline(path, options.method || 'GET')) return offlineRequest(path, options)
  return networkFetch(path, { preserveSession: !!getCachedUser(), ...options })
}
