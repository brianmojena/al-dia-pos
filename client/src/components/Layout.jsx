import { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { LayoutDashboard, Package, ShoppingCart, ClipboardList, Calculator, ArrowLeftRight, Warehouse, LogOut, CloudOff, ShieldCheck, Sparkles, MoreHorizontal, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { flushQueue, getLogoutBlockers } from '../lib/salesQueue'
import { splitMobileNav, isMoreActive } from '../lib/mobileNav.js'
import OfflineStatus from './OfflineStatus'
import { localSyncStatus, retrySync } from '../lib/offlineClient.js'
import { isElectron } from '../lib/network.js'
import SyncStatus from './SyncStatus'
import { planLabel } from '../lib/plans'
import { getSharedContext, getSharedMembers } from '../lib/sharedDevice.js'

// ownerOnly no es solo cosmética: el servidor devuelve 403 en esas rutas para
// un cajero (ver middleware/auth.js). Ocultarlas evita que la caja muestre
// pantallas que solo darían un error.
const navItems = [
  { to: '/pos',       icon: ShoppingCart,    label: 'Venta'                        },
  { to: '/caja',      icon: Calculator,      label: 'Caja'                         },
  { to: '/divisas',   icon: ArrowLeftRight,  label: 'Divisas'                      },
  { to: '/dashboard', icon: LayoutDashboard, label: 'Inicio',    ownerOnly: true   },
  // Productos lo ve también el empleado: puede dar de alta mercancía nueva.
  // Editar y borrar sigue siendo del dueño (lo decide el servidor y la caja).
  { to: '/products',  icon: Package,         label: 'Productos'                    },
  { to: '/almacen',   icon: Warehouse,       label: 'Almacén',   warehouse: true   },
  { to: '/sales',     icon: ClipboardList,   label: 'Historial'                    },
  // Los informes de auditoría los genera la nube; el escritorio offline no los tiene.
  { to: '/auditoria', icon: Sparkles,        label: 'Auditoría',   ownerOnly: true, cloudOnly: true },
  // Panel de administración: confirmar tiendas nuevas (ver pages/Admin.jsx).
  // Solo existe para la cuenta de administración (is_admin del servidor).
  { to: '/admin',     icon: ShieldCheck,     label: 'Admin',     adminOnly: true   },
]

export default function Layout() {
  const { user, logout, lockShared, switchCashier } = useAuth()
  const shared = getSharedContext()
  const activeName = shared && (getSharedMembers().find((c) => Number(c.id) === Number(user?.id))?.display_name || user?.email)
  const [handoverError, setHandoverError] = useState('')
  const sharedAction = async (action) => { setHandoverError(''); try { await action() } catch (e) { setHandoverError(e.message) } }
  const navigate = useNavigate()
  const location = useLocation()
  const isOwner = user?.role !== 'cajero'
  // Una tienda puede tener el almacén apagado (users.warehouse_enabled en el servidor).
  const visibleNav = navItems.filter(item =>
    (isOwner || !item.ownerOnly)
    && (!item.adminOnly || user?.is_admin)
    && !(item.cloudOnly && isElectron())
    && !(item.warehouse && user?.warehouse_enabled === false))

  // Navegación móvil: divide en 4 principales + menú "Más" para evitar saturación
  const [moreOpen, setMoreOpen] = useState(false)
  const { primary, more } = splitMobileNav(visibleNav, { isOwner })

  // Cierra la hoja de "Más" al cambiar de ruta o presionar Escape
  useEffect(() => {
    setMoreOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!moreOpen) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [moreOpen])

  // Cerrar sesión con ventas sin subir no las borra, pero las deja esperando
  // hasta que ESTA cuenta vuelva a entrar en este teléfono — y mientras, el
  // dueño no las ve. Por eso no se deja salir hasta que suban.
  const [blockers, setBlockers] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [stillOffline, setStillOffline] = useState(false)

  const findBlockers = async () => {
    const [legacy, local] = await Promise.all([getLogoutBlockers(), localSyncStatus()])
    return { ...legacy, pending: legacy.pending + local.pending, total: legacy.total + local.pending }
  }
  const doLogout = () => {
    setBlockers(null)
    logout()
    navigate('/login')
  }

  const handleLogout = async () => {
    let found
    try { found = await findBlockers() }
    catch { setBlockers({ total: 1, pending: 0, storageUnavailable: true }); return }
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
      if (isElectron()) await flushQueue()
      else await retrySync()
      const found = await findBlockers()
      if (found.total === 0) return doLogout()
      setBlockers(found)
      setStillOffline(true)
    } catch { setStillOffline(true) } finally {
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
            !isOwner                    ? 'bg-gray-200 text-gray-600'
            : user.plan === 'enterprise' ? 'bg-purple-100 text-purple-700'
                                         : 'bg-blue-100 text-blue-700'
          }`}>
            {!isOwner ? 'Cajero' : `Plan ${planLabel(user.plan)}`}
          </span>
        )}
        {user && isOwner && user.plan_status === 'pending' && user.trial_days_left != null && (
          // Recordatorio de la prueba gratuita mientras administración no confirme.
          <span className="hidden sm:inline text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">
            Prueba · {user.trial_days_left} {user.trial_days_left === 1 ? 'día' : 'días'}
          </span>
        )}
        {!shared && <button
          onClick={handleLogout}
          title="Cerrar sesión"
          className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <LogOut size={18} />
        </button>}
      </header>

      {shared && <div className="bg-white border-b border-gray-200 px-4 py-3 flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-0"><p className="text-sm font-semibold text-gray-900 truncate">Atendiendo: {activeName}</p><p className="text-xs text-gray-500 truncate">{shared.name} · {shared.continuous ? 'Caja continua' : 'Caja por turno'}</p></div>
        <button onClick={() => sharedAction(switchCashier)} className="text-xs font-semibold bg-blue-50 text-[#007AFF] rounded-xl px-3 py-2.5">Cambiar cajero</button>
        <button onClick={() => sharedAction(lockShared)} className="text-xs font-semibold bg-gray-100 text-gray-600 rounded-xl px-3 py-2.5">Bloquear</button>
        {handoverError && <p role="alert" className="basis-full text-xs text-red-700 bg-red-50 rounded-xl p-2">{handoverError}</p>}
      </div>}

      <OfflineStatus />
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
          <Outlet key={user?.id} />
        </main>
      </div>

      {/* Bottom nav — mobile/tablet */}
      <nav className="md:hidden flex bg-white border-t border-gray-200 flex-shrink-0 safe-area-bottom">
        {primary.map(({ to, icon: Icon, label }) => (
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
        {more.length > 0 && (
          <button
            onClick={() => setMoreOpen(true)}
            className={`flex flex-1 flex-col items-center py-2.5 gap-1 text-xs font-medium transition-colors ${
              isMoreActive(more, location.pathname) || moreOpen ? 'text-[#007AFF]' : 'text-gray-400'
            }`}
            aria-label="Más opciones"
            aria-expanded={moreOpen}
            aria-controls="mobile-more-menu"
          >
            <MoreHorizontal size={22} />
            Más
          </button>
        )}
      </nav>

      {/* "Más" sheet — modal overlay + panel anclado abajo */}
      {more.length > 0 && moreOpen && (
        <>
          {/* Overlay para cerrar */}
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/40"
            onClick={() => setMoreOpen(false)}
            aria-hidden="true"
          />
          {/* Panel de la hoja */}
          <div
            id="mobile-more-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Más opciones"
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white rounded-t-3xl shadow-xl safe-area-bottom"
          >
            <div className="p-4 max-h-[70vh] overflow-y-auto">
              {/* Encabezado */}
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-gray-900">Más opciones</h2>
                <button
                  onClick={() => setMoreOpen(false)}
                  className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                  aria-label="Cerrar"
                >
                  <X size={20} />
                </button>
              </div>
              {/* Grid 2 columnas de opciones */}
              <div className="grid grid-cols-2 gap-3">
                {more.map(({ to, icon: Icon, label }) => (
                  <NavLink
                    key={to}
                    to={to}
                    onClick={() => setMoreOpen(false)}
                    className={({ isActive }) =>
                      `flex flex-col items-center justify-center py-4 px-3 rounded-2xl font-medium transition-colors min-h-14 ${
                        isActive
                          ? 'bg-[#007AFF] text-white'
                          : 'bg-gray-50 text-gray-900 hover:bg-gray-100'
                      }`
                    }
                  >
                    <Icon size={24} />
                    <span className="text-sm mt-1 text-center">{label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {blockers && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="logout-blocked-title"
               className="bg-white rounded-3xl shadow-xl w-full max-w-sm p-6">
            <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center mb-4">
              <CloudOff size={24} />
            </div>
            <h2 id="logout-blocked-title" className="text-lg font-bold text-gray-900">
              {blockers.storageUnavailable ? 'No se pudieron comprobar los cambios pendientes' : blockers.pending > 0
                ? `${blockers.pending === 1 ? 'Queda 1 cambio' : `Quedan ${blockers.pending} cambios`} sin subir`
                : 'Hay ventas rechazadas sin avisar al dueño'}
            </h2>
            <p className="text-sm text-gray-600 mt-2">
              Todavía no puedes cerrar sesión. Los cambios están guardados en este teléfono,
              pero el dueño no los verá hasta que se suban.
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
