const crypto = require('crypto');
const { getLocalDb } = require('./localDb');
const { todayBounds, boundsForDate } = require('../lib/businessDay');

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

function getSession() {
  const db = getLocalDb();
  return db.prepare('SELECT * FROM session WHERE id = 1').get() || null;
}

function setSession({
  user_id, email, store_name, plan, token,
  transfer_limit = null, usd_rate = null, role = null,
}) {
  const db = getLocalDb();
  db.prepare(`
    INSERT INTO session (id, user_id, email, store_name, plan, token, transfer_limit, usd_rate, role, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id, email = excluded.email, store_name = excluded.store_name,
      plan = excluded.plan, token = excluded.token,
      transfer_limit = excluded.transfer_limit, usd_rate = excluded.usd_rate,
      role = excluded.role,
      updated_at = datetime('now')
  `).run(user_id, email, store_name, plan, token, transfer_limit, usd_rate, role);
}

/**
 * Actualiza SOLO transfer_limit/usd_rate de la sesión ya guardada, sin tocar
 * el resto — la usa el sync worker para reflejar en la caja lo que el dueño
 * cambió desde su teléfono, sin tener que volver a loguearse. No crea sesión
 * si no hay una activa: no tendría a quién actualizar.
 */
function updateSessionSettings({ transfer_limit = null, usd_rate = null }) {
  const db = getLocalDb();
  db.prepare(`
    UPDATE session SET transfer_limit = ?, usd_rate = ?, updated_at = datetime('now') WHERE id = 1
  `).run(transfer_limit, usd_rate);
}

function clearSession() {
  getLocalDb().prepare('DELETE FROM session WHERE id = 1').run();
}

// ---------------------------------------------------------------------------
// Outbox — helpers compartidos por queries.js (encolar) y syncWorker.js (leer)
// ---------------------------------------------------------------------------

function enqueueOutbox(db, { op_type, client_op_id, local_ref_id, payload }) {
  db.prepare(`
    INSERT INTO outbox (op_type, client_op_id, local_ref_id, payload)
    VALUES (?, ?, ?, ?)
  `).run(op_type, client_op_id, local_ref_id, JSON.stringify(payload));
}

function getPendingOutbox(limit = 50) {
  return getLocalDb()
    .prepare(`SELECT * FROM outbox WHERE status IN ('pending', 'conflict') ORDER BY id ASC LIMIT ?`)
    .all(limit);
}

function countPendingOutbox() {
  const row = getLocalDb()
    .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status IN ('pending', 'syncing', 'conflict')`)
    .get();
  return row.c;
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

function listProducts() {
  return getLocalDb()
    .prepare('SELECT * FROM products WHERE deleted = 0 ORDER BY name ASC')
    .all();
}

/** "  Arroz   (1 LB) " y "arroz (1 lb)" son el mismo producto — misma regla que el servidor. */
const normalizeName = (name) =>
  String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

const findProductByName = (db, name) => {
  const key = normalizeName(name);
  return db.prepare('SELECT * FROM products WHERE deleted = 0').all()
    .find((p) => normalizeName(p.name) === key) || null;
};

function createProduct({ name, purchase_price = 0, sale_price, stock = 0 }) {
  const db = getLocalDb();
  const clientOpId = crypto.randomUUID();
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');

  // Si esta caja ya tiene el producto (lo bajó del catálogo o lo creó antes),
  // se avisa en vez de duplicarlo. El caso en que la caja NO lo tiene todavía
  // —el dueño lo cargó en la web mientras no había internet— lo resuelve el
  // servidor al sincronizar, uniéndolos (ver onSuccess de product.create).
  const existing = findProductByName(db, cleanName);
  if (existing) {
    throw Object.assign(
      new Error(`Ya existe «${existing.name}». Búscalo en la lista en vez de crearlo otra vez.`),
      { code: 'DUPLICATE_NAME', product: existing }
    );
  }

  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO products (name, purchase_price, sale_price, stock) VALUES (?, ?, ?, ?)
    `).run(cleanName, purchase_price, sale_price, stock);
    const localId = result.lastInsertRowid;

    enqueueOutbox(db, {
      op_type: 'product.create',
      client_op_id: clientOpId,
      local_ref_id: localId,
      payload: { local_product_id: localId, name: cleanName, purchase_price, sale_price, stock },
    });

    return db.prepare('SELECT * FROM products WHERE id = ?').get(localId);
  });

  return insert();
}

