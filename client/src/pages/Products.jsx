import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, X, Package } from 'lucide-react'
import { apiFetch } from '../lib/api'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))
const EMPTY = { name: '', purchase_price: '', sale_price: '', stock: '' }

export default function Products() {
  const [products, setProducts] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing,  setEditing]  = useState(null)
  const [form,     setForm]     = useState(EMPTY)
  const [saving,   setSaving]   = useState(false)
  const [search,   setSearch]   = useState('')

  const load = () =>
    apiFetch('/api/products').then(r => r.json()).then(d => { setProducts(d); setLoading(false) })

  useEffect(() => { load() }, [])

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  )

  const openNew = () => { setEditing(null); setForm(EMPTY); setShowForm(true) }
  const openEdit = (p) => {
    setEditing(p)
    setForm({ name: p.name, purchase_price: p.purchase_price, sale_price: p.sale_price, stock: p.stock })
    setShowForm(true)
  }
  const closeForm = () => { setShowForm(false); setEditing(null); setForm(EMPTY) }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    const body = {
      name: form.name,
      purchase_price: parseFloat(form.purchase_price) || 0,
      sale_price: parseFloat(form.sale_price),
      stock: parseInt(form.stock) || 0,
    }
    await apiFetch(editing ? `/api/products/${editing.id}` : '/api/products', {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    })
    await load()
    closeForm()
    setSaving(false)
  }

  const handleDelete = async (id, name) => {
    if (!confirm(`¿Eliminar "${name}"?`)) return
    await apiFetch(`/api/products/${id}`, { method: 'DELETE' })
    await load()
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
        <button
          onClick={openNew}
          className="flex items-center gap-2 bg-[#007AFF] text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-blue-600 active:scale-95 transition-all"
        >
          <Plus size={18} />
          Nuevo
        </button>
      </div>

      {/* Search */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Buscar producto..."
        className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm mb-4 focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
      />

      {/* Modal form */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">
                {editing ? 'Editar producto' : 'Nuevo producto'}
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
                <input required placeholder="Ej: Coca-Cola 600ml" {...field('name')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    Precio compra
                  </label>
                  <input type="number" step="0.01" min="0" placeholder="0.00" {...field('purchase_price')} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    Precio venta *
                  </label>
                  <input required type="number" step="0.01" min="0" placeholder="0.00" {...field('sale_price')} />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                  Stock
                </label>
                <input type="number" min="0" placeholder="0" {...field('stock')} />
              </div>
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
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider hidden sm:table-cell">Compra</th>
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
                    </td>
                    <td className="px-5 py-4 text-right text-gray-400 text-sm hidden sm:table-cell">{fmt(p.purchase_price)}</td>
                    <td className="px-5 py-4 text-right font-semibold text-gray-900 text-sm">{fmt(p.sale_price)}</td>
                    <td className="px-5 py-4 text-right">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg ${
                        p.stock === 0 ? 'bg-red-50 text-red-600' :
                        p.stock <= 5  ? 'bg-orange-50 text-orange-600' :
                                        'bg-green-50 text-green-700'
                      }`}>
                        {p.stock}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(p)}
                          className="p-2 hover:bg-gray-100 rounded-xl text-gray-400 hover:text-gray-700 transition-colors"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => handleDelete(p.id, p.name)}
                          className="p-2 hover:bg-red-50 rounded-xl text-gray-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={15} />
                        </button>
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
