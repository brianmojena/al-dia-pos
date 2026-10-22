/**
 * Cruce de inventario con cierre de caja.
 *
 * Compara el último arqueo de inventario contra la diferencia de efectivo
 * del cierre para detectar ventas sin registrar o duplicadas.
 */

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round2 = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;

const abs = (value) => Math.abs(number(value));

/**
 * Función pura: analiza un arqueo contra un cierre.
 *
 * @param {Object} params - Parámetros
 * @param {Object} params.close - El cierre de caja
 * @param {Object} params.count - El arqueo de inventario (o null)
 * @param {Array} params.items - Líneas del arqueo (product_id, product_name, expected, counted, difference, unit_price)
 * @param {number} params.productsTotal - Productos con control de stock y existencias (los que el arqueo debía cubrir)
 * @returns {Object} { available, verdict, message, ...métricas }
 */
export function evaluateCrossCheck({ close, count, items, productsTotal }) {
  if (!close || !count) {
    return {
      available: false,
      verdict: 'sin_arqueo',
      message: 'No hay un arqueo de inventario en las 6 horas previas al cierre; no se puede cruzar.',
    };
  }

  if (!Array.isArray(items)) {
    items = [];
  }

  // Calcular métricas
  const products_counted = items.length;
  const coverage = productsTotal > 0 ? products_counted / productsTotal : 1;

  let units_missing = 0;
  let units_extra = 0;
  let value_missing = 0;
  let value_extra = 0;

  for (const item of items) {
    const difference = number(item.difference);
    const unit_price = number(item.unit_price);

    if (difference < 0) {
      units_missing += -difference;
      value_missing += -difference * unit_price;
    } else if (difference > 0) {
      units_extra += difference;
      value_extra += difference * unit_price;
    }
  }

  units_missing = round2(units_missing);
  units_extra = round2(units_extra);
  value_missing = round2(value_missing);
  value_extra = round2(value_extra);
  const net_missing_value = round2(value_missing - value_extra);

  const cash_difference = number(close.difference);
  const minutes_before_close = Math.round(
    (new Date(close.closed_at) - new Date(count.counted_at)) / (1000 * 60)
  );
  const counted_by = count.account_email || null;
  const count_id = count.id;
  const counted_at = count.counted_at;

  // Determinar veredicto
  let verdict;
  let message;

  if (coverage < 0.8 && productsTotal > 0) {
    verdict = 'parcial';
    const covered = Math.round(coverage * 100);
    message = `El arqueo cubrió ${products_counted} de ${productsTotal} productos (${covered}%); no se puede concluir con tan poca cobertura.`;
  } else if (units_missing === 0 && units_extra === 0) {
    verdict = 'cuadra';
    if (cash_difference < -0.5) {
      message = 'El inventario cuadra con las ventas registradas: no hay ventas sin registrar ni duplicadas. La diferencia de caja viene del efectivo (vuelto, gastos sin anotar o conteo).';
    } else {
      message = 'El inventario cuadra con las ventas registradas.';
    }
  } else if (
    cash_difference < -0.5
    && net_missing_value > 0
    && net_missing_value >= 0.6 * abs(cash_difference)
    && net_missing_value <= 1.5 * abs(cash_difference)
  ) {
    verdict = 'respaldo';
    const missingRounded = Math.round(net_missing_value);
    const cashRounded = Math.round(abs(cash_difference));
    message = `Faltan mercancías por ${missingRounded} CUP y el faltante de caja es ${cashRounded} CUP: probablemente hay ventas sin registrar.`;
  } else {
    verdict = 'diferencias';
    const unitsMissingRounded = Math.round(units_missing);
    const unitsExtraRounded = Math.round(units_extra);
    const netRounded = Math.round(net_missing_value);
    const cashRounded = Math.round(abs(cash_difference));
    message = `El inventario tiene diferencias (${unitsMissingRounded} unidades faltan, ${unitsExtraRounded} sobran, valor neto ${netRounded} CUP) que no coinciden con la diferencia de caja de ${cashRounded} CUP; revisar ventas duplicadas, sin registrar o mercancía dañada o regalada.`;
  }

  return {
    available: true,
    verdict,
    message,
    products_counted,
    products_total: productsTotal,
    units_missing,
    units_extra,
    value_missing,
    value_extra,
    net_missing_value,
    cash_difference,
    minutes_before_close,
    counted_by,
    count_id,
    counted_at,
  };
}

/**
 * Consulta el último arqueo de inventario y evalúa el cruce.
 *
 * Selecciona el inventory_counts más reciente del mismo user_id con
 * counted_at entre (closed_at - 360 minutos) y (closed_at + 5 minutos).
 */
export async function computeInventoryCrossCheck(db, close) {
  const userId = close.user_id;

  // Buscar el arqueo más reciente en la ventana de tiempo
  const countResult = await db.execute({
    sql: `
      SELECT ic.* FROM inventory_counts ic
      WHERE ic.user_id = ?
        AND datetime(ic.counted_at) BETWEEN datetime(?, '-360 minutes') AND datetime(?, '+5 minutes')
      ORDER BY ic.counted_at DESC, ic.id DESC
      LIMIT 1
    `,
    args: [userId, close.closed_at, close.closed_at],
  });

  const count = countResult.rows?.[0] || null;

  if (!count) {
    return {
      available: false,
      verdict: 'sin_arqueo',
      message: 'No hay un arqueo de inventario en las 6 horas previas al cierre; no se puede cruzar.',
    };
  }

  // Cargar las líneas del arqueo
  const itemsResult = await db.execute({
    sql: `
      SELECT product_id, product_name, expected, counted, difference, unit_cost, unit_price
      FROM inventory_count_items
      WHERE count_id = ?
      ORDER BY product_id ASC
    `,
    args: [count.id],
  });

  const items = itemsResult.rows || [];

  // El arqueo solo lista los productos con existencias: uno en cero no hay
  // nada que contar. La cobertura se mide contra los que tienen stock (o ya
  // entraron en este arqueo), no contra todo el catálogo.
  const productsResult = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM products
           WHERE user_id = ? AND track_stock = 1
             AND (stock > 0 OR id IN (SELECT product_id FROM inventory_count_items WHERE count_id = ?))`,
    args: [userId, count.id],
  });

  const productsTotal = Number(productsResult.rows?.[0]?.n) || 0;

  return evaluateCrossCheck({ close, count, items, productsTotal });
}
