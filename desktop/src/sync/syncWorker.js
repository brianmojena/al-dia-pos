const { getLocalDb } = require('../db/localDb');
const { getPendingOutbox, getSession, updateSessionSettings } = require('../db/queries');
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
          db.prepare('UPDATE products SET server_id = ? WHERE id = ?').run(data.id, payload.local_product_id);
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

    if (res.status === 409 || res.status === 400) {
      // Conflicto real (p. ej. stock insuficiente en el servidor) — no es un
      // problema de red, reintentar solo no lo arregla. Requiere revisión.
      markConflict(db, row.id, res.data?.error || `HTTP ${res.status}`);
      summary.conflicts++;
      continue;
    }

    // 5xx u otro código inesperado: tratamos como transitorio.
    markRetry(db, row.id, res.data?.error || `HTTP ${res.status}`);
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

module.exports = { syncOnce, startSyncLoop };
