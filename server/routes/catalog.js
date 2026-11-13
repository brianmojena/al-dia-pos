const express = require('express');
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { validQuantity, roundQty } = require('../lib/units');
const { notify } = require('../lib/push');

/**
 * Tienda online por negocio: catálogo público + reservas.
 *
 * publicRouter va montado SIN requireAuth (app.js): el slug compartible es la
 * credencial de lectura del cliente, igual que el código de un solo uso es la
 * credencial al activar una caja compartida. Lo que expone es mínimo y está
 * pensado para eso: nombre de la tienda, nota, teléfono de contacto y por
 * producto nombre/precio/disponibilidad. NUNCA sale el costo de compra, el
 * stock exacto ni las tasas de divisa del negocio (mismo criterio con el que
 * lib/sharedSnapshot.js le quita los costos al cajero).
 *
 * ownerRouter (configuración y reservas) es solo del dueño; app.js le pone
 * requireAuth + requireOwner como a /api/accounting.
 */

// El slug se genera del nombre de la tienda y el dueño lo puede cambiar.
// "mi-tienda" en vez del id numérico: el enlace se comparte por WhatsApp.
const SLUG_MAX = 60;

const normalizeSlug = (value) =>
  String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX).replace(/-+$/g, '');

// Rutas que ya ocupan el cliente (App.jsx) y la API: un negocio no puede
// apoderarse de /login ni de /api.
const RESERVED_SLUGS = new Set([
  'api', 'www', 'app', 'admin',
  'login', 'register', 'recuperar', 'bienvenida', 'activar', 'cajero',
  'pos', 'products', 'sales', 'dashboard', 'caja', 'divisas', 'almacen',
  'inventario', 'contabilidad', 'auditoria', 'cajeros', 'importar',
  't', 'tienda', 'catalogo', 'catalog',
]);

const validSlug = (slug) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) && slug.length >= 3;

/** Busca el primer sufijo libre: mi-tienda, mi-tienda-2, mi-tienda-3… */
async function uniqueSlug(db, base, excludeUserId = null) {
  let candidate = base.slice(0, SLUG_MAX - 8) || 'tienda';
  for (let n = 2; n <= 500; n += 1) {
    const taken = (await db.execute({
      sql: 'SELECT id FROM users WHERE catalog_slug = ?' + (excludeUserId ? ' AND id != ?' : ''),
      args: excludeUserId ? [candidate, excludeUserId] : [candidate],
    })).rows.length > 0;
    if (!taken) return candidate;
    candidate = `${base.slice(0, SLUG_MAX - 8)}-${n}`;
  }
  return null;
}

// --- límite de peticiones anónimas -------------------------------------------
// El deploy es serverless: cada instancia tiene su mapa (memoria efímera), así
// que esto es una válvula best-effort, no un muro. La validación estricta de
// cada reserva es la barrera de verdad; esto solo frena el martilleo obvio.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const rateBuckets = new Map();

