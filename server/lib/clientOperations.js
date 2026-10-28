const crypto = require('crypto');
const { getDb } = require('../db/database');

/**
 * Idempotencia por `operation_id` (opcional, en el cuerpo). Mismo patrón que
 * pwa_product_operations: el recibo se lee y se guarda DENTRO de la misma
 * transacción que la escritura, así un reintento (cola offline de Android)
 * devuelve la respuesta original en vez de aplicar el cambio otra vez.
 * Sin operation_id nada cambia. El mismo id con otra ruta o cuerpo distinto
 * es un 409, nunca una reaplicación silenciosa. Solo se guardan respuestas 2xx.
 */
class OperationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

// shortcut: el hash depende del orden de las claves del JSON; un cliente que reordene al reintentar recibe 409.
function operationOf(req) {
  const id = req.body?.operation_id;
  if (id === undefined || id === null) return null;
  if (typeof id !== 'string' || !id || id.length > 100) throw new OperationError(400, 'operation_id inválido');
  const { operation_id, ...rest } = req.body;
  return { userId: req.userId, id, endpoint: `${req.method} ${req.baseUrl}${req.path}`, hash: hashOf(rest) };
}

// {status, body} del recibo previo, o null si es la primera vez.
async function replay(tx, op) {
  const row = (await tx.execute({
    sql: 'SELECT endpoint, response FROM client_operations WHERE user_id = ? AND operation_id = ?',
    args: [op.userId, op.id],
  })).rows[0];
  if (!row) return null;
  const stored = JSON.parse(row.response);
  if (row.endpoint !== op.endpoint || stored.hash !== op.hash) {
    throw new OperationError(409, 'Este operation_id ya se usó con otra operación');
  }
  return stored;
}

const record = (tx, op, status, body) => tx.execute({
  sql: 'INSERT INTO client_operations (user_id, operation_id, endpoint, response) VALUES (?, ?, ?, ?)',
  args: [op.userId, op.id, op.endpoint, JSON.stringify({ hash: op.hash, status, body })],
});

/**
 * Para handlers que responden con res.status().json(): `work(db, res)` corre
 * con la transacción como `db` y un `res` que solo captura la respuesta.
 * Sin operation_id corre tal cual, sobre la conexión normal.
 */
async function withOperation(req, res, work) {
  let op;
  try { op = operationOf(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
  if (!op) return work(getDb(), res);

  const tx = await getDb().transaction('write');
  try {
    const prior = await replay(tx, op);
    if (prior) {
      await tx.rollback();
      return res.status(prior.status).json(prior.body);
    }
    const cap = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await work(tx, cap);
    if (cap.code >= 200 && cap.code < 300) {
      await record(tx, op, cap.code, cap.body);
      await tx.commit();
    } else {
      await tx.rollback();
    }
    return res.status(cap.code).json(cap.body);
  } catch (e) {
    await tx.rollback().catch(() => {});
    if (e instanceof OperationError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}

module.exports = { OperationError, operationOf, replay, record, withOperation };
