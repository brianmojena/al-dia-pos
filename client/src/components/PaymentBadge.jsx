import { Banknote, Smartphone, DollarSign, AlertTriangle } from 'lucide-react'
import { paymentSplit, offShopRate, fmtForeign } from '../lib/payment'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

/**
 * Etiqueta de la forma de cobro de una venta. Una venta mixta muestra el
 * reparto al lado ("$1.350 + $1.150"): sin eso, el dueño que revisa el día no
 * puede saber cuánto de esa venta tendría que estar en la gaveta.
 */
export default function PaymentBadge({ sale, short = false }) {
  const base = 'flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full'

  // En divisa se ve a cuánto se tomó el billete ("20 USD × 350"). Si no era la
  // tasa de la tienda, la etiqueta sale en naranja con un aviso.
  if (sale.payment_method === 'divisa') {
    const off = offShopRate(sale)
    const { cash } = paymentSplit(sale)
    const detail = `${fmtForeign(sale.foreign_amount)} ${sale.foreign_currency} a ${fmt(sale.exchange_rate)}`
      + (Math.round(cash) > 0 ? ` + ${fmt(cash)} en efectivo` : Math.round(cash) < 0 ? ` · vuelto ${fmt(-cash)}` : '')
      + (off ? ` · la tienda tenía ${fmt(sale.shop_rate)}` : '')
    return (
      <span className={`${base} ${off ? 'bg-orange-100 text-orange-700' : 'bg-amber-100 text-amber-800'}`} title={detail}>
        {off ? <AlertTriangle size={11} /> : <DollarSign size={11} />}
        {short
          ? `${fmtForeign(sale.foreign_amount)} ${sale.foreign_currency}`
          : <>{fmtForeign(sale.foreign_amount)} {sale.foreign_currency} <span className="font-normal">× {fmtForeign(sale.exchange_rate)}</span></>}
      </span>
    )
  }

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
  // Efectivo puro: si cash_received está presente, mostrar vuelto
  if (sale.cash_received != null && Number(sale.cash_received) > Number(sale.total)) {
    const change = Number(sale.cash_received) - Number(sale.total)
    const detail = `Recibió ${fmt(sale.cash_received)} · vuelto ${fmt(change)}`
    return (
      <span className={`${base} bg-green-100 text-green-700`} title={detail}>
        <Banknote size={11} /> {short ? `Efectivo · vuelto ${fmt(change)}` : `Efectivo · ${detail}`}
      </span>
    )
  }
  // Efectivo exacto
  if (sale.cash_received != null && Number(sale.cash_received) === Number(sale.total)) {
    return (
      <span className={`${base} bg-green-100 text-green-700`} title="Pago exacto, sin vuelto">
        <Banknote size={11} /> Efectivo · exacto
      </span>
    )
  }
  // Efectivo antiguo (sin cash_received)
  return (
    <span className={`${base} bg-green-100 text-green-700`}>
      <Banknote size={11} /> Efectivo
    </span>
  )
}