function tooManyRequests(key, now = Date.now()) {
  if (rateBuckets.size > 50000) {
    for (const [k, b] of rateBuckets) {
      if (now - b.start >= RATE_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

// --- límites de una reserva ---------------------------------------------------
const MAX_ITEMS = 30;
const MAX_NAME = 80;
const MAX_PHONE = 30;
const MAX_NOTE = 300;
const MAX_QUANTITY = 9999;

const RESERVATION_STATES = ['pendiente', 'confirmada', 'entregada', 'anulada'];
// La reserva no bloquea stock y el dueño decide el resto del camino: una
// entrega se anula (se acabó la mercancía, el cliente desistió) pero una
// anulada no se reabre — se pide de nuevo.
const TRANSITIONS = {
  pendiente: ['confirmada', 'anulada'],
  confirmada: ['entregada', 'anulada'],
  entregada: [],
  anulada: [],
};

const parseItems = (row) => {
  try { return JSON.parse(row.items); } catch { return []; }
};

// --- catálogo público ----------------------------------------------------------
const publicRouter = express.Router();

publicRouter.get('/:slug', asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const store = (await getDb().execute({
    sql: 'SELECT id, store_name, catalog_note, catalog_phone, catalog_enabled FROM users WHERE catalog_slug = ?',
    args: [slug],
  })).rows[0];
  if (!store || Number(store.catalog_enabled) !== 1) {
    return res.status(404).json({ error: 'Esta tienda no tiene catálogo disponible' });
  }
  const rows = (await getDb().execute({
    sql: `SELECT id, name, sale_price, unit, pack_size, pack_price, stock, track_stock
          FROM products WHERE user_id = ? AND catalog_visible = 1 ORDER BY name ASC`,
    args: [store.id],
  })).rows;
  res.json({
    store: {
      name: store.store_name,
      note: store.catalog_note ?? null,
      phone: store.catalog_phone ?? null,
    },
    products: rows.map((p) => ({
      id: p.id,
      name: p.name,
      sale_price: Number(p.sale_price),
      unit: p.unit ?? null,
      pack_size: p.pack_size ?? null,
      pack_price: p.pack_price ?? null,
      // El cliente solo pregunta "¿hay?": disponible/agotado, nunca cuánto queda.
      available: Number(p.track_stock) !== 1 || Number(p.stock) > 0,
    })),
  });
}));

publicRouter.post('/:slug/reservations', asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const store = (await getDb().execute({
    sql: 'SELECT id, store_name, catalog_enabled FROM users WHERE catalog_slug = ?',
    args: [slug],
  })).rows[0];
  if (!store || Number(store.catalog_enabled) !== 1) {
    return res.status(404).json({ error: 'Esta tienda no tiene catálogo disponible' });
  }
  if (tooManyRequests(`${slug}|${req.ip || 'desconocida'}`)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes seguidas; espera un momento y prueba otra vez' });
  }

  const body = req.body || {};
  const clientReservationId = typeof body.client_reservation_id === 'string' ? body.client_reservation_id : '';
  if (clientReservationId.length > 100) {
    return res.status(400).json({ error: 'Identificador de reserva inválido' });
  }
  const customerName = typeof body.customer_name === 'string' ? body.customer_name.trim().replace(/\s+/g, ' ') : '';
  const customerPhone = typeof body.customer_phone === 'string' ? body.customer_phone.trim().replace(/\s+/g, ' ') : '';
  const customerNote = typeof body.customer_note === 'string' ? body.customer_note.trim() : '';
  if (!customerName || customerName.length > MAX_NAME) {
    return res.status(400).json({ error: 'Falta tu nombre (máximo 80 caracteres)' });
  }
  if (!customerPhone || customerPhone.length > MAX_PHONE) {
    return res.status(400).json({ error: 'Falta un teléfono para contactarte (máximo 30 caracteres)' });
  }
  if (customerNote.length > MAX_NOTE) {
    return res.status(400).json({ error: `La nota no puede pasar de ${MAX_NOTE} caracteres` });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'No hay productos en la reserva' });
  }
  if (body.items.length > MAX_ITEMS) {
    return res.status(400).json({ error: `Máximo ${MAX_ITEMS} productos por reserva` });
  }

  // La visibilidad y la disponibilidad se revalidan aquí: el cliente no es de fiar.
  const visible = (await getDb().execute({
    sql: `SELECT id, name, sale_price, unit, pack_size, stock, track_stock
          FROM products WHERE user_id = ? AND catalog_visible = 1`,
    args: [store.id],
  })).rows;
  const byId = new Map(visible.map((p) => [Number(p.id), p]));

  const errors = [];
  const frozen = [];
  body.items.forEach((item, index) => {
    const product = byId.get(Number(item?.product_id));
    if (!product) {
      errors.push({ index, error: 'Ese producto ya no está en el catálogo' });
      return;
    }
    const unit = product.unit ?? null;
    // Por pieza: entero desde 1. Por peso: desde 1 gramo (0.001), hasta 3 decimales.
    if (!validQuantity(item.quantity, unit, unit ? { min: 0.001 } : { min: 1 }) || Number(item.quantity) > MAX_QUANTITY) {
      errors.push({ index, error: `La cantidad de "${product.name}" no es válida` });
      return;
    }
    if (Number(product.track_stock) === 1 && Number(product.stock) <= 0) {
      errors.push({ index, error: `"${product.name}" está agotado` });
      return;
    }
    frozen.push({
      product_id: product.id,
      product_name: product.name,
      quantity: roundQty(Number(item.quantity)),
      unit,
      sale_price: Number(product.sale_price),
      pack_size: product.pack_size ?? null,
    });
  });
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Hay productos que ya no se pueden reservar', items: errors });
  }

  const db = getDb();
  // Idempotencia, mismo contrato que las ventas: un reintento con el mismo id
  // devuelve la reserva que ya se creó en vez de duplicarla.
  if (clientReservationId) {
    const existing = (await db.execute({
      sql: 'SELECT * FROM product_reservations WHERE user_id = ? AND client_reservation_id = ?',
      args: [store.id, clientReservationId],
    })).rows[0];
    if (existing) return res.status(200).json({ ...existing, items: parseItems(existing) });
  }

  const itemsJson = JSON.stringify(frozen);
  const summary = frozen
    .map((i) => `${i.quantity}${i.unit ? i.unit : ''} × ${i.product_name}`)
    .join(', ');
  try {
    const insert = await db.execute({
      sql: `INSERT INTO product_reservations
              (user_id, client_reservation_id, customer_name, customer_phone, customer_note, items)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [store.id, clientReservationId || null, customerName, customerPhone, customerNote || null, itemsJson],
    });
    const created = (await db.execute({
      sql: 'SELECT * FROM product_reservations WHERE id = ?',
      args: [Number(insert.lastInsertRowid)],
    })).rows[0];
    // El aviso no puede romper ni retrasar la respuesta de la reserva.
    notify(db, store.id, {
      title: `Reserva de ${customerName}`,
      body: `${frozen.length} producto(s) · ${customerPhone} · ${summary.slice(0, 120)}`,
    });
    return res.status(201).json({ ...created, items: frozen });
  } catch (err) {
    // Dos peticiones idénticas a la vez: la UNIQUE rechaza la segunda y se
    // responde con la primera, como si hubiera llegado después.
    if (clientReservationId && /UNIQUE/.test(String(err.message))) {
      const existing = (await db.execute({
        sql: 'SELECT * FROM product_reservations WHERE user_id = ? AND client_reservation_id = ?',
        args: [store.id, clientReservationId],
      })).rows[0];
      if (existing) return res.status(200).json({ ...existing, items: parseItems(existing) });
    }
    throw err;
  }
}));

// --- configuración y reservas del dueño ----------------------------------------
const ownerRouter = express.Router();

const storeShape = (row) => ({
  store_name: row.store_name,
  catalog_enabled: Number(row.catalog_enabled) === 1,
  catalog_slug: row.catalog_slug ?? null,
  catalog_note: row.catalog_note ?? null,
  catalog_phone: row.catalog_phone ?? null,
});

const readStore = async (db, userId) => (await db.execute({
  sql: 'SELECT store_name, catalog_slug, catalog_enabled, catalog_note, catalog_phone FROM users WHERE id = ?',
  args: [userId],
})).rows[0];

ownerRouter.get('/', asyncHandler(async (req, res) => {
  res.json(storeShape(await readStore(getDb(), req.userId)));
}));

ownerRouter.put('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const current = await readStore(db, req.userId);
  const body = req.body || {};
  const updates = {};

  if ('catalog_enabled' in body) {
    if (body.catalog_enabled !== true && body.catalog_enabled !== false
        && body.catalog_enabled !== 0 && body.catalog_enabled !== 1) {
      return res.status(400).json({ error: 'El valor de activar/desactivar no es válido' });
    }
    updates.catalog_enabled = body.catalog_enabled === true || body.catalog_enabled === 1 ? 1 : 0;
  }

  if ('catalog_slug' in body) {
    const raw = body.catalog_slug === null || body.catalog_slug === '' ? '' : normalizeSlug(body.catalog_slug);
    if (raw) {
      if (!validSlug(raw)) {
        return res.status(400).json({ error: 'El enlace necesita al menos 3 caracteres, con letras, números o guiones' });
      }
      if (RESERVED_SLUGS.has(raw)) {
        return res.status(400).json({ error: 'Ese enlace está reservado; elige otro' });
      }
      if (raw !== current.catalog_slug) {
        const taken = (await db.execute({
          sql: 'SELECT id FROM users WHERE catalog_slug = ? AND id != ?',
          args: [raw, req.userId],
        })).rows.length > 0;
        if (taken) return res.status(409).json({ error: 'Ese enlace ya lo usa otra tienda; elige otro' });
      }
      updates.catalog_slug = raw;
    } else {
      updates.catalog_slug = null;
    }
  }

  if ('catalog_note' in body) {
    const note = body.catalog_note === null || body.catalog_note === '' ? null : String(body.catalog_note).trim();
    if (note && note.length > 200) {
      return res.status(400).json({ error: 'La nota no puede pasar de 200 caracteres' });
    }
    updates.catalog_note = note;
  }
  if ('catalog_phone' in body) {
    const phone = body.catalog_phone === null || body.catalog_phone === '' ? null : String(body.catalog_phone).trim();
    if (phone && phone.length > 30) {
      return res.status(400).json({ error: 'El teléfono no puede pasar de 30 caracteres' });
    }
    updates.catalog_phone = phone;
  }

  // Activar sin enlace: se genera del nombre de la tienda y se busca el primer
  // sufijo libre — el dueño no tiene que saber qué es un slug.
  const enabled = 'catalog_enabled' in updates ? updates.catalog_enabled : Number(current.catalog_enabled);
  const slugAfter = 'catalog_slug' in updates ? updates.catalog_slug : current.catalog_slug;
  if (enabled === 1 && !slugAfter) {
    updates.catalog_slug = await uniqueSlug(db, normalizeSlug(current.store_name), req.userId);
    if (!updates.catalog_slug) {
      return res.status(409).json({ error: 'No se pudo generar un enlace libre; escribe uno a mano' });
    }
  }

  const keys = Object.keys(updates);
  if (keys.length > 0) {
    await db.execute({
      sql: `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      args: [...keys.map((k) => updates[k]), req.userId],
    });
  }
  res.json(storeShape(await readStore(db, req.userId)));
}));

