/**
 * Procesador de trabajos de auditoría.
 *
 * Lo usan el cron externo y el script local de Node. Recibe un cliente
 * libSQL (el mismo `execute({ sql, args })` en ambos entornos), reclama
 * trabajos, arma el snapshot y guarda el informe.
 *
 * Si el modelo falla, el informe determinista siempre queda guardado: la
 * auditoría no depende de que Groq esté disponible.
 */

import {
  PROMPT_VERSION,
  SEVERITY_ORDER,
  buildAuditSnapshot,
  buildFallbackReport,
  summarizeSnapshot,
  toPromptPayload,
  validateModelOutput,
} from './auditRules.mjs';

const rows = async (db, sql, args = []) => (await db.execute({ sql, args })).rows;

/** Llamadas al modelo ya registradas hoy para una tienda (tope de costo). */
export async function countModelCallsToday(db, userId) {
  const result = await rows(db,
    `SELECT COUNT(*) AS n FROM audit_reports
      WHERE user_id = ? AND model IS NOT NULL AND date(created_at) = date('now')`,
    [userId]);
  return Number(result[0]?.n) || 0;
}

const nextAttemptSql = (attempts) => {
  const minutes = Math.min(Math.max(attempts, 1), 5);
  return new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
};

export async function recoverStaleJobs(db) {
  // Un trabajo que ya agotó sus intentos no vuelve a la cola: si el worker
  // murió tres veces procesándolo, se marca fallido para revisión manual.
  await db.execute({
    sql: `UPDATE audit_jobs
             SET status = 'failed',
                 last_error = COALESCE(last_error, 'El worker se interrumpió antes de terminar'),
                 lease_until = NULL,
                 updated_at = datetime('now')
           WHERE status = 'processing'
             AND lease_until IS NOT NULL
             AND lease_until < datetime('now')
             AND attempts >= 3`,
  });
  const result = await db.execute({
    sql: `UPDATE audit_jobs
             SET status = 'pending', lease_until = NULL, updated_at = datetime('now')
           WHERE status = 'processing'
             AND lease_until IS NOT NULL
             AND lease_until < datetime('now')
             AND attempts < 3`,
  });
  return Number(result.rowsAffected) || 0;
}

/**
 * Reclama trabajos de forma atómica: varias invocaciones del worker pueden
 * correr a la vez y solo una debe quedarse con cada fila.
 */
export async function claimAuditJobs(db, limit = 5) {
  const candidates = await rows(db,
    `SELECT * FROM audit_jobs
      WHERE status = 'pending' AND next_attempt_at <= datetime('now')
      ORDER BY id ASC LIMIT ?`, [limit]);
  const claimed = [];
  for (const job of candidates) {
    const result = await db.execute({
      sql: `UPDATE audit_jobs
               SET status = 'processing',
                   attempts = attempts + 1,
                   lease_until = datetime('now', '+2 minutes'),
                   updated_at = datetime('now')
             WHERE id = ? AND status = 'pending'`,
      args: [job.id],
    });
    if (Number(result.rowsAffected) === 1) {
      claimed.push({ ...job, attempts: Number(job.attempts) + 1 });
    }
  }
  return claimed;
}

async function fetchClose(db, job) {
  return (await rows(db,
    'SELECT * FROM cash_closes WHERE id = ? AND user_id = ?',
    [job.cash_close_id, job.user_id]))[0] || null;
}

