#!/usr/bin/env node
'use strict';

// Respalda y borra por completo una cuenta de dueño con sus cajeros y datos.
// Uso: node scripts/delete-account.js --email dueño@tienda.cu
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
};
const inList = (ids) => `(${ids.map(Number).join(',')})`;

async function main() {
  const email = option('--email');
  if (!email) throw new Error('Uso: node scripts/delete-account.js --email cuenta@tienda.cu');
  const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const tx = await client.transaction('write');
  try {
    const rows = async (sql) => (await tx.execute(sql)).rows.map((r) => ({ ...r }));
    const owner = (await tx.execute({ sql: "SELECT id, owner_id FROM users WHERE lower(trim(email)) = lower(trim(?))", args: [email] })).rows;
    if (owner.length !== 1) throw new Error('La cuenta no existe o el email es ambiguo.');
    if (owner[0].owner_id != null) throw new Error('Es una cuenta de cajero, no de dueño.');
    const ownerId = Number(owner[0].id);
    const ids = [ownerId, ...(await rows(`SELECT id FROM users WHERE owner_id = ${ownerId}`)).map((r) => Number(r.id))];

    const tables = (await rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('sqlite_sequence','schema_migrations')")).map((r) => r.name);
    const withUserId = [];
    for (const t of tables) {
      const cols = (await rows(`PRAGMA table_info(${t})`)).map((c) => c.name);
      if (cols.includes('user_id') && t !== 'users') withUserId.push(t);
    }

    const saleIds = (await rows(`SELECT id FROM sales WHERE user_id IN ${inList(ids)}`)).map((r) => Number(r.id));
    const countIds = (await rows(`SELECT id FROM inventory_counts WHERE user_id IN ${inList(ids)}`)).map((r) => Number(r.id));
    const deviceIds = (await rows(`SELECT id FROM shared_devices WHERE owner_id IN ${inList(ids)}`)).map((r) => r.id);
    const quoted = deviceIds.map((d) => `'${String(d).replace(/'/g, "''")}'`);

    const plan = [
      ['sale_items', saleIds.length ? `sale_id IN ${inList(saleIds)}` : null],
      ['inventory_count_items', countIds.length ? `count_id IN ${inList(countIds)}` : null],
      ['account_devices', `account_id IN ${inList(ids)}`],
      ['shared_device_cashiers', `account_id IN ${inList(ids)}${quoted.length ? ` OR device_id IN (${quoted.join(',')})` : ''}`],
      ...withUserId.map((t) => [t, `user_id IN ${inList(ids)}`]),
      ['shared_devices', `owner_id IN ${inList(ids)}`],
      ['users', `id IN ${inList(ids)}`],
    ].filter(([, where]) => where);

    const usersBefore = Number((await rows('SELECT count(*) n FROM users'))[0].n);
    const backup = { email, ownerId, userIds: ids, takenAt: new Date().toISOString(), tables: {} };
    for (const [t, where] of plan) backup.tables[t] = await rows(`SELECT * FROM ${t} WHERE ${where}`);

    const dir = path.resolve(__dirname, '../audit-backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `account-${email.split('@')[0]}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(backup));
    console.log('Respaldo:', file);

    for (const [t, where] of plan) {
      const res = await tx.execute(`DELETE FROM ${t} WHERE ${where}`);
      if (res.rowsAffected) console.log(`borradas ${res.rowsAffected} de ${t}`);
    }
    for (const [t, where] of plan) {
      const left = Number((await rows(`SELECT count(*) n FROM ${t} WHERE ${where}`))[0].n);
      if (left) throw new Error(`Quedaron ${left} filas en ${t}`);
    }
    const usersAfter = Number((await rows('SELECT count(*) n FROM users'))[0].n);
    if (usersBefore - usersAfter !== ids.length) throw new Error('Se borró un número inesperado de usuarios.');
    await tx.commit();
    console.log('Listo. Usuarios:', usersBefore, '->', usersAfter);
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

main().catch((error) => { console.error('ERROR:', error.message); process.exit(1); });
