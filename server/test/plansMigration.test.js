const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { migratePlans } = require('../db/migrate');

/**
 * Migración de planes ('premium'/'dev' → 'basic'/'enterprise') sobre una base
 * con el esquema viejo, tal como está hoy la de producción. Se prueba contra
 * una base local temporal: reconstruye users, mapea los planes acordados y
 * conserva cuentas e hijas.
 */

// DDL equivalente al de producción antes de esta migración: CHECK viejo en
// users y tablas hijas con FK a users (products, sales).
const OLD_SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    store_name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'dev' CHECK (plan IN ('premium', 'dev')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    transfer_limit REAL,
    usd_rate REAL,
    role TEXT NOT NULL DEFAULT 'dueño',
    owner_id INTEGER REFERENCES users(id),
    eur_rate REAL,
    warehouse_enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    purchase_price REAL NOT NULL DEFAULT 0,
    sale_price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    client_sale_id TEXT,
    total REAL NOT NULL,
    profit REAL NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'efectivo',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`;

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mypimes-plans-'));
  const { createClient } = require('@libsql/client');
  const db = createClient({ url: `file:${path.join(dir, 'old.db')}` });
  return { dir, db };
}

test('migración de planes: mapea Enterprise, conserva cuentas e hijas, es idempotente', async (t) => {
  const { dir, db } = freshDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // Con las FK activas, igual que en producción: la reconstrucción debe
  // sobrevivir con hijas apuntando a users.
  await db.execute('PRAGMA foreign_keys = ON');
  await db.executeMultiple(OLD_SCHEMA);
  await db.executeMultiple(`
    INSERT INTO users (id, email, password_hash, store_name, plan, created_at, role, owner_id) VALUES
      (1,  'demo@mitienda.cu',          'h1', 'Mi Tienda Demo',    'dev',     '2026-08-01 10:00:00', 'dueño',  NULL),
      (5,  'deliciasysabores@aldia.cu', 'h2', 'Delicias y Sabores','premium', '2026-08-10 10:00:00', 'dueño',  NULL),
      (6,  'cajero98@aldia.cu',         'h3', 'Delicias y Sabores','premium', '2026-08-11 10:00:00', 'cajero', 5),
      (10, 'montevaldes@aldia.cu',      'h4', 'Monte Valdes',      'premium', '2026-08-20 10:00:00', 'dueño',  NULL),
      (15, 'gemastore@aldia.cu',        'h5', 'Gema Store',        'premium', '2026-09-01 10:00:00', 'dueño',  NULL);
    INSERT INTO products (id, user_id, name, purchase_price, sale_price, stock) VALUES (1, 5, 'Arroz', 80, 130, 40);
    INSERT INTO sales (id, user_id, total, profit) VALUES (1, 10, 250, 90);
  `);
  // Columnas de confirmación/prueba gratuita añadidas por el código actual:
  // en la base real ya existirían al correr la migración (las agrega initDb en
  // el primer arranque). Gema Store queda pendiente con su prueba a medias:
  // la reconstrucción debe conservar ese estado, no solo el plan.
  await db.executeMultiple(`
    ALTER TABLE users ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE users ADD COLUMN trial_ends_at TEXT;
    UPDATE users SET plan_status = 'pending', trial_ends_at = '2026-10-20T12:30:00.000Z' WHERE id = 15;
  `);

  const backupDir = path.join(dir, 'backups');
  const result = await migratePlans(db, { backupDir });
  assert.equal(result.status, 'migrated');

  const rows = (await db.execute(
    'SELECT id, email, password_hash, store_name, plan, created_at, role, owner_id FROM users ORDER BY id'
  )).rows;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));

  // Mapeo acordado: Delicias y Monte Valdes a Enterprise (cajeros incluidos);
  // el resto — incluida Gema Store, que no entró en el acuerdo — a Basic.
  assert.equal(byId.get(5).plan, 'enterprise');
  assert.equal(byId.get(6).plan, 'enterprise', 'el cajero hereda el plan de su tienda');
  assert.equal(byId.get(10).plan, 'enterprise');
  assert.equal(byId.get(15).plan, 'basic');
  assert.equal(byId.get(1).plan, 'basic');

  // Nada de la fila cambió aparte del plan.
  assert.equal(String(byId.get(6).password_hash), 'h3');
  assert.equal(String(byId.get(5).created_at), '2026-08-10 10:00:00');
  assert.equal(Number(byId.get(6).owner_id), 5);

  // El estado de confirmación/prueba sobrevive la reconstrucción: Gema Store
  // (pendiente) sigue pendiente con su trial; las demás quedan activas.
  const estado = (await db.execute('SELECT id, plan_status, trial_ends_at FROM users ORDER BY id')).rows;
  const estadoById = new Map(estado.map((r) => [Number(r.id), r]));
  assert.equal(String(estadoById.get(15).plan_status), 'pending');
  assert.equal(String(estadoById.get(15).trial_ends_at), '2026-10-20T12:30:00.000Z');
  assert.equal(String(estadoById.get(5).plan_status), 'active');
  assert.equal(estadoById.get(5).trial_ends_at, null);

  // Las hijas quedaron intactas y sus FK siguen resolviendo (JOIN) y
  // restringiendo igual que el esquema original: borrar una cuenta con
  // productos se rechaza, no cascadea.
  assert.equal(Number((await db.execute('SELECT COUNT(*) AS n FROM products')).rows[0].n), 1);
  assert.equal(Number((await db.execute('SELECT COUNT(*) AS n FROM sales')).rows[0].n), 1);
  const join = await db.execute('SELECT u.store_name, s.total FROM sales s JOIN users u ON u.id = s.user_id');
  assert.equal(String(join.rows[0].store_name), 'Monte Valdes');
  await assert.rejects(db.execute('DELETE FROM users WHERE id = 5'), { code: 'SQLITE_CONSTRAINT' });
  assert.equal(Number((await db.execute('SELECT COUNT(*) AS n FROM products WHERE user_id = 5')).rows[0].n), 1);

  // El CHECK reconstruido acepta los planes nuevos y también los viejos:
  // durante el despliegue convive un servidor sin actualizar que aún registra
  // 'premium'/'dev'.
  await db.execute("INSERT INTO users (email, password_hash, store_name, plan) VALUES ('nuevo@test.local', 'x', 'Nueva', 'basic')");
  await db.execute("INSERT INTO users (email, password_hash, store_name, plan) VALUES ('viejo@test.local', 'x', 'Vieja', 'premium')");

  // Copia de seguridad previa, con las cuentas de antes.
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  const backup = JSON.parse(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'));
  assert.equal(backup.users.length, 5);

  // Idempotente: la segunda pasada no toca nada (ni escribe otra copia).
  assert.equal((await migratePlans(db, { backupDir })).status, 'already');
  assert.equal(fs.readdirSync(backupDir).length, 1);
});

test('migración de planes: completa una corrida interrumpida (users_new sin renombrar)', async (t) => {
  const { dir, db } = freshDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // Estado a medias: la transacción llegó a construir users_new y a dropear
  // users, pero no a renombrar (así queda la base si el proceso muere a mitad).
  await db.execute('PRAGMA foreign_keys = OFF');
  await db.executeMultiple(OLD_SCHEMA);
  await db.executeMultiple(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      store_name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'basic' CHECK (plan IN ('basic', 'enterprise', 'premium', 'dev')),
      plan_status TEXT NOT NULL DEFAULT 'active',
      trial_ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      transfer_limit REAL,
      usd_rate REAL,
      eur_rate REAL,
      role TEXT NOT NULL DEFAULT 'dueño',
      owner_id INTEGER REFERENCES users(id),
      warehouse_enabled INTEGER NOT NULL DEFAULT 1
    );
    DROP TABLE users;
    INSERT INTO users_new (id, email, password_hash, store_name, plan)
      VALUES (7, 'x@test.local', 'h', 'Taller', 'enterprise');
  `);

  const result = await migratePlans(db, { backupDir: path.join(dir, 'backups') });
  assert.equal(result.status, 'already');
  const fila = await db.execute('SELECT plan FROM users WHERE id = 7');
  assert.equal(fila.rows[0].plan, 'enterprise');
});

