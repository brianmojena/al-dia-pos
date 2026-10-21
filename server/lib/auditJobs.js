'use strict';

const { AUDIT_ENABLED } = require('../config');

/**
 * Encola un cierre para que el worker de auditoría lo analice.
 *
 * Es deliberadamente best-effort: si la tabla no existe, Turso está lento o
 * el flag está apagado, el cierre ya se guardó y debe responder igual. El
 * cajero no puede quedarse esperando a que la IA esté disponible.
 *
 * La clave única (user_id, cash_close_id, kind, source_revision) hace que un
 * reintento del mismo cierre no genere dos trabajos ni dos cobros de tokens.
 */
async function enqueueAuditJob(db, { userId, cashCloseId, kind = 'cash_close', revision = 0 }) {
  if (!AUDIT_ENABLED) return null;
  let timer;
  try {
    const write = db.execute({
      sql: `INSERT OR IGNORE INTO audit_jobs (user_id, cash_close_id, kind, source_revision)
            VALUES (?, ?, ?, ?)`,
      args: [userId, cashCloseId, kind, revision],
    });
    // El cierre ya está confirmado. Un servicio lento de auditoría no debe
    // dejar al cajero esperando ni hacerle repetir un cierre que sí se guardó.
    const result = await Promise.race([
      write,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    if (!result) return null;
    return Number(result.rowsAffected) > 0;
  } catch (error) {
    console.error('audit: no se pudo encolar el cierre', error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enqueueAuditJob };
