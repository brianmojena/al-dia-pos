const { getLocalDb } = require('../db/localDb');
const {
  getPendingOutbox, getSession, updateSessionSettings, applyServerCatalog, resetStuckSyncing,
} = require('../db/queries');
const { apiRequest } = require('./apiClient');

// ---------------------------------------------------------------------------
// Transiciones de estado del outbox
// ---------------------------------------------------------------------------

const markSyncing = (db, id) =>
  db.prepare(`UPDATE outbox SET status = 'syncing', last_attempt_at = datetime('now') WHERE id = ?`).run(id);

const markSynced = (db, id) =>
  db.prepare(`UPDATE outbox SET status = 'synced', last_error = NULL WHERE id = ?`).run(id);

const markConflict = (db, id, error) =>
  db.prepare(`UPDATE outbox SET status = 'conflict', last_error = ? WHERE id = ?`).run(error, id);

// Vuelve a 'pending' (no 'failed' — sigue reintentándose solo) con el contador
// de intentos incrementado, para poder aplicar backoff más adelante si hace falta.
const markRetry = (db, id, error) =>
  db.prepare(`
    UPDATE outbox SET status = 'pending', attempts = attempts + 1, last_error = ? WHERE id = ?
  `).run(error, id);

const getProductServerId = (db, localId) => {
  const row = db.prepare('SELECT server_id FROM products WHERE id = ?').get(localId);
  return row ? row.server_id : null;
};

// ---------------------------------------------------------------------------
// Resolución de un paso del outbox a una llamada HTTP concreta
// ---------------------------------------------------------------------------

/**
 * Devuelve { skip: true } si la operación depende de un id local que todavía
 * no tiene server_id (p. ej. una venta de un producto creado offline cuyo
 * outbox de creación no sincronizó todavía). El propio orden FIFO del outbox
 * garantiza que esa dependencia se resuelva en una pasada anterior o en la
 * siguiente — nunca hace falta reordenar nada a mano.
 */
function buildRequest(db, row) {
  const payload = JSON.parse(row.payload);

  switch (row.op_type) {
    case 'product.create':
      return {
        method: 'POST',
        path: '/api/products',
        body: {
          name: payload.name,
          purchase_price: payload.purchase_price,
          sale_price: payload.sale_price,
          stock: payload.stock,
        },
        onSuccess: (data) => {
          // Si el servidor lo unió con un producto que ya existía (mismo
          // nombre), esta caja puede tener ya ese producto, bajado del
          // catálogo. Dos filas visibles con el mismo server_id se verían como
          // dos productos iguales, así que esta copia se oculta. Conserva el
          // server_id: las ventas hechas con ella lo necesitan para subir.
          const other = db.prepare(
            'SELECT id FROM products WHERE server_id = ? AND id != ? AND deleted = 0'
          ).get(data.id, payload.local_product_id);
          db.prepare('UPDATE products SET server_id = ?, deleted = MAX(deleted, ?) WHERE id = ?')
            .run(data.id, other ? 1 : 0, payload.local_product_id);
        },
      };

    case 'product.update': {
      const serverId = getProductServerId(db, payload.local_product_id);
      if (!serverId) return { skip: true };
      return {
        method: 'PUT',
        path: `/api/products/${serverId}`,
        body: {
          name: payload.name,
          purchase_price: payload.purchase_price,
          sale_price: payload.sale_price,
          stock: payload.stock,
        },
      };
    }

    case 'product.delete': {
      const serverId = getProductServerId(db, payload.local_product_id);
      if (!serverId) return { skip: true };
      return { method: 'DELETE', path: `/api/products/${serverId}`, treatNotFoundAsSuccess: true };
    }

    case 'sale.create': {
      const items = [];
      for (const item of payload.items) {
        const serverId = getProductServerId(db, item.local_product_id);
        if (!serverId) return { skip: true };
        items.push({ product_id: serverId, quantity: item.quantity, unit_price: item.unit_price });
      }
      return {
        method: 'POST',
        path: '/api/sales',
        body: { items, payment_method: payload.payment_method, client_sale_id: payload.client_sale_id },
        onSuccess: (data) => {
          db.prepare('UPDATE sales SET server_id = ? WHERE client_sale_id = ?').run(data.id, payload.client_sale_id);
        },
      };
    }

    case 'cash_close.create': {
      // El cierre viaja con los client_sale_id que cubrió, NO con fechas: el
      // servidor le pone a cada venta sincronizada su propia hora de llegada,
      // así que un período definido por timestamps no encontraría del otro lado
      // las ventas que acá ocurrieron horas antes. Con los ids, el servidor
      // suma exactamente las mismas ventas sin importar cuánto tardó el sync.
      //
      // Y se espera a que todas estén arriba: si alguna no sincronizó todavía,
      // el servidor calcularía el esperado sin ella y el descuadre saldría mal.
      // El orden FIFO garantiza que se resuelva en una pasada posterior —
      // mismo mecanismo que ya usan las ventas con sus productos.
      const ids = payload.client_sale_ids || [];
      const pendientes = ids.filter((clientSaleId) => {
        const sale = db.prepare('SELECT server_id FROM sales WHERE client_sale_id = ?').get(clientSaleId);
        return !sale || sale.server_id == null;
      });
      if (pendientes.length > 0) return { skip: true };

      return {
        method: 'POST',
        path: '/api/cash-closes',
        body: {
          client_close_id: payload.client_close_id,
          opening_float: payload.opening_float,
          counted_cash: payload.counted_cash,
          note: payload.note,
          client_sale_ids: ids,
        },
        onSuccess: (data) => {
          db.prepare('UPDATE cash_closes SET server_id = ? WHERE client_close_id = ?')
            .run(data.id, payload.client_close_id);
        },
      };
    }

    case 'inventory_count.create': {
      const items = [];
      for (const item of payload.items) {
        const serverId = getProductServerId(db, item.local_product_id);
        if (!serverId) return { skip: true };
        items.push({ product_id: serverId, counted: item.counted });
      }
      return {
        method: 'POST',
        path: '/api/inventory-counts',
        body: {
          client_count_id: payload.client_count_id,
          note: payload.note,
          items,
        },
        onSuccess: (data) => {
          db.prepare('UPDATE inventory_counts SET server_id = ? WHERE client_count_id = ?')
            .run(data.id, payload.client_count_id);
        },
      };
    }

    default:
      throw new Error(`Tipo de operación desconocido en outbox: ${row.op_type}`);
  }
}

