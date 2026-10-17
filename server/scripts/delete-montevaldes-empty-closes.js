#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const OWNER_ID = 10;
const EMAIL = 'montevaldes@aldia.cu';
const STORE_NAME = 'Monte Valdes';
const KEEP = { id: 5, closed_at: '2026-10-15 03:05:20' };
const REMOVE = [
  { id: 6, closed_at: '2026-10-15 03:06:42' },
  { id: 7, closed_at: '2026-10-15 03:08:05' },
];
const TARGET_IDS = [KEEP.id, ...REMOVE.map((row) => row.id)];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

const stringify = (value, space) => JSON.stringify(stable(value), null, space);
const stateHash = (state) => crypto.createHash('sha256').update(stringify(state)).digest('hex');
const rows = async (tx, sql, args = []) => (await tx.execute({ sql, args })).rows;

async function tableExists(tx, name) {
  return (await rows(tx, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0;
}

async function collect(tx) {
  const accounts = await rows(tx,
    'SELECT id, email, store_name, owner_id, role FROM users WHERE lower(trim(email)) = lower(trim(?))', [EMAIL]);
  const account = accounts.length === 1 ? accounts[0] : null;
  const shopUserId = account ? Number(account.owner_id || account.id) : null;
  const allCloses = shopUserId == null ? [] : await rows(tx,
    'SELECT * FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC, id DESC', [shopUserId]);
  const closes = allCloses.filter((close) => TARGET_IDS.includes(Number(close.id)));
  const references = {};
  for (const table of ['sales', 'currency_purchases', 'cash_withdrawals', 'sale_corrections']) {
    references[table] = await rows(tx,
      `SELECT id, cash_close_id FROM ${table} WHERE cash_close_id IN (?, ?) ORDER BY id`,
      REMOVE.map((close) => close.id));
  }
  const correctionsExist = await tableExists(tx, 'cash_close_corrections');
  const corrections = correctionsExist ? await rows(tx,
    'SELECT * FROM cash_close_corrections WHERE cash_close_id IN (?, ?, ?) ORDER BY cash_close_id, correction_revision, id', TARGET_IDS) : [];
  const state = {
    account_count: accounts.length, account, shop_user_id: shopUserId,
    store_close_count: allCloses.length,
    all_close_ids: allCloses.map((close) => Number(close.id)).sort((a, b) => a - b),
    closes, references, cash_close_corrections_table_exists: correctionsExist,
    cash_close_corrections: corrections,
  };
  return { state, allCloses };
}

function blockers({ state, allCloses }) {
  const found = [];
  if (state.account_count !== 1) found.push(`email_match_count=${state.account_count}`);
  if (state.account && Number(state.account.id) !== OWNER_ID) found.push(`owner_id=${state.account.id}`);
  if (state.account && state.account.store_name !== STORE_NAME) found.push(`store_name=${state.account.store_name}`);
  if (state.shop_user_id !== OWNER_ID) found.push(`shop_user_id=${state.shop_user_id}`);
  for (const expected of [KEEP, ...REMOVE]) {
    const close = state.closes.find((row) => Number(row.id) === expected.id);
    if (!close) found.push(`missing_close_${expected.id}`);
    else if (String(close.closed_at) !== expected.closed_at) found.push(`timestamp_mismatch_close_${expected.id}`);
  }
  const ids = allCloses.map((row) => Number(row.id)).sort((a, b) => a - b);
  if (ids.length !== 3 || ids.some((id, index) => id !== [5, 6, 7][index])) {
    found.push(`unexpected_store_close_set=${ids.join(',')}`);
  }
  for (const [table, refs] of Object.entries(state.references)) {
    if (refs.length) found.push(`${table}_references=${refs.length}`);
  }
  if (state.cash_close_corrections.length) found.push(`cash_close_corrections=${state.cash_close_corrections.length}`);
  return found;
}

function auditResult(state, allCloses, blockersList) {
  return {
    mode: 'audit-read-only', account: state.account, shop_user_id: state.shop_user_id,
    store_close_count: state.store_close_count, requested_closes: state.closes,
    references_to_delete: state.references,
    cash_close_corrections_table_exists: state.cash_close_corrections_table_exists,
    cash_close_corrections: state.cash_close_corrections,
    other_close_ids: allCloses.map((row) => Number(row.id)).filter((id) => !TARGET_IDS.includes(id)),
    blockers: blockersList, audit_hash: stateHash(state),
  };
}

async function writeBackup(dir, state, auditHash) {
  const absoluteDir = path.resolve(dir);
  await fs.mkdir(absoluteDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(absoluteDir, `montevaldes-cash-closes-${stamp}-${process.pid}.json`);
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${stringify({
      backed_up_at: new Date().toISOString(), audit_hash: auditHash,
      account: state.account, shop_user_id: state.shop_user_id,
      closes: state.closes, cash_close_corrections: state.cash_close_corrections,
    }, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await fs.chmod(file, 0o600);
  return file;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const audit = process.argv.includes('--audit');
  const expectedHash = arg('--expect-hash');
  const backupDir = arg('--backup-dir');
  const allowed = new Set(['--audit', '--apply', '--expect-hash', '--backup-dir']);
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i];
    if (!allowed.has(name)) throw new Error(`Argumento no reconocido: ${name}`);
    if (name === '--expect-hash' || name === '--backup-dir') i++;
  }
  if (apply && audit) throw new Error('Usa --audit o --apply, no ambos.');
  if (apply && (!expectedHash || !backupDir)) throw new Error('Apply requiere --expect-hash HASH y --backup-dir RUTA.');

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !/^(libsql|https?):\/\//i.test(url) || !authToken) {
    throw new Error('Se requiere TURSO_DATABASE_URL remota y TURSO_AUTH_TOKEN en server/.env.');
  }

  const client = createClient({ url, authToken });
  let tx;
  try {
    tx = await client.transaction(apply ? 'write' : 'read');
    const snapshot = await collect(tx);
    const { state, allCloses } = snapshot;
    const auditHash = stateHash(state);
    if (!apply) {
      const report = auditResult(state, allCloses, blockers(snapshot));
      await tx.commit();
      tx = null;
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    if (auditHash !== expectedHash) throw new Error(`Snapshot cambió; audit_hash actual=${auditHash}`);

    const targetsAbsent = REMOVE.every(({ id }) => !state.closes.some((row) => Number(row.id) === id));
    const keptOnly = allCloses.length === 1 && Number(allCloses[0].id) === KEEP.id
      && String(allCloses[0].closed_at) === KEEP.closed_at;
    if (targetsAbsent && keptOnly) {
      const refsExist = Object.values(state.references).some((refs) => refs.length);
      if (refsExist || state.cash_close_corrections.length) {
        throw new Error('Los cierres ya no están, pero existen referencias o auditoría asociadas; no se modifica nada.');
      }
      await tx.commit();
      tx = null;
      process.stdout.write(`${JSON.stringify({ mode: 'apply-idempotent', deleted: [], remaining_close_id: KEEP.id, mutation: false, audit_hash: auditHash }, null, 2)}\n`);
      return;
    }

    const blocked = blockers(snapshot);
    if (blocked.length) throw new Error(`Guardas impiden borrar: ${blocked.join('; ')}`);

    const backupPath = await writeBackup(backupDir, state, auditHash);
    const result = await tx.execute({
      sql: `DELETE FROM cash_closes WHERE user_id = ? AND id IN (?, ?)
              AND ((id = ? AND closed_at = ?) OR (id = ? AND closed_at = ?))`,
      args: [OWNER_ID, REMOVE[0].id, REMOVE[1].id,
        REMOVE[0].id, REMOVE[0].closed_at, REMOVE[1].id, REMOVE[1].closed_at],
    });
    if (Number(result.rowsAffected) !== 2) throw new Error(`Se esperaban 2 filas borradas; rowsAffected=${result.rowsAffected}`);

    const after = await rows(tx,
      'SELECT * FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC, id DESC', [OWNER_ID]);
    const preserved = after.find((row) => Number(row.id) === KEEP.id);
    const original = state.closes.find((row) => Number(row.id) === KEEP.id);
    if (after.length !== 1 || !preserved || stringify(preserved) !== stringify(original)) {
      throw new Error('Verificación fallida: cierre #5 cambió o no quedó exactamente un cierre.');
    }
    const remainingTargets = await rows(tx,
      'SELECT id FROM cash_closes WHERE user_id = ? AND id IN (?, ?)', [OWNER_ID, REMOVE[0].id, REMOVE[1].id]);
    if (remainingTargets.length) throw new Error('Verificación fallida: queda algún cierre objetivo.');
    for (const table of ['sales', 'currency_purchases', 'cash_withdrawals', 'sale_corrections']) {
      const refs = await rows(tx, `SELECT id FROM ${table} WHERE cash_close_id IN (?, ?) LIMIT 1`, REMOVE.map((row) => row.id));
      if (refs.length) throw new Error(`Verificación fallida: referencias posteriores en ${table}.`);
    }

    await tx.commit();
    tx = null;
    process.stdout.write(`${JSON.stringify({ mode: 'apply', deleted: [6, 7], remaining_close_id: 5,
      before: { store_close_count: state.store_close_count, close_ids: state.all_close_ids },
      after: { store_close_count: after.length, close_ids: after.map((row) => Number(row.id)) },
      preserved_close_unchanged: true,
      backup_path: backupPath, backup_mode: '0600',
      backup_summary: { close_ids: TARGET_IDS, cash_close_corrections: state.cash_close_corrections.length },
      audit_hash: auditHash }, null, 2)}\n`);
  } finally {
    if (tx) await tx.rollback().catch(() => {});
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
