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
      if (parts.length === 3 && parts[2] === 'reset-password' && method === 'POST') {
        const { apiRequest } = require('./sync/apiClient');
        try {
          const res = await apiRequest(method, '/api/auth/reset-password', { body });
          // Una respuesta cloud no invalida la sesión ni la cola local.
          return res.status === 401 ? fail(400, 'El código no es válido o venció. Pide uno nuevo.') : res;
        } catch (_) {
          return fail(503, 'Conéctate a internet para recuperar tu contraseña.');
        }
      }
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

    // Los informes se consultan en la nube; cobrar sigue usando SQLite local.
    if (method === 'GET' && /^\/api\/audit\/reports(?:\/\d+)?$/.test(pathname)) {
      if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
      const { apiRequest } = require('./sync/apiClient');
      try {
        const res = await apiRequest(method, fullPath, { token: session.token });
        return res.status === 401 ? fail(403, 'Renueva tu sesión con la nube para consultar los informes.') : res;
      } catch (_) {
        return fail(503, 'Conéctate a internet para consultar los informes.');
      }
    }

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
      if (parts.length === 3 && parts[2] === 'day-stock' && method === 'GET') {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
        return ok(200, queries.getDayStock());
      }
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
    // Transferir de tienda a almacén requiere red (se valida stock local y se sincroniza).
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
      if (parts.length === 3 && parts[2] === 'from-store' && method === 'POST') {
        // Transferencia de tienda a almacén: solo online.
        const product = queries.listProducts().find(p => p.id === Number(body?.product_id));
        if (!product) return fail(404, 'Producto no encontrado en la tienda');
        if (product.server_id == null) {
          return fail(409, 'Este producto todavía no se ha subido a la nube. Espera a que sincronice y vuelve a intentarlo.');
        }
        if ((!product.unit || Number(product.track_stock) === 1) && Number(body.quantity) > Number(product.stock)) {
          return fail(409, `En la tienda solo hay ${product.stock} de ${product.name}`);
        }

        const { apiRequest } = require('./sync/apiClient');
        let res;
        try {
          res = await apiRequest('POST', '/api/warehouse/from-store', {
            token: session.token,
            body: {
              product_id: product.server_id,
              quantity: body.quantity,
              client_transfer_id: body.client_transfer_id,
            },
          });
        } catch (_) {
          return fail(503, 'Para esto hace falta internet');
        }
        if (res.status === 401) return fail(403, 'Tu sesión con la nube venció. Vuelve a iniciar sesión.');

        if (res.status === 201) {
          queries.takeLocalStock(product.id, Number(body.quantity));
          const wh = await apiRequest('GET', '/api/warehouse', { token: session.token }).catch(() => null);
          if (wh && wh.ok) queries.applyServerWarehouse(wh.data);
          require('./sync/syncWorker').syncOnce().catch(() => {});
        }

        return { ok: res.ok, status: res.status, data: res.data };
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
      // Correcciones de la cuenta principal (cambiar forma de pago, anular).
      // Se hacen en el servidor, que es quien tiene la venta y el cierre de
      // todas las cajas: hace falta internet. Aquí los ids son locales.
      const isCorrections = parts.length === 3 && parts[2] === 'corrections' && method === 'GET';
      const isSaleCorrections = parts.length === 4 && parts[3] === 'corrections' && method === 'GET';
      const isCorrect = parts.length === 4 && parts[3] === 'correct' && method === 'POST';
      if (isCorrections || isSaleCorrections || isCorrect) {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede corregir ventas');
        const { apiRequest } = require('./sync/apiClient');
        let path = '/api/sales/corrections' + (query.date ? `?date=${encodeURIComponent(query.date)}` : '');
        if (!isCorrections) {
          const sale = queries.getSale(Number(parts[2]));
          if (!sale) return fail(404, 'Venta no encontrada');
          if (sale.server_id == null) {
            return fail(409, 'Esta venta todavía no subió al servidor. Espera a que sincronice para corregirla.');
          }
          path = `/api/sales/${sale.server_id}/${parts[3]}`;
        }
        let res;
        try {
          res = await apiRequest(method, path, { token: session.token, body });
        } catch (_) {
          return fail(503, 'Para corregir ventas hace falta internet.');
        }
        if (res.ok && isCorrect) {
          queries.applySaleCorrectionLocal({
            ...res.data.correction,
            sale: res.data.sale,
            cash_close: res.data.cash_close,
          });
        }
        return { ok: res.ok, status: res.status, data: res.data };
      }
      if (parts.length === 2 && method === 'GET') {
        return ok(200, queries.listSales({
          date: query.date,
          ...(session.role === 'cajero' && { accountEmail: session.email }),
        }));
      }
      if (parts.length === 3 && method === 'GET') {
        const sale = queries.getSale(Number(parts[2]), session.role === 'cajero' ? { accountEmail: session.email } : {});
        if (session.role === 'cajero' && sale?.account_email !== session.email) return fail(404, 'Venta no encontrada');
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

    // --- extracción de caja ---
    // Solo el dueño extrae dinero; el historial es del dueño.
    if (parts[0] === 'api' && parts[1] === 'cash-withdrawals') {
      if (parts.length === 2) {
        if (method === 'GET') {
          if (session.role === 'cajero') return fail(403, 'Solo el dueño puede ver esto');
          return ok(200, queries.listWithdrawals({ date: query.date, open: query.open }));
        }
        if (method === 'POST') {
          try {
            return ok(201, queries.createWithdrawalLocal(body || {}));
          } catch (err) {
            if (err.code === 'UNAUTHORIZED') return fail(403, err.message);
            return fail(400, err.message);
          }
        }
      }
      if (parts.length === 4 && parts[3] === 'void' && method === 'POST') {
        try {
          return ok(200, queries.voidWithdrawalLocal(parts[2]));
        } catch (err) {
          if (err.status === 404) return fail(404, err.message);
          if (err.status === 409) return fail(409, err.message);
          if (err.code === 'UNAUTHORIZED') return fail(403, err.message);
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
      if (parts.length === 3 && method === 'GET' && /^\d+$/.test(parts[2])) {
        const local = queries.getCashClose(Number(parts[2]));
        if (!local) return fail(404, 'Cierre de caja no encontrado');
        if (session.role === 'cajero' && local.account_email !== session.email) return fail(404, 'Cierre de caja no encontrado');
        if (local.server_id == null) return ok(200, queries.getCashCloseDetail(local.id));
        const { apiRequest } = require('./sync/apiClient');
        let res;
        try { res = await apiRequest('GET', `/api/cash-closes/${local.server_id}`, { token: session.token }); }
        catch (_) { return fail(503, 'Para cargar el detalle actualizado hace falta conexión.'); }
        if (res.ok) {
          queries.applyCashCloseDetailLocal(res.data);
          return { ok: true, status: res.status, data: { ...res.data, id: local.id, server_id: local.server_id } };
        }
        return { ok: res.ok, status: res.status, data: res.data };
      }
      if (parts.length === 3 && method === 'PUT' && /^\d+$/.test(parts[2])) {
        if (session.role === 'cajero') return fail(403, 'Solo el dueño puede corregir cierres de caja');
        const local = queries.getCashClose(Number(parts[2]));
        if (!local) return fail(404, 'Cierre de caja no encontrado');
        if (local.server_id == null) return fail(409, 'Este cierre todavía no se sincroniza. Conéctate y vuelve a intentarlo.');
        const { apiRequest } = require('./sync/apiClient');
        let res;
        try { res = await apiRequest('PUT', `/api/cash-closes/${local.server_id}`, { token: session.token, body }); }
        catch (_) { return fail(503, 'Para corregir cierres hace falta internet.'); }
        if (res.ok) {
          queries.applyCashCloseCorrectionLocal(res.data);
          return { ok: true, status: res.status, data: {
            ...res.data,
            cash_close: { ...res.data.cash_close, id: local.id, server_id: local.server_id },
          } };
        }
        return { ok: res.ok, status: res.status, data: res.data };
      }
      if (parts.length === 2 && method === 'GET') {
        return ok(200, queries.listCashCloses(session.role === 'cajero' ? { accountEmail: session.email } : undefined));
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
              const saved = queries.getCashClose(close.id);
              return ok(201, { ...saved, pending: saved.server_id == null });
            }
            // Sin internet: se cierra con lo que ya bajó. Al sincronizar, el
            // servidor suma lo que falte (p. ej. ventas de un teléfono que no
            // habían llegado) y corrige las cifras.
            const close = queries.createCashCloseLocal(body);
            const asOf = queries.getSyncState('last_delta_at');
            const ago = asOf ? Math.max(0, Math.round((Date.now() - Date.parse(asOf)) / 60000)) : null;
            const saved = queries.getCashClose(close.id);
            return ok(201, {
              ...saved,
              pending: saved.server_id == null,
              offline_notice: ago == null
                ? 'Cerrado sin internet y sin haber bajado nunca las ventas de otros aparatos. El servidor puede ajustar la diferencia al sincronizar.'
                : `Cerrado con los datos de hace ${ago} min; el servidor puede ajustar la diferencia al sincronizar.`,
            });
          }
          const saved = queries.createCashCloseLocal(body);
          return ok(201, { ...saved, pending: saved.server_id == null });
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
