const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let rules;
before(async () => {
  rules = await import('../lib/audit/auditRules.mjs');
});

const baseClose = (overrides = {}) => ({
  id: 1,
  user_id: 1,
  opened_at: '2026-10-20 08:00:00',
  closed_at: '2026-10-20 18:00:00',
  opening_float: 1000,
  expected_cash: 5000,
  counted_cash: 5000,
  difference: 0,
  expected_transfer: 0,
  expected_usd: 0,
  counted_usd: 0,
  difference_usd: 0,
  expected_eur: 0,
  counted_eur: 0,
  difference_eur: 0,
  sales_count: 1,
  register_id: 'web',
  account_id: 7,
  account_email: 'cajero@test.local',
  withdrawn_cash: 0,
  withdrawn_transfer: 0,
  withdrawn_usd: 0,
  withdrawn_eur: 0,
  overlap_sales: 0,
  correction_revision: 0,
  ...overrides,
});

const sale = (overrides = {}) => ({
  id: 1,
  total: 100,
  payment_method: 'efectivo',
  transfer_amount: 0,
  foreign_currency: null,
  foreign_amount: 0,
  exchange_rate: null,
  shop_rate: null,
  account_id: 7,
  account_email: 'cajero@test.local',
  created_at: '2026-10-20 10:00:00',
  ...overrides,
});

const prior = (overrides = {}) => ({
  id: 2,
  closed_at: '2026-10-19 18:00:00',
  difference: 0,
  difference_usd: 0,
  difference_eur: 0,
  account_id: 7,
  account_email: 'cajero@test.local',
  register_id: 'web',
  ...overrides,
});

test('un cierre cuadrado no genera señales ni llamadas a la IA', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose(),
    sales: [sale()],
  });
  assert.equal(snapshot.severity, 'ok');
  assert.equal(snapshot.signals.length, 0);
  const report = rules.buildFallbackReport(snapshot);
  assert.equal(report.headline, 'Cierre cuadrado');
  assert.deepEqual(report.findings, []);
});

test('un faltante pequeño queda en revisión, no en riesgo alto', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ counted_cash: 4950, difference: -50 }),
    sales: [sale()],
  });
  assert.equal(snapshot.severity, 'warning');
  assert.ok(snapshot.signals.some((item) => item.id === 'S01'));
  assert.ok(snapshot.signals.some((item) => item.id === 'S02'));
  assert.ok(!snapshot.signals.some((item) => item.severity === 'critical'));
});

test('un 2% de una caja pequeña sigue en revisión, no escala a crítico', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ counted_cash: 4900, difference: -100 }),
    sales: [sale()],
  });
  assert.equal(snapshot.severity, 'warning');
  assert.equal(snapshot.signals.find((item) => item.id === 'S02').severity, 'warning');
});

test('un faltante grande es crítico', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ counted_cash: 4400, difference: -600 }),
    sales: [sale()],
  });
  assert.equal(snapshot.severity, 'critical');
  assert.equal(snapshot.signals.find((item) => item.id === 'S01').severity, 'critical');
});

test('dos faltantes previos más el actual disparan el patrón crítico S03', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ counted_cash: 4950, difference: -50 }),
    sales: [sale()],
    priorCloses: [
      prior({ id: 2, difference: -50 }),
      prior({ id: 3, difference: -50 }),
    ],
  });
  const signal = snapshot.signals.find((item) => item.id === 'S03');
  assert.ok(signal);
  assert.equal(signal.severity, 'critical');
  assert.match(signal.evidence, /3 faltantes/);
});

test('un descuadre atípico para el cajero dispara S04', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ counted_cash: 4950, difference: -50 }),
    sales: [sale()],
    priorCloses: [
      prior({ id: 2, difference: 0 }),
      prior({ id: 3, difference: 0 }),
      prior({ id: 4, difference: 0 }),
      prior({ id: 5, difference: 10 }),
    ],
  });
  const signal = snapshot.signals.find((item) => item.id === 'S04');
  assert.ok(signal);
  assert.equal(signal.severity, 'warning');
});

test('una venta en divisa a tasa distinta dispara S05', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose(),
    sales: [sale({
      payment_method: 'divisa',
      foreign_currency: 'USD',
      foreign_amount: 100,
      exchange_rate: 300,
      shop_rate: 280,
      total: 30000,
    })],
  });
  const signal = snapshot.signals.find((item) => item.id === 'S05');
  assert.ok(signal);
  assert.equal(signal.severity, 'critical');
  assert.equal(signal.amount, 2000);
});

test('las ventas rechazadas sin revisar disparan S06', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose(),
    sales: [sale()],
    rejectedSales: [{ total: 500 }],
  });
  const signal = snapshot.signals.find((item) => item.id === 'S06');
  assert.ok(signal);
  assert.equal(signal.severity, 'warning');
  assert.equal(signal.amount, 500);
});

test('una extracción cerca del cierre dispara S07', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose(),
    sales: [sale()],
    withdrawals: [{
      id: 1,
      method: 'efectivo',
      amount: 100,
      created_at: '2026-10-20 17:45:00',
      account_id: 7,
      account_email: 'cajero@test.local',
    }],
  });
  assert.ok(snapshot.signals.some((item) => item.id === 'S07'));
});

