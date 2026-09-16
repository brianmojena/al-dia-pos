const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireOwner } = require('../middleware/auth');
const { monthBounds, businessCurrentMonth, shopLocalDate, shopLocalTime } = require('../lib/businessDay');

/**
 * El histórico de ventas (esta carpeta) es para el "económico" — quien revisa
 * DÍAS PASADOS, no el que está parado en la caja ahora. Por eso todo aquí es
 * requireOwner: es el mismo dato que el conteo a ciegas del cierre de caja le
 * esconde al cajero (cuánto se vendió, cuánto faltó), solo que de meses
 * enteros en vez de un turno.
 */

// Redondea a centavos: sumar muchos REAL de SQLite puede dejar residuos de
// punto flotante (0.1 + 0.2 en JS), y un total de mes con ".00000000004" se
// ve roto en la pantalla del dueño aunque matemáticamente esté bien.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// 'YYYY-MM' del query, o el mes actual del negocio si no lo mandan. Lanza si
// viene con forma inválida — lo capturan las rutas para responder 400.
const resolveMonth = (monthParam) => {
  // Sin parámetro, el mes actual. Con un parámetro vacío (?month=) NO: eso es
  // un error de quien llama, y devolver el mes corriente escondería el fallo
  // detrás de datos que parecen buenos.
  const month = monthParam === undefined ? businessCurrentMonth() : String(monthParam);
  return monthBounds(month); // puede lanzar
};

/**
 * Trae ventas y cierres del mes de un solo golpe (dos consultas, no una por
 * día) y los agrupa en JS por el día LOCAL de la tienda. Turso es una base
 * remota: una consulta por día de un mes de 30 días son 30 viajes de red que
 * el dueño paga en segundos de espera.
 *
 * Devuelve los días más recientes primero — así los consume la pantalla de
 * histórico, que abre mostrando lo más reciente arriba.
 */
