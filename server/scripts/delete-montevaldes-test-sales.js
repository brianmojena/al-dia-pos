#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');
const { paymentSplit, purchaseSplit, withdrawalSplit, round2 } = require('../lib/payment');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const OWNER_ID = 10;
const OWNER_EMAIL = 'montevaldes@aldia.cu';
const EXPECTED_CLOSE = { id: 5, closed_at: '2026-10-15 03:05:20' };
const TARGETS = [
  { id: 445, total: 1400 }, { id: 446, total: 60 }, { id: 447, total: 60 },
  { id: 448, total: 390 }, { id: 449, total: 390 }, { id: 450, total: 390 }, { id: 451, total: 390 },
];
const TARGET_IDS = TARGETS.map(({ id }) => id);
const TARGET_CASH = 3080;

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

const stringify = (value, space) => JSON.stringify(stable(value), null, space);
const hashState = (state) => crypto.createHash('sha256').update(stringify(state)).digest('hex');
const rows = async (tx, sql, args = []) => (await tx.execute({ sql, args })).rows;

async function tableExists(tx, table) {
  return (await rows(tx, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])).length > 0;
}

function emptyHoldings() { return { cash: 0, transfer: 0, usd: 0, eur: 0 }; }

function addSplit(target, split) {
  for (const key of Object.keys(target)) target[key] += Number(split[key]) || 0;
}

function roundedHoldings(totals) {
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round2(value)]));
}

async function collect(tx, preserveProductIds = []) {
  const accounts = await rows(tx,
    'SELECT id, email, store_name, owner_id, role FROM users WHERE lower(trim(email)) = lower(trim(?))', [OWNER_EMAIL]);
  const account = accounts.length === 1 ? accounts[0] : null;

  const sales = await rows(tx,
    `SELECT * FROM sales WHERE user_id = ? AND id IN (${TARGET_IDS.map(() => '?').join(',')}) ORDER BY id`,
    [OWNER_ID, ...TARGET_IDS]);
  const saleIds = sales.map((sale) => Number(sale.id));
  const items = saleIds.length
    ? await rows(tx,
      `SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.user_id = ? AND s.id IN (${saleIds.map(() => '?').join(',')}) ORDER BY si.sale_id, si.id`,
      [OWNER_ID, ...saleIds])
    : [];
  const productIds = [...new Set([
    ...items.map((item) => Number(item.product_id)).filter(Number.isSafeInteger),
    ...preserveProductIds.map(Number).filter(Number.isSafeInteger),
  ])];
  const products = productIds.length
    ? await rows(tx,
      `SELECT * FROM products WHERE user_id = ? AND id IN (${productIds.map(() => '?').join(',')}) ORDER BY id`,
      [OWNER_ID, ...productIds])
    : [];

  const allCloses = await rows(tx,
    'SELECT * FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC, id DESC', [OWNER_ID]);
  const correctionsTableExists = await tableExists(tx, 'sale_corrections');
  const targetClientIds = [...new Set(sales.map((sale) => sale.client_sale_id).filter(Boolean))];
  const correctionRefs = [
    ...(saleIds.length ? [`sale_id IN (${saleIds.map(() => '?').join(',')})`] : []),
    ...(targetClientIds.length ? [`client_sale_id IN (${targetClientIds.map(() => '?').join(',')})`] : []),
  ];
  const saleCorrections = correctionsTableExists && correctionRefs.length
    ? await rows(tx,
      `SELECT * FROM sale_corrections WHERE user_id = ? AND (${correctionRefs.join(' OR ')}) ORDER BY id`,
      [OWNER_ID, ...saleIds, ...targetClientIds])
    : [];

  const rejectedTableExists = await tableExists(tx, 'rejected_sales');
  const clientIds = sales.map((sale) => sale.client_sale_id).filter(Boolean);
  const rejectedSales = rejectedTableExists && clientIds.length
    ? await rows(tx,
      `SELECT id, client_sale_id, total, payment_method, sold_at, reported_at
       FROM rejected_sales WHERE user_id = ? AND client_sale_id IN (${clientIds.map(() => '?').join(',')}) ORDER BY id`,
      [OWNER_ID, ...clientIds])
    : [];

  const metrics = {};
  for (const table of ['stock_entries', 'cash_withdrawals', 'cash_closes', 'sale_corrections']) {
    metrics[table] = await tableExists(tx, table)
      ? Number((await rows(tx, `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`, [OWNER_ID]))[0].count)
      : null;
  }

  // This mirrors dashboard.js exactly: open sales + open purchases + active
  // open withdrawals. Neither opening_float nor a close count is added.
  const openSales = await rows(tx,
    `SELECT id, client_sale_id, created_at, payment_method, total, transfer_amount,
            foreign_currency, foreign_amount, exchange_rate, account_email, register_id
     FROM sales WHERE user_id = ? AND cash_close_id IS NULL ORDER BY id`,
    [OWNER_ID]);
  const openPurchases = await rows(tx,
    `SELECT id, client_purchase_id, created_at, foreign_currency, foreign_amount,
            exchange_rate, cup_amount, account_email, register_id
     FROM currency_purchases WHERE user_id = ? AND cash_close_id IS NULL ORDER BY id`,
    [OWNER_ID]);
  const openWithdrawals = await rows(tx,
    `SELECT id, client_withdrawal_id, created_at, method, amount, voided_at, account_email, register_id
     FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL AND voided_at IS NULL ORDER BY id`,
    [OWNER_ID]);
  const holdings = emptyHoldings();
  for (const sale of openSales) addSplit(holdings, paymentSplit(sale));
  for (const purchase of openPurchases) addSplit(holdings, purchaseSplit(purchase));
  for (const withdrawal of openWithdrawals) addSplit(holdings, withdrawalSplit(withdrawal));

  return {
    account_count: accounts.length,
    account,
    sales,
    sale_items: items,
    products,
    closes: allCloses,
    sale_corrections_table_exists: correctionsTableExists,
    sale_corrections: saleCorrections,
    rejected_sales_table_exists: rejectedTableExists,
    matching_rejected_sales: rejectedSales,
    protected_counts: metrics,
    open_movements_snapshot: { sales: openSales, purchases: openPurchases, withdrawals: openWithdrawals },
    open_holdings: roundedHoldings(holdings),
    dashboard_open_sales_count: openSales.length,
    dashboard_open_purchases_count: openPurchases.length,
    dashboard_active_open_withdrawals_count: openWithdrawals.length,
  };
}

