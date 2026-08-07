import { useState, useEffect } from 'react'
import { CloudOff, AlertTriangle } from 'lucide-react'
import { isElectron } from '../lib/api'

// Solo existe dentro de la app de escritorio — la web no tiene cola offline.
// Discreto a propósito: no se muestra nada cuando no hay nada pendiente,
// para no generar ansiedad de "¿esto está fallando?" en el día a día normal.
export default function SyncStatus() {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    if (!isElectron()) return
    return window.electronAPI.onSyncStatus(setStatus)
  }, [])

  if (!isElectron() || !status) return null
  if (!status.pending) return null

  const hasConflict = status.conflicts > 0

  return (
    <span
      title={hasConflict
        ? 'Alguna venta necesita revisión manual — el resto sigue sincronizando'
        : 'Ventas guardadas localmente, esperando conexión para subir a la nube'}
      className={`hidden sm:flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full ${
        hasConflict ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-500'
      }`}
    >
      {hasConflict ? <AlertTriangle size={12} /> : <CloudOff size={12} />}
      {status.pending} por sincronizar
    </span>
  )
}
