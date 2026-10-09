import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { localSyncStatus, retrySync, resolveProductConflict } from '../lib/offlineClient.js'
import { isElectron } from '../lib/network.js'

export default function OfflineStatus() {
  const [status, setStatus] = useState(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [resolutionError, setResolutionError] = useState('')
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    if (isElectron()) return
    const read = () => { localSyncStatus().then(setStatus).catch(() => setStatus({ error: 'No se puede acceder al almacenamiento de este dispositivo' })); setOnline(navigator.onLine) }
    read()
    window.addEventListener('local:data-changed', read)
    window.addEventListener('online', read)
    window.addEventListener('offline', read)
    return () => { window.removeEventListener('local:data-changed', read); window.removeEventListener('online', read); window.removeEventListener('offline', read) }
  }, [])
  if (isElectron() || !status) return null
  const retry = async () => { setRetrying(true); try { await retrySync() } finally { setRetrying(false) } }
  const resolve = async (choice) => {
    if (choice === 'local' && !confirm('Esto reemplazará el nombre, los precios y el stock de la nube por los cambios guardados en este dispositivo. ¿Continuar?')) return
    setRetrying(true); setResolutionError('')
    try { await resolveProductConflict(choice) } catch (error) { setResolutionError(error.message) }
    finally { setRetrying(false) }
  }
  if (online && status.initialized && !status.pending && !status.error) return null
  return (
    <div role="status" className={`px-5 py-2.5 text-xs border-b flex flex-wrap items-center gap-2 ${status.conflicts ? 'bg-red-50 text-red-700 border-red-100' : 'bg-amber-50 text-amber-800 border-amber-100'}`}>
      <span className="flex-1">
        {!online ? 'Sin conexión. Puedes seguir trabajando con los datos de este dispositivo.' : !status.initialized ? 'Preparando los datos para trabajar sin conexión.' : `${status.pending || 0} cambios guardados pendientes de subir.`}
        {status.lastSynced && <span className="ml-1">Última sincronización: {new Date(status.lastSynced).toLocaleString('es-ES')}.</span>}
        {status.error && <span className="block mt-1">{status.error}</span>}
      </span>
      {online && status.problem?.kind === 'product' && status.problem.productId > 0 && (
        <div className="basis-full flex flex-wrap gap-3 items-center">
          <span>Revisar: {status.problem.result.name || 'producto eliminado'}. Se conservan todos los cambios pendientes.</span>
          <button disabled={retrying} onClick={() => resolve('cloud')} className="font-semibold underline">Usar datos de la nube</button>
          {status.problem.errorStatus === 409 && <button disabled={retrying} onClick={() => resolve('local')} className="font-semibold underline">Subir mis cambios</button>}
          {resolutionError && <span role="alert">{resolutionError}</span>}
        </div>
      )}
      {online && <button onClick={retry} disabled={retrying} className="font-semibold underline disabled:opacity-50">{retrying ? 'Sincronizando…' : 'Sincronizar ahora'}</button>}
      {/sesi[oó]n/i.test(status.error || '') && <Link to="/login" className="font-semibold underline">Renovar sesión</Link>}
    </div>
  )
}
