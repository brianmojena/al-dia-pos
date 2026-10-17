import { formatQty, hasPack, formatPackStock } from '../lib/units.js'
import { productDayStockValues } from '../lib/dailyStock.js'
import { businessDate } from '../lib/offlineModel.js'

function stockLabel(value, product) {
  if (value == null || !Number.isFinite(Number(value))) return 'No disponible'
  return hasPack(product) ? formatPackStock(value, product.pack_size) : formatQty(value, product.unit)
}

export default function ProductDayStock({ product, dayStock, className = '' }) {
  const values = productDayStockValues(product, dayStock, businessDate())
  const opening = stockLabel(values.opening_stock, product)
  const current = stockLabel(values.current_stock, product)
  const entries = values.entries_stock == null ? '—' : stockLabel(values.entries_stock, product)

  if (!values.tracked) {
    return (
      <div className={`text-[11px] leading-4 text-gray-400 ${className}`}>
        <span>Sin control de stock</span>
      </div>
    )
  }

  return (
    <div className={`text-[11px] leading-4 text-gray-400 ${className}`}>
      <span>Inicial: <span className="font-medium text-gray-500">{opening}</span></span>
      <span className="mx-1.5">·</span>
      <span>Entradas: <span className="font-medium text-green-600">{entries}</span></span>
      <span className="mx-1.5">·</span>
      <span>Disponible: <span className="font-medium text-gray-600">{current}</span></span>
    </div>
  )
}
