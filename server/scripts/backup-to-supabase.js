#!/usr/bin/env node
'use strict';

// Respaldo completo de Turso a un bucket PRIVADO de Supabase Storage (solo lectura en Turso).
// Variables: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY y,
// opcional, SUPABASE_BACKUP_BUCKET (por defecto "backups"). El archivo lleva hashes de
// contraseña: el bucket nunca debe ser público.
// shortcut: no borra respaldos viejos (≈8/día, ~150 KB comprimidos c/u), limpiar a mano o con una política del bucket.
const path = require('node:path');
const zlib = require('node:zlib');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const BUCKET = process.env.SUPABASE_BACKUP_BUCKET || 'backups';

async function dump(db) {
  const objects = (await db.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name",
  )).rows.map((r) => ({ ...r }));
  const tables = objects.filter((o) => o.type === 'table').map((o) => o.name);
  // Un solo batch de lectura = una instantánea consistente de todas las tablas.
  const results = await db.batch([...tables, 'sqlite_sequence'].map((t) => `SELECT * FROM "${t}"`), 'read');
  const data = {};
  [...tables, 'sqlite_sequence'].forEach((t, i) => { data[t] = results[i].rows.map((r) => ({ ...r })); });
  return { taken_at: new Date().toISOString(), schema: objects, data };
}

async function main() {
  for (const [k, v] of Object.entries({ TURSO_DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
    if (!v) throw new Error(`Falta ${k}`);
  }
  const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  const snapshot = await dump(db);
  const counts = Object.fromEntries(Object.entries(snapshot.data).map(([t, rows]) => [t, rows.length]));
  const body = zlib.gzipSync(JSON.stringify(snapshot));

  const stamp = snapshot.taken_at.replace(/[:.]/g, '-');
  const objectPath = `turso/${stamp.slice(0, 10)}/${stamp}.json.gz`;
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/gzip',
      'x-upsert': 'false',
    },
    body,
  });
  if (!res.ok) throw new Error(`Supabase respondió ${res.status}: ${await res.text()}`);
  console.log(`Respaldo ${BUCKET}/${objectPath} (${body.length} bytes)`, counts);
}

main().catch((err) => { console.error('Falló el respaldo:', err.message); process.exit(1); });
