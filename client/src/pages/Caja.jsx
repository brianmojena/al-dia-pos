import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { useState, useEffect, useRef } from 'react'
import {
  Calculator, Check, AlertTriangle, ArrowUp, ArrowLeft, Banknote, Smartphone, Lock, History, Users, DollarSign,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import { getToken, isElectron } from '../lib/network.js'
import { accountKeyFromToken } from '../lib/queueOwnership.js'
import { cacheCashCloseCorrection, refreshOfflineSnapshot } from '../lib/offlineClient.js'
import { newId } from '../lib/newId'
import { formatDateTime as fmtDateTime } from '../lib/dates'
import { accountLabel } from '../lib/accountLabel'
import { useAuth } from '../context/AuthContext'
import { useExchangeRates } from '../lib/exchangeRates'
import { fmtForeign } from '../lib/payment'
import InventoryCrossCheck from '../components/InventoryCrossCheck'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))
const sameCashClose = (left, right) => Boolean(
  (left?.client_close_id && right?.client_close_id && left.client_close_id === right.client_close_id)
  || (left?.id != null && right?.id != null && Number(left.id) === Number(right.id))
)

export default function Caja() {
  const { user, sharedDevice } = useAuth()
  const isOwner = user?.role !== 'cajero'
  // Se piden los billetes en divisa solo si este aparato puede cobrar en esa
  // moneda (tiene tasa, propia o de la tienda). Mostrar u ocultar el campo no
  // le dice al cajero si hubo ventas en divisa: el conteo sigue a ciegas.
  const rates = useExchangeRates(user)
  const foreignFields = ['USD', 'EUR'].filter((c) => rates[c].rate != null)
  const [countedForeign, setCountedForeign] = useState({ USD: '', EUR: '' })
  const [period,     setPeriod]     = useState(null)
  const [history,    setHistory]    = useState([])
  const [summary,    setSummary]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [float,      setFloat]      = useState('')
  const [counted,    setCounted]    = useState('')
  const [note,       setNote]       = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result,     setResult]     = useState(null)
  const [detailClose,setDetailClose]= useState(null)
  const [error,      setError]      = useState('')
  // Se mantiene entre reintentos para que el servidor reconozca el reintento y
  // no registre dos arqueos del mismo período.
  const closeIdRef = useRef(null)

  const load = async () => {
    // El servidor limita al cajero a los cierres hechos por su propia cuenta.
    try {
      const [p, h, s] = await Promise.all([
        apiFetch('/api/cash-closes/current?register_id=web').then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'No se pudo cargar'); return data }),
        apiFetch('/api/cash-closes').then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'No se pudo cargar'); return data }),
        isOwner ? apiFetch('/api/cash-closes/summary').then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'No se pudo cargar'); return data }) : Promise.resolve([]),
      ])
      setPeriod(p)
      setHistory(Array.isArray(h) ? h : [])
      setSummary(Array.isArray(s) ? s : [])
      setDetailClose((current) => {
        if (!current) return current
        return (Array.isArray(h) ? h : []).find((close) => sameCashClose(close, current)) || current
      })
      setResult((current) => {
        if (!current) return current
        const confirmed = (Array.isArray(h) ? h : []).find((close) => sameCashClose(close, current) && !close.pending)
        return confirmed ? { ...confirmed, pending: false, offline_notice: null } : current
      })
    } catch (error) { setError(error.message || 'No se pudieron leer los datos locales') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])
  useLocalRefresh(load)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')

    if (!closeIdRef.current) closeIdRef.current = newId()

    try {
      const res = await apiFetch('/api/cash-closes', {
        method: 'POST',
        body: JSON.stringify({
          counted_cash: parseFloat(counted) || 0,
          counted_usd: parseFloat(countedForeign.USD) || 0,
          counted_eur: parseFloat(countedForeign.EUR) || 0,
          opening_float: parseFloat(float) || 0,
          note: note.trim() || null,
          client_close_id: closeIdRef.current,
          register_id: 'web',
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'No se pudo cerrar la caja.')
      } else {
        closeIdRef.current = null
        setResult(data)
        setFloat(''); setCounted(''); setNote(''); setCountedForeign({ USD: '', EUR: '' })
        await load()
      }
    } catch (_) {
      setError('No se pudo guardar el cierre en este dispositivo. Vuelve a intentar.')
    } finally {
      setSubmitting(false)
    }
  }

  const startNew = () => { setResult(null); setError('') }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (detailClose) return (
    <CashCloseDetail
      key={`${detailClose.id}:${detailClose.server_id ?? 'pending'}`}
      close={detailClose}
      isOwner={isOwner}
      onBack={() => setDetailClose(null)}
      onSaved={async (updated) => {
        setHistory((current) => current.map((close) =>
          sameCashClose(close, updated)
            ? { ...close, ...updated } : close))
        setResult((current) => current && sameCashClose(current, updated)
          ? { ...current, ...updated, pending: false, offline_notice: null } : current)
        await load()
      }}
    />
  )

  const field = 'w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors'

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-24 md:pb-8">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold text-gray-900">Cierre de caja</h2>
        {history.length > 0 && (
          <span className="text-sm text-gray-500">{history.length} cierres</span>
        )}
      </div>

      {sharedDevice && user?.role === 'cajero' && <p className="mb-4 rounded-xl bg-blue-50 text-blue-800 p-3 text-sm">{sharedDevice.continuous
        ? 'Este cierre incluye las operaciones de todos los cajeros de esta caja. Quedará registrado quién hizo el conteo; el descuadre corresponde al período compartido.'
        : 'Este cierre incluye tus operaciones en este dispositivo. Cierra antes de entregar la caja al siguiente cajero.'}</p>}

      {result ? (
        <div>
          {result.offline_notice && <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2 mb-3">{result.offline_notice}</p>}
          {result.pending && <p className="text-xs text-amber-700 mb-3">Cierre guardado en este dispositivo. El resultado se confirmará al sincronizar con la nube.</p>}
          {result.pending ? (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl p-5 mb-6">
              <p className="font-semibold">Cierre guardado; esperando confirmación</p>
              <p className="text-sm mt-1">La diferencia aparecerá cuando la nube confirme las ventas incluidas en este conteo.</p>
              <button type="button" onClick={startNew} className="text-sm font-semibold underline mt-3">Volver a la caja</button>
            </div>
          ) : <ResultCard result={result} onNew={startNew} />}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm p-6 mb-6">
          {/* El aviso de conteo a ciegas es parte del producto, no decoración:
              es lo que le da valor al arqueo frente al dueño. */}
          <div className="flex items-start gap-2.5 bg-blue-50 text-[#007AFF] rounded-xl px-4 py-3 mb-5">
            <Lock size={16} className="flex-shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed font-medium">
              Cuenta el efectivo{foreignFields.length > 0 && ' y la divisa'} <strong>antes</strong> de ver el total del sistema.
              La diferencia aparece solo cuando confirmes.
            </p>
          </div>

          <p className="text-xs text-gray-400 mb-5">
            {period?.has_sales
              ? <>Cubre las ventas desde <strong className="text-gray-600">{fmtDateTime(period.opened_at)}</strong></>
              : 'No hay ventas nuevas desde el último cierre.'}
          </p>

          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                Fondo de caja inicial
              </label>
              <input
                type="number" step="1" min="0" inputMode="numeric" placeholder="0"
                value={float} onChange={e => setFloat(e.target.value)} className={field}
              />
              <p className="text-[11px] text-gray-400 mt-1.5">
                Con cuánto efectivo empezó la caja. Déjalo en 0 si empezó vacía.
              </p>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                Efectivo contado *
              </label>
              <input
                required autoFocus
                type="number" step="1" min="0" inputMode="numeric" placeholder="0"
                value={counted} onChange={e => setCounted(e.target.value)}
                className={`${field} text-2xl font-bold py-4`}
              />
              <p className="text-[11px] text-gray-400 mt-1.5">
                Los pesos que hay físicamente en la gaveta ahora mismo.
              </p>
            </div>

            {foreignFields.length > 0 && (
              <div>
                <div className={`grid gap-3 ${foreignFields.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  {foreignFields.map((currency) => (
                    <div key={currency}>
                      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                        {currency === 'USD' ? 'Dólares contados' : 'Euros contados'}
                      </label>
                      <input
                        type="number" step="any" min="0" inputMode="decimal" placeholder="0"
                        value={countedForeign[currency]}
                        onChange={e => setCountedForeign((c) => ({ ...c, [currency]: e.target.value }))}
                        className={`${field} text-xl font-bold`}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400 mt-1.5">
                  Los billetes en divisa se cuentan aparte, sin convertirlos a pesos.
                </p>
              </div>
            )}

            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                Nota (opcional)
              </label>
              <input
                placeholder="Ej: faltó un billete de 100"
                value={note} onChange={e => setNote(e.target.value)} className={field}
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 mt-4 text-sm font-medium">
              <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || counted === ''}
            className="w-full bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-lg mt-6 hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200 disabled:shadow-none"
          >
            {submitting ? 'Cerrando...' : 'Cerrar caja'}
          </button>
        </form>
      )}

      {/* Un cierre suelto con un faltante puede ser un vuelto mal dado. El
          mismo nombre repitiendo faltantes es otra cosa — y eso solo se ve
          agrupado. Con un solo cajero no aporta nada, así que no se muestra. */}
      {summary.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2 px-1">
            <Users size={13} className="text-gray-400" />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Descuadres por cajero o caja</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
            {summary.map((s, idx) => {
              const saldo = Number(s.total_difference) || 0
              const falta = Math.round(saldo) < 0
              return (
                <div
                  key={s.register_id || `${s.account_id}-${s.account_email}`}
                  className={`flex items-center justify-between px-5 py-4 ${
                    idx < summary.length - 1 ? 'border-b border-gray-50' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 text-sm truncate">
                      {s.attribution === 'register' ? (s.register_name || 'Caja compartida') : (accountLabel(s.account_email) || 'Sin identificar')}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {s.closes} {Number(s.closes) === 1 ? 'cierre' : 'cierres'}
                      {Number(s.times_short) > 0 && ` · ${s.times_short} con faltante`}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className={`text-base font-bold ${
                      falta ? 'text-red-600' : Math.round(saldo) > 0 ? 'text-orange-500' : 'text-green-600'
                    }`}>
                      {Math.round(saldo) === 0 ? fmt(0) : (falta ? '−' : '+') + fmt(Math.abs(saldo))}
                    </p>
                    {['usd', 'eur'].map((k) => Math.abs(Number(s[`total_difference_${k}`]) || 0) >= 0.01 && (
                      <p key={k} className={`text-[11px] font-semibold ${Number(s[`total_difference_${k}`]) < 0 ? 'text-red-600' : 'text-orange-500'}`}>
                        {Number(s[`total_difference_${k}`]) > 0 ? '+' : '−'}{fmtForeign(Math.abs(s[`total_difference_${k}`]))} {k.toUpperCase()}
                      </p>
                    ))}
                    {Number(s.worst_difference) < -0.5 && (
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        peor: {fmt(Math.abs(s.worst_difference))}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-gray-400 mt-2 px-1">
            Saldo acumulado de todos sus cierres. Un faltante aislado suele ser un vuelto mal
            dado; lo que dice algo es el patrón.
          </p>
        </div>
      )}

      {history.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2 px-1">
            <History size={13} className="text-gray-400" />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Cierres anteriores</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
            {history.map((c, idx) => (
              (() => {
                const pending = c.pending || c.coverage_incomplete || (isElectron() && c.server_id == null)
                return <button
                type="button"
                onClick={() => setDetailClose(c)}
                aria-label={`Ver detalle del cierre del ${fmtDateTime(c.closed_at)}`}
                key={c.id}
                className={`w-full text-left flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors ${
                  idx < history.length - 1 ? 'border-b border-gray-50' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 text-sm">
                    {fmtDateTime(c.closed_at)}
                    {accountLabel(c.account_email) && (
                      <span className="font-normal text-gray-400"> · {accountLabel(c.account_email)}</span>
                    )}
                  </p>
                  {pending
                    ? <p className="text-xs text-amber-700 mt-0.5">Pendiente de sincronizar · resultado sin confirmar</p>
                    : <p className="text-xs text-gray-400 mt-0.5">{c.sales_count} {c.sales_count === 1 ? 'venta' : 'ventas'} · esperado {fmt(c.expected_cash)}</p>}
                  {c.note && <p className="text-xs text-gray-400 mt-1 italic truncate">{c.note}</p>}
                  {/* Una venta de este cierre se corrigió después (forma de pago o anulada). */}
                  {!pending && c.corrected_at && (
                    <p className="text-xs text-[#007AFF] font-medium mt-1">
                      Corregido{c.original_difference != null && <> · al cerrar dio {isSquare(c.original_difference) ? 'cuadrado' : `${c.original_difference < 0 ? 'faltante de' : 'sobrante de'} ${fmt(Math.abs(c.original_difference))}`}</>}
                    </p>
                  )}
                </div>
                {!pending && <div className="flex flex-col items-end gap-1">
                  <DifferenceBadge value={c.difference} />
                  <ForeignDifference close={c} />
                </div>}
              </button>
                })()
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function CashCloseDetail({ close, isOwner, onBack, onSaved }) {
  const pending = close.pending || close.coverage_incomplete || (isElectron() && close.server_id == null)
  const [detail, setDetail] = useState(pending ? close : null)
  const [loading, setLoading] = useState(!pending)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [form, setForm] = useState({})

  const fetchDetail = async () => {
    if (pending) { setDetail(close); setLoading(false); return }
    setLoading(true)
    setLoadError('')
    try {
      const res = await apiFetch(`/api/cash-closes/${close.id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo abrir el detalle del cierre.')
      setDetail(data.cash_close || data)
    } catch (err) {
      setLoadError(err.message || 'No se pudo abrir el detalle. Hace falta conexión.')
    } finally { setLoading(false) }
  }

  useEffect(() => { fetchDetail() }, [close.id, close.server_id, close.pending, close.correction_revision])

  const beginEdit = () => {
    setForm({
      opening_float: String(detail.opening_float ?? 0),
      counted_cash: String(detail.counted_cash ?? 0),
      counted_usd: String(detail.counted_usd ?? 0),
      counted_eur: String(detail.counted_eur ?? 0),
      note: detail.note ?? '',
    })
    setError('')
    setRefreshError('')
    setEditing(true)
  }

  const save = async () => {
    if (saving || !detail) return
    const numericKeys = ['opening_float', 'counted_cash', 'counted_usd', 'counted_eur']
    const payload = {}
    for (const key of numericKeys) {
      const raw = String(form[key] ?? '').trim()
      const value = Number(raw)
      if (!raw || !Number.isFinite(value) || value < 0) {
        setError('Escribe cantidades válidas mayores o iguales a cero en todos los campos.')
        return
      }
      payload[key] = Math.round(value * 100) / 100
    }
    payload.note = String(form.note ?? '').trim() || null
    payload.correction_revision = Number(detail.correction_revision || 0)
    const identityToken = getToken()
    const identity = { token: identityToken, account: accountKeyFromToken(identityToken) }
    setSaving(true)
    setError('')
    setRefreshError('')
    try {
      const res = await apiFetch(`/api/cash-closes/${close.id}`, {
        method: 'PUT', body: JSON.stringify(payload), token: identityToken,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo guardar la corrección.')
      if (!identity.account || getToken() !== identity.token || accountKeyFromToken(getToken()) !== identity.account) {
        setError('La corrección quedó guardada, pero cambió la sesión. Vuelve a abrir el cierre con la cuenta original.')
        setEditing(false)
        return
      }
      const updated = data.cash_close || data
      setDetail(updated)
      setEditing(false)
      try {
        await cacheCashCloseCorrection(data, identity)
        await refreshOfflineSnapshot(identity)
        if (getToken() !== identity.token || accountKeyFromToken(getToken()) !== identity.account) return
        await onSaved(updated)
      } catch (_) {
        setRefreshError('La corrección quedó guardada, pero no se pudo actualizar el historial. Vuelve a cargar.')
      }
    } catch (err) {
      setError(err.message || 'Hace falta conexión para corregir este cierre.')
    } finally { setSaving(false) }
  }

  const cancel = () => {
    setEditing(false)
    setError('')
    setForm({})
  }

  const inputClass = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF]'
  const row = (label, value, suffix = '') => (
    <div className="flex justify-between gap-4 py-2 border-b border-gray-50 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm font-semibold text-gray-900 text-right">{value}{suffix}</span>
    </div>
  )

  if (loading) return <div className="p-5 md:p-8 max-w-2xl mx-auto"><div className="flex items-center gap-3 mb-5"><button onClick={onBack} className="p-2 -ml-2 rounded-xl hover:bg-gray-100 text-gray-400"><ArrowLeft size={20} /></button><h2 className="text-2xl font-bold">Detalle del cierre</h2></div><p className="py-16 text-center text-gray-400">Cargando cierre…</p></div>

  if (loadError) return <div className="p-5 md:p-8 max-w-2xl mx-auto"><div className="flex items-center gap-3 mb-5"><button onClick={onBack} className="p-2 -ml-2 rounded-xl hover:bg-gray-100 text-gray-400"><ArrowLeft size={20} /></button><h2 className="text-2xl font-bold">Detalle del cierre</h2></div><div className="bg-red-50 text-red-700 rounded-xl p-4 text-sm"><p>{loadError}</p><button onClick={fetchDetail} className="underline font-semibold mt-3">Reintentar</button></div></div>

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-32 md:pb-8">
      <div className="flex items-center gap-3 mb-5">
        <button onClick={onBack} className="p-2 -ml-2 rounded-xl hover:bg-gray-100 text-gray-400"><ArrowLeft size={20} /></button>
        <h2 className="text-2xl font-bold text-gray-900">Detalle del cierre</h2>
      </div>

      {pending && <div className="bg-amber-50 text-amber-800 rounded-xl px-4 py-3 mb-4 text-sm">Pendiente de sincronizar; este resultado aún no está confirmado y no se puede corregir.</div>}
      {refreshError && <div className="bg-amber-50 text-amber-800 rounded-xl px-4 py-3 mb-4 text-sm">{refreshError}</div>}
      {error && <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 mb-4 text-sm">{error}</div>}

      <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">{fmtDateTime(detail.closed_at)}</p>
            <p className="text-xs text-gray-400 mt-1">Abierto: {fmtDateTime(detail.opened_at)} · {detail.sales_count} {detail.sales_count === 1 ? 'venta' : 'ventas'}</p>
            {detail.corrected_at && <p className="text-xs text-[#007AFF] mt-1">Corregido</p>}
          </div>
          {isOwner && !pending && !editing && <button onClick={beginEdit} className="px-3 py-2 text-xs font-semibold text-[#007AFF] hover:bg-blue-50 rounded-lg">Corregir</button>}
        </div>
        {editing ? (
          <div className="space-y-3 mt-4">
            {[
              ['opening_float', 'Fondo inicial'], ['counted_cash', 'Efectivo contado'],
              ['counted_usd', 'Dólares contados'], ['counted_eur', 'Euros contados'],
            ].map(([key, label]) => <label key={key} className="block text-xs font-semibold text-gray-500">{label}<input className={`${inputClass} mt-1`} type="number" min="0" step="0.01" inputMode="decimal" value={form[key] ?? ''} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
            <label className="block text-xs font-semibold text-gray-500">Nota<input className={`${inputClass} mt-1`} maxLength={200} value={form.note ?? ''} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} /></label>
            <p className="text-xs text-gray-400">Las fechas, las ventas incluidas y los montos esperados no se editan.</p>
            <div className="flex gap-3 pt-1"><button disabled={saving} onClick={cancel} className="flex-1 border border-gray-200 text-gray-600 py-3 rounded-xl font-semibold disabled:opacity-50">Cancelar</button><button disabled={saving} onClick={save} className="flex-1 bg-[#007AFF] text-white py-3 rounded-xl font-semibold disabled:opacity-50">{saving ? 'Guardando…' : 'Guardar corrección'}</button></div>
          </div>
        ) : (
          <>
            {row('Fondo inicial', fmt(detail.opening_float))}
            {row('Efectivo esperado', pending ? 'Pendiente' : fmt(detail.expected_cash))}
            {row('Efectivo contado', pending ? 'Pendiente' : fmt(detail.counted_cash))}
            {row('Diferencia en efectivo', pending ? 'Pendiente' : <span className={Number(detail.difference) < 0 ? 'text-red-600' : Number(detail.difference) > 0 ? 'text-orange-600' : 'text-green-600'}>{fmt(detail.difference)}</span>)}
            {row('Transferencias', pending ? 'Pendiente' : fmt(detail.expected_transfer))}
            {row('USD esperado / contado', pending ? 'Pendiente' : `${fmtForeign(detail.expected_usd)} / ${fmtForeign(detail.counted_usd)} USD`)}
            {row('EUR esperado / contado', pending ? 'Pendiente' : `${fmtForeign(detail.expected_eur)} / ${fmtForeign(detail.counted_eur)} EUR`)}
            {row('Extracciones cubiertas', pending ? 'Pendiente' : `${fmt(detail.withdrawn_cash)} efectivo · ${fmt(detail.withdrawn_transfer)} transferencia`)}
            {detail.note && <p className="text-sm text-gray-500 mt-3 italic">{detail.note}</p>}
            {detail.original_expected_cash != null && <p className="text-xs text-gray-400 mt-3">Antes de la primera corrección: esperado {fmt(detail.original_expected_cash)} · diferencia {fmt(detail.original_difference)}</p>}
          </>
        )}
      </div>

      {isOwner && !pending && <InventoryCrossCheck check={detail.inventory_check} />}

      {isOwner && detail.corrections?.length > 0 && <div className="bg-white rounded-2xl shadow-sm p-5"><h3 className="font-semibold text-sm mb-3">Historial de correcciones</h3>{detail.corrections.map((entry) => <div key={entry.id} className="border-t border-gray-100 py-3 first:border-0"><p className="text-xs font-semibold text-gray-700">Revisión {entry.correction_revision} · {accountLabel(entry.account_email) || entry.account_email || 'Dueño'} · {fmtDateTime(entry.created_at)}</p><p className="text-xs text-gray-400 mt-1">Efectivo contado: {fmt(entry.before.counted_cash)} → {fmt(entry.after.counted_cash)} · fondo: {fmt(entry.before.opening_float)} → {fmt(entry.after.opening_float)}</p></div>)}</div>}
    </div>
  )
}

// Redondeo antes de comparar: expected y counted son REAL, y una suma de
// decimales puede dejar una diferencia de 0.0000001 que no es un descuadre real.
const isSquare = (v) => Math.round(v || 0) === 0

function DifferenceBadge({ value }) {
  if (isSquare(value)) {
    return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-green-100 text-green-700 flex-shrink-0">
        <Check size={12} /> Cuadró
      </span>
    )
  }
  const short = value < 0
  return (
    <span className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0 ${
      short ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'
    }`}>
      {short ? <AlertTriangle size={12} /> : <ArrowUp size={12} />}
      {short ? `Faltó ${fmt(Math.abs(value))}` : `Sobró ${fmt(value)}`}
    </span>
  )
}

// Los descuadres en divisa van aparte de los pesos: un faltante de 5 USD no
// se puede leer como uno de 5 pesos.
function ForeignDifference({ close }) {
  const parts = ['usd', 'eur']
    .map((k) => ({ code: k.toUpperCase(), diff: Number(close[`difference_${k}`]) || 0 }))
    .filter((p) => Math.abs(p.diff) >= 0.005)
  if (parts.length === 0) return null
  return parts.map(({ code, diff }) => (
    <span key={code} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${diff < 0 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
      {diff < 0 ? 'Faltó' : 'Sobró'} {fmtForeign(Math.abs(diff))} {code}
    </span>
  ))
}

function ResultCard({ result, onNew }) {
  const square = isSquare(result.difference)
  const short  = result.difference < 0

  // Los pesos cuadraron pero no la divisa: no se puede decir "cuadró".
  const foreignShort = ['usd', 'eur'].some((k) => Number(result[`difference_${k}`]) < -0.005)
  const foreignOff = ['usd', 'eur'].some((k) => Math.abs(Number(result[`difference_${k}`]) || 0) >= 0.005)

  const tone = square && foreignOff
    ? foreignShort
      ? { bg: 'bg-red-500',    shadow: 'shadow-red-200',    label: 'Los pesos cuadraron, pero falta divisa', Icon: AlertTriangle }
      : { bg: 'bg-orange-500', shadow: 'shadow-orange-200', label: 'Los pesos cuadraron, pero sobra divisa', Icon: ArrowUp }
    : square
    ? { bg: 'bg-green-500',  shadow: 'shadow-green-200',  label: 'La caja cuadró',  Icon: Check }
    : short
      ? { bg: 'bg-red-500',   shadow: 'shadow-red-200',   label: 'Falta efectivo',  Icon: AlertTriangle }
      : { bg: 'bg-orange-500', shadow: 'shadow-orange-200', label: 'Sobra efectivo', Icon: ArrowUp }

  return (
    <div className="mb-6">
      <div className={`${tone.bg} ${tone.shadow} text-white rounded-3xl p-7 text-center shadow-lg mb-4`}>
        <tone.Icon size={34} className="mx-auto mb-2 opacity-90" />
        <p className="font-semibold opacity-90">{tone.label}</p>
        {!square && (
          <p className="text-5xl font-bold mt-1 tracking-tight">{fmt(Math.abs(result.difference))}</p>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm px-5 py-4 space-y-3">
        <Row label="Fondo inicial"      value={fmt(result.opening_float)} muted />
        <Row
          label={<><Banknote size={13} className="inline mr-1.5 -mt-0.5 text-green-600" />Ventas en efectivo</>}
          value={fmt(result.expected_cash - result.opening_float + (result.withdrawn_cash || 0))}
          muted
        />
        {(result.withdrawn_cash || 0) > 0 && (
          <Row label="Extracciones" value={`− ${fmt(result.withdrawn_cash)}`} muted />
        )}
        <div className="border-t border-gray-100 pt-3">
          <Row label="Debería haber" value={fmt(result.expected_cash)} />
        </div>
        <Row label="Contado" value={fmt(result.counted_cash)} />
        <div className="border-t border-gray-100 pt-3">
          <Row
            label="Diferencia"
            value={square ? fmt(0) : (short ? '−' : '+') + fmt(Math.abs(result.difference)).replace('$ ', '$ ')}
            strong
            tone={square ? 'text-green-600' : short ? 'text-red-600' : 'text-orange-600'}
          />
        </div>

        {['usd', 'eur'].map((k) => {
          const expected = Number(result[`expected_${k}`]) || 0
          const counted = Number(result[`counted_${k}`]) || 0
          const withdrawn = Number(result[`withdrawn_${k}`]) || 0
          if (expected === 0 && counted === 0) return null
          const diff = Number(result[`difference_${k}`]) || 0
          const code = k.toUpperCase()
          return (
            <div key={k} className="border-t border-gray-100 pt-3 space-y-2">
              <Row label={<><DollarSign size={13} className="inline mr-1.5 -mt-0.5 text-amber-600" />{code} esperados</>} value={`${fmtForeign(expected + withdrawn)} ${code}`} muted />
              {withdrawn > 0 && (
                <Row label="Extracciones" value={`− ${fmtForeign(withdrawn)} ${code}`} muted />
              )}
              <Row label={`${code} contados`} value={`${fmtForeign(counted)} ${code}`} />
              <Row
                label={`Diferencia ${code}`}
                value={Math.abs(diff) < 0.005 ? 'Cuadró' : `${diff < 0 ? '−' : '+'}${fmtForeign(Math.abs(diff))} ${code}`}
                strong
                tone={Math.abs(diff) < 0.005 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-orange-600'}
              />
            </div>
          )
        })}

        {(result.expected_transfer || 0) > 0 && (
          <div className="border-t border-gray-100 pt-3">
            <Row
              label={<><Smartphone size={13} className="inline mr-1.5 -mt-0.5 text-[#007AFF]" />Cobrado por transferencia</>}
              value={fmt((result.expected_transfer || 0) + (result.withdrawn_transfer || 0))}
              muted
            />
            {(result.withdrawn_transfer || 0) > 0 && (
              <Row label="Extracciones" value={`− ${fmt(result.withdrawn_transfer)}`} muted />
            )}
            <p className="text-[11px] text-gray-400 mt-1.5">
              No entra en el conteo — no está en la gaveta.
            </p>
          </div>
        )}
      </div>

      <button
        onClick={onNew}
        className="w-full text-gray-400 py-3 text-sm hover:text-gray-600 transition-colors mt-2"
      >
        Hacer otro cierre
      </button>
    </div>
  )
}

function Row({ label, value, muted, strong, tone }) {
  return (
    <div className="flex justify-between items-center">
      <span className={`text-sm ${muted ? 'text-gray-400' : 'text-gray-600'}`}>{label}</span>
      <span className={`${strong ? 'text-lg font-bold' : 'text-sm font-semibold'} ${tone || 'text-gray-900'}`}>
        {value}
      </span>
    </div>
  )
}
