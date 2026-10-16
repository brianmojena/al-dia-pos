const { businessToday } = require('./businessDay');
const HAVANA = 'America/Havana';

function validDayStock(value) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && Array.isArray(value.products)
    && value.products.every((product) => Number.isFinite(Number(product.id))
      && Number.isFinite(Number(product.current_stock))
      && typeof product.tracked === 'boolean'
      && (product.opening_stock === null || Number.isFinite(Number(product.opening_stock)))));
}

function createdBusinessDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let timestamp = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(timestamp)) {
    timestamp = `${timestamp.replace(' ', 'T')}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(timestamp)) {
    timestamp += 'Z';
  }
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HAVANA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/** Current stock always comes from the local product row, which already
 * reflects this register's completed sales, counts, entries and corrections.
 * The server snapshot is used only for the opening and tracking flag. */
function withDayStock(snapshot, products, date = businessToday(HAVANA)) {
  const hasSnapshotForToday = validDayStock(snapshot) && snapshot.date === date;
  const byServerId = hasSnapshotForToday
    ? new Map(snapshot.products.map((row) => [Number(row.id), row]))
    : new Map();

  return {
    date,
    products: products.map((product) => {
      const remote = hasSnapshotForToday && product.server_id != null
        ? byServerId.get(Number(product.server_id))
        : null;
      const createdToday = createdBusinessDate(product.created_at) === date;
      return {
        id: product.id,
        opening_stock: remote
          ? remote.opening_stock
          : product.server_id == null && createdToday ? 0 : null,
        current_stock: Number(product.stock),
        tracked: remote ? remote.tracked : !product.unit || Number(product.track_stock ?? 1) === 1,
      };
    }),
  };
}

module.exports = { validDayStock, createdBusinessDate, withDayStock };
