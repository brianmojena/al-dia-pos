import { businessDate } from '../lib/offlineModel.js'
import { monthCsv } from '../lib/offlineExport.js'
import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { useState, useEffect } from 'react'
import {
  ChevronDown, ChevronUp, ChevronLeft, ChevronRight, ArrowLeft, ClipboardList,
  Banknote, Smartphone, Check, AlertTriangle, ArrowUp, Download, WifiOff, DollarSign,
} from 'lucide-react'
import { apiFetch, isElectron } from '../lib/api'
import PaymentBadge from '../components/PaymentBadge'
import { paymentSplit, offShopRate, fmtForeign } from '../lib/payment'
import { formatDayLabel, formatTime } from '../lib/dates'
import { shiftMonth, monthLabel, dayLabel, closeStatus } from '../lib/months'
import { accountLabel } from '../lib/accountLabel'
import { useAuth } from '../context/AuthContext'
import RejectedSalesPanel from '../components/RejectedSalesPanel'
import SaleCorrection, { VoidedSales } from '../components/SaleCorrection'
import { summarizeCashierSales, summarizeCashierPayments } from '../lib/cashierSalesSummary'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))
const fmtCashierTotal = (n) => '$ ' + new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0)

export default function Sales() {
  const { user } = useAuth()
  if (user?.role === 'cajero') return <CashierSalesHistory />
  // La caja de escritorio (Electron) todavía no tiene /api/reports/* — vive
  // local en desktop/src/router.js y esa ruta no está ahí. En vez de romper
  // el Historial en la app de escritorio, se deja tal cual funcionaba antes:
  // la lista simple de ventas recientes, sin navegación por mes ni Excel.
  if (isElectron()) return <ElectronHistorial />
  return <HistorialPorMes />
}

