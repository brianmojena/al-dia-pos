import { AlertTriangle, Check } from 'lucide-react'
import { formatDateTime } from '../lib/dates'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

// Lo que ve el EMPLEADO en su pantalla de venta cuando una venta que cobró sin
// internet fue rechazada al subirla. Tiene que ser imposible de pasar por alto:
// el dinero está en la caja y la venta no quedó registrada.
export default function RejectedSalesBanner({ rejected, onAcknowledge }) {
  if (!rejected || rejected.length === 0) return null

  return (
    <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4">
      <div className="flex items-start gap-2.5 mb-3">
        <AlertTriangle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-red-700 text-sm">
            {rejected.length === 1
              ? '1 venta cobrada no se pudo registrar'
              : `${rejected.length} ventas cobradas no se pudieron registrar`}
          </p>
          <p className="text-xs text-red-600 mt-0.5 leading-relaxed">
            Se cobraron sin internet y, al subirlas, el sistema las rechazó. El dinero está en la
            caja: no lo devuelvas ni lo guardes aparte, avisa al dueño.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {rejected.map((sale) => {
          const total = (sale.items || []).reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0)
          return (
            <div key={sale.client_sale_id} className="bg-white rounded-xl px-3.5 py-3">
              <div className="flex justify-between items-start gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {fmt(total)} · {sale.payment_method === 'transferencia' ? 'Transferencia' : 'Efectivo'}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {sale.queued_at ? formatDateTime(new Date(sale.queued_at).toISOString()) : ''}
                    {' · '}
                    {(sale.items || []).map((i) => `${i.quantity}× ${i.product_name || 'producto'}`).join(', ')}
                  </p>
                  <p className="text-xs text-red-600 mt-1">{sale.error}</p>
                </div>
                {sale.reported ? (
                  <button
                    onClick={() => onAcknowledge(sale.client_sale_id)}
                    className="flex items-center gap-1 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 px-2.5 py-1.5 rounded-lg flex-shrink-0"
                  >
                    <Check size={13} /> Entendido
                  </button>
                ) : null}
              </div>
              <p className={`text-[11px] mt-1.5 ${sale.reported ? 'text-green-700' : 'text-gray-400'}`}>
                {sale.reported
                  ? 'El dueño ya puede verla en su Historial.'
                  : 'Avisando al dueño… hace falta internet.'}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
