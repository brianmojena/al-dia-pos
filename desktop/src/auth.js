const { getSession, setSession, clearSession, listProducts, applyServerCatalog } = require('./db/queries');
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
 * Trae el catálogo del servidor y lo aplica a esta caja. Antes solo se hacía
 * con la base vacía (instalación nueva); ahora es la misma operación que corre
 * el sync worker en cada pasada, así que al iniciar sesión la caja queda al día
 * aunque ya tuviera productos — sin esperar a la próxima pasada.
 * Requiere red; si falla no es grave: la siguiente pasada lo vuelve a intentar.
 */
async function pullCatalog(token) {
  const res = await apiRequest('GET', '/api/products', { token });
  if (!res.ok || !Array.isArray(res.data)) return { pulled: false, error: res.data?.error };
  return { pulled: true, ...applyServerCatalog(res.data) };
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
    role: res.data.user.role,
  });

  const pull = await pullCatalog(res.data.token).catch((err) => ({ pulled: false, error: err.message }));

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

module.exports = { login, logout, getLocalSession, isSessionTokenValid, pullCatalog };
