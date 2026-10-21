const test = require('node:test');
const assert = require('node:assert/strict');
process.env.AUDIT_ENABLED = '1';
const { enqueueAuditJob } = require('../lib/auditJobs');

test('un fallo de auditoría no impide responder al cierre confirmado', async () => {
  const result = await enqueueAuditJob({ execute: async () => { throw new Error('Auditoría no disponible'); } },
    { userId: 1, cashCloseId: 1 });
  assert.equal(result, null);
});

test('una escritura de auditoría que no responde tiene un plazo limitado', { timeout: 10_000 }, async () => {
  const result = await enqueueAuditJob({ execute: () => new Promise(() => {}) },
    { userId: 1, cashCloseId: 1 });
  assert.equal(result, null, 'el cierre puede responder sin esperar indefinidamente');
});
