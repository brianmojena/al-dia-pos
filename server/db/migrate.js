// Migraciones one-off sobre bases ya existentes.
//
// Se ejecutan a mano (npm run migrate), NO en cada arranque: SQLite no permite
// alterar un CHECK con ALTER TABLE, hay que reconstruir la tabla, y eso no debe
// pasar dentro del ciclo de vida de una petición serverless.
//
// Son idempotentes: si el cambio ya está aplicado, no hacen nada.
//
// OJO con el destino: el script usa el TURSO_DATABASE_URL del .env, que en este
// repo apunta a la base de PRODUCCIÓN. Contra una base remota exige
// CONFIRM_REMOTE_MIGRATE=1 para seguir.
const fs = require('fs');
const path = require('path');

// Migración one-off: añade CHECK (stock >= 0) a la tabla products ya existente.
// Es idempotente: si el CHECK ya está, no hace nada.
async function migrateProducts(db) {
  const current = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'");
  const ddl = current.rows[0]?.sql || '';

  if (ddl.includes('CHECK (stock >= 0)')) {
    console.log('✓ products ya tiene CHECK (stock >= 0) — nada que migrar');
    return { status: 'already' };
  }

  const negatives = await db.execute('SELECT id, name, stock FROM products WHERE stock < 0');
  if (negatives.rows.length > 0) {
    console.log(`⚠  ${negatives.rows.length} producto(s) con stock negativo; se ajustan a 0:`);
    for (const r of negatives.rows) console.log(`   - ${r.name}: ${r.stock} → 0`);
    await db.execute('UPDATE products SET stock = 0 WHERE stock < 0');
  }

  // Reconstrucción de tabla: crear, copiar, borrar, renombrar. Los índices se
  // pierden al borrar la tabla, así que se recrean al final.
  await db.executeMultiple(`
    PRAGMA foreign_keys=OFF;
    BEGIN;
    CREATE TABLE products_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      purchase_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    INSERT INTO products_new (id, user_id, name, purchase_price, sale_price, stock, created_at)
      SELECT id, user_id, name, purchase_price, sale_price, stock, created_at FROM products;
    DROP TABLE products;
    ALTER TABLE products_new RENAME TO products;
    CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
    COMMIT;
    PRAGMA foreign_keys=ON;
  `);

  const after = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'");
  const ok = (after.rows[0]?.sql || '').includes('CHECK (stock >= 0)');
  const count = await db.execute('SELECT COUNT(*) AS c FROM products');
  console.log(ok
    ? `✓ Migración aplicada: CHECK (stock >= 0) activo, ${count.rows[0].c} productos conservados`
    : '✗ La migración no aplicó el CHECK — revisar manualmente');
  return { status: ok ? 'migrated' : 'failed' };
}

