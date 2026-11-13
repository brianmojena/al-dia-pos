import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  AlertCircle, CheckCircle2, Minus, Phone, Plus, RefreshCw, Search,
  ShoppingBag, Store, Trash2, X,
} from 'lucide-react'
import { fmtMoney } from '../lib/fmt'
import { hasPack, roundQty } from '../lib/units'
import { newId } from '../lib/newId'
import {
  catalogCacheKey, itemLineTotal, LANDING_URL, MAX_ITEMS, mergeReservationItem,
  parseQuantityInput, POLL_MS, reservationTotal, updatedAgo, validateCustomer,
} from '../lib/catalogoPublico.js'

/**
 * Tienda pública de un negocio (/t/<slug>). Página standalone: no usa el
 * Layout del POS ni la sesión — el cliente entra desde un enlace de WhatsApp,
 * muchas veces con datos lentos, así que carga desde la caché de la sesión y
 * refresca por polling (el serverless no tiene WebSockets; la PWA ya hace lo
 * mismo cada 20 s). Fetch directo sin token: la ruta pública no está tras
 * requireAuth y network.js le metería un Bearer que no existe.
 */

function QtyInput({ value, unit, onCommit }) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setText(String(value)) }, [value, focused])

  const change = (t) => {
    setText(t)
    const n = parseQuantityInput(t, unit)
    if (n !== null) onCommit(n)
  }
  const blur = () => {
    setFocused(false)
    const n = parseQuantityInput(text, unit)
    onCommit(n ?? value)
    setText(String(n ?? value))
  }

  return (
    <input
      type="text"
      inputMode={unit ? 'decimal' : 'numeric'}
      value={text}
      onChange={(e) => change(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={blur}
      aria-label={`Cantidad de ${unit || 'unidades'}`}
      className="w-16 text-center bg-gray-50 border border-gray-200 rounded-xl py-1.5 text-base font-semibold focus:outline-none focus:border-[#007AFF]"
    />
  )
}

export function ReservationSheet({ cart, onClose, onChangeQty, onRemove, onSubmitted, slug }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    const errors = validateCustomer(name, phone, note)
    setFieldErrors(errors || {})
    if (errors) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const res = await fetch(`/api/public/catalog/${slug}/reservations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_reservation_id: newId(),
          customer_name: name.trim(),
          customer_phone: phone.trim(),
          customer_note: note.trim(),
          items: cart.map(({ product_id, quantity }) => ({ product_id, quantity })),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSubmitError(json.error || 'No se pudo enviar la reserva; prueba otra vez')
        return
      }
      setSuccess(json)
      onSubmitted?.()
    } catch {
      setSubmitError('Sin conexión; revisa tu internet y prueba otra vez')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Reserva de productos">
      <button type="button" aria-label="Cerrar" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl max-h-[92vh] overflow-y-auto safe-area-bottom">
        {success ? (
          <div className="p-6 text-center">
            <CheckCircle2 size={48} className="text-green-600 mx-auto mb-3" />
            <h2 className="text-xl font-bold text-gray-900">¡Reserva enviada!</h2>
            <p className="text-sm text-gray-500 mt-1">
              La tienda te va a confirmar por teléfono al {success.customer_phone}.
            </p>
            <ul className="mt-4 bg-gray-50 rounded-2xl p-4 text-left text-sm text-gray-700 space-y-1">
              {success.items.map((i) => (
                <li key={i.product_id} className="flex justify-between gap-2">
                  <span>{i.product_name} × {i.quantity}{i.unit ? ` ${i.unit}` : ''}</span>
                  <span className="font-semibold">{fmtMoney(i.quantity * i.sale_price)}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onClose}
              className="w-full mt-5 bg-[#007AFF] text-white py-3 rounded-2xl font-bold active:scale-95 transition-all"
            >
              Seguir mirando
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-gray-900">Tu reserva</h2>
              <button type="button" onClick={onClose} aria-label="Cerrar" className="p-2 -mr-2 text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>

            <ul className="space-y-2">
              {cart.map((item) => (
                <li key={item.product_id} className="flex items-center gap-2 bg-gray-50 rounded-2xl p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">{item.product_name}</p>
                    <p className="text-xs text-gray-500">
                      {fmtMoney(item.sale_price)}{item.unit ? ` / ${item.unit}` : ''} · subtotal {fmtMoney(itemLineTotal(item))}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label="Quitar cantidad"
                      onClick={() => onChangeQty(item, item.quantity - (item.unit ? 0.5 : 1))}
                      className="p-1.5 rounded-full bg-white border border-gray-200 text-gray-600 active:scale-90 transition-transform"
                    >
                      <Minus size={14} />
                    </button>
                    <QtyInput value={item.quantity} unit={item.unit} onCommit={(n) => onChangeQty(item, null, n)} />
                    <button
                      type="button"
                      aria-label="Añadir cantidad"
                      onClick={() => onChangeQty(item, item.quantity + (item.unit ? 0.5 : 1))}
                      className="p-1.5 rounded-full bg-white border border-gray-200 text-gray-600 active:scale-90 transition-transform"
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Quitar ${item.product_name} de la reserva`}
                      onClick={() => onRemove(item)}
                      className="p-1.5 text-gray-400 hover:text-red-500"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <p className="text-right text-sm text-gray-500 mt-2">
              Total aproximado: <span className="font-bold text-gray-900">{fmtMoney(reservationTotal(cart))}</span>
            </p>

            <div className="space-y-3 mt-4">
              <div>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Tu nombre"
                  maxLength={80}
                  className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF]"
                />
                {fieldErrors.name && <p className="text-xs text-red-600 mt-1">{fieldErrors.name}</p>}
              </div>
              <div>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Teléfono para confirmarte"
                  maxLength={30}
                  inputMode="tel"
                  className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF]"
                />
                {fieldErrors.phone && <p className="text-xs text-red-600 mt-1">{fieldErrors.phone}</p>}
              </div>
              <div>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Nota (opcional): para cuándo lo necesitas, etc."
                  rows={2}
                  maxLength={300}
                  className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] resize-none"
                />
                {fieldErrors.note && <p className="text-xs text-red-600 mt-1">{fieldErrors.note}</p>}
              </div>
            </div>

            {submitError && (
              <div className="flex items-start gap-2 bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl mt-3">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                {submitError}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full mt-4 bg-[#007AFF] text-white py-3.5 rounded-2xl font-bold text-base active:scale-95 transition-all disabled:opacity-50"
            >
              {submitting ? 'Enviando...' : 'Enviar reserva'}
            </button>
            <p className="text-xs text-gray-400 text-center mt-2">
              Reservar no cobra nada: la tienda confirma y tú pagas al recoger.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}

// Tarjeta de producto del catálogo público. Exportada para el render test:
// el badge Disponible/Agotado es la promesa visible de la tienda online.
export function ProductCard({ product, onReserve }) {
  return (
    <li className={`bg-white rounded-2xl p-4 flex items-center justify-between gap-3 ${product.available ? '' : 'opacity-60'}`}>
      <div className="min-w-0">
        <h2 className="font-semibold text-gray-900 leading-snug">{product.name}</h2>
        <p className="text-[15px] font-bold text-gray-900 mt-0.5">
          {fmtMoney(product.sale_price)}{product.unit ? <span className="text-xs font-medium text-gray-400"> / {product.unit}</span> : null}
        </p>
        {hasPack(product) && (
          <p className="text-xs text-gray-500 mt-0.5">Paquete de {product.pack_size}: {fmtMoney(product.pack_price)}</p>
        )}
        {product.available
          ? <span className="inline-block text-[11px] font-bold text-green-700 bg-green-50 rounded-full px-2 py-0.5 mt-1.5">Disponible</span>
          : <span className="inline-block text-[11px] font-bold text-gray-500 bg-gray-100 rounded-full px-2 py-0.5 mt-1.5">Agotado</span>}
      </div>
      {product.available && (
        <div className="flex flex-col items-stretch gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => onReserve?.(product, 1)}
            className="bg-[#007AFF] text-white text-sm font-bold px-4 py-2 rounded-xl active:scale-95 transition-transform"
          >
            Reservar
          </button>
          {hasPack(product) && (
            <button
              type="button"
              onClick={() => onReserve?.(product, product.pack_size)}
              className="text-[11px] font-semibold text-[#007AFF] bg-blue-50 px-3 py-1.5 rounded-xl active:scale-95 transition-transform"
            >
              +1 paquete
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export default function CatalogoPublico() {
  const { slug } = useParams()
  const [data, setData] = useState(null)
  const [phase, setPhase] = useState('loading') // loading | ready | notfound | error
  const [stale, setStale] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [cart, setCart] = useState([])
  const [sheetOpen, setSheetOpen] = useState(false)

  const dataRef = useRef(null)
  const setDataBoth = (value) => { dataRef.current = value; setData(value) }

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch(`/api/public/catalog/${encodeURIComponent(slug)}`)
      if (res.status === 404) { setPhase('notfound'); return }
      if (!res.ok) throw new Error(`status ${res.status}`)
      const json = await res.json()
      setDataBoth(json)
      setPhase('ready')
      setStale(false)
      setLastUpdated(Date.now())
      try { sessionStorage.setItem(catalogCacheKey(slug), JSON.stringify({ at: Date.now(), json })) } catch { /* lleno o bloqueado */ }
    } catch {
      if (!dataRef.current) setPhase('error')
      else setStale(true)
    } finally {
      setRefreshing(false)
    }
  }, [slug])

  // Carga inicial: pinta primero lo que haya en la caché de la sesión (el
  // cliente vuelve a abrir el enlace con datos lentos) y refresca detrás.
  useEffect(() => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(catalogCacheKey(slug)) || 'null')
      if (cached?.json) {
        setDataBoth(cached.json)
        setPhase('ready')
        setStale(true)
        setLastUpdated(cached.at)
      }
    } catch { /* caché corrupta: se ignora */ }
    load()
  }, [slug, load])

  // Polling: cada 30 s si la pestaña está a la vista, y al volver el foco.
  useEffect(() => {
    const interval = setInterval(() => { if (!document.hidden) load() }, POLL_MS)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    const tick = setInterval(() => setNow(Date.now()), 5000)
    return () => {
      clearInterval(interval)
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [load])

  const products = data?.products ?? []
  const filtered = query.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : products
  const disponibles = filtered.filter((p) => p.available)
  const agotados = filtered.filter((p) => !p.available)

  const addToCart = (product, quantity = 1) => {
    setCart((items) => mergeReservationItem(items, product, quantity))
    setSheetOpen(true)
  }
  const changeQty = (item, delta = null, absolute = null) => {
    const next = absolute !== null ? absolute : roundQty(item.quantity + delta)
    if (next <= 0) {
      setCart((items) => items.filter((i) => i.product_id !== item.product_id))
      return
    }
    setCart((items) => items.map((i) => (i.product_id === item.product_id ? { ...i, quantity: next } : i)))
  }
  const removeItem = (item) => setCart((items) => items.filter((i) => i.product_id !== item.product_id))

  if (phase === 'notfound') {
    return (
      <Shell>
        <EmptyState
          icon={<Store size={40} className="text-gray-300" />}
          title="Esta tienda no tiene catálogo disponible"
          text="Revisa el enlace o pregúntale a la tienda por su página actualizada."
        />
      </Shell>
    )
  }
  if (phase === 'error') {
    return (
      <Shell>
        <EmptyState
          icon={<AlertCircle size={40} className="text-gray-300" />}
          title="Sin conexión"
          text="No pudimos cargar el catálogo. Revisa tu internet y prueba otra vez."
          action={<button type="button" onClick={load} className="bg-[#007AFF] text-white px-6 py-3 rounded-2xl font-bold">Reintentar</button>}
        />
      </Shell>
    )
  }

  return (
    <Shell>
      <header className="bg-white border-b border-gray-100 px-5 pt-6 pb-4">
        <div className="max-w-md mx-auto sm:max-w-2xl">
          <h1 className="text-2xl font-bold text-gray-900 leading-tight">{data ? data.store.name : 'Cargando…'}</h1>
          {data?.store.note && <p className="text-sm text-gray-500 mt-1 whitespace-pre-line">{data.store.note}</p>}
          {data?.store.phone && (
            <a href={`tel:${data.store.phone}`} className="inline-flex items-center gap-1.5 text-sm text-[#007AFF] font-semibold mt-2">
              <Phone size={14} /> {data.store.phone}
            </a>
          )}
          <div className="flex items-center justify-between mt-3">
            <span className={`text-xs ${stale ? 'text-amber-600' : 'text-gray-400'}`}>
              {data
                ? `${stale ? 'Puede estar desactualizado' : `Actualizado ${updatedAgo(lastUpdated, now)}`}${refreshing ? ' · actualizando…' : ''}`
                : 'Cargando catálogo…'}
            </span>
            <button
              type="button"
              onClick={load}
              disabled={refreshing}
              aria-label="Actualizar catálogo"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#007AFF] disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Actualizar
            </button>
          </div>
          <div className="relative mt-3">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar producto…"
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl pl-10 pr-4 py-2.5 text-base focus:outline-none focus:border-[#007AFF]"
            />
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto sm:max-w-2xl px-5 py-4 pb-28">
        {phase === 'loading' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" aria-hidden="true">
            {[...Array(4)].map((_, i) => <div key={i} className="bg-white rounded-2xl p-4 animate-pulse h-20" />)}
          </div>
        )}

        {phase === 'ready' && (
          <>
            {disponibles.length === 0 && agotados.length === 0 && (
              <EmptyState
                icon={<Search size={40} className="text-gray-300" />}
                title={query ? 'Sin resultados' : 'Catálogo vacío por ahora'}
                text={query ? `Nada coincide con “${query}”.` : 'La tienda todavía no publicó productos.'}
              />
            )}
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {[...disponibles, ...agotados].map((p) => (
                <ProductCard key={p.id} product={p} onReserve={addToCart} />
              ))}
            </ul>
          </>
        )}
      </main>

      {cart.length > 0 && !sheetOpen && phase === 'ready' && (
        <div className="fixed bottom-0 inset-x-0 z-40 px-4 pb-4 safe-area-bottom pointer-events-none">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="pointer-events-auto w-full max-w-md sm:max-w-sm mx-auto flex items-center justify-center gap-2 bg-[#007AFF] text-white py-3.5 rounded-2xl font-bold shadow-lg shadow-blue-200 active:scale-95 transition-all"
          >
            <ShoppingBag size={18} />
            Reservar {cart.length} producto{cart.length > 1 ? 's' : ''} · {fmtMoney(reservationTotal(cart))}
          </button>
        </div>
      )}

      {sheetOpen && (
        <ReservationSheet
          slug={slug}
          cart={cart}
          onClose={() => setSheetOpen(false)}
          onChangeQty={changeQty}
          onRemove={removeItem}
          onSubmitted={() => setCart([])}
        />
      )}
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-[#F5F5F7] flex flex-col">
      <div className="flex-1">{children}</div>
      <footer className="text-center text-xs text-gray-400 pb-6 pt-2">
        Hecho con{' '}
        <a href={LANDING_URL} target="_blank" rel="noreferrer" className="font-bold text-gray-500 hover:text-[#007AFF]">
          Al Día
        </a>
        {' '}— la app que lleva tu tienda al día
      </footer>
    </div>
  )
}

function EmptyState({ icon, title, text, action = null }) {
  return (
    <div className="max-w-md mx-auto px-5 py-16 text-center">
      <div className="flex justify-center mb-3">{icon}</div>
      <h2 className="text-lg font-bold text-gray-900">{title}</h2>
      {text && <p className="text-sm text-gray-500 mt-1">{text}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}
