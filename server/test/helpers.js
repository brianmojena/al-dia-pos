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
    // Para descargas binarias (el Excel de /api/reports/export), que `api()`
    // no puede devolver porque siempre intenta parsear JSON.
    baseUrl,
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

/** Crea un cajero en la tienda del token dueño y devuelve su token. */
async function createCashier(api, ownerToken, { email, password = 'caja1234' } = {}) {
  const inbox = email || `cajero${Date.now()}${Math.random().toString(36).slice(2)}@test.local`;
  const res = await api('POST', '/api/auth/cashiers', {
    token: ownerToken,
    body: { email: inbox, password },
  });
  if (res.status !== 201) {
    throw new Error(`No se pudo crear el cajero: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const login = await api('POST', '/api/auth/login', { body: { email: inbox, password } });
  if (!login.body?.token) {
    throw new Error(`No se pudo loguear el cajero: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return { token: login.body.token, id: res.body.id, email: inbox };
}

/**
 * Monta la tienda de una jornada diaria completa: dueño + cajero + catálogo.
 * Devuelve tokens y ids listos para vender, cerrar caja y conciliar.
 */
async function jornadaFixtures(api, suffix = Math.random().toString(36).slice(2)) {
  const ownerToken = await registerUser(api, `dueno${suffix}@test.local`);
  const { token: cashierToken } = await createCashier(api, ownerToken, {
    email: `cajero${suffix}@test.local`,
  });
  const panId = await createProduct(api, ownerToken, {
    name: 'Pan', stock: 10, sale_price: 100, purchase_price: 60,
  });
  const lecheId = await createProduct(api, ownerToken, {
    name: 'Leche', stock: 5, sale_price: 200, purchase_price: 120,
  });
  const agotadoId = await createProduct(api, ownerToken, {
    name: 'Agotado', stock: 0, sale_price: 50, purchase_price: 30,
  });
  return { ownerToken, cashierToken, panId, lecheId, agotadoId };
}

module.exports = { startTestServer, registerUser, createProduct, createCashier, jornadaFixtures };
