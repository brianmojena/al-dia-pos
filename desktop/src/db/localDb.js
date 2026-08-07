const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

/**
 * Inicializa (o reabre) la base local. Debe llamarse una vez al arrancar,
 * con una ruta explícita — en la app real es app.getPath('userData'),
 * en scripts de prueba puede ser cualquier archivo temporal.
 */
function initLocalDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Fila única con la sesión activa. Se cachea localmente para que la app
    -- abra sin red; el JWT solo hace falta cuando el sync worker llama al servidor.
    CREATE TABLE IF NOT EXISTS session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      user_id INTEGER,
      email TEXT,
      store_name TEXT,
      plan TEXT,
      token TEXT,
      transfer_limit REAL,
      usd_rate REAL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Espejo local de products. server_id queda NULL hasta que el outbox de
    -- creación de ESTE producto se sincroniza — ver sync/syncWorker.js.
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      name TEXT NOT NULL,
      purchase_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted INTEGER NOT NULL DEFAULT 0
    );

    -- Espejo local de sales. client_sale_id es la MISMA clave de idempotencia
    -- que ya entiende el backend (server/routes/sales.js) — se genera una sola
    -- vez por venta y viaja intacta hasta Turso, sin importar cuántos reintentos.
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      client_sale_id TEXT NOT NULL UNIQUE,
      total REAL NOT NULL,
      profit REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0
    );

    -- La cola de sincronización. Cada fila es UNA operación pendiente de subir.
    -- payload guarda ids LOCALES cuando hace falta (p.ej. product_id de una venta);
    -- el sync worker los traduce a server_id recién al armar el POST.
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_type TEXT NOT NULL,              -- 'product.create' | 'product.update' | 'product.delete' | 'sale.create'
      client_op_id TEXT NOT NULL UNIQUE,
      local_ref_id INTEGER,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | syncing | synced | conflict | failed
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_attempt_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_status  ON outbox(status, id);
    CREATE INDEX IF NOT EXISTS idx_products_server ON products(server_id);
    CREATE INDEX IF NOT EXISTS idx_sales_client_id  ON sales(client_sale_id);
  `);

  // Migración aditiva: instalaciones ya existentes tienen una tabla session
  // creada antes de que transfer_limit/usd_rate existieran — el CREATE TABLE
  // IF NOT EXISTS de arriba no las agrega a una tabla que ya existe.
  for (const sql of [
    'ALTER TABLE session ADD COLUMN transfer_limit REAL',
    'ALTER TABLE session ADD COLUMN usd_rate REAL',
  ]) {
    try { db.exec(sql); } catch (_) { /* la columna ya existe */ }
  }

  return db;
}

function getLocalDb() {
  if (!db) throw new Error('Base local no inicializada — llamá initLocalDb(dbPath) primero.');
  return db;
}

function closeLocalDb() {
  if (db) { db.close(); db = undefined; }
}

module.exports = { initLocalDb, getLocalDb, closeLocalDb };