function blockers(state) {
  const found = [];
  if (state.account_count !== 1) found.push(`owner_email_match_count=${state.account_count}`);
  if (state.account && Number(state.account.id) !== OWNER_ID) found.push(`owner_id=${state.account.id}`);
  if (state.account && String(state.account.email).trim().toLowerCase() !== OWNER_EMAIL) found.push('owner_email_mismatch');
  if (state.account && (state.account.owner_id != null || state.account.role !== 'dueño')) found.push('account_is_not_owner');
  if (state.sales.length !== TARGETS.length) found.push(`target_sale_count=${state.sales.length},expected=${TARGETS.length}`);

  for (const expected of TARGETS) {
    const sale = state.sales.find((row) => Number(row.id) === expected.id);
    if (!sale) { found.push(`missing_sale_${expected.id}`); continue; }
    if (Number(sale.user_id) !== OWNER_ID) found.push(`sale_${expected.id}_user_mismatch`);
    if (String(sale.account_email || '').trim().toLowerCase() !== OWNER_EMAIL) found.push(`sale_${expected.id}_account_email_mismatch`);
    if (sale.register_id !== `web:${OWNER_ID}`) found.push(`sale_${expected.id}_register_mismatch`);
    if (sale.cash_close_id != null) found.push(`sale_${expected.id}_already_linked_to_close`);
    if (sale.payment_method !== 'efectivo') found.push(`sale_${expected.id}_payment_method_mismatch`);
    if (round2(sale.total) !== expected.total) found.push(`sale_${expected.id}_total_mismatch`);
  }
  const targetCash = state.sales.reduce((sum, sale) => sum + paymentSplit(sale).cash, 0);
  if (round2(targetCash) !== TARGET_CASH) found.push(`target_cash=${round2(targetCash)},expected=${TARGET_CASH}`);

  const closeIds = state.closes.map((close) => Number(close.id));
  if (closeIds.length !== 1 || closeIds[0] !== 5) found.push(`unexpected_close_set=${closeIds.join(',')}`);
  if (state.closes[0] && String(state.closes[0].closed_at) !== EXPECTED_CLOSE.closed_at) found.push('close_5_timestamp_mismatch');
  if (state.sale_corrections.length) found.push(`sale_corrections_for_targets=${state.sale_corrections.length}`);
  if (state.matching_rejected_sales.length) found.push(`matching_rejected_sales=${state.matching_rejected_sales.length}`);

  const productsById = new Set(state.products.map((product) => Number(product.id)));
  const missingProductIds = [...new Set(state.sale_items
    .map((item) => item.product_id == null ? null : Number(item.product_id))
    .filter((id) => id != null && !productsById.has(id)))];
  if (missingProductIds.length) found.push(`missing_or_foreign_product_ids=${missingProductIds.join(',')}`);
  return found;
}

