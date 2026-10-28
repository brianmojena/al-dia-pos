import { CheckCircle2, AlertTriangle, Info, AlertCircle } from 'lucide-react'
import { formatDateTime } from './dates.js'
import { accountLabel } from './accountLabel.js'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))

export const crossCheckTone = (verdict) => {
  const tones = {
    cuadra: {
      bg: 'bg-green-50',
      textColor: 'text-green-800',
      iconColor: 'text-green-600',
      Icon: CheckCircle2,
    },
    respaldo: {
      bg: 'bg-red-50',
      textColor: 'text-red-800',
      iconColor: 'text-red-600',
      Icon: AlertTriangle,
    },
    diferencias: {
      bg: 'bg-amber-50',
      textColor: 'text-amber-800',
      iconColor: 'text-amber-600',
      Icon: AlertCircle,
    },
    parcial: {
      bg: 'bg-gray-50',
      textColor: 'text-gray-700',
      iconColor: 'text-gray-500',
      Icon: Info,
    },
    sin_arqueo: {
      bg: 'bg-gray-50',
      textColor: 'text-gray-700',
      iconColor: 'text-gray-500',
      Icon: Info,
    },
  }
  return tones[verdict] || tones.parcial
}

export const crossCheckRows = (check) => {
  if (!check || !check.available) return []

  const rows = []

  // Línea 1: Arqueo (fecha, hora, por quién)
  if (check.counted_at && check.counted_by) {
    const label = accountLabel(check.counted_by) || check.counted_by
    rows.push({
      label: 'Arqueo',
      value: `${formatDateTime(check.counted_at)} · ${label}`,
    })
  }

  if (check.closed_by) {
    const label = accountLabel(check.closed_by) || check.closed_by
    rows.push({ label: 'Cierre realizado por', value: label })
  }

  if (check.uncounted_sold_products_count > 0) {
    const products = Array.isArray(check.uncounted_sold_products)
      ? check.uncounted_sold_products.map((product) => product.product_name).filter(Boolean)
      : []
    rows.push({
      label: 'Productos vendidos sin contar',
      value: products.length ? products.join(', ') : String(check.uncounted_sold_products_count),
      tone: 'text-amber-700',
    })
  }

  if (check.stock_adjustments_count > 0) {
    rows.push({
      label: 'Ajustes de stock desde conteo anterior',
      value: `${check.stock_adjustments_count} · +${check.stock_adjustment_units_in || 0} / −${check.stock_adjustment_units_out || 0} unidades`,
      tone: 'text-amber-700',
    })
  }

  // Línea 2: Productos contados
  if (check.products_counted != null && check.products_total != null) {
    rows.push({
      label: 'Productos contados',
      value: `${check.products_counted} de ${check.products_total}`,
    })
  }

  // Línea 3: Faltan (solo si > 0)
  if (check.units_missing > 0) {
    rows.push({
      label: 'Faltan',
      value: `${check.units_missing} unidades · ${fmt(check.value_missing)}`,
      tone: 'text-red-600',
    })
  }

  // Línea 4: Sobran (solo si > 0)
  if (check.units_extra > 0) {
    rows.push({
      label: 'Sobran',
      value: `${check.units_extra} unidades · ${fmt(check.value_extra)}`,
      tone: 'text-orange-600',
    })
  }

  // Línea 5: Diferencia de caja
  if (check.cash_difference != null) {
    const cashDiff = Number(check.cash_difference) || 0
    rows.push({
      label: 'Diferencia de caja',
      value: fmt(cashDiff),
      tone: cashDiff < 0 ? 'text-red-600' : cashDiff > 0 ? 'text-orange-600' : 'text-green-600',
    })
  }

  return rows
}
