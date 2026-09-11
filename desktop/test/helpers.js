const os = require('os');
const path = require('path');
const fs = require('fs');

const { initLocalDb, closeLocalDb, getLocalDb } = require('../src/db/localDb');
const queries = require('../src/db/queries');

/**
 * Abre una base local limpia en un archivo temporal.
 *
 * La capa de consultas no necesita Electron para nada — habla con
 * better-sqlite3 directamente — así que se puede probar entera con node --test.
 */
function startLocalDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitienda-desktop-test-'));
  const dbPath = path.join(dir, 'test.db');
  initLocalDb(dbPath);

  queries.setSession({
    user_id: 1,
    email: 'cajera@mitienda.cu',
    store_name: 'Tienda de Prueba',
    plan: 'dev',
    token: 'token-de-prueba',
    role: 'cajero',
  });

  return {
    db: getLocalDb(),
    queries,
    close() {
      closeLocalDb();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Crea un producto local y le asigna server_id como si ya hubiera sincronizado. */
function crearProductoSincronizado(queries, { name = 'Producto', stock = 10, sale_price = 100, purchase_price = 60 } = {}) {
  const product = queries.createProduct({ name, stock, sale_price, purchase_price });
  getLocalDb().prepare('UPDATE products SET server_id = ? WHERE id = ?').run(1000 + product.id, product.id);
  return product;
}

/** Marca las ventas como ya subidas, que es el estado normal tras una pasada de sync. */
function marcarVentasSincronizadas() {
  getLocalDb()
    .prepare('UPDATE sales SET server_id = 9000 + id WHERE server_id IS NULL')
    .run();
}

const outboxDe = (tipo) =>
  getLocalDb().prepare('SELECT * FROM outbox WHERE op_type = ? ORDER BY id ASC').all(tipo);

module.exports = { startLocalDb, crearProductoSincronizado, marcarVentasSincronizadas, outboxDe };