function updateProduct(id, { name, purchase_price, sale_price, stock }) {
  const db = getLocalDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(id);
  if (!existing) return null;
  if (stock !== undefined && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
    throw new Error('El stock debe ser un número entero mayor o igual a 0');
  }

  const next = {
    name: name ?? existing.name,
    purchase_price: purchase_price ?? existing.purchase_price,
    sale_price: sale_price ?? existing.sale_price,
    stock: stock ?? existing.stock,
  };

  // Solo viaja al servidor lo que de verdad cambió. El formulario manda todos
  // los campos siempre; si se reenviara el stock al corregir un precio, el
  // stock que tenía ESTA caja en ese momento pisaría en el servidor las ventas
  // que entraron entretanto desde la web u otra caja.
  const changed = {};
  if (String(next.name) !== String(existing.name)) changed.name = next.name;
  for (const key of ['purchase_price', 'sale_price', 'stock']) {
    if (Number(next[key]) !== Number(existing[key])) changed[key] = next[key];
  }
  if (Object.keys(changed).length === 0) return existing;

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE products SET name = ?, purchase_price = ?, sale_price = ?, stock = ? WHERE id = ?
    `).run(next.name, next.purchase_price, next.sale_price, next.stock, id);

    enqueueOutbox(db, {
      op_type: 'product.update',
      client_op_id: crypto.randomUUID(),
      local_ref_id: id,
      payload: { local_product_id: id, ...changed },
    });

    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  });

  return update();
}

function deleteProduct(id) {
  const db = getLocalDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(id);
  if (!existing) return false;

  const del = db.transaction(() => {
    // Soft delete: mantenemos la fila para que sale_items conserve su referencia
    // y para poder resolver server_id cuando el outbox de borrado se sincronice.
    db.prepare('UPDATE products SET deleted = 1 WHERE id = ?').run(id);
    enqueueOutbox(db, {
      op_type: 'product.delete',
      client_op_id: crypto.randomUUID(),
      local_ref_id: id,
      payload: { local_product_id: id },
    });
  });

  del();
  return true;
}

// ---------------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------------

/**
 * Crea una venta 100% local, sin red. Espeja la lógica de server/routes/sales.js:
 * valida stock con un UPDATE condicional (misma defensa que la carrera que
 * arreglamos en el servidor) y todo ocurre en una sola transacción con el
 * encolado del outbox — o se guarda todo, o no se guarda nada.
 */
function createSaleLocal({ items, payment_method = 'efectivo' }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('La venta debe tener al menos un producto'), { code: 'EMPTY_SALE' });
  }

  const db = getLocalDb();
  const clientSaleId = crypto.randomUUID();

  const create = db.transaction(() => {
    let total = 0;
    let profit = 0;
    const lines = [];

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw Object.assign(new Error('Cantidad inválida'), { code: 'BAD_QUANTITY' });
      }
      const unitPrice = Number(item.unit_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw Object.assign(new Error('Precio inválido'), { code: 'BAD_PRICE' });
      }

      const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(item.product_id);
      if (!product) {
        throw Object.assign(new Error('Producto no existe'), { code: 'NO_PRODUCT' });
      }

      const updated = db.prepare(
        'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?'
      ).run(quantity, item.product_id, quantity);
      if (updated.changes !== 1) {
        throw Object.assign(
          new Error(`Stock insuficiente para ${product.name}`),
          { code: 'NO_STOCK', product: product.name }
        );
      }

      total  += quantity * unitPrice;
      profit += quantity * (unitPrice - (product.purchase_price || 0));
      lines.push({
        product_id: product.id,
        product_name: product.name,
        quantity,
        unit_price: unitPrice,
        unit_cost: product.purchase_price || 0,
      });
    }

    const saleResult = db.prepare(`
      INSERT INTO sales (client_sale_id, total, profit, payment_method) VALUES (?, ?, ?, ?)
    `).run(clientSaleId, total, profit, payment_method);
    const saleId = saleResult.lastInsertRowid;

    for (const line of lines) {
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(saleId, line.product_id, line.product_name, line.quantity, line.unit_price, line.unit_cost);
    }

    enqueueOutbox(db, {
      op_type: 'sale.create',
      client_op_id: clientSaleId,   // mismo id: es EL identificador de idempotencia de esta venta
      local_ref_id: saleId,
      payload: {
        client_sale_id: clientSaleId,
        payment_method,
        items: lines.map(l => ({
          local_product_id: l.product_id,
          quantity: l.quantity,
          unit_price: l.unit_price,
        })),
      },
    });

    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  });

  return create();
}

function listSales({ date } = {}) {
  const db = getLocalDb();
  if (!date) return db.prepare(`SELECT * FROM sales ORDER BY created_at DESC LIMIT 200`).all();
  // El día del negocio en Cuba, no el día UTC — ver src/lib/businessDay.js.
  const { start, end } = boundsForDate(date);
  return db.prepare(
    `SELECT * FROM sales WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC`
  ).all(start, end);
}

function getSale(id) {
  const db = getLocalDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) return null;
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);
  return { ...sale, items };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function getDashboard() {
  const db = getLocalDb();
  // Antes se comparaba contra la fecha UTC, así que a las 8:00 pm hora de Cuba
  // el día del dueño se reiniciaba con la tienda todavía abierta.
  const { start, end } = todayBounds();

  const todayStats = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS sales, COALESCE(SUM(profit),0) AS profit, COUNT(*) AS count
    FROM sales WHERE created_at >= ? AND created_at < ?
  `).get(start, end);

  const lowStock = db.prepare(`
    SELECT * FROM products WHERE deleted = 0 AND stock <= 5 ORDER BY stock ASC
  `).all();

  const recentSales = db.prepare(`
    SELECT * FROM sales WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 5
  `).all(start, end);

  return { today: todayStats, lowStock, recentSales };
}

