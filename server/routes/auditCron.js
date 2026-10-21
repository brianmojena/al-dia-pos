'use strict';

const crypto = require('crypto');
const express = require('express');
const { getDb } = require('../db/database');
const { AUDIT_ENABLED } = require('../config');

const router = express.Router();

// El motor vive en módulos ESM porque también lo usa el script local. Se carga
// una sola vez por contenedor; Vercel reutiliza el proceso en invocaciones
// tibias, así que no se vuelve a importar en cada cron.
let enginePromise = null;
const loadEngine = () => {
  if (!enginePromise) {
    enginePromise = Promise.all([
      import('../lib/audit/auditProcessor.mjs'),
      import('../lib/audit/groq.mjs'),
    ]).then(([processor, groq]) => ({ ...processor, ...groq }))
      .catch((error) => { enginePromise = null; throw error; });
  }
  return enginePromise;
};

const workerSecrets = () => [process.env.CRON_SECRET, process.env.AUDIT_WORKER_SECRET]
  .map((value) => String(value || '').trim())
  .filter(Boolean);

const sameSecret = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const requestSecret = (req) => {
  const bearer = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : String(req.get('x-audit-secret') || '').trim();
};

const clampLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.min(Math.floor(parsed), 20);
};

const dailyCap = () => {
  const raw = String(process.env.AUDIT_MAX_LLM_PER_DAY_PER_SHOP || '').trim();
  const parsed = raw === '' ? 100 : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 100;
};

const timeBudgetMs = () => {
  const parsed = Number(process.env.AUDIT_WORKER_TIME_BUDGET_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000;
  // 35 s + los 20 s de timeout de Groq siguen dentro de maxDuration=60.
  return Math.min(Math.max(Math.floor(parsed), 5_000), 35_000);
};

/**
 * Worker de auditoría para un cron externo.
 *
 * El cron llama esta ruta cada pocos minutos con `Authorization: Bearer
 * <CRON_SECRET>`. Reclama trabajos de Turso de una en una, calcula las señales
 * con las reglas deterministas y solo llama a Groq si hay anomalías. Si el
 * modelo falla, el informe determinista se guarda igual.
 *
 * No usa requireAuth: el cron no tiene una sesión de usuario. La credencial es
 * el secreto compartido, y el endpoint no revela datos de ninguna tienda.
 */
router.all('/', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const secrets = workerSecrets();
  if (!secrets.length) {
    return res.status(500).json({ error: 'Falta CRON_SECRET en el servidor' });
  }
  const provided = requestSecret(req);
  if (!provided || !secrets.some((secret) => sameSecret(provided, secret))) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (!AUDIT_ENABLED) {
    return res.json({ ok: true, disabled: true, recovered: 0, processed: 0, results: [] });
  }

  // Solo bajo el mismo secreto del cron. Permite validar la configuración real
  // de Vercel con un cierre ficticio sin procesar trabajos de clientes.
  if (req.query.probe === '1') {
    res.set('Cache-Control', 'no-store');
    try {
      const { probeGroq, DEFAULT_MODEL } = await loadEngine();
      return res.json(await probeGroq({
        apiKey: String(process.env.GROQ_API_KEY || '').trim(),
        model: String(process.env.GROQ_AUDIT_MODEL || '').trim() || DEFAULT_MODEL,
      }));
    } catch (error) {
      const message = String(error.message || '');
      const providerStatus = Number(/Groq respondió (\d+)/.exec(message)?.[1]) || null;
      // Solo categorías fijas: nunca devolver la respuesta cruda del proveedor
      // ni valores de entorno en el diagnóstico que queda en GitHub Actions.
      const code = /no está configurada/.test(message) ? 'MISSING_KEY'
        : /invalid_api_key/.test(message) ? 'INVALID_KEY'
        : providerStatus === 404 ? 'MODEL_NOT_FOUND'
        : providerStatus === 429 ? 'QUOTA_EXCEEDED'
        : providerStatus === 403 ? 'PROVIDER_DENIED'
        : error.name === 'AbortError' ? 'TIMEOUT'
        : providerStatus ? 'PROVIDER_ERROR' : 'INVALID_OUTPUT';
      return res.status(502).json({ ok: false, probe: true, code, provider_status: providerStatus,
        error: 'No se pudo validar Groq; revisa su configuración en Vercel' });
    }
  }

  const started = Date.now();
  const deadline = started + timeBudgetMs();
  const limit = clampLimit(req.query.limit);

  try {
    const {
      recoverStaleJobs, claimAuditJobs, countModelCallsToday,
      processAuditJob, callGroq, DEFAULT_MODEL,
    } = await loadEngine();

    const db = getDb();
    const model = String(process.env.GROQ_AUDIT_MODEL || '').trim() || DEFAULT_MODEL;
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    const cap = dailyCap();
    const recovered = await recoverStaleJobs(db);
    const results = [];

    for (let index = 0; index < limit; index += 1) {
      // No empezar un trabajo que probablemente no termine antes del timeout
      // de la función. Groq tiene un timeout propio de 20 s.
      if (Date.now() >= deadline) break;
      const [job] = await claimAuditJobs(db, 1);
      if (!job) break;

      let callModel = null;
      if (apiKey) {
        const used = await countModelCallsToday(db, Number(job.user_id)).catch(() => cap);
        if (used < cap) callModel = (payload) => callGroq({ apiKey, model, payload });
      }

      const result = await processAuditJob(db, job, { callModel });
      results.push({ jobId: Number(job.id), ...result });
    }

    return res.json({
      ok: true,
      recovered,
      claimed: results.length,
      processed: results.length,
      results,
      duration_ms: Date.now() - started,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
