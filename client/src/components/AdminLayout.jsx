import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, LayoutDashboard, Monitor, ShieldCheck, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import '../admin.css'

const sections = [
  { to: '/admin', label: 'Vista general', icon: LayoutDashboard, end: true },
  { to: '/admin/accounts', label: 'Cuentas', icon: Users },
  { to: '/admin/devices', label: 'Dispositivos', icon: Monitor },
]

export default function AdminLayout() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const current = sections.find(section => section.to === pathname) || sections[0]
  return (
    <div className="admin-shell">
      <a href="#admin-content" className="admin-skip">Saltar al contenido</a>
      <aside className="admin-sidebar">
        <Link to="/admin" className="admin-brand"><span><ShieldCheck size={23} /></span><div>Mi Tienda<small>CONSOLA DE ADMINISTRACIÓN</small></div></Link>
        <p className="admin-nav-label">PLATAFORMA</p>
        <nav aria-label="Administración privada" className="admin-navigation">
          {sections.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end}
            className={({ isActive }) => `admin-nav-link ${isActive ? 'is-active' : ''}`}>
            <Icon size={19} /><span>{label}</span><ArrowUpRight size={15} className="admin-nav-arrow" />
          </NavLink>)}
        </nav>
        <div className="admin-sidebar-footer">
          <div className="admin-access"><ShieldCheck size={18} /><div>Acceso restringido<small>Administración del sistema</small></div></div>
          <Link to="/pos" className="admin-return" title="Volver a mi tienda"><ArrowLeft size={16} /> Volver a mi tienda</Link>
        </div>
      </aside>
      <div className="admin-workspace">
        <header className="admin-topbar">
          <div className="admin-breadcrumb">Administración <span>/</span> <strong>{current.label}</strong></div>
          <div className="admin-identity"><span className="admin-avatar">{(user?.email || 'A').slice(0, 1).toUpperCase()}</span><div><strong>Administrador</strong><small>{user?.email}</small></div></div>
        </header>
        <main id="admin-content" tabIndex={-1} className="admin-content"><Outlet /></main>
      </div>
    </div>
  )
}
