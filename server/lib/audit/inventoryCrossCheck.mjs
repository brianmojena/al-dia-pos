/**
 * Cruce de inventario con cierre de caja.
 *
 * Compara un arqueo con el cierre y muestra los límites de esa evidencia.
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
export function evaluateCrossCheck({
  close, count, items, productsTotal, adjustments = [], uncountedSoldProducts = [],
  linkedSalesCount = 0, stockTrackingHistoryKnown = true,
}) {
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
  const adjustmentsBeforeCount = adjustments.filter((row) => String(row.created_at) <= String(count.counted_at));
  const adjustmentsAfterCount = adjustments.filter((row) => String(row.created_at) > String(count.counted_at));
  const adjustmentUnits = (rows, sign) => round2(rows.reduce((total, row) => {
    const delta = number(row.stock_after) - number(row.stock_before);
    return total + (sign > 0 ? Math.max(delta, 0) : Math.max(-delta, 0));
  }, 0));

  const cash_difference = number(close.difference);
  const minutes_before_close = Math.round(
    (new Date(close.closed_at) - new Date(count.counted_at)) / (1000 * 60)
  );
  const counted_by = count.account_email || null;
  const closed_by = close.account_email || null;
  const countedAfterClose = minutes_before_close < 0;
  const timingUncertain = Number(linkedSalesCount) > 0 && minutes_before_close !== 0;
  const limitations = [];
  if (!stockTrackingHistoryKnown) {
    limitations.push('no se conserva el historial de qué productos tenían control de stock; los omitidos se filtran por el estado actual');
  }
  if (countedAfterClose) {
    limitations.push('el conteo se hizo después del cierre y puede incluir movimientos posteriores');
  } else if (timingUncertain) {
    limitations.push('el conteo y las ventas vinculadas al cierre no son simultáneos; las fechas offline no siempre reflejan el orden físico');
  }
  const limitationNote = limitations.length ? ` Limitación: ${limitations.join('; ')}.` : '';
  const count_id = count.id;
  const counted_at = count.counted_at;

  // Determinar veredicto
  let verdict;
  let message;

  if (coverage < 0.8 && productsTotal > 0) {
    verdict = 'parcial';
    const covered = Math.round(coverage * 100);
    message = `El arqueo cubrió ${products_counted} de ${productsTotal} productos (${covered}%); no se puede concluir con tan poca cobertura.${limitationNote}`;
  } else if (units_missing === 0 && units_extra === 0 && adjustments.length === 0
      && uncountedSoldProducts.length === 0 && limitations.length === 0) {
    verdict = 'cuadra';
    message = 'Las líneas incluidas en el arqueo coinciden con el stock esperado. Esto no demuestra que no haya ventas duplicadas o sin registrar.';
  } else if (units_missing === 0 && units_extra === 0) {
    verdict = 'parcial';
    const reasons = [];
    if (adjustments.length) reasons.push(`${adjustments.length} ajuste(s) de stock desde el conteo anterior`);
    if (uncountedSoldProducts.length) reasons.push(`${uncountedSoldProducts.length} producto(s) vendido(s) en el período sin línea contada`);
    if (!reasons.length) reasons.push('el alcance temporal o del control de stock es incompleto');
    message = `Las líneas contadas coinciden, pero el cruce es incierto: ${reasons.join(' y ')}. No permite concluir que no haya ventas duplicadas o sin registrar.${limitationNote}`;
  } else {
    verdict = 'diferencias';
    const unitsMissingRounded = Math.round(units_missing);
    const unitsExtraRounded = Math.round(units_extra);
    const netRounded = Math.round(net_missing_value);
    const cashRounded = Math.round(abs(cash_difference));
    const adjustmentNote = adjustments.length ? ` Hay ${adjustments.length} ajuste(s) de stock previos en el período.` : '';
    const omittedNote = uncountedSoldProducts.length ? ` Hay ${uncountedSoldProducts.length} producto(s) vendido(s) sin línea contada.` : '';
    message = `El arqueo tiene diferencias (${unitsMissingRounded} unidades faltan, ${unitsExtraRounded} sobran; valor neto de mercancía ${netRounded} CUP). La diferencia de caja es ${cashRounded} CUP; la coincidencia de valores no demuestra una causa ni ventas duplicadas o sin registrar.${adjustmentNote}${omittedNote}${limitationNote}`;
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
    closed_by,
    linked_sales_count: Number(linkedSalesCount) || 0,
    counted_after_close: countedAfterClose,
    timing_uncertain: timingUncertain,
    stock_tracking_history_known: stockTrackingHistoryKnown,
    uncounted_sold_products: uncountedSoldProducts.map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      quantity_sold: number(row.quantity_sold),
    })),
    uncounted_sold_products_count: uncountedSoldProducts.length,
    stock_adjustments_count: adjustments.length,
    stock_adjustments_before_count: adjustmentsBeforeCount.length,
    stock_adjustments_after_count: adjustmentsAfterCount.length,
    stock_adjustment_units_in: adjustmentUnits(adjustments, 1),
    stock_adjustment_units_out: adjustmentUnits(adjustments, -1),
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

  // No usar stock actual para reconstruir un cierre histórico: una existencia
  // actual de cero no elimina productos que debieron entrar en aquel conteo.
  const productsResult = await db.execute({
    sql: `SELECT COUNT(DISTINCT product_id) AS n FROM (
            SELECT p.id AS product_id FROM products p
             WHERE p.user_id = ? AND p.track_stock = 1
               AND datetime(p.created_at) <= datetime(?)
            UNION SELECT product_id FROM inventory_count_items WHERE count_id = ?
            UNION SELECT si.product_id FROM sale_items si
              JOIN sales s ON s.id = si.sale_id
              JOIN products p ON p.id = si.product_id AND p.user_id = s.user_id AND p.track_stock = 1
             WHERE s.user_id = ? AND si.product_id IS NOT NULL
               AND s.cash_close_id = ?
          )`,
    args: [userId, count.counted_at, count.id, userId, close.id],
  });

  const productsTotal = Number(productsResult.rows?.[0]?.n) || 0;

  const previousCountResult = await db.execute({
    sql: `SELECT counted_at FROM inventory_counts
           WHERE user_id = ? AND (counted_at < ? OR (counted_at = ? AND id < ?))
           ORDER BY counted_at DESC, id DESC LIMIT 1`,
    args: [userId, count.counted_at, count.counted_at, count.id],
  });
  const previousCountAt = previousCountResult.rows?.[0]?.counted_at || close.opened_at || count.counted_at;
  const adjustmentPeriodEnd = String(count.counted_at) > String(close.closed_at)
    ? count.counted_at : close.closed_at;

  const adjustmentsResult = await db.execute({
    sql: `SELECT id, product_id, product_name, stock_before, stock_after, created_at
            FROM stock_entries
           WHERE user_id = ? AND kind = 'correccion'
             AND datetime(created_at) >= datetime(?)
             AND datetime(created_at) <= datetime(?)
           ORDER BY created_at ASC, id ASC`,
    args: [userId, previousCountAt, adjustmentPeriodEnd],
  });

  const linkedSalesResult = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM sales WHERE user_id = ? AND cash_close_id = ?',
    args: [userId, close.id],
  });

  const uncountedSoldResult = await db.execute({
    sql: `SELECT si.product_id, MAX(si.product_name) AS product_name,
                 SUM(si.quantity * COALESCE(si.pack_size, 1)) AS quantity_sold
            FROM sale_items si JOIN sales s ON s.id = si.sale_id
            JOIN products p ON p.id = si.product_id AND p.user_id = s.user_id AND p.track_stock = 1
           WHERE s.user_id = ? AND s.cash_close_id = ?
             AND si.product_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM inventory_count_items ici
                WHERE ici.count_id = ? AND ici.product_id = si.product_id
             )
           GROUP BY si.product_id ORDER BY product_name COLLATE NOCASE`,
    args: [userId, close.id, count.id],
  });

  return evaluateCrossCheck({
    close,
    count,
    items,
    productsTotal,
    adjustments: adjustmentsResult.rows || [],
    uncountedSoldProducts: uncountedSoldResult.rows || [],
    linkedSalesCount: Number(linkedSalesResult.rows?.[0]?.n) || 0,
    // products.track_stock se conserva solo en su estado actual, sin historial.
    stockTrackingHistoryKnown: false,
  });
}
