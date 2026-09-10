const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireOwner } = require('../middleware/auth');

// Antes del primer cierre no existe un corte anterior del cual partir. Este
// centinela ordena por debajo de cualquier fecha real ('0000-...' < '2026-...'
// como texto), así que el primer arqueo barre todas las ventas que nunca se
// han contado, sin depender de la zona horaria del servidor.
const BEGINNING_OF_TIME = '0000-01-01 00:00:00';

const isUniqueViolation = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
};

const findByClientCloseId = (db, userId, clientCloseId) =>
  db.execute({
    sql: 'SELECT * FROM cash_closes WHERE user_id = ? AND client_close_id = ?',
    args: [userId, clientCloseId],
  });

// Frontera del período abierto: el corte del último cierre.
const getPeriodStart = async (executor, userId) => {
  const result = await executor.execute({
    sql: 'SELECT closed_at FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC LIMIT 1',
    args: [userId],
  });
  return result.rows[0]?.closed_at || BEGINNING_OF_TIME;
};

// Ventas del período abierto, separadas por forma de cobro: solo el efectivo
// tiene que aparecer físicamente en la gaveta; las transferencias se muestran
// aparte como referencia.
//
// `created_at > periodStart` (estricto, no >=) para que una venta registrada
// exactamente en el segundo del corte anterior caiga en el período siguiente.
// En el peor caso se cuenta un período más tarde; nunca se cuenta dos veces.
const summarizePeriod = async (executor, userId, periodStart) => {
  const result = await executor.execute({
    sql: `SELECT
            COALESCE(SUM(CASE WHEN payment_method = 'efectivo'      THEN total ELSE 0 END), 0) AS cash,
            COALESCE(SUM(CASE WHEN payment_method = 'transferencia' THEN total ELSE 0 END), 0) AS transfer,
            COUNT(*)         AS count,
            MIN(created_at)  AS first_sale_at
          FROM sales
          WHERE user_id = ? AND created_at > ?`,
    args: [userId, periodStart],
  });
  return result.rows[0];
};

// Historial: solo el dueño. Cada fila lleva el efectivo esperado de su
// período, así que dejarlo abierto le daría al cajero justo el número que el
// conteo a ciegas le esconde.
router.get('/', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC LIMIT 100',
    args: [req.userId],
  });
  res.json(result.rows);
}));

// Describe el período que está por cerrarse — y NADA MÁS que eso.
//
// Deliberadamente no devuelve el efectivo esperado ni la cantidad de ventas.
// Ese es todo el punto del conteo a ciegas: el cajero declara lo que contó sin
// saber contra qué se va a comparar. Si el monto esperado viajara al navegador
// "solo para mostrarlo después", bastaría con abrir la pestaña de red para
// verlo antes de declarar, y la garantía se caería. El cálculo vive del lado
// del servidor y solo se revela junto con el resultado del arqueo.
router.get('/current', asyncHandler(async (req, res) => {
  const db = getDb();
  const periodStart = await getPeriodStart(db, req.userId);
  const summary = await summarizePeriod(db, req.userId, periodStart);
  const isFirstClose = periodStart === BEGINNING_OF_TIME;

  res.json({
    opened_at: isFirstClose ? summary.first_sale_at : periodStart,
    is_first_close: isFirstClose,
    has_sales: Number(summary.count) > 0,
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { counted_cash, opening_float = 0, note = null, client_close_id = null } = req.body;

  const counted = Number(counted_cash);
  if (!Number.isFinite(counted) || counted < 0) {
    return res.status(400).json({ error: 'El efectivo contado no es válido' });
  }
  const float = Number(opening_float);
  if (!Number.isFinite(float) || float < 0) {
    return res.status(400).json({ error: 'El fondo de caja no es válido' });
  }

  const db = getDb();

  // Idempotencia (camino rápido), igual que en ventas: un doble toque en
  // "Cerrar caja" no puede producir dos arqueos del mismo período.
  if (client_close_id) {
    const existing = await findByClientCloseId(db, req.userId, client_close_id);
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
    }
  }

  // Leer la frontera y escribir el cierre en la misma transacción: si dos
  // cierres se solaparan, ambos leerían el mismo corte anterior y el mismo
  // tramo de ventas quedaría contado dos veces.
  const tx = await db.transaction('write');
  try {
    const periodStart = await getPeriodStart(tx, req.userId);
    const summary = await summarizePeriod(tx, req.userId, periodStart);

    const expectedCash = float + Number(summary.cash);
    const isFirstClose = periodStart === BEGINNING_OF_TIME;
    // Un primer cierre sin ninguna venta no tiene fecha de apertura natural:
    // COALESCE deja que SQLite ponga la de ahora.
    const openedAt = isFirstClose ? summary.first_sale_at : periodStart;

    const inserted = await tx.execute({
      sql: `INSERT INTO cash_closes
              (user_id, client_close_id, opened_at, opening_float, expected_cash,
               counted_cash, difference, expected_transfer, sales_count, note)
            VALUES (?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        req.userId, client_close_id, openedAt, float, expectedCash,
        counted, counted - expectedCash,
        Number(summary.transfer), Number(summary.count), note,
      ],
    });
    const closeId = Number(inserted.lastInsertRowid);

    await tx.commit();

    const final = await db.execute({
      sql: 'SELECT * FROM cash_closes WHERE id = ?',
      args: [closeId],
    });
    return res.status(201).json(final.rows[0]);
  } catch (err) {
    await tx.rollback().catch(() => { /* la transacción ya estaba cerrada */ });

    // Dos peticiones idénticas a la vez: una perdió la carrera contra el índice
    // UNIQUE. Devolvemos el cierre que sí se registró.
    if (client_close_id && isUniqueViolation(err)) {
      const existing = await findByClientCloseId(db, req.userId, client_close_id);
      if (existing.rows[0]) {
        return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
      }
    }
    throw err;
  }
}));

module.exports = router;
