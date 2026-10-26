const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startTestServer, registerUser, createCashier, createProduct } = require('./helpers');

const suffix = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;

/**
 * Módulo de contabilidad: gastos + extracciones.
 * Solo disponible para dueño en plan Enterprise.
 */

test('contabilidad', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  // Helpers para la suite
  const registerWithPlan = (api, suffix_, plan) =>
    api('POST', '/api/auth/register', {
      body: {
        email: `owner-${suffix_}@test.local`,
        password: 'test1234',
        store_name: 'Tienda Test',
        ...(plan ? { plan } : {}),
      },
    });

  await t.test('plan y permisos: Basic -> 403 PLAN_REQUIRED', async () => {
    const s = suffix();
    const res = await registerWithPlan(ctx.api, s);
    const token = res.body.token;

    // GET /expenses
    const get1 = await ctx.api('GET', '/api/accounting/expenses?month=2024-01', { token });
    assert.equal(get1.status, 403);
    assert.equal(get1.body.code, 'PLAN_REQUIRED');

    // POST /expenses
    const post1 = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp1',
        method: 'efectivo',
        amount: 100,
        concept: 'Compra de materiales',
      },
    });
    assert.equal(post1.status, 403);
    assert.equal(post1.body.code, 'PLAN_REQUIRED');

    // POST /void
    const void1 = await ctx.api('POST', '/api/accounting/expenses/exp1/void', { token });
    assert.equal(void1.status, 403);
    assert.equal(void1.body.code, 'PLAN_REQUIRED');

    // GET /summary
    const sum1 = await ctx.api('GET', '/api/accounting/summary?month=2024-01', { token });
    assert.equal(sum1.status, 403);
    assert.equal(sum1.body.code, 'PLAN_REQUIRED');
  });

  await t.test('plan y permisos: cajero en plan Enterprise -> 403', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const ownerToken = owner.body.token;

    const cashier = await createCashier(ctx.api, ownerToken, {
      email: `cashier-${s}@test.local`,
    });
    const cashierToken = cashier.token;

    // El cajero intenta acceder a contabilidad
    const res = await ctx.api('GET', '/api/accounting/expenses?month=2024-01', {
      token: cashierToken,
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /dueño/);
  });

  await t.test('crear gasto -> 201 con datos correctos', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    const res = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-1',
        method: 'efectivo',
        amount: 150.50,
        concept: 'Compra de ingredientes para la tienda',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.client_expense_id, 'exp-1');
    assert.equal(res.body.method, 'efectivo');
    assert.equal(res.body.amount, 150.5);
    assert.equal(res.body.concept, 'Compra de ingredientes para la tienda');
    assert.equal(res.body.voided_at, null);
  });

  await t.test('crear con client_expense_id duplicado -> 200 idempotente', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    const res1 = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-2',
        method: 'transferencia',
        amount: 200,
        concept: 'Pago de alquiler',
      },
    });
    assert.equal(res1.status, 201);

    const res2 = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-2',
        method: 'transferencia',
        amount: 200,
        concept: 'Pago de alquiler',
      },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.idempotent_replay, true);
    assert.equal(res2.body.id, res1.body.id);
  });

  await t.test('validar concepto: mínimo 3, máximo 200 caracteres', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    const resCorto = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-short',
        method: 'efectivo',
        amount: 100,
        concept: 'ab',
      },
    });
    assert.equal(resCorto.status, 400);
    assert.match(resCorto.body.error, /3 y 200/);

    const resLargo = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-long',
        method: 'efectivo',
        amount: 100,
        concept: 'a'.repeat(201),
      },
    });
    assert.equal(resLargo.status, 400);
    assert.match(resLargo.body.error, /3 y 200/);
  });

  await t.test('validar monto > 0', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    const res0 = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-zero',
        method: 'efectivo',
        amount: 0,
        concept: 'Gasto cero',
      },
    });
    assert.equal(res0.status, 400);
    assert.match(res0.body.error, /monto/);

    const resNeg = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-neg',
        method: 'efectivo',
        amount: -50,
        concept: 'Gasto negativo',
      },
    });
    assert.equal(resNeg.status, 400);
    assert.match(resNeg.body.error, /monto/);
  });

  await t.test('validar método en WITHDRAWAL_METHODS', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    const res = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-bad-method',
        method: 'cheque',
        amount: 100,
        concept: 'Gasto con método inválido',
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Apartado inválido/);
  });

  await t.test('anular gasto -> voided_at se pone', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    const res1 = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-void-1',
        method: 'USD',
        amount: 50,
        concept: 'Gasto en dólares',
      },
    });
    assert.equal(res1.status, 201);
    assert.equal(res1.body.voided_at, null);

    const res2 = await ctx.api('POST', '/api/accounting/expenses/exp-void-1/void', { token });
    assert.equal(res2.status, 200);
    assert.notEqual(res2.body.voided_at, null);
  });

  await t.test('anular gasto inexistente -> 404', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    const res = await ctx.api('POST', '/api/accounting/expenses/exp-noexiste/void', { token });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /no encontrado/);
  });

  await t.test('anular gasto dos veces -> idempotente (200)', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    const res1 = await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-void-2',
        method: 'efectivo',
        amount: 75,
        concept: 'Gasto para anular dos veces',
      },
    });
    assert.equal(res1.status, 201);

    const res2 = await ctx.api('POST', '/api/accounting/expenses/exp-void-2/void', { token });
    assert.equal(res2.status, 200);

    const res3 = await ctx.api('POST', '/api/accounting/expenses/exp-void-2/void', { token });
    assert.equal(res3.status, 200);
    assert.equal(res3.body.id, res2.body.id);
  });

  await t.test('listado de gastos incluye anulados', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    // Crear varios gastos
    await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-list-1',
        method: 'efectivo',
        amount: 100,
        concept: 'Primer gasto',
      },
    });

    await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-list-2',
        method: 'transferencia',
        amount: 200,
        concept: 'Segundo gasto',
      },
    });

    // Anular uno
    await ctx.api('POST', '/api/accounting/expenses/exp-list-1/void', { token });

    // Listar
    const res = await ctx.api('GET', '/api/accounting/expenses', { token });
    assert.equal(res.status, 200);
    assert.equal(Array.isArray(res.body), true);
    assert.ok(res.body.length >= 2, 'lista contiene al menos 2 gastos');

    // Verificar que incluye el anulado
    const anulado = res.body.find((e) => e.client_expense_id === 'exp-list-1');
    assert.ok(anulado, 'incluye gasto anulado');
    assert.notEqual(anulado.voided_at, null);
  });

  await t.test('summary sin gastos vs con gastos', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    // Summary sin gastos
    const res1 = await ctx.api('GET', '/api/accounting/summary', { token });
    assert.equal(res1.status, 200);
    assert.ok(res1.body.month, 'incluye mes');
    assert.ok(res1.body.totals, 'incluye totales');
    assert.ok(Array.isArray(res1.body.days), 'incluye array de días');
    assert.equal(res1.body.totals.expenses_cup, 0);
    assert.equal(res1.body.totals.expenses_usd, 0);
    assert.equal(res1.body.totals.expenses_eur, 0);

    // Crear un gasto
    await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-summary-1',
        method: 'efectivo',
        amount: 250,
        concept: 'Gasto de prueba',
      },
    });

    // Summary con gasto
    const res2 = await ctx.api('GET', '/api/accounting/summary', { token });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.totals.expenses_cup, 250);

    // Anular el gasto
    await ctx.api('POST', '/api/accounting/expenses/exp-summary-1/void', { token });

    // Summary sin el gasto (anulado)
    const res3 = await ctx.api('GET', '/api/accounting/summary', { token });
    assert.equal(res3.status, 200);
    assert.equal(res3.body.totals.expenses_cup, 0, 'gastos anulados no se cuentan');
  });

  await t.test('divisas en gastos se separan de CUP', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    // Crear gastos en diferentes monedas
    await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-usd',
        method: 'USD',
        amount: 100,
        concept: 'Gasto en dólares',
      },
    });

    await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-eur',
        method: 'EUR',
        amount: 50,
        concept: 'Gasto en euros',
      },
    });

    // Summary
    const res = await ctx.api('GET', '/api/accounting/summary', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.totals.expenses_cup, 0, 'USD y EUR no se mezclan con CUP');
    assert.equal(res.body.totals.expenses_usd, 100);
    assert.equal(res.body.totals.expenses_eur, 50);
  });

  await t.test('export devuelve Excel con status 200', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    // Crear un gasto
    await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-export',
        method: 'efectivo',
        amount: 300,
        concept: 'Gasto para exportar',
      },
    });

    // Llamar a /export (descarga binaria)
    const today = new Date();
    const month = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;

    const exportRes = await fetch(`${ctx.baseUrl}/api/accounting/export?month=${month}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get('content-type'), /spreadsheetml/);
    assert.match(exportRes.headers.get('content-disposition'), /contabilidad-.*.xlsx/);
  });

  await t.test('totales de /summary coinciden con fila Total del Excel', async () => {
    const s = suffix();
    const owner = await registerWithPlan(ctx.api, s, 'enterprise');
    const token = owner.body.token;

    // Crear algunos gastos en diferentes métodos
    await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-total-1',
        method: 'efectivo',
        amount: 100,
        concept: 'Gasto efectivo',
      },
    });

    await ctx.api('POST', '/api/accounting/expenses', {
      token,
      body: {
        client_expense_id: 'exp-total-2',
        method: 'USD',
        amount: 50,
        concept: 'Gasto dólares',
      },
    });

    // Obtener summary
    const today = new Date();
    const month = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;

    const summaryRes = await ctx.api('GET', '/api/accounting/summary', { token });
    assert.equal(summaryRes.status, 200);
    const summaryTotals = summaryRes.body.totals;

    // Obtener Excel
    const exportRes = await fetch(`${ctx.baseUrl}/api/accounting/export?month=${month}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(exportRes.status, 200);

    const buffer = await exportRes.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const resumenSheet = workbook.getWorksheet('Resumen por día');
    assert.ok(resumenSheet, 'debe existir hoja Resumen por día');

    // Encontrar la fila de totales (última fila con 'Total del mes')
    let totalRow = null;
    for (let i = 2; i <= resumenSheet.rowCount; i++) {
      const row = resumenSheet.getRow(i);
      if (row.getCell(1).value === 'Total del mes') {
        totalRow = row;
        break;
      }
    }
    assert.ok(totalRow, 'debe existir fila Total del mes');

    // Comparar totales (columnas: 1=Fecha, 2=Ingresos, 3=Ganancia, 4=Gastos CUP, 5=Gastos USD, 6=Gastos EUR, 7=Resultado CUP)
    assert.equal(totalRow.getCell(2).value, summaryTotals.income, 'ingresos coinciden');
    assert.equal(totalRow.getCell(3).value, summaryTotals.profit, 'ganancia coincide');
    assert.equal(totalRow.getCell(4).value, summaryTotals.expenses_cup, 'gastos_cup coinciden');
    assert.equal(totalRow.getCell(5).value, summaryTotals.expenses_usd, 'gastos_usd coinciden');
    assert.equal(totalRow.getCell(6).value, summaryTotals.expenses_eur, 'gastos_eur coinciden');
    assert.equal(totalRow.getCell(7).value, summaryTotals.result_cup, 'resultado_cup coincide');
  });
});
