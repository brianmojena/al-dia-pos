import { useState, useEffect } from 'react'
import {
  ChevronDown, ChevronUp, ChevronLeft, ChevronRight, ArrowLeft, ClipboardList,
  Banknote, Smartphone, Check, AlertTriangle, ArrowUp, Download, WifiOff,
} from 'lucide-react'
import { apiFetch, isElectron } from '../lib/api'
import { formatDayLabel, formatTime } from '../lib/dates'
import { shiftMonth, monthLabel, dayLabel, closeStatus } from '../lib/months'
import { accountLabel } from '../lib/accountLabel'
import RejectedSalesPanel from '../components/RejectedSalesPanel'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

export default function Sales() {
  // La caja de escritorio (Electron) todavía no tiene /api/reports/* — vive
  // local en desktop/src/router.js y esa ruta no está ahí. En vez de romper
  // el Historial en la app de escritorio, se deja tal cual funcionaba antes:
  // la lista simple de ventas recientes, sin navegación por mes ni Excel.
  if (isElectron()) return <ElectronHistorial />
  return <HistorialPorMes />
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
        setError('No se pudo cargar el historial.')
        return
      }
      const data = await res.json()
      setMonthData(data)
      setViewMonth(data.month)
      setCurrentMonth((prev) => prev ?? data.month)
    } catch (_) {
      // Sin red: antes esto dejaba el spinner girando para siempre.
      setError('Necesitas internet para ver el historial.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadMonth() }, [])

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

  // El botón "Historial" de DayDetail solo limpia selectedDate: viewMonth no
  // se toca, así que se vuelve al mismo mes que se estaba mirando.
  const closeDay = () => setSelectedDate(null)

  const toggleExpand = async (id) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (!details[id]) {
      const data = await apiFetch(`/api/sales/${id}`).then((r) => r.json())
      setDetails((prev) => ({ ...prev, [id]: data }))
    }
  }

  const downloadExcel = async () => {
    if (!viewMonth) return
    setExporting(true)
    setExportError('')
    try {
      const res = await apiFetch(`/api/reports/export?month=${viewMonth}`)
      if (!res.ok) throw new Error('export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ventas-${viewMonth}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Safari (iPhone) empieza a leer el archivo después del clic: liberarlo en
      // el acto puede dejar una descarga vacía.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (_) {
      setExportError('Necesitas internet para descargar el Excel.')
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
              {exporting ? 'Generando...' : 'Descargar Excel del mes'}
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
      <div className="grid grid-cols-3 gap-3 pt-3 border-t border-gray-100 text-center">
        <div>
          <p className="text-[11px] text-gray-400 mb-0.5">Efectivo</p>
          <p className="text-sm font-semibold text-gray-800">{fmt(totals.cash_total)}</p>
        </div>
        <div>
          <p className="text-[11px] text-gray-400 mb-0.5">Transf.</p>
          <p className="text-sm font-semibold text-gray-800">{fmt(totals.transfer_total)}</p>
        </div>
        <div>
          <p className="text-[11px] text-gray-400 mb-0.5">Ganancia</p>
          <p className="text-sm font-semibold text-green-600">{fmt(totals.profit)}</p>
        </div>
      </div>
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
        {day.sales_count} {day.sales_count === 1 ? 'venta' : 'ventas'} · efectivo {fmt(day.cash_total)} · transf. {fmt(day.transfer_total)}
      </p>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-green-600 font-medium">Ganancia {fmt(day.profit)}</p>
        <CloseBadge status={status} />
      </div>
    </button>
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

// Detalle de un día: mismas filas de venta expandibles que tenía Historial,
// solo que ahora acotadas a un día (antes eran las últimas 200 ventas).
function DayDetail({ date, sales, loading, error, expandedId, details, onToggle, onBack }) {
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
      ) : sales.length === 0 ? (
        <div className="bg-white rounded-2xl py-20 text-center text-gray-400 shadow-sm">
          <ClipboardList size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Sin ventas ese día</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {sales.map((sale, idx) => (
            <div key={sale.id}>
              <button
                onClick={() => onToggle(sale.id)}
                className={`w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50/80 transition-colors text-left ${
                  idx < sales.length - 1 || expandedId === sale.id ? 'border-b border-gray-50' : ''
                }`}
              >
                <div>
                  <p className="font-semibold text-gray-900 text-sm">Venta #{sale.id}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {formatTime(sale.created_at)}
                    {accountLabel(sale.account_email) && (
                      <span className="text-gray-300"> · {accountLabel(sale.account_email)}</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                    sale.payment_method === 'transferencia'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-green-100 text-green-700'
                  }`}>
                    {sale.payment_method === 'transferencia'
                      ? <><Smartphone size={11} /> Transferencia</>
                      : <><Banknote size={11} /> Efectivo</>}
                  </span>
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

  useEffect(() => {
    apiFetch('/api/sales')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad response'))))
      .then((d) => setSales(Array.isArray(d) ? d : []))
      .catch(() => setError('No se pudo cargar el historial.'))
      .finally(() => setLoading(false))
  }, [])

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
                          <p className="font-semibold text-gray-900 text-sm">Venta #{sale.id}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {formatTime(sale.created_at)}
                            {accountLabel(sale.account_email) && (
                              <span className="text-gray-300"> · {accountLabel(sale.account_email)}</span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                            sale.payment_method === 'transferencia'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-green-100 text-green-700'
                          }`}>
                            {sale.payment_method === 'transferencia'
                              ? <><Smartphone size={11} /> Transferencia</>
                              : <><Banknote size={11} /> Efectivo</>}
                          </span>
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
