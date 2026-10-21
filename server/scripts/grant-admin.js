#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const { getDb } = require('../db/database');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

const email = String(arg('--email') || process.argv[2] || '').trim().toLowerCase();
const password = arg('--password') || process.env.ADMIN_PASSWORD || null;
const storeName = arg('--store') || 'Administración';
const revoke = process.argv.includes('--revoke');

async function main() {
  if (!email || !email.includes('@')) {
    console.error('Uso: npm run admin:grant -- <email> [--password <clave>] [--store "<tienda>"] [--revoke]');
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const existing = (await db.execute({
    sql: 'SELECT id, email, is_admin FROM users WHERE lower(email) = ?',
    args: [email],
  })).rows[0];

  if (revoke) {
    if (!existing) {
      console.error(`No existe una cuenta con el correo ${email}.`);
      process.exitCode = 1;
      return;
    }
    await db.execute({ sql: 'UPDATE users SET is_admin = 0 WHERE id = ?', args: [existing.id] });
    console.log(`Administración retirada a ${email} (id ${existing.id}).`);
    return;
  }

  if (existing) {
    await db.execute({ sql: 'UPDATE users SET is_admin = 1 WHERE id = ?', args: [existing.id] });
    console.log(`Administración concedida a ${email} (id ${existing.id}).`);
    return;
  }

  if (!password || password.length < 6) {
    console.error(
      `No existe una cuenta con el correo ${email}. Para crearla, repite el comando con ` +
      '--password <clave de al menos 6 caracteres> (o define ADMIN_PASSWORD).'
    );
    process.exitCode = 1;
    return;
  }

  const insert = await db.execute({
    sql: `INSERT INTO users (email, password_hash, store_name, plan, plan_status, is_admin)
          VALUES (?, ?, ?, 'enterprise', 'active', 1)`,
    args: [email, bcrypt.hashSync(password, 10), storeName],
  });
  console.log(`Cuenta de administración creada: ${email} (id ${Number(insert.lastInsertRowid)}).`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
