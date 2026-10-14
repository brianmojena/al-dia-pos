import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Pencil, Trash2, X, Package, ClipboardCheck, Upload, Info, AlertTriangle } from 'lucide-react'
import { apiFetch, isElectron } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { accountLabel } from '../lib/accountLabel'
import { UNITS, formatQty, priceSuffix } from '../lib/units'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))
const EMPTY = { name: '', purchase_price: '', sale_price: '', stock: '', unit: '', track_stock: false, add_stock: '', stock_reason: '' }

// Cada movimiento del registro de stock: mercancía recibida, stock puesto a
// mano por la cuenta principal o unidades que volvieron al anular una venta.
const ENTRY_KIND = {
  entrada:    { label: 'Entrada',    color: 'text-green-600' },
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
  }

  useEffect(() => { load() }, [])
  useLocalRefresh(load)

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
    setForm({ name: p.name, purchase_price: p.purchase_price, sale_price: p.sale_price, stock: p.stock, unit: p.unit || '', track_stock: !p.unit || Number(p.track_stock) === 1, add_stock: '', stock_reason: '' })
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

  const addPreview = parseFloat(String(form.add_stock ?? '').replace(',', '.')) || 0
  // La cuenta principal cambió el stock a mano: se le pide (opcional) el motivo.
  const stockChanged = !!editing && isOwner && !addPreview && String(form.stock) !== '' && Number(String(form.stock).replace(',', '.')) !== Number(editing.stock)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setFormError('')
    const addStock = form.add_stock === '' || form.add_stock == null ? 0 : parseFloat(String(form.add_stock).replace(',', '.'))
    const body = editing && !isOwner ? { sale_price: parseFloat(form.sale_price), ...(addStock > 0 && { add_stock: addStock }) } : {
      name: form.name,
      purchase_price: parseFloat(form.purchase_price) || 0,
      sale_price: parseFloat(form.sale_price),
      stock: (form.unit ? parseFloat(String(form.stock).replace(',', '.')) : parseInt(form.stock)) || 0,
      unit: form.unit || null,
      ...(form.unit && { track_stock: !!form.track_stock }),
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
          {isOwner && (
            <Link
              to="/inventario"
              title="Contar inventario"
              className="flex items-center gap-2 bg-white border border-gray-200 text-gray-600 px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-50 active:scale-95 transition-all"
            >
              <ClipboardCheck size={17} />
              <span className="hidden sm:inline">Contar</span>
            </Link>
          )}
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
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">
                {editing ? (isOwner ? 'Editar producto' : 'Editar precio y stock') : 'Nuevo producto'}
              </h3>
              <button onClick={closeForm} className="p-2 hover:bg-gray-100 rounded-xl transition-colors">
                <X size={20} className="text-gray-500" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
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
                            className={`py-2.5 rounded-xl text-sm font-bold border-2 transition-colors ${
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
              <div className={editing && !isOwner ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3'}>
                {(!editing || isOwner) && <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    Precio compra{form.unit ? ` por ${form.unit}` : ''}
                  </label>
                  <input type="number" step="0.01" min="0" placeholder="0.00" {...field('purchase_price')} />
                </div>}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    Precio venta{form.unit ? ` por ${form.unit}` : ''} *
                  </label>
                  <input required type="number" step="0.01" min="0" placeholder="0.00" {...field('sale_price')} />
                </div>
              </div>
              {(!form.unit || form.track_stock) && <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                  {editing ? 'Stock' : 'Stock inicial'}{form.unit ? ` (${form.unit})` : ''}
                </label>
                <input disabled={!!editing && !isOwner} type="number" min="0" step={form.unit ? 'any' : '1'} inputMode={form.unit ? 'decimal' : 'numeric'} placeholder="0" {...field('stock')} />
                {stockChanged && (
                  <>
                    <p className="text-xs text-gray-400 mt-1.5">
                      Corrección: {Number(editing.stock)} → {Number(String(form.stock).replace(',', '.'))}. Queda anotada a tu nombre.
                    </p>
                    <div className="mt-1.5">
                      <input type="text" maxLength={200} placeholder="Motivo (opcional): conteo, se rompieron..." {...field('stock_reason')} />
                    </div>
                  </>
                )}
              </div>}
              {editing && (!form.unit || form.track_stock) && (
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    Añadir al stock{form.unit ? ` (${form.unit})` : ''}
                  </label>
                  <input type="number" min="0" step={form.unit ? 'any' : '1'} inputMode={form.unit ? 'decimal' : 'numeric'} placeholder="Cantidad que llegó" {...field('add_stock')} />
                  {addPreview > 0 && (
                    <p className="text-xs text-gray-400 mt-1.5">
                      Quedará en {Math.round((Number(form.stock || 0) + addPreview) * 1000) / 1000}{form.unit ? ` ${form.unit}` : ''}
                    </p>
                  )}
                </div>
              )}

              {formError && (
                <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 text-sm font-medium">
                  <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                  <span>{formError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full bg-[#007AFF] text-white py-3.5 rounded-xl font-semibold text-base hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50 mt-2"
              >
                {saving ? 'Guardando...' : editing ? 'Guardar cambios' : 'Agregar producto'}
              </button>
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
                    </td>
                    {isOwner && (
                      <td className="px-5 py-4 text-right text-gray-400 text-sm hidden sm:table-cell">{fmt(p.purchase_price)}{priceSuffix(p.unit)}</td>
                    )}
                    <td className="px-5 py-4 text-right font-semibold text-gray-900 text-sm">{fmt(p.sale_price)}{priceSuffix(p.unit)}</td>
                    <td className="px-5 py-4 text-right">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg ${
                        p.unit && Number(p.track_stock) !== 1 ? 'bg-gray-100 text-gray-500' :
                        p.stock === 0 ? 'bg-red-50 text-red-600' :
                        p.stock <= 5  ? 'bg-orange-50 text-orange-600' :
                                        'bg-green-50 text-green-700'
                      }`}>
                        {p.unit && Number(p.track_stock) !== 1 ? 'Sin control' : formatQty(p.stock, p.unit)}
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
