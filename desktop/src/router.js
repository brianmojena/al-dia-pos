// Traduce las mismas rutas /api/... que ya entiende el cliente web a llamadas
// locales. Devuelve siempre {ok, status, data} — la misma forma que ya usa
// apiClient.js — así client/src/lib/api.js puede tratar ambos modos igual.
const queries = require('./db/queries');
const auth = require('./auth');

function ok(status, data) { return { ok: true, status, data }; }
function fail(status, error) { return { ok: false, status, data: { error } }; }

const SALE_ERROR_STATUS = {
  EMPTY_SALE: 400, BAD_QUANTITY: 400, BAD_PRICE: 400, NO_PRODUCT: 400, NO_STOCK: 409,
};

async function routeRequest(method, fullPath, body) {
  const [pathname, queryString] = fullPath.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryString || ''));
  const parts = pathname.split('/').filter(Boolean); // ['api', 'products', '3'] etc.

  try {
    // --- auth ---
    if (parts[0] === 'api' && parts[1] === 'auth') {
      if (parts[2] === 'login' && method === 'POST') {
        const { user, initialPull } = await auth.login(body.email, body.password);
        const session = auth.getLocalSession();
        return ok(200, { token: session.token, user });
      }
      if (parts[2] === 'register' && method === 'POST') {
        // El alta de cuenta siempre requiere red — se delega íntegro al servidor real.
        const { apiRequest } = require('./sync/apiClient');
        const res = await apiRequest('POST', '/api/auth/register', { body });
        if (res.ok) {
          const { setSession } = require('./db/queries');
          setSession({
            user_id: res.data.user.id, email: res.data.user.email,
            store_name: res.data.user.store_name, plan: res.data.user.plan, token: res.data.token,
            transfer_limit: res.data.user.transfer_limit, usd_rate: res.data.user.usd_rate,
          });
          await auth.pullInitialCatalogIfEmpty(res.data.token).catch(() => {});
        }
        return { ok: res.ok, status: res.status, data: res.data };
      }
      if (parts[2] === 'me' && method === 'GET') {
        const session = auth.getLocalSession();
        if (!session) return fail(401, 'No autenticado');
        return ok(200, {
          user: {
            id: session.user_id, email: session.email,
            store_name: session.store_name, plan: session.plan,
            transfer_limit: session.transfer_limit, usd_rate: session.usd_rate,
          },
        });
      }
    }

    // Todo lo demás requiere sesión local (igual que requireAuth en el servidor).
    const session = auth.getLocalSession();
    if (!session) return fail(401, 'No autenticado');

    // --- products ---
    if (parts[0] === 'api' && parts[1] === 'products') {
      if (parts.length === 2 && method === 'GET') return ok(200, queries.listProducts());
      if (parts.length === 2 && method === 'POST') {
        if (!body.name || body.sale_price === undefined) {
          return fail(400, 'Nombre y precio de venta son requeridos');
        }
        return ok(201, queries.createProduct(body));
      }
      if (parts.length === 3 && method === 'PUT') {
        try {
          const updated = queries.updateProduct(Number(parts[2]), body);
          return updated ? ok(200, updated) : fail(404, 'Producto no encontrado');
        } catch (err) {
          return fail(400, err.message);
        }
      }
      if (parts.length === 3 && method === 'DELETE') {
        const deleted = queries.deleteProduct(Number(parts[2]));
        return deleted ? ok(200, { success: true }) : fail(404, 'Producto no encontrado');
      }
    }

    // --- sales ---
    if (parts[0] === 'api' && parts[1] === 'sales') {
      if (parts.length === 2 && method === 'GET') return ok(200, queries.listSales({ date: query.date }));
      if (parts.length === 3 && method === 'GET') {
        const sale = queries.getSale(Number(parts[2]));
        return sale ? ok(200, sale) : fail(404, 'Venta no encontrada');
      }
      if (parts.length === 2 && method === 'POST') {
        try {
          return ok(201, queries.createSaleLocal(body));
        } catch (err) {
          return fail(SALE_ERROR_STATUS[err.code] || 400, err.message);
        }
      }
    }

    // --- dashboard ---
    if (parts[0] === 'api' && parts[1] === 'dashboard' && parts.length === 2 && method === 'GET') {
      return ok(200, queries.getDashboard());
    }

    return fail(404, 'Ruta no encontrada');
  } catch (err) {
    console.error('[router] error inesperado:', err);
    return fail(500, 'Error interno');
  }
}

module.exports = { routeRequest };