test('una compra de divisa a tasa distinta dispara S08', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose(),
    sales: [sale()],
    purchases: [{
      id: 1,
      foreign_currency: 'USD',
      foreign_amount: 100,
      exchange_rate: 300,
      shop_rate: 280,
      cup_amount: 30000,
      account_id: 7,
      account_email: 'cajero@test.local',
    }],
  });
  const signal = snapshot.signals.find((item) => item.id === 'S08');
  assert.ok(signal);
  assert.equal(signal.severity, 'critical');
  assert.equal(signal.amount, 2000);
});

test('una corrección posterior dispara S09', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ correction_revision: 1 }),
    sales: [sale()],
    corrections: [{
      correction_revision: 1,
      account_email: 'dueno@test.local',
      created_at: '2026-10-21 09:00:00',
    }],
  });
  const signal = snapshot.signals.find((item) => item.id === 'S09');
  assert.ok(signal);
  assert.equal(signal.subject_label, 'Administrador');
});

test('el fondo inicial que no cuadra con el cierre anterior dispara S10', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ opening_float: 1000 }),
    sales: [sale()],
    context: {
      previousClose: {
        id: 2,
        closed_at: '2026-10-19 18:00:00',
        counted_cash: 400,
        opening_float: 0,
      },
    },
  });
  const signal = snapshot.signals.find((item) => item.id === 'S10');
  assert.ok(signal);
  assert.equal(signal.amount, 600);
});

test('un período de más de 24 horas dispara S11', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ opened_at: '2026-10-19 08:00:00' }),
    sales: [sale()],
  });
  assert.ok(snapshot.signals.some((item) => item.id === 'S11'));
});

test('dos cierres de la misma caja muy seguidos disparan S17', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose(),
    sales: [sale()],
    context: {
      previousRegisterClose: { id: 2, closed_at: '2026-10-20 17:58:00' },
    },
  });
  const signal = snapshot.signals.find((item) => item.id === 'S17');
  assert.ok(signal);
  assert.equal(signal.severity, 'warning');
  assert.match(signal.evidence, /2 minutos/);
});

test('un cierre sin ventas deja una observación, no una alerta', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ sales_count: 0 }),
    sales: [],
  });
  assert.equal(snapshot.severity, 'info');
  assert.ok(snapshot.signals.some((item) => item.id === 'S12'));
});

test('las ventas ya cubiertas por otro cierre disparan S13', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ overlap_sales: 2 }),
    sales: [sale()],
  });
  const signal = snapshot.signals.find((item) => item.id === 'S13');
  assert.ok(signal);
  assert.equal(signal.severity, 'warning');
});

test('una caja compartida se marca para no atribuir el descuadre a una persona', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ register_id: 'shared:abc' }),
    sales: [sale()],
  });
  assert.ok(snapshot.signals.some((item) => item.id === 'S14'));
});

test('una diferencia de divisa se separa de la de pesos', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ expected_usd: 0, counted_usd: 6, difference_usd: 6 }),
    sales: [sale()],
  });
  const signal = snapshot.signals.find((item) => item.id === 'S15');
  assert.ok(signal);
  assert.equal(signal.severity, 'critical');
  assert.equal(signal.currency, 'USD');
});

test('las ventas abiertas de días anteriores dejan una observación', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose(),
    sales: [sale()],
    context: { openSalesOlderThan24h: 2 },
  });
  const signal = snapshot.signals.find((item) => item.id === 'S16');
  assert.ok(signal);
  assert.equal(signal.severity, 'info');
});

test('el prompt elimina correos e IDs de cuenta', () => {
  const snapshot = rules.buildAuditSnapshot({
    close: baseClose({ counted_cash: 4950, difference: -50 }),
    sales: [sale()],
    priorCloses: [prior({ difference: -50 })],
  });
  const payload = rules.toPromptPayload(snapshot);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('cajero@test.local'));
  assert.ok(!serialized.includes('account_id'));
  assert.ok(!serialized.includes('account_email'));
  assert.equal(payload.prompt_version, rules.PROMPT_VERSION);
  assert.equal(payload.cashiers[0].label, 'Cajero 1');
});

test('validateModelOutput rechaza respuestas incompletas y limpia las válidas', () => {
  assert.equal(rules.validateModelOutput(null), null);
  assert.equal(rules.validateModelOutput({ headline: 'Solo titular' }), null);
  assert.equal(rules.validateModelOutput({ headline: 'T', summary: 'S', findings: [] }), null);

  const valid = rules.validateModelOutput({
    headline: '  Faltante de 50 CUP  ',
    summary: '  El conteo quedó 50 CUP por debajo.  ',
    findings: [{
      probable_cause: '  Vuelto mal entregado  ',
      confidence: 'alta',
      evidence: ['  Faltan 50 CUP  ', ''],
      impact: '50 CUP',
      recommendation: 'Repetir el conteo',
    }],
    questions: ['¿Se revisó el vuelto?'],
    next_step: 'Revisar la gaveta',
  });
  assert.equal(valid.headline, 'Faltante de 50 CUP');
  assert.equal(valid.findings[0].probable_cause, 'Vuelto mal entregado');
  assert.deepEqual(valid.findings[0].evidence, ['Faltan 50 CUP']);
  assert.equal(valid.findings[0].confidence, 'alta');
});
