const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Groq conserva el plazo hasta que termina de leer la respuesta', async () => {
  const { callGroq } = await import('../lib/audit/groq.mjs');
  let signal;
  const fetchImpl = async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('plazo agotado')), { once: true });
    }) };
  };
  await assert.rejects(callGroq({ apiKey: 'fake', payload: {}, fetchImpl, timeoutMs: 30 }), /plazo agotado/);
  assert.equal(signal.aborted, true);
});

test('Groq devuelve el JSON y los contadores de una respuesta completa', async () => {
  const { callGroq } = await import('../lib/audit/groq.mjs');
  const content = { headline: 'Prueba', summary: 'Datos ficticios', findings: [], questions: [], next_step: 'Revisar' };
  const result = await callGroq({ apiKey: 'fake', model: 'test-model', payload: {}, fetchImpl: async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
  }) });
  assert.deepEqual(result, { content, model: 'test-model', tokens_in: 10, tokens_out: 20 });
});

test('la prueba operativa usa un cierre ficticio y valida el formato del modelo', async () => {
  const { probeGroq } = await import('../lib/audit/groq.mjs');
  let request;
  const response = { headline: 'Revisar faltante', summary: 'Faltan 200 CUP.', findings: [{ probable_cause: 'Error de conteo', confidence: 'baja', evidence: ['Faltan 200 CUP'], impact: 'Diferencia de caja', recommendation: 'Contar de nuevo' }], questions: [], next_step: 'Contar' };
  const result = await probeGroq({ apiKey: 'fake', model: 'test-model', fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] }) };
  } });
  assert.deepEqual(result, { ok: true, probe: true, model: 'test-model' });
  const prompt = request.messages[1].content;
  assert.ok(prompt.includes('200'));
  assert.ok(!prompt.includes('account_email'));
  assert.ok(!prompt.includes('account_id'));
});


test('Groq usa el contrato estricto y nunca revela el mensaje crudo de un error', async () => {
  const { callGroq, DEFAULT_MODEL } = await import('../lib/audit/groq.mjs');
  let request;
  await assert.rejects(callGroq({ apiKey: 'fake', payload: {}, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fake');
    request = JSON.parse(options.body);
    return { ok: false, status: 401, json: async () => ({ error: { code: 'invalid_api_key', message: 'dato privado de prueba' } }) };
  } }), error => error.message === 'Groq respondió 401 (invalid_api_key)');
  assert.equal(request.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'openai/gpt-oss-120b');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(request.include_reasoning, false);
});

test('una respuesta truncada no se convierte en un informe válido', async () => {
  const { callGroq } = await import('../lib/audit/groq.mjs');
  await assert.rejects(callGroq({ apiKey: 'fake', payload: {}, fetchImpl: async () => ({
    ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
  }) }), /incompleta/);
});
