import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Package, ShoppingCart, ClipboardList, Calculator, LogOut } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { isElectron } from '../lib/api'
import SyncStatus from './SyncStatus'

// ownerOnly no es solo cosmética: el servidor devuelve 403 en esas rutas para
// un cajero (ver middleware/auth.js). Ocultarlas evita que la caja muestre
// pantallas que solo darían un error.
const navItems = [
  { to: '/pos',       icon: ShoppingCart,    label: 'Venta'                        },
  { to: '/caja',      icon: Calculator,      label: 'Caja',      webOnly:   true   },
  { to: '/dashboard', icon: LayoutDashboard, label: 'Inicio',    ownerOnly: true   },
  { to: '/products',  icon: Package,         label: 'Productos', ownerOnly: true   },
  { to: '/sales',     icon: ClipboardList,   label: 'Historial', ownerOnly: true   },
]

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const isOwner = user?.role !== 'cajero'
  // El router local del escritorio (desktop/src/router.js) todavía no conoce
  // /api/cash-closes y devolvería 404, así que allí el cierre se esconde en vez
  // de mostrar una pestaña que no funciona. Quitar este webOnly en cuanto el
  // escritorio implemente los cierres contra su SQLite local.
  const visibleNav = navItems.filter(item =>
    (isOwner || !item.ownerOnly) && !(item.webOnly && isElectron())
  )

  const handleLogout = () => {
    logout()
    navigate('/login')
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
    </div>
  )
}