async function daySummaries(db, userId, bounds) {
  const salesResult = await db.execute({
    sql: `SELECT created_at, total, profit, payment_method
          FROM sales WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    args: [userId, bounds.start, bounds.end],
  });
  const closesResult = await db.execute({
    sql: `SELECT closed_at, difference
          FROM cash_closes WHERE user_id = ? AND closed_at >= ? AND closed_at < ?`,
    args: [userId, bounds.start, bounds.end],
  });

  const byDate = new Map();
  const dayFor = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date, sales_count: 0, total: 0, cash_total: 0, transfer_total: 0, profit: 0,
        closes: null,
      });
    }
    return byDate.get(date);
  };

  for (const row of salesResult.rows) {
    const date = shopLocalDate(row.created_at);
    if (!date) continue; // fila sin created_at válido; no debería pasar, pero no tumba el reporte
    const d = dayFor(date);
    const total = Number(row.total) || 0;
    d.sales_count += 1;
    d.total += total;
    d.profit += Number(row.profit) || 0;
    // Solo el efectivo pesa en la gaveta; el resto son transferencias.
    if (row.payment_method === 'transferencia') d.transfer_total += total;
    else d.cash_total += total;
  }

  for (const row of closesResult.rows) {
    const date = shopLocalDate(row.closed_at);
    if (!date) continue;
    const d = dayFor(date);
    const diff = Number(row.difference) || 0;
    if (!d.closes) d.closes = { count: 0, difference: 0, short: false };
    d.closes.count += 1;
    d.closes.difference += diff;
    if (diff < -0.5) d.closes.short = true;
  }

  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((d) => ({
      ...d,
      total: round2(d.total),
      cash_total: round2(d.cash_total),
      transfer_total: round2(d.transfer_total),
      profit: round2(d.profit),
      closes: d.closes ? { ...d.closes, difference: round2(d.closes.difference) } : null,
    }));

  return days;
}

const sumTotals = (days) => days.reduce((acc, d) => ({
  sales_count: acc.sales_count + d.sales_count,
  total: round2(acc.total + d.total),
  cash_total: round2(acc.cash_total + d.cash_total),
  transfer_total: round2(acc.transfer_total + d.transfer_total),
  profit: round2(acc.profit + d.profit),
}), { sales_count: 0, total: 0, cash_total: 0, transfer_total: 0, profit: 0 });

// Lista de días con actividad en el mes — la pantalla de histórico del
// económico: toca un día y ve sus ventas con GET /api/sales?date=.
router.get('/days', requireOwner, asyncHandler(async (req, res) => {
  let bounds;
  try {
    bounds = resolveMonth(req.query.month);
  } catch (_) {
    return res.status(400).json({ error: 'Mes inválido' });
  }

  const days = await daySummaries(getDb(), req.userId, bounds);
  res.json({ month: bounds.month, totals: sumTotals(days), days });
}));

// --- Excel -------------------------------------------------------------

const MONEY_FMT = '#,##0.00';

function styleHeaderRow(row) {
  row.font = { bold: true };
  row.eachCell((cell) => { cell.alignment = { vertical: 'middle' }; });
}

function buildResumenSheet(workbook, days, totals) {
  const sheet = workbook.addWorksheet('Resumen por día');
  sheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Ventas', key: 'ventas', width: 10 },
    { header: 'Total', key: 'total', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Efectivo', key: 'efectivo', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Transferencia', key: 'transferencia', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Ganancia', key: 'ganancia', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Cierres', key: 'cierres', width: 10 },
    { header: 'Diferencia de caja', key: 'diferencia', width: 16, style: { numFmt: MONEY_FMT } },
  ];
  styleHeaderRow(sheet.getRow(1));

  // Aquí sí de más viejo a más nuevo: se lee como un libro contable, no como
  // una pantalla de "lo último arriba".
  for (const d of [...days].reverse()) {
    sheet.addRow({
      fecha: d.date,
      ventas: d.sales_count,
      total: d.total,
      efectivo: d.cash_total,
      transferencia: d.transfer_total,
      ganancia: d.profit,
      cierres: d.closes ? d.closes.count : 0,
      diferencia: d.closes ? d.closes.difference : 0,
    });
  }

  const totalRow = sheet.addRow({
    fecha: 'Total del mes',
    ventas: totals.sales_count,
    total: totals.total,
    efectivo: totals.cash_total,
    transferencia: totals.transfer_total,
    ganancia: totals.profit,
    cierres: '',
    diferencia: '',
  });
  totalRow.font = { bold: true };
}

async function buildVentasSheet(workbook, db, userId, bounds) {
  const sheet = workbook.addWorksheet('Ventas');
  sheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Hora', key: 'hora', width: 8 },
    { header: 'Venta #', key: 'venta', width: 10 },
    { header: 'Producto', key: 'producto', width: 28 },
    { header: 'Cantidad', key: 'cantidad', width: 10 },
    { header: 'Precio unitario', key: 'precio', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Importe', key: 'importe', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Forma de pago', key: 'pago', width: 14 },
    { header: 'Cobró', key: 'cobro', width: 24 },
  ];
  styleHeaderRow(sheet.getRow(1));

  const result = await db.execute({
    sql: `SELECT s.id AS sale_id, s.created_at, s.payment_method, s.account_email,
                 si.product_name, si.quantity, si.unit_price
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
          WHERE s.user_id = ? AND s.created_at >= ? AND s.created_at < ?
          ORDER BY s.created_at ASC, s.id ASC, si.id ASC`,
    args: [userId, bounds.start, bounds.end],
  });

  for (const row of result.rows) {
    const quantity = Number(row.quantity) || 0;
    const unitPrice = Number(row.unit_price) || 0;
    sheet.addRow({
      fecha: shopLocalDate(row.created_at),
      hora: shopLocalTime(row.created_at),
      venta: Number(row.sale_id),
      producto: row.product_name,
      cantidad: quantity,
      precio: unitPrice,
      importe: round2(quantity * unitPrice),
      pago: row.payment_method === 'transferencia' ? 'Transferencia' : 'Efectivo',
      cobro: row.account_email || '',
    });
  }

  return result.rows.length;
}

async function buildCierresSheet(workbook, db, userId, bounds) {
  const sheet = workbook.addWorksheet('Cierres de caja');
  sheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Hora', key: 'hora', width: 8 },
    { header: 'Cerró', key: 'cerro', width: 24 },
    { header: 'Fondo inicial', key: 'fondo', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Efectivo esperado', key: 'esperado', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Efectivo contado', key: 'contado', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Diferencia', key: 'diferencia', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Transferencias', key: 'transferencias', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Ventas', key: 'ventas', width: 10 },
    { header: 'Nota', key: 'nota', width: 30 },
  ];
  styleHeaderRow(sheet.getRow(1));

  const result = await db.execute({
    sql: `SELECT closed_at, account_email, opening_float, expected_cash, counted_cash,
                 difference, expected_transfer, sales_count, note
          FROM cash_closes WHERE user_id = ? AND closed_at >= ? AND closed_at < ?
          ORDER BY closed_at ASC`,
    args: [userId, bounds.start, bounds.end],
  });

  for (const row of result.rows) {
    sheet.addRow({
      fecha: shopLocalDate(row.closed_at),
      hora: shopLocalTime(row.closed_at),
      cerro: row.account_email || '',
      fondo: Number(row.opening_float) || 0,
      esperado: Number(row.expected_cash) || 0,
      contado: Number(row.counted_cash) || 0,
      diferencia: Number(row.difference) || 0,
      transferencias: Number(row.expected_transfer) || 0,
      ventas: Number(row.sales_count) || 0,
      nota: row.note || '',
    });
  }
}

// Descarga en Excel del mes completo: lo que el económico se lleva a revisar
// fuera del sistema, o le manda al dueño / al contador de verdad.
router.get('/export', requireOwner, asyncHandler(async (req, res) => {
  let bounds;
  try {
    bounds = resolveMonth(req.query.month);
  } catch (_) {
    return res.status(400).json({ error: 'Mes inválido' });
  }

  const db = getDb();
  const days = await daySummaries(db, req.userId, bounds);
  const totals = sumTotals(days);

  const workbook = new ExcelJS.Workbook();
  buildResumenSheet(workbook, days, totals);
  await buildVentasSheet(workbook, db, req.userId, bounds);
  await buildCierresSheet(workbook, db, req.userId, bounds);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ventas-${bounds.month}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}));

module.exports = router;
