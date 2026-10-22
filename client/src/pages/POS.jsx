import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { useState, useEffect, useRef } from 'react'
import { Search, Plus, Minus, Trash2, ShoppingCart, CheckCircle, X, Banknote, Smartphone, AlertCircle, CloudOff, DollarSign, Pencil } from 'lucide-react'
import { apiFetch, getToken, isElectron } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { subscribe as subscribeQueue, acknowledgeRejected } from '../lib/salesQueue'
import { isTransferBlocked } from '../lib/transferGuard'
import { maxTransfer, paymentLabel } from '../lib/payment'
import MixedPayment from '../components/MixedPayment'
import ForeignPayment from '../components/ForeignPayment'
import CashPayment from '../components/CashPayment'
import DeviceRatesEditor from '../components/DeviceRatesEditor'
import { useExchangeRates } from '../lib/exchangeRates'
import RejectedSalesBanner from '../components/RejectedSalesBanner'
import { newId as newSaleId } from '../lib/newId'
import { formatQty, lineTotal, priceSuffix, roundQty, hasPack, lineUnits, formatPackStock } from '../lib/units'
import { cashPaymentBreakdown, isMontevaldesCashEnabled } from '../lib/cashPayment.js'
import { getSharedContext } from '../lib/sharedDevice.js'

const readSharedDraft = (key) => {
  try { const draft = key && JSON.parse(sessionStorage.getItem(key) || 'null'); return Array.isArray(draft?.cart) ? draft : { cart: [] } }
  catch { return { cart: [] } }
}

// Hasta 2 decimales: 1,3 lb a $55 son $71,50 y el cliente tiene que ver ese importe.
const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(Math.round((n || 0) * 100) / 100)

// Atajos de peso para el modal: lo más común en cada unidad.
const QUICK = { lb: [0.5, 1, 2, 5], kg: [0.5, 1, 2, 5], g: [100, 250, 500, 1000] }

// Clave única para una línea del carrito.
const lineKey = (i) => i.pack ? `${i.id}:paq` : i.id

// Cantidad de sueltos en carrito para un producto (incluye paquetes expandidos).
const unitsInCart = (cart, productId) =>
  cart
    .filter(i => i.id === productId)
    .reduce((s, i) => s + lineUnits(i), 0)

