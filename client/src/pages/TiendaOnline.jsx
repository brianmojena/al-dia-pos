import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, Check, CheckCircle2, Copy, Globe, MessageCircle, Package,
  Phone, RefreshCw, X,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { fmtMoney } from '../lib/fmt.js'
import { formatQty } from '../lib/units'

/**
 * Tienda online del dueño: configurar el catálogo público (/t/<slug>) y
 * gestionar las reservas que hacen los clientes. Todo vive en la nube — el
 * catálogo es una página pública del servidor, así que aquí hace falta
 * conexión (el item de navegación es cloudOnly y desaparece en el escritorio
 * offline, igual que Auditoría).
 */

const STATES = ['pendiente', 'confirmada', 'entregada', 'anulada']

const STATUS_STYLE = {
  pendiente:  'bg-amber-100 text-amber-700',
  confirmada: 'bg-blue-100 text-blue-700',
  entregada:  'bg-green-100 text-green-700',
  anulada:    'bg-gray-100 text-gray-500',
}

const STATUS_LABEL = {
  pendiente: 'Pendiente',
  confirmada: 'Confirmada',
  entregada: 'Entregada',
  anulada: 'Anulada',
}

// "2026-11-09 14:33:21" (SQLite) → hora local, como el historial de entradas.
const when = (value) => {
  try { return new Date(String(value).replace(' ', 'T') + 'Z').toLocaleString() } catch { return String(value || '') }
}

