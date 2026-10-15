import { validQuantity, hasPack, packCountTotal, formatPackStock } from '../lib/units'
import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  ClipboardCheck, Search, X, AlertTriangle, ArrowUp, Check, History, ArrowLeft, Eye,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import { newId } from '../lib/newId'
import { formatDateTime } from '../lib/dates'
import { accountLabel } from '../lib/accountLabel'
import { useAuth } from '../context/AuthContext'
import { retrySync } from '../lib/offlineClient'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

export default function Inventario() {
  const { user } = useAuth()
  const [products,      setProducts]      = useState([])
  const [history,       setHistory]       = useState([])
  const [counts,        setCounts]        = useState({})   // product_id -> texto tecleado (productos sin pack)
  const [packCounts,    setPackCounts]    = useState({})   // product_id -> { packs: '', loose: '' } (productos con pack)
  const [search,        setSearch]        = useState('')
  const [note,          setNote]          = useState('')
  const [loading,       setLoading]       = useState(true)
  const [submitting,    setSubmitting]    = useState(false)
  const [result,        setResult]        = useState(null)
  const [error,         setError]         = useState('')
  const [detailCount,   setDetailCount]   = useState(null)  // Count being viewed/edited
  const countIdRef = useRef(null)

  const load = async () => {
    try {
      const p = await apiFetch('/api/products').then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'No se pudo cargar'); return data })
      setProducts(Array.isArray(p) ? p : [])

      // Los cajeros no ven el historial de arqueos: no pueden hacer GET /api/inventory-counts (403).
      // Solo el dueño ve quién contó en "Arqueos anteriores".
      if (user?.role === 'cajero') {
        setHistory([])
      } else {
        const h = await apiFetch('/api/inventory-counts').then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || 'No se pudo cargar'); return data })
        setHistory(Array.isArray(h) ? h : [])
      }
    } catch (error) { setError(error.message || 'No se pudieron leer los datos locales') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])
  useLocalRefresh(load)

  const filtered = useMemo(
    () => products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) && (!p.unit || Number(p.track_stock) === 1)),
    [products, search]
  )

  // Solo cuenta lo que se tecleó: dejar un producto en blanco significa "no lo
  // conté", que no es lo mismo que "conté cero".
  const entered = useMemo(() => {
    const items = []

    // Productos sin pack (counts)
    Object.entries(counts).forEach(([id, v]) => {
      if (v !== '' && v != null) {
        const product_id = Number(id)
        const counted = parseFloat(String(v).replace(',', '.'))
        const unit = products.find(p => p.id === product_id)?.unit
        if (validQuantity(counted, unit)) {
          items.push({ product_id, counted })
        }
      }
    })

    // Productos con pack (packCounts)
    Object.entries(packCounts).forEach(([id, pc]) => {
      const product_id = Number(id)
      const product = products.find(p => p.id === product_id)
      if (!product) return
      const counted = packCountTotal(pc.packs, pc.loose, product.pack_size)
      if (counted != null) {
        items.push({ product_id, counted })
      }
    })

    return items
  }, [counts, packCounts, products])

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
        setPackCounts({})
        setNote('')
        await load()
      }
    } catch (_) {
      setError('No se pudo guardar el arqueo en este dispositivo. Vuelve a intentar.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (detailCount) return (
    <DetalleArqueo
      count={detailCount}
      products={products}
      onClose={() => setDetailCount(null)}
      onSuccess={() => {
        setDetailCount(null)
        load()
        retrySync().catch(() => { /* ignorar errores de sync */ })
      }}
    />
  )

  if (result) return <Resultado result={result} products={products} onNew={() => setResult(null)} />

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
          const isPack = hasPack(p)
          const value = isPack ? (packCounts[p.id] ?? { packs: '', loose: '' }) : (counts[p.id] ?? '')
          const hasValue = isPack ? (value.packs !== '' || value.loose !== '') : (value !== '')

          return (
            <div
              key={p.id}
              className={`flex items-center gap-3 px-5 py-3 ${
                idx < filtered.length - 1 ? 'border-b border-gray-50' : ''
              } ${hasValue ? 'bg-blue-50/40' : ''}`}
            >
              <span className="flex-1 text-sm font-medium text-gray-900 min-w-0 truncate">{p.name}</span>
              {p.unit && <span className="text-xs font-semibold text-gray-400">{p.unit}</span>}

              {isPack ? (
                <div className="flex items-end gap-2">
                  <div className="flex flex-col items-center">
                    <label className="text-xs text-gray-400 font-medium mb-1">paq de {p.pack_size}</label>
                    <input
                      type="number" min="0" step="1" inputMode="numeric" placeholder="—"
                      value={value.packs}
                      onChange={e => setPackCounts(pc => ({
                        ...pc,
                        [p.id]: { ...value, packs: e.target.value }
                      }))}
                      className="w-16 text-center border border-gray-200 rounded-xl px-2 py-2 text-base font-semibold focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                    />
                  </div>
                  <div className="flex flex-col items-center">
                    <label className="text-xs text-gray-400 font-medium mb-1">sueltos</label>
                    <input
                      type="number" min="0" step="1" inputMode="numeric" placeholder="—"
                      value={value.loose}
                      onChange={e => setPackCounts(pc => ({
                        ...pc,
                        [p.id]: { ...value, loose: e.target.value }
                      }))}
                      className="w-16 text-center border border-gray-200 rounded-xl px-2 py-2 text-base font-semibold focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                    />
                  </div>
                </div>
              ) : (
                <input
                  type="number" min="0" step={p.unit ? 'any' : '1'} inputMode={p.unit ? 'decimal' : 'numeric'} placeholder="—"
                  value={value}
                  onChange={e => setCounts(c => ({ ...c, [p.id]: e.target.value }))}
                  className="w-20 text-center border border-gray-200 rounded-xl px-2 py-2 text-base font-semibold focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                />
              )}
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
              <button
                key={c.id}
                onClick={() => setDetailCount(c)}
                className={`w-full flex items-center justify-between px-5 py-4 text-left hover:bg-blue-50/50 transition-colors ${
                  idx < history.length - 1 ? 'border-b border-gray-50' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 text-sm">
                    {formatDateTime(c.counted_at)}
                    {accountLabel(c.account_email) && (
                      <span className="font-normal text-gray-400"> · {accountLabel(c.account_email)}</span>
                    )}
                  </p>
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
              </button>
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

function DetalleArqueo({ count, products, onClose, onSuccess }) {
  const [fetchedCount, setFetchedCount] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [editedCounts, setEditedCounts] = useState({})  // item_id -> text value
  const [editedPackCounts, setEditedPackCounts] = useState({})  // item_id -> { packs: text, loose: text }
  const [isEditing, setIsEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const currentCount = fetchedCount || count
  const currentItems = currentCount.items || []
  const isPending = Number(currentCount.id) < 0

  // Cargar detalles completos al montar
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setLoadError('')
      try {
        const res = await apiFetch(`/api/inventory-counts/${count.id}`)
        const data = await res.json()
        if (!res.ok) {
          setLoadError(data.error || 'No se pudo abrir el arqueo.')
        } else {
          setFetchedCount(data)
        }
      } catch (_) {
        setLoadError('No se pudo abrir el arqueo. Hace falta conexión.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [count.id])

  const handleEditChange = (itemId, field, value) => {
    const item = currentItems.find(i => i.id === itemId)
    if (!item) return
    const product = products.find(p => p.id === item.product_id)
    const hasPacked = hasPack(product)

    if (hasPacked) {
      setEditedPackCounts(pc => ({
        ...pc,
        [itemId]: { ...pc[itemId] || { packs: '', loose: '' }, [field]: value }
      }))
    } else {
      setEditedCounts(c => ({ ...c, [itemId]: value }))
    }
  }

  const handleRetryLoad = async () => {
    setLoading(true)
    setLoadError('')
    try {
      const res = await apiFetch(`/api/inventory-counts/${count.id}`)
      const data = await res.json()
      if (!res.ok) {
        setLoadError(data.error || 'No se pudo abrir el arqueo.')
      } else {
        setFetchedCount(data)
      }
    } catch (_) {
      setLoadError('No se pudo abrir el arqueo. Hace falta conexión.')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError('')

    try {
      const changed = []

      for (const item of currentItems) {
        const product = products.find(p => p.id === item.product_id)
        const hasPacked = hasPack(product)
        let newCounted = null

        if (hasPacked) {
          // Pack product: validate with packCountTotal
          const pc = editedPackCounts[item.id]
          if (pc) {
            newCounted = packCountTotal(pc.packs, pc.loose, product.pack_size)
          }
        } else {
          // Regular product: get from editedCounts
          const text = editedCounts[item.id]
          if (text !== undefined && text !== '') {
            const val = Number(text)
            if (validQuantity(val, product.unit)) {
              newCounted = val
            }
          }
        }

        // Si cambió y es válido, agregar a changed. Si está vacío/inválido, error.
        if (editedCounts[item.id] !== undefined || editedPackCounts[item.id] !== undefined) {
          if (newCounted === null) {
            setSaving(false)
            setSaveError('Revisa los números: hay uno vacío o no válido.')
            return
          }
          if (newCounted !== Number(item.counted)) {
            changed.push({ item_id: item.id, counted: newCounted })
          }
        }
      }

      if (changed.length === 0) {
        setIsEditing(false)
        setSaving(false)
        return
      }

      const res = await apiFetch(`/api/inventory-counts/${count.id}`, {
        method: 'PUT',
        body: JSON.stringify({ items: changed }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSaveError(data.error || 'No se pudo guardar la corrección.')
      } else {
        // Éxito: actualizar el count fetched, salir de edición, limpiar inputs.
        setFetchedCount(data)
        setEditedCounts({})
        setEditedPackCounts({})
        setIsEditing(false)
        // Llamar a onSuccess para que actualice la lista en el padre.
        onSuccess()
      }
    } catch (_) {
      setSaveError('Hace falta conexión para corregir un arqueo.')
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setEditedCounts({})
    setEditedPackCounts({})
    setIsEditing(false)
  }

  const faltantes = currentItems.filter(i => Number(i.difference) < 0)
  const sobrantes = currentItems.filter(i => Number(i.difference) > 0)
  const exactos = currentItems.filter(i => Number(i.difference) === 0)

  if (loading) return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-32 md:pb-8">
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={onClose}
          className="p-2 -ml-2 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h2 className="text-2xl font-bold text-gray-900">Detalle del arqueo</h2>
      </div>
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
      </div>
    </div>
  )

  if (loadError) return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-32 md:pb-8">
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={onClose}
          className="p-2 -ml-2 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h2 className="text-2xl font-bold text-gray-900">Detalle del arqueo</h2>
      </div>
      <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 mb-4 text-sm font-medium">
        <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p>{loadError}</p>
          <button
            onClick={handleRetryLoad}
            className="mt-3 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-100 rounded-lg transition-colors"
          >
            Reintentar
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-32 md:pb-8">
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={onClose}
          className="p-2 -ml-2 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h2 className="text-2xl font-bold text-gray-900">Detalle del arqueo</h2>
      </div>

      {isPending && (
        <div className="flex items-start gap-2.5 bg-amber-50 text-amber-800 rounded-xl px-4 py-3 mb-4 text-sm font-medium">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span>Pendiente de sincronizar: aún no se puede corregir.</span>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900">
              {formatDateTime(currentCount.counted_at)}
              {accountLabel(currentCount.account_email) && (
                <span className="font-normal text-gray-400"> · {accountLabel(currentCount.account_email)}</span>
              )}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {currentCount.lines_count} {currentCount.lines_count === 1 ? 'producto' : 'productos'} contados
            </p>
          </div>
          {!isPending && !isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              className="px-3 py-2 text-xs font-semibold text-[#007AFF] hover:bg-blue-50 rounded-lg transition-colors flex-shrink-0"
            >
              Corregir
            </button>
          )}
        </div>
        {currentCount.note && <p className="text-xs text-gray-400 italic">{currentCount.note}</p>}
      </div>

      {isEditing && (
        <div className="flex items-start gap-2.5 bg-blue-50 text-[#007AFF] rounded-xl px-4 py-3 mb-4">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed font-medium">
            El stock se mueve por la diferencia que corrijas.
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4">
        {[...faltantes, ...sobrantes, ...exactos].map((item, idx, arr) => {
          const product = products.find(p => p.id === item.product_id)
          const hasPacked = hasPack(product)
          const isReadOnly = item.recounted_later || isPending || !isEditing

          if (hasPacked && isEditing) {
            const pc = editedPackCounts[item.id] || { packs: '', loose: '' }

            return (
              <div
                key={item.id}
                className={`border-b border-gray-50 last:border-b-0 p-5 ${
                  item.recounted_later ? 'bg-gray-50' : ''
                }`}
              >
                <p className="text-sm font-medium text-gray-900 mb-3">{item.product_name}</p>
                <p className="text-xs text-gray-400 mb-3">
                  Sistema {formatPackStock(item.expected, product.pack_size)} · esperado {formatPackStock(item.expected, product.pack_size)}
                </p>

                {isReadOnly ? (
                  <p className="text-xs text-gray-400 mb-2">Contado {formatPackStock(item.counted, product.pack_size)}</p>
                ) : (
                  <div className="flex items-end gap-2">
                    <div className="flex flex-col items-center">
                      <label className="text-xs text-gray-400 font-medium mb-1">paq de {product.pack_size}</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        placeholder="—"
                        value={pc.packs}
                        onChange={e => handleEditChange(item.id, 'packs', e.target.value)}
                        className="w-16 text-center border border-gray-200 rounded-xl px-2 py-2 text-base font-semibold focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                      />
                    </div>
                    <div className="flex flex-col items-center">
                      <label className="text-xs text-gray-400 font-medium mb-1">sueltos</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        placeholder="—"
                        value={pc.loose}
                        onChange={e => handleEditChange(item.id, 'loose', e.target.value)}
                        className="w-16 text-center border border-gray-200 rounded-xl px-2 py-2 text-base font-semibold focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                      />
                    </div>
                  </div>
                )}

                {item.recounted_later && isEditing && (
                  <p className="text-xs text-gray-400 mt-2">Contado de nuevo después</p>
                )}

                <p className="text-xs text-gray-400 mt-3">
                  Diferencia: {Number(item.difference) < 0 ? '−' : '+'}{Math.abs(Number(item.difference))} {hasPacked ? 'sueltos' : 'uds'}
                </p>
              </div>
            )
          }

          if (!hasPacked && isEditing) {
            const textValue = editedCounts[item.id] !== undefined ? editedCounts[item.id] : ''

            return (
              <div
                key={item.id}
                className={`flex items-end gap-4 px-5 py-4 border-b border-gray-50 last:border-b-0 ${
                  item.recounted_later ? 'bg-gray-50' : ''
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{item.product_name}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    Sistema {item.expected} · esperado {item.expected}
                  </p>
                </div>

                {isReadOnly ? (
                  <p className="text-sm font-semibold text-gray-600 flex-shrink-0">Contado {item.counted}</p>
                ) : (
                  <input
                    type="number"
                    min="0"
                    step={product?.unit ? 'any' : '1'}
                    inputMode={product?.unit ? 'decimal' : 'numeric'}
                    placeholder="—"
                    value={textValue}
                    onChange={e => handleEditChange(item.id, 'counted', e.target.value)}
                    className="w-20 text-center border border-gray-200 rounded-xl px-2 py-2 text-base font-semibold focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors flex-shrink-0"
                  />
                )}

                {item.recounted_later && (
                  <p className="text-xs text-gray-400">Contado de nuevo después</p>
                )}
              </div>
            )
          }

          // Display mode (not editing)
          return (
            <div
              key={item.id}
              className={`flex items-center justify-between px-5 py-3.5 border-b border-gray-50 last:border-b-0`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{item.product_name}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {hasPacked ? (
                    <>
                      Sistema {formatPackStock(item.expected, product.pack_size)} · contado {formatPackStock(item.counted, product.pack_size)}
                    </>
                  ) : (
                    <>
                      Sistema {item.expected} · contado {item.counted}
                    </>
                  )}
                </p>
              </div>
              {Number(item.difference) === 0 ? (
                <span className="text-xs font-semibold text-green-600 flex-shrink-0">✓</span>
              ) : (
                <span className={`text-sm font-bold flex-shrink-0 ${
                  Number(item.difference) < 0 ? 'text-red-600' : 'text-orange-500'
                }`}>
                  {Number(item.difference) > 0 ? '+' : '−'}{Math.abs(Number(item.difference))} {hasPacked ? 'sueltos' : ''}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {saveError && (
        <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 mb-4 text-sm font-medium">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{saveError}</span>
        </div>
      )}

      {isEditing && (
        <div className="fixed bottom-0 left-0 right-0 md:left-56 bg-white/95 backdrop-blur border-t border-gray-200 px-5 py-4 safe-area-bottom">
          <div className="max-w-2xl mx-auto flex items-center gap-3">
            <button
              onClick={handleCancel}
              className="flex-1 bg-white border border-gray-200 text-gray-600 py-3.5 rounded-2xl font-bold hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-[#007AFF] text-white py-3.5 rounded-2xl font-bold hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200 disabled:shadow-none"
            >
              {saving ? 'Guardando...' : 'Guardar corrección'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Resultado({ result, products, onNew }) {
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
        {[...faltantes, ...sobrantes, ...exactos].map((item, idx, arr) => {
          const product = products.find(p => p.id === item.product_id)
          const hasPacked = hasPack(product)

          return (
            <div
              key={item.id}
              className={`flex items-center justify-between px-5 py-3.5 ${
                idx < arr.length - 1 ? 'border-b border-gray-50' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{item.product_name}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {hasPacked ? (
                    <>
                      Sistema {formatPackStock(item.expected, product.pack_size)} · contado {formatPackStock(item.counted, product.pack_size)}
                    </>
                  ) : (
                    <>
                      Sistema {item.expected} · contado {item.counted}
                    </>
                  )}
                </p>
              </div>
              {item.difference === 0 ? (
                <span className="text-xs font-semibold text-green-600 flex-shrink-0">✓</span>
              ) : (
                <span className={`text-sm font-bold flex-shrink-0 ${
                  item.difference < 0 ? 'text-red-600' : 'text-orange-500'
                }`}>
                  {item.difference > 0 ? '+' : '−'}{Math.abs(item.difference)} {hasPacked ? 'sueltos' : ''}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {result.pending && <p className="text-xs text-amber-700 text-center mb-3">Guardado en este dispositivo. Pendiente de sincronizar.</p>}
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
