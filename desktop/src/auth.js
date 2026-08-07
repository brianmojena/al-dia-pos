const { getLocalDb } = require('./db/localDb');
const { getSession, setSession, clearSession, listProducts } = require('./db/queries');
const { apiRequest } = require('./sync/apiClient');

/** Decodifica el payload del JWT sin verificar firma — alcanza para saber si
 * expiró; la firma la verifica el servidor cuando de verdad lo usamos. */
function decodeJwtPayload(token) {
  try {
    const [, payloadB64] = token.split('.');
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function isSessionTokenValid(session) {
  if (!session?.token) return false;
  const payload = decodeJwtPayload(session.token);
  if (!payload?.exp) return false;
  return payload.exp * 1000 > Date.now();
}

/**
 * Trae el catálogo actual desde el servidor y siembra la base local — solo
 * tiene sentido la primera vez (instalación nueva, sin productos todavía).
 * Requiere red; si falla, no es grave: la tienda puede cargar sus productos
 * a mano y de todas formas van a subir por el outbox normal.
 */
async function pullInitialCatalogIfEmpty(token) {
  const db = getLocalDb();
  const existing = listProducts();
  if (existing.length > 0) return { pulled: false };

  const res = await apiRequest('GET', '/api/products', { token });
  if (!res.ok || !Array.isArray(res.data)) return { pulled: false, error: res.data?.error };

  const insert = db.transaction((products) => {
    const stmt = db.prepare(`
      INSERT INTO products (server_id, name, purchase_price, sale_price, stock, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const p of products) {
      stmt.run(p.id, p.name, p.purchase_price, p.sale_price, p.stock, p.created_at);
    }
  });
  insert(res.data);

  return { pulled: true, count: res.data.length };
}

/**
 * Login online (necesita red la primera vez). Si esta máquina ya tenía
 * datos locales de OTRA cuenta, se niega — mezclar dos tiendas en la misma
 * base local corrompería el inventario. Cada instalación es una sola tienda.
 */
async function login(email, password) {
  const res = await apiRequest('POST', '/api/auth/login', { body: { email, password } });
  if (!res.ok) {
    throw Object.assign(new Error(res.data?.error || 'No se pudo iniciar sesión'), { status: res.status });
  }

  const previous = getSession();
  const hasLocalData = listProducts().length > 0;
  if (previous && hasLocalData && previous.user_id !== res.data.user.id) {
    throw new Error(
      'Esta computadora ya tiene datos de otra tienda. Para usar una cuenta distinta, ' +
      'instalá la app en otra máquina o contactá soporte para migrar los datos.'
    );
  }

  setSession({
    user_id: res.data.user.id,
    email: res.data.user.email,
    store_name: res.data.user.store_name,
    plan: res.data.user.plan,
    token: res.data.token,
    transfer_limit: res.data.user.transfer_limit,
    usd_rate: res.data.user.usd_rate,
  });

  const pull = await pullInitialCatalogIfEmpty(res.data.token).catch((err) => ({ pulled: false, error: err.message }));

  return { user: res.data.user, initialPull: pull };
}

/** Sesión usable para operar localmente — no requiere red ni token vigente:
 * la app funciona offline aunque el JWT haya vencido, solo deja de sincronizar. */
function getLocalSession() {
  const session = getSession();
  if (!session) return null;
  return { ...session, tokenValid: isSessionTokenValid(session) };
}

function logout() {
  clearSession();
}

module.exports = { login, logout, getLocalSession, isSessionTokenValid, pullInitialCatalogIfEmpty };
