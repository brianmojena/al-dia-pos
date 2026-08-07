import { useState, useEffect } from 'react'
import { TrendingUp, DollarSign, ShoppingBag, AlertTriangle, RefreshCw, Banknote, Smartphone } from 'lucide-react'
import { apiFetch } from '../lib/api'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

export default function Dashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    apiFetch('/api/dashboard')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  const today = new Date()
  const dateLabel = today.toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long',
  })

  return (
    <div className="p-5 md:p-8 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Hoy</h2>
          <p className="text-sm text-gray-500 capitalize mt-0.5">{dateLabel}</p>
        </div>
        <button
          onClick={load}
          className="p-2.5 rounded-xl hover:bg-gray-100 text-gray-500 transition-colors active:scale-95"
        >
          <RefreshCw size={18} />
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <div className="bg-white rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
              <DollarSign size={20} className="text-[#007AFF]" />
            </div>
            <span className="text-sm text-gray-500 font-medium">Ventas del día</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{fmt(data?.today?.sales)}</p>
        </div>

        <div className="bg-white rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center">
              <TrendingUp size={20} className="text-green-500" />
            </div>
            <span className="text-sm text-gray-500 font-medium">Ganancia estimada</span>
          </div>
          <p className="text-2xl font-bold text-green-600">{fmt(data?.today?.profit)}</p>
        </div>

        <div className="bg-white rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-purple-50 rounded-xl flex items-center justify-center">
              <ShoppingBag size={20} className="text-purple-500" />
            </div>
            <span className="text-sm text-gray-500 font-medium">Transacciones</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{data?.today?.count || 0}</p>
        </div>
      </div>

      {/* Low stock alert */}
      {data?.lowStock?.length > 0 && (
        <div className="bg-orange-50 border border-orange-100 rounded-2xl p-5 mb-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={17} className="text-orange-500" />
            <h3 className="font-semibold text-orange-800 text-sm">Stock bajo</h3>
          </div>
          <div className="space-y-1">
            {data.lowStock.map(p => (
              <div key={p.id} className="flex justify-between items-center py-2 border-b border-orange-100 last:border-0">
                <span className="text-gray-700 text-sm">{p.name}</span>
                <span className={`font-bold text-sm px-2 py-0.5 rounded-lg ${
                  p.stock === 0 ? 'bg-red-100 text-red-600' : 'bg-orange-100 text-orange-700'
                }`}>
                  {p.stock === 0 ? 'AGOTADO' : `${p.stock} uds`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent sales */}
      {data?.recentSales?.length > 0 && (
        <div className="bg-white rounded-2xl p-5 shadow-sm">
          <h3 className="font-semibold text-gray-900 mb-4 text-sm uppercase tracking-wide text-gray-500">
            Últimas ventas hoy
          </h3>
          <div className="space-y-1">
            {data.recentSales.map(sale => (
              <div key={sale.id} className="flex justify-between items-center py-2.5 border-b border-gray-50 last:border-0">
                <div>
                  <p className="text-gray-800 font-medium text-sm">Venta #{sale.id}</p>
                  <p className="text-xs text-gray-400">
                    {new Date(sale.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                    sale.payment_method === 'transferencia'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-green-100 text-green-700'
                  }`}>
                    {sale.payment_method === 'transferencia'
                      ? <><Smartphone size={11} /> Transfer</>
                      : <><Banknote size={11} /> Efectivo</>}
                  </span>
                  <span className="font-semibold text-gray-900">{fmt(sale.total)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data?.today?.count === 0 && data?.lowStock?.length === 0 && (
        <div className="bg-white rounded-2xl py-16 text-center text-gray-400 shadow-sm">
          <ShoppingBag size={36} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Sin ventas registradas hoy</p>
        </div>
      )}
    </div>
  )
}
