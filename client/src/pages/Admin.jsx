import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Monitor, Globe, RefreshCw, Search, ShieldCheck, Users, Store, Activity, ChevronDown } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { formatDateTime } from '../lib/dates'

const labels = {
  overview: ['Tu plataforma, de un vistazo', 'Supervisa las cuentas y las instalaciones de todas las tiendas.'],
  accounts: ['Cuentas', 'Consulta quién usa la plataforma y los dispositivos asociados a cada cuenta.'],
  devices: ['Dispositivos', 'Revisa las instalaciones registradas y su actividad por cuenta.'],
}
const roleLabel = role => role === 'cajero' ? 'Cajero' : 'Dueño'

export default function Admin({ view = 'overview' }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('all')
  const [activity, setActivity] = useState('all')
  const [platform, setPlatform] = useState('all')
  const [sort, setSort] = useState('email')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/admin/devices')
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) setReport(null)
        throw new Error(data.error || 'No se pudo cargar el panel')
      }
      setReport(data)
    } catch (err) {
      setError(err instanceof TypeError ? 'Conéctate a internet para consultar el panel.' : err.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  useEffect(() => { setSearch(''); setRole('all'); setActivity('all'); setPlatform('all'); setSort('email') }, [view])

  const allAccounts = report?.accounts || []
  const allDevices = allAccounts.flatMap(account => account.devices.map(device => ({ ...device, account })))
  const recentUnique = new Set(allDevices.filter(device => device.seen_recently).map(device => device.device_id)).size
  const owners = allAccounts.filter(account => account.role !== 'cajero').length
  const unregistered = allAccounts.filter(account => account.device_count === 0).length
  const query = search.trim().toLowerCase()
  const matchesAccount = account => `${account.email} ${account.store_name}`.toLowerCase().includes(query) && (role === 'all' || (role === 'cajero' ? account.role === 'cajero' : account.role !== 'cajero'))
  const accounts = allAccounts.filter(account => matchesAccount(account) && (activity === 'all' || (activity === 'recent' ? account.recent_device_count > 0 : activity === 'none' ? account.device_count === 0 : account.device_count > 0 && account.recent_device_count === 0)))
    .sort((a, b) => sort === 'devices' ? b.device_count - a.device_count || a.email.localeCompare(b.email) : a.email.localeCompare(b.email))
  const devices = allDevices.filter(device => `${device.account.email} ${device.account.store_name} ${device.label} ${device.device_id}`.toLowerCase().includes(query) && (platform === 'all' || device.platform === platform) && (activity === 'all' || (activity === 'recent' ? device.seen_recently : !device.seen_recently)))
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
  const resetFilters = () => { setSearch(''); setRole('all'); setActivity('all'); setPlatform('all'); setSort('email') }
  const [title, description] = labels[view]

  return (
    <div>
      <div className="admin-page-heading">
        <div><p className="admin-eyebrow">CONTROL DE LA PLATAFORMA</p><h1>{title}</h1><p>{description}</p></div>
        <button onClick={load} disabled={loading} className="admin-button"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} />{loading ? 'Actualizando…' : 'Actualizar'}</button>
      </div>
      {error && <div role="alert" className="admin-error">{error}{report && <span> Se muestran los datos de la última consulta correcta.</span>}<button onClick={load} disabled={loading}>Reintentar</button></div>}
      {loading && !report && <div role="status" className="admin-loading"><RefreshCw size={22} className="animate-spin" /> Cargando cuentas y dispositivos…</div>}
      {report?.device_registry_available === false && <div role="status" className="admin-note" style={{ marginBottom: 20 }}><ShieldCheck size={17} /><p>Estas son las cuentas reales. El registro de dispositivos todavía no está activado; los dispositivos aparecerán cuando se habilite y los clientes se conecten.</p></div>}
      {report && <>
        {view === 'overview' && <>
          <div className="admin-metrics">
            {[
              { label: 'Cuentas registradas', value: allAccounts.length, detail: `${owners} dueños · ${allAccounts.length - owners} cajeros`, icon: Users },
              { label: 'Cuentas de dueños', value: owners, detail: 'Cuentas principales de tienda', icon: Store },
              { label: 'Instalaciones únicas', value: report.unique_device_count, detail: 'Deduplicadas entre cuentas', icon: Monitor },
              { label: 'Actividad reciente', value: recentUnique, detail: 'Instalaciones vistas en 30 días', icon: Activity },
            ].map(({ label, value, detail, icon: Icon }) => <div key={label} className="admin-metric"><div><span>{label}</span><Icon size={19} /></div><strong>{value}</strong><small>{detail}</small></div>)}
          </div>
          <div className="admin-overview-grid">
            <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Distribución de cuentas</h2><p>Acceso a la plataforma por rol</p></div><Users size={20} /></div>
              {[['Dueños', owners], ['Cajeros', allAccounts.length - owners]].map(([label, count]) => <div key={label} className="admin-distribution"><div><span>{label}</span><strong>{count}</strong></div><progress aria-label={label} value={count} max={allAccounts.length || 1} /></div>)}
              <Link to="/admin/accounts" className="admin-text-link">Explorar cuentas <ArrowRight size={16} /></Link>
            </section>
            <section className="admin-panel admin-attention"><div className="admin-panel-heading"><div><h2>Registro de dispositivos</h2><p>Visibilidad sobre las instalaciones</p></div><ShieldCheck size={20} /></div><strong className="admin-attention-count">{unregistered}</strong><p>cuentas sin dispositivos registrados</p><small>El registro comienza cuando una cuenta se conecta desde una versión compatible.</small><Link to="/admin/devices" className="admin-text-link">Revisar dispositivos <ArrowRight size={16} /></Link></section>
          </div>
        </>}
        <section className="admin-panel admin-directory" aria-busy={loading}>
          <div className="admin-panel-heading"><div><h2>{view === 'devices' ? 'Registro de instalaciones' : view === 'overview' ? 'Directorio de cuentas' : 'Todas las cuentas'}</h2><p>{view === 'devices' ? `${devices.length} registros por cuenta · un equipo puede aparecer varias veces` : `${accounts.length} de ${allAccounts.length} cuentas`}</p></div><span className="admin-tag">Solo consulta</span></div>
          <div className="admin-filters">
            <label className="admin-search"><Search size={17} /><span className="sr-only">Buscar {view === 'devices' ? 'cuenta, tienda o dispositivo' : 'por email o tienda'}</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={view === 'devices' ? 'Buscar cuenta, tienda o dispositivo…' : 'Buscar por email o tienda…'} /></label>
            {view === 'devices' ? <label><span className="sr-only">Plataforma</span><select aria-label="Plataforma" value={platform} onChange={event => setPlatform(event.target.value)}><option value="all">Todas las plataformas</option><option value="web">Web / PWA</option><option value="desktop">Escritorio</option></select></label> : <label><span className="sr-only">Rol de cuenta</span><select aria-label="Rol de cuenta" value={role} onChange={event => setRole(event.target.value)}><option value="all">Todos los roles</option><option value="owner">Dueños</option><option value="cajero">Cajeros</option></select></label>}
            <label><span className="sr-only">Actividad de dispositivos</span><select aria-label="Actividad de dispositivos" value={activity} onChange={event => setActivity(event.target.value)}><option value="all">Toda la actividad</option><option value="recent">Actividad en 30 días</option><option value="inactive">Sin actividad en 30 días</option>{view !== 'devices' && <option value="none">Sin dispositivos</option>}</select></label>
            {view !== 'devices' && <label><span className="sr-only">Ordenar cuentas</span><select aria-label="Ordenar cuentas" value={sort} onChange={event => setSort(event.target.value)}><option value="email">Email A–Z</option><option value="devices">Más dispositivos</option></select></label>}
          </div>
          {view === 'devices' ? <div className="admin-table-scroll"><table className="admin-device-table"><thead><tr><th>Dispositivo</th><th>Cuenta / tienda</th><th>Actividad</th><th>Última conexión</th><th>Primera conexión</th></tr></thead><tbody>{devices.map(device => <tr key={`${device.account.id}-${device.device_id}`}><td><div className="admin-device-name">{device.platform === 'desktop' ? <Monitor size={18} /> : <Globe size={18} />}<strong>{device.label}</strong></div><code>{device.device_id}</code></td><td><strong>{device.account.email}</strong><small>{device.account.store_name} · {roleLabel(device.account.role)}</small></td><td><span className={`admin-status ${device.seen_recently ? 'is-recent' : ''}`}>{device.seen_recently ? 'Reciente' : 'Sin actividad reciente'}</span></td><td>{formatDateTime(device.last_seen_at)}</td><td>{formatDateTime(device.first_seen_at)}</td></tr>)}</tbody></table></div> : <div className="admin-account-list">
            <div className="admin-account-columns"><span>Cuenta / tienda</span><span>Rol</span><span>Dispositivos</span><span>Detalle</span></div>
            {accounts.map(account => <details key={account.id} className="admin-account"><summary><div className="admin-account-info"><span className="admin-account-avatar">{(account.store_name || account.email).slice(0, 1).toUpperCase()}</span><div><strong>{account.email}</strong><small>{account.store_name}</small></div></div><span className={`admin-role ${account.role === 'cajero' ? '' : 'is-owner'}`}>{roleLabel(account.role)}</span><div className="admin-account-count"><strong>{account.device_count}</strong><small>{account.recent_device_count} recientes</small></div><ChevronDown size={17} className="admin-expand" /></summary><div className="admin-account-detail"><p>Cuenta creada: {formatDateTime(account.created_at)}</p>{account.devices.length === 0 ? <p>Sin dispositivos registrados. Aparecerán cuando esta cuenta use una versión actualizada con internet.</p> : account.devices.map(device => <div key={device.device_id} className="admin-detail-device">{device.platform === 'desktop' ? <Monitor size={19} /> : <Globe size={19} />}<div><strong>{device.label}</strong><small>Última actividad: {formatDateTime(device.last_seen_at)} · Primera conexión: {formatDateTime(device.first_seen_at)}</small><code>{device.device_id}</code></div><span className={`admin-status ${device.seen_recently ? 'is-recent' : ''}`}>{device.seen_recently ? 'Reciente' : 'Sin actividad reciente'}</span></div>)}</div></details>)}
          </div>}
          {(view === 'devices' ? devices.length : accounts.length) === 0 && <div className="admin-empty"><Search size={26} /><h3>{allAccounts.length ? 'No hay resultados con estos filtros' : 'Todavía no hay cuentas registradas'}</h3><p>{allAccounts.length ? 'Prueba otra búsqueda o restablece los filtros.' : 'Las cuentas aparecerán cuando se registren en la plataforma.'}</p>{allAccounts.length > 0 && <button className="admin-button" onClick={resetFilters}>Restablecer filtros</button>}</div>}
          <div className="admin-directory-footer">Última consulta: {formatDateTime(report.generated_at)}</div>
        </section>
        <div className="admin-note"><ShieldCheck size={17} /><p>La actividad reciente corresponde a los últimos 30 días; no indica sesiones abiertas ni equipos conectados ahora. Una instalación puede usarse en varias cuentas. Borrar los datos del navegador o reinstalar la app genera un identificador nuevo.</p></div>
      </>}
    </div>
  )
}
