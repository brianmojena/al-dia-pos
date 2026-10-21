import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, MonitorSmartphone, RefreshCw, ShieldCheck, Sparkles, Store } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { formatDateTime } from '../lib/dates'
import SharedDeviceSetup from '../components/SharedDeviceSetup'
import AuditReportCard from '../components/AuditReportCard'

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
  // Pestaña activa y datos de auditoría (se cargan solo al abrirla).
  const [tab, setTab] = useState('shops')
  const [audit, setAudit] = useState({ health: null, reports: null })
  const [auditError, setAuditError] = useState('')
  const [auditLoading, setAuditLoading] = useState(false)

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

  const loadAudit = async () => {
    setAuditLoading(true)
    setAuditError('')
    try {
      const [healthRes, reportsRes] = await Promise.all([
        apiFetch('/api/admin/audit/health'),
        apiFetch('/api/admin/audit/reports?limit=100'),
      ])
      const [health, reports] = await Promise.all([healthRes.json(), reportsRes.json()])
      if (!healthRes.ok) throw new Error(health.error || 'No se pudo leer el estado del worker')
      if (!reportsRes.ok) throw new Error(reports.error || 'No se pudieron cargar los informes')
      setAudit({ health, reports: Array.isArray(reports) ? reports : [] })
    } catch (err) {
      setAuditError(err.message)
    } finally {
      setAuditLoading(false)
    }
  }

  useEffect(() => {
    if (user?.is_admin && tab === 'audit') void loadAudit()
  }, [tab, user?.is_admin])

  const retryFailed = async () => {
    setAuditLoading(true)
    setAuditError('')
    try {
      const res = await apiFetch('/api/admin/audit/jobs/retry-failed', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudieron reintentar los trabajos')
      await loadAudit()
    } catch (err) {
      setAuditError(err.message)
      setAuditLoading(false)
    }
  }

  const retryReport = async (report) => {
    setAuditError('')
    try {
      const res = await apiFetch(`/api/admin/audit/reports/${report.id}/retry`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo reintentar el informe')
      await loadAudit()
    } catch (err) {
      setAuditError(err.message)
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
            {tab === 'shops'
              ? (shops === null
                ? 'Cargando tiendas…'
                : `${shops.length} tienda${shops.length === 1 ? '' : 's'} · ${pendientes} pendiente${pendientes === 1 ? '' : 's'}`)
              : 'Salud del worker e informes de todas las tiendas'}
          </p>
        </div>
      </div>

      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mt-4 mb-2">
        <button
          onClick={() => setTab('shops')}
          className={`flex-1 flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-lg transition-colors ${
            tab === 'shops' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
          }`}
        >
          <Store size={15} /> Tiendas
        </button>
        <button
          onClick={() => setTab('audit')}
          className={`flex-1 flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-lg transition-colors ${
            tab === 'audit' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
          }`}
        >
          <Sparkles size={15} /> Auditoría
        </button>
      </div>

      {error && (
        <div className="mt-4 bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl">{error}</div>
      )}

      {tab === 'shops' ? (shops === null ? (
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
      )) : (
        <AdminAudit
          data={audit}
          loading={auditLoading}
          error={auditError}
          onRefresh={loadAudit}
          onRetry={retryFailed}
          onRetryReport={retryReport}
        />
      )}
    </div>
  )
}

function AdminAudit({ data, loading, error, onRefresh, onRetry, onRetryReport }) {
  const health = data.health
  const reports = data.reports
  const cards = health ? [
    ['Pendientes', health.pending, 'text-amber-600'],
    ['Procesando', health.processing, 'text-blue-600'],
    ['Fallidos', health.failed, Number(health.failed) > 0 ? 'text-red-600' : 'text-gray-900'],
    ['Informes', health.reports, 'text-gray-900'],
    ['Con IA hoy', health.model_calls_today, 'text-gray-900'],
    ['Respaldo', health.fallbacks, Number(health.fallbacks) > 0 ? 'text-amber-600' : 'text-gray-900'],
  ] : []

  return (
    <div className="mt-4">
      {error && <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm mb-4">{error}</div>}
      {loading && !health ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {health && (
            <>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Estado del worker</p>
                <div className="flex items-center gap-2">
                  {Number(health.failed) > 0 && (
                    <button
                      onClick={onRetry}
                      disabled={loading}
                      className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
                    >
                      Reintentar fallidos
                    </button>
                  )}
                  <button
                    onClick={onRefresh}
                    disabled={loading}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-[#007AFF] disabled:opacity-50"
                    title="Actualizar"
                  >
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-2">
                {cards.map(([label, value, tone]) => (
                  <div key={label} className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 text-center">
                    <p className={`text-lg font-bold ${tone}`}>{value ?? '—'}</p>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{label}</p>
                  </div>
                ))}
              </div>

              <p className="text-[11px] text-gray-400 mb-4">
                {health.last_report_at
                  ? `Último informe: ${formatDateTime(health.last_report_at)}`
                  : 'Todavía no se ha generado ningún informe.'}
                {health.oldest_pending_at ? ` · Pendiente más antiguo: ${formatDateTime(health.oldest_pending_at)}` : ''}
              </p>

              {Number(health.failed) > 0 && (
                <div className="flex items-start gap-2 bg-amber-50 text-amber-800 rounded-xl px-3.5 py-2.5 text-xs mb-4">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  <span>
                    Hay {health.failed} trabajo(s) fallido(s). Revisa los secretos del worker
                    (Turso, Gemini y el secreto compartido) y reintenta.
                  </span>
                </div>
              )}
            </>
          )}

          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Informes de todas las tiendas {reports?.length ? `(${reports.length})` : ''}
          </p>

          {!reports ? (
            error ? null : (
              <div className="flex justify-center py-12">
                <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
              </div>
            )
          ) : reports.length === 0 ? (
            <p className="text-center text-gray-400 text-sm py-12">Todavía no hay informes.</p>
          ) : (
            <div className="space-y-3">
              {reports.map((report) => (
                <AuditReportCard
                  key={report.id}
                  report={report}
                  showStore
                  onRetry={onRetryReport}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