function auditSummary(state, blockersList) {
  return {
    mode: 'audit-read-only',
    owner: state.account,
    targeted_sales: state.sales,
    target_cash: round2(state.sales.reduce((sum, sale) => sum + paymentSplit(sale).cash, 0)),
    sale_items: state.sale_items,
    products: state.products,
    cash_closes: state.closes,
    sale_corrections_for_targets: state.sale_corrections,
    matching_rejected_sales: state.matching_rejected_sales.length,
    holdings_before: state.open_holdings,
    open_movement_counts: {
      sales: state.dashboard_open_sales_count,
      purchases: state.dashboard_open_purchases_count,
      withdrawals: state.dashboard_active_open_withdrawals_count,
    },
    protected_counts_before: state.protected_counts,
    blockers: blockersList,
    audit_hash: hashState(state),
  };
}

async function writeBackup(dir, state, auditHash) {
  const absoluteDir = path.resolve(dir);
  await fs.mkdir(absoluteDir, { recursive: true, mode: 0o700 });
  await fs.chmod(absoluteDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(absoluteDir, `montevaldes-test-sales-${stamp}-${process.pid}.json`);
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${stringify({ backed_up_at: new Date().toISOString(), audit_hash: auditHash, state }, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(file, 0o600);
  return file;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const expectedHash = arg('--expect-hash');
  const backupDir = arg('--backup-dir');
  const allowedFlags = new Set(['--audit', '--apply', '--expect-hash', '--backup-dir']);
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (!allowedFlags.has(flag)) throw new Error(`Argumento no reconocido: ${flag}`);
    if (flag === '--expect-hash' || flag === '--backup-dir') index++;
  }
  if (process.argv.includes('--audit') && apply) throw new Error('Usa --audit o --apply, no ambos.');
  if (apply && (!expectedHash || !backupDir)) throw new Error('Apply requiere --expect-hash HASH y --backup-dir RUTA.');
  if (apply && !/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error('--expect-hash debe ser SHA-256 hexadecimal.');

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch {}
  if (!url || !/^(libsql|https?):\/\//i.test(url) || !authToken
      || ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) {
    throw new Error('Se requiere TURSO_DATABASE_URL remota y TURSO_AUTH_TOKEN en server/.env.');
  }

  const client = createClient({ url, authToken });
  let tx;
  try {
    tx = await client.transaction(apply ? 'write' : 'read');
    const state = await collect(tx);
    const auditHash = hashState(state);
    const blocked = blockers(state);

    if (!apply) {
      await tx.commit();
      tx = null;
      process.stdout.write(`${JSON.stringify(auditSummary(state, blocked), null, 2)}\n`);
      return;
    }

    if (auditHash !== expectedHash) throw new Error(`El estado cambió desde la auditoría; hash actual: ${auditHash}. No se modificó nada.`);
    if (blocked.length) throw new Error(`Guardas impiden borrar: ${blocked.join('; ')}. No se modificó nada.`);

    const beforeClose = state.closes[0];
    const backupPath = await writeBackup(backupDir, state, auditHash);

    const itemDelete = await tx.execute({
      sql: `DELETE FROM sale_items WHERE sale_id IN (
              SELECT id FROM sales WHERE user_id = ? AND id IN (${TARGET_IDS.map(() => '?').join(',')})
            )`,
      args: [OWNER_ID, ...TARGET_IDS],
    });
    const saleDelete = await tx.execute({
      sql: `DELETE FROM sales
            WHERE user_id = ? AND id IN (${TARGET_IDS.map(() => '?').join(',')})
              AND lower(trim(account_email)) = lower(trim(?)) AND register_id = ?
              AND cash_close_id IS NULL AND payment_method = 'efectivo'
              AND (${TARGETS.map(() => '(id = ? AND round(total, 2) = ?)').join(' OR ')})`,
      args: [OWNER_ID, ...TARGET_IDS, OWNER_EMAIL, `web:${OWNER_ID}`,
        ...TARGETS.flatMap(({ id, total }) => [id, total])],
    });
    if (Number(saleDelete.rowsAffected) !== TARGETS.length) {
      throw new Error(`Se esperaban 7 ventas borradas; rowsAffected=${saleDelete.rowsAffected}. Rollback.`);
    }

    const preservedProductIds = state.products.map((product) => Number(product.id));
    const after = await collect(tx, preservedProductIds);
    const remainingSales = after.sales.length;
    if (remainingSales !== 0) throw new Error(`Verificación fallida: quedan ${remainingSales} ventas objetivo. Rollback.`);
    if (after.sale_items.length !== 0) throw new Error(`Verificación fallida: quedan ${after.sale_items.length} artículos objetivo. Rollback.`);
    if (stringify(after.products) !== stringify(state.products)) throw new Error('Verificación fallida: cambió algún producto/stock. Rollback.');
    if (stringify(after.closes) !== stringify(state.closes) || stringify(after.closes[0]) !== stringify(beforeClose)) {
      throw new Error('Verificación fallida: cambió el conjunto o contenido de cierres. Rollback.');
    }
    if (stringify(after.protected_counts) !== stringify(state.protected_counts)) {
      throw new Error('Verificación fallida: cambió el conteo de movimientos protegidos. Rollback.');
    }
    const expectedAfter = { ...state.open_holdings, cash: round2(state.open_holdings.cash - TARGET_CASH) };
    if (stringify(after.open_holdings) !== stringify(expectedAfter)) {
      throw new Error(`Verificación fallida: holdings posteriores inesperados (${stringify(after.open_holdings)}). Rollback.`);
    }
    const expectedOpenMovementRows = {
      sales: state.open_movements_snapshot.sales.filter((sale) => !TARGET_IDS.includes(Number(sale.id))),
      purchases: state.open_movements_snapshot.purchases,
      withdrawals: state.open_movements_snapshot.withdrawals,
    };
    if (stringify(after.open_movements_snapshot) !== stringify(expectedOpenMovementRows)) {
      throw new Error('Verificación fallida: cambió algún movimiento abierto ajeno a las ventas objetivo. Rollback.');
    }

    await tx.commit();
    tx = null;
    process.stdout.write(`${JSON.stringify({
      mode: 'apply',
      deleted_sale_ids: TARGET_IDS,
      deleted_sale_items: Number(itemDelete.rowsAffected),
      cash_removed_from_dashboard_holdings: TARGET_CASH,
      holdings_before: state.open_holdings,
      holdings_after: after.open_holdings,
      products_and_stock_unchanged: true,
      close_5_unchanged: true,
      protected_counts_before: state.protected_counts,
      protected_counts_after: after.protected_counts,
      backup_path: backupPath,
      backup_mode: '0600',
      audit_hash: auditHash,
    }, null, 2)}\n`);
  } finally {
    if (tx) await tx.rollback().catch(() => {});
    await client.close();
  }
}

main().catch((error) => {
  let message = String(error.message || error);
  for (const secret of [process.env.TURSO_AUTH_TOKEN, process.env.TURSO_DATABASE_URL]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
