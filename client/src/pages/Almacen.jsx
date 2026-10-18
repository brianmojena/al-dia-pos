import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Upload, Plus, Pencil, Trash2, X, Warehouse, ArrowRightLeft, History, AlertTriangle, PackagePlus, Store } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { accountLabel } from '../lib/accountLabel'
import { UNITS, formatQty, priceSuffix, roundMoney } from '../lib/units'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(roundMoney(n))
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
const num = (v) => parseFloat(String(v ?? '').replace(',', '.'))
const EMPTY = { name: '', cost: '', quantity: '', unit: '' }
const labelCls = 'text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block'
const inputCls = 'w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors'

// Estos componentes van fuera del componente para que React no los remonte en
// cada render: si se definen dentro, el modal se desmonta al escribir y el
// campo pierde el foco tras cada letra.
const ErrorBox = ({ message }) => message ? (
  <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 text-sm font-medium"><AlertTriangle size={16} className="flex-shrink-0 mt-0.5" /><span>{message}</span></div>
) : null
const Modal = ({ title, onClose, children }) => (
  <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
    <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[90vh] overflow-auto">
      <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-xl"><X size={20} className="text-gray-500" /></button>
      </div>
      {children}
    </div>
  </div>
)

// Almacén: mercancía guardada aparte de la tienda. Solo tiene costo y cantidad.
// Todas las cuentas dan de alta, editan, importan, borran y transfieren; el
// servidor deja quién lo hizo y solo la cuenta principal ve el historial.
export default function Almacen() {
  const { user } = useAuth()
  const isOwner = user?.role !== 'cajero'
  const [items, setItems] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState(null) // { editing, ...campos }
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [transfer, setTransfer] = useState(null) // { item, quantity, sale_price }
  const [fromStore, setFromStore] = useState(null) // { product, quantity, client_transfer_id }
  const [addQty, setAddQty] = useState(null) // { item, quantity, cost }
  const [storeSearch, setStoreSearch] = useState('')
  const [history, setHistory] = useState(null)
  const [changes, setChanges] = useState([])
  const [historyError, setHistoryError] = useState('')

  const load = async () => {
    try {
      const [w, p] = await Promise.all([apiFetch('/api/warehouse'), apiFetch('/api/products')])
      const wd = await w.json(), pd = await p.json()
      if (!w.ok) throw new Error(wd.error || 'No se pudo cargar el almacén')
      setItems(Array.isArray(wd) ? wd : [])
      setProducts(Array.isArray(pd) ? pd : [])
      setNotice('')
    } catch (_) { setNotice('No se pudo cargar el almacén. Hace falta conexión.') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  useLocalRefresh(load)

  const filtered = items.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
  const total = items.reduce((n, i) => n + Number(i.quantity) * Number(i.cost), 0)
  const inStore = (item) => products.find((p) => norm(p.name) === norm(item.name))

  const saveItem = async (e) => {
    e.preventDefault(); setSaving(true); setFormError('')
    const add = String(form.add_quantity ?? '').trim()

    // Check for duplicates on create
    if (!form.editing) {
      const existing = items.find((i) => norm(i.name) === norm(form.name))
      if (existing) {
        setFormError(`«${existing.name}» ya está en el almacén. Usa el botón «Añadir cantidad» de su fila para sumar lo que llegó.`)
        setSaving(false)
        return
      }
    }

    const body = {
      name: form.name, cost: num(form.cost) || 0, unit: form.unit || null,
      ...(form.editing ? (add ? { add_quantity: num(add) } : {}) : { quantity: num(form.quantity) || 0 }),
    }
    try {
      const res = await apiFetch(form.editing ? `/api/warehouse/${form.editing.id}` : '/api/warehouse', { method: form.editing ? 'PUT' : 'POST', body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFormError(data.error || 'No se pudo guardar.'); return }
      await load(); setForm(null)
    } catch (_) { setFormError('No se pudo guardar. Hace falta conexión.') }
    finally { setSaving(false) }
  }

  const removeItem = async (item) => {
    if (!confirm(`¿Eliminar "${item.name}" del almacén?`)) return
    try {
      const res = await apiFetch(`/api/warehouse/${item.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setNotice(data.error || 'No se pudo eliminar.'); return }
      await load()
    } catch (_) { setNotice('No se pudo eliminar. Hace falta conexión.') }
  }

  const doFromStore = async (e) => {
    e.preventDefault(); setSaving(true); setFormError('')
    try {
      const res = await apiFetch('/api/warehouse/from-store', {
        method: 'POST',
        body: JSON.stringify({
          product_id: fromStore.product.id, quantity: num(fromStore.quantity),
          client_transfer_id: fromStore.clientId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFormError(data.error || 'No se pudo pasar.'); return }
      setNotice(`${formatQty(num(fromStore.quantity), fromStore.product.unit)} de «${fromStore.product.name}» pasaron al almacén.`)
      setFromStore(null); await load()
    } catch (_) { setFormError('No se pudo pasar. Hace falta conexión.') }
    finally { setSaving(false) }
  }

  const doAddQty = async (e) => {
    e.preventDefault(); setSaving(true); setFormError('')
    const cost = String(addQty.cost ?? '').trim()
    const body = { add_quantity: num(addQty.quantity), ...(cost ? { cost: num(cost) } : {}) }
    try {
      const res = await apiFetch(`/api/warehouse/${addQty.item.id}`, { method: 'PUT', body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFormError(data.error || 'No se pudo añadir.'); return }
      setNotice(`Se añadieron ${formatQty(num(addQty.quantity), addQty.item.unit)} a «${addQty.item.name}».`)
      setAddQty(null); await load()
    } catch (_) { setFormError('No se pudo añadir. Hace falta conexión.') }
    finally { setSaving(false) }
  }

  const doTransfer = async (e) => {
    e.preventDefault(); setSaving(true); setFormError('')
    const exists = !!inStore(transfer.item)
    try {
      const res = await apiFetch('/api/warehouse/transfer', {
        method: 'POST',
        body: JSON.stringify({
          warehouse_item_id: transfer.item.id, quantity: num(transfer.quantity),
          client_transfer_id: transfer.clientId,
          ...(!exists && { sale_price: num(transfer.sale_price) }),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFormError(data.error || 'No se pudo transferir.'); return }
      setNotice(`${formatQty(data.quantity, transfer.item.unit)} de «${transfer.item.name}» pasaron a la tienda.`)
      setTransfer(null); await load()
    } catch (_) { setFormError('No se pudo transferir. Hace falta conexión.') }
    finally { setSaving(false) }
  }

  const openHistory = async () => {
    setHistory([]); setHistoryError('')
    try {
      const [res, resC] = await Promise.all([apiFetch('/api/warehouse/transfers'), apiFetch('/api/warehouse/changes')])
      const data = await res.json().catch(() => null), dataC = await resC.json().catch(() => null)
      if (!res.ok || !Array.isArray(data)) { setHistoryError((data && data.error) || 'No se pudo cargar el historial. Hace falta conexión.'); return }
      setChanges(resC.ok && Array.isArray(dataC) ? dataC : [])
      setHistory(data)
    } catch (_) { setHistoryError('No se pudo cargar el historial. Hace falta conexión.') }
  }

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" /></div>

  const field = (key) => ({ value: form[key], onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })), className: inputCls })

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Almacén</h2>
          <p className="text-sm text-gray-500">Importe total al costo: <span className="font-semibold text-gray-800">{fmt(total)}</span></p>
        </div>
        <div className="flex gap-2">
            {isOwner && <button onClick={openHistory} className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50"><History size={16} />Historial</button>}
            <button onClick={() => { setFromStore({ product: null, quantity: '', clientId: crypto.randomUUID() }); setFormError(''); setStoreSearch('') }} className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50"><Store size={16} />Desde la tienda</button>
            <Link to="/almacen/importar" className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50"><Upload size={16} />Importar</Link>
            <button onClick={() => { setForm({ ...EMPTY }); setFormError('') }} className="flex items-center gap-2 bg-[#007AFF] text-white px-4 py-2.5 rounded-xl text-sm font-semibold"><Plus size={16} />Nuevo</button>
        </div>
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar en el almacén..." className={inputCls + ' mb-4'} />
      {notice && <div className="bg-blue-50 text-blue-700 rounded-xl px-4 py-3 text-sm font-medium mb-4">{notice}</div>}

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-gray-400"><Warehouse size={40} className="mx-auto mb-3 opacity-30" /><p className="text-sm">{items.length === 0 ? 'No hay artículos en el almacén' : 'Sin resultados'}</p></div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full">
            <thead><tr className="border-b border-gray-100">
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase">Artículo</th>
              <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase">Costo</th>
              <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase">Cantidad</th>
              <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase hidden sm:table-cell">Importe</th>
              <th className="px-5 py-3 w-32"></th>
            </tr></thead>
            <tbody>{filtered.map((i) => (
              <tr key={i.id} className="border-b border-gray-50 last:border-0">
                <td className="px-5 py-4 font-medium text-gray-900 text-sm">{i.name}</td>
                <td className="px-5 py-4 text-right text-sm text-gray-600">{fmt(i.cost)}{priceSuffix(i.unit)}</td>
                <td className="px-5 py-4 text-right text-sm font-semibold">{formatQty(i.quantity, i.unit)}</td>
                <td className="px-5 py-4 text-right text-sm text-gray-600 hidden sm:table-cell">{fmt(Number(i.quantity) * Number(i.cost))}</td>
                <td className="px-5 py-4"><div className="flex items-center justify-end gap-1">
                  <button disabled={Number(i.quantity) <= 0} title="Pasar a la tienda" aria-label="Pasar a la tienda"
                    onClick={() => { setTransfer({ item: i, quantity: '', sale_price: '', clientId: crypto.randomUUID() }); setFormError('') }}
                    className="p-2 hover:bg-blue-50 rounded-xl text-[#007AFF] disabled:opacity-30"><ArrowRightLeft size={16} /></button>
                  <button title="Añadir cantidad" aria-label="Añadir cantidad"
                    onClick={() => { setAddQty({ item: i, quantity: '', cost: i.cost }); setFormError('') }}
                    className="p-2 hover:bg-green-50 rounded-xl text-green-600"><PackagePlus size={16} /></button>
                  <>
                    <button title="Editar" aria-label="Editar" onClick={() => { setForm({ editing: i, name: i.name, cost: i.cost, unit: i.unit || '', add_quantity: '' }); setFormError('') }} className="p-2 hover:bg-gray-100 rounded-xl text-gray-400 hover:text-gray-700"><Pencil size={15} /></button>
                    <button title="Eliminar" aria-label="Eliminar" onClick={() => removeItem(i)} className="p-2 hover:bg-red-50 rounded-xl text-gray-300 hover:text-red-500"><Trash2 size={15} /></button>
                  </>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {form && (
        <Modal title={form.editing ? 'Editar artículo' : 'Nuevo artículo del almacén'} onClose={() => setForm(null)}>
          <form onSubmit={saveItem} className="px-6 py-5 space-y-4">
            <div><label className={labelCls}>Nombre</label><input required placeholder="Ej: Aceite 5L" {...field('name')} /></div>
            <div>
              <label className={labelCls}>Unidad</label>
              <select value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} className={inputCls}>
                <option value="">Por pieza</option>
                {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </div>
            <div><label className={labelCls}>Costo{form.unit ? ` por ${form.unit}` : ''}</label><input type="number" step="0.01" min="0" placeholder="0.00" {...field('cost')} /></div>
            {form.editing ? (
              <div>
                <label className={labelCls}>Añadir cantidad (hay {formatQty(form.editing.quantity, form.editing.unit)})</label>
                <input type="number" min="0" step={form.unit ? 'any' : '1'} placeholder="Cantidad que llegó" {...field('add_quantity')} />
              </div>
            ) : (
              <div><label className={labelCls}>Cantidad inicial</label><input type="number" min="0" step={form.unit ? 'any' : '1'} placeholder="0" {...field('quantity')} /></div>
            )}
            <ErrorBox message={formError} />
            <button type="submit" disabled={saving} className="w-full bg-[#007AFF] text-white py-3.5 rounded-xl font-semibold disabled:opacity-50">{saving ? 'Guardando...' : 'Guardar'}</button>
          </form>
        </Modal>
      )}

      {transfer && (() => {
        const existing = inStore(transfer.item), q = num(transfer.quantity) || 0
        return (
          <Modal title="Pasar a la tienda" onClose={() => setTransfer(null)}>
            <form onSubmit={doTransfer} className="px-6 py-5 space-y-4">
              <p className="text-sm text-gray-700"><span className="font-semibold">{transfer.item.name}</span> — en el almacén hay {formatQty(transfer.item.quantity, transfer.item.unit)}</p>
              <div><label className={labelCls}>Cantidad a pasar{transfer.item.unit ? ` (${transfer.item.unit})` : ''}</label>
                <input autoFocus required type="number" min="0" max={transfer.item.quantity} step={transfer.item.unit ? 'any' : '1'} className={inputCls} value={transfer.quantity} onChange={(e) => setTransfer((t) => ({ ...t, quantity: e.target.value }))} /></div>
              {existing ? (
                <p className="text-xs text-gray-500">Ya está en la tienda con {formatQty(existing.stock, existing.unit)}{q > 0 ? `; quedará en ${formatQty(Number(existing.stock) + q, existing.unit)}` : ''}.</p>
              ) : (
                <div><label className={labelCls}>Precio de venta{transfer.item.unit ? ` por ${transfer.item.unit}` : ''} *</label>
                  <input required type="number" min="0" step="0.01" placeholder="Este producto aún no está en la tienda" className={inputCls} value={transfer.sale_price} onChange={(e) => setTransfer((t) => ({ ...t, sale_price: e.target.value }))} />
                  <p className="text-xs text-gray-400 mt-1.5"><PackagePlus size={12} className="inline mr-1" />Se creará en la tienda con costo {fmt(transfer.item.cost)}.</p></div>
              )}
              <ErrorBox message={formError} />
              <button type="submit" disabled={saving} className="w-full bg-[#007AFF] text-white py-3.5 rounded-xl font-semibold disabled:opacity-50">{saving ? 'Transfiriendo...' : 'Transferir'}</button>
            </form>
          </Modal>
        )
      })()}

      {fromStore && (() => {
        const storeProducts = products.filter((p) => Number(p.stock) > 0 && !(p.unit && Number(p.track_stock) === 0)).sort((a, b) => a.name.localeCompare(b.name))
        const filtered = storeProducts.filter((p) => p.name.toLowerCase().includes(storeSearch.toLowerCase()))
        const selected = fromStore.product ? storeProducts.find((p) => p.id === fromStore.product.id) : null
        const existingWh = selected ? items.find((i) => norm(i.name) === norm(selected.name)) : null
        const q = num(fromStore.quantity) || 0
        return (
          <Modal title="Pasar de la tienda al almacén" onClose={() => setFromStore(null)}>
            <form onSubmit={doFromStore} className="px-6 py-5 space-y-4">
              <div>
                <label className={labelCls}>Buscar producto</label>
                <input autoFocus type="text" placeholder="Buscar en la tienda..." className={inputCls} value={storeSearch} onChange={(e) => setStoreSearch(e.target.value)} />
              </div>
              {!selected ? (
                <div>
                  <label className={labelCls}>Producto</label>
                  <select value={''} onChange={(e) => {
                    const p = storeProducts.find((p) => p.id === parseInt(e.target.value))
                    setFromStore((fs) => ({ ...fs, product: p, quantity: '' }))
                  }} className={inputCls}>
                    <option value="">Selecciona un producto</option>
                    {filtered.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} — hay {formatQty(p.stock, p.unit)}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <>
                  <div className="bg-blue-50 rounded-xl px-4 py-3 text-sm">
                    <p className="font-semibold text-blue-900">{selected.name}</p>
                    <p className="text-xs text-blue-700 mt-1">hay {formatQty(selected.stock, selected.unit)}</p>
                  </div>
                  <button type="button" onClick={() => { setFromStore((fs) => ({ ...fs, product: null })); setStoreSearch('') }} className="text-sm text-[#007AFF] font-semibold">Cambiar producto</button>
                  <div><label className={labelCls}>{selected.pack_size && Number(selected.pack_size) > 1 ? 'Cantidad a pasar (unidades sueltas)' : 'Cantidad a pasar'}</label>
                    <input required type="number" min="0" max={selected.stock} step={selected.unit ? 'any' : '1'} placeholder="0" className={inputCls} value={fromStore.quantity} onChange={(e) => setFromStore((fs) => ({ ...fs, quantity: e.target.value }))} /></div>
                  {existingWh ? (
                    <>
                      <p className="text-xs text-gray-500">Ya está en el almacén con {formatQty(existingWh.quantity, existingWh.unit)}{q > 0 ? `; quedará en ${formatQty(Number(existingWh.quantity) + q, existingWh.unit)}` : ''}.</p>
                      {existingWh.unit !== selected.unit && <p className="text-xs text-red-600 font-semibold">El artículo del almacén tiene otra unidad de medida</p>}
                    </>
                  ) : (
                    <p className="text-xs text-gray-500">Se creará en el almacén con costo {fmt(selected.purchase_price)}.</p>
                  )}
                  <ErrorBox message={formError} />
                  <button type="submit" disabled={saving || (existingWh && existingWh.unit !== selected.unit)} className="w-full bg-[#007AFF] text-white py-3.5 rounded-xl font-semibold disabled:opacity-50">{saving ? 'Pasando...' : 'Pasar'}</button>
                </>
              )}
            </form>
          </Modal>
        )
      })()}

      {addQty && (() => {
        return (
          <Modal title="Añadir al almacén" onClose={() => setAddQty(null)}>
            <form onSubmit={doAddQty} className="px-6 py-5 space-y-4">
              <p className="text-sm text-gray-700"><span className="font-semibold">{addQty.item.name}</span> — hay {formatQty(addQty.item.quantity, addQty.item.unit)}</p>
              <div><label className={labelCls}>Cantidad que llegó</label>
                <input autoFocus required type="number" min="0" step={addQty.item.unit ? 'any' : '1'} placeholder="0" className={inputCls} value={addQty.quantity} onChange={(e) => setAddQty((aq) => ({ ...aq, quantity: e.target.value }))} /></div>
              <div><label className={labelCls}>Costo{addQty.item.unit ? ` por ${addQty.item.unit}` : ''}</label>
                <input type="number" min="0" step="0.01" placeholder="0.00" className={inputCls} value={addQty.cost} onChange={(e) => setAddQty((aq) => ({ ...aq, cost: e.target.value }))} /></div>
              <ErrorBox message={formError} />
              <button type="submit" disabled={saving} className="w-full bg-[#007AFF] text-white py-3.5 rounded-xl font-semibold disabled:opacity-50">{saving ? 'Añadiendo...' : 'Añadir'}</button>
            </form>
          </Modal>
        )
      })()}

      {history && (
        <Modal title="Historial del almacén" onClose={() => setHistory(null)}>
          <div className="px-6 py-5 space-y-2">
            {!historyError && changes.length > 0 && <>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cambios en el almacén</p>
              {changes.map((c) => (
                <div key={'c' + c.id} className="border-b border-gray-100 pb-2 text-sm">
                  <p className="font-medium text-gray-900 capitalize">{c.action} · <span className="normal-case">{c.item_name}</span></p>
                  {c.detail && <p className="text-xs text-gray-500">{c.detail}</p>}
                  <p className="text-xs text-gray-400">{accountLabel(c.account_email)} · {c.created_at}</p>
                </div>
              ))}
            </>}
            {!historyError && <>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2">Pases entre tienda y almacén</p>
              {history.length === 0 ? (
                <p className="text-sm text-gray-400">Todavía no hay pases.</p>
              ) : history.map((h) => (
                <div key={h.id} className="border-b border-gray-100 pb-2 text-sm">
                  <p className="font-medium text-gray-900">{h.item_name} · {formatQty(h.quantity, null)}</p>
                  <p className="text-xs text-gray-500">
                    {h.direction === 'to_warehouse' ? 'Tienda → almacén' : 'Almacén → tienda'}
                    {h.direction === 'to_warehouse' && Number(h.created_product) ? ' · creó el artículo en el almacén' : h.direction !== 'to_warehouse' && Number(h.created_product) ? ' · creó el producto en la tienda' : ''}
                  </p>
                  <p className="text-xs text-gray-400">{accountLabel(h.account_email)} · {h.created_at}</p>
                </div>
              ))}
            </>}
            {historyError && <p className="text-sm text-red-600">{historyError}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}