test('migrar el esquema anterior al trial conserva IDs retirados, índices y auditoría', async (t) => {
  const { dir, db } = freshDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await db.executeMultiple(`${OLD_SCHEMA}
    CREATE TABLE account_audit (account_id INTEGER);
    CREATE INDEX idx_users_store ON users(store_name);
    CREATE TRIGGER audit_new_account AFTER INSERT ON users
      BEGIN INSERT INTO account_audit(account_id) VALUES (new.id); END;
    INSERT INTO users (id, email, password_hash, store_name, plan) VALUES
      (1, 'owner@test.local', 'unchanged', 'Tienda', 'premium'),
      (99, 'retired@test.local', 'old', 'Retirada', 'dev');
    DELETE FROM users WHERE id = 99;
  `);
  const originalColumns = (await db.execute('PRAGMA table_info(users)')).rows.map((c) => c.name);
  assert.equal((await migratePlans(db, { backupDir: path.join(dir, 'backups') })).status, 'migrated');
  assert.deepEqual((await db.execute('PRAGMA table_info(users)')).rows.map((c) => c.name), [...originalColumns, 'plan_status', 'trial_ends_at']);
  const owner = (await db.execute('SELECT * FROM users WHERE id = 1')).rows[0];
  assert.equal(owner.password_hash, 'unchanged');
  assert.equal(owner.plan_status, 'active', 'los clientes existentes siguen activos');
  assert.equal(owner.trial_ends_at, null);
  const inserted = await db.execute("INSERT INTO users (email, password_hash, store_name, plan) VALUES ('new@test.local', 'new', 'Nueva', 'enterprise')");
  assert.equal(Number(inserted.lastInsertRowid), 100, 'no se reutiliza un ID de cuenta retirada');
  assert.equal((await db.execute('SELECT account_id FROM account_audit ORDER BY rowid DESC LIMIT 1')).rows[0].account_id, 100);
  assert.equal((await db.execute("SELECT name FROM sqlite_master WHERE name = 'idx_users_store'")).rows.length, 1);
  assert.deepEqual((await db.execute('PRAGMA foreign_key_check')).rows, []);
});

test('la migración se cancela sin perder columnas ajenas al esquema conocido', async (t) => {
  const { dir, db } = freshDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await db.executeMultiple(`${OLD_SCHEMA}
    ALTER TABLE users ADD COLUMN custom_setting TEXT;
    INSERT INTO users (email, password_hash, store_name, plan, custom_setting)
      VALUES ('owner@test.local', 'h', 'Tienda', 'premium', 'conservar');
  `);
  await assert.rejects(migratePlans(db, { backupDir: path.join(dir, 'backups') }), /custom_setting/);
  assert.equal((await db.execute('SELECT custom_setting FROM users')).rows[0].custom_setting, 'conservar');
});
