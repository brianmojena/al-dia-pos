import { useState } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Package, ShoppingCart, ClipboardList, Calculator, LogOut, CloudOff } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { flushQueue, getLogoutBlockers } from '../lib/salesQueue'
import SyncStatus from './SyncStatus'

// ownerOnly no es solo cosmética: el servidor devuelve 403 en esas rutas para
// un cajero (ver middleware/auth.js). Ocultarlas evita que la caja muestre
// pantallas que solo darían un error.
const navItems = [
  { to: '/pos',       icon: ShoppingCart,    label: 'Venta'                        },
  { to: '/caja',      icon: Calculator,      label: 'Caja'                         },
  { to: '/dashboard', icon: LayoutDashboard, label: 'Inicio',    ownerOnly: true   },
  // Productos lo ve también el empleado: puede dar de alta mercancía nueva.
  // Editar y borrar sigue siendo del dueño (lo decide el servidor y la caja).
  { to: '/products',  icon: Package,         label: 'Productos'                    },
  { to: '/sales',     icon: ClipboardList,   label: 'Historial', ownerOnly: true   },
]

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const isOwner = user?.role !== 'cajero'
  const visibleNav = navItems.filter(item => isOwner || !item.ownerOnly)

  // Cerrar sesión con ventas sin subir no las borra, pero las deja esperando
  // hasta que ESTA cuenta vuelva a entrar en este teléfono — y mientras, el
  // dueño no las ve. Por eso no se deja salir hasta que suban.
  const [blockers, setBlockers] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [stillOffline, setStillOffline] = useState(false)

  const doLogout = () => {
    setBlockers(null)
    logout()
    navigate('/login')
  }

  const handleLogout = async () => {
    const found = await getLogoutBlockers().catch(() => ({ total: 0 }))
    if (found.total > 0) {
      setStillOffline(false)
      setBlockers(found)
      return
    }
    doLogout()
  }

  const uploadNow = async () => {
    setUploading(true)
    setStillOffline(false)
    try {
      await flushQueue()
      const found = await getLogoutBlockers().catch(() => ({ total: 0 }))
      if (found.total === 0) return doLogout()
      setBlockers(found)
      setStillOffline(true)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-[#F5F5F7] overflow-hidden">
      {/* Top header */}
      <header className="bg-white border-b border-gray-200 px-5 py-3.5 flex items-center gap-3 flex-shrink-0">
        <div className="w-8 h-8 bg-[#007AFF] rounded-lg flex items-center justify-center text-white font-bold text-sm">M</div>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-gray-900 tracking-tight truncate">
            {user?.store_name || 'Mi Tienda'}
          </h1>
        </div>
        <SyncStatus />
        {user && (
          // Para un cajero, saber en qué cuenta está abierta la caja importa
          // más que el plan del negocio.
          <span className={`hidden sm:inline text-[11px] font-semibold px-2.5 py-1 rounded-full ${
            !isOwner              ? 'bg-gray-200 text-gray-600'
            : user.plan === 'premium' ? 'bg-blue-100 text-blue-700'
                                      : 'bg-purple-100 text-purple-700'
          }`}>
            {!isOwner ? 'Cajero' : user.plan === 'premium' ? 'Premium' : 'Plan Dev'}
          </span>
        )}
        <button
          onClick={handleLogout}
          title="Cerrar sesión"
          className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <LogOut size={18} />
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — desktop */}
        <nav className="hidden md:flex flex-col w-56 bg-white border-r border-gray-200 py-5 px-3 gap-1 flex-shrink-0">
          {visibleNav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-[#007AFF] text-white'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`
              }
            >
              <Icon size={20} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      {/* Bottom nav — mobile/tablet */}
      <nav className="md:hidden flex bg-white border-t border-gray-200 flex-shrink-0 safe-area-bottom">
        {visibleNav.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center py-2.5 gap-1 text-xs font-medium transition-colors ${
                isActive ? 'text-[#007AFF]' : 'text-gray-400'
              }`
            }
          >
            <Icon size={22} />
            {label}
          </NavLink>
        ))}
      </nav>

      {blockers && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="logout-blocked-title"
               className="bg-white rounded-3xl shadow-xl w-full max-w-sm p-6">
            <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center mb-4">
              <CloudOff size={24} />
            </div>
            <h2 id="logout-blocked-title" className="text-lg font-bold text-gray-900">
              {blockers.pending > 0
                ? `${blockers.pending === 1 ? 'Queda 1 venta' : `Quedan ${blockers.pending} ventas`} sin subir`
                : 'Hay ventas rechazadas sin avisar al dueño'}
            </h2>
            <p className="text-sm text-gray-600 mt-2">
              Todavía no puedes cerrar sesión. Las ventas están guardadas en este teléfono,
              pero el dueño no las verá hasta que se suban.
            </p>
            <p className="text-sm text-gray-600 mt-2">
              Conéctate a internet y toca <strong>Subir ahora</strong>.
            </p>
            {stillOffline && (
              <p className="text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 mt-3">
                No se pudieron subir todas. Revisa la conexión y vuelve a intentarlo.
              </p>
            )}
            <div className="flex flex-col gap-2 mt-5">
              <button
                onClick={uploadNow}
                disabled={uploading}
                className="w-full py-3 rounded-2xl bg-[#007AFF] text-white font-semibold disabled:opacity-60"
              >
                {uploading ? 'Subiendo…' : 'Subir ahora'}
              </button>
              <button
                onClick={() => setBlockers(null)}
                disabled={uploading}
                className="w-full py-3 rounded-2xl bg-gray-100 text-gray-700 font-semibold"
              >
                Seguir en la app
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
