const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Arranca la API contra una base de datos SQLite temporal y aislada.
 *
 * Hay que fijar TURSO_DATABASE_URL *antes* de requerir database.js: getDb()
 * memoiza el cliente en la primera llamada, así que si el módulo se cargara
 * primero, los tests escribirían sobre server/db/inventory.db — la base de
 * desarrollo real.
 */
async function startTestServer() {
  const dbFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mypimes-test-')),
    'test.db'
  );

  process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.JWT_SECRET = 'test-secret';
  process.env.NODE_ENV = 'test';

  const { initDb, getDb } = require('../db/database');
  await initDb();

  const app = require('../app');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* respuesta sin cuerpo */ }
    return { status: res.status, body: json };
  };

  return {
    api,
    db: getDb(),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
    },
  };
}

/** Registra un usuario nuevo y devuelve su token. */
async function registerUser(api, email = `t${Date.now()}${Math.random().toString(36).slice(2)}@test.local`) {
  const res = await api('POST', '/api/auth/register', {
    body: { email, password: 'test1234', store_name: 'Tienda de Prueba' },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`No se pudo registrar el usuario de prueba: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

/** Crea un producto y devuelve su id. */
async function createProduct(api, token, { name = 'Producto', stock = 0, sale_price = 100, purchase_price = 60 } = {}) {
  const res = await api('POST', '/api/products', {
    token,
    body: { name, stock, sale_price, purchase_price },
  });
  if (res.status !== 201) {
    throw new Error(`No se pudo crear el producto: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return Number(res.body.id);
}

module.exports = { startTestServer, registerUser, createProduct };