ownerRouter.get('/reservations', asyncHandler(async (req, res) => {
  const status = req.query.status;
  if (status !== undefined && !RESERVATION_STATES.includes(String(status))) {
    return res.status(400).json({ error: 'Estado de reserva no válido' });
  }
  const rows = (await getDb().execute({
    sql: `SELECT * FROM product_reservations WHERE user_id = ? ${status ? 'AND status = ?' : ''}
          ORDER BY created_at DESC, id DESC LIMIT 200`,
    args: status ? [req.userId, String(status)] : [req.userId],
  })).rows;

  // Estado actual de cada producto pedido: la reserva guarda su copia congelada,
  // pero al confirmar el dueño quiere saber si hoy sigue habiendo.
  const productIds = [...new Set(rows.flatMap((r) => parseItems(r).map((i) => Number(i.product_id))))];
  const products = new Map();
  if (productIds.length > 0) {
    const placeholders = productIds.map(() => '?').join(', ');
    for (const p of (await getDb().execute({
      sql: `SELECT id, name, stock, track_stock FROM products WHERE user_id = ? AND id IN (${placeholders})`,
      args: [req.userId, ...productIds],
    })).rows) products.set(Number(p.id), p);
  }

  res.json(rows.map((row) => ({
    ...row,
    items: parseItems(row).map((item) => {
      const product = products.get(Number(item.product_id));
      return {
        ...item,
        current_name: product?.name ?? null,
        current_available: product
          ? Number(product.track_stock) !== 1 || Number(product.stock) > 0
          : null,
      };
    }),
  })));
}));

