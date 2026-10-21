const { resolveRegisterId } = require('./register');
const { registerOf } = require('./sharedDevices');
const { dailyStock } = require('./dailyStock');

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_MAX_BYTES = 2 * 1024 * 1024;

const CURSOR_PARAMS = {
  sale: 'after_sale',
  close: 'after_close',
  count: 'after_count',
  purchase: 'after_purchase',
  withdrawal: 'after_withdrawal',
  correction: 'after_correction',
  close_correction: 'after_close_correction',
};

const intParam = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

const dateParam = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replace('T', ' ') : null;
};

const query = async (tx, sql, args = []) => (await tx.execute({ sql, args })).rows;

const inClause = (values) => values.map(() => '?').join(',');

const groupItems = (rows, key, itemKey) => {
  const grouped = new Map();
  for (const item of rows) {
    const owner = Number(item[itemKey]);
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(item);
  }
  return (sale) => grouped.get(Number(sale[key])) || [];
};

const byteSize = (value) => Buffer.byteLength(JSON.stringify(value));

// Recorta la respuesta por bytes sin romper los cursores. Cada tabla que
// devolvió exactamente `limit` filas puede tener más: el cursor queda en la
// última fila incluida y la página siguiente continúa desde ahí.
function trimToBudget(payload, order, maxBytes) {
  const trimmed = new Set();
  let total = byteSize(payload);
  const sizes = new Map();
  for (const key of order) {
    if (!Array.isArray(payload[key]) || payload[key].length === 0) continue;
    sizes.set(key, payload[key].map((row) => byteSize(row)));
  }
  while (total > maxBytes) {
    let candidate = null;
    for (const key of order) {
      const rows = payload[key];
      if (!Array.isArray(rows) || rows.length <= 1) continue;
      const size = sizes.get(key).reduce((n, value) => n + value, 0);
      if (!candidate || size > candidate.size) candidate = { key, size };
    }
    if (!candidate) break;
    const key = candidate.key;
    const rowSize = sizes.get(key).pop();
    payload[key].pop();
    total -= rowSize + 1;
    trimmed.add(key);
  }
  return trimmed;
}

function cursorsFor(rows, previous) {
  return rows.length ? Number(rows[rows.length - 1].id) : previous;
}

