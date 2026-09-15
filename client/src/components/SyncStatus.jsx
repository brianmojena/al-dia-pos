import { useState, useEffect } from 'react'
import { CloudOff, AlertTriangle } from 'lucide-react'
import { isElectron } from '../lib/api'
import { subscribe as subscribeQueue } from '../lib/salesQueue'

// En escritorio lee el estado del outbox de Electron por IPC; en la web lee la
// cola de IndexedDB (src/lib/salesQueue.js) — misma idea, dos almacenamientos
// distintos. Discreto a propósito: no se muestra nada cuando no hay nada
// pendiente, para no generar ansiedad en el día a día normal.
//
// Visible TAMBIÉN en el móvil. Antes estaba oculto en pantallas pequeñas, así
// que el empleado que vende desde el teléfono no tenía forma de saber si le
// quedaban ventas por subir antes de irse.
export default function SyncStatus() {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    if (isElectron()) {
      return window.electronAPI.onSyncStatus(setStatus)
    }
    return subscribeQueue(({ pending, rejected, otherAccounts }) =>
      setStatus({ pending, conflicts: 0, rejected: rejected.length, otherAccounts })
    )
  }, [])

  if (!status) return null
  const pending = status.pending || 0
  const rejected = status.rejected || 0
  const conflicts = status.conflicts || 0
  const otherAccounts = status.otherAccounts || 0
  if (!pending && !rejected && !otherAccounts) return null

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {otherAccounts > 0 && (
        // No se suben con esta sesión: se esperan a que entre la cuenta que las
        // cobró. Visible para que nadie crea que se perdieron.
        <span
          title="Ventas guardadas en este teléfono por otra cuenta. Se subirán cuando esa cuenta inicie sesión aquí."
          className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full bg-amber-100 text-amber-800"
        >
          <CloudOff size={12} />
          {otherAccounts} <span className="hidden min-[400px]:inline">de otra cuenta</span>
        </span>
      )}
      {rejected > 0 && (
        <span
          title="Ventas cobradas que el sistema rechazó al subirlas — revisa la pantalla de Venta"
          className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full bg-red-100 text-red-700"
        >
          <AlertTriangle size={12} />
          {rejected} <span className="hidden min-[400px]:inline">{rejected === 1 ? 'rechazada' : 'rechazadas'}</span>
        </span>
      )}
      {pending > 0 && (
        <span
          title={conflicts > 0
            ? 'Alguna venta necesita revisión manual — el resto sigue sincronizando'
            : 'Ventas guardadas en este equipo, esperando internet para subir'}
          className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full ${
            conflicts > 0 ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'
          }`}
        >
          {conflicts > 0 ? <AlertTriangle size={12} /> : <CloudOff size={12} />}
          {pending} por subir
        </span>
      )}
    </div>
  )
}
