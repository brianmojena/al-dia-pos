const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { operationTime } = require('../lib/operationTime');
const { shopLocalDate, shopLocalTime } = require('../lib/businessDay');
const { describeAccount } = require('../lib/account');
const { requireOwner } = require('../middleware/auth');
const { WITHDRAWAL_METHODS, round2 } = require('../lib/payment');
const {
  daySummaries, sumTotals, resolveMonth, buildExtraccionesSheet, styleHeaderRow,
} = require('./reports');

/**
 * Módulo de contabilidad: gastos del dueño + extracciones de caja.
 * Solo disponible en plan Enterprise.
 */

const isUniqueViolation = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT_UNIQUE');
};

const findByClientId = (db, userId, clientId) =>
  db.execute({
    sql: 'SELECT * FROM expenses WHERE user_id = ? AND client_expense_id = ?',
    args: [userId, clientId],
  });

/**
 * Clasifica una cantidad por método en los apartados contables.
 * Devuelve { cup, usd, eur } con los montos clasificados.
 */
const classifyByMethod = (method, amount) => {
  const amt = round2(amount);
  if (method === 'efectivo' || method === 'transferencia') {
    return { cup: amt, usd: 0, eur: 0 };
  }
  if (method === 'USD') {
    return { cup: 0, usd: amt, eur: 0 };
  }
  if (method === 'EUR') {
    return { cup: 0, usd: 0, eur: amt };
  }
  return { cup: 0, usd: 0, eur: 0 };
};

/**
 * Calcula ingresos y gastos del mes para el summary y el export.
 * Devuelve { totals, days } donde days está ordenado más reciente primero.
 *
 * totals: { income, income_cash, income_transfer, income_foreign_cup, profit,
 *           expenses_cup, expenses_usd, expenses_eur, result_cup }
 * days: [{ date, income, profit, expenses_cup, expenses_usd, expenses_eur, result_cup }, ...]
 */
async function monthAccounting(db, userId, bounds) {
  // Ingresos desde daySummaries
  const days = await daySummaries(db, userId, bounds);
  const totals = sumTotals(days);

  // Gastos no anulados
  const expensesResult = await db.execute({
    sql: `SELECT created_at, method, amount FROM expenses
          WHERE user_id = ? AND created_at >= ? AND created_at < ? AND voided_at IS NULL
          ORDER BY created_at ASC`,
    args: [userId, bounds.start, bounds.end],
  });

  // Extracciones no anuladas
  const withdrawalsResult = await db.execute({
    sql: `SELECT created_at, method, amount FROM cash_withdrawals
          WHERE user_id = ? AND created_at >= ? AND created_at < ? AND voided_at IS NULL
          ORDER BY created_at ASC`,
    args: [userId, bounds.start, bounds.end],
  });

  // Agrupar gastos y extracciones por día
  const expensesByDay = new Map();
  const dayExpense = (date) => {
    if (!expensesByDay.has(date)) {
      expensesByDay.set(date, { expenses_cup: 0, expenses_usd: 0, expenses_eur: 0 });
    }
    return expensesByDay.get(date);
  };

  for (const row of expensesResult.rows) {
    const date = shopLocalDate(row.created_at);
    if (!date) continue;
    const d = dayExpense(date);
    const classified = classifyByMethod(row.method, row.amount);
    d.expenses_cup += classified.cup;
    d.expenses_usd += classified.usd;
    d.expenses_eur += classified.eur;
  }

  for (const row of withdrawalsResult.rows) {
    const date = shopLocalDate(row.created_at);
    if (!date) continue;
    const d = dayExpense(date);
    const classified = classifyByMethod(row.method, row.amount);
    d.expenses_cup += classified.cup;
    d.expenses_usd += classified.usd;
    d.expenses_eur += classified.eur;
  }

  // Combinar con los días de daySummaries
  const allDays = {};
  for (const d of days) {
    allDays[d.date] = { ...d };
  }

  // Añadir días que solo tienen gastos
  for (const [date, expenses] of expensesByDay) {
    if (!allDays[date]) {
      allDays[date] = {
        date,
        sales_count: 0,
        total: 0,
        cash_total: 0,
        transfer_total: 0,
        profit: 0,
        foreign_total: 0,
        usd_total: 0,
        eur_total: 0,
        off_rate_count: 0,
        stock_moves: 0,
        closes: null,
        ...expenses,
      };
    } else {
      allDays[date].expenses_cup = (allDays[date].expenses_cup || 0) + expenses.expenses_cup;
      allDays[date].expenses_usd = (allDays[date].expenses_usd || 0) + expenses.expenses_usd;
      allDays[date].expenses_eur = (allDays[date].expenses_eur || 0) + expenses.expenses_eur;
    }
  }

  // Calcular resultado_cup por día y convertir a array ordenado
  const resultDays = Object.values(allDays)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((d) => ({
      date: d.date,
      income: round2(d.total || 0),
      profit: round2(d.profit || 0),
      expenses_cup: round2(d.expenses_cup || 0),
      expenses_usd: round2(d.expenses_usd || 0),
      expenses_eur: round2(d.expenses_eur || 0),
      result_cup: round2((d.profit || 0) - (d.expenses_cup || 0)),
    }));

  // Totales
  const summaryTotals = {
    income: totals.total,
    income_cash: totals.cash_total,
    income_transfer: totals.transfer_total,
    income_foreign_cup: totals.foreign_total,
    profit: totals.profit,
    expenses_cup: 0,
    expenses_usd: 0,
    expenses_eur: 0,
    result_cup: 0,
  };

  for (const d of resultDays) {
    summaryTotals.expenses_cup = round2(summaryTotals.expenses_cup + d.expenses_cup);
    summaryTotals.expenses_usd = round2(summaryTotals.expenses_usd + d.expenses_usd);
    summaryTotals.expenses_eur = round2(summaryTotals.expenses_eur + d.expenses_eur);
  }
  summaryTotals.result_cup = round2(summaryTotals.profit - summaryTotals.expenses_cup);

  return { totals: summaryTotals, days: resultDays };
}

