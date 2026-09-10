import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  ClipboardCheck, Search, X, AlertTriangle, ArrowUp, Check, History, ArrowLeft, Eye,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import { newId } from '../lib/newId'
import { formatDateTime } from '../lib/dates'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

export default function Inventario() {
  const [products,   setProducts]   = useState([])
  const [history,    setHistory]    = useState([])
  const [counts,     setCounts]     = useState({})   // product_id -> texto tecleado
  const [search,     setSearch]     = useState('')
  const [note,       setNote]       = useState('')
  const [loading,    setLoading]    = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState('')
  const countIdRef = useRef(null)

  const load = async () => {
    const [p, h] = await Promise.all([
      apiFetch('/api/products').then(r => r.json()),
      apiFetch('/api/inventory-counts').then(r => r.json()),
    ])
    setProducts(Array.isArray(p) ? p : [])
    setHistory(Array.isArray(h) ? h : [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = useMemo(
    () => products.filter(p => p.name.toLowerCase().includes(search.toLowerCase())),
    [products, search]
  )

  // Solo cuenta lo que se tecleó: dejar un producto en blanco significa "no lo
  // conté", que no es lo mismo que "conté cero".
  const entered = Object.entries(counts)
    .filter(([, v]) => v !== '' && v != null)
    .map(([id, v]) => ({ product_id: Number(id), counted: parseInt(v, 10) }))
    .filter(i => Number.isInteger(i.counted) && i.counted >= 0)

  const handleSubmit = async () => {
    if (entered.length === 0 || submitting) return
    setSubmitting(true)
    setError('')

    if (!countIdRef.current) countIdRef.current = newId()

    try {
      const res = await apiFetch('/api/inventory-counts', {
        method: 'POST',
        body: JSON.stringify({
          items: entered,
          note: note.trim() || null,
          client_count_id: countIdRef.current,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'No se pudo registrar el arqueo.')
      } else {
        countIdRef.current = null
        setResult(data)
        setCounts({})
        setNote('')
        await load()
      }
    } catch (_) {
      setError('Sin conexión. El arqueo no se registró — vuelve a intentar cuando tengas red.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (result) return <Resultado result={result} onNew={() => setResult(null)} />

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-40">
      <div className="flex items-center gap-3 mb-5">
        <Link to="/products" className="p-2 -ml-2 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <h2 className="text-2xl font-bold text-gray-900">Contar inventario</h2>
      </div>

      <div className="flex items-start gap-2.5 bg-blue-50 text-[#007AFF] rounded-xl px-4 py-3 mb-5">
        <Eye size={16} className="flex-shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed font-medium">
          Escribe lo que <strong>cuentas en el estante</strong>. No te mostramos lo que dice el
          sistema hasta el final, para que cuentes de verdad en vez de confirmar un número.
          Lo que dejes en blanco no se toca.
        </p>
      </div>

      <div className="relative mb-4">
        <Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar producto..."
          className="w-full bg-white border border-gray-200 rounded-2xl pl-11 pr-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors shadow-sm"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4">
        {filtered.length === 0 ? (
          <div className="py-14 text-center text-gray-400">
            <Search size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Sin resultados</p>
          </div>
        ) : filtered.map((p, idx) => {
          const value = counts[p.id] ?? ''
          return (
            <div
              key={p.id}
              className={`flex items-center gap-3 px-5 py-3 ${
                idx < filtered.length - 1 ? 'border-b border-gray-50' : ''
              } ${value !== '' ? 'bg-blue-50/40' : ''}`}
            >
              <span className="flex-1 text-sm font-medium text-gray-900 min-w-0 truncate">{p.name}</span>
              <input
                type="number" min="0" step="1" inputMode="numeric" placeholder="—"
                value={value}
                onChange={e => setCounts(c => ({ ...c, [p.id]: e.target.value }))}
                className="w-20 text-center border border-gray-200 rounded-xl px-2 py-2 text-base font-semibold focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
              />
            </div>
          )
        })}
      </div>

      <input
        placeholder="Nota (opcional) — ej: conteo del cierre de mes"
        value={note}
        onChange={e => setNote(e.target.value)}
        className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm mb-4 focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
      />

      {error && (
        <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 mb-4 text-sm font-medium">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {history.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2 px-1">
            <History size={13} className="text-gray-400" />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Arqueos anteriores</p>
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
                  <p className="font-semibold text-gray-900 text-sm">{formatDateTime(c.counted_at)}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {c.lines_count} {c.lines_count === 1 ? 'producto' : 'productos'} contados
                  </p>
                  {c.note && <p className="text-xs text-gray-400 mt-1 italic truncate">{c.note}</p>}
                </div>
                {c.units_missing > 0 ? (
                  <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-red-100 text-red-700 flex-shrink-0">
                    <AlertTriangle size={12} />
                    −{c.units_missing} uds · {fmt(c.value_missing)}
                  </span>
                ) : c.units_extra > 0 ? (
                  <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 flex-shrink-0">
                    <ArrowUp size={12} /> +{c.units_extra} uds
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-green-100 text-green-700 flex-shrink-0">
                    <Check size={12} /> Cuadró
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Barra fija: el conteo es largo y el botón no puede quedar al final de
          una lista de 200 productos. */}
      <div className="fixed bottom-0 left-0 right-0 md:left-56 bg-white/95 backdrop-blur border-t border-gray-200 px-5 py-4 safe-area-bottom">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900">
              {entered.length} {entered.length === 1 ? 'producto contado' : 'productos contados'}
            </p>
            <p className="text-xs text-gray-400">de {products.length} en el inventario</p>
          </div>
          <button
            onClick={handleSubmit}
            disabled={entered.length === 0 || submitting}
            className="bg-[#007AFF] text-white px-6 py-3.5 rounded-2xl font-bold hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200 disabled:shadow-none flex-shrink-0"
          >
            {submitting ? 'Guardando...' : 'Cerrar arqueo'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Resultado({ result, onNew }) {
  const faltantes = result.items.filter(i => i.difference < 0)
  const sobrantes = result.items.filter(i => i.difference > 0)
  const exactos   = result.items.filter(i => i.difference === 0)
  const cuadro    = faltantes.length === 0 && sobrantes.length === 0

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-24 md:pb-8">
      <h2 className="text-2xl font-bold text-gray-900 mb-5">Resultado del arqueo</h2>

      <div className={`rounded-3xl p-7 text-center shadow-lg mb-4 text-white ${
        cuadro ? 'bg-green-500 shadow-green-200' : 'bg-red-500 shadow-red-200'
      }`}>
        {cuadro ? (
          <>
            <Check size={34} className="mx-auto mb-2 opacity-90" />
            <p className="font-semibold opacity-90">Todo cuadró</p>
            <p className="text-sm opacity-75 mt-1">{result.lines_count} productos contados</p>
          </>
        ) : (
          <>
            <AlertTriangle size={34} className="mx-auto mb-2 opacity-90" />
            <p className="font-semibold opacity-90">
              {result.units_missing > 0 ? 'Falta mercancía' : 'Hay mercancía de más'}
            </p>
            {result.units_missing > 0 && (
              <>
                <p className="text-5xl font-bold mt-1 tracking-tight">{fmt(result.value_missing)}</p>
                <p className="text-sm opacity-75 mt-1">
                  {result.units_missing} {result.units_missing === 1 ? 'unidad' : 'unidades'} a precio de venta
                </p>
              </>
            )}
          </>
        )}
      </div>

      {!cuadro && result.units_missing > 0 && (
        <div className="flex items-start gap-2.5 bg-orange-50 text-orange-800 rounded-xl px-4 py-3 mb-4">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed font-medium">
            Mercancía que salió del estante sin una venta que la explique. Puede ser robo, merma,
            rotura o un error al recibir el pedido — el sistema no puede distinguirlos, pero
            ahora sabes cuánto y de qué.
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4">
        {[...faltantes, ...sobrantes, ...exactos].map((item, idx, arr) => (
          <div
            key={item.id}
            className={`flex items-center justify-between px-5 py-3.5 ${
              idx < arr.length - 1 ? 'border-b border-gray-50' : ''
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 truncate">{item.product_name}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                Sistema {item.expected} · contado {item.counted}
              </p>
            </div>
            {item.difference === 0 ? (
              <span className="text-xs font-semibold text-green-600 flex-shrink-0">✓</span>
            ) : (
              <span className={`text-sm font-bold flex-shrink-0 ${
                item.difference < 0 ? 'text-red-600' : 'text-orange-500'
              }`}>
                {item.difference > 0 ? '+' : '−'}{Math.abs(item.difference)}
              </span>
            )}
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-400 text-center mb-4">
        El stock ya quedó ajustado a lo que contaste.
      </p>

      <button
        onClick={onNew}
        className="w-full bg-white border border-gray-200 text-gray-600 py-3.5 rounded-2xl font-semibold hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
      >
        <ClipboardCheck size={17} />
        Hacer otro arqueo
      </button>
    </div>
  )
}
