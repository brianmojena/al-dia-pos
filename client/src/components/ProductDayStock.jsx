import { formatQty, hasPack, formatPackStock } from '../lib/units.js'
import { productDayStockValues } from '../lib/dailyStock.js'
import { businessDate } from '../lib/offlineModel.js'

function stockLabel(value, product) {
  if (value == null || !Number.isFinite(Number(value))) return 'No disponible'
  return hasPack(product) ? formatPackStock(value, product.pack_size) : formatQty(value, product.unit)
}

export default function ProductDayStock({ product, dayStock, className = '' }) {
  const values = productDayStockValues(product, dayStock, businessDate())
  const opening = values.tracked ? stockLabel(values.opening_stock, product) : 'Sin control'
  const current = values.tracked ? stockLabel(values.current_stock, product) : 'Sin control'

  return (
    <div className={`text-[11px] leading-4 text-gray-400 ${className}`}>
      <span>Inicio del día: <span className="font-medium text-gray-500">{opening}</span></span>
      <span className="mx-1.5">·</span>
      <span>Stock actual: <span className="font-medium text-gray-600">{current}</span></span>
    </div>
  )
}
