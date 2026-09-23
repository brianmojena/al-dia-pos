import { Banknote, Smartphone } from 'lucide-react'
import { paymentSplit } from '../lib/payment'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

/**
 * Etiqueta de la forma de cobro de una venta. Una venta mixta muestra el
 * reparto al lado ("$1.350 + $1.150"): sin eso, el dueño que revisa el día no
 * puede saber cuánto de esa venta tendría que estar en la gaveta.
 */
export default function PaymentBadge({ sale, short = false }) {
  const base = 'flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full'

  if (sale.payment_method === 'mixto') {
    const { cash, transfer } = paymentSplit(sale)
    return (
      <span
        className={`${base} bg-violet-100 text-violet-700`}
        title={`Transferencia ${fmt(transfer)} + efectivo ${fmt(cash)}`}
      >
        <Smartphone size={11} /><Banknote size={11} />
        {short ? 'Mixto' : <>Mixto <span className="font-normal">· {fmt(transfer)} + {fmt(cash)}</span></>}
      </span>
    )
  }
  if (sale.payment_method === 'transferencia') {
    return (
      <span className={`${base} bg-blue-100 text-blue-700`}>
        <Smartphone size={11} /> {short ? 'Transfer' : 'Transferencia'}
      </span>
    )
  }
  return (
    <span className={`${base} bg-green-100 text-green-700`}>
      <Banknote size={11} /> Efectivo
    </span>
  )
}
