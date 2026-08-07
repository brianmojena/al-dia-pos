const { createClient } = require('@libsql/client');
const path = require('path');

let client;

// Vercel define VERCEL=1 en todos sus entornos; NODE_ENV=production en el build de producción.
const isServerless = () => process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

function getDb() {
  if (!client) {
    const tursoUrl  = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    // En serverless el disco es efímero: si cayéramos al archivo local, las ventas
    // parecerían guardarse y se perderían al reciclarse la instancia, sin ningún aviso.
    // Preferimos fallar ruidosamente antes que perder datos en silencio.
    if (isServerless()) {
      if (!tursoUrl) {
        throw new Error(
          'TURSO_DATABASE_URL no está configurada. En producción no se puede usar el archivo ' +
          'SQLite local: el disco es efímero y las ventas se perderían sin aviso. ' +
          'Configura la variable de entorno en Vercel antes de desplegar.'
        );
      }
      if (!authToken) {
        throw new Error(
          'TURSO_AUTH_TOKEN no está configurada. Turso remoto requiere autenticación.'
        );
      }
    }

    if (!tursoUrl) {
      console.warn('⚠  TURSO_DATABASE_URL no definida — usando SQLite local (solo desarrollo).');
    }

    const url = tursoUrl || `file:${path.join(__dirname, 'inventory.db')}`;
    client = createClient(authToken ? { url, authToken } : { url });
  }
  return client;
}

async function initDb() {
  const db = getDb();

  try { await db.execute('PRAGMA foreign_keys = ON'); } catch (_) { /* ignorado */ }

  // Esquema para bases nuevas. Para bases ya existentes, las migraciones aditivas de
  // más abajo ponen al día lo que falte. El CHECK de stock sobre una tabla ya creada
  // requiere reconstruirla: eso vive en db/migrate.js (script one-off), no aquí.
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      store_name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'dev' CHECK (plan IN ('premium', 'dev')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      purchase_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_sale_id TEXT,
      total REAL NOT NULL,
      profit REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (sale_id) REFERENCES sales(id)
    );
  `);

  // Migraciones aditivas: seguras de reintentar, fallan si la columna ya existe.
  const addColumns = [
    "ALTER TABLE sales ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'efectivo'",
    'ALTER TABLE products ADD COLUMN user_id INTEGER REFERENCES users(id)',
    'ALTER TABLE sales ADD COLUMN user_id INTEGER REFERENCES users(id)',
    'ALTER TABLE sales ADD COLUMN client_sale_id TEXT',
    // Configuración del negocio, editable por el dueño desde el dashboard móvil.
    // NULL = todavía no la configuró; el dashboard debe tratarlo como "sin límite" /
    // "sin tasa definida" en vez de mostrar 0, que sería engañoso.
    'ALTER TABLE users ADD COLUMN transfer_limit REAL',
    'ALTER TABLE users ADD COLUMN usd_rate REAL',
  ];
  for (const sql of addColumns) {
    try { await db.execute(sql); } catch (_) { /* la columna ya existe */ }
  }

  // El índice UNIQUE es lo que garantiza la idempotencia incluso si dos peticiones
  // idénticas llegan a la vez: la base rechaza la segunda inserción.
  // Parcial (WHERE ... IS NOT NULL) para no afectar a las ventas antiguas sin id de cliente.
  await db.executeMultiple(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_client_sale_id
      ON sales(user_id, client_sale_id) WHERE client_sale_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_sales_user_created ON sales(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_products_user      ON products(user_id);
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);
  `);

  console.log('Base de datos lista');
}

module.exports = { getDb, initDb };
