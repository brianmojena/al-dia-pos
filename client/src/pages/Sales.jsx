import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, ClipboardList, Banknote, Smartphone } from 'lucide-react'
import { apiFetch } from '../lib/api'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

export default function Sales() {
  const [sales,      setSales]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [details,    setDetails]    = useState({})

  useEffect(() => {
    apiFetch('/api/sales')
      .then(r => r.json())
      .then(d => { setSales(d); setLoading(false) })
  }, [])

  const toggleExpand = async (id) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (!details[id]) {
      const data = await apiFetch(`/api/sales/${id}`).then(r => r.json())
      setDetails(prev => ({ ...prev, [id]: data }))
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  // Group by calendar date
  const grouped = sales.reduce((acc, sale) => {
    const date = new Date(sale.created_at).toLocaleDateString('es-ES', {
      weekday: 'long', day: 'numeric', month: 'long',
    })
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
                            {new Date(sale.created_at).toLocaleTimeString('es-ES', {
                              hour: '2-digit', minute: '2-digit',
                            })}
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
                                {details[sale.id].items.map(item => (
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