function CashierSalesHistory() {
  const { user } = useAuth()
  const [sales, setSales] = useState([])
  const [details, setDetails] = useState({})
  const [expandedId, setExpandedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const res = await apiFetch('/api/sales')
      if (!res.ok) throw new Error('No se pudo cargar el historial.')
      const data = await res.json()
      setSales(Array.isArray(data) ? data : [])
      setError('')
    } catch (_) {
      setError('No se pudo leer el historial guardado. Vuelve a intentar.')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  useLocalRefresh(load)

  const toggle = async (sale) => {
    if (expandedId === sale.id) { setExpandedId(null); return }
    setExpandedId(sale.id)
    if (details[sale.id]) return
    try {
      const res = await apiFetch(`/api/sales/${sale.id}`)
      if (!res.ok) throw new Error('No se pudo cargar el detalle de la venta.')
      const detail = await res.json()
      setDetails((current) => ({ ...current, [sale.id]: detail }))
    } catch (err) { setError(err.message); setExpandedId(null) }
  }

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-24 md:pb-8">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold text-gray-900">Mis ventas</h2>
      </div>
      <p className="text-xs text-gray-500 mb-4">Solo aparecen las ventas de tu cuenta, incluidas las del período abierto.</p>
      {!loading && !error && <CashierSalesSummary sales={sales} />}
      {!loading && !error && user?.cashier_day_breakdown && <CashierDayPayments sales={sales} />}
      {loading ? (
        <div className="flex items-center justify-center py-16"><div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" /></div>
      ) : error ? (
        <div className="bg-white rounded-2xl py-10 text-center text-gray-500 shadow-sm px-6">
          <p className="text-sm mb-3">{error}</p>
          <button onClick={load} className="text-sm font-semibold text-[#007AFF]">Reintentar</button>
        </div>
      ) : sales.length === 0 ? (
        <div className="bg-white rounded-2xl py-16 text-center text-gray-400 shadow-sm"><ClipboardList size={36} className="mx-auto mb-3 opacity-30" /><p className="text-sm">Todavía no hay ventas para mostrar.</p></div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {sales.map((sale, idx) => {
            const expanded = expandedId === sale.id
            const detail = details[sale.id]
            return (
              <div key={sale.id} className={idx < sales.length - 1 || expanded ? 'border-b border-gray-100' : ''}>
                <button onClick={() => toggle(sale)} className="w-full px-5 py-4 text-left hover:bg-gray-50 flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-gray-900">{formatDayLabel(sale.created_at)} · {formatTime(sale.created_at)}</span>
                    <span className="block text-xs text-gray-400 mt-1"><PaymentBadge sale={sale} /></span>
                  </span>
                  <span className="flex items-center gap-2 flex-shrink-0 font-bold text-gray-900">{fmt(sale.total)}{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
                </button>
                {expanded && <div className="px-5 pb-4 bg-gray-50/70">
                  {!detail ? <p className="text-xs text-gray-400 py-2">Cargando detalle…</p> : detail.items.map((item) => (
                    <div key={item.id} className="flex justify-between gap-4 py-2 border-b border-gray-100 last:border-0 text-xs">
                      <span className="text-gray-600">{item.quantity} × {item.product_name}</span>
                      <span className="text-gray-700 font-medium">{fmt(item.quantity * item.unit_price)}</span>
                    </div>
                  ))}
                </div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function CashierSalesSummary({ sales = [], now = new Date() }) {
  const { count, total, pendingCount } = summarizeCashierSales(sales, now)
  return (
    <div className="bg-white rounded-2xl shadow-sm px-5 py-4 mb-4" aria-label="Resumen de mis ventas de hoy">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Mis ventas de hoy</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-gray-400">Ventas</p>
          <p className="text-xl font-bold text-gray-900">{count}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Importe total (CUP)</p>
          <p className="text-xl font-bold text-gray-900">{fmtCashierTotal(total)}</p>
        </div>
      </div>
      {pendingCount > 0 && (
        <p className="text-xs text-amber-700 mt-3">
          Incluye {pendingCount} venta{pendingCount === 1 ? '' : 's'} pendiente{pendingCount === 1 ? '' : 's'} de sincronizar.
        </p>
      )}
    </div>
  )
}

// Lo cobrado hoy por forma de pago, con las mismas tarjetas de la pantalla de
// Inicio. Solo lo ven los cajeros de las tiendas marcadas en el servidor
// (user.cashier_day_breakdown). Los dólares y los euros van en billetes, sin
// convertir: es lo que de verdad entró a la gaveta.
export function CashierDayPayments({ sales = [], now = new Date() }) {
  const payments = summarizeCashierPayments(sales, now)
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Lo cobrado hoy</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Efectivo', value: fmt(payments.cash), icon: Banknote, tone: 'bg-green-50 text-green-600' },
          { label: 'Transferencia', value: fmt(payments.transfer), icon: Smartphone, tone: 'bg-blue-50 text-[#007AFF]' },
          { label: 'Dólares', value: `$ ${fmtForeign(payments.usd)}`, icon: DollarSign, tone: 'bg-emerald-50 text-emerald-600' },
          { label: 'Euros', value: `€ ${fmtForeign(payments.eur)}`, icon: DollarSign, tone: 'bg-indigo-50 text-indigo-500' },
        ].map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="bg-white rounded-2xl p-4 shadow-sm flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${tone}`}><Icon size={16} /></div>
              <span className="text-xs text-gray-500 font-medium">{label}</span>
            </div>
            <p className="text-lg font-bold text-gray-900">{value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Web / móvil: Historial con navegación por mes, resumen y Excel.
// ---------------------------------------------------------------------------

function HistorialPorMes() {
  const [viewMonth,    setViewMonth]    = useState(null) // mes que se está mostrando
  // Mes "actual" según el servidor (nunca según el reloj del teléfono, que
  // puede estar en otro huso horario). Se fija con la primera respuesta y no
  // se vuelve a tocar: es el límite para el botón "siguiente".
  const [currentMonth, setCurrentMonth] = useState(null)
  const [monthData,    setMonthData]    = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')

  const [selectedDate, setSelectedDate] = useState(null)
  const [daySales,     setDaySales]     = useState([])
  const [dayLoading,   setDayLoading]   = useState(false)
  const [dayError,     setDayError]     = useState('')
  const [expandedId,   setExpandedId]   = useState(null)
  const [details,      setDetails]      = useState({})

  const [exporting,    setExporting]    = useState(false)
  const [exportError,  setExportError]  = useState('')

  const loadMonth = async (month) => {
    setLoading(true)
    setError('')
    // Se marca antes de pedirlo: si falla, "Reintentar" vuelve a pedir ESTE mes
    // y no el que se estaba mirando antes.
    if (month) setViewMonth(month)
    try {
      const url = month ? `/api/reports/days?month=${month}` : '/api/reports/days'
      const res = await apiFetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'No se pudo cargar el historial.')
        return
      }
      const data = await res.json()
      setMonthData(data)
      setViewMonth(data.month)
      setCurrentMonth(businessDate().slice(0, 7))
    } catch (_) {
      // Sin red: antes esto dejaba el spinner girando para siempre.
      setError('No se pudo leer el historial guardado. Vuelve a intentar.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadMonth() }, [])
  useLocalRefresh(async () => {
    await loadMonth(viewMonth)
    if (selectedDate) {
      const res = await apiFetch(`/api/sales?date=${selectedDate}`)
      if (res.ok) setDaySales(await res.json())
    }
  })

  const goMonth = (delta) => {
    if (!viewMonth || loading) return
    const target = shiftMonth(viewMonth, delta)
    if (delta > 0 && currentMonth && target > currentMonth) return // no hay meses futuros
    loadMonth(target)
  }

  const openDay = (date) => {
    setSelectedDate(date)
    setDaySales([])
    setDayError('')
    setExpandedId(null)
    setDetails({})
    setDayLoading(true)
    apiFetch(`/api/sales?date=${date}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad response'))))
      .then((d) => setDaySales(Array.isArray(d) ? d : []))
      .catch(() => setDayError('No se pudieron cargar las ventas de ese día.'))
      .finally(() => setDayLoading(false))
  }

  // Tras corregir una venta: se vuelven a leer el día y el mes (totales y
  // cierre cambian) y se cierra el detalle, que ya no vale.
  const [correctedAt, setCorrectedAt] = useState(0)
  const afterCorrection = async () => {
    setExpandedId(null)
    setDetails({})
    setCorrectedAt(Date.now())
    const res = await apiFetch(`/api/sales?date=${selectedDate}`).catch(() => null)
    if (res?.ok) setDaySales(await res.json())
    loadMonth(viewMonth)
  }

  // El botón "Historial" de DayDetail solo limpia selectedDate: viewMonth no
  // se toca, así que se vuelve al mismo mes que se estaba mirando.
  const closeDay = () => setSelectedDate(null)

  const toggleExpand = async (id) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (!details[id]) {
      try {
        const res = await apiFetch(`/api/sales/${id}`)
        if (!res.ok) throw new Error('No se pudo cargar el detalle de la venta')
        const data = await res.json()
        setDetails((prev) => ({ ...prev, [id]: data }))
      } catch (error) { setDayError(error.message); setExpandedId(null) }
    }
  }

  const downloadExcel = async () => {
    if (!viewMonth) return
    setExporting(true)
    setExportError('')
    try {
      let blob, extension = 'xlsx'
      try {
        if (navigator.onLine === false) throw new Error('offline')
        const res = await apiFetch(`/api/reports/export?month=${viewMonth}`)
        if (!res.ok) throw new Error('export failed')
        blob = await res.blob()
      } catch {
        const res = await apiFetch('/api/sales')
        if (!res.ok) throw new Error('No se pudo preparar el archivo local')
        blob = new Blob([monthCsv(await res.json(), viewMonth)], { type: 'text/csv;charset=utf-8' })
        extension = 'csv'
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ventas-${viewMonth}.${extension}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Safari (iPhone) empieza a leer el archivo después del clic: liberarlo en
      // el acto puede dejar una descarga vacía.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (_) {
      setExportError('No se pudo generar el archivo. Vuelve a intentar.')
    } finally {
      setExporting(false)
    }
  }

  if (selectedDate) {
    return (
      <DayDetail
        date={selectedDate}
        sales={daySales}
        loading={dayLoading}
        error={dayError}
        expandedId={expandedId}
        details={details}
        onToggle={toggleExpand}
        onBack={closeDay}
        onCorrected={afterCorrection}
        correctedAt={correctedAt}
      />
    )
  }

  const nextDisabled = !viewMonth || !currentMonth || viewMonth >= currentMonth

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Historial</h2>
      </div>

      <RejectedSalesPanel />

      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => goMonth(-1)}
          disabled={!viewMonth || loading}
          className="p-2 rounded-xl hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={20} />
        </button>
        <p className="font-semibold text-gray-900 capitalize">
          {viewMonth ? monthLabel(viewMonth) : '—'}
        </p>
        <button
          onClick={() => goMonth(1)}
          disabled={nextDisabled || loading}
          className="p-2 rounded-xl hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl py-16 text-center text-gray-400 shadow-sm px-6">
          <WifiOff size={36} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm text-gray-500 mb-4">{error}</p>
          <button onClick={() => loadMonth(viewMonth)} className="text-sm font-semibold text-[#007AFF]">
            Reintentar
          </button>
        </div>
      ) : (
        <>
          <MonthSummary totals={monthData.totals} />

          <div className="mb-6">
            <button
              onClick={downloadExcel}
              disabled={exporting}
              className="w-full flex items-center justify-center gap-2 bg-white border border-gray-200 text-gray-700 font-semibold text-sm py-3 rounded-2xl shadow-sm hover:bg-gray-50 active:scale-[0.99] transition-all disabled:opacity-50"
            >
              <Download size={16} />
              {exporting ? 'Generando...' : 'Descargar ventas del mes (Excel / CSV sin conexión)'}
            </button>
            {exportError && (
              <p className="text-xs text-red-600 text-center mt-2">{exportError}</p>
            )}
          </div>

          {monthData.days.length === 0 ? (
            <div className="bg-white rounded-2xl py-20 text-center text-gray-400 shadow-sm">
              <ClipboardList size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">No hubo ventas en {monthLabel(viewMonth)}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {monthData.days.map((day) => (
                <DayRow key={day.date} day={day} onOpen={() => openDay(day.date)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function MonthSummary({ totals }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Total del mes</span>
        <span className="text-xs text-gray-400">
          {totals.sales_count} {totals.sales_count === 1 ? 'venta' : 'ventas'}
        </span>
      </div>
      <p className="text-3xl font-bold text-gray-900 mb-4">{fmt(totals.total)}</p>
      <div className={`grid ${totals.foreign_total ? 'grid-cols-4' : 'grid-cols-3'} gap-3 pt-3 border-t border-gray-100 text-center`}>
        <div>
          <p className="text-[11px] text-gray-400 mb-0.5">Efectivo</p>
          <p className="text-sm font-semibold text-gray-800">{fmt(totals.cash_total)}</p>
        </div>
        <div>
          <p className="text-[11px] text-gray-400 mb-0.5">Transf.</p>
          <p className="text-sm font-semibold text-gray-800">{fmt(totals.transfer_total)}</p>
        </div>
        {!!totals.foreign_total && (
          <div>
            <p className="text-[11px] text-gray-400 mb-0.5">Divisa</p>
            <p className="text-sm font-semibold text-amber-700">{fmt(totals.foreign_total)}</p>
          </div>
        )}
        <div>
          <p className="text-[11px] text-gray-400 mb-0.5">Ganancia</p>
          <p className="text-sm font-semibold text-green-600">{fmt(totals.profit)}</p>
        </div>
      </div>
      <ForeignLine day={totals} />
    </div>
  )
}

function DayRow({ day, onOpen }) {
  const status = closeStatus(day.closes)
  return (
    <button
      onClick={onOpen}
      className="w-full bg-white rounded-2xl shadow-sm px-5 py-4 text-left hover:bg-gray-50/80 active:scale-[0.99] transition-all"
    >
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <p className="font-semibold text-gray-900 text-sm capitalize truncate">{dayLabel(day.date)}</p>
        <span className="font-bold text-gray-900 flex-shrink-0">{fmt(day.total)}</span>
      </div>
      <p className="text-xs text-gray-400 mb-2">
        {day.sales_count === 0 ? 'Sin ventas' : `${day.sales_count} ${day.sales_count === 1 ? 'venta' : 'ventas'} · efectivo ${fmt(day.cash_total)} · transf. ${fmt(day.transfer_total)}`}
        {!!day.foreign_total && <> · divisa {fmt(day.foreign_total)}</>}
      </p>
      {!!day.stock_moves && (
        <p className="text-xs text-gray-400 mb-2">
          {day.stock_moves} {day.stock_moves === 1 ? 'movimiento de mercancía' : 'movimientos de mercancía'}
        </p>
      )}
      <ForeignLine day={day} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-green-600 font-medium">Ganancia {fmt(day.profit)}</p>
        <CloseBadge status={status} />
      </div>
    </button>
  )
}

// Los billetes recibidos en el día o el mes, sin convertir, y cuántos se
// cobraron a una tasa que no era la de la tienda. Los descuadres de divisa de
// los cierres van aquí también: la etiqueta del cierre habla solo de pesos.
function ForeignLine({ day }) {
  const received = [['usd_total', 'USD'], ['eur_total', 'EUR']]
    .filter(([key]) => Number(day[key]) > 0)
    .map(([key, code]) => `${fmtForeign(day[key])} ${code}`)
  const diffs = [['difference_usd', 'USD'], ['difference_eur', 'EUR']]
    .map(([key, code]) => ({ code, diff: Number(day.closes?.[key]) || 0 }))
    .filter((d) => Math.abs(d.diff) >= 0.005)
  if (received.length === 0 && !day.off_rate_count && diffs.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mb-2 mt-1">
      {received.length > 0 && (
        <span className="flex items-center gap-1 text-amber-800 font-medium">
          <DollarSign size={12} /> {received.join(' · ')}
        </span>
      )}
      {day.off_rate_count > 0 && (
        <span className="flex items-center gap-1 text-orange-600 font-semibold">
          <AlertTriangle size={12} />
          {day.off_rate_count === 1 ? '1 cobro' : `${day.off_rate_count} cobros`} con otra tasa
        </span>
      )}
      {diffs.map(({ code, diff }) => (
        <span key={code} className={`font-semibold ${diff < 0 ? 'text-red-600' : 'text-orange-600'}`}>
          {diff < 0 ? 'Faltó' : 'Sobró'} {fmtForeign(Math.abs(diff))} {code} en caja
        </span>
      ))}
    </div>
  )
}

// Detalle de un cobro en divisa, para el dueño: a cuánto se tomó el billete,
// qué completó el cliente en pesos o qué vuelto se le dio, y si la tasa no era
// la de la tienda.
function ForeignDetail({ sale }) {
  if (sale.payment_method !== 'divisa') return null
  const { cash, foreign_cup: foreignCup } = paymentSplit(sale)
  const off = offShopRate(sale)
  return (
    <div className={`rounded-xl px-3 py-2.5 mb-3 text-sm ${off ? 'bg-orange-50' : 'bg-amber-50'}`}>
      <p className="text-gray-800">
        <strong>{fmtForeign(sale.foreign_amount)} {sale.foreign_currency}</strong> a {fmt(sale.exchange_rate)} = {fmt(foreignCup)}
      </p>
      {Math.round(cash) > 0 && <p className="text-xs text-gray-600 mt-0.5">El cliente completó {fmt(cash)} en efectivo</p>}
      {Math.round(cash) < 0 && <p className="text-xs text-gray-600 mt-0.5">Vuelto en pesos: {fmt(-cash)}</p>}
      {off && (
        <p className="flex items-center gap-1 text-xs font-semibold text-orange-700 mt-1">
          <AlertTriangle size={12} /> La tasa de la tienda era {fmt(sale.shop_rate)}
        </p>
      )}
    </div>
  )
}

function CloseBadge({ status }) {
  if (status.kind === 'none') {
    return (
      <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-400 flex-shrink-0">
        Sin cierre
      </span>
    )
  }
  if (status.kind === 'square') {
    return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-green-100 text-green-700 flex-shrink-0">
        <Check size={12} /> Cuadró
      </span>
    )
  }
  const short = status.kind === 'short'
  return (
    <span className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0 ${
      short ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'
    }`}>
      {short ? <AlertTriangle size={12} /> : <ArrowUp size={12} />}
      {short ? `Faltó ${fmt(status.amount)}` : `Sobró ${fmt(status.amount)}`}
    </span>
  )
}

// Entradas de mercancía del día: stock_entries, warehouse_transfers y warehouse_changes
function StockMovements({ date, refreshKey }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [movements, setMovements] = useState([])

  useEffect(() => {
    setLoading(true)
    setError(false)
    apiFetch(`/api/dashboard/day?date=${date}`)
      .then((res) => {
        if (!res.ok) throw new Error('failed')
        return res.json()
      })
      .then((data) => {
        const all = [
          ...(data.stockEntries || []).map((e) => ({
            type: 'stock_entry',
            kind: e.kind || 'entrada',
            product_name: e.product_name,
            quantity: e.quantity,
            stock_before: e.stock_before,
            stock_after: e.stock_after,
            reason: e.reason,
            time: e.time,
            account_email: e.account_email,
            created_at: e.created_at,
          })),
          ...(data.transfers || []).map((t) => ({
            type: 'warehouse_transfer',
            item_name: t.item_name,
            quantity: t.quantity,
            created_product: t.created_product,
            direction: t.direction,
            time: t.time,
            account_email: t.account_email,
            created_at: t.created_at,
          })),
          ...(data.warehouseChanges || []).map((w) => ({
            type: 'warehouse_change',
            action: w.action,
            item_name: w.item_name,
            detail: w.detail,
            time: w.time,
            account_email: w.account_email,
            created_at: w.created_at,
          })),
        ]
        all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        setMovements(all)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [date, refreshKey])

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-5 flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-5 text-center">
        <p className="text-xs text-gray-400">No se pudieron cargar los movimientos de mercancía. Hace falta conexión.</p>
      </div>
    )
  }

  if (movements.length === 0) return null

  const formatQty = (q) => Number(Number(q).toFixed(3)).toString()

  const actionLabels = {
    'alta': 'Entró al almacén',
    'importación': 'Importado al almacén',
    'reposición': 'Repuesto en el almacén',
    'edición': 'Cambio en el almacén',
    'borrado': 'Borrado del almacén',
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4">
      <div className="px-5 py-3 border-b border-gray-50">
        <h3 className="text-sm font-semibold text-gray-900">Movimientos de mercancía</h3>
      </div>
      {movements.map((m, idx) => (
        <div
          key={`${m.type}-${idx}`}
          className={`px-5 py-4 flex items-start justify-between ${
            idx < movements.length - 1 ? 'border-b border-gray-50' : ''
          }`}
        >
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-900">
              {m.type === 'stock_entry'
                ? m.product_name
                : m.item_name}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {m.time}
              {accountLabel(m.account_email) && (
                <span className="text-gray-300"> · {accountLabel(m.account_email)}</span>
              )}
            </p>
            {m.type === 'stock_entry' && (
              <p className="text-xs text-gray-400 mt-1">
                {
                  {
                    'entrada': 'Entró a la tienda',
                    'nuevo': 'Producto nuevo con stock',
                    'importacion': 'Importado desde Excel',
                    'correccion': 'Corrección de stock',
                    'anulacion': 'Volvió por venta anulada',
                  }[m.kind] || 'Movimiento de stock'
                }
                <br />
                <span className="text-gray-500">{Number(m.stock_before)} → {Number(m.stock_after)}</span>
                {m.reason && (
                  <>
                    <br />
                    <span className="text-gray-500">{m.reason}</span>
                  </>
                )}
              </p>
            )}
            {m.type === 'warehouse_transfer' && (
              <p className="text-xs text-gray-400 mt-1">
                {m.direction === 'to_warehouse' ? 'De la tienda al almacén' : 'Del almacén a la tienda'}
                {m.direction === 'to_warehouse' && m.created_product ? ' · artículo nuevo' : m.direction !== 'to_warehouse' && m.created_product ? ' · producto nuevo' : ''}
              </p>
            )}
            {m.type === 'warehouse_change' && (
              <p className="text-xs text-gray-400 mt-1">
                {actionLabels[m.action] || 'Almacén'}
                {m.detail && (
                  <>
                    <br />
                    <span className="text-gray-500">{m.detail}</span>
                  </>
                )}
              </p>
            )}
          </div>
          <div className="text-right flex-shrink-0 ml-3">
            {m.type === 'stock_entry' && (
              <p className={`text-sm font-semibold ${m.stock_after - m.stock_before < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {m.stock_after - m.stock_before >= 0 ? '+' : ''}{formatQty(m.stock_after - m.stock_before)}
              </p>
            )}
            {m.type === 'warehouse_transfer' && (
              <p className="text-sm font-semibold text-gray-900">
                {m.direction === 'to_warehouse' ? '−' : '+'}{formatQty(m.quantity)}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// Detalle de un día: mismas filas de venta expandibles que tenía Historial,
// solo que ahora acotadas a un día (antes eran las últimas 200 ventas).
function DayDetail({ date, sales, loading, error, expandedId, details, onToggle, onBack, onCorrected, correctedAt }) {
  const total = sales.reduce((s, sale) => s + sale.total, 0)

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm font-semibold text-[#007AFF] mb-4 hover:opacity-70 transition-opacity"
      >
        <ArrowLeft size={16} /> Historial
      </button>

      <div className="flex items-center justify-between mb-6 gap-2">
        <h2 className="text-2xl font-bold text-gray-900 capitalize truncate">{dayLabel(date)}</h2>
        {sales.length > 0 && (
          <span className="text-sm text-gray-500 flex-shrink-0">{sales.length} ventas · {fmt(total)}</span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl py-16 text-center text-gray-400 shadow-sm px-6">
          <WifiOff size={36} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      ) : (
        <>
          {sales.length === 0 && (
            <div className="bg-white rounded-2xl py-20 text-center text-gray-400 shadow-sm mb-4">
              <ClipboardList size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Sin ventas ese día</p>
            </div>
          )}
          {sales.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4">
              {sales.map((sale, idx) => (
            <div key={sale.id}>
              <button
                onClick={() => onToggle(sale.id)}
                className={`w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50/80 transition-colors text-left ${
                  idx < sales.length - 1 || expandedId === sale.id ? 'border-b border-gray-50' : ''
                }`}
              >
                <div>
                  <p className="font-semibold text-gray-900 text-sm">{sale.pending ? 'Venta pendiente' : `Venta #${sale.id}`}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {formatTime(sale.created_at)}
                    {accountLabel(sale.account_email) && (
                      <span className="text-gray-300"> · {accountLabel(sale.account_email)}</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <PaymentBadge sale={sale} />
                  <span className="font-bold text-gray-900">{fmt(sale.total)}</span>
                  {expandedId === sale.id
                    ? <ChevronUp size={16} className="text-gray-400" />
                    : <ChevronDown size={16} className="text-gray-400" />}
                </div>
              </button>

              {expandedId === sale.id && (
                <div className="bg-gray-50/60 px-5 pb-4 pt-3 border-b border-gray-50 last:border-0">
                  {details[sale.id] ? (
                    <>
                      <ForeignDetail sale={sale} />
                      <div className="space-y-2 mb-3">
                        {details[sale.id].items.map((item) => (
                          <div key={item.id} className="flex justify-between text-sm">
                            <span className="text-gray-600">
                              {item.product_name}
                              <span className="text-gray-400"> × {item.quantity}</span>
                            </span>
                            <span className="font-medium text-gray-800">
                              {fmt(item.unit_price * item.quantity)}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between pt-2 border-t border-gray-200">
                        <span className="text-xs text-gray-400 font-medium">Ganancia estimada</span>
                        <span className="text-xs font-bold text-green-600">{fmt(sale.profit)}</span>
                      </div>
                      <SaleCorrection sale={sale} items={details[sale.id].items} onChanged={onCorrected} />
                    </>
                  ) : (
                    <div className="flex justify-center py-2">
                      <div className="w-5 h-5 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                </div>
              )}
            </div>
            ))}
            </div>
          )}
          <StockMovements date={date} refreshKey={correctedAt} />
        </>
      )}
      <VoidedSales date={date} refreshKey={correctedAt} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Electron: /api/reports/* no existe en desktop/src/router.js (todavía vive
// solo en el servidor real). Se mantiene el Historial de siempre — lista
// plana de ventas recientes agrupadas por día, sin mes ni Excel — para no
// romper la caja de escritorio. Si algún día el router local aprende esas
// rutas, esto se puede borrar y usar HistorialPorMes en los dos modos.
// ---------------------------------------------------------------------------

function ElectronHistorial() {
  const [sales,      setSales]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [details,    setDetails]    = useState({})

  const [correctedAt, setCorrectedAt] = useState(0)
  const fetchSales = () => apiFetch('/api/sales')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad response'))))
    .then((d) => setSales(Array.isArray(d) ? d : []))

  useEffect(() => {
    fetchSales()
      .catch(() => setError('No se pudo cargar el historial.'))
      .finally(() => setLoading(false))
  }, [])

  // Tras corregir una venta se vuelve a leer la lista y se cierra el detalle.
  const load = () => {
    setExpandedId(null)
    setDetails({})
    setCorrectedAt(Date.now())
    fetchSales().catch(() => {})
  }

  const toggleExpand = async (id) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (!details[id]) {
      const data = await apiFetch(`/api/sales/${id}`).then((r) => r.json())
      setDetails((prev) => ({ ...prev, [id]: data }))
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (error) return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Historial</h2>
      <RejectedSalesPanel />
      <div className="bg-white rounded-2xl py-16 text-center text-gray-400 shadow-sm px-6">
        <WifiOff size={36} className="mx-auto mb-3 opacity-30" />
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    </div>
  )

  // Group by calendar date
  const grouped = sales.reduce((acc, sale) => {
    const date = formatDayLabel(sale.created_at)
    if (!acc[date]) acc[date] = []
    acc[date].push(sale)
    return acc
  }, {})

  const totalAll = sales.reduce((s, sale) => s + sale.total, 0)

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Historial</h2>
        {sales.length > 0 && (
          <span className="text-sm text-gray-500">{sales.length} ventas · {fmt(totalAll)}</span>
        )}
      </div>

      <RejectedSalesPanel />
      <div className="mb-4"><VoidedSales refreshKey={correctedAt} /></div>

      {sales.length === 0 ? (
        <div className="bg-white rounded-2xl py-20 text-center text-gray-400 shadow-sm">
          <ClipboardList size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Sin ventas registradas</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([date, daySales]) => {
            const dayTotal = daySales.reduce((s, sale) => s + sale.total, 0)
            return (
              <div key={date}>
                <div className="flex justify-between items-center mb-2 px-1">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide capitalize">{date}</p>
                  <p className="text-xs font-semibold text-gray-500">{fmt(dayTotal)}</p>
                </div>
                <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
                  {daySales.map((sale, idx) => (
                    <div key={sale.id}>
                      <button
                        onClick={() => toggleExpand(sale.id)}
                        className={`w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50/80 transition-colors text-left ${
                          idx < daySales.length - 1 || expandedId === sale.id ? 'border-b border-gray-50' : ''
                        }`}
                      >
                        <div>
                          <p className="font-semibold text-gray-900 text-sm">{sale.pending ? 'Venta pendiente' : `Venta #${sale.id}`}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {formatTime(sale.created_at)}
                            {accountLabel(sale.account_email) && (
                              <span className="text-gray-300"> · {accountLabel(sale.account_email)}</span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <PaymentBadge sale={sale} />
                          <span className="font-bold text-gray-900">{fmt(sale.total)}</span>
                          {expandedId === sale.id
                            ? <ChevronUp size={16} className="text-gray-400" />
                            : <ChevronDown size={16} className="text-gray-400" />}
                        </div>
                      </button>

                      {expandedId === sale.id && (
                        <div className="bg-gray-50/60 px-5 pb-4 pt-3 border-b border-gray-50 last:border-0">
                          {details[sale.id] ? (
                            <>
                              <ForeignDetail sale={sale} />
                              <div className="space-y-2 mb-3">
                                {details[sale.id].items.map((item) => (
                                  <div key={item.id} className="flex justify-between text-sm">
                                    <span className="text-gray-600">
                                      {item.product_name}
                                      <span className="text-gray-400"> × {item.quantity}</span>
                                    </span>
                                    <span className="font-medium text-gray-800">
                                      {fmt(item.unit_price * item.quantity)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              <div className="flex justify-between pt-2 border-t border-gray-200">
                                <span className="text-xs text-gray-400 font-medium">Ganancia estimada</span>
                                <span className="text-xs font-bold text-green-600">{fmt(sale.profit)}</span>
                              </div>
                              <SaleCorrection sale={sale} items={details[sale.id].items} onChanged={load} />
                            </>
                          ) : (
                            <div className="flex justify-center py-2">
                              <div className="w-5 h-5 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
