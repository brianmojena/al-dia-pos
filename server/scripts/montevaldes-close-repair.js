#!/usr/bin/env node
'use strict';

// Auditoría puntual y reparación con precondiciones para el último cierre de
// una tienda. La ejecución normal es exclusivamente de lectura. Nunca inicia
// el servidor ni usa la base SQLite local.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');
const { paymentSplit, purchaseSplit, withdrawalSplit, round2 } = require('../lib/payment');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const STORE_NAME = 'Montevaldes';
const closeFields = [
  'id', 'client_close_id', 'opened_at', 'closed_at', 'opening_float', 'expected_cash',
  'counted_cash', 'difference', 'expected_transfer', 'sales_count', 'expected_usd',
  'counted_usd', 'difference_usd', 'expected_eur', 'counted_eur', 'difference_eur',
  'withdrawn_cash', 'withdrawn_transfer', 'withdrawn_usd', 'withdrawn_eur',
  'register_id', 'account_id', 'account_email', 'corrected_at', 'original_expected_cash',
  'original_difference', 'note',
];
const amountFields = [
  'opening_float', 'expected_cash', 'counted_cash', 'difference', 'expected_transfer',
  'sales_count', 'expected_usd', 'counted_usd', 'difference_usd', 'expected_eur',
  'counted_eur', 'difference_eur', 'withdrawn_cash', 'withdrawn_transfer',
  'withdrawn_usd', 'withdrawn_eur',
];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sameAmount(left, right) {
  return Math.abs(round2(left) - round2(right)) < 0.005;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rowsSum(rows, splitter, key) {
  return rows.reduce((sum, row) => sum + splitter(row)[key], 0);
}

function sortIds(rows) {
  return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

function publicRows(rows) {
  return rows.map((row) => ({
    id: Number(row.id),
    client_id: row.client_sale_id ?? row.client_purchase_id ?? row.client_withdrawal_id ?? null,
    created_at: row.created_at,
    total: row.total == null ? undefined : safeNumber(row.total),
    payment_method: row.payment_method ?? row.method ?? null,
    amount: row.amount == null ? undefined : safeNumber(row.amount),
    foreign_currency: row.foreign_currency ?? null,
    foreign_amount: row.foreign_amount == null ? undefined : safeNumber(row.foreign_amount),
    cup_amount: row.cup_amount == null ? undefined : safeNumber(row.cup_amount),
    exchange_rate: row.exchange_rate == null ? undefined : safeNumber(row.exchange_rate),
    cash_close_id: row.cash_close_id == null ? null : Number(row.cash_close_id),
  }));
}

async function query(tx, sql, args = []) {
  return (await tx.execute({ sql, args })).rows;
}

async function buildPlan(tx) {
  const owners = await query(tx,
    'SELECT id, email, store_name FROM users WHERE lower(trim(store_name)) = lower(trim(?)) ORDER BY id',
    [STORE_NAME]);
  if (owners.length !== 1) {
    throw new Error(owners.length === 0
      ? `No existe una tienda con nombre exacto ${STORE_NAME}.`
      : `El nombre ${STORE_NAME} coincide con ${owners.length} tiendas; se requiere identificar la cuenta sin ambigüedad.`);
  }
  const owner = owners[0];
  const closes = await query(tx,
    `SELECT ${closeFields.join(', ')} FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC, id DESC`,
    [owner.id]);
  if (!closes.length) throw new Error('Montevaldes no tiene cierres de caja registrados.');
  const close = closes[0];
  if (!close.closed_at || !Number.isInteger(Number(close.id))) throw new Error('El último cierre no tiene una fecha o ID válidos.');

  const accountRows = close.account_id == null
    ? []
    : await query(tx, 'SELECT id, email, owner_id FROM users WHERE id = ?', [close.account_id]);
  const actor = accountRows[0] || null;
  const actorIsOwner = Number(close.account_id) === Number(owner.id)
    || (close.account_id == null && close.account_email && close.account_email.toLowerCase() === owner.email.toLowerCase());
  const actorEmail = close.account_email || actor?.email || null;
  const blockers = [];
  if (!actorIsOwner && !actorEmail) blockers.push('el cierre no tiene autor suficiente para aplicar el alcance original');
  if (actor && Number(actor.owner_id) !== Number(owner.id) && Number(actor.id) !== Number(owner.id)) {
    blockers.push('el autor registrado no pertenece a Montevaldes');
  }
  if (close.corrected_at) blockers.push('el cierre tiene una corrección posterior registrada');
  if (close.corrected_at == null && close.original_difference != null) {
    blockers.push('el cierre tiene original_difference sin corrected_at; requiere revisión manual');
  }

  const priorClose = closes.find((row) => Number(row.id) !== Number(close.id)
    && String(row.closed_at) <= String(close.closed_at)
    && (close.register_id == null ? row.register_id == null : row.register_id === close.register_id)) || null;

  const cashierScope = actorIsOwner ? '' : ` AND (account_id = ? OR
    (account_id IS NULL AND account_email = ?))`;
  const registerScope = actorIsOwner || close.register_id == null ? '' : ' AND (register_id = ? OR register_id IS NULL)';
  const scopeArgs = [owner.id];
  if (!actorIsOwner) scopeArgs.push(close.account_id, actorEmail);
  if (!actorIsOwner && close.register_id != null) scopeArgs.push(close.register_id);
  const baseSales = `SELECT id, client_sale_id, total, payment_method, transfer_amount,
      foreign_currency, foreign_amount, exchange_rate, shop_rate, created_at, register_id,
      account_id, account_email, cash_close_id FROM sales WHERE user_id = ?`;
  const basePurchases = `SELECT id, client_purchase_id, foreign_currency, foreign_amount,
      exchange_rate, cup_amount, created_at, register_id, account_id, account_email,
      cash_close_id FROM currency_purchases WHERE user_id = ?`;

  const coveredSales = await query(tx, `${baseSales} AND cash_close_id = ? ORDER BY id`, [owner.id, close.id]);
  const coveredPurchases = await query(tx, `${basePurchases} AND cash_close_id = ? ORDER BY id`, [owner.id, close.id]);
  const coveredWithdrawals = await query(tx,
    `SELECT id, client_withdrawal_id, method, amount, created_at, cash_close_id, voided_at
       FROM cash_withdrawals WHERE user_id = ? AND cash_close_id = ? ORDER BY id`, [owner.id, close.id]);

  const cutoff = String(close.closed_at);
  const candidateArgs = [...scopeArgs, cutoff];
  const candidateSales = await query(tx,
    `${baseSales} AND cash_close_id IS NULL${cashierScope}${registerScope} AND created_at < ? ORDER BY id`, candidateArgs);
  const cutoffSales = await query(tx,
    `${baseSales} AND cash_close_id IS NULL${cashierScope}${registerScope} AND created_at = ? ORDER BY id`, candidateArgs);
  const candidatePurchases = await query(tx,
    `${basePurchases} AND cash_close_id IS NULL${cashierScope}${registerScope} AND created_at < ? ORDER BY id`, candidateArgs);
  const cutoffPurchases = await query(tx,
    `${basePurchases} AND cash_close_id IS NULL${cashierScope}${registerScope} AND created_at = ? ORDER BY id`, candidateArgs);
  // Contrato documentado: las extracciones son globales y entran al siguiente
  // cierre de tienda, aunque las haya registrado otro usuario/dispositivo.
  const candidateWithdrawals = await query(tx,
    `SELECT id, client_withdrawal_id, method, amount, created_at, cash_close_id, voided_at
       FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL
         AND voided_at IS NULL AND created_at < ? ORDER BY id`, [owner.id, cutoff]);
  const cutoffWithdrawals = await query(tx,
    `SELECT id, client_withdrawal_id, method, amount, created_at, cash_close_id, voided_at
       FROM cash_withdrawals WHERE user_id = ? AND cash_close_id IS NULL
         AND voided_at IS NULL AND created_at = ? ORDER BY id`, [owner.id, cutoff]);

  const afterCutoffCovered = [
    ...coveredSales.filter((row) => String(row.created_at) > cutoff).map((row) => ({ type: 'sale', id: Number(row.id), created_at: row.created_at })),
    ...coveredPurchases.filter((row) => String(row.created_at) > cutoff).map((row) => ({ type: 'purchase', id: Number(row.id), created_at: row.created_at })),
    ...coveredWithdrawals.filter((row) => !row.voided_at && String(row.created_at) > cutoff).map((row) => ({ type: 'withdrawal', id: Number(row.id), created_at: row.created_at })),
  ];
  if (afterCutoffCovered.length) blockers.push('hay movimientos posteriores al cierre ya vinculados a este cierre');
  if (cutoffSales.length || cutoffPurchases.length || cutoffWithdrawals.length) {
    blockers.push('hay movimientos con la misma marca de tiempo del cierre; el orden dentro del segundo es ambiguo');
  }

  const corrections = await query(tx,
    `SELECT id, sale_id, client_sale_id, action, created_at, cash_close_id
       FROM sale_corrections WHERE user_id = ? AND cash_close_id = ? ORDER BY id`, [owner.id, close.id]);
  if (corrections.length) blockers.push('existen correcciones de ventas asociadas al cierre');

  const sales = [...coveredSales, ...candidateSales];
  const purchases = [...coveredPurchases, ...candidatePurchases];
  const withdrawals = [...coveredWithdrawals, ...candidateWithdrawals].filter((row) => !row.voided_at);
  const expected = {
    expected_cash: round2(safeNumber(close.opening_float) + rowsSum(sales, paymentSplit, 'cash')
      + rowsSum(purchases, purchaseSplit, 'cash') + rowsSum(withdrawals, withdrawalSplit, 'cash')),
    expected_transfer: round2(rowsSum(sales, paymentSplit, 'transfer')
      + rowsSum(purchases, purchaseSplit, 'transfer') + rowsSum(withdrawals, withdrawalSplit, 'transfer')),
    expected_usd: round2(rowsSum(sales, paymentSplit, 'usd')
      + rowsSum(purchases, purchaseSplit, 'usd') + rowsSum(withdrawals, withdrawalSplit, 'usd')),
    expected_eur: round2(rowsSum(sales, paymentSplit, 'eur')
      + rowsSum(purchases, purchaseSplit, 'eur') + rowsSum(withdrawals, withdrawalSplit, 'eur')),
    difference: round2(safeNumber(close.counted_cash) - (safeNumber(close.opening_float)
      + rowsSum(sales, paymentSplit, 'cash') + rowsSum(purchases, purchaseSplit, 'cash')
      + rowsSum(withdrawals, withdrawalSplit, 'cash'))),
    difference_usd: round2(safeNumber(close.counted_usd) - rowsSum(sales, paymentSplit, 'usd')
      - rowsSum(purchases, purchaseSplit, 'usd') - rowsSum(withdrawals, withdrawalSplit, 'usd')),
    difference_eur: round2(safeNumber(close.counted_eur) - rowsSum(sales, paymentSplit, 'eur')
      - rowsSum(purchases, purchaseSplit, 'eur') - rowsSum(withdrawals, withdrawalSplit, 'eur')),
    sales_count: sales.length,
    withdrawn_cash: round2(withdrawals.reduce((sum, row) => sum + (row.method === 'efectivo' ? safeNumber(row.amount) : 0), 0)),
    withdrawn_transfer: round2(withdrawals.reduce((sum, row) => sum + (row.method === 'transferencia' ? safeNumber(row.amount) : 0), 0)),
    withdrawn_usd: round2(withdrawals.reduce((sum, row) => sum + (row.method === 'USD' ? safeNumber(row.amount) : 0), 0)),
    withdrawn_eur: round2(withdrawals.reduce((sum, row) => sum + (row.method === 'EUR' ? safeNumber(row.amount) : 0), 0)),
  };
  const recorded = Object.fromEntries(amountFields.map((key) => [key, safeNumber(close[key])]));
  const changes = Object.fromEntries(Object.entries(expected)
    .filter(([key, value]) => !sameAmount(recorded[key], value))
    .map(([key, value]) => [key, { recorded: recorded[key], calculated: value }]));

  const rawState = {
    owner: { id: Number(owner.id), store_name: owner.store_name },
    close,
    priorClose,
    coveredSales, coveredPurchases, coveredWithdrawals,
    candidateSales, candidatePurchases, candidateWithdrawals,
    cutoffSales, cutoffPurchases, cutoffWithdrawals,
    corrections,
  };
  const auditHash = stableHash(rawState);
  return {
    owner, close, priorClose, actorIsOwner, actorEmail,
    coveredSales, coveredPurchases, coveredWithdrawals,
    candidateSales, candidatePurchases, candidateWithdrawals,
    cutoffSales, cutoffPurchases, cutoffWithdrawals,
    corrections, afterCutoffCovered, blockers,
    recorded, expected, changes, auditHash, rawState,
  };
}

function present(plan) {
  const { close, priorClose, expected, recorded, changes } = plan;
  return {
    mode: 'audit-only',
    store: plan.owner.store_name,
    owner_id: Number(plan.owner.id),
    close: {
      id: Number(close.id), client_close_id: close.client_close_id,
      opened_at: close.opened_at, closed_at: close.closed_at,
      register_id: close.register_id, account_id: close.account_id,
      opening_float: safeNumber(close.opening_float), counted_cash: safeNumber(close.counted_cash),
      expected_cash_recorded: safeNumber(close.expected_cash), difference_recorded: safeNumber(close.difference),
    },
    prior_close: priorClose ? { id: Number(priorClose.id), closed_at: priorClose.closed_at, register_id: priorClose.register_id } : null,
    covered_counts: { sales: plan.coveredSales.length, purchases: plan.coveredPurchases.length, withdrawals: plan.coveredWithdrawals.filter((row) => !row.voided_at).length },
    candidate_counts_before_cutoff: { sales: plan.candidateSales.length, purchases: plan.candidatePurchases.length, global_withdrawals: plan.candidateWithdrawals.length },
    candidate_sales: publicRows(plan.candidateSales),
    candidate_purchases: publicRows(plan.candidatePurchases),
    candidate_global_withdrawals: publicRows(plan.candidateWithdrawals),
    ambiguous_same_timestamp_counts: { sales: plan.cutoffSales.length, purchases: plan.cutoffPurchases.length, global_withdrawals: plan.cutoffWithdrawals.length },
    already_covered_after_cutoff: plan.afterCutoffCovered,
    corrections_linked_to_close: plan.corrections.length,
    calculated_from_covered_plus_candidates: expected,
    recorded_amounts: recorded,
    amount_differences: changes,
    blockers: plan.blockers,
    audit_hash: plan.auditHash,
  };
}

function backupDocument(plan) {
  return {
    format: 'montevaldes-cash-close-repair-backup-v1',
    created_at: new Date().toISOString(),
    store_name: plan.owner.store_name,
    owner_id: Number(plan.owner.id),
    close_id: Number(plan.close.id),
    audit_hash: plan.auditHash,
    close_before: plan.close,
    prior_close: plan.priorClose,
    covered_sales_before: plan.coveredSales,
    covered_purchases_before: plan.coveredPurchases,
    covered_withdrawals_before: plan.coveredWithdrawals,
    candidate_sales_to_attach: plan.candidateSales,
    candidate_purchases_to_attach: plan.candidatePurchases,
    candidate_withdrawals_to_attach: plan.candidateWithdrawals,
    ambiguous_timestamp_rows: {
      sales: plan.cutoffSales, purchases: plan.cutoffPurchases, withdrawals: plan.cutoffWithdrawals,
    },
    corrections: plan.corrections,
    calculated_values: plan.expected,
    recorded_values: plan.recorded,
  };
}

async function run() {
  const apply = process.argv.includes('--apply');
  const expectedHash = argValue('--expect-audit-hash');
  const databaseUrl = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!databaseUrl || !authToken) throw new Error('Faltan variables Turso requeridas; no se abrió ninguna conexión.');
  if (!/^libsql:\/\//i.test(databaseUrl)) throw new Error('Se rechazó la URL: este script solo permite el endpoint remoto Turso libsql://.');
  if (apply && !expectedHash) throw new Error('La opción --apply requiere --expect-audit-hash obtenido de una auditoría revisada.');
  if (apply && argValue('--store') !== STORE_NAME) throw new Error(`La opción --apply requiere --store ${STORE_NAME}.`);

  const client = createClient({ url: databaseUrl, authToken });
  let tx;
  try {
    tx = await client.transaction(apply ? 'write' : 'read');
    const plan = await buildPlan(tx);
    const report = present(plan);
    if (!apply) {
      console.log(JSON.stringify(report, null, 2));
      await tx.commit();
      return;
    }
    if (plan.auditHash !== expectedHash) throw new Error('La base cambió desde la auditoría revisada; no se aplicó ninguna reparación. Ejecuta --audit otra vez.');
    if (plan.blockers.length) throw new Error(`Reparación bloqueada: ${plan.blockers.join('; ')}`);
    if (Number(argValue('--close-id')) !== Number(plan.close.id)) throw new Error('El --close-id no coincide con el último cierre auditado.');

    const backupDirectory = path.resolve(__dirname, '../audit-backups');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory,
      `montevaldes-close-${plan.close.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const backupFd = fs.openSync(backupPath, 'wx', 0o600);
    try { fs.writeFileSync(backupFd, `${JSON.stringify(backupDocument(plan), null, 2)}\n`); }
    finally { fs.closeSync(backupFd); }

    for (const [table, rows] of [
      ['sales', plan.candidateSales],
      ['currency_purchases', plan.candidatePurchases],
      ['cash_withdrawals', plan.candidateWithdrawals],
    ]) {
      for (const row of rows) {
        const guard = table === 'cash_withdrawals'
          ? 'AND cash_close_id IS NULL AND voided_at IS NULL'
          : 'AND cash_close_id IS NULL';
        const result = await tx.execute({
          sql: `UPDATE ${table} SET cash_close_id = ? WHERE user_id = ? AND id = ? ${guard}`,
          args: [plan.close.id, plan.owner.id, row.id],
        });
        if (Number(result.rowsAffected) !== 1) throw new Error(`Cambió el movimiento ${table}#${row.id}; se revierte toda la transacción.`);
      }
    }

    const values = plan.expected;
    const updated = await tx.execute({
      sql: `UPDATE cash_closes SET expected_cash = ?, difference = ?, expected_transfer = ?,
              sales_count = ?, expected_usd = ?, difference_usd = ?, expected_eur = ?,
              difference_eur = ?, withdrawn_cash = ?, withdrawn_transfer = ?,
              withdrawn_usd = ?, withdrawn_eur = ?
            WHERE user_id = ? AND id = ? AND closed_at = ? AND opening_float = ? AND counted_cash = ?`,
      args: [values.expected_cash, values.difference, values.expected_transfer,
        values.sales_count, values.expected_usd, values.difference_usd,
        values.expected_eur, values.difference_eur, values.withdrawn_cash,
        values.withdrawn_transfer, values.withdrawn_usd, values.withdrawn_eur,
        plan.owner.id, plan.close.id, plan.close.closed_at,
        plan.close.opening_float, plan.close.counted_cash],
    });
    if (Number(updated.rowsAffected) !== 1) throw new Error('El cierre dejó de coincidir con sus guardas; se revierte toda la transacción.');

    const verified = await buildPlan(tx);
    if (verified.blockers.length || Object.keys(verified.changes).length) {
      throw new Error('La verificación posterior no coincide con el cálculo esperado; se revierte toda la transacción.');
    }
    await tx.commit();
    console.log(JSON.stringify({
      mode: 'applied', store: plan.owner.store_name, close_id: Number(plan.close.id),
      backup_path: backupPath, audit_hash: plan.auditHash,
      preserved: { counted_cash: plan.close.counted_cash, opening_float: plan.close.opening_float,
        opened_at: plan.close.opened_at, closed_at: plan.close.closed_at },
      attached: { sales: sortIds(plan.candidateSales), purchases: sortIds(plan.candidatePurchases), global_withdrawals: sortIds(plan.candidateWithdrawals) },
      verified_values: values,
    }, null, 2));
  } catch (error) {
    if (tx) await tx.rollback().catch(() => {});
    throw error;
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  // Errores de conexión pueden traer detalles internos; no mostrar URL/token.
  const message = String(error?.message || 'Error desconocido').replace(/(?:libsql:\/\/|https?:\/\/)[^\s]+/gi, '[endpoint]');
  console.error(`Auditoría/reparación detenida: ${message}`);
  process.exitCode = 1;
});
