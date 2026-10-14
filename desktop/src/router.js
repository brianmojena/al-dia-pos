// Traduce las mismas rutas /api/... que ya entiende el cliente web a llamadas
// locales. Devuelve siempre {ok, status, data} — la misma forma que ya usa
// apiClient.js — así client/src/lib/api.js puede tratar ambos modos igual.
const queries = require('./db/queries');
const auth = require('./auth');

function ok(status, data) { return { ok: true, status, data }; }
function fail(status, error) { return { ok: false, status, data: { error } }; }

const SALE_ERROR_STATUS = {
  EMPTY_SALE: 400, BAD_QUANTITY: 400, BAD_PRICE: 400, NO_PRODUCT: 400, NO_STOCK: 409, BAD_PAYMENT: 400,
};

const queryString = (fullPath) => (fullPath.includes('?') ? `?${fullPath.split('?')[1]}` : '');

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
            eur_rate: res.data.user.eur_rate ?? null, role: res.data.user.role,
            warehouse_enabled: res.data.user.warehouse_enabled,
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
            eur_rate: session.eur_rate ?? null,
            // Sin rol guardado son sesiones anteriores a que existieran los
            // cajeros: eran dueños, así que se interpretan como tales.
            role: session.role || 'dueño',
            warehouse_enabled: session.warehouse_enabled !== 0,
          },
        });
      }
    }

    // Todo lo demás requiere sesión local (igual que requireAuth en el servidor).
    const session = auth.getLocalSession();
    if (!session) return fail(401, 'No autenticado');

    // Las tasas y el techo son de la tienda entera: cambiarlos necesita red,
    // como el alta de cuenta. Si el servidor acepta, la caja se queda con los
    // valores nuevos sin esperar a la próxima pasada del sync.
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'settings' && method === 'PUT') {
      if (session.role === 'cajero') return fail(403, 'Solo el dueño puede cambiar esto');
      const { apiRequest } = require('./sync/apiClient');
      let res;
      try {
        res = await apiRequest('PUT', '/api/auth/settings', { token: session.token, body });
      } catch (_) {
        return fail(503, 'Para cambiar la tasa de la tienda hace falta internet');
      }
      // Un 401 de la nube no puede volver como 401: la ventana lo tomaría como
      // sesión local perdida y sacaría al dueño de una caja que sí funciona.
      if (res.status === 401) return fail(403, 'Tu sesión con la nube venció. Vuelve a iniciar sesión para cambiar la tasa.');
      if (res.ok) {
        queries.updateSessionSettings({
          transfer_limit: res.data.user.transfer_limit,
          usd_rate: res.data.user.usd_rate,
          eur_rate: res.data.user.eur_rate ?? null,
        });
      }
      return { ok: res.ok, status: res.status, data: res.data };
    }

    // --- products ---
    // Mismas reglas que el servidor: un empleado puede dar de ALTA productos
    // nuevos y cambiar su precio de venta. Otros cambios son del dueño. Si la caja
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
      if (parts.length === 3 && parts[2] === 'stock-entries' && method === 'GET') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
        return ok(200, queries.listStockEntries());
      }
      if (parts.length === 3 && parts[2] === 'import' && method === 'POST') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede importar');
        const items = body && body.items;
        if (!Array.isArray(items) || items.length === 0 || items.length > 2000) {
          return fail(400, 'La importación debe contener entre 1 y 2000 productos');
        }
        try {
          return ok(200, queries.importProducts(items, body.stock_mode));
        } catch (err) {
          return fail(400, err.message);
        }
      }
      if (parts.length === 3 && session.role === 'cajero'
          && (method === 'DELETE' || (method === 'PUT' && Object.keys(body).some((key) => key !== 'sale_price' && key !== 'add_stock')))) {
        return fail(403, 'El cajero solo puede cambiar el precio de venta y añadir stock');
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

    // --- almacén ---
    // Leer y transferir funcionan sin red (la caja trabaja con su espejo). Dar
    // de alta, editar o borrar artículos lo puede hacer cualquier cuenta (el servidor lo registra) y se
    // hace en el servidor, que es donde vive el almacén: hace falta internet.
    if (parts[0] === 'api' && parts[1] === 'warehouse') {
      if (parts.length === 2 && method === 'GET') return ok(200, queries.listWarehouse());
      if (parts.length === 3 && parts[2] === 'transfer' && method === 'POST') {
        try {
          const done = queries.transferWarehouseLocal(body || {});
          require('./sync/syncWorker').syncOnce().catch(() => {});
          return ok(201, done);
        } catch (err) {
          return fail(err.code === 'NEEDS_SALE_PRICE' ? 400 : 409, err.message);
        }
      }
      const { apiRequest } = require('./sync/apiClient');
      let res;
      try {
        res = await apiRequest(method, `/${parts.join('/')}${queryString(fullPath)}`, { token: session.token, body: method === 'GET' || method === 'DELETE' ? undefined : body });
      } catch (_) {
        return fail(503, 'Para esto hace falta internet');
      }
      if (res.status === 401) return fail(403, 'Tu sesión con la nube venció. Vuelve a iniciar sesión.');
      if (res.ok && method !== 'GET') {
        const wh = await apiRequest('GET', '/api/warehouse', { token: session.token }).catch(() => null);
        if (wh && wh.ok) queries.applyServerWarehouse(wh.data);
      }
      return { ok: res.ok, status: res.status, data: res.data };
    }

    // --- sales ---
    if (parts[0] === 'api' && parts[1] === 'sales') {
      if (parts.length === 2 && method === 'GET') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
        return ok(200, queries.listSales({ date: query.date }));
      }
      if (parts.length === 3 && method === 'GET') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
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

    // --- compra de divisa ---
    // Cualquier cuenta compra; el historial es del dueño (como el servidor).
    if (parts[0] === 'api' && parts[1] === 'currency-purchases' && parts.length === 2) {
      if (method === 'GET') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
        return ok(200, queries.listCurrencyPurchases({ date: query.date }));
      }
      if (method === 'POST') {
        try {
          return ok(201, queries.createCurrencyPurchaseLocal(body || {}));
        } catch (err) {
          return fail(400, err.message);
        }
      }
    }

    // --- dashboard ---
    if (parts[0] === 'api' && parts[1] === 'dashboard' && parts.length === 2 && method === 'GET') {
      if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
      const dash = queries.getDashboard();
      // Efectivo, transferencia y divisas son de la tienda entera (teléfonos
      // incluidos): con internet los da el servidor, más lo de esta caja que
      // aún no subió. Sin internet quedan los de esta caja.
      try {
        const { apiRequest } = require('./sync/apiClient');
        const remote = await Promise.race([
          apiRequest('GET', '/api/dashboard', { token: session.token }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
        ]);
        if (remote.ok && remote.data && remote.data.holdings) {
          const pending = queries.pendingHoldings();
          const holdings = {};
          for (const key of Object.keys(dash.holdings)) {
            holdings[key] = Math.round((Number(remote.data.holdings[key] || 0) + pending[key]) * 100) / 100;
          }
          dash.holdings = holdings;
        }
      } catch (_) { /* sin red: se muestra lo local */ }
      return ok(200, dash);
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
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
        return ok(200, queries.cashCloseSummary());
      }
      if (parts.length === 2 && method === 'GET') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
        return ok(200, queries.listCashCloses());
      }
      if (parts.length === 2 && method === 'POST') {
        try {
          // La cuenta principal cierra la tienda entera, teléfonos incluidos:
          // el servidor es quien tiene esas ventas, así que hace falta red.
          // Se sube todo lo pendiente antes y el cierre después, para que el
          // resultado que ve el dueño sea la cuenta del servidor.
          if (session.role !== 'cajero') {
            const { apiRequest } = require('./sync/apiClient');
            const { syncOnce } = require('./sync/syncWorker');
            let online = true;
            try {
              await Promise.race([
                apiRequest('GET', '/api/auth/me', { token: session.token }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
              ]);
            } catch (_) { online = false; }
            if (online) {
              await syncOnce();
              const close = queries.createCashCloseLocal(body);
              await syncOnce();
              return ok(201, queries.getCashClose(close.id));
            }
            // Sin internet: se cierra con lo que ya bajó. Al sincronizar, el
            // servidor suma lo que falte (p. ej. ventas de un teléfono que no
            // habían llegado) y corrige las cifras.
            const close = queries.createCashCloseLocal(body);
            const asOf = queries.getSyncState('last_delta_at');
            const ago = asOf ? Math.max(0, Math.round((Date.now() - Date.parse(asOf)) / 60000)) : null;
            return ok(201, {
              ...queries.getCashClose(close.id),
              offline_notice: ago == null
                ? 'Cerrado sin internet y sin haber bajado nunca las ventas de otros aparatos. El servidor puede ajustar la diferencia al sincronizar.'
                : `Cerrado con los datos de hace ${ago} min; el servidor puede ajustar la diferencia al sincronizar.`,
            });
          }
          return ok(201, queries.createCashCloseLocal(body));
        } catch (err) {
          return fail(400, err.message);
        }
      }
    }

    // --- arqueo de inventario ---
    if (parts[0] === 'api' && parts[1] === 'inventory-counts') {
      if (parts.length === 2 && method === 'GET') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
        return ok(200, queries.listInventoryCounts());
      }
      if (parts.length === 3 && method === 'GET') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
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
