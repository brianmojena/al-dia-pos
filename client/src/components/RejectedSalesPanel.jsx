import { useState, useEffect } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { apiFetch, isElectron } from '../lib/api'
import { formatDateTime } from '../lib/dates'
import { accountLabel } from '../lib/accountLabel'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

// Lo que ve el DUEÑO en Historial: ventas que un empleado cobró sin internet y
// el servidor rechazó al subirlas. No se muestra nada si no hay pendientes de
// revisar. En la caja de escritorio no aplica: esas ventas viven en la web.
export default function RejectedSalesPanel() {
  const [list, setList] = useState([])

  const load = () =>
    apiFetch('/api/sales/rejected')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setList(Array.isArray(d) ? d : []))
      .catch(() => {})

  useEffect(() => { if (!isElectron()) load() }, [])

  const markReviewed = async (id) => {
    const res = await apiFetch(`/api/sales/rejected/${id}/review`, { method: 'POST' })
    if (res.ok) load()
  }

  const pendientes = list.filter((s) => !s.reviewed_at)
  if (pendientes.length === 0) return null

  const totalPendiente = pendientes.reduce((s, r) => s + Number(r.total), 0)

  return (
    <div className="mb-6">
      <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
        <div className="flex items-start gap-2.5 mb-4">
          <AlertTriangle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-red-700">
              {pendientes.length === 1 ? '1 venta rechazada' : `${pendientes.length} ventas rechazadas`} · {fmt(totalPendiente)}
            </p>
            <p className="text-xs text-red-600 mt-1 leading-relaxed">
              Se cobraron sin internet y el sistema no pudo registrarlas al subirlas, casi siempre porque
              ya no quedaba stock. No descontaron inventario ni cuentan en el cierre de caja: el cierre
              va a mostrar un sobrante por este monto.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          {pendientes.map((sale) => (
            <div key={sale.id} className="bg-white rounded-xl px-4 py-3">
              <div className="flex justify-between items-start gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {fmt(sale.total)} · {sale.payment_method === 'transferencia' ? 'Transferencia' : 'Efectivo'}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {formatDateTime(sale.sold_at || sale.reported_at)}
                    {accountLabel(sale.account_email) && ` · cobró ${accountLabel(sale.account_email)}`}
                  </p>
                  <p className="text-xs text-gray-600 mt-1">
                    {(sale.items || []).map((i) => `${i.quantity}× ${i.product_name}`).join(', ')}
                  </p>
                  {sale.error && <p className="text-xs text-red-600 mt-1">{sale.error}</p>}
                </div>
                <button
                  onClick={() => markReviewed(sale.id)}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 px-2.5 py-1.5 rounded-lg flex-shrink-0"
                >
                  <Check size={13} /> Revisada
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
