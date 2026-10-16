import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { useBusinessDayRefresh } from '../lib/useBusinessDayRefresh.js'
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Pencil, Trash2, X, Package, ClipboardCheck, Upload, Info, AlertTriangle } from 'lucide-react'
import { apiFetch, isElectron } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { accountLabel } from '../lib/accountLabel'
import { UNITS, formatQty, priceSuffix, hasPack, formatPackStock } from '../lib/units'
import ProductDayStock from '../components/ProductDayStock.jsx'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))
const fmt2 = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(Number(n) || 0)
const round4 = (n) => Math.round(Number(n) * 10000) / 10000
const round2 = (n) => Math.round(Number(n) * 100) / 100
const EMPTY = { name: '', purchase_price: '', sale_price: '', stock: '', unit: '', track_stock: false, add_stock: '', stock_reason: '', pack_size: '', pack_price: '', pack_cost: '', pack_on: false, stock_packs: '', stock_loose: '', add_stock_packs: '', add_stock_loose: '' }

// Cada movimiento del registro de stock: mercancía recibida, stock puesto a
// mano por la cuenta principal o unidades que volvieron al anular una venta.
const ENTRY_KIND = {
  entrada:    { label: 'Entrada',    color: 'text-green-600' },
  nuevo:      { label: 'Producto nuevo', color: 'text-green-600' },
  importacion: { label: 'Importación', color: 'text-green-600' },
  correccion: { label: 'Corrección', color: 'text-[#007AFF]' },
  anulacion:  { label: 'Venta anulada', color: 'text-orange-600' },
}

