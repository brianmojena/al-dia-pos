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
 * The server snapshot is used only for the opening and tracking flag.
 *
 * `localEntries` (optional) adds the merchandise this register received whose
 * entry has not reached the server yet — pending/syncing outbox rows — so the
 * day's entries stay live between sync passes without double counting. */
function withDayStock(snapshot, products, date = businessToday(HAVANA), localEntries = null) {
  const hasSnapshotForToday = validDayStock(snapshot) && snapshot.date === date;
  const byServerId = hasSnapshotForToday
    ? new Map(snapshot.products.map((row) => [Number(row.id), row]))
    : new Map();
  const pendingFor = (id) => {
    if (!localEntries) return 0;
    const value = localEntries instanceof Map ? localEntries.get(Number(id)) : localEntries[Number(id)];
    return Number(value) || 0;
  };

  return {
    date,
    products: products.map((product) => {
      const remote = hasSnapshotForToday && product.server_id != null
        ? byServerId.get(Number(product.server_id))
        : null;
      const tracked = remote ? remote.tracked : !product.unit || Number(product.track_stock ?? 1) === 1;
      const createdToday = createdBusinessDate(product.created_at) === date;
      const pending = pendingFor(product.id);
      const remoteEntries = remote && Number.isFinite(Number(remote.entries_stock)) && Number(remote.entries_stock) >= 0
        ? Number(remote.entries_stock)
        : null;
      let entries;
      if (!tracked) entries = 0;
      else if (remoteEntries != null) entries = round3(remoteEntries + pending);
      else if (product.server_id == null || hasSnapshotForToday) entries = round3(pending);
      else entries = null;
      return {
        id: product.id,
        opening_stock: remote
          ? remote.opening_stock
          : product.server_id == null && createdToday ? 0 : null,
        entries_stock: tracked ? (entries == null ? null : entries) : 0,
        current_stock: Number(product.stock),
        tracked,
      };
    }),
  };
}

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

module.exports = { validDayStock, createdBusinessDate, withDayStock };