// Migración de planes: 'premium'/'dev' → 'basic'/'enterprise'.
//
// El CHECK viejo está grabado en el DDL de users y SQLite no lo puede alterar
// sin reconstruir la tabla. La reconstrucción acepta ADEMÁS los valores viejos:
// mientras convivan un servidor sin desplegar y esta base, un registro viejo
// ('premium'/'dev') no debe reventar; el código nuevo los trata como Basic.
//
// Delicias y Sabores y Monte Valdes pasan a Enterprise (acuerdo comercial ya
// cerrado, pago en persona); el resto queda en Basic, el plan por defecto.
async function migratePlans(db, { backupDir } = {}) {
  const tables = await db.execute(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('users', 'users_new')"
  );
  const byName = new Map(tables.rows.map((r) => [String(r.name), String(r.sql || '')]));

  // Una corrida anterior pudo quedar entre el DROP de users y el RENAME de
  // users_new. Terminar el renombrado es seguro: users_new ya tiene la tabla
  // nueva completa.
  if (!byName.has('users') && byName.has('users_new')) {
    console.log('⚠  Migración de planes a medias: users_new quedó sin renombrar. Se completa ahora.');
    await db.executeMultiple(`
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_id);
    `);
    byName.set('users', byName.get('users_new'));
    byName.delete('users_new');
  }

  const ddl = byName.get('users') || '';
  if (ddl.includes("'basic'")) {
    console.log('✓ Planes Basic/Enterprise ya aplicados en users — nada que migrar');
    return { status: 'already' };
  }
  if (!ddl.includes("'premium'")) {
    console.log('⚠  users no tiene un CHECK de plan reconocible; no se toca — revisar a mano');
    return { status: 'unknown' };
  }

  const userCols = new Set((await db.execute('PRAGMA table_info(users)')).rows.map((r) => String(r.name)));
  const supportedColumns = new Set([
    'id', 'email', 'password_hash', 'store_name', 'plan', 'created_at', 'transfer_limit',
    'usd_rate', 'eur_rate', 'role', 'owner_id', 'warehouse_enabled', 'plan_status', 'trial_ends_at',
  ]);
  const unknownColumns = [...userCols].filter((name) => !supportedColumns.has(name));
  if (unknownColumns.length) {
    throw new Error(`Migración cancelada: users tiene columnas que deben conservarse: ${unknownColumns.join(', ')}`);
  }
  // No reutilizar IDs de cuentas borradas al reconstruir AUTOINCREMENT: las
  // operaciones históricas siguen conservando el identificador de su autor.
  const sequence = Number((await db.execute("SELECT seq FROM sqlite_sequence WHERE name = 'users'")).rows[0]?.seq || 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Secuencia de users inválida; no se modifica la tabla.');
  const schemaObjects = (await db.execute(
    "SELECT name, sql FROM sqlite_master WHERE tbl_name = 'users' AND type IN ('index', 'trigger') AND sql IS NOT NULL"
  )).rows.filter((row) => row.name !== 'idx_users_owner');
  // Conservar el orden de las columnas previas también evita desalinear la
  // metadata de SELECT * en conexiones que sobreviven durante el despliegue.
  const columnDefinitions = {
    id: 'INTEGER PRIMARY KEY AUTOINCREMENT', email: 'TEXT NOT NULL UNIQUE',
    password_hash: 'TEXT NOT NULL', store_name: 'TEXT NOT NULL',
    plan: "TEXT NOT NULL DEFAULT 'basic' CHECK (plan IN ('basic', 'enterprise', 'premium', 'dev'))",
    created_at: "TEXT NOT NULL DEFAULT (datetime('now'))", transfer_limit: 'REAL',
    usd_rate: 'REAL', eur_rate: 'REAL', role: "TEXT NOT NULL DEFAULT 'dueño'",
    owner_id: 'INTEGER REFERENCES users(id)', warehouse_enabled: 'INTEGER NOT NULL DEFAULT 1',
    plan_status: "TEXT NOT NULL DEFAULT 'active'", trial_ends_at: 'TEXT',
  };
  const columnOrder = [...userCols, ...Object.keys(columnDefinitions).filter((name) => !userCols.has(name))];

  // Copia de seguridad ANTES de tocar nada: si la reconstrucción se corta a
  // medias, esto es lo que permite rehacerla con la mano.
  const before = await db.execute('SELECT * FROM users ORDER BY id');
  const dir = backupDir || path.join(__dirname, '..', 'audit-backups');
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `plans-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupPath, `${JSON.stringify(
    { migrated_at: new Date().toISOString(), users: before.rows },
    (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
    2
  )}\n`, { mode: 0o600 });
  console.log(`   Copia de seguridad de users: ${backupPath}`);

  // La confirmación y la prueba gratuita (plan_status/trial_ends_at) pueden no
  // existir todavía si esta migración corre antes del primer arranque del
  // código nuevo: se rellenan con el valor por defecto en vez de romper el
  // SELECT. Si existen, se conservan tal cual (una tienda pendiente sigue
  // pendiente, con su prueba intacta).
  const planStatusExpr = userCols.has('plan_status') ? 'plan_status' : "'active'";
  const trialExpr = userCols.has('trial_ends_at') ? 'trial_ends_at' : 'NULL';

  await db.executeMultiple(`
    PRAGMA foreign_keys=OFF;
    BEGIN;
    DROP TABLE IF EXISTS users_new;
    CREATE TABLE users_new (
      ${columnOrder.map((name) => `${name} ${columnDefinitions[name]}`).join(',\n      ')}
    );
    INSERT INTO users_new (id, email, password_hash, store_name, plan, plan_status, trial_ends_at, created_at, transfer_limit, usd_rate, eur_rate, role, owner_id, warehouse_enabled)
      SELECT id, email, password_hash, store_name,
        CASE
          WHEN store_name LIKE '%delicia%' THEN 'enterprise'
          WHEN store_name LIKE '%monte%vald_s%' THEN 'enterprise'
          ELSE 'basic'
        END,
        ${planStatusExpr}, ${trialExpr},
        created_at, transfer_limit, usd_rate, eur_rate, role, owner_id, warehouse_enabled
      FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    UPDATE sqlite_sequence SET seq = MAX(seq, ${sequence}) WHERE name = 'users';
    CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_id);
    ${schemaObjects.map((row) => `${row.sql};`).join('\n')}
    COMMIT;
    PRAGMA foreign_keys=ON;
  `);

  const afterCount = await db.execute('SELECT COUNT(*) AS n FROM users');
  if (Number(afterCount.rows[0].n) !== before.rows.length) {
    throw new Error(
      `La reconstrucción de users perdió filas: antes ${before.rows.length}, después ${afterCount.rows[0].n}. ` +
      `La copia está en ${backupPath}.`
    );
  }

  const summary = await db.execute('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan ORDER BY plan');
  const enterprise = await db.execute("SELECT store_name, email FROM users WHERE plan = 'enterprise' ORDER BY id");
  console.log(`✓ Migración de planes aplicada — ${before.rows.length} cuentas conservadas`);
  console.log('  Reparto:', summary.rows.map((r) => `${r.plan}: ${r.n}`).join(' · '));
  for (const r of enterprise.rows) console.log(`   - ${r.store_name} (${r.email}) → Enterprise`);
  return { status: 'migrated' };
}

async function main() {
  require('dotenv').config({ quiet: true });

  // El .env de este repo apunta a producción. Imprimir el destino (sin token)
  // y exigir confirmación explícita para bases remotas evita la migración
  // accidental más caras: la que se corre contra la base "de pruebas" que no lo era.
  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const remote = /^(libsql|https?|wss?):/i.test(rawUrl);
  console.log(`Destino: ${rawUrl ? rawUrl.split('?')[0] : '(sin TURSO_DATABASE_URL — SQLite local de desarrollo)'}`);
  if (remote && process.env.CONFIRM_REMOTE_MIGRATE !== '1') {
    console.error(
      '✗ El destino es una base remota. Revisa que sea la base correcta y repite con:\n' +
      '  CONFIRM_REMOTE_MIGRATE=1 npm run migrate'
    );
    process.exit(1);
  }

  const { getDb, initDb } = require('./database');
  if (process.argv.includes('--plans-only')) {
    await migratePlans(getDb());
    return;
  }
  await initDb();
  const db = getDb();
  await migrateProducts(db);
  await migratePlans(db);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error en la migración:', err);
    process.exit(1);
  });
}

module.exports = { migrateProducts, migratePlans };
