import { formatQty } from '../lib/units'
import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { TrendingUp, DollarSign, ShoppingBag, AlertTriangle, RefreshCw, Banknote, Smartphone, Users, ChevronRight, Package, X, ArrowUpFromLine } from 'lucide-react'
import { apiFetch } from '../lib/api'
import PaymentBadge from '../components/PaymentBadge'
import ShopRatesCard from '../components/ShopRatesCard'
import { formatTime, formatDateTime } from '../lib/dates'
import { newId } from '../lib/newId'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

const fmtMoney = (n) => new Intl.NumberFormat('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n || 0)

const methodLabel = { efectivo: 'Efectivo', transferencia: 'Transferencia', USD: 'Dólares', EUR: 'Euros' }
const holdingKey = { efectivo: 'cash', transferencia: 'transfer', USD: 'usd', EUR: 'eur' }

export default function Dashboard() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [withdrawalModal, setWithdrawalModal] = useState(null) // { method } or null
  const [withdrawalAmount, setWithdrawalAmount] = useState('')
  const [withdrawalNote, setWithdrawalNote] = useState('')
  const [withdrawalSubmitting, setWithdrawalSubmitting] = useState(false)
  const [withdrawalError, setWithdrawalError] = useState('')

  const load = async () => {
    try {
      const res = await apiFetch('/api/dashboard'), data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar Inicio')
      setData(data); setError('')
    } catch (error) { setError(error.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])
  useLocalRefresh(load)

  const handleWithdrawalSubmit = async (e) => {
    e.preventDefault()
    if (withdrawalSubmitting || !withdrawalModal) return
    setWithdrawalSubmitting(true)
    setWithdrawalError('')
    try {
      const res = await apiFetch('/api/cash-withdrawals', {
        method: 'POST',
        body: JSON.stringify({
          client_withdrawal_id: withdrawalModal.id,
          method: withdrawalModal.method,
          amount: parseFloat(withdrawalAmount) || 0,
          note: withdrawalNote.trim() || null,
        }),
      })
      const result = await res.json()
      if (!res.ok) {
        setWithdrawalError(result.error || 'No se pudo guardar la extracción')
        return
      }
      setWithdrawalModal(null)
      setWithdrawalAmount('')
      setWithdrawalNote('')
      await load()
    } catch (err) {
      setWithdrawalError(err.message || 'No se pudo guardar la extracción. Intenta de nuevo.')
    } finally {
      setWithdrawalSubmitting(false)
    }
  }

  const handleVoidWithdrawal = async (clientWithdrawalId) => {
    if (!confirm('¿Anular esta extracción? El dinero vuelve a contar en la caja.')) return
    try {
      const res = await apiFetch(`/api/cash-withdrawals/${clientWithdrawalId}/void`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        alert(result.error || 'No se pudo anular la extracción')
        return
      }
      await load()
    } catch (err) {
      alert(err.message || 'No se pudo anular la extracción. Intenta de nuevo.')
    }
  }

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

      {data?.audit?.rejectedSales > 0 && (
        <Link
          to="/sales"
          className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-2xl px-5 py-4 mb-5 hover:bg-red-100/60 transition-colors"
        >
          <AlertTriangle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-red-700 text-sm">
              {data.audit.rejectedSales === 1
                ? '1 venta rechazada por revisar'
                : `${data.audit.rejectedSales} ventas rechazadas por revisar`}
            </p>
            <p className="text-xs text-red-600 mt-0.5">
              Se cobraron sin internet y no se pudieron registrar. Míralas en Historial.
            </p>
          </div>
          <ChevronRight size={18} className="text-red-300 flex-shrink-0" />
        </Link>
      )}

      {data?.audit?.offRateSales > 0 && (
        <Link
          to="/sales"
          className="flex items-start gap-3 bg-orange-50 border border-orange-200 rounded-2xl px-5 py-4 mb-5 hover:bg-orange-100/60 transition-colors"
        >
          <AlertTriangle size={18} className="text-orange-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-orange-700 text-sm">
              {data.audit.offRateSales === 1
                ? '1 cobro en divisa hoy con otra tasa'
                : `${data.audit.offRateSales} cobros en divisa hoy con otra tasa`}
            </p>
            <p className="text-xs text-orange-600 mt-0.5">
              Se cobraron a una tasa distinta a la de la tienda. Míralos en Historial.
            </p>
          </div>
          <ChevronRight size={18} className="text-orange-300 flex-shrink-0" />
        </Link>
      )}

      {error && <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>}
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

      {/* Lo que hay ahora: efectivo, transferencias, divisas e inventario */}
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Lo que hay ahora</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Efectivo', method: 'efectivo', value: fmt(data?.holdings?.cash), icon: Banknote, tone: 'bg-green-50 text-green-600' },
            { label: 'Transferencia', method: 'transferencia', value: fmt(data?.holdings?.transfer), icon: Smartphone, tone: 'bg-blue-50 text-[#007AFF]' },
            { label: 'Dólares', method: 'USD', value: `$ ${fmtMoney(data?.holdings?.usd)}`, icon: DollarSign, tone: 'bg-emerald-50 text-emerald-600' },
            { label: 'Euros', method: 'EUR', value: `€ ${fmtMoney(data?.holdings?.eur)}`, icon: DollarSign, tone: 'bg-indigo-50 text-indigo-500' },
          ].map(({ label, method, value, icon: Icon, tone }) => (
            <div key={label} className="bg-white rounded-2xl p-4 shadow-sm flex flex-col">
              <div className="flex items-center gap-2 mb-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${tone}`}><Icon size={16} /></div>
                <span className="text-xs text-gray-500 font-medium">{label}</span>
              </div>
              <p className="text-lg font-bold text-gray-900 mb-2">{value}</p>
              <button
                onClick={() => { setWithdrawalModal({ method, id: newId() }); setWithdrawalAmount(''); setWithdrawalNote(''); setWithdrawalError('') }}
                className="mt-auto w-full flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold text-[#007AFF] hover:bg-blue-50 rounded-lg transition-colors active:scale-95 min-h-[36px]"
              >
                <ArrowUpFromLine size={14} /> Extraer
              </button>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-2">Lo cobrado desde el último arqueo de caja, menos lo extraído.</p>

        {data?.open_withdrawals?.length > 0 && (
          <div className="bg-white rounded-2xl p-4 shadow-sm mt-3">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-3">Extracciones sin cerrar</h3>
            <div className="space-y-2">
              {data.open_withdrawals.map((w) => {
                const label = methodLabel[w.method]
                const formattedAmount = w.method === 'USD' ? `− $ ${fmtMoney(w.amount)}` : w.method === 'EUR' ? `− € ${fmtMoney(w.amount)}` : fmt(Math.round(w.amount))
                return (
                  <div key={w.client_withdrawal_id} className="flex items-start justify-between py-2 border-b border-gray-100 last:border-0 gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{label}</p>
                      {w.note && <p className="text-xs text-gray-500 truncate">{w.note}</p>}
                      <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(w.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-sm font-bold text-red-600">{w.method === 'USD' || w.method === 'EUR' ? formattedAmount : `− ${fmt(Math.round(w.amount))}`}</span>
                      <button
                        onClick={() => handleVoidWithdrawal(w.client_withdrawal_id)}
                        className="text-xs text-red-500 hover:text-red-700 font-semibold transition-colors"
                      >
                        Anular
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="bg-white rounded-2xl p-4 shadow-sm mt-3 flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Package size={19} className="text-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 font-medium">Importe total del inventario</p>
            <p className="text-xl font-bold text-gray-900">{fmt(data?.inventory?.cost)}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              A precio de compra · {fmt(data?.inventory?.retail)} a precio de venta · {data?.inventory?.units || 0} uds
            </p>
          </div>
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
                  {p.stock === 0 ? 'AGOTADO' : `${formatQty(p.stock, p.unit || 'uds')}`}
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
                  <p className="text-gray-800 font-medium text-sm">{sale.pending ? 'Venta pendiente' : `Venta #${sale.id}`}</p>
                  <p className="text-xs text-gray-400">
                    {formatTime(sale.created_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <PaymentBadge sale={sale} short />
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

      <ShopRatesCard fmt={fmt} />

      <Link
        to="/cajeros"
        className="flex items-center gap-3 bg-white rounded-2xl px-5 py-4 shadow-sm mt-5 hover:bg-gray-50/80 transition-colors"
      >
        <div className="w-10 h-10 bg-gray-100 rounded-xl flex items-center justify-center flex-shrink-0">
          <Users size={19} className="text-gray-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 text-sm">Cajeros</p>
          <p className="text-xs text-gray-400 mt-0.5">
            Cuentas que pueden cobrar pero no ver las ventas del día
          </p>
        </div>
        <ChevronRight size={18} className="text-gray-300 flex-shrink-0" />
      </Link>

      {/* Withdrawal Modal */}
      {withdrawalModal && (
        <div className="fixed inset-0 bg-black/20 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-lg">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Extraer de {methodLabel[withdrawalModal.method]}</h3>
              <button
                onClick={() => setWithdrawalModal(null)}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X size={18} className="text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleWithdrawalSubmit} className="p-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-600 block mb-1.5">Cuánto extraes</label>
                <div className="relative">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    autoFocus
                    value={withdrawalAmount}
                    onChange={(e) => setWithdrawalAmount(e.target.value)}
                    placeholder="0"
                    className="w-full px-4 py-3 text-lg font-bold rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-gray-500">
                    {withdrawalModal.method === 'USD' ? '$' : withdrawalModal.method === 'EUR' ? '€' : 'CUP'}
                  </span>
                </div>
                {withdrawalModal.method === 'transferencia' && (
                  <p className="text-[11px] text-gray-400 mt-1.5">Dinero que sale de la cuenta del banco.</p>
                )}
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-600 block mb-1.5">Nota (opcional)</label>
                <input
                  type="text"
                  value={withdrawalNote}
                  onChange={(e) => setWithdrawalNote(e.target.value)}
                  placeholder="Ej: pago al proveedor de pan"
                  className="w-full px-4 py-3 text-sm rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>

              {parseFloat(withdrawalAmount) > 0 && data?.holdings?.[holdingKey[withdrawalModal.method]] !== undefined && parseFloat(withdrawalAmount) > data.holdings[holdingKey[withdrawalModal.method]] && (
                <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2.5">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  <p>Estás sacando más de lo que marca el sistema. Puede pasar si la caja tenía fondo inicial.</p>
                </div>
              )}

              {withdrawalError && (
                <div className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2.5">{withdrawalError}</div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setWithdrawalModal(null)}
                  className="flex-1 px-4 py-3 text-sm font-semibold text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={withdrawalSubmitting || !withdrawalAmount || parseFloat(withdrawalAmount) <= 0}
                  className="flex-1 px-4 py-3 text-sm font-semibold bg-[#007AFF] text-white rounded-xl hover:bg-blue-600 disabled:opacity-40 transition-colors active:scale-95"
                >
                  {withdrawalSubmitting ? 'Guardando…' : 'Extraer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
