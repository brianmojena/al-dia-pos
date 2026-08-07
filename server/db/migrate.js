// Migración one-off: añade CHECK (stock >= 0) a la tabla products ya existente.
//
// Se ejecuta a mano (npm run migrate), NO en cada arranque: SQLite no permite
// añadir un CHECK con ALTER TABLE, hay que reconstruir la tabla, y eso no debe
// pasar dentro del ciclo de vida de una petición serverless.
//
// Es idempotente: si el CHECK ya está, no hace nada.
require('dotenv').config({ quiet: true });
const { getDb, initDb } = require('./database');

async function migrate() {
  await initDb();
  const db = getDb();

  const current = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'");
  const ddl = current.rows[0]?.sql || '';

  if (ddl.includes('CHECK (stock >= 0)')) {
    console.log('✓ products ya tiene CHECK (stock >= 0) — nada que migrar');
    return;
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
}

migrate().catch((err) => {
  console.error('Error en la migración:', err);
  process.exit(1);
});