export default function POS() {
  const { user, setSharedGuard } = useAuth()
  const shared = getSharedContext()
  const draftKey = shared ? `mypimes_shared_cart:${shared.id}:${user.id}` : null
  const restored = useRef(readSharedDraft(draftKey))
  const rates = useExchangeRates(user)
  const [products,          setProducts]          = useState([])
  const [search,            setSearch]            = useState('')
  const [cart,              setCart]              = useState(restored.current.cart)
  const [loading,           setLoading]           = useState(true)
  const [completing,        setCompleting]        = useState(false)
  const [success,           setSuccess]           = useState(false)
  const [showCart,          setShowCart]          = useState(false)
  const [showPaymentModal,  setShowPaymentModal]  = useState(false)
  // Qué pantalla del modal de cobro está abierta: la lista, el mixto o la divisa.
  const [paymentView,       setPaymentView]       = useState('list')
  const [ratesOpen,         setRatesOpen]         = useState(false)
  const [lastPayment,       setLastPayment]       = useState({ payment_method: 'efectivo' })
  const [error,             setError]             = useState('')
  // Producto por peso que se está pesando (modal "¿cuántas lb?") y lo que se teclea.
  const [weighing,          setWeighing]          = useState(null)
  const [weighInput,        setWeighInput]        = useState('')
  const [queuedOffline,     setQueuedOffline]     = useState(false)
  const [rejected,          setRejected]          = useState([])
  const pendingCountRef = useRef(0)
  const searchRef = useRef(null)
  // Identificador de la venta en curso. Se mantiene entre reintentos para que el
  // servidor reconozca el reintento y no registre la venta dos veces; solo se
  // descarta cuando la venta se cierra con éxito.
  const saleIdRef = useRef(restored.current.saleId || null)
  useEffect(() => {
    setSharedGuard?.({ hasCart: cart.length > 0, busy: completing })
    if (draftKey) {
      try { sessionStorage.setItem(draftKey, JSON.stringify({ cart, saleId: saleIdRef.current })) } catch { /* El recibo se guarda en IndexedDB al cobrar. */ }
    }
  }, [cart, completing, draftKey, setSharedGuard])
  useEffect(() => () => setSharedGuard?.({ hasCart: false, busy: false }), [setSharedGuard])

  const loadProducts = async () => {
    try {
      const res = await apiFetch('/api/products')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar el catálogo')
      setProducts(Array.isArray(data) ? data : [])
    } catch (error) { setError(error.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProducts() }, [])
  useLocalRefresh(loadProducts)

  // En la caja de escritorio el catálogo puede cambiar desde la web mientras
  // se vende (un producto nuevo, un precio): el sync worker avisa y la
  // cuadrícula se recarga sin salir de la pantalla. El carrito no se toca —
  // cada línea conserva el precio con el que se agregó.
  useEffect(() => {
    if (!isElectron()) return
    return window.electronAPI.onSyncStatus((status) => {
      if (status.catalogChanged) loadProducts()
    })
  }, [])

  // Web: estado de la cola. Si bajan las pendientes es que acaban de subir
  // ventas y el servidor ya las descontó: se vuelve a pedir el catálogo, porque
  // si no ese stock "reaparecería" en pantalla hasta recargar.
  useEffect(() => {
    if (isElectron()) return
    return subscribeQueue(({ pending, rejected: rechazadas }) => {
      if (pending < pendingCountRef.current) loadProducts()
      pendingCountRef.current = pending
      setRejected(rechazadas)
    })
  }, [])

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) && (p.unit || p.stock > 0)
  )

  const addToCart = (product, isPack = false) => {
    // Un producto por peso no se suma de uno en uno: se pregunta cuánto pesa.
    if (product.unit) {
      const inCart = cart.find(i => i.id === product.id)
      setWeighInput(inCart ? String(inCart.quantity) : '')
      setWeighing(product)
      return
    }

    setCart(prev => {
      // Contar sueltos en carrito para verificar límite de stock
      const unitsUsed = unitsInCart(prev, product.id)
      const existing = prev.find(i => i.id === product.id && !!(i.pack || false) === isPack)

      if (isPack) {
        // Agregar un paquete
        if (unitsUsed + product.pack_size > product.stock) return prev
        if (existing) {
          return prev.map(i =>
            i.id === product.id && (i.pack || false)
              ? { ...i, quantity: i.quantity + 1 }
              : i
          )
        }
        return [...prev, { ...product, quantity: 1, pack: true, price: product.pack_price }]
      } else {
        // Agregar un suelto
        if (unitsUsed + 1 > product.stock) return prev
        if (existing) {
          return prev.map(i =>
            i.id === product.id && !(i.pack || false)
              ? { ...i, quantity: i.quantity + 1 }
              : i
          )
        }
        return [...prev, { ...product, quantity: 1, price: product.sale_price }]
      }
    })
  }

  // Confirma el peso: fija la cantidad del producto en el carrito (no la suma —
  // volver a tocar el producto sirve para corregir el peso).
  const weighQty = parseFloat(String(weighInput).replace(',', '.'))
  const weighValid = weighing && Number.isFinite(weighQty) && weighQty >= 0.001
    && Math.abs(roundQty(weighQty) - weighQty) < 1e-9
  const confirmWeight = () => {
    if (!weighValid) return
    const product = weighing
    setCart(prev => prev.some(i => i.id === product.id)
      ? prev.map(i => i.id === product.id ? { ...i, quantity: weighQty } : i)
      : [...prev, { ...product, quantity: weighQty }])
    setWeighing(null)
  }

  const updateQty = (cartKey, delta) => {
    setCart(prev => {
      const line = prev.find(i => lineKey(i) === cartKey)
      if (!line) return prev

      const product = products.find(p => p.id === line.id)
      if (!product) return prev

      const newQty = line.quantity + delta
      if (newQty <= 0) return prev.filter(i => lineKey(i) !== cartKey)

      // Verificar límite de stock: sumar todas las líneas del producto
      const otherUnits = unitsInCart(prev.filter(i => lineKey(i) !== cartKey), product.id)
      const newLineUnits = lineUnits({ ...line, quantity: newQty })

      if (otherUnits + newLineUnits > product.stock) return prev

      return prev.map(i => lineKey(i) === cartKey ? { ...i, quantity: newQty } : i)
    })
  }

  const removeFromCart = (cartKey) => setCart(prev => prev.filter(i => lineKey(i) !== cartKey))

  const total     = cart.reduce((s, i) => s + lineTotal(i.quantity, i.price ?? i.sale_price), 0)
  // Un producto por peso cuenta como una línea. Un paquete = 1 item, como hoy los sueltos.
  const itemCount = cart.reduce((s, i) => s + (i.unit ? 1 : i.quantity), 0)

  // El límite lo configura el dueño desde la app móvil (PUT /api/auth/settings).
  // La UI lo bloquea por adelantado, pero la validación definitiva está en el
  // servidor (POST /api/sales responde 403): la cola offline también cobra.
  const transferOverLimit = isTransferBlocked(total, user?.transfer_limit)
  // El cobro mixto necesita poder transferir al menos un peso y dejar al menos
  // uno en efectivo; con un techo en 0 no hay nada que repartir.
  const canSplit = total >= 2 && maxTransfer(total, user?.transfer_limit) >= 1
  const guidedCashPayment = isMontevaldesCashEnabled(getToken())

  // El modal siempre abre en la lista de formas de pago, y el cobro mixto
  // siempre arranca en 50/50 (MixedPayment se monta de nuevo cada vez).
  const openPayment = () => { setPaymentView('list'); setShowPaymentModal(true) }
  const closePayment = () => { setShowPaymentModal(false); setPaymentView('list') }

  // payment es la forma de cobro tal como viaja al servidor: en un mixto
  // lleva la parte transferida; en divisa, los billetes, la moneda y la tasa.
  const handleCheckout = async (payment) => {
    if (cart.length === 0 || completing) return
    setCompleting(true)
    closePayment()
    setError('')

    if (!saleIdRef.current) saleIdRef.current = newSaleId()

    try {
      const res = await apiFetch('/api/sales', {
        method: 'POST',
        body: JSON.stringify({
          items: cart.map(i =>
            i.pack
              ? { product_id: i.id, quantity: i.quantity, unit_price: i.pack_price, pack_size: i.pack_size }
              : { product_id: i.id, quantity: i.quantity, unit_price: i.sale_price }
          ),
          ...payment,
          client_sale_id: saleIdRef.current,
          register_id: 'web',
        }),
      })

      if (res.ok) {
        saleIdRef.current = null   // venta cerrada: la siguiente empieza con id nuevo
        setCart([])
        setShowCart(false)
        setLastPayment(payment)
        const saved = await res.json()
        setQueuedOffline(!!saved.pending)
        setSuccess(true)
        await loadProducts()
        setTimeout(() => setSuccess(false), 2500)
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'No se pudo registrar la venta. Intenta de nuevo.')
        // El stock pudo cambiar por otra venta; refrescamos para mostrar el real.
        await loadProducts().catch(() => {})
      }
    } catch (error) {
      setError(error.message || 'No se pudo guardar la venta. Vuelve a intentar.')
    } finally {
      setCompleting(false)
    }
  }

  // La pantalla guiada valida de nuevo al confirmar; el servidor recibe
  // el efectivo recibido (cash_received) para guardar cuánto entregó el cliente.
  const handleCashCheckout = (amountReceived) => {
    if (!isMontevaldesCashEnabled(getToken()) || cart.length === 0 || completing) return
    const breakdown = cashPaymentBreakdown(total, amountReceived)
    if (!breakdown.canConfirm) return
    const cashReceivedCups = breakdown.receivedCents / 100
    return handleCheckout({ payment_method: 'efectivo', cash_received: cashReceivedCups })
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  const CartItem = ({ item }) => {
    const cartKey = lineKey(item)
    const price = item.price ?? item.sale_price
    const currentProduct = products.find(p => p.id === item.id) || item

    return (
      <div className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
          <p className="text-xs text-gray-400">
            {item.unit
              ? `${fmt(item.sale_price)} por ${item.unit}`
              : item.pack
              ? `Paquete de ${item.pack_size} · ${fmt(price)} c/u`
              : `${fmt(price)} c/u`
            }
          </p>
        </div>
        {item.unit ? (
          <button
            onClick={() => addToCart(item)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-blue-50 text-[#007AFF] text-sm font-bold active:scale-95 transition-all"
            title="Cambiar el peso"
          >
            {formatQty(item.quantity, item.unit)}
            <Pencil size={12} />
          </button>
        ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={() => updateQty(cartKey, -1)}
            className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center hover:bg-gray-200 active:scale-90 transition-all"
          >
            <Minus size={13} />
          </button>
          <span className="w-5 text-center text-sm font-bold text-gray-900">{item.quantity}</span>
          <button
            onClick={() => updateQty(cartKey, 1)}
            disabled={unitsInCart(cart, item.id) + (item.pack ? Number(item.pack_size) : 1) > currentProduct.stock}
            className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center hover:bg-gray-200 active:scale-90 transition-all disabled:opacity-30"
          >
            <Plus size={13} />
          </button>
        </div>
        )}
        <div className="text-right min-w-[56px]">
          <p className="text-sm font-semibold text-gray-900">{fmt(lineTotal(item.quantity, price))}</p>
          <button onClick={() => removeFromCart(cartKey)} className="text-gray-300 hover:text-red-400 transition-colors">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Success toast */}
      {success && (
        <div className={`fixed top-20 left-1/2 -translate-x-1/2 z-50 text-white px-6 py-3 rounded-full shadow-xl flex items-center gap-2 font-semibold text-sm animate-bounce ${
          queuedOffline ? 'bg-gray-700' : 'bg-green-500'
        }`}>
          {queuedOffline ? <CloudOff size={18} /> : <CheckCircle size={18} />}
          {queuedOffline ? 'Venta guardada en este dispositivo · ' : '¡Venta registrada! · '}
          {lastPayment.payment_method === 'divisa'
            ? `${lastPayment.foreign_amount} ${lastPayment.foreign_currency}`
            : paymentLabel(lastPayment)}
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

      {/* Producto por peso: cuántas lb/kg/g se lleva el cliente */}
      {weighing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setWeighing(null)} />
          <form
            onSubmit={(e) => { e.preventDefault(); confirmWeight() }}
            className="relative bg-white rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl w-full sm:w-96 sm:mx-4"
          >
            <div className="flex items-start justify-between mb-1">
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-gray-900 truncate">{weighing.name}</h3>
                <p className="text-sm text-gray-400">{fmt(weighing.sale_price)} por {weighing.unit}{Number(weighing.track_stock) === 1 ? ` · quedan ${formatQty(weighing.stock, weighing.unit)}` : ''}</p>
              </div>
              <button type="button" onClick={() => setWeighing(null)} className="p-2 -mr-2 hover:bg-gray-100 rounded-xl">
                <X size={20} className="text-gray-500" />
              </button>
            </div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1.5">
              ¿Cuántas {weighing.unit}?
            </label>
            <input
              autoFocus
              type="number" step="any" min="0" inputMode="decimal"
              value={weighInput}
              onChange={e => setWeighInput(e.target.value)}
              placeholder="0"
              className="w-full text-center text-4xl font-bold border-2 border-gray-200 rounded-2xl py-4 focus:outline-none focus:border-[#007AFF] transition-colors"
            />
            <div className="grid grid-cols-4 gap-2 mt-3">
              {(QUICK[weighing.unit] || []).map(q => (
                <button
                  type="button" key={q}
                  onClick={() => setWeighInput(String(q))}
                  className="py-2.5 rounded-xl bg-gray-100 text-sm font-bold text-gray-700 hover:bg-gray-200 active:scale-95 transition-all"
                >
                  {q}
                </button>
              ))}
            </div>
            <div className="flex items-baseline justify-between mt-5">
              <span className="text-gray-500 font-medium">Total</span>
              <span className="text-3xl font-bold text-[#007AFF]">
                {weighValid ? fmt(lineTotal(weighQty, weighing.sale_price)) : '—'}
              </span>
            </div>
            {weighInput !== '' && !weighValid && (
              <p className="text-xs text-red-500 mt-2">
                Escribe una cantidad válida (hasta 3 decimales).
              </p>
            )}
            <button
              type="submit"
              disabled={!weighValid}
              className="w-full bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-lg mt-4 active:scale-95 transition-all disabled:opacity-40 shadow-lg shadow-blue-200"
            >
              Agregar a la venta
            </button>
          </form>
        </div>
      )}

      {/* Payment method modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={closePayment}
          />
          <div className="relative bg-white rounded-3xl p-6 shadow-2xl w-80 mx-4">
            <h3 className="text-lg font-bold text-gray-900 text-center mb-1">Forma de pago</h3>
            <p className="text-3xl font-bold text-center text-[#007AFF]">{fmt(total)}</p>
            <div className="mb-5" />
            {paymentView === 'mixed' ? (
              <MixedPayment
                total={total}
                transferLimit={user?.transfer_limit}
                fmt={fmt}
                disabled={completing}
                onConfirm={handleCheckout}
                onBack={() => setPaymentView('list')}
              />
            ) : paymentView === 'foreign' ? (
              <ForeignPayment
                total={total}
                rates={rates}
                fmt={fmt}
                disabled={completing}
                onConfirm={handleCheckout}
                onBack={() => setPaymentView('list')}
              />
            ) : paymentView === 'cash' && guidedCashPayment ? (
              <CashPayment
                total={total}
                fmt={fmt}
                disabled={completing}
                onConfirm={handleCashCheckout}
                onBack={() => setPaymentView('list')}
              />
            ) : (<>
            <div className="space-y-3">
              <button
                onClick={() => guidedCashPayment
                  ? setPaymentView('cash')
                  : handleCheckout({ payment_method: 'efectivo' })}
                disabled={completing}
                className="w-full bg-green-500 text-white py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 active:scale-95 transition-all shadow-md shadow-green-200 disabled:opacity-50"
              >
                <Banknote size={22} />
                Efectivo
              </button>
              <div>
                <button
                  onClick={() => handleCheckout({ payment_method: 'transferencia' })}
                  disabled={completing || transferOverLimit}
                  className="w-full bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 active:scale-95 transition-all shadow-md shadow-blue-200 disabled:opacity-50 disabled:shadow-none"
                >
                  <Smartphone size={22} />
                  Transferencia
                </button>
                {transferOverLimit && (
                  <p className="text-xs text-red-500 text-center mt-2">
                    Supera el límite de transferencia ({fmt(user.transfer_limit)}).
                    {canSplit ? ' Combina transferencia y efectivo, o cobra en efectivo.' : ' Cobra en efectivo o reduce el monto.'}
                  </p>
                )}
              </div>
              {canSplit && (
                <button
                  onClick={() => setPaymentView('mixed')}
                  disabled={completing}
                  className="w-full bg-white text-gray-900 border-2 border-gray-200 py-3.5 rounded-2xl font-bold text-base flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
                >
                  <Smartphone size={18} className="text-[#007AFF]" />
                  Transferencia + efectivo
                  <Banknote size={18} className="text-green-600" />
                </button>
              )}
              <button
                onClick={() => setPaymentView('foreign')}
                disabled={completing}
                className="w-full bg-amber-500 text-white py-3.5 rounded-2xl font-bold text-base flex items-center justify-center gap-2 active:scale-95 transition-all shadow-md shadow-amber-200 disabled:opacity-50"
              >
                <DollarSign size={18} />
                Dólares / Euros
              </button>
            </div>
            <button
              onClick={closePayment}
              className="w-full text-gray-400 py-3 text-sm hover:text-gray-600 transition-colors mt-2"
            >
              Cancelar
            </button>
            </>)}
          </div>
        </div>
      )}

      {/* Products panel */}
      <div className="flex-1 flex flex-col p-4 md:p-6 min-w-0">
        <RejectedSalesBanner rejected={rejected} onAcknowledge={acknowledgeRejected} />
        {ratesOpen && <DeviceRatesEditor rates={rates} fmt={fmt} onClose={() => setRatesOpen(false)} />}
        {/* Barra de referencia: el límite de transferencia del dueño y las
            tasas con que cobra este aparato. Siempre visible para el cajero;
            tocar una tasa la cambia en este aparato. */}
        <div className="flex flex-wrap gap-2 mb-4">
          {user?.transfer_limit != null && (
            <div className="flex items-center gap-1.5 bg-blue-50 text-[#007AFF] text-xs font-semibold px-3 py-1.5 rounded-full">
              <Smartphone size={13} />
              Transferencia hasta {fmt(user.transfer_limit)}
            </div>
          )}
          {['USD', 'EUR'].map((currency) => {
            const r = rates[currency]
            const differs = r.source === 'device' && r.shopRate != null && r.rate !== r.shopRate
            return (
              <button
                key={currency}
                onClick={() => setRatesOpen(true)}
                className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${
                  differs ? 'bg-orange-100 text-orange-700' : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                }`}
                title="Cambiar la tasa de este aparato"
              >
                <DollarSign size={13} />
                {r.rate == null ? `Poner tasa ${currency}` : `1 ${currency} = ${fmt(r.rate)}`}
                {differs && <span className="font-normal">(tienda {fmt(r.shopRate)})</span>}
                <Pencil size={11} className="opacity-60" />
              </button>
            )
          })}
        </div>

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
              const looseLine = cart.find(i => i.id === p.id && !(i.pack || false))
              const packLine = cart.find(i => i.id === p.id && (i.pack || false))
              const hasPackVariant = hasPack(p)

              if (hasPackVariant) {
                return (
                  <div
                    key={p.id}
                    className={`bg-white rounded-2xl p-4 text-left shadow-sm border-2 transition-all ${
                      looseLine || packLine ? 'border-[#007AFF] bg-blue-50/30' : 'border-transparent'
                    }`}
                  >
                    <p className="text-sm font-semibold text-gray-900 mb-1.5 line-clamp-2 leading-tight min-h-[2.5rem]">
                      {p.name}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">Stock: {formatPackStock(p.stock, p.pack_size)}</p>

                    <div className="flex flex-col gap-2 mt-3">
                      <button
                        onClick={() => addToCart(p, false)}
                        disabled={unitsInCart(cart, p.id) >= p.stock}
                        className={`text-left py-2 px-2.5 rounded-lg font-semibold text-sm transition-all active:scale-95 ${
                          unitsInCart(cart, p.id) >= p.stock
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-blue-50 text-[#007AFF] hover:bg-blue-100'
                        }`}
                      >
                        {fmt(p.sale_price)} c/u
                      </button>
                      <button
                        onClick={() => addToCart(p, true)}
                        disabled={unitsInCart(cart, p.id) + p.pack_size > p.stock}
                        className={`text-left py-2 px-2.5 rounded-lg font-semibold text-sm transition-all active:scale-95 ${
                          unitsInCart(cart, p.id) + p.pack_size > p.stock
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                        }`}
                      >
                        Paquete ×{p.pack_size} · {fmt(p.pack_price)}
                      </button>
                    </div>

                    {(looseLine || packLine) && (
                      <div className="mt-2.5 space-y-1.5">
                        {looseLine && (
                          <span className="inline-block bg-blue-500 text-white text-xs font-semibold px-2.5 py-0.5 rounded-full">
                            {looseLine.quantity} c/u en carrito
                          </span>
                        )}
                        {packLine && (
                          <span className="inline-block bg-amber-600 text-white text-xs font-semibold px-2.5 py-0.5 rounded-full">
                            {packLine.quantity} paq en carrito
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              } else {
                return (
                  <button
                    key={p.id}
                    onClick={() => addToCart(p)}
                    className={`bg-white rounded-2xl p-4 text-left shadow-sm hover:shadow-md active:scale-95 transition-all border-2 ${
                      looseLine ? 'border-[#007AFF] bg-blue-50/30' : 'border-transparent'
                    }`}
                  >
                    <p className="text-sm font-semibold text-gray-900 mb-1.5 line-clamp-2 leading-tight min-h-[2.5rem]">
                      {p.name}
                    </p>
                    <p className="text-[#007AFF] font-bold text-base">{fmt(p.sale_price)}{priceSuffix(p.unit)}</p>
                    {(!p.unit || Number(p.track_stock) === 1) && <p className="text-xs text-gray-400 mt-1">Stock: {formatQty(p.stock, p.unit)}</p>}
                    {looseLine && (
                      <div className="mt-2">
                        <span className="bg-[#007AFF] text-white text-xs font-semibold px-2.5 py-0.5 rounded-full">
                          {looseLine.unit ? `${formatQty(looseLine.quantity, looseLine.unit)} en carrito` : `${looseLine.quantity} en carrito`}
                        </span>
                      </div>
                    )}
                  </button>
                )
              }
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
            cart.map(item => <CartItem key={lineKey(item)} item={item} />)
          )}
        </div>

        <div className="px-5 py-5 border-t border-gray-100">
          <div className="flex justify-between items-center mb-4">
            <span className="text-gray-500 font-medium">Total</span>
            <span className="text-3xl font-bold text-gray-900">{fmt(total)}</span>
          </div>
          <button
            onClick={openPayment}
            disabled={cart.length === 0 || completing}
            className="w-full bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-lg hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200"
          >
            {completing ? 'Procesando...' : 'Cobrar'}
          </button>
          {cart.length > 0 && (
            <button
              onClick={() => { if (!shared || window.confirm('¿Vaciar el carrito sin cobrar?')) { saleIdRef.current = null; setCart([]) } }}
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
              {cart.map(item => <CartItem key={lineKey(item)} item={item} />)}
            </div>
            <div className="px-5 py-5 border-t border-gray-100">
              <div className="flex justify-between items-center mb-4">
                <span className="text-gray-500 font-medium text-lg">Total</span>
                <span className="text-3xl font-bold text-gray-900">{fmt(total)}</span>
              </div>
              <button
                onClick={openPayment}
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