/**
 * GET /expenses?month=YYYY-MM
 * Devuelve gastos del mes, incluyendo anulados.
 */
router.get('/expenses', requireOwner, asyncHandler(async (req, res) => {
  let bounds;
  try {
    bounds = resolveMonth(req.query.month);
  } catch (_) {
    return res.status(400).json({ error: 'Mes inválido' });
  }

  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM expenses
          WHERE user_id = ? AND created_at >= ? AND created_at < ?
          ORDER BY created_at DESC, id DESC`,
    args: [req.userId, bounds.start, bounds.end],
  });

  res.json(result.rows);
}));

/**
 * POST /expenses
 * Crea un gasto. Idempotente por client_expense_id.
 */
router.post('/expenses', requireOwner, asyncHandler(async (req, res) => {
  let operationDate;
  try { operationDate = operationTime(req.body.spent_at); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  // Validar method
  if (!WITHDRAWAL_METHODS.includes(req.body.method)) {
    return res.status(400).json({ error: 'Apartado inválido' });
  }

  // Validar amount
  const amount = Number(req.body.amount);
  if (req.body.amount == null || req.body.amount === '' || !Number.isFinite(amount) || round2(amount) <= 0) {
    return res.status(400).json({ error: 'Falta el monto del gasto' });
  }

  // Validar concept
  const concept = req.body.concept == null ? '' : String(req.body.concept).trim();
  if (concept.length < 3 || concept.length > 200) {
    return res.status(400).json({ error: 'Escribe en qué se gastó (entre 3 y 200 caracteres)' });
  }

  // Validar client_expense_id
  const { client_expense_id = null } = req.body;
  if (!client_expense_id) {
    return res.status(400).json({ error: 'client_expense_id es requerido' });
  }

  const db = getDb();

  // Idempotencia (camino rápido)
  if (client_expense_id) {
    const existing = await findByClientId(db, req.userId, client_expense_id);
    if (existing.rows[0]) return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
  }

  const account = await describeAccount(db, req);

  try {
    const inserted = await db.execute({
      sql: `INSERT INTO expenses
              (user_id, client_expense_id, method, amount, concept,
               account_id, account_email, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      args: [
        req.userId, client_expense_id, req.body.method, round2(amount), concept,
        account.id, account.email, operationDate,
      ],
    });
    const row = await db.execute({
      sql: 'SELECT * FROM expenses WHERE id = ?',
      args: [Number(inserted.lastInsertRowid)],
    });
    return res.status(201).json(row.rows[0]);
  } catch (err) {
    if (client_expense_id && isUniqueViolation(err)) {
      const existing = await findByClientId(db, req.userId, client_expense_id);
      if (existing.rows[0]) return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
    }
    throw err;
  }
}));

/**
 * POST /expenses/:clientExpenseId/void
 * Anula un gasto (pone voided_at). Idempotente.
 */
