import { useState, useEffect, useRef } from 'react'
import {
  Calculator, Check, AlertTriangle, ArrowUp, Banknote, Smartphone, Lock, History,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import { newId } from '../lib/newId'
import { formatDateTime as fmtDateTime } from '../lib/dates'
import { useAuth } from '../context/AuthContext'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

export default function Caja() {
  const { user } = useAuth()
  const isOwner = user?.role !== 'cajero'
  const [period,     setPeriod]     = useState(null)
  const [history,    setHistory]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [float,      setFloat]      = useState('')
  const [counted,    setCounted]    = useState('')
  const [note,       setNote]       = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState('')
  // Se mantiene entre reintentos para que el servidor reconozca el reintento y
  // no registre dos arqueos del mismo período.
  const closeIdRef = useRef(null)

  const load = async () => {
    // El historial lleva el efectivo esperado de cada período: el servidor solo
    // se lo da al dueño (403 para un cajero), así que ni lo pedimos.
    const [p, h] = await Promise.all([
      apiFetch('/api/cash-closes/current').then(r => r.json()),
      isOwner ? apiFetch('/api/cash-closes').then(r => r.json()) : Promise.resolve([]),
    ])
    setPeriod(p)
    setHistory(h)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

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
          opening_float: parseFloat(float) || 0,
          note: note.trim() || null,
          client_close_id: closeIdRef.current,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'No se pudo cerrar la caja.')
      } else {
        closeIdRef.current = null
        setResult(data)
        setFloat(''); setCounted(''); setNote('')
        await load()
      }
    } catch (_) {
      setError('Sin conexión. El cierre no se registró — vuelve a intentar cuando tengas red.')
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

  const field = 'w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors'

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-24 md:pb-8">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold text-gray-900">Cierre de caja</h2>
        {history.length > 0 && (
          <span className="text-sm text-gray-500">{history.length} cierres</span>
        )}
      </div>

      {result ? (
        <ResultCard result={result} onNew={startNew} />
      ) : (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm p-6 mb-6">
          {/* El aviso de conteo a ciegas es parte del producto, no decoración:
              es lo que le da valor al arqueo frente al dueño. */}
          <div className="flex items-start gap-2.5 bg-blue-50 text-[#007AFF] rounded-xl px-4 py-3 mb-5">
            <Lock size={16} className="flex-shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed font-medium">
              Cuenta el efectivo <strong>antes</strong> de ver el total del sistema.
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
                Lo que hay físicamente en la gaveta ahora mismo.
              </p>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                Nota (opcional)
              </label>
              <input
                placeholder="Ej: saqué 2000 para pagar al proveedor"
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

      {history.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2 px-1">
            <History size={13} className="text-gray-400" />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Cierres anteriores</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
            {history.map((c, idx) => (
              <div
                key={c.id}
                className={`flex items-center justify-between px-5 py-4 ${
                  idx < history.length - 1 ? 'border-b border-gray-50' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 text-sm">{fmtDateTime(c.closed_at)}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {c.sales_count} {c.sales_count === 1 ? 'venta' : 'ventas'} · esperado {fmt(c.expected_cash)}
                  </p>
                  {c.note && <p className="text-xs text-gray-400 mt-1 italic truncate">{c.note}</p>}
                </div>
                <DifferenceBadge value={c.difference} />
              </div>
            ))}
          </div>
        </div>
      )}
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

function ResultCard({ result, onNew }) {
  const square = isSquare(result.difference)
  const short  = result.difference < 0

  const tone = square
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
          value={fmt(result.expected_cash - result.opening_float)}
          muted
        />
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

        {result.expected_transfer > 0 && (
          <div className="border-t border-gray-100 pt-3">
            <Row
              label={<><Smartphone size={13} className="inline mr-1.5 -mt-0.5 text-[#007AFF]" />Cobrado por transferencia</>}
              value={fmt(result.expected_transfer)}
              muted
            />
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
