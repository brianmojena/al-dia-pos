import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { CheckCircle2, MonitorSmartphone, RefreshCw, ShieldCheck } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { formatDateTime } from '../lib/dates'
import SharedDeviceSetup from '../components/SharedDeviceSetup'

// Etiqueta visual del estado. El cálculo real (locked, días de prueba) lo
// manda el servidor: aquí solo se pinta.
const estadoDe = (shop) => {
  if (shop.plan_status !== 'pending') return { texto: 'Activa', clase: 'bg-green-100 text-green-700' }
  if (shop.locked) return { texto: 'Prueba vencida', clase: 'bg-red-100 text-red-700' }
  const dias = shop.trial_days_left ?? 0
  return { texto: `Prueba · ${dias} ${dias === 1 ? 'día' : 'días'}`, clase: 'bg-amber-100 text-amber-700' }
}

/**
 * Panel de administración (solo la cuenta de ADMIN_EMAILS): las tiendas
 * registradas, pendientes primero, con botón para confirmarlas cuando el
 * pago se cobra en persona.
 */
export default function Admin() {
  const { user } = useAuth()
  const [shops, setShops] = useState(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(null)
  // Tienda cuya ficha de caja compartida está abierta (una a la vez).
  const [setupShop, setSetupShop] = useState(null)

  const load = async () => {
    setError('')
    try {
      const res = await apiFetch('/api/admin/shops')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las tiendas')
      setShops(data.shops)
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => { if (user?.is_admin) void load() }, [user?.is_admin])

  // El servidor también lo bloquea (403); esto es para no enseñar la pantalla.
  if (!user?.is_admin) return <Navigate to="/" replace />

  const confirmar = async (id) => {
    setConfirming(id)
    setError('')
    try {
      const res = await apiFetch(`/api/admin/shops/${id}/confirm`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo confirmar')
      setShops((prev) => prev.map((s) => (s.id === id ? { ...s, ...data.shop } : s)))
    } catch (err) {
      setError(err.message)
    } finally {
      setConfirming(null)
    }
  }

  const pendientes = shops?.filter((s) => s.plan_status === 'pending').length ?? 0

  return (
    <div className="p-5 max-w-3xl mx-auto w-full">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 bg-[#007AFF] rounded-xl flex items-center justify-center text-white">
          <ShieldCheck size={20} />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Administración</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {shops === null
              ? 'Cargando tiendas…'
              : `${shops.length} tienda${shops.length === 1 ? '' : 's'} · ${pendientes} pendiente${pendientes === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4 bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl">{error}</div>
      )}

      {shops === null ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : shops.length === 0 ? (
        <p className="text-center text-gray-400 text-sm py-16">Todavía no hay tiendas registradas.</p>
      ) : (
        <div className="mt-5 space-y-3">
          {shops.map((shop) => {
            const estado = estadoDe(shop)
            const setupOpen = setupShop === shop.id
            return (
              <div key={shop.id}>
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 truncate">{shop.store_name}</p>
                    <p className="text-xs text-gray-400 truncate">
                      {shop.email} · {shop.plan_label} · {shop.team_size} cuenta{shop.team_size === 1 ? '' : 's'}
                    </p>
                    <p className="text-xs text-gray-400">Registrada el {formatDateTime(shop.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${estado.clase}`}>
                      {estado.texto}
                    </span>
                    {shop.plan_status === 'pending' && (
                      <button
                        onClick={() => confirmar(shop.id)}
                        disabled={confirming === shop.id}
                        className="flex items-center gap-1.5 bg-[#007AFF] text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50"
                      >
                        {confirming === shop.id
                          ? <RefreshCw size={14} className="animate-spin" />
                          : <CheckCircle2 size={14} />}
                        Confirmar
                      </button>
                    )}
                    <button
                      onClick={() => setSetupShop(setupOpen ? null : shop.id)}
                      className="flex items-center gap-1.5 bg-white border border-gray-200 text-gray-700 px-3 py-2 rounded-xl text-sm font-semibold hover:bg-gray-50 active:scale-95 transition-all"
                    >
                      <MonitorSmartphone size={14} />
                      {setupOpen ? 'Ocultar' : 'Caja compartida'}
                    </button>
                  </div>
                </div>
                {setupOpen && (
                  <SharedDeviceSetup shop={shop} onInstalled={() => setSetupShop(null)} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