// ---------------------------------------------------------------------------
// Arqueo de caja
// ---------------------------------------------------------------------------

// Antes del primer cierre no hay corte anterior. Mismo centinela que el
// servidor (server/routes/cashCloses.js): ordena por debajo de cualquier fecha
// real, así que el primer arqueo barre todo lo que nunca se contó.
const BEGINNING_OF_TIME = '0000-01-01 00:00:00';

const getPeriodStart = (db) => {
  const row = db.prepare('SELECT closed_at FROM cash_closes ORDER BY closed_at DESC LIMIT 1').get();
  return row ? row.closed_at : BEGINNING_OF_TIME;
};

// created_at > inicio (estricto): una venta registrada justo en el segundo del
// corte anterior cae en el período siguiente. En el peor caso se cuenta un
// período más tarde; nunca dos veces.
const periodSales = (db, periodStart) =>
  db.prepare(
    `SELECT client_sale_id, total, payment_method, created_at
     FROM sales WHERE created_at > ? ORDER BY created_at ASC`
  ).all(periodStart);

/**
 * Describe el período abierto SIN revelar cuánto debería haber.
 *
 * Misma disciplina que en el servidor: el conteo a ciegas no se sostiene si el
 * monto esperado llega a la pantalla antes de que el cajero declare lo contado.
 * Acá el que la sostiene es este router local, porque en modo escritorio no
 * hay servidor en el medio.
 */
function getCurrentCashPeriod() {
  const db = getLocalDb();
  const periodStart = getPeriodStart(db);
  const sales = periodSales(db, periodStart);
  const isFirstClose = periodStart === BEGINNING_OF_TIME;

  return {
    opened_at: isFirstClose ? (sales[0]?.created_at ?? null) : periodStart,
    is_first_close: isFirstClose,
    has_sales: sales.length > 0,
  };
}

/**
 * Cierra la caja 100% local, sin red.
 *
 * El outbox lleva la lista de client_sale_id que este cierre cubrió, no las
 * fechas: el servidor le pone a cada venta sincronizada su propia hora de
 * llegada, así que un cierre definido por timestamps no encontraría ninguna
 * venta del otro lado. Con los ids, el servidor suma exactamente las mismas
 * ventas y el resultado no depende de cuánto tardó la sincronización.
 */
