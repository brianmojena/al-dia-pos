import { useState, useEffect, useRef } from 'react'
import { Search, Plus, Minus, Trash2, ShoppingCart, CheckCircle, X, Banknote, Smartphone, AlertCircle, CloudOff } from 'lucide-react'
import { apiFetch, isElectron } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { cacheProducts, getCachedProducts } from '../lib/offlineCache'
import { enqueueSale } from '../lib/salesQueue'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

// crypto.randomUUID solo existe en contextos seguros (HTTPS o localhost); el fallback
// cubre el caso de abrir el dev server por IP en la red local.
const newSaleId = () =>
  globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`

export default function POS() {
  const { user } = useAuth()
  const [products,          setProducts]          = useState([])
  const [search,            setSearch]            = useState('')
  const [cart,              setCart]              = useState([])
  const [loading,           setLoading]           = useState(true)
  const [completing,        setCompleting]        = useState(false)
  const [success,           setSuccess]           = useState(false)
  const [showCart,          setShowCart]          = useState(false)
  const [showPaymentModal,  setShowPaymentModal]  = useState(false)
  const [lastPaymentMethod, setLastPaymentMethod] = useState('efectivo')
  const [error,             setError]             = useState('')
  const [queuedOffline,     setQueuedOffline]     = useState(false)
  const searchRef = useRef(null)
  // Identificador de la venta en curso. Se mantiene entre reintentos para que el
  // servidor reconozca el reintento y no registre la venta dos veces; solo se
  // descarta cuando la venta se cierra con éxito.
  const saleIdRef = useRef(null)

  const loadProducts = () =>
    apiFetch('/api/products')
      .then(r => r.json())
      .then(d => {
        setProducts(d)
        setLoading(false)
        if (!isElectron()) cacheProducts(d) // última foto conocida por si la próxima carga es offline
      })
      .catch(() => {
        // Sin red al abrir la PWA: mejor vender con el catálogo de la última
        // vez que con una pantalla en blanco. El stock puede estar desfasado
        // — se corrige solo al sincronizar y volver a pedir /api/products.
        const cached = !isElectron() && getCachedProducts()
        if (cached) setProducts(cached)
        setLoading(false)
      })

  useEffect(() => { loadProducts() }, [])

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) && p.stock > 0
  )

  const addToCart = (product) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id)
      if (existing) {
        if (existing.quantity >= product.stock) return prev
        return prev.map(i => i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i)
      }
      return [...prev, { ...product, quantity: 1 }]
    })
  }

  const updateQty = (id, delta) =>
    setCart(prev => prev.map(i => i.id === id ? { ...i, quantity: i.quantity + delta } : i).filter(i => i.quantity > 0))

  const removeFromCart = (id) => setCart(prev => prev.filter(i => i.id !== id))

  const total     = cart.reduce((s, i) => s + i.sale_price * i.quantity, 0)
  const itemCount = cart.reduce((s, i) => s + i.quantity, 0)

  // El límite lo configura el dueño desde la app móvil (PUT /api/auth/settings).
  // Es una política del negocio, no un control de seguridad — alcanza con
  // bloquearlo en la UI, no hace falta que el servidor lo valide también.
  const transferOverLimit = user?.transfer_limit != null && total > user.transfer_limit

  const handleCheckout = async (paymentMethod) => {
    if (cart.length === 0 || completing) return
    setCompleting(true)
    setShowPaymentModal(false)
    setError('')

    if (!saleIdRef.current) saleIdRef.current = newSaleId()

    try {
      const res = await apiFetch('/api/sales', {
        method: 'POST',
        body: JSON.stringify({
          items: cart.map(i => ({ product_id: i.id, quantity: i.quantity, unit_price: i.sale_price })),
          payment_method: paymentMethod,
          client_sale_id: saleIdRef.current,
        }),
      })

      if (res.ok) {
        saleIdRef.current = null   // venta cerrada: la siguiente empieza con id nuevo
        setCart([])
        setShowCart(false)
        setLastPaymentMethod(paymentMethod)
        setQueuedOffline(false)
        setSuccess(true)
        await loadProducts()
        setTimeout(() => setSuccess(false), 2500)
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'No se pudo registrar la venta. Intenta de nuevo.')
        // El stock pudo cambiar por otra venta; refrescamos para mostrar el real.
        await loadProducts().catch(() => {})
      }
    } catch (_) {
      // Sin red (típico en Cuba, no un caso raro): en Electron esto no debería
      // pasar nunca (apiFetch va por IPC local), así que si llegamos aquí es
      // porque estamos en la PWA web sin conexión. La venta ya se cobró en
      // caja — no tiene sentido bloquear al cajero, la encolamos y seguimos.
      if (!isElectron()) {
        const soldItems = cart.map(i => ({ product_id: i.id, quantity: i.quantity, unit_price: i.sale_price }))
        await enqueueSale({
          items: soldItems,
          payment_method: paymentMethod,
          client_sale_id: saleIdRef.current,
        })
        // Descuento optimista del stock local para que el siguiente cliente
        // no compre algo que ya no queda — se corrige solo al re-sincronizar.
        setProducts(prev => prev.map(p => {
          const sold = soldItems.find(i => i.product_id === p.id)
          return sold ? { ...p, stock: Math.max(0, p.stock - sold.quantity) } : p
        }))
        saleIdRef.current = null
        setCart([])
        setShowCart(false)
        setLastPaymentMethod(paymentMethod)
        setQueuedOffline(true)
        setSuccess(true)
        setTimeout(() => setSuccess(false), 3500)
      } else {
        setError('Sin conexión. Revisa tu Internet y vuelve a intentar — no se cobrará dos veces.')
      }
    } finally {
      setCompleting(false)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  const CartItem = ({ item }) => (
    <div className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
        <p className="text-xs text-gray-400">{fmt(item.sale_price)} c/u</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => updateQty(item.id, -1)}
          className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center hover:bg-gray-200 active:scale-90 transition-all"
        >
          <Minus size={13} />
        </button>
        <span className="w-5 text-center text-sm font-bold text-gray-900">{item.quantity}</span>
        <button
          onClick={() => updateQty(item.id, 1)}
          disabled={item.quantity >= item.stock}
          className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center hover:bg-gray-200 active:scale-90 transition-all disabled:opacity-30"
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="text-right min-w-[56px]">
        <p className="text-sm font-semibold text-gray-900">{fmt(item.sale_price * item.quantity)}</p>
        <button onClick={() => removeFromCart(item.id)} className="text-gray-300 hover:text-red-400 transition-colors">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex h-full overflow-hidden">
      {/* Success toast */}
      {success && (
        <div className={`fixed top-20 left-1/2 -translate-x-1/2 z-50 text-white px-6 py-3 rounded-full shadow-xl flex items-center gap-2 font-semibold text-sm animate-bounce ${
          queuedOffline ? 'bg-gray-700' : 'bg-green-500'
        }`}>
          {queuedOffline ? <CloudOff size={18} /> : <CheckCircle size={18} />}
          {queuedOffline ? 'Venta guardada, sincroniza al volver la red · ' : '¡Venta registrada! · '}
          {lastPaymentMethod === 'efectivo' ? 'Efectivo' : 'Transferencia'}
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] bg-red-500 text-white px-5 py-3 rounded-2xl shadow-xl flex items-start gap-2.5 font-medium text-sm">
          <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="flex-shrink-0 opacity-70 hover:opacity-100">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Payment method modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowPaymentModal(false)}
          />
          <div className="relative bg-white rounded-3xl p-6 shadow-2xl w-80 mx-4">
            <h3 className="text-lg font-bold text-gray-900 text-center mb-1">Forma de pago</h3>
            <p className="text-3xl font-bold text-center text-[#007AFF]">{fmt(total)}</p>
            {user?.usd_rate != null && (
              <p className="text-xs text-gray-400 text-center mt-1 mb-4">
                1 USD ≈ {fmt(user.usd_rate)}
              </p>
            )}
            {user?.usd_rate == null && <div className="mb-6" />}
            <div className="space-y-3">
              <button
                onClick={() => handleCheckout('efectivo')}
                disabled={completing}
                className="w-full bg-green-500 text-white py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 active:scale-95 transition-all shadow-md shadow-green-200 disabled:opacity-50"
              >
                <Banknote size={22} />
                Efectivo
              </button>
              <div>
                <button
                  onClick={() => handleCheckout('transferencia')}
                  disabled={completing || transferOverLimit}
                  className="w-full bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 active:scale-95 transition-all shadow-md shadow-blue-200 disabled:opacity-50 disabled:shadow-none"
                >
                  <Smartphone size={22} />
                  Transferencia
                </button>
                {transferOverLimit && (
                  <p className="text-xs text-red-500 text-center mt-2">
                    Supera el límite de transferencia ({fmt(user.transfer_limit)}). Cobra en efectivo o reduce el monto.
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={() => setShowPaymentModal(false)}
              className="w-full text-gray-400 py-3 text-sm hover:text-gray-600 transition-colors mt-2"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Products panel */}
      <div className="flex-1 flex flex-col p-4 md:p-6 min-w-0">
        {/* Barra de referencia: límite de transferencia y tasa del dólar,
            configurados por el dueño desde la app móvil. Siempre visible para
            el cajero, no solo dentro del modal de cobro. */}
        {(user?.transfer_limit != null || user?.usd_rate != null) && (
          <div className="flex flex-wrap gap-2 mb-4">
            {user?.transfer_limit != null && (
              <div className="flex items-center gap-1.5 bg-blue-50 text-[#007AFF] text-xs font-semibold px-3 py-1.5 rounded-full">
                <Smartphone size={13} />
                Transferencia hasta {fmt(user.transfer_limit)}
              </div>
            )}
            {user?.usd_rate != null && (
              <div className="flex items-center gap-1.5 bg-green-50 text-green-700 text-xs font-semibold px-3 py-1.5 rounded-full">
                <Banknote size={13} />
                1 USD ≈ {fmt(user.usd_rate)}
              </div>
            )}
          </div>
        )}

        {/* Search */}
        <div className="relative mb-4">
          <Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar producto..."
            className="w-full bg-white border border-gray-200 rounded-2xl pl-11 pr-4 py-3.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors shadow-sm"
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

        {/* Product grid */}
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 pb-24 md:pb-4">
            {filtered.map(p => {
              const inCart = cart.find(i => i.id === p.id)
              return (
                <button
                  key={p.id}
                  onClick={() => addToCart(p)}
                  className={`bg-white rounded-2xl p-4 text-left shadow-sm hover:shadow-md active:scale-95 transition-all border-2 ${
                    inCart ? 'border-[#007AFF] bg-blue-50/30' : 'border-transparent'
                  }`}
                >
                  <p className="text-sm font-semibold text-gray-900 mb-1.5 line-clamp-2 leading-tight min-h-[2.5rem]">
                    {p.name}
                  </p>
                  <p className="text-[#007AFF] font-bold text-base">{fmt(p.sale_price)}</p>
                  <p className="text-xs text-gray-400 mt-1">Stock: {p.stock}</p>
                  {inCart && (
                    <div className="mt-2">
                      <span className="bg-[#007AFF] text-white text-xs font-semibold px-2.5 py-0.5 rounded-full">
                        {inCart.quantity} en carrito
                      </span>
                    </div>
                  )}
                </button>
              )
            })}
            {filtered.length === 0 && (
              <div className="col-span-full py-16 text-center text-gray-400">
                <Search size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">No se encontraron productos disponibles</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Cart sidebar — desktop */}
      <div className="hidden md:flex flex-col w-80 bg-white border-l border-gray-200 flex-shrink-0">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Venta actual</h3>
          {cart.length > 0 && (
            <span className="text-xs bg-[#007AFF] text-white px-2 py-0.5 rounded-full font-medium">
              {itemCount}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-auto px-4 py-2">
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 py-12">
              <ShoppingCart size={36} className="mb-3 opacity-30" />
              <p className="text-sm">Toca un producto para agregarlo</p>
            </div>
          ) : (
            cart.map(item => <CartItem key={item.id} item={item} />)
          )}
        </div>

        <div className="px-5 py-5 border-t border-gray-100">
          <div className="flex justify-between items-center mb-4">
            <span className="text-gray-500 font-medium">Total</span>
            <span className="text-3xl font-bold text-gray-900">{fmt(total)}</span>
          </div>
          <button
            onClick={() => setShowPaymentModal(true)}
            disabled={cart.length === 0 || completing}
            className="w-full bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-lg hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200"
          >
            {completing ? 'Procesando...' : 'Cobrar'}
          </button>
          {cart.length > 0 && (
            <button
              onClick={() => setCart([])}
              className="w-full text-gray-400 py-2 text-sm hover:text-gray-600 transition-colors mt-2"
            >
              Cancelar venta
            </button>
          )}
        </div>
      </div>

      {/* Mobile: floating cart button */}
      {cart.length > 0 && !showCart && (
        <button
          onClick={() => setShowCart(true)}
          className="md:hidden fixed bottom-20 right-4 bg-[#007AFF] text-white px-5 py-3.5 rounded-full shadow-xl flex items-center gap-2.5 font-semibold z-20"
        >
          <ShoppingCart size={20} />
          <span>{itemCount} —</span>
          <span>{fmt(total)}</span>
        </button>
      )}

      {/* Mobile: cart drawer */}
      {showCart && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowCart(false)} />
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-3xl max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900 text-lg">Carrito ({itemCount})</h3>
              <button onClick={() => setShowCart(false)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X size={20} className="text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-5 py-2">
              {cart.map(item => <CartItem key={item.id} item={item} />)}
            </div>
            <div className="px-5 py-5 border-t border-gray-100">
              <div className="flex justify-between items-center mb-4">
                <span className="text-gray-500 font-medium text-lg">Total</span>
                <span className="text-3xl font-bold text-gray-900">{fmt(total)}</span>
              </div>
              <button
                onClick={() => setShowPaymentModal(true)}
                disabled={completing}
                className="w-full bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-xl active:scale-95 transition-all shadow-lg shadow-blue-200"
              >
                {completing ? 'Procesando...' : `Cobrar ${fmt(total)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
