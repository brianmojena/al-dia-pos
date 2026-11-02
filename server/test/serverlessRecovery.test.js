const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('serverless comparte el arranque y reintenta tras una caída temporal de la base', async () => {
  let attempts = 0, handled = 0, rejectStart;
  const firstStart = new Promise((_, reject) => { rejectStart = reject; });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/index'), 'utf8'), {
    module,
    require: (id) => {
      if (id === '../db/database') return { initDb: () => ++attempts === 1 ? firstStart : Promise.resolve() };
      if (id === '../config') return { assertConfig() {} };
      if (id === '../app') return () => ++handled;
      throw new Error(`Dependencia inesperada: ${id}`);
    },
  });
  const handler = module.exports;
  const initial = [handler({}, {}), handler({}, {})];
  assert.equal(attempts, 1);
  const failed = Promise.allSettled(initial);
  rejectStart(new Error('Base temporalmente bloqueada'));
  assert.ok((await failed).every((result) => result.status === 'rejected'));
  assert.equal(handled, 0);
  await Promise.all([handler({}, {}), handler({}, {})]);
  assert.equal(attempts, 2);
  assert.equal(handled, 2);
  await handler({}, {});
  assert.equal(attempts, 2, 'un arranque correcto se reutiliza en invocaciones posteriores');
});
