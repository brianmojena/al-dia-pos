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
            role: res.data.user.role,
          });
          await auth.pullCatalog(res.data.token).catch(() => {});
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
            // Sin rol guardado son sesiones anteriores a que existieran los
            // cajeros: eran dueños, así que se interpretan como tales.
            role: session.role || 'dueño',
          },
        });
      }
    }

    // Todo lo demás requiere sesión local (igual que requireAuth en el servidor).
    const session = auth.getLocalSession();
    if (!session) return fail(401, 'No autenticado');

    // --- products ---
    // Mismas reglas que el servidor: un empleado puede dar de ALTA productos
    // nuevos, pero editar o borrar los que ya existen es del dueño. Si la caja
    // no las aplicara, el cambio quedaría hecho aquí, el servidor lo rechazaría
    // al sincronizar, y la caja y la web contarían historias distintas.
    if (parts[0] === 'api' && parts[1] === 'products') {
      if (parts.length === 2 && method === 'GET') return ok(200, queries.listProducts());
      if (parts.length === 2 && method === 'POST') {
        if (!body.name || !String(body.name).trim() || body.sale_price === undefined || body.sale_price === null) {
          return fail(400, 'Nombre y precio de venta son requeridos');
        }
        try {
          return ok(201, queries.createProduct(body));
        } catch (err) {
          return fail(err.code === 'DUPLICATE_NAME' ? 409 : 400, err.message);
        }
      }
      if (parts.length === 3 && (method === 'PUT' || method === 'DELETE') && session.role === 'cajero') {
        return fail(403, 'Solo el dueño puede cambiar o borrar productos que ya existen');
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

    // --- cierre de caja ---
    // Mismo contrato que server/routes/cashCloses.js, incluido lo que NO se
    // devuelve: /current describe el período pero nunca el efectivo esperado.
    // Acá el conteo a ciegas lo sostiene este router, porque en modo escritorio
    // no hay servidor en el medio.
    if (parts[0] === 'api' && parts[1] === 'cash-closes') {
      if (parts.length === 3 && parts[2] === 'current' && method === 'GET') {
        return ok(200, queries.getCurrentCashPeriod());
      }
      if (parts.length === 3 && parts[2] === 'summary' && method === 'GET') {
        return ok(200, queries.cashCloseSummary());
      }
      if (parts.length === 2 && method === 'GET') return ok(200, queries.listCashCloses());
      if (parts.length === 2 && method === 'POST') {
        try {
          return ok(201, queries.createCashCloseLocal(body));
        } catch (err) {
          return fail(400, err.message);
        }
      }
    }

    // --- arqueo de inventario ---
    if (parts[0] === 'api' && parts[1] === 'inventory-counts') {
      if (parts.length === 2 && method === 'GET') return ok(200, queries.listInventoryCounts());
      if (parts.length === 3 && method === 'GET') {
        const count = queries.getInventoryCount(Number(parts[2]));
        return count ? ok(200, count) : fail(404, 'Arqueo no encontrado');
      }
      if (parts.length === 2 && method === 'POST') {
        try {
          return ok(201, queries.createInventoryCountLocal(body));
        } catch (err) {
          return fail(400, err.message);
        }
      }
    }

    return fail(404, 'Ruta no encontrada');
  } catch (err) {
    console.error('[router] error inesperado:', err);
    return fail(500, 'Error interno');
  }
}

module.exports = { routeRequest };