ownerRouter.patch('/reservations/:id', asyncHandler(async (req, res) => {
  const status = req.body?.status;
  if (!RESERVATION_STATES.includes(status)) {
    return res.status(400).json({ error: 'Estado de reserva no válido' });
  }
  const db = getDb();
  const current = (await db.execute({
    sql: 'SELECT id, status FROM product_reservations WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.userId],
  })).rows[0];
  if (!current) return res.status(404).json({ error: 'Reserva no encontrada' });
  if (!TRANSITIONS[current.status].includes(status)) {
    return res.status(400).json({ error: `Una reserva ${current.status} no puede pasar a ${status}` });
  }
  // El WHERE repite el estado leído: dos dueños cambiando a la vez no se pisan.
  const updated = await db.execute({
    sql: `UPDATE product_reservations SET status = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND status = ?`,
    args: [status, current.id, req.userId, current.status],
  });
  if (updated.rowsAffected === 0) {
    return res.status(409).json({ error: 'La reserva ya cambió de estado; actualiza y prueba otra vez' });
  }
  const row = (await db.execute({
    sql: 'SELECT * FROM product_reservations WHERE id = ?',
    args: [current.id],
  })).rows[0];
  res.json({ ...row, items: parseItems(row) });
}));

module.exports = { publicRouter, ownerRouter };
