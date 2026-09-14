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

    -- Ventas cobradas SIN internet que el servidor rechazó al subirlas (casi
    -- siempre: ya no quedaba stock porque otra caja vendió las últimas
    -- unidades). El dinero se cobró, así que no pueden desaparecer: quedan aquí
    -- para que el dueño las vea y decida. No descuentan stock ni entran en el
    -- cierre de caja — por eso ese cierre mostrará un sobrante por el mismo
    -- monto, y esta lista explica de dónde sale.
    CREATE TABLE IF NOT EXISTS rejected_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_sale_id TEXT NOT NULL,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'efectivo',
      items TEXT NOT NULL,
      error TEXT,
      sold_at TEXT,
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      account_id INTEGER,
      account_email TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Arqueo de inventario: lo que el sistema cree que hay en el estante contra
    -- lo que el dueño contó con la mano.
    --
    -- Es el complemento del arqueo de caja, y detecta algo que aquel NO puede
    -- ver: una venta que nunca se registró. Si el producto salió del estante
    -- pero nadie lo cobró en el POS, la caja cuadra perfecta (no hay venta con
    -- la cual comparar el efectivo) y la única huella que queda es la unidad
    -- que falta aquí.
    CREATE TABLE IF NOT EXISTS inventory_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_count_id TEXT,
      counted_at TEXT NOT NULL DEFAULT (datetime('now')),
      lines_count INTEGER NOT NULL DEFAULT 0,
      products_with_difference INTEGER NOT NULL DEFAULT 0,
      units_missing INTEGER NOT NULL DEFAULT 0,
      units_extra INTEGER NOT NULL DEFAULT 0,
      value_missing REAL NOT NULL DEFAULT 0,
      note TEXT,
      account_id INTEGER,
      account_email TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Una línea por producto contado. Guarda el nombre y los precios del
    -- momento: si mañana borran el producto o le cambian el precio, el arqueo
    -- tiene que seguir contando la misma historia.
    CREATE TABLE IF NOT EXISTS inventory_count_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      expected INTEGER NOT NULL,
      counted INTEGER NOT NULL,
      difference INTEGER NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (count_id) REFERENCES inventory_counts(id)
    );

    -- Arqueo de caja: lo que el sistema dice que debería haber contra lo que el
    -- cajero contó de verdad. Los cierres son contiguos — cada uno cubre desde
    -- el corte del anterior — así que ninguna venta queda fuera de un arqueo.
    CREATE TABLE IF NOT EXISTS cash_closes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_close_id TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      opening_float REAL NOT NULL DEFAULT 0,
      expected_cash REAL NOT NULL,
      counted_cash REAL NOT NULL,
      difference REAL NOT NULL,
      expected_transfer REAL NOT NULL DEFAULT 0,
      sales_count INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      account_id INTEGER,
      account_email TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
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
    // Roles. Una fila de users con owner_id es un cajero de esa tienda; sin
    // owner_id es el dueño, y su propio id ES el identificador de la tienda.
    // Por eso todas las consultas existentes (que filtran por user_id) siguen
    // valiendo sin tocar una sola de ellas: el middleware resuelve user_id al
    // id de la tienda, no al de quien inició sesión.
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'dueño'",
    'ALTER TABLE users ADD COLUMN owner_id INTEGER REFERENCES users(id)',
    // Atribución: quién hizo cada operación. Sin esto, "faltaron 12.000 pesos
    // este mes" no se puede accionar; con esto, "los faltantes aparecen en el
    // turno de la tarde" sí.
    //
    // El email va CONGELADO junto al id, igual que sale_items.product_name:
    // si el dueño borra al cajero que pilló robando, la evidencia no puede
    // desaparecer con él. El id sirve para agrupar; el email, para mostrar.
    //
    // account_id NO lleva REFERENCES a propósito, por la misma razón que
    // sale_items.product_id tampoco: esto es un hecho histórico, no una
    // relación viva. Con la clave foránea puesta, la base impide borrar al
    // cajero que ya vendió — o sea, impide justo la acción que el dueño
    // necesita tomar cuando descubre el faltante.
    'ALTER TABLE sales ADD COLUMN account_id INTEGER',
    'ALTER TABLE sales ADD COLUMN account_email TEXT',
    'ALTER TABLE cash_closes ADD COLUMN account_id INTEGER',
    'ALTER TABLE cash_closes ADD COLUMN account_email TEXT',
    'ALTER TABLE inventory_counts ADD COLUMN account_id INTEGER',
    'ALTER TABLE inventory_counts ADD COLUMN account_email TEXT',
    // Quién dio de alta cada producto. Los empleados pueden crear productos
    // (el dueño delega la carga de mercancía nueva), así que el dueño tiene que
    // poder ver quién agregó qué. Mismo criterio que el resto de la atribución:
    // email congelado y sin clave foránea, para que sobreviva a borrar la cuenta.
    'ALTER TABLE products ADD COLUMN created_by_account_id INTEGER',
    'ALTER TABLE products ADD COLUMN created_by_email TEXT',
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_closes_client_close_id
      ON cash_closes(user_id, client_close_id) WHERE client_close_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_sales_user_created ON sales(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_products_user      ON products(user_id);
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);

    -- El cierre siempre busca "el último corte" de este usuario.
    CREATE INDEX IF NOT EXISTS idx_cash_closes_user_closed ON cash_closes(user_id, closed_at);

    CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_counts_client_id
      ON inventory_counts(user_id, client_count_id) WHERE client_count_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_inventory_counts_user  ON inventory_counts(user_id, counted_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_items_count  ON inventory_count_items(count_id);

    -- El teléfono reintenta el aviso si se corta la conexión: una sola fila por venta.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rejected_sales_client ON rejected_sales(user_id, client_sale_id);
  `);

  console.log('Base de datos lista');
}

module.exports = { getDb, initDb };
