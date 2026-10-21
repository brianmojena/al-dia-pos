'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { requireOwner, requireAdmin } = require('../middleware/auth');

const ownerRouter = express.Router();
const adminRouter = express.Router();

const parseJson = (value, fallback) => {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch (_) {
    return fallback;
  }
};

const clampLimit = (value, fallback = 50, max = 200) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const severityFilter = (value) => (
  ['ok', 'info', 'warning', 'critical'].includes(value) ? value : null
);

const asReport = (row) => ({
  id: Number(row.id),
  cash_close_id: Number(row.cash_close_id),
  source_revision: Number(row.source_revision) || 0,
  scope: row.scope,
  severity: row.severity,
  headline: row.headline,
  summary: row.summary,
  findings: parseJson(row.findings_json, []),
  metrics: parseJson(row.metrics_json, {}),
  signals: parseJson(row.signals_json, []),
  questions: parseJson(row.questions_json, []),
  next_step: row.next_step || null,
  model: row.model,
  prompt_version: row.prompt_version,
  tokens_in: row.tokens_in == null ? null : Number(row.tokens_in),
  tokens_out: row.tokens_out == null ? null : Number(row.tokens_out),
  duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
  status: row.status,
  error: row.error,
  created_at: row.created_at,
  close: row.closed_at == null ? null : {
    closed_at: row.closed_at,
    opened_at: row.opened_at,
    difference: row.difference,
    difference_usd: row.difference_usd,
    difference_eur: row.difference_eur,
    register_id: row.register_id,
    cashier_email: row.account_email,
    expected_cash: row.expected_cash,
    counted_cash: row.counted_cash,
  },
});

const ownerSelect = `
  SELECT r.*, c.closed_at, c.opened_at, c.difference, c.difference_usd, c.difference_eur,
         c.register_id, c.account_email, c.expected_cash, c.counted_cash
    FROM audit_reports r
    LEFT JOIN cash_closes c ON c.id = r.cash_close_id AND c.user_id = r.user_id`;

/** Informes de la tienda del dueño autenticado. */
ownerRouter.get('/reports', requireOwner, async (req, res, next) => {
  try {
    const limit = clampLimit(req.query.limit);
    const severity = severityFilter(req.query.severity);
    const before = Number(req.query.before) || null;
    const clauses = ['r.user_id = ?'];
    const args = [req.userId];
    if (severity) { clauses.push('r.severity = ?'); args.push(severity); }
    if (before) { clauses.push('r.id < ?'); args.push(before); }
    args.push(limit);

    const result = await getDb().execute({
      sql: `${ownerSelect} WHERE ${clauses.join(' AND ')} ORDER BY r.id DESC LIMIT ?`,
      args,
    });
    res.json(result.rows.map(asReport));
  } catch (error) { next(error); }
});

/** Detalle de un informe, siempre dentro de la tienda del dueño. */
ownerRouter.get('/reports/:id', requireOwner, async (req, res, next) => {
  try {
    const result = await getDb().execute({
      sql: `${ownerSelect} WHERE r.id = ? AND r.user_id = ?`,
      args: [req.params.id, req.userId],
    });
    if (!result.rows[0]) return res.status(404).json({ error: 'Informe no encontrado' });
    res.json(asReport(result.rows[0]));
  } catch (error) { next(error); }
});

/** Resumen operativo: lo que el administrador necesita para saber si el worker corre. */
adminRouter.get('/health', async (req, res, next) => {
  try {
    const result = await getDb().execute(`
      SELECT
        (SELECT COUNT(*) FROM audit_jobs WHERE status = 'pending')    AS pending,
        (SELECT COUNT(*) FROM audit_jobs WHERE status = 'processing') AS processing,
        (SELECT COUNT(*) FROM audit_jobs WHERE status = 'failed')     AS failed,
        (SELECT COUNT(*) FROM audit_jobs WHERE status = 'done')       AS done,
        (SELECT COUNT(*) FROM audit_reports)                          AS reports,
        (SELECT COUNT(*) FROM audit_reports WHERE status = 'fallback') AS fallbacks,
        (SELECT COUNT(*) FROM audit_reports
          WHERE model IS NOT NULL AND date(created_at) = date('now')) AS model_calls_today,
        (SELECT MAX(created_at) FROM audit_reports)                   AS last_report_at,
        (SELECT MIN(created_at) FROM audit_jobs WHERE status = 'pending') AS oldest_pending_at,
        (SELECT MAX(created_at) FROM audit_jobs WHERE status = 'done') AS last_done_at
    `);
    const row = result.rows[0] || {};
    res.json(Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? Number(value) : value,
    ])));
  } catch (error) { next(error); }
});