// El server manda los items ya parseados (con el estado actual de cada
// producto); por robustez aceptamos también el JSON en bruto de la columna.
const reservationItems = (row) => {
  try {
    const parsed = typeof row.items === 'string' ? JSON.parse(row.items || '[]') : row.items
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// Tarjeta de una reserva del cliente. Exportada para el render test: el
// estado actual de cada producto (current_available) y las acciones por
// estado son la lógica que más se pisa a mano.
export function ReservationCard({ row, working = null, onStatus = () => {} }) {
  const items = reservationItems(row)
  const faltan = items.filter((i) => i.current_available === false)
  return (
    <>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 text-sm">{row.customer_name}</p>
          <a href={`tel:${row.customer_phone}`} className="inline-flex items-center gap-1 text-xs text-[#007AFF] font-semibold mt-0.5">
            <Phone size={11} /> {row.customer_phone}
          </a>
        </div>
        <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${STATUS_STYLE[row.status]}`}>
          {STATUS_LABEL[row.status]}
        </span>
      </div>
      <p className="text-xs text-gray-400 mt-1">{when(row.created_at)}</p>

      <ul className="mt-2 bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-700 space-y-1">
        {items.map((i) => (
          <li key={`${row.id}-${i.product_id}`} className="flex justify-between gap-2">
            <span className="min-w-0 truncate">
              {formatQty(i.quantity, i.unit)} × {i.product_name}
              {i.current_available === false && <span className="text-amber-600 font-semibold"> · ya no hay</span>}
            </span>
            <span className="font-semibold flex-shrink-0">{fmtMoney(Number(i.quantity) * Number(i.sale_price))}</span>
          </li>
        ))}
      </ul>

      {row.customer_note && <p className="text-xs text-gray-500 italic mt-2">«{row.customer_note}»</p>}
      {faltan.length > 0 && row.status !== 'anulada' && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2 mt-2 flex items-start gap-1.5">
          <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
          Algunos productos ya no están disponibles. Coordina con el cliente antes de confirmar.
        </p>
      )}

      <div className="flex gap-2 mt-3 flex-wrap">
        {row.status === 'pendiente' && (
          <>
            <button
              type="button"
              disabled={working !== null}
              onClick={() => onStatus(row, 'confirmada')}
              className="bg-[#007AFF] text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50"
            >
              {working === row.id ? '…' : 'Confirmar'}
            </button>
            <button
              type="button"
              disabled={working !== null}
              onClick={() => onStatus(row, 'anulada')}
              className="bg-gray-100 text-gray-600 px-4 py-2 rounded-xl text-xs font-bold hover:bg-gray-200 disabled:opacity-50"
            >
              Anular
            </button>
          </>
        )}
        {row.status === 'confirmada' && (
          <>
            <button
              type="button"
              disabled={working !== null}
              onClick={() => onStatus(row, 'entregada')}
              className="bg-green-600 text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-green-700 active:scale-95 transition-all disabled:opacity-50"
            >
              {working === row.id ? '…' : 'Entregada'}
            </button>
            <button
              type="button"
              disabled={working !== null}
              onClick={() => onStatus(row, 'anulada')}
              className="bg-gray-100 text-gray-600 px-4 py-2 rounded-xl text-xs font-bold hover:bg-gray-200 disabled:opacity-50"
            >
              Anular
            </button>
          </>
        )}
      </div>
    </>
  )
}

export default function TiendaOnline() {
  const [settings, setSettings] = useState(null)
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)
  const [copied, setCopied] = useState(false)
  const [reservations, setReservations] = useState([])
  const [filter, setFilter] = useState('todas')
  const [workingId, setWorkingId] = useState(null)
  const [actionError, setActionError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/catalog')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar la tienda online')
      setSettings(data)
      setForm({ catalog_enabled: data.catalog_enabled, catalog_slug: data.catalog_slug || '', catalog_note: data.catalog_note || '', catalog_phone: data.catalog_phone || '' })
      setLoadError('')
    } catch (error) {
      setLoadError(error.message || 'Hace falta conexión para ver la tienda online.')
    } finally {
      setLoading(false)
    }
    try {
      const res = await apiFetch('/api/catalog/reservations')
      const data = await res.json().catch(() => ({}))
      if (res.ok && Array.isArray(data)) setReservations(data)
    } catch { /* la lista espera la próxima vez que haya red */ }
  }, [])

  useEffect(() => { load() }, [load])
  useLocalRefresh(load)
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])

  const publicUrl = settings?.catalog_slug ? `${window.location.origin}/t/${settings.catalog_slug}` : null

  const save = async (overrides = {}) => {
    setSaving(true)
    setSaveError('')
    setSavedFlash(false)
    try {
      const body = {
        catalog_enabled: overrides.catalog_enabled ?? form.catalog_enabled,
        catalog_slug: (overrides.catalog_slug ?? form.catalog_slug).trim(),
        catalog_note: (overrides.catalog_note ?? form.catalog_note).trim(),
        catalog_phone: (overrides.catalog_phone ?? form.catalog_phone).trim(),
      }
      const res = await apiFetch('/api/catalog', { method: 'PUT', body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'No se pudo guardar la configuración')
      setSettings(data)
      setForm({ catalog_enabled: data.catalog_enabled, catalog_slug: data.catalog_slug || '', catalog_note: data.catalog_note || '', catalog_phone: data.catalog_phone || '' })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2500)
    } catch (error) {
      setSaveError(error.message || 'No se pudo guardar la configuración. Revisa la conexión.')
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = () => save({ catalog_enabled: !form.catalog_enabled })

  const copyLink = async () => {
    if (!publicUrl) return
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* el navegador bloqueó el portapapeles */ }
  }

  const shareWhatsApp = () => {
    if (!publicUrl) return
    const text = `Mira el catálogo de ${settings.store_name}: ${publicUrl}`
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
  }

  const changeStatus = async (row, status) => {
    setWorkingId(row.id)
    setActionError('')
    try {
      const res = await apiFetch(`/api/catalog/reservations/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'No se pudo actualizar la reserva')
      setReservations((current) => current.map((r) => (r.id === row.id ? data : r)))
    } catch (error) {
      setActionError(error.message || 'No se pudo actualizar la reserva. Revisa la conexión.')
    } finally {
      setWorkingId(null)
    }
  }

  const pendientes = reservations.filter((r) => r.status === 'pendiente').length
  const counts = { todas: reservations.length, ...Object.fromEntries(STATES.map((s) => [s, reservations.filter((r) => r.status === s).length])) }
  const visible = filter === 'todas' ? reservations : reservations.filter((r) => r.status === filter)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="p-5 md:p-8 max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Tienda online</h2>
        <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
          <Globe size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-500">{loadError}</p>
          <button
            type="button"
            onClick={() => { setLoading(true); load() }}
            className="mt-4 inline-flex items-center gap-2 bg-[#007AFF] text-white px-5 py-2.5 rounded-xl font-semibold text-sm"
          >
            <RefreshCw size={15} /> Reintentar
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 md:p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl font-bold text-gray-900">Tienda online</h2>
        {pendientes > 0 && (
          <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full">
            {pendientes} reserva{pendientes > 1 ? 's' : ''} por confirmar
          </span>
        )}
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Tu página pública para clientes: ellos ven el catálogo con los precios al momento y te dejan reservas.
      </p>

      {/* Configuración */}
      <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-gray-900">Catálogo público</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {settings.catalog_enabled
                ? 'Tus clientes pueden verlo y reservar desde el enlace.'
                : 'Activado, cualquiera con el enlace ve tu catálogo.'}
            </p>
          </div>
          <button
            type="button"
            onClick={toggleEnabled}
            disabled={saving}
            className={`flex-shrink-0 px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50 ${
              settings.catalog_enabled ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-[#007AFF] text-white hover:bg-blue-600'
            }`}
          >
            {saving ? 'Guardando…' : settings.catalog_enabled ? 'Desactivar' : 'Activar'}
          </button>
        </div>

        {publicUrl && (
          <div className="mt-4 bg-gray-50 rounded-xl px-4 py-3 flex items-center gap-2 flex-wrap">
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-semibold text-[#007AFF] truncate flex-1 min-w-0 underline-offset-2 hover:underline"
            >
              {publicUrl}
            </a>
            <button
              type="button"
              onClick={copyLink}
              className="flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-gray-50 active:scale-95 transition-all"
            >
              {copied ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
            <button
              type="button"
              onClick={shareWhatsApp}
              className="flex items-center gap-1.5 bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-green-700 active:scale-95 transition-all"
            >
              <MessageCircle size={13} /> WhatsApp
            </button>
          </div>
        )}

        {form && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Enlace de tu tienda</label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-gray-400 flex-shrink-0 select-none">/t/</span>
                <input
                  type="text"
                  value={form.catalog_slug}
                  onChange={(e) => setForm((f) => ({ ...f, catalog_slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
                  placeholder="mi-tienda"
                  maxLength={60}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="flex-1 min-w-0 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#007AFF]"
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">Letras, números y guiones. Si lo dejas vacío al activar, se genera del nombre de tu tienda.</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Aviso para tus clientes (opcional)</label>
              <textarea
                value={form.catalog_note}
                onChange={(e) => setForm((f) => ({ ...f, catalog_note: e.target.value }))}
                placeholder="Ej.: Recogemos pedidos de 9am a 5pm. Entregamos en el barrio gratis a partir de $ 3.000."
                rows={2}
                maxLength={200}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#007AFF] resize-none"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Teléfono de contacto (opcional)</label>
              <input
                type="tel"
                value={form.catalog_phone}
                onChange={(e) => setForm((f) => ({ ...f, catalog_phone: e.target.value }))}
                placeholder="Ej.: 53123456"
                maxLength={30}
                inputMode="tel"
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#007AFF]"
              />
            </div>

            {saveError && (
              <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 text-sm font-medium">
                <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                <span>{saveError}</span>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => save()}
                disabled={saving}
                className="bg-[#007AFF] text-white px-6 py-2.5 rounded-xl font-semibold text-sm hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50"
              >
                {saving ? 'Guardando…' : 'Guardar cambios'}
              </button>
              {savedFlash && (
                <span className="inline-flex items-center gap-1 text-sm text-green-700 font-semibold">
                  <CheckCircle2 size={15} /> Guardado
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 flex items-start gap-1.5">
              <Package size={13} className="flex-shrink-0 mt-0.5" />
              Publica productos con la casilla «Visible en la tienda online» en cada producto. El catálogo refleja lo que está en la nube: lo que cambies sin conexión aparece cuando la tienda sincroniza.
            </p>
          </div>
        )}
      </div>

      {/* Reservas */}
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold text-gray-900">Reservas</h3>
          <div className="flex gap-1 flex-wrap">
            {['todas', ...STATES].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilter(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  filter === s ? 'bg-[#007AFF] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {s === 'todas' ? 'Todas' : STATUS_LABEL[s]}
                <span className="ml-1 opacity-70">{counts[s]}</span>
              </button>
            ))}
          </div>
        </div>

        {actionError && (
          <div className="mx-5 mt-3 flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 text-sm font-medium">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{actionError}</span>
          </div>
        )}

        {visible.length === 0 ? (
          <div className="py-14 text-center text-gray-400">
            <Globe size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">
              {filter === 'todas'
                ? 'Todavía no hay reservas. Comparte tu enlace para que tus clientes te encuentren.'
                : `No hay reservas ${STATUS_LABEL[filter].toLowerCase()}s.`}
            </p>
          </div>
        ) : (
          <ul>
            {visible.map((row) => (
              <li key={row.id} className="px-5 py-4 border-b border-gray-50 last:border-0">
                <ReservationCard row={row} working={workingId} onStatus={changeStatus} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
