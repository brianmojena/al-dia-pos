import { buildAuditSnapshot, toPromptPayload, validateModelOutput } from './auditRules.mjs';

/**
 * Llamada a Groq para redactar el informe de auditoría.
 *
 * El modelo recibe un snapshot ya calculado y seudonimizado. No decide
 * severidades ni sumas: solo explica lo que las reglas encontraron.
 *
 * Lo usan el cron externo y el script local, por eso no importa nada
 * específico de un runtime.
 */

export const DEFAULT_MODEL = 'openai/gpt-oss-120b';

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          probable_cause: { type: 'string' },
          confidence: { type: 'string', enum: ['alta', 'media', 'baja'] },
          evidence: { type: 'array', items: { type: 'string' } },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['probable_cause', 'confidence', 'evidence', 'impact', 'recommendation'],
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
    next_step: { type: 'string' },
  },
  required: ['headline', 'summary', 'findings', 'questions', 'next_step'],
};

const SYSTEM_PROMPT = `Eres un auditor de caja de una MIPYME cubana. Recibes un snapshot JSON con cifras ya calculadas por reglas deterministas.

Tu trabajo es explicar al dueño de la tienda qué pudo pasar y qué conviene revisar. Reglas estrictas:
- No inventes cifras, nombres, fechas ni hechos que no estén en el snapshot.
- No acuses a nadie de fraude. Habla de causas probables, errores de proceso y cosas que hay que verificar.
- No cambies ni recalcules los totales. Si el snapshot dice una cifra, usa esa cifra.
- Los cajeros aparecen como "Cajero 1", "Cajero 2". No intentes identificarlos.
- Prioriza faltantes de efectivo, patrones repetidos, ventas en divisa a tasa distinta, ventas rechazadas y extracciones cerca del cierre.
- Si no hay anomalías, dilo con claridad y no inventes un problema.
- Escribe en español claro, breve y directo, para alguien que atiende una tienda.
- Devuelve únicamente el JSON del esquema pedido.`;

const parseModelJson = (text) => {
  const cleaned = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned);
};

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.model]
 * @param {object} options.payload  Snapshot ya pasado por toPromptPayload()
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{content: object, model: string, tokens_in: number|null, tokens_out: number|null}>}
 */
export async function callGroq({
  apiKey,
  model = DEFAULT_MODEL,
  payload,
  fetchImpl = fetch,
  timeoutMs = 20_000,
}) {
  if (!apiKey) throw new Error('GROQ_API_KEY no está configurada');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Snapshot del cierre:\n${JSON.stringify(payload, null, 2)}` },
          ],
          temperature: 0.2,
          reasoning_effort: 'low',
          include_reasoning: false,
          max_completion_tokens: 4096,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'cash_close_audit', strict: true, schema: RESPONSE_SCHEMA },
          },
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const code = String(data?.error?.code || 'provider_error').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80);
      throw new Error(`Groq respondió ${response.status} (${code})`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('Groq devolvió una respuesta incompleta');
    if (choice?.message?.refusal) throw new Error('Groq rechazó redactar el informe');
    const text = choice?.message?.content;
    if (typeof text !== 'string') throw new Error('Groq devolvió una respuesta vacía');
    if (!text.trim()) throw new Error('Groq devolvió una respuesta vacía');

    const content = parseModelJson(text);
    return {
      content,
      model,
      tokens_in: data?.usage?.prompt_tokens ?? null,
      tokens_out: data?.usage?.completion_tokens ?? null,
    };
  } finally {
    // El plazo también cubre la descarga del cuerpo, no solo las cabeceras.
    clearTimeout(timer);
  }
}

// Prueba operativa con cifras fijas: nunca lee ni escribe información de tiendas.
export async function probeGroq(options) {
  const snapshot = buildAuditSnapshot({
    close: {
      id: 1, opened_at: '2026-01-01 08:00:00', closed_at: '2026-01-01 18:00:00',
      opening_float: 100, expected_cash: 1000, counted_cash: 800, difference: -200,
      expected_transfer: 0, expected_usd: 0, counted_usd: 0, difference_usd: 0,
      expected_eur: 0, counted_eur: 0, difference_eur: 0, sales_count: 1,
    },
    sales: [{ id: 1, total: 900, payment_method: 'efectivo', created_at: '2026-01-01 10:00:00' }],
  });
  const result = await callGroq({ ...options, payload: toPromptPayload(snapshot) });
  if (!validateModelOutput(result.content)) throw new Error('Respuesta de prueba inválida');
  return { ok: true, probe: true, model: result.model };
}

export { RESPONSE_SCHEMA, SYSTEM_PROMPT };