async function fetchSnapshotInput(db, close) {
  const userId = close.user_id;
  const closeId = close.id;

  const sales = await rows(db,
    `SELECT id, total, payment_method, transfer_amount, foreign_currency, foreign_amount,
            exchange_rate, shop_rate, account_id, account_email, created_at
       FROM sales
      WHERE user_id = ? AND cash_close_id = ?
      ORDER BY created_at ASC, id ASC`, [userId, closeId]);

  const purchases = await rows(db,
    `SELECT id, foreign_currency, foreign_amount, exchange_rate, shop_rate, cup_amount,
            account_id, account_email, created_at
       FROM currency_purchases
      WHERE user_id = ? AND cash_close_id = ?
      ORDER BY created_at ASC, id ASC`, [userId, closeId]);

  const withdrawals = await rows(db,
    `SELECT id, method, amount, account_id, account_email, created_at
       FROM cash_withdrawals
      WHERE user_id = ? AND cash_close_id = ? AND voided_at IS NULL
      ORDER BY created_at ASC, id ASC`, [userId, closeId]);

  const corrections = await rows(db,
    `SELECT correction_revision, account_id, account_email, before, after, created_at
       FROM cash_close_corrections
      WHERE user_id = ? AND cash_close_id = ?
      ORDER BY correction_revision ASC`, [userId, closeId]);

  // La ventana se mide contra la fecha del cierre, no contra "ahora": si un
  // trabajo se reintenta días después, el patrón debe seguir siendo el mismo.
  const priorCloses = await rows(db,
    `SELECT id, closed_at, difference, difference_usd, difference_eur,
            account_id, account_email, register_id
       FROM cash_closes
      WHERE user_id = ? AND id <> ?
        AND datetime(closed_at) >= datetime(?, '-30 days')
        AND datetime(closed_at) <= datetime(?)
      ORDER BY closed_at DESC
      LIMIT 200`, [userId, closeId, close.closed_at, close.closed_at]);

  const previousClose = (close.register_id == null
    ? await rows(db,
      `SELECT * FROM cash_closes
        WHERE user_id = ? AND id <> ? AND register_id IS NULL
          AND (closed_at < ? OR (closed_at = ? AND id < ?))
        ORDER BY closed_at DESC, id DESC LIMIT 1`,
      [userId, closeId, close.closed_at, close.closed_at, closeId])
    : await rows(db,
      `SELECT * FROM cash_closes
        WHERE user_id = ? AND id <> ? AND register_id = ?
          AND (closed_at < ? OR (closed_at = ? AND id < ?))
        ORDER BY closed_at DESC, id DESC LIMIT 1`,
      [userId, closeId, close.register_id, close.closed_at, close.closed_at, closeId]))[0] || null;

  const day = String(close.closed_at || '').slice(0, 10);
  const sameRegisterClosesToday = Number((await rows(db,
    close.register_id == null
      ? `SELECT COUNT(*) AS n FROM cash_closes
          WHERE user_id = ? AND id <> ? AND register_id IS NULL AND substr(closed_at, 1, 10) = ?`
      : `SELECT COUNT(*) AS n FROM cash_closes
          WHERE user_id = ? AND id <> ? AND register_id = ? AND substr(closed_at, 1, 10) = ?`,
    close.register_id == null
      ? [userId, closeId, day]
      : [userId, closeId, close.register_id, day]))[0]?.n) || 0;

  const rejectedSales = await rows(db,
    `SELECT total FROM rejected_sales
      WHERE user_id = ? AND reviewed_at IS NULL
        AND datetime(COALESCE(sold_at, reported_at)) BETWEEN datetime(?, '-1 day') AND datetime(?, '+1 day')`,
    [userId, close.opened_at, close.closed_at]);

  const openSalesOlderThan24h = Number((await rows(db,
    `SELECT COUNT(*) AS n FROM sales
      WHERE user_id = ? AND cash_close_id IS NULL AND datetime(created_at) <= datetime(?, '-1 day')`,
    [userId, close.closed_at]))[0]?.n) || 0;

  return {
    close,
    sales,
    purchases,
    withdrawals,
    corrections,
    priorCloses,
    rejectedSales,
    context: {
      previousClose,
      previousRegisterClose: previousClose,
      sameRegisterClosesToday,
      openSalesOlderThan24h,
    },
  };
}

async function existingReport(db, job) {
  return (await rows(db,
    `SELECT id, status, model FROM audit_reports
      WHERE user_id = ? AND cash_close_id = ? AND source_revision = ?`,
    [job.user_id, job.cash_close_id, job.source_revision]))[0] || null;
}

async function markDone(db, job) {
  await db.execute({
    sql: `UPDATE audit_jobs
             SET status = 'done', last_error = NULL, lease_until = NULL, updated_at = datetime('now')
           WHERE id = ?`, args: [job.id],
  });
}

async function markRetry(db, job, error, maxAttempts) {
  const failed = Number(job.attempts) >= maxAttempts;
  await db.execute({
    sql: `UPDATE audit_jobs
             SET status = ?, next_attempt_at = ?, last_error = ?, lease_until = NULL, updated_at = datetime('now')
           WHERE id = ?`,
    args: [failed ? 'failed' : 'pending', nextAttemptSql(job.attempts), String(error?.message || error).slice(0, 2000), job.id],
  });
}