/** Informes de todas las tiendas. */
adminRouter.get('/reports', async (req, res, next) => {
  try {
    const limit = clampLimit(req.query.limit, 100, 300);
    const severity = severityFilter(req.query.severity);
    const before = Number(req.query.before) || null;
    const userId = Number(req.query.user_id) || null;
    const clauses = [];
    const args = [];
    if (severity) { clauses.push('r.severity = ?'); args.push(severity); }
    if (userId) { clauses.push('r.user_id = ?'); args.push(userId); }
    if (before) { clauses.push('r.id < ?'); args.push(before); }
    args.push(limit);

    const result = await getDb().execute({
      sql: `SELECT r.*, c.closed_at, c.opened_at, c.difference, c.difference_usd,
                   c.difference_eur, c.register_id, c.account_email,
                   c.expected_cash, c.counted_cash,
                   u.store_name AS store_name, u.email AS store_email
              FROM audit_reports r
              LEFT JOIN cash_closes c ON c.id = r.cash_close_id AND c.user_id = r.user_id
              LEFT JOIN users u ON u.id = r.user_id
             ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
             ORDER BY r.id DESC LIMIT ?`,
      args,
    });
    res.json(result.rows.map((row) => ({
      ...asReport(row),
      store_name: row.store_name,
      store_email: row.store_email,
    })));
  } catch (error) { next(error); }
});

/** Detalle de un informe de cualquier tienda. */
adminRouter.get('/reports/:id', async (req, res, next) => {
  try {
    const result = await getDb().execute({
      sql: `SELECT r.*, c.closed_at, c.opened_at, c.difference, c.difference_usd,
                   c.difference_eur, c.register_id, c.account_email,
                   c.expected_cash, c.counted_cash,
                   u.store_name AS store_name, u.email AS store_email
              FROM audit_reports r
              LEFT JOIN cash_closes c ON c.id = r.cash_close_id AND c.user_id = r.user_id
              LEFT JOIN users u ON u.id = r.user_id
             WHERE r.id = ?`,
      args: [req.params.id],
    });
    if (!result.rows[0]) return res.status(404).json({ error: 'Informe no encontrado' });
    const row = result.rows[0];
    res.json({ ...asReport(row), store_name: row.store_name, store_email: row.store_email });
  } catch (error) { next(error); }
});

/** Vuelve a encolar un informe de respaldo para que el worker lo intente con IA. */
adminRouter.post('/reports/:id/retry', async (req, res, next) => {
  try {
    const db = getDb();
    const report = (await db.execute({
      sql: 'SELECT * FROM audit_reports WHERE id = ?',
      args: [req.params.id],
    })).rows[0];
    if (!report) return res.status(404).json({ error: 'Informe no encontrado' });
    if (report.status !== 'fallback') {
      return res.status(409).json({ error: 'Solo se pueden reintentar informes de respaldo' });
    }
    const updated = await db.execute({
      sql: `UPDATE audit_jobs
               SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'),
                   lease_until = NULL, last_error = NULL, updated_at = datetime('now')
             WHERE user_id = ? AND cash_close_id = ? AND source_revision = ?`,
      args: [report.user_id, report.cash_close_id, report.source_revision],
    });
    if (Number(updated.rowsAffected) === 0) {
      await db.execute({
        sql: `INSERT INTO audit_jobs (user_id, cash_close_id, source_revision)
              VALUES (?, ?, ?)
              ON CONFLICT(user_id, cash_close_id, kind, source_revision) DO UPDATE SET
                status = 'pending', attempts = 0, next_attempt_at = datetime('now'),
                lease_until = NULL, last_error = NULL, updated_at = datetime('now')`,
        args: [report.user_id, report.cash_close_id, report.source_revision],
      });
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/** Reintenta todos los trabajos fallidos (útil tras corregir un secreto o una cuota). */
adminRouter.post('/jobs/retry-failed', async (req, res, next) => {
  try {
    const result = await getDb().execute(`
      UPDATE audit_jobs
         SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'),
             lease_until = NULL, last_error = NULL, updated_at = datetime('now')
       WHERE status = 'failed'
    `);
    res.json({ ok: true, retried: Number(result.rowsAffected) || 0 });
  } catch (error) { next(error); }
});

/** Reintenta un trabajo fallido sin esperar a que alguien toque la base. */
adminRouter.post('/jobs/:id/retry', async (req, res, next) => {
  try {
    const result = await getDb().execute({
      sql: `UPDATE audit_jobs
               SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'),
                   lease_until = NULL, last_error = NULL, updated_at = datetime('now')
             WHERE id = ? AND status = 'failed'`,
      args: [req.params.id],
    });
    if (Number(result.rowsAffected) === 0) {
      return res.status(404).json({ error: 'Trabajo fallido no encontrado' });
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = { ownerRouter, adminRouter };
