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
  try {
    const result = await db.execute({
      sql: `INSERT OR IGNORE INTO audit_jobs (user_id, cash_close_id, kind, source_revision)
            VALUES (?, ?, ?, ?)`,
      args: [userId, cashCloseId, kind, revision],
    });
    return Number(result.rowsAffected) > 0;
  } catch (error) {
    console.error('audit: no se pudo encolar el cierre', error.message);
    return null;
  }
}

module.exports = { enqueueAuditJob };