async function coverageFor(tx, req, closeIds) {
  const covered = { sales: new Map(), purchases: new Map(), withdrawals: new Map() };
  if (closeIds.length === 0) return covered;
  const marks = inClause(closeIds);
  for (const [table, map] of [
    ['sales', covered.sales],
    ['currency_purchases', covered.purchases],
    ['cash_withdrawals', covered.withdrawals],
  ]) {
    const rows = await query(tx,
      `SELECT id, cash_close_id FROM ${table} WHERE user_id = ? AND cash_close_id IN (${marks})`,
      [req.userId, ...closeIds]);
    for (const row of rows) {
      const key = Number(row.cash_close_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(Number(row.id));
    }
  }
  return covered;
}

function withCoverage(closes, covered) {
  return closes.map((close) => ({
    ...close,
    covered_sale_ids: covered.sales.get(Number(close.id)) || [],
    covered_purchase_ids: covered.purchases.get(Number(close.id)) || [],
    covered_withdrawal_ids: covered.withdrawals.get(Number(close.id)) || [],
  }));
}

async function currentPeriod(tx, req, register, extraScope, scopeArgs) {
  const userId = req.userId;
  const first = async (table) => (await query(tx,
    `SELECT created_at FROM ${table}
      WHERE user_id = ? AND cash_close_id IS NULL AND (register_id = ? OR register_id IS NULL)${extraScope}
      ORDER BY created_at LIMIT 1`,
    [userId, register, ...scopeArgs]))[0];
  const openSale = await first('sales');
  const openPurchase = await first('currency_purchases');
  const openWithdrawal = (await query(tx,
    'SELECT created_at FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL ORDER BY created_at LIMIT 1',
    [userId]))[0];
  const last = (await query(tx,
    'SELECT closed_at FROM cash_closes WHERE user_id = ? AND register_id = ? ORDER BY closed_at DESC LIMIT 1',
    [userId, register]))[0];
  return {
    opened_at: last?.closed_at || openSale?.created_at || openPurchase?.created_at || openWithdrawal?.created_at || null,
    has_sales: !!(openSale || openPurchase || openWithdrawal),
    is_first_close: !last,
  };
}

async function sharedPeriods(tx, req, device) {
  const members = await query(tx,
    'SELECT account_id FROM shared_device_cashiers WHERE device_id = ? AND active = 1', [device.id]);
  const periods = {};
  for (const member of members) {
    const register = registerOf(device, member.account_id);
    const scope = '(register_id = ? OR register_id LIKE ?)';
    const first = async (table) => (await query(tx,
      `SELECT created_at FROM ${table}
        WHERE user_id = ? AND cash_close_id IS NULL AND ${scope}
        ORDER BY created_at LIMIT 1`,
      [req.userId, register, `shared:${device.id}:%`]))[0];
    const openSale = await first('sales');
    const openPurchase = await first('currency_purchases');
    const openWithdrawal = (await query(tx,
      'SELECT created_at FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL ORDER BY created_at LIMIT 1',
      [req.userId]))[0];
    const last = (await query(tx,
      'SELECT closed_at FROM cash_closes WHERE user_id = ? AND register_id = ? ORDER BY closed_at DESC LIMIT 1',
      [req.userId, register]))[0];
    periods[register] = {
      register_id: register,
      opened_at: last?.closed_at || openSale?.created_at || openPurchase?.created_at || openWithdrawal?.created_at || null,
      has_sales: !!(openSale || openPurchase || openWithdrawal),
      is_first_close: !last,
    };
  }
  return periods;
}

function parseCorrection(row, { owner, cashierProjection }) {
  let sale = null;
  if (row._sale) sale = cashierProjection ? cashierProjection(row._sale) : row._sale;
  delete row._sale;
  let cashClose = null;
  if (row.close_after) {
    try {
      cashClose = { ...JSON.parse(row.close_after), id: Number(row.cash_close_id) };
    } catch { cashClose = null; }
  }
  const base = owner
    ? row
    : {
      id: row.id,
      action: row.action,
      sale_id: row.sale_id,
      client_sale_id: row.client_sale_id,
      cash_close_id: row.cash_close_id,
      created_at: row.created_at,
    };
  return { ...base, sale, cash_close: cashClose };
}

function cashierSaleProjection(sale) {
  const { id, client_sale_id, total, payment_method, transfer_amount, foreign_currency,
    foreign_amount, exchange_rate, shop_rate, created_at, register_id, account_id,
    account_email, cash_close_id } = sale;
  return { id, client_sale_id, total, payment_method, transfer_amount, foreign_currency,
    foreign_amount, exchange_rate, shop_rate, created_at, register_id, account_id,
    account_email, cash_close_id };
}

/**
 * Página de sincronización para la PWA. Extiende el snapshot con cursores y
 * presupuesto de bytes para que el arranque no dependa del tamaño del
 * historial. Sin parámetros, /snapshot conserva su comportamiento anterior.
 */
async function syncChanges(tx, req) {
  const limit = Math.min(intParam(req.query.limit, DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
  const maxBytes = Math.min(intParam(req.query.max_bytes, DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const cursors = {};
  for (const [key, param] of Object.entries(CURSOR_PARAMS)) cursors[key] = intParam(req.query[param]);
  const historyFrom = dateParam(req.query.history_from);
  const historyTo = dateParam(req.query.history_until) || (historyFrom ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null);
  const since = historyFrom ? null : dateParam(req.query.since);
  const history = historyFrom ? { from: historyFrom, to: historyTo } : null;
  // En la carga inicial acotada se conservan siempre las filas abiertas: son
  // las que participan del arqueo y no deben quedar fuera por ser antiguas.
  const windowFilter = (column, openColumn = null) => {
    if (history) return { sql: ` AND datetime(${column}) >= datetime(?) AND datetime(${column}) < datetime(?)`, args: [history.from, history.to] };
    if (since) return openColumn
      ? { sql: ` AND (datetime(${column}) >= datetime(?) OR ${openColumn} IS NULL)`, args: [since] }
      : { sql: ` AND datetime(${column}) >= datetime(?)`, args: [since] };
    return { sql: '', args: [] };
  };
  const owner = req.role === 'dueño';
  const shared = req.sharedDevice;
  const cashier = !owner && !shared;
  const register = resolveRegisterId(req, 'web');
  const cashierScope = cashier
    ? ' AND (account_id = ? OR (account_id IS NULL AND account_email = (SELECT email FROM users WHERE id = ?)))'
    : '';
  const cashierArgs = cashier ? [req.accountId, req.accountId] : [];

  let products = [];
  if (!history) {
    if (shared) {
      products = (await query(tx, 'SELECT * FROM products WHERE user_id = ? ORDER BY name', [req.userId]))
        .map(({ purchase_price, ...product }) => product);
    } else {
      products = await query(tx, 'SELECT * FROM products WHERE user_id = ? ORDER BY name', [req.userId]);
    }
  }

  let sales = [];
  const saleWindow = windowFilter('created_at', 'cash_close_id');
  if (shared) {
    const scope = [req.userId, `shared:${shared.id}`, `shared:${shared.id}:%`, cursors.sale, ...saleWindow.args, limit];
    sales = await query(tx,
      `SELECT id, client_sale_id, total, payment_method, transfer_amount, foreign_currency,
              foreign_amount, exchange_rate, shop_rate, created_at, register_id,
              account_id, account_email, cash_close_id
        FROM sales WHERE user_id = ? AND (register_id = ? OR register_id LIKE ?)
          AND id > ?${saleWindow.sql} ORDER BY id ASC LIMIT ?`, scope);
  } else if (cashier) {
    sales = await query(tx,
      `SELECT id, client_sale_id, total, payment_method, transfer_amount, foreign_currency,
              foreign_amount, exchange_rate, shop_rate, created_at, register_id,
              account_id, account_email, cash_close_id
        FROM sales WHERE user_id = ? AND id > ?${saleWindow.sql}${cashierScope}
        ORDER BY id ASC LIMIT ?`, [req.userId, cursors.sale, ...saleWindow.args, ...cashierArgs, limit]);
  } else {
    sales = await query(tx,
      `SELECT * FROM sales WHERE user_id = ? AND id > ?${saleWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, cursors.sale, ...saleWindow.args, limit]);
  }
  if (sales.length) {
    const marks = inClause(sales.map((sale) => Number(sale.id)));
    const items = shared || cashier
      ? await query(tx,
        `SELECT i.id, i.sale_id, i.product_id, i.product_name, i.quantity, i.unit_price,
                i.pack_size, p.unit
          FROM sale_items i LEFT JOIN products p ON p.id = i.product_id
          WHERE i.sale_id IN (${marks}) ORDER BY i.id`, sales.map((sale) => Number(sale.id)))
      : await query(tx,
        `SELECT i.* FROM sale_items i JOIN sales s ON s.id = i.sale_id
          WHERE s.user_id = ? AND i.sale_id IN (${marks}) ORDER BY i.id`,
        [req.userId, ...sales.map((sale) => Number(sale.id))]);
    const itemsFor = groupItems(items, 'id', 'sale_id');
    sales = sales.map((sale) => ({ ...sale, items: itemsFor(sale) }));
  }

  let closes;
  const closeWindow = windowFilter('closed_at');
  if (cashier) {
    closes = await query(tx,
      `SELECT id, client_close_id, opened_at, closed_at, opening_float,
              expected_cash, counted_cash, difference, expected_transfer,
              sales_count, note, register_id, account_id, account_email,
              expected_usd, counted_usd, difference_usd, expected_eur,
              counted_eur, difference_eur, withdrawn_cash, withdrawn_transfer,
              withdrawn_usd, withdrawn_eur, correction_revision
        FROM cash_closes WHERE user_id = ? AND id > ?${closeWindow.sql}${cashierScope}
        ORDER BY id ASC LIMIT ?`, [req.userId, cursors.close, ...closeWindow.args, ...cashierArgs, limit]);
  } else if (shared) {
    closes = await query(tx,
      `SELECT * FROM cash_closes WHERE user_id = ? AND (register_id = ? OR register_id LIKE ?)
        AND id > ?${closeWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, `shared:${shared.id}`, `shared:${shared.id}:%`, cursors.close, ...closeWindow.args, limit]);
  } else {
    closes = await query(tx,
      `SELECT * FROM cash_closes WHERE user_id = ? AND id > ?${closeWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, cursors.close, ...closeWindow.args, limit]);
  }
  const covered = await coverageFor(tx, req, closes.map((close) => Number(close.id)));
  closes = withCoverage(closes, covered);

  let counts = [];
  let countItems = [];
  if (owner) {
    const countWindow = windowFilter('counted_at');
    counts = await query(tx,
      `SELECT * FROM inventory_counts WHERE user_id = ? AND id > ?${countWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, cursors.count, ...countWindow.args, limit]);
    if (counts.length) {
      countItems = await query(tx,
        `SELECT i.* FROM inventory_count_items i JOIN inventory_counts c ON c.id = i.count_id
          WHERE c.user_id = ? AND i.count_id IN (${inClause(counts.map((c) => Number(c.id)))}) ORDER BY i.id`,
        [req.userId, ...counts.map((c) => Number(c.id))]);
      const itemsFor = groupItems(countItems, 'id', 'count_id');
      counts = counts.map((count) => ({ ...count, items: itemsFor(count) }));
    }
  }

  let purchases = [];
  const purchaseWindow = windowFilter('created_at', 'cash_close_id');
  if (shared) {
    purchases = await query(tx,
      `SELECT * FROM currency_purchases WHERE user_id = ? AND (register_id = ? OR register_id LIKE ?)
        AND id > ?${purchaseWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, `shared:${shared.id}`, `shared:${shared.id}:%`, cursors.purchase, ...purchaseWindow.args, limit]);
  } else if (cashier) {
    // Sin ventana solo llegan las abiertas; las cerradas van en la cobertura.
    const open = history || since ? '' : ' AND cash_close_id IS NULL';
    purchases = await query(tx,
      `SELECT id, client_purchase_id, foreign_currency, foreign_amount, exchange_rate,
              cup_amount, created_at, register_id, account_id, account_email, cash_close_id
        FROM currency_purchases WHERE user_id = ?${open}
          AND (register_id = ? OR register_id IS NULL)${purchaseWindow.sql}${cashierScope}
          AND id > ? ORDER BY id ASC LIMIT ?`,
      [req.userId, register, ...purchaseWindow.args, ...cashierArgs, cursors.purchase, limit]);
  } else {
    purchases = await query(tx,
      `SELECT * FROM currency_purchases WHERE user_id = ? AND id > ?${purchaseWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, cursors.purchase, ...purchaseWindow.args, limit]);
  }

  // Extracciones: el dueño recibe también el historial nuevo; cajero y caja
  // compartida solo necesitan las abiertas (las cerradas llegan por cobertura).
  let withdrawals;
  const withdrawalWindow = windowFilter('created_at', 'cash_close_id');
  if (owner) {
    withdrawals = await query(tx,
      `SELECT * FROM cash_withdrawals WHERE user_id = ? AND id > ?${withdrawalWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, cursors.withdrawal, ...withdrawalWindow.args, limit]);
  } else {
    const open = history || since ? '' : ' AND cash_close_id IS NULL';
    withdrawals = await query(tx,
      `SELECT id, client_withdrawal_id, method, amount, created_at, cash_close_id, voided_at
        FROM cash_withdrawals WHERE user_id = ?${open} AND id > ?${withdrawalWindow.sql}
        ORDER BY id ASC LIMIT ?`, [req.userId, cursors.withdrawal, ...withdrawalWindow.args, limit]);
  }
  const reminders = history ? [] : await query(tx,
    `SELECT ${owner ? '*' : 'id, client_withdrawal_id, method, amount, created_at, cash_close_id, voided_at'}
      FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND id <= ?
      ORDER BY id DESC LIMIT 200`, [req.userId, cursors.withdrawal]);
  const newWithdrawals = withdrawals.length;
  const withdrawalMap = new Map();
  for (const row of withdrawals) withdrawalMap.set(Number(row.id), row);
  for (const row of reminders) if (!withdrawalMap.has(Number(row.id))) withdrawalMap.set(Number(row.id), row);
  withdrawals = [...withdrawalMap.values()].sort((a, b) => Number(a.id) - Number(b.id));

  let corrections = [];
  const correctionWindow = windowFilter('created_at');
  if (owner) {
    corrections = await query(tx,
      `SELECT * FROM sale_corrections WHERE user_id = ? AND id > ?${correctionWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, cursors.correction, ...correctionWindow.args, limit]);
  } else {
    const saleScope = shared
      ? "(json_extract(before, '$.register_id') = ? OR json_extract(before, '$.register_id') LIKE ?)"
      : "(json_extract(before, '$.account_id') = ? OR (json_extract(before, '$.account_id') IS NULL AND json_extract(before, '$.account_email') = (SELECT email FROM users WHERE id = ?)))";
    const args = shared
      ? [req.userId, cursors.correction, `shared:${shared.id}`, `shared:${shared.id}:%`, ...correctionWindow.args, limit]
      : [req.userId, cursors.correction, req.accountId, req.accountId, ...correctionWindow.args, limit];
    corrections = await query(tx,
      `SELECT id, action, sale_id, client_sale_id, cash_close_id, created_at, before, close_after
        FROM sale_corrections WHERE user_id = ? AND id > ? AND ${saleScope}${correctionWindow.sql}
        ORDER BY id ASC LIMIT ?`, args);
  }
  if (corrections.length) {
    const ids = [...new Set(corrections.map((row) => Number(row.sale_id)))];
    const saleRows = ids.length
      ? await query(tx, `SELECT * FROM sales WHERE user_id = ? AND id IN (${inClause(ids)})`, [req.userId, ...ids])
      : [];
    const byId = new Map(saleRows.map((row) => [Number(row.id), row]));
    corrections = corrections.map((row) => parseCorrection(
      { ...row, _sale: byId.get(Number(row.sale_id)) || null },
      { owner, cashierProjection: cashierSaleProjection },
    ));
  }

  let closeCorrections = [];
  const closeCorrectionWindow = windowFilter('created_at');
  if (owner) {
    closeCorrections = await query(tx,
      `SELECT * FROM cash_close_corrections WHERE user_id = ? AND id > ?${closeCorrectionWindow.sql} ORDER BY id ASC LIMIT ?`,
      [req.userId, cursors.close_correction, ...closeCorrectionWindow.args, limit]);
  } else {
    const closeScope = shared
      ? 'SELECT id FROM cash_closes WHERE user_id = ? AND (register_id = ? OR register_id LIKE ?)'
      : `SELECT id FROM cash_closes WHERE user_id = ?${cashierScope}`;
    const args = shared
      ? [req.userId, cursors.close_correction, req.userId, `shared:${shared.id}`, `shared:${shared.id}:%`, ...closeCorrectionWindow.args, limit]
      : [req.userId, cursors.close_correction, req.userId, ...cashierArgs, ...closeCorrectionWindow.args, limit];
    closeCorrections = await query(tx,
      `SELECT id, cash_close_id, correction_revision, account_id, account_email,
              before, after, created_at
        FROM cash_close_corrections WHERE user_id = ? AND id > ?
          AND cash_close_id IN (${closeScope})${closeCorrectionWindow.sql}
        ORDER BY id ASC LIMIT ?`, args);
  }
  if (closeCorrections.length) {
    const ids = [...new Set(closeCorrections.map((row) => Number(row.cash_close_id)))];
    const closeRows = ids.length
      ? await query(tx, `SELECT * FROM cash_closes WHERE user_id = ? AND id IN (${inClause(ids)})`, [req.userId, ...ids])
      : [];
    const byId = new Map(closeRows.map((row) => [Number(row.id), row]));
    closeCorrections = closeCorrections.map((row) => {
      let corrected = byId.get(Number(row.cash_close_id)) || null;
      if (corrected && cashier) corrected = { ...corrected };
      return { ...row, cash_close: corrected };
    });
  }

  let rejectedSales;
  let cashiers;
  let daily;
  if (owner) {
    rejectedSales = (await query(tx,
      'SELECT * FROM rejected_sales WHERE user_id = ? AND reviewed_at IS NULL ORDER BY id', [req.userId]))
      .map((sale) => ({ ...sale, items: JSON.parse(sale.items || '[]') }));
    cashiers = await query(tx,
      'SELECT id, email, created_at FROM users WHERE owner_id = ? ORDER BY created_at', [req.userId]);
    daily = await dailyStock(tx, req.userId);
  }

  const payload = {
    products,
    sales,
    cash_closes: closes,
    currency_purchases: purchases,
    cash_withdrawals: withdrawals,
    sale_corrections: corrections,
    cash_close_corrections: closeCorrections,
    cash_close_coverage_version: 1,
  };
  if (history) {
    payload.history = history;
  } else if (owner) {
    payload.inventory_counts = counts;
    payload.rejected_sales = rejectedSales;
    payload.cashiers = cashiers;
    payload.daily_stock = daily;
    payload.current_period = await currentPeriod(tx, req, register, '', []);
  } else if (cashier) {
    payload.current_period = await currentPeriod(tx, req, register, cashierScope, cashierArgs);
  } else {
    const periods = await sharedPeriods(tx, req, shared);
    payload.shared_device = shared;
    payload.current_periods = periods;
    payload.current_period = periods[registerOf(shared, req.accountId)];
  }

  const buildCursors = () => ({
    sale: cursorsFor(sales, cursors.sale),
    close: cursorsFor(closes, cursors.close),
    count: cursorsFor(counts, cursors.count),
    purchase: cursorsFor(purchases, cursors.purchase),
    withdrawal: cursorsFor(withdrawals.filter((row) => Number(row.id) > cursors.withdrawal), cursors.withdrawal),
    correction: cursorsFor(corrections, cursors.correction),
    close_correction: cursorsFor(closeCorrections, cursors.close_correction),
  });
  const buildHasMore = (trimmed) => sales.length === limit || closes.length === limit || counts.length === limit
    || purchases.length === limit || newWithdrawals === limit
    || corrections.length === limit || closeCorrections.length === limit
    || trimmed.size > 0;

  // El presupuesto incluye también cursores y bandera; si no, una página justa
  // se pasa por unas decenas de bytes al añadir la metadata.
  payload.cursors = buildCursors();
  payload.has_more = true;
  let trimmed = trimToBudget(payload, [
    'sales', 'cash_closes', 'inventory_counts', 'currency_purchases',
    'cash_withdrawals', 'sale_corrections', 'cash_close_corrections',
  ], maxBytes);
  payload.cursors = buildCursors();
  payload.has_more = buildHasMore(trimmed);
  if (byteSize(payload) > maxBytes) {
    trimmed = trimToBudget(payload, [
      'sales', 'cash_closes', 'inventory_counts', 'currency_purchases',
      'cash_withdrawals', 'sale_corrections', 'cash_close_corrections',
    ], maxBytes);
    payload.cursors = buildCursors();
    payload.has_more = buildHasMore(trimmed);
  }
  return payload;
}

const isPaginated = (queryParams) => Object.keys(CURSOR_PARAMS).some((key) => CURSOR_PARAMS[key] in queryParams)
  || 'limit' in queryParams || 'max_bytes' in queryParams || 'since' in queryParams
  || 'history_from' in queryParams || 'history_until' in queryParams;

module.exports = { syncChanges, isPaginated };