// ---------------------------------------------------------------------------
// Una pasada completa de sincronización
// ---------------------------------------------------------------------------

async function syncOnce() {
  const db = getLocalDb();
  const session = getSession();
  const summary = { processed: 0, synced: 0, conflicts: 0, skipped: 0, authExpired: false };

  if (!session?.token) return summary; // sin sesión, nada que sincronizar

  // Operaciones que una pasada anterior dejó a medio subir (la app se cerró
  // en plena petición). Sin esto no se reintentaban nunca.
  summary.recovered = resetStuckSyncing();

  const pending = getPendingOutbox();

  for (const row of pending) {
    if (summary.authExpired) break; // token vencido: no tiene sentido seguir intentando

    let step;
    try {
      step = buildRequest(db, row);
    } catch (err) {
      markConflict(db, row.id, err.message);
      summary.conflicts++;
      continue;
    }

    if (step.skip) { summary.skipped++; continue; }

    markSyncing(db, row.id);
    summary.processed++;

    let res;
    try {
      res = await apiRequest(step.method, step.path, { token: session.token, body: step.body });
    } catch (err) {
      // Sin red: la dejamos 'pending' para el próximo intento, sin gastar reintentos raros.
      markRetry(db, row.id, err.message);
      continue;
    }

    if (res.ok) {
      step.onSuccess?.(res.data);
      markSynced(db, row.id);
      summary.synced++;
      continue;
    }

    // idempotent_replay: el servidor ya tenía esta venta (la respuesta se había
    // perdido en un intento anterior) — es un éxito, no un conflicto.
    if (res.status === 200 && res.data?.idempotent_replay) {
      step.onSuccess?.(res.data);
      markSynced(db, row.id);
      summary.synced++;
      continue;
    }

    if (step.treatNotFoundAsSuccess && res.status === 404) {
      markSynced(db, row.id);
      summary.synced++;
      continue;
    }

    if (res.status === 401) {
      markRetry(db, row.id, 'Sesión expirada');
      summary.authExpired = true;
      continue;
    }

    if (res.status === 409 || res.status === 400 || res.status === 403) {
      // Conflicto real (p. ej. stock insuficiente en el servidor, o una
      // operación que esta cuenta no tiene permiso para hacer) — no es un
      // problema de red, reintentar solo no lo arregla. Requiere revisión.
      // Antes un 403 caía en "transitorio" y se reintentaba para siempre.
      markConflict(db, row.id, res.data?.error || `HTTP ${res.status}`);
      summary.conflicts++;
      continue;
    }

    // 5xx u otro código inesperado: tratamos como transitorio.
    markRetry(db, row.id, res.data?.error || `HTTP ${res.status}`);
  }

  // Catálogo: lo que el dueño cargó o cambió en la web baja a esta caja.
  // Va DESPUÉS de subir la cola a propósito: así las ventas y altas hechas aquí
  // ya están arriba y quedan menos productos con cambios pendientes que haya
  // que saltarse (ver applyServerCatalog). Sin red se ignora: la caja sigue
  // vendiendo con el catálogo que ya tiene.
  if (!summary.authExpired) {
    try {
      const catalog = await apiRequest('GET', '/api/products', { token: session.token });
      if (catalog.ok && Array.isArray(catalog.data)) {
        const stats = applyServerCatalog(catalog.data);
        summary.catalog = stats;
        summary.catalogChanged = stats.changed;
      }
    } catch (_) { /* sin red — se reintenta en la próxima pasada */ }
  }

  // El límite de transferencia y la tasa del dólar los cambia el dueño desde
  // su teléfono, no desde esta caja — así que la única forma de que la caja
  // se entere es preguntándole al servidor. Se aprovecha cada pasada del
  // sync worker (misma cadencia que ya existe) en vez de abrir una conexión
  // aparte solo para esto. Si no hay red, se ignora en silencio: el valor
  // guardado localmente sigue siendo válido hasta la próxima pasada exitosa.
  try {
    const me = await apiRequest('GET', '/api/auth/me', { token: session.token });
    if (me.ok) {
      updateSessionSettings({ transfer_limit: me.data.user.transfer_limit, usd_rate: me.data.user.usd_rate });
      summary.settingsRefreshed = true;
    }
  } catch (_) { /* sin red — se reintenta en la próxima pasada */ }

  return summary;
}

/**
 * Arranca el loop periódico. Se llama una vez desde main.js. Devuelve una
 * función para detenerlo (útil en tests).
 */
function startSyncLoop({ intervalMs = 30000, onTick } = {}) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const summary = await syncOnce();
      onTick?.(summary);
    } catch (err) {
      console.error('[sync] error inesperado en syncOnce:', err);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };

  tick(); // primera pasada inmediata al arrancar, no esperar el primer intervalo
  return () => { stopped = true; };
}

// buildRequest se exporta para poder probarlo sin levantar red ni Electron:
// es donde vive la lógica que decide si una operación puede subir todavía o
// tiene que esperar a que sus dependencias sincronicen.
module.exports = { syncOnce, startSyncLoop, buildRequest };