export default function Products() {
  const { user } = useAuth()
  // Decisión del negocio: el empleado da de alta productos nuevos (el dueño
  // delega la carga de mercancía) y puede editar su precio de venta.
  // Los permisos también se validan en el servidor y en el router local
  // de la caja de escritorio.
  const isOwner = user?.role !== 'cajero'

  const [products,  setProducts]  = useState([])
  const [dayStock,  setDayStock]  = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [showForm,  setShowForm]  = useState(false)
  const [editing,   setEditing]   = useState(null)
  const [form,      setForm]      = useState(EMPTY)
  const [saving,    setSaving]    = useState(false)
  const [search,    setSearch]    = useState('')
  const [formError, setFormError] = useState('')
  const [notice,    setNotice]    = useState('')

  const load = async () => {
    try {
      const res = await apiFetch('/api/products'), data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar el catálogo')
      setProducts(Array.isArray(data) ? data : [])
    } catch (error) { setNotice(error.message) }
    finally { setLoading(false) }
    if (isOwner) {
      try {
        const res = await apiFetch('/api/products/day-stock')
        const data = await res.json()
        if (res.ok && Array.isArray(data.products)) setDayStock(data)
        else setDayStock(null)
      } catch (_) { setDayStock(null) }
    } else setDayStock(null)
  }

  useEffect(() => { load() }, [])
  useLocalRefresh(load)
  useBusinessDayRefresh(load)
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  // En la caja de escritorio el catálogo puede cambiar desde la web con esta
  // pantalla abierta: el sync worker avisa y la lista se recarga sola.
  useEffect(() => {
    if (!isElectron()) return
    return window.electronAPI.onSyncStatus((status) => {
      if (status.catalogChanged) load()
    })
  }, [])

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  )

  const openNew = () => { setEditing(null); setForm(EMPTY); setFormError(''); setShowForm(true) }
  const openEdit = (p) => {
    setEditing(p)
    const hasPack = p.pack_size && Number(p.pack_size) > 1
    const packCost = hasPack ? round2(Number(p.purchase_price) * Number(p.pack_size)) : ''
    const stockPacks = hasPack ? Math.floor(Number(p.stock) / Number(p.pack_size)) : ''
    const stockLoose = hasPack ? (Number(p.stock) % Number(p.pack_size)) : ''
    setForm({
      name: p.name,
      purchase_price: p.purchase_price,
      sale_price: p.sale_price,
      stock: p.stock,
      unit: p.unit || '',
      track_stock: !p.unit || Number(p.track_stock) === 1,
      add_stock: '',
      stock_reason: '',
      pack_size: p.pack_size || '',
      pack_price: p.pack_price || '',
      pack_cost: packCost,
      pack_on: hasPack,
      stock_packs: stockPacks,
      stock_loose: stockLoose,
      add_stock_packs: '',
      add_stock_loose: ''
    })
    setFormError('')
    setShowForm(true)
  }
  const closeForm = () => { setShowForm(false); setEditing(null); setForm(EMPTY); setFormError('') }

  const [showEntries, setShowEntries] = useState(false)
  const [entries, setEntries] = useState(null)
  const [entriesError, setEntriesError] = useState('')
  const openEntries = async () => {
    setShowEntries(true); setEntries(null); setEntriesError('')
    try {
      const res = await apiFetch('/api/products/stock-entries')
      const data = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(data)) { setEntriesError((data && data.error) || 'No se pudo cargar el historial. Hace falta conexión.'); return }
      setEntries(data)
    } catch (_) { setEntriesError('No se pudo cargar el historial. Hace falta conexión.') }
  }

  // Para productos con paquete, el add_stock viene en paquetes + sueltos
  const hasPack_ = !form.unit && form.pack_on
  const addPreview = hasPack_
    ? (Number(form.add_stock_packs || 0) * Number(form.pack_size)) + (parseFloat(String(form.add_stock_loose ?? '').replace(',', '.')) || 0)
    : parseFloat(String(form.add_stock ?? '').replace(',', '.')) || 0

  // Compute effective stock for stock correction detection
  const effectiveStock = hasPack_
    ? (Number(form.stock_packs || 0) * Number(form.pack_size)) + (Number(form.stock_loose || 0))
    : (form.unit ? parseFloat(String(form.stock).replace(',', '.')) : parseInt(form.stock))

  // La cuenta principal cambió el stock a mano: se le pide (opcional) el motivo.
  const stockChanged = !!editing && isOwner && !addPreview && effectiveStock !== Number(editing.stock)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setFormError('')

    // Validar paquete si está activado
    if (hasPack_) {
      const packSize = parseInt(form.pack_size || 0)
      const packPrice = parseFloat(form.pack_price || 0)
      if (packSize < 2) {
        setFormError('Unidades por paquete debe ser 2 o más.')
        setSaving(false)
        return
      }
      if (!Number.isFinite(packPrice) || packPrice < 0) {
        setFormError('Precio del paquete debe ser un valor válido.')
        setSaving(false)
        return
      }

      // Validar stock de paquete (empty = 0, must be non-negative integers)
      const stockPacksVal = Number(form.stock_packs || 0)
      const stockLooseVal = Number(form.stock_loose || 0)
      if (!Number.isInteger(stockPacksVal) || stockPacksVal < 0 || !Number.isInteger(stockLooseVal) || stockLooseVal < 0) {
        setFormError('Paquetes y sueltos deben ser números enteros no negativos.')
        setSaving(false)
        return
      }

      // Validar add_stock de paquete (empty = 0, must be non-negative integers)
      if (addPreview > 0) {
        const addPacksVal = Number(form.add_stock_packs || 0)
        const addLooseVal = Number(form.add_stock_loose || 0)
        if (!Number.isInteger(addPacksVal) || addPacksVal < 0 || !Number.isInteger(addLooseVal) || addLooseVal < 0) {
          setFormError('Paquetes y sueltos a añadir deben ser números enteros no negativos.')
          setSaving(false)
          return
        }
      }
    }

    const addStock = hasPack_
      ? (Number(form.add_stock_packs || 0) * Number(form.pack_size)) + (parseFloat(String(form.add_stock_loose ?? '').replace(',', '.')) || 0)
      : form.add_stock === '' || form.add_stock == null ? 0 : parseFloat(String(form.add_stock).replace(',', '.'))

    const computedStock = hasPack_
      ? (Number(form.stock_packs || 0) * Number(form.pack_size)) + (Number(form.stock_loose || 0))
      : (form.unit ? parseFloat(String(form.stock).replace(',', '.')) : parseInt(form.stock)) || 0

    // Cost calculation: if pack_cost is provided, compute per-unit cost; otherwise use purchase_price
    let finalPurchasePrice = parseFloat(form.purchase_price) || 0
    if (hasPack_ && form.pack_cost && Number(form.pack_cost) > 0 && Number(form.pack_size) >= 2) {
      finalPurchasePrice = round4(Number(form.pack_cost) / Number(form.pack_size))
    }

    const body = editing && !isOwner ? { sale_price: parseFloat(form.sale_price), ...(addStock > 0 && { add_stock: addStock }) } : {
      name: form.name,
      purchase_price: finalPurchasePrice,
      sale_price: parseFloat(form.sale_price),
      stock: computedStock,
      unit: form.unit || null,
      ...(form.unit && { track_stock: !!form.track_stock }),
      ...(hasPack_ && { pack_size: parseInt(form.pack_size), pack_price: parseFloat(form.pack_price) }),
      ...(!hasPack_ && { pack_size: null, pack_price: null }),
      ...(editing && addStock > 0 && { add_stock: addStock }),
      ...(stockChanged && form.stock_reason.trim() && { stock_reason: form.stock_reason.trim() }),
    }
    try {
      const res = await apiFetch(editing ? `/api/products/${editing.id}` : '/api/products', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      // Antes la respuesta no se miraba: si el guardado fallaba, el formulario
      // se cerraba igual y parecía que el producto se había creado.
      if (!res.ok) {
        setFormError(data.error || 'No se pudo guardar el producto.')
        return
      }
      if (data.pending) setNotice('Producto guardado en este dispositivo. Se subirá al recuperar la conexión.')
      if (data.merged) {
        setNotice(`«${data.name}» ya existía, así que no se creó otro. Se mantienen su precio y su stock.`)
      }
      await load()
      closeForm()
    } catch (_) {
      setFormError('No se pudo guardar el producto en este dispositivo. Vuelve a intentar.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id, name) => {
    if (!confirm(`¿Eliminar "${name}"?`)) return
    try {
      const res = await apiFetch(`/api/products/${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) { setNotice(data.error || 'No se pudo eliminar el producto.'); return }
      await load()
    } catch (error) { setNotice(error.message || 'No se pudo eliminar el producto') }
  }

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm(f => ({ ...f, [key]: e.target.value })),
    className: 'w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors',
  })

  // Custom handler for pack_size: re-split stock when size changes
  const handlePackSizeChange = (e) => {
    const newSize = e.target.value
    setForm(f => {
      // Compute current total stock with old pack_size
      const currentTotal = (Number(f.stock_packs || 0) * Number(f.pack_size || 1)) + (Number(f.stock_loose || 0))

      // If new size is not valid, put everything in stock_loose
      const newSizeNum = Number(newSize || 0)
      if (!Number.isInteger(newSizeNum) || newSizeNum < 2) {
        return { ...f, pack_size: newSize, stock_packs: '', stock_loose: String(currentTotal) }
      }

      // Re-split with new size
      const newPacks = Math.floor(currentTotal / newSizeNum)
      const newLoose = currentTotal % newSizeNum
      return { ...f, pack_size: newSize, stock_packs: String(newPacks), stock_loose: String(newLoose) }
    })
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="p-5 md:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold text-gray-900">Productos</h2>
        <div className="flex items-center gap-2">
          {/* Importar: solo dueño y solo web — el router local del escritorio
              no tiene esta ruta todavía. */}
          {isOwner && !isElectron() && (
            <Link
              to="/products/importar"
              title="Importar desde Excel"
              className="flex items-center gap-2 bg-white border border-gray-200 text-gray-600 px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-50 active:scale-95 transition-all"
            >
              <Upload size={17} />
              <span className="hidden sm:inline">Importar</span>
            </Link>
          )}
          {isOwner && (
            <button
              onClick={openEntries}
              title="Historial de movimientos de stock"
              className="flex items-center gap-2 bg-white border border-gray-200 text-gray-600 px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-50 active:scale-95 transition-all"
            >
              <Info size={17} />
              <span className="hidden sm:inline">Entradas</span>
            </button>
          )}
          <Link
            to="/inventario"
            title="Contar inventario"
            className="flex items-center gap-2 bg-white border border-gray-200 text-gray-600 px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-50 active:scale-95 transition-all"
          >
            <ClipboardCheck size={17} />
            <span className="hidden sm:inline">Contar</span>
          </Link>
          <button
            onClick={openNew}
            className="flex items-center gap-2 bg-[#007AFF] text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-blue-600 active:scale-95 transition-all"
          >
            <Plus size={18} />
            Nuevo
          </button>
        </div>
      </div>

      {!isOwner && (
        <div className="flex items-start gap-2.5 bg-blue-50 text-[#007AFF] rounded-xl px-4 py-3 mb-4">
          <Info size={16} className="flex-shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed font-medium">
            Puedes dar de alta productos nuevos, cambiar su precio de venta y añadir stock (queda registrado a tu nombre). Los demás cambios
            y la eliminación de productos los hace el dueño.
          </p>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2.5 bg-orange-50 text-orange-800 rounded-xl px-4 py-3 mb-4">
          <Info size={16} className="flex-shrink-0 mt-0.5" />
          <p className="text-sm flex-1">{notice}</p>
          <button onClick={() => setNotice('')} className="opacity-60 hover:opacity-100">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Search */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Buscar producto..."
        className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm mb-4 focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
      />

      {/* Modal form */}
      {showEntries && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Movimientos de stock</h3>
              <button onClick={() => setShowEntries(false)} className="p-2 hover:bg-gray-100 rounded-xl transition-colors">
                <X size={20} className="text-gray-500" />
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              {entriesError && <p className="text-sm text-red-600 font-medium">{entriesError}</p>}
              {!entriesError && entries === null && <p className="text-sm text-gray-400">Cargando...</p>}
              {entries && entries.length === 0 && <p className="text-sm text-gray-400">Todavía no hay movimientos de stock.</p>}
              {entries && entries.map(e => {
                const kind = ENTRY_KIND[e.kind] || ENTRY_KIND.entrada
                const qty = Number(e.quantity)
                return (
                  <div key={e.id} className="py-3 border-b border-gray-100 last:border-0">
                    <div className="flex justify-between gap-3">
                      <span className="font-semibold text-gray-900 text-sm">{e.product_name}</span>
                      <span className={`font-bold text-sm ${qty < 0 ? 'text-red-600' : kind.color}`}>{qty > 0 ? '+' : ''}{qty}</span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      <span className={`font-semibold ${kind.color}`}>{kind.label}</span> · {Number(e.stock_before)} → {Number(e.stock_after)} · {e.account_email || 'cuenta desconocida'} · {new Date(String(e.created_at).replace(' ', 'T') + 'Z').toLocaleString()}
                    </p>
                    {e.reason && <p className="text-xs text-gray-500 italic mt-0.5">«{e.reason}»</p>}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">
            <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100 flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">
                {editing ? (isOwner ? 'Editar producto' : 'Editar precio y stock') : 'Nuevo producto'}
              </h3>
              <button onClick={closeForm} className="p-2 hover:bg-gray-100 rounded-xl transition-colors">
                <X size={20} className="text-gray-500" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                  Nombre del producto
                </label>
                <input disabled={!!editing && !isOwner} required placeholder="Ej: Coca-Cola 600ml" {...field('name')} />
              </div>
              {/* Productos fraccionados: el precio y el stock pasan a ser por
                  kg, g o lb, y en la venta se marca cuánto pesa lo que se lleva. */}
              {(!editing || isOwner) && (
                <div className="rounded-xl border border-gray-200 px-4 py-3">
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!form.unit}
                      onChange={(e) => setForm(f => ({ ...f, unit: e.target.checked ? 'lb' : '' }))}
                      className="w-5 h-5 accent-[#007AFF]"
                    />
                    <span className="text-sm font-semibold text-gray-800">Se vende por peso</span>
                  </label>
                  {form.unit && (
                    <div className="mt-3">
                      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                        Unidad de medida
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {UNITS.map(u => (
                          <button
                            type="button"
                            key={u.value}
                            onClick={() => setForm(f => ({ ...f, unit: u.value }))}
                            className={`min-w-0 py-2.5 rounded-xl text-sm font-bold border-2 transition-colors ${
                              form.unit === u.value
                                ? 'border-[#007AFF] bg-blue-50 text-[#007AFF]'
                                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                            }`}
                          >
                            {u.value}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-gray-400 mt-2">
                        Los precios son por {form.unit}. Al vender, escribes cuántos {form.unit} se lleva el cliente y se calcula el total.
                      </p>
                      <label className="flex items-start gap-3 cursor-pointer select-none mt-3">
                        <input
                          type="checkbox"
                          checked={!!form.track_stock}
                          onChange={(e) => setForm(f => ({ ...f, track_stock: e.target.checked }))}
                          className="w-5 h-5 accent-[#007AFF] mt-0.5"
                        />
                        <span>
                          <span className="text-sm font-semibold text-gray-800 block">Llevar control de stock</span>
                          <span className="text-xs text-gray-400">
                            Opcional. Si lo dejas apagado, se vende siempre sin contar las {form.unit} que quedan.
                            Si lo activas, anotas las {form.unit} que llegan y cada venta las descuenta.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              )}
              {/* Venta por paquete: solo para productos sin peso, en la web, y si es dueño */}
              {(!editing || isOwner) && !form.unit && !isElectron() && (
                <div className="rounded-xl border border-gray-200 px-4 py-3">
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={form.pack_on}
                      onChange={(e) => setForm(f => e.target.checked
                        ? { ...f, pack_on: true, stock_packs: '', stock_loose: String(f.stock || 0) }
                        : { ...f, pack_on: false, pack_size: '', pack_price: '', pack_cost: '', add_stock_packs: '', add_stock_loose: '', stock_packs: '', stock_loose: '' }
                      )}
                      className="w-5 h-5 accent-[#007AFF]"
                    />
                    <span className="text-sm font-semibold text-gray-800">También se vende por paquete</span>
                  </label>
                  {hasPack_ && (
                    <div className="mt-3 space-y-3">
                      <p className="text-xs text-gray-400">
                        Ej.: cajetilla de 20 cigarros o paquete de galletas
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="min-w-0">
                          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                            Unidades por paquete *
                          </label>
                          <input type="number" required min="2" step="1" placeholder="20" value={form.pack_size} onChange={handlePackSizeChange} className='w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors' />
                        </div>
                        <div className="min-w-0">
                          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                            Precio del paquete *
                          </label>
                          <input type="number" required step="0.01" min="0" placeholder="0.00" {...field('pack_price')} />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                          Costo del paquete
                        </label>
                        <input type="number" step="0.01" min="0" placeholder="0.00" {...field('pack_cost')} />
                        {form.pack_cost && Number(form.pack_cost) > 0 && Number(form.pack_size) > 0 && (
                          <p className="text-xs text-gray-400 mt-1.5">
                            Cada suelto te cuesta {fmt2(Number(form.pack_cost) / Number(form.pack_size))}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className={editing && !isOwner ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'}>
                {(!editing || isOwner) && <div className="min-w-0">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    Precio compra{form.unit ? ` por ${form.unit}` : hasPack_ ? ' del suelto' : ''}
                  </label>
                  {hasPack_ && form.pack_cost && Number(form.pack_cost) > 0 && Number(form.pack_size) >= 2 ? (
                    <div className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base bg-gray-50 text-gray-600 select-none">
                      {fmt2(round4(Number(form.pack_cost) / Number(form.pack_size)))}
                    </div>
                  ) : (
                    <input type="number" step="0.01" min="0" placeholder="0.00" {...field('purchase_price')} />
                  )}
                </div>}
                <div className="min-w-0">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    Precio venta{form.unit ? ` por ${form.unit}` : hasPack_ ? ' del suelto' : ''} *
                  </label>
                  <input required type="number" step="0.01" min="0" placeholder="0.00" {...field('sale_price')} />
                </div>
              </div>
              {(!form.unit || form.track_stock) && (
                <>
                  {!hasPack_ ? (
                    <div>
                      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                        {editing ? 'Stock' : 'Stock inicial'}{form.unit ? ` (${form.unit})` : ''}
                      </label>
                      <input disabled={!!editing && !isOwner} type="number" min="0" step={form.unit ? 'any' : '1'} inputMode={form.unit ? 'decimal' : 'numeric'} placeholder="0" {...field('stock')} />
                      {stockChanged && (
                        <>
                          <p className="text-xs text-gray-400 mt-1.5">
                            Corrección: {Number(editing.stock)} → {effectiveStock}. Queda anotada a tu nombre.
                          </p>
                          <div className="mt-1.5">
                            <input type="text" maxLength={200} placeholder="Motivo (opcional): conteo, se rompieron..." {...field('stock_reason')} />
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <div>
                      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                        {editing ? 'Stock actual' : 'Stock inicial'}
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="min-w-0">
                          <label className="text-xs text-gray-400 mb-1 block">Paquetes</label>
                          <input disabled={!!editing && !isOwner} type="number" min="0" step="1" inputMode="numeric" placeholder="0" {...field('stock_packs')} />
                        </div>
                        <div className="min-w-0">
                          <label className="text-xs text-gray-400 mb-1 block">Sueltos</label>
                          <input disabled={!!editing && !isOwner} type="number" min="0" step="1" inputMode="numeric" placeholder="0" {...field('stock_loose')} />
                        </div>
                      </div>
                      {stockChanged && (
                        <>
                          <p className="text-xs text-gray-400 mt-1.5">
                            Corrección: {formatPackStock(Number(editing.stock), Number(form.pack_size))} → {formatPackStock(effectiveStock, Number(form.pack_size))}. Queda anotada a tu nombre.
                          </p>
                          <div className="mt-1.5">
                            <input type="text" maxLength={200} placeholder="Motivo (opcional): conteo, se rompieron..." {...field('stock_reason')} />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
              {editing && (!form.unit || form.track_stock) && (
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    {hasPack_ ? '¿Cuántos llegaron?' : `Añadir al stock${form.unit ? ` (${form.unit})` : ''}`}
                  </label>
                  {hasPack_ ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="min-w-0">
                        <label className="text-xs text-gray-400 mb-1 block">Paquetes</label>
                        <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" {...field('add_stock_packs')} />
                      </div>
                      <div className="min-w-0">
                        <label className="text-xs text-gray-400 mb-1 block">Sueltos (opcional)</label>
                        <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" {...field('add_stock_loose')} />
                      </div>
                    </div>
                  ) : (
                    <input type="number" min="0" step={form.unit ? 'any' : '1'} inputMode={form.unit ? 'decimal' : 'numeric'} placeholder="Cantidad que llegó" {...field('add_stock')} />
                  )}
                  {addPreview > 0 && (
                    <p className="text-xs text-gray-400 mt-1.5">
                      Quedará en {hasPack_ ? formatPackStock(effectiveStock + addPreview, Number(form.pack_size)) : Math.round((effectiveStock + addPreview) * 1000) / 1000}{form.unit ? ` ${form.unit}` : ''}
                    </p>
                  )}
                </div>
              )}

              <div className="sticky bottom-0 bg-white -mx-6 px-6 pt-3 pb-1 border-t border-gray-100">
                {formError && (
                  <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 text-sm font-medium mb-3">
                    <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                    <span>{formError}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full bg-[#007AFF] text-white py-3.5 rounded-xl font-semibold text-base hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50"
                >
                  {saving ? 'Guardando...' : editing ? 'Guardar cambios' : 'Agregar producto'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Product table */}
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <Package size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">{products.length === 0 ? 'No hay productos' : 'Sin resultados'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Producto</th>
                  {isOwner && (
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider hidden sm:table-cell">Compra</th>
                  )}
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Venta</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Stock</th>
                  <th className="px-5 py-3 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-4">
                      <span className="font-medium text-gray-900 text-sm">{p.name}</span>
                      {isOwner && p.created_by_email && p.created_by_email !== user?.email && (
                        <span className="block text-xs text-gray-400 mt-0.5">
                          agregado por {accountLabel(p.created_by_email)}
                        </span>
                      )}
                      {isOwner && <ProductDayStock product={p} dayStock={dayStock} className="mt-1" />}
                    </td>
                    {isOwner && (
                      <td className="px-5 py-4 text-right text-gray-400 text-sm hidden sm:table-cell">{fmt(p.purchase_price)}{priceSuffix(p.unit)}</td>
                    )}
                    <td className="px-5 py-4 text-right font-semibold text-gray-900 text-sm">
                      <div>{fmt(p.sale_price)}{priceSuffix(p.unit)}</div>
                      {hasPack(p) && (
                        <div className="text-xs text-gray-400 mt-0.5">paquete ×{p.pack_size} {fmt(p.pack_price)}</div>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg ${
                        p.unit && Number(p.track_stock) !== 1 ? 'bg-gray-100 text-gray-500' :
                        p.stock === 0 ? 'bg-red-50 text-red-600' :
                        p.stock <= 5  ? 'bg-orange-50 text-orange-600' :
                                        'bg-green-50 text-green-700'
                      }`}>
                        {p.unit && Number(p.track_stock) !== 1 ? 'Sin control' : hasPack(p) ? formatPackStock(p.stock, p.pack_size) : formatQty(p.stock, p.unit)}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(p)}
                          title={isOwner ? 'Editar producto' : 'Editar precio y stock'}
                          aria-label={isOwner ? 'Editar producto' : 'Editar precio y stock'}
                          className="p-2 hover:bg-gray-100 rounded-xl text-gray-400 hover:text-gray-700 transition-colors"
                        >
                          <Pencil size={15} />
                        </button>
                        {isOwner && <button
                          onClick={() => handleDelete(p.id, p.name)}
                          className="p-2 hover:bg-red-50 rounded-xl text-gray-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={15} />
                        </button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 text-right mt-3">{products.length} productos en total</p>
    </div>
  )
}
