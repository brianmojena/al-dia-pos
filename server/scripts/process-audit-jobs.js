'use strict';

/**
 * Procesador local de trabajos de auditoría.
 *
 * Sirve para probar el flujo sin el cron externo y como respaldo manual si el
 * cron está caído. Usa exactamente el mismo motor de reglas y el mismo
 * procesador que el endpoint /api/cron/audit.
 *
 * Uso:
 *   npm run audit:process              # procesa pendientes una vez
 *   npm run audit:process -- --watch   # queda vigilando cada 15 s
 *   npm run audit:process -- --no-model --limit=10
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const noModel = args.has('--no-model');
const limitArg = process.argv.slice(2).find((arg) => arg.startsWith('--limit='));
const limit = Math.min(Math.max(Number(limitArg?.split('=')[1]) || 5, 1), 50);
const intervalArg = process.argv.slice(2).find((arg) => arg.startsWith('--interval='));
const intervalMs = Math.max(Number(intervalArg?.split('=')[1]) || 15, 5) * 1000;

const loadShared = async () => ({
  ...(await import('../lib/audit/auditProcessor.mjs')),
  ...(await import('../lib/audit/groq.mjs')),
});

async function main() {
  const { initDb, getDb } = require('../db/database');
  await initDb();
  const db = getDb();
  const {
    claimAuditJobs, countModelCallsToday, processAuditJob, recoverStaleJobs,
    callGroq, DEFAULT_MODEL,
  } = await loadShared();

  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  const model = String(process.env.GROQ_AUDIT_MODEL || '').trim() || DEFAULT_MODEL;
  const capText = String(process.env.AUDIT_MAX_LLM_PER_DAY_PER_SHOP || '').trim();
  const parsedCap = capText === '' ? 100 : Number(capText);
  const dailyCap = Number.isFinite(parsedCap) && parsedCap >= 0 ? Math.floor(parsedCap) : 100;
  const useModel = !noModel && !!apiKey;

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  do {
    const recovered = await recoverStaleJobs(db);
    let processed = 0;

    // Igual que el worker: reclama de una en una para que el lease de cada
    // trabajo empiece justo antes de procesarlo, no al reclamar todo el lote.
    for (let index = 0; index < limit; index += 1) {
      if (stopping) break;
      const [job] = await claimAuditJobs(db, 1);
      if (!job) break;
      let callModel = null;
      if (useModel) {
        const used = await countModelCallsToday(db, Number(job.user_id)).catch(() => dailyCap);
        if (used < dailyCap) callModel = (payload) => callGroq({ apiKey, model, payload });
      }
      const result = await processAuditJob(db, job, { callModel });
      processed += 1;
      console.log(`audit: cierre ${job.cash_close_id} rev ${job.source_revision} → ${result.status}`,
        result.error ? `(${result.error})` : '');
    }

    if (recovered || processed) {
      console.log(`audit: ${recovered} trabajo(s) recuperado(s), ${processed} procesado(s)`);
    }

    if (!watch || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (!stopping);

  console.log(useModel ? `audit: modelo ${model}` : 'audit: solo reglas deterministas (sin Groq)');
}

main().catch((error) => {
  console.error('audit:', error);
  process.exitCode = 1;
});