const betterSeverity = (left, right) => (SEVERITY_ORDER[left] >= SEVERITY_ORDER[right] ? left : right);

/**
 * Procesa un trabajo ya reclamado.
 *
 * `callModel` es opcional: si no se pasa (sin API key, tope diario alcanzado
 * o pruebas), se guarda el informe determinista. Debe devolver
 * `{ content, model, tokens_in, tokens_out }`.
 */
export async function processAuditJob(db, job, { callModel = null, maxAttempts = 3 } = {}) {
  const started = Date.now();
  try {
    const previous = await existingReport(db, job);
    if (previous && previous.status === 'ready') {
      await markDone(db, job);
      return { status: 'skipped', reportId: previous.id };
    }

    const close = await fetchClose(db, job);
    if (!close) throw new Error('El cierre ya no existe');

    const input = await fetchSnapshotInput(db, close);
    const snapshot = buildAuditSnapshot(input);
    const fallback = buildFallbackReport(snapshot);

    let report = {
      ...fallback,
      // Un cierre sin anomalías se guarda como informe determinista listo,
      // sin haber llamado al modelo. Si había anomalías y el modelo falla,
      // el estado pasa a 'fallback' y se conserva el motivo.
      status: 'ready',
      model: null,
      tokens_in: null,
      tokens_out: null,
      error: null,
    };

    const shouldAskModel = callModel
      && (snapshot.severity === 'critical' || snapshot.severity === 'warning');

    if (shouldAskModel) {
      try {
        const result = await callModel(toPromptPayload(snapshot));
        const validated = validateModelOutput(result?.content);
        if (validated) {
          report = {
            ...validated,
            // La severidad la mandan las reglas, no el modelo.
            severity: betterSeverity(snapshot.severity, fallback.severity),
            status: 'ready',
            model: result.model || null,
            tokens_in: result.tokens_in ?? null,
            tokens_out: result.tokens_out ?? null,
            error: null,
          };
        } else {
          report.status = 'fallback';
          report.error = 'El modelo devolvió una respuesta con formato inválido';
        }
      } catch (error) {
        report.status = 'fallback';
        report.error = String(error?.message || error).slice(0, 2000);
      }
    }

    const duration = Date.now() - started;
    const inserted = await db.execute({
      sql: `INSERT INTO audit_reports
              (user_id, cash_close_id, job_id, source_revision, scope, severity, headline, summary,
               findings_json, metrics_json, signals_json, questions_json, next_step,
               model, prompt_version, tokens_in, tokens_out, duration_ms, status, error, created_at)
            VALUES (?, ?, ?, ?, 'cash_close', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(user_id, cash_close_id, source_revision) DO UPDATE SET
              job_id = excluded.job_id,
              severity = excluded.severity,
              headline = excluded.headline,
              summary = excluded.summary,
              findings_json = excluded.findings_json,
              metrics_json = excluded.metrics_json,
              signals_json = excluded.signals_json,
              questions_json = excluded.questions_json,
              next_step = excluded.next_step,
              model = excluded.model,
              prompt_version = excluded.prompt_version,
              tokens_in = excluded.tokens_in,
              tokens_out = excluded.tokens_out,
              duration_ms = excluded.duration_ms,
              status = excluded.status,
              error = excluded.error,
              created_at = excluded.created_at`,
      args: [
        job.user_id,
        job.cash_close_id,
        job.id,
        job.source_revision,
        report.severity,
        report.headline,
        report.summary,
        JSON.stringify(report.findings || []),
        JSON.stringify(snapshot.metrics),
        JSON.stringify(snapshot.signals),
        JSON.stringify(report.questions || []),
        report.next_step || null,
        report.model,
        PROMPT_VERSION,
        report.tokens_in,
        report.tokens_out,
        duration,
        report.status,
        report.error,
      ],
    });

    await markDone(db, job);
    return {
      status: report.status,
      reportId: Number(inserted.lastInsertRowid) || null,
      severity: report.severity,
      usedModel: !!report.model,
    };
  } catch (error) {
    await markRetry(db, job, error, maxAttempts);
    return { status: 'retry', error: String(error?.message || error) };
  }
}

export { summarizeSnapshot };
