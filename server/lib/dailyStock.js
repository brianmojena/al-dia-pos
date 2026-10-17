const { businessToday, boundsForDate } = require('./businessDay');
const { lineUnits } = require('./units');

function timestampMs(value) {
  if (!value) return null;
  const text = String(value).trim().replace(' ', 'T');
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const time = Date.parse(zoned);
  return Number.isFinite(time) ? time : null;
}

// Mercancía que entró al stock hoy: la recibida a mano ('entrada'), la carga
// inicial de un producto nuevo ('nuevo') y la importación que SUMA
// ('importacion'). Las correcciones a mano ('correccion'), las unidades que
// vuelven al anular una venta ('anulacion') y una importación que REEMPLAZA el
// stock (también 'correccion') NO son entradas: ajustan o restauran, pero no es
// mercancía que llegó. Una transferencia almacén → tienda sí lo es y se cuenta
// aparte, en la consulta de transferencias.
const ENTRY_KINDS = new Set(['entrada', 'nuevo', 'importacion']);

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Reconstruct today's opening stock from persisted movements, using the caller's transaction. */
async function dailyStock(tx, userId, date = businessToday()) {
  const { start, end } = boundsForDate(date);
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  const products = (await tx.execute({
    sql: 'SELECT id, stock, unit, track_stock, created_at FROM products WHERE user_id = ? ORDER BY name, id',
    args: [userId],
  })).rows;
  const sales = await tx.execute({ sql: `SELECT i.product_id, i.quantity, i.pack_size, i.stock_delta FROM sales s JOIN sale_items i ON i.sale_id = s.id
    WHERE s.user_id = ? AND datetime(s.created_at) >= datetime(?) AND datetime(s.created_at) < datetime(?) AND i.product_id IS NOT NULL`, args: [userId, start, end] });
  const entries = await tx.execute({ sql: `SELECT product_id, stock_before, stock_after, kind, quantity FROM stock_entries
    WHERE user_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?) AND product_id IS NOT NULL`, args: [userId, start, end] });
  const transfers = await tx.execute({ sql: `SELECT product_id, quantity, direction FROM warehouse_transfers
    WHERE user_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?) AND product_id IS NOT NULL`, args: [userId, start, end] });
  const corrections = await tx.execute({ sql: `SELECT before FROM sale_corrections WHERE user_id = ? AND action = 'anular'
    AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)`, args: [userId, start, end] });
  const countsToday = await tx.execute({ sql: `SELECT i.product_id, i.initial_difference, i.difference FROM inventory_count_items i
    JOIN inventory_counts c ON c.id = i.count_id
    WHERE c.user_id = ? AND datetime(c.counted_at) >= datetime(?) AND datetime(c.counted_at) < datetime(?) AND i.product_id IS NOT NULL`, args: [userId, start, end] });
  const legacyCorrectionProducts = await tx.execute({ sql: `SELECT DISTINCT product_id FROM stock_entries
    WHERE user_id = ? AND product_id IS NOT NULL AND kind = 'correccion'
      AND reason LIKE 'Corrección del arqueo del %'`, args: [userId] });
  const legacyCorrectionProductIds = new Set(legacyCorrectionProducts.rows.map((row) => Number(row.product_id)));
  const ambiguousLegacyProducts = new Set();
  const ambiguousLegacyWeightedProducts = new Set();
  const productsById = new Map(products.map((product) => [Number(product.id), product]));
  const delta = new Map();
  const add = (id, amount) => delta.set(Number(id), (delta.get(Number(id)) || 0) + amount);
  const addSaleLine = (item) => {
    const product = productsById.get(Number(item.product_id));
    if (item.stock_delta != null) {
      add(item.product_id, Number(item.stock_delta));
    } else if (product?.unit && Number(product.track_stock) === 1) {
      // Legacy weight sales don't record how much the zero clamp actually removed.
      ambiguousLegacyWeightedProducts.add(Number(item.product_id));
    } else {
      add(item.product_id, -lineUnits(item));
    }
  };
  for (const row of sales.rows) addSaleLine(row);
  // Sales deleted by an annulment remain in the correction JSON. Include their
  // original decrease only when the sale itself happened today; the separate
  // stock_entries annulment row represents the restoration on its actual day.
  for (const correction of corrections.rows) {
    let before;
    try { before = JSON.parse(correction.before); } catch (_) { before = null; }
    const soldAt = timestampMs(before?.created_at);
    if (soldAt == null || soldAt < startMs || soldAt >= endMs) continue;
    for (const item of before.items || []) if (item.product_id != null) addSaleLine(item);
  }
  for (const row of entries.rows) add(row.product_id, Number(row.stock_after) - Number(row.stock_before));
  // Mercancía recibida hoy, aparte del ajuste de apertura: es lo que el dueño
  // quiere ver sumado a la base del día. Se acumula por producto para soportar
  // varias entradas (a mano, alta de producto nuevo e importación). Solo cuenta
  // lo que suma stock: una importación que reemplaza a la baja es un ajuste,
  // igual que una corrección, no mercancía que llegó.
  const entriesByProduct = new Map();
  for (const row of entries.rows) {
    const kind = row.kind == null || row.kind === '' ? 'entrada' : String(row.kind);
    if (!ENTRY_KINDS.has(kind)) continue;
    const quantity = Number(row.quantity);
    if (!(quantity > 0)) continue;
    const id = Number(row.product_id);
    entriesByProduct.set(id, (entriesByProduct.get(id) || 0) + quantity);
  }
  // Semántica de tienda: recibir del almacén hoy también es mercancía que
  // entró a la tienda, así que cuenta como entrada. La tienda → almacén saca
  // mercancía y no es una entrada. Se cuenta una sola vez (la transferencia).
  for (const row of transfers.rows) {
    if (row.direction !== 'to_store') continue;
    const id = Number(row.product_id);
    entriesByProduct.set(id, (entriesByProduct.get(id) || 0) + Number(row.quantity));
  }
  for (const row of transfers.rows) add(row.product_id, (row.direction === 'to_warehouse' ? -1 : 1) * Number(row.quantity));
  for (const row of countsToday.rows) {
    const id = Number(row.product_id);
    if (row.initial_difference != null) add(id, Number(row.initial_difference));
    else if (legacyCorrectionProductIds.has(id)) ambiguousLegacyProducts.add(id);
    else add(id, Number(row.difference) || 0);
  }

  return {
    date,
    products: products.map((product) => {
      const tracked = Number(product.track_stock) === 1;
      const createdAtMs = timestampMs(product.created_at);
      const createdToday = createdAtMs != null && createdAtMs >= startMs && createdAtMs < endMs;
      const current = Number(product.stock) || 0;
      const rawOpening = Math.round((current - (delta.get(Number(product.id)) || 0)) * 1000) / 1000;
      const ambiguousLegacy = ambiguousLegacyProducts.has(Number(product.id));
      const ambiguousWeightedSale = ambiguousLegacyWeightedProducts.has(Number(product.id));
      const invalidNegativeOpening = rawOpening < 0;
      const openingReason = ambiguousLegacy
        ? 'Conteo histórico corregido sin diferencia inicial persistida'
        : ambiguousWeightedSale ? 'Venta por peso histórica sin stock_delta; pudo aplicarse el límite de stock cero'
        : invalidNegativeOpening ? 'La reconstrucción produce un stock inicial negativo' : null;
      return {
        id: Number(product.id),
        opening_stock: !tracked ? null : createdToday ? 0 : openingReason ? null : rawOpening,
        entries_stock: tracked ? round3(entriesByProduct.get(Number(product.id)) || 0) : 0,
        current_stock: tracked ? current : 0,
        tracked,
        ...(tracked && openingReason && !createdToday ? { opening_stock_reason: openingReason } : {}),
      };
    }),
  };
}

module.exports = { dailyStock };