router.post('/expenses/:clientExpenseId/void', requireOwner, asyncHandler(async (req, res) => {
  const db = getDb();
  const { clientExpenseId } = req.params;

  const tx = await db.transaction('write');
  try {
    const expense = await tx.execute({
      sql: 'SELECT * FROM expenses WHERE user_id = ? AND client_expense_id = ?',
      args: [req.userId, clientExpenseId],
    });

    if (expense.rows.length === 0) {
      await tx.rollback();
      return res.status(404).json({ error: 'Gasto no encontrado' });
    }

    const row = expense.rows[0];

    // Ya estaba anulado - idempotente
    if (row.voided_at) {
      await tx.rollback();
      return res.status(200).json(row);
    }

    // Anular el gasto
    await tx.execute({
      sql: 'UPDATE expenses SET voided_at = datetime(\'now\') WHERE id = ? AND voided_at IS NULL',
      args: [row.id],
    });

    await tx.commit();

    const updated = await db.execute({
      sql: 'SELECT * FROM expenses WHERE id = ?',
      args: [row.id],
    });
    return res.status(200).json(updated.rows[0]);
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}));

/**
 * GET /summary?month=YYYY-MM
 * Resumen mensual de ingresos y gastos.
 */
router.get('/summary', requireOwner, asyncHandler(async (req, res) => {
  let bounds;
  try {
    bounds = resolveMonth(req.query.month);
  } catch (_) {
    return res.status(400).json({ error: 'Mes inválido' });
  }

  const db = getDb();
  const { totals, days } = await monthAccounting(db, req.userId, bounds);

  res.json({
    month: bounds.month,
    totals,
    days,
  });
}));

/**
 * GET /export?month=YYYY-MM
 * Descarga Excel con contabilidad del mes.
 */
router.get('/export', requireOwner, asyncHandler(async (req, res) => {
  let bounds;
  try {
    bounds = resolveMonth(req.query.month);
  } catch (_) {
    return res.status(400).json({ error: 'Mes inválido' });
  }

  const db = getDb();
  const { totals, days } = await monthAccounting(db, req.userId, bounds);

  const workbook = new ExcelJS.Workbook();
  const MONEY_FMT = '#,##0.00';

  // Hoja: Resumen por día
  const resumenSheet = workbook.addWorksheet('Resumen por día');
  resumenSheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Ingresos', key: 'ingresos', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Ganancia', key: 'ganancia', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Gastos CUP', key: 'gastos_cup', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Gastos USD', key: 'gastos_usd', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Gastos EUR', key: 'gastos_eur', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Resultado CUP', key: 'resultado_cup', width: 14, style: { numFmt: MONEY_FMT } },
  ];
  styleHeaderRow(resumenSheet.getRow(1));

  // Filas de días
  for (const d of days) {
    resumenSheet.addRow({
      fecha: d.date,
      ingresos: d.income,
      ganancia: d.profit,
      gastos_cup: d.expenses_cup,
      gastos_usd: d.expenses_usd,
      gastos_eur: d.expenses_eur,
      resultado_cup: d.result_cup,
    });
  }

  // Fila de totales
  const totalRow = resumenSheet.addRow({
    fecha: 'Total del mes',
    ingresos: totals.income,
    ganancia: totals.profit,
    gastos_cup: totals.expenses_cup,
    gastos_usd: totals.expenses_usd,
    gastos_eur: totals.expenses_eur,
    resultado_cup: totals.result_cup,
  });
  totalRow.font = { bold: true };

  // Hoja: Gastos
  const gastosSheet = workbook.addWorksheet('Gastos');
  gastosSheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Hora', key: 'hora', width: 8 },
    { header: 'Concepto', key: 'concepto', width: 30 },
    { header: 'Apartado', key: 'apartado', width: 14 },
    { header: 'Monto', key: 'monto', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Registró', key: 'registro', width: 24 },
    { header: 'Estado', key: 'estado', width: 12 },
  ];
  styleHeaderRow(gastosSheet.getRow(1));

  const allExpensesResult = await db.execute({
    sql: `SELECT created_at, method, amount, concept, account_email, voided_at FROM expenses
          WHERE user_id = ? AND created_at >= ? AND created_at < ?
          ORDER BY created_at ASC`,
    args: [req.userId, bounds.start, bounds.end],
  });

  const methodLabels = {
    'efectivo': 'Efectivo',
    'transferencia': 'Transferencia',
    'USD': 'Dólares',
    'EUR': 'Euros',
  };

  for (const row of allExpensesResult.rows) {
    let estado = 'Activo';
    if (row.voided_at) {
      estado = 'Anulado';
    }

    gastosSheet.addRow({
      fecha: shopLocalDate(row.created_at),
      hora: shopLocalTime(row.created_at),
      concepto: row.concept,
      apartado: methodLabels[row.method] || row.method,
      monto: Number(row.amount) || 0,
      registro: row.account_email || '',
      estado,
    });
  }

  // Hoja: Extracciones (reutiliza buildExtraccionesSheet)
  await buildExtraccionesSheet(workbook, db, req.userId, bounds);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="contabilidad-${bounds.month}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}));

module.exports = router;
module.exports.monthAccounting = monthAccounting;
