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
      role TEXT,
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

    -- Arqueo de caja hecho en ESTA caja. Se calcula y se guarda entero sin
    -- red: el registro local es la verdad de lo que pasó acá, y el servidor
    -- recibe después una copia para que el dueño la vea desde su teléfono.
    CREATE TABLE IF NOT EXISTS cash_closes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      client_close_id TEXT NOT NULL UNIQUE,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      opening_float REAL NOT NULL DEFAULT 0,
      expected_cash REAL NOT NULL,
      counted_cash REAL NOT NULL,
      difference REAL NOT NULL,
      expected_transfer REAL NOT NULL DEFAULT 0,
      sales_count INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      account_email TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      client_count_id TEXT NOT NULL UNIQUE,
      counted_at TEXT NOT NULL DEFAULT (datetime('now')),
      lines_count INTEGER NOT NULL DEFAULT 0,
      products_with_difference INTEGER NOT NULL DEFAULT 0,
      units_missing INTEGER NOT NULL DEFAULT 0,
      units_extra INTEGER NOT NULL DEFAULT 0,
      value_missing REAL NOT NULL DEFAULT 0,
      note TEXT,
      account_email TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory_count_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL REFERENCES inventory_counts(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      expected INTEGER NOT NULL,
      counted INTEGER NOT NULL,
      difference INTEGER NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0
    );

    -- La cola de sincronización. Cada fila es UNA operación pendiente de subir.
    -- payload guarda ids LOCALES cuando hace falta (p.ej. product_id de una venta);
    -- el sync worker los traduce a server_id recién al armar el POST.
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_type TEXT NOT NULL,              -- 'product.create' | 'product.update' | 'product.delete' | 'sale.create' | 'cash_close.create' | 'inventory_count.create'
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
    CREATE INDEX IF NOT EXISTS idx_cash_closes_closed ON cash_closes(closed_at);
    CREATE INDEX IF NOT EXISTS idx_inv_items_count    ON inventory_count_items(count_id);
  `);

  // Migración aditiva: instalaciones ya existentes tienen una tabla session
  // creada antes de que transfer_limit/usd_rate existieran — el CREATE TABLE
  // IF NOT EXISTS de arriba no las agrega a una tabla que ya existe.
  for (const sql of [
    'ALTER TABLE session ADD COLUMN transfer_limit REAL',
    'ALTER TABLE session ADD COLUMN usd_rate REAL',
    // Mismo caso que las dos de arriba, y el mismo error que costó la 1.0.1:
    // el login SÍ recibe el rol del servidor, pero si la sesión local no tiene
    // dónde guardarlo se descarta antes de tocar disco y /api/auth/me local lo
    // devuelve siempre undefined. Sin esta columna, un cajero que entre en el
    // escritorio vería el panel del dueño.
    'ALTER TABLE session ADD COLUMN role TEXT',
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