function createCashCloseLocal({ counted_cash, opening_float = 0, note = null }) {
  const counted = Number(counted_cash);
  if (!Number.isFinite(counted) || counted < 0) {
    throw Object.assign(new Error('El efectivo contado no es válido'), { code: 'BAD_COUNT' });
  }
  const float = Number(opening_float);
  if (!Number.isFinite(float) || float < 0) {
    throw Object.assign(new Error('El fondo de caja no es válido'), { code: 'BAD_FLOAT' });
  }

  const db = getLocalDb();
  const clientCloseId = crypto.randomUUID();
  const email = getSession()?.email ?? null;

  const create = db.transaction(() => {
    const periodStart = getPeriodStart(db);
    const sales = periodSales(db, periodStart);

    const cash = sales
      .filter(s => s.payment_method === 'efectivo')
      .reduce((sum, s) => sum + s.total, 0);
    const transfer = sales
      .filter(s => s.payment_method === 'transferencia')
      .reduce((sum, s) => sum + s.total, 0);

    const expectedCash = float + cash;
    const openedAt = periodStart === BEGINNING_OF_TIME
      ? (sales[0]?.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19))
      : periodStart;

    const result = db.prepare(`
      INSERT INTO cash_closes
        (client_close_id, opened_at, opening_float, expected_cash, counted_cash,
         difference, expected_transfer, sales_count, note, account_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clientCloseId, openedAt, float, expectedCash, counted,
      counted - expectedCash, transfer, sales.length, note, email
    );
    const closeId = result.lastInsertRowid;

    enqueueOutbox(db, {
      op_type: 'cash_close.create',
      client_op_id: clientCloseId,
      local_ref_id: closeId,
      payload: {
        client_close_id: clientCloseId,
        opening_float: float,
        counted_cash: counted,
        note,
        closed_at: db.prepare('SELECT closed_at FROM cash_closes WHERE id = ?').get(closeId).closed_at,
        client_sale_ids: sales.map(s => s.client_sale_id),
      },
    });

    return db.prepare('SELECT * FROM cash_closes WHERE id = ?').get(closeId);
  });

  return create();
}

const listCashCloses = () =>
  getLocalDb().prepare('SELECT * FROM cash_closes ORDER BY closed_at DESC LIMIT 100').all();

// Saldo acumulado por cuenta. En una caja de escritorio suele haber una sola,
// pero si el dueño y un cajero se turnan en la misma máquina el patrón sigue
// valiendo — y es el mismo dato que muestra la web.
const cashCloseSummary = () =>
  getLocalDb().prepare(`
    SELECT account_email,
           COUNT(*) AS closes,
           COALESCE(SUM(difference), 0) AS total_difference,
           COALESCE(MIN(difference), 0) AS worst_difference,
           SUM(CASE WHEN difference < -0.5 THEN 1 ELSE 0 END) AS times_short,
           MAX(closed_at) AS last_close_at
    FROM cash_closes
    GROUP BY account_email
    ORDER BY total_difference ASC
  `).all();

// ---------------------------------------------------------------------------
// Arqueo de inventario
// ---------------------------------------------------------------------------

/**
 * Cuenta físico contra lo que el sistema cree tener, ajusta el stock local a
 * lo contado y deja la evidencia — las tres cosas en una sola transacción,
 * por la misma razón que en el servidor: sin ajustar, el mismo faltante
 * reaparece cada noche; sin registrar, ajustar sería tapar el problema.
 */
function createInventoryCountLocal({ items, note = null }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('Hay que contar al menos un producto'), { code: 'EMPTY_COUNT' });
  }
  for (const item of items) {
    const counted = Number(item.counted);
    if (!Number.isInteger(counted) || counted < 0) {
      throw Object.assign(
        new Error('Las cantidades contadas deben ser números enteros mayores o iguales a 0'),
        { code: 'BAD_COUNT' }
      );
    }
  }
  const ids = items.map(i => Number(i.product_id));
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('Un producto aparece repetido en el conteo'), { code: 'DUPLICATE' });
  }

  const db = getLocalDb();
  const clientCountId = crypto.randomUUID();
  const email = getSession()?.email ?? null;

  const create = db.transaction(() => {
    const lines = [];
    let unitsMissing = 0;
    let unitsExtra = 0;
    let valueMissing = 0;
    let withDifference = 0;

    for (const item of items) {
      const counted = Number(item.counted);
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(item.product_id);
      if (!product) {
        throw Object.assign(new Error('Producto no existe'), { code: 'NO_PRODUCT' });
      }

      const expected = product.stock;
      const difference = counted - expected;

      if (difference !== 0) {
        withDifference += 1;
        if (difference < 0) {
          unitsMissing += -difference;
          // A precio de VENTA: si la unidad se fue por una venta que nadie
          // registró, eso es el dinero que debió entrar a la caja.
          valueMissing += -difference * (product.sale_price || 0);
        } else {
          unitsExtra += difference;
        }
        db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(counted, product.id);
      }

      lines.push({
        product_id: product.id,
        product_name: product.name,
        expected,
        counted,
        difference,
        unit_cost: product.purchase_price || 0,
        unit_price: product.sale_price || 0,
      });
    }

    const result = db.prepare(`
      INSERT INTO inventory_counts
        (client_count_id, lines_count, products_with_difference,
         units_missing, units_extra, value_missing, note, account_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(clientCountId, lines.length, withDifference, unitsMissing, unitsExtra, valueMissing, note, email);
    const countId = result.lastInsertRowid;

    for (const line of lines) {
      db.prepare(`
        INSERT INTO inventory_count_items
          (count_id, product_id, product_name, expected, counted, difference, unit_cost, unit_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(countId, line.product_id, line.product_name, line.expected,
             line.counted, line.difference, line.unit_cost, line.unit_price);
    }

    enqueueOutbox(db, {
      op_type: 'inventory_count.create',
      client_op_id: clientCountId,
      local_ref_id: countId,
      payload: {
        client_count_id: clientCountId,
        note,
        // Ids LOCALES: el sync worker los traduce a server_id al armar el POST,
        // igual que hace con las líneas de una venta.
        items: lines.map(l => ({ local_product_id: l.product_id, counted: l.counted })),
      },
    });

    const count = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(countId);
    return { ...count, items: db.prepare(
      'SELECT * FROM inventory_count_items WHERE count_id = ? ORDER BY difference ASC, product_name ASC'
    ).all(countId) };
  });

  return create();
}

const listInventoryCounts = () =>
  getLocalDb().prepare('SELECT * FROM inventory_counts ORDER BY counted_at DESC LIMIT 100').all();

function getInventoryCount(id) {
  const db = getLocalDb();
  const count = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(id);
  if (!count) return null;
  const items = db.prepare(
    'SELECT * FROM inventory_count_items WHERE count_id = ? ORDER BY difference ASC, product_name ASC'
  ).all(id);
  return { ...count, items };
}

// ---------------------------------------------------------------------------
// Catálogo recibido del servidor
// ---------------------------------------------------------------------------

/**
 * Productos locales con cambios propios que todavía no subieron: los que
 * aparecen en una operación pendiente del outbox (su alta, una edición, un
 * borrado, o una línea de una venta o de un arqueo).
 *
 * 'conflict' NO cuenta a propósito: una operación que el servidor ya rechazó
 * no va a cambiar el stock de allá, así que la verdad es la del servidor. Si
 * contara, un solo rechazo dejaría ese producto sin actualizarse para siempre.
 */
function productsWithPendingChanges(db) {
  const ids = new Set();
  const rows = db.prepare(`SELECT payload FROM outbox WHERE status IN ('pending', 'syncing')`).all();
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch (_) { continue; }
    if (payload.local_product_id != null) ids.add(Number(payload.local_product_id));
    for (const item of payload.items || []) {
      if (item.local_product_id != null) ids.add(Number(item.local_product_id));
    }
  }
  return ids;
}

/**
 * Aplica el catálogo del servidor a esta caja: altas, cambios de precio y de
 * stock, y productos borrados en la web.
 *
 * La regla que evita perder ventas: un producto con cambios locales que todavía
 * no subieron NO se toca en esta pasada. Si la caja vendió 2 sin internet, el
 * servidor sigue diciendo "10"; copiar ese número borraría la venta del stock
 * local y se podría vender lo que ya no hay. Cuando esas operaciones suben, la
 * pasada siguiente lo actualiza con el número que ya las incluye.
 *
 * Los productos creados aquí que aún no tienen server_id tampoco se tocan: el
 * servidor todavía no sabe que existen.
 *
 * Si el servidor devuelve la lista vacía no se borra nada. Un dueño que borre
 * todo su catálogo es rarísimo; una caja que se queda sin productos en medio
 * de la jornada por una respuesta anómala es un desastre.
 */
function applyServerCatalog(serverProducts) {
  if (!Array.isArray(serverProducts)) throw new Error('El catálogo del servidor no es una lista');

  const db = getLocalDb();
  const stats = { created: 0, updated: 0, removed: 0, skipped: 0 };

  const apply = db.transaction(() => {
    const pending = productsWithPendingChanges(db);
    // Primero las filas visibles: si hay una copia oculta con el mismo
    // server_id (un duplicado que se unió al sincronizar), manda la visible.
    const locals = db.prepare(
      'SELECT * FROM products WHERE server_id IS NOT NULL ORDER BY deleted ASC, id ASC'
    ).all();
    const byServerId = new Map();
    for (const p of locals) if (!byServerId.has(p.server_id)) byServerId.set(p.server_id, p);

    const insert = db.prepare(`
      INSERT INTO products (server_id, name, purchase_price, sale_price, stock, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE products SET name = ?, purchase_price = ?, sale_price = ?, stock = ?, deleted = 0 WHERE id = ?
    `);

    const seen = new Set();
    for (const s of serverProducts) {
      const serverId = Number(s.id);
      seen.add(serverId);
      const values = [
        String(s.name),
        Number(s.purchase_price) || 0,
        Number(s.sale_price) || 0,
        Math.max(0, Math.trunc(Number(s.stock) || 0)),
      ];

      const local = byServerId.get(serverId);
      if (!local) {
        const createdAt = s.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19);
        insert.run(serverId, ...values, createdAt);
        stats.created++;
        continue;
      }
      if (pending.has(local.id)) { stats.skipped++; continue; }

      const differs =
        local.deleted === 1 ||
        local.name !== values[0] ||
        local.purchase_price !== values[1] ||
        local.sale_price !== values[2] ||
        local.stock !== values[3];
      if (differs) {
        update.run(...values, local.id);
        stats.updated++;
      }
    }

    if (serverProducts.length > 0) {
      const remove = db.prepare('UPDATE products SET deleted = 1 WHERE id = ?');
      for (const local of locals) {
        if (local.deleted || seen.has(local.server_id) || pending.has(local.id)) continue;
        remove.run(local.id);
        stats.removed++;
      }
    }
  });

  apply();
  stats.changed = stats.created + stats.updated + stats.removed > 0;
  return stats;
}

/**
 * Devuelve a 'pending' las operaciones que quedaron en 'syncing'.
 *
 * Una pasada del sync worker nunca empieza con otra en curso (el loop espera a
 * que termine para programar la siguiente), así que cualquier 'syncing' al
 * empezar es de una pasada que se cortó: la app se cerró o se colgó a mitad de
 * una petición. Antes quedaban así para siempre, porque getPendingOutbox solo
 * lee 'pending' y 'conflict'.
 *
 * Reintentarlas es seguro: ventas, cierres y arqueos llevan su id de
 * idempotencia, y un alta de producto repetida la une el servidor por nombre.
 */
function resetStuckSyncing() {
  return getLocalDb().prepare(`UPDATE outbox SET status = 'pending' WHERE status = 'syncing'`).run().changes;
}

module.exports = {
  getSession, setSession, updateSessionSettings, clearSession,
  getPendingOutbox, countPendingOutbox, enqueueOutbox, resetStuckSyncing,
  listProducts, createProduct, updateProduct, deleteProduct, applyServerCatalog,
  createSaleLocal, listSales, getSale,
  getDashboard,
  getCurrentCashPeriod, createCashCloseLocal, listCashCloses, cashCloseSummary,
  createInventoryCountLocal, listInventoryCounts, getInventoryCount,
};
