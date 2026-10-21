const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Gemini conserva el plazo hasta que termina de leer la respuesta', async () => {
  const { callGemini } = await import('../lib/audit/gemini.mjs');
  let signal;
  const fetchImpl = async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('plazo agotado')), { once: true });
    }) };
  };
  await assert.rejects(callGemini({ apiKey: 'fake', payload: {}, fetchImpl, timeoutMs: 30 }), /plazo agotado/);
  assert.equal(signal.aborted, true);
});

test('Gemini devuelve el JSON y los contadores de una respuesta completa', async () => {
  const { callGemini } = await import('../lib/audit/gemini.mjs');
  const content = { headline: 'Prueba', summary: 'Datos ficticios', findings: [], questions: [], next_step: 'Revisar' };
  const result = await callGemini({ apiKey: 'fake', model: 'test-model', payload: {}, fetchImpl: async () => ({
    ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(content) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }),
  }) });
  assert.deepEqual(result, { content, model: 'test-model', tokens_in: 10, tokens_out: 20 });
});

test('la prueba operativa usa un cierre ficticio y valida el formato del modelo', async () => {
  const { probeGemini } = await import('../lib/audit/gemini.mjs');
  let request;
  const response = { headline: 'Revisar faltante', summary: 'Faltan 200 CUP.', findings: [{ probable_cause: 'Error de conteo', confidence: 'baja', evidence: ['Faltan 200 CUP'], impact: 'Diferencia de caja', recommendation: 'Contar de nuevo' }], questions: [], next_step: 'Contar' };
  const result = await probeGemini({ apiKey: 'fake', model: 'test-model', fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] } }] }) };
  } });
  assert.deepEqual(result, { ok: true, probe: true, model: 'test-model' });
  const prompt = request.contents[0].parts[0].text;
  assert.ok(prompt.includes('200'));
  assert.ok(!prompt.includes('account_email'));
  assert.ok(!prompt.includes('account_id'));
});
