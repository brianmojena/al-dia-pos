const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireOwner } = require('../middleware/auth');
const { monthBounds, businessCurrentMonth, shopLocalDate, shopLocalTime } = require('../lib/businessDay');
const { paymentSplit, paymentLabel, offShopRate, withdrawalSplit } = require('../lib/payment');

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

// La hoja de ventas va por línea de producto, así que el reparto de un cobro
// mixto no cabe en una columna numérica sin repetirse en cada línea (y sumar
// esa columna daría de más). Va como texto en la columna "Pago"; los totales
// por forma de cobro están en la hoja de días.
const money = (n) => '$' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(n);
const rateText = (n) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(Number(n) || 0);
const paymentDescription = (sale) => {
  if (sale.payment_method === 'divisa') {
    const { cash } = paymentSplit(sale);
    const base = `${rateText(sale.foreign_amount)} ${sale.foreign_currency} a ${rateText(sale.exchange_rate)}`;
    if (Math.round(cash) > 0) return `${base} + efect. ${money(cash)}`;
    if (Math.round(cash) < 0) return `${base} (vuelto ${money(-cash)})`;
    return base;
  }
  if (sale.payment_method !== 'mixto') return paymentLabel(sale);
  const { cash, transfer } = paymentSplit(sale);
  return `Mixto (transf. ${money(transfer)} + efect. ${money(cash)})`;
};

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
    sql: `SELECT created_at, total, profit, payment_method, transfer_amount,
                 foreign_currency, foreign_amount, exchange_rate, shop_rate
          FROM sales WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    args: [userId, bounds.start, bounds.end],
  });
  const closesResult = await db.execute({
    sql: `SELECT closed_at, difference, difference_usd, difference_eur
          FROM cash_closes WHERE user_id = ? AND closed_at >= ? AND closed_at < ?`,
    args: [userId, bounds.start, bounds.end],
  });
  const stockMovesResult = await db.execute({
    sql: `SELECT 'stock_entry' AS type, created_at FROM stock_entries WHERE user_id = ? AND created_at >= ? AND created_at < ?
          UNION ALL
          SELECT 'transfer' AS type, created_at FROM warehouse_transfers WHERE user_id = ? AND created_at >= ? AND created_at < ?
          UNION ALL
          SELECT 'warehouse_change' AS type, created_at FROM warehouse_changes WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    args: [userId, bounds.start, bounds.end, userId, bounds.start, bounds.end, userId, bounds.start, bounds.end],
  });

  const byDate = new Map();
  const dayFor = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date, sales_count: 0, total: 0, cash_total: 0, transfer_total: 0, profit: 0,
        foreign_total: 0, usd_total: 0, eur_total: 0, off_rate_count: 0, stock_moves: 0,
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
    // Solo el efectivo pesa en la gaveta; el resto son transferencias. Una
    // venta mixta reparte su total entre las dos columnas.
    const split = paymentSplit(row);
    d.cash_total += split.cash;
    d.transfer_total += split.transfer;
    // La divisa va en su propia columna, en pesos a la tasa del cobro: así
    // efectivo + transferencia + divisa sigue sumando el total del día.
    d.foreign_total += split.foreign_cup;
    d.usd_total += split.usd;
    d.eur_total += split.eur;
    if (offShopRate(row)) d.off_rate_count += 1;
  }

  for (const row of closesResult.rows) {
    const date = shopLocalDate(row.closed_at);
    if (!date) continue;
    const d = dayFor(date);
    const diff = Number(row.difference) || 0;
    if (!d.closes) d.closes = { count: 0, difference: 0, difference_usd: 0, difference_eur: 0, short: false };
    d.closes.count += 1;
    d.closes.difference += diff;
    d.closes.difference_usd += Number(row.difference_usd) || 0;
    d.closes.difference_eur += Number(row.difference_eur) || 0;
    if (diff < -0.5 || Number(row.difference_usd) < -0.005 || Number(row.difference_eur) < -0.005) d.closes.short = true;
  }

  for (const row of stockMovesResult.rows) {
    const date = shopLocalDate(row.created_at);
    if (!date) continue;
    const d = dayFor(date);
    d.stock_moves += 1;
  }

  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((d) => ({
      ...d,
      total: round2(d.total),
      cash_total: round2(d.cash_total),
      transfer_total: round2(d.transfer_total),
      foreign_total: round2(d.foreign_total),
      usd_total: round2(d.usd_total),
      eur_total: round2(d.eur_total),
      profit: round2(d.profit),
      closes: d.closes ? {
        ...d.closes,
        difference: round2(d.closes.difference),
        difference_usd: round2(d.closes.difference_usd),
        difference_eur: round2(d.closes.difference_eur),
      } : null,
    }));

  return days;
}

const TOTAL_KEYS = ['total', 'cash_total', 'transfer_total', 'foreign_total', 'usd_total', 'eur_total', 'profit'];
const sumTotals = (days) => days.reduce((acc, d) => {
  const next = {
    sales_count: acc.sales_count + d.sales_count,
    off_rate_count: acc.off_rate_count + d.off_rate_count,
  };
  for (const key of TOTAL_KEYS) next[key] = round2(acc[key] + d[key]);
  return next;
}, { sales_count: 0, off_rate_count: 0, ...Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0])) });

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
    { header: 'Divisa (en CUP)', key: 'divisa', width: 15, style: { numFmt: MONEY_FMT } },
    { header: 'USD recibidos', key: 'usd', width: 13, style: { numFmt: MONEY_FMT } },
    { header: 'EUR recibidos', key: 'eur', width: 13, style: { numFmt: MONEY_FMT } },
    { header: 'Ganancia', key: 'ganancia', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Cierres', key: 'cierres', width: 10 },
    { header: 'Diferencia de caja', key: 'diferencia', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Diferencia USD', key: 'diferencia_usd', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Diferencia EUR', key: 'diferencia_eur', width: 14, style: { numFmt: MONEY_FMT } },
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
      divisa: d.foreign_total,
      usd: d.usd_total,
      eur: d.eur_total,
      ganancia: d.profit,
      cierres: d.closes ? d.closes.count : 0,
      diferencia: d.closes ? d.closes.difference : 0,
      diferencia_usd: d.closes ? d.closes.difference_usd : 0,
      diferencia_eur: d.closes ? d.closes.difference_eur : 0,
    });
  }

  const totalRow = sheet.addRow({
    fecha: 'Total del mes',
    ventas: totals.sales_count,
    total: totals.total,
    efectivo: totals.cash_total,
    transferencia: totals.transfer_total,
    divisa: totals.foreign_total,
    usd: totals.usd_total,
    eur: totals.eur_total,
    ganancia: totals.profit,
    cierres: '',
    diferencia: '',
    diferencia_usd: '',
    diferencia_eur: '',
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
    { header: 'Forma de pago', key: 'pago', width: 30 },
    { header: 'Cobró', key: 'cobro', width: 24 },
  ];
  styleHeaderRow(sheet.getRow(1));

  const result = await db.execute({
    sql: `SELECT s.id AS sale_id, s.created_at, s.payment_method, s.transfer_amount, s.total, s.account_email,
                 s.foreign_currency, s.foreign_amount, s.exchange_rate, s.shop_rate,
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
      pago: paymentDescription(row),
      cobro: row.account_email || '',
    });
  }

  return result.rows.length;
}

/**
 * Una fila por venta cobrada en dólares o euros: a cuánto se tomó cada billete
 * y si esa era la tasa de la tienda. Va en su propia hoja porque la de ventas
 * es por línea de producto, y repetir ahí los billetes haría que sumar la
 * columna diera de más.
 */
async function buildDivisaSheet(workbook, db, userId, bounds) {
  const sheet = workbook.addWorksheet('Cobros en divisa');
  sheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Hora', key: 'hora', width: 8 },
    { header: 'Venta #', key: 'venta', width: 10 },
    { header: 'Cobró', key: 'cobro', width: 24 },
    { header: 'Moneda', key: 'moneda', width: 9 },
    { header: 'Recibido', key: 'recibido', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Tasa usada', key: 'tasa', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Tasa de la tienda', key: 'tasa_tienda', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Equivale (CUP)', key: 'equivale', width: 15, style: { numFmt: MONEY_FMT } },
    { header: 'Total venta (CUP)', key: 'total', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Efectivo CUP recibido', key: 'efectivo', width: 19, style: { numFmt: MONEY_FMT } },
    { header: 'Vuelto CUP', key: 'vuelto', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Aviso', key: 'aviso', width: 30 },
  ];
  styleHeaderRow(sheet.getRow(1));

  const result = await db.execute({
    sql: `SELECT id, created_at, account_email, total, payment_method,
                 foreign_currency, foreign_amount, exchange_rate, shop_rate
          FROM sales WHERE user_id = ? AND payment_method = 'divisa'
            AND created_at >= ? AND created_at < ?
          ORDER BY created_at ASC, id ASC`,
    args: [userId, bounds.start, bounds.end],
  });

  for (const row of result.rows) {
    const split = paymentSplit(row);
    const added = sheet.addRow({
      fecha: shopLocalDate(row.created_at),
      hora: shopLocalTime(row.created_at),
      venta: Number(row.id),
      cobro: row.account_email || '',
      moneda: row.foreign_currency,
      recibido: Number(row.foreign_amount) || 0,
      tasa: Number(row.exchange_rate) || 0,
      tasa_tienda: row.shop_rate == null ? '' : Number(row.shop_rate),
      equivale: split.foreign_cup,
      total: Number(row.total) || 0,
      efectivo: Math.max(0, split.cash),
      vuelto: Math.max(0, -split.cash),
      aviso: offShopRate(row) ? 'Tasa distinta a la de la tienda' : '',
    });
    if (offShopRate(row)) added.font = { color: { argb: 'FFC2410C' } };
  }
}

async function buildExtraccionesSheet(workbook, db, userId, bounds) {
  const sheet = workbook.addWorksheet('Extracciones');
  sheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Hora', key: 'hora', width: 8 },
    { header: 'Apartado', key: 'apartado', width: 14 },
    { header: 'Cantidad', key: 'cantidad', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Nota', key: 'nota', width: 30 },
    { header: 'Quién', key: 'quien', width: 24 },
    { header: 'Estado', key: 'estado', width: 12 },
  ];
  styleHeaderRow(sheet.getRow(1));

  const result = await db.execute({
    sql: `SELECT created_at, method, amount, note, account_email, voided_at, cash_close_id
          FROM cash_withdrawals WHERE user_id = ? AND created_at >= ? AND created_at < ?
          ORDER BY created_at ASC`,
    args: [userId, bounds.start, bounds.end],
  });

  const methodLabels = {
    'efectivo': 'Efectivo',
    'transferencia': 'Transferencia',
    'USD': 'Dólares',
    'EUR': 'Euros',
  };

  for (const row of result.rows) {
    let estado = 'Abierta';
    if (row.voided_at) {
      estado = 'Anulada';
    } else if (row.cash_close_id != null) {
      estado = 'En cierre';
    }

    sheet.addRow({
      fecha: shopLocalDate(row.created_at),
      hora: shopLocalTime(row.created_at),
      apartado: methodLabels[row.method] || row.method,
      cantidad: Number(row.amount) || 0,
      nota: row.note || '',
      quien: row.account_email || '',
      estado,
    });
  }
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
    { header: 'Extraído (efectivo)', key: 'extraido', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'USD esperado', key: 'usd_esperado', width: 13, style: { numFmt: MONEY_FMT } },
    { header: 'USD contado', key: 'usd_contado', width: 13, style: { numFmt: MONEY_FMT } },
    { header: 'Diferencia USD', key: 'usd_diferencia', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'EUR esperado', key: 'eur_esperado', width: 13, style: { numFmt: MONEY_FMT } },
    { header: 'EUR contado', key: 'eur_contado', width: 13, style: { numFmt: MONEY_FMT } },
    { header: 'Diferencia EUR', key: 'eur_diferencia', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Ventas', key: 'ventas', width: 10 },
    { header: 'Nota', key: 'nota', width: 30 },
  ];
  styleHeaderRow(sheet.getRow(1));

  const result = await db.execute({
    sql: `SELECT closed_at, account_email, opening_float, expected_cash, counted_cash,
                 difference, expected_transfer, sales_count, note,
                 expected_usd, counted_usd, difference_usd,
                 expected_eur, counted_eur, difference_eur,
                 withdrawn_cash
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
      extraido: Number(row.withdrawn_cash) || 0,
      usd_esperado: Number(row.expected_usd) || 0,
      usd_contado: Number(row.counted_usd) || 0,
      usd_diferencia: Number(row.difference_usd) || 0,
      eur_esperado: Number(row.expected_eur) || 0,
      eur_contado: Number(row.counted_eur) || 0,
      eur_diferencia: Number(row.difference_eur) || 0,
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
  await buildDivisaSheet(workbook, db, req.userId, bounds);
  await buildExtraccionesSheet(workbook, db, req.userId, bounds);
  await buildCierresSheet(workbook, db, req.userId, bounds);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ventas-${bounds.month}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}));

module.exports = router;
module.exports.daySummaries = daySummaries;
module.exports.sumTotals = sumTotals;
module.exports.resolveMonth = resolveMonth;
module.exports.buildExtraccionesSheet = buildExtraccionesSheet;
module.exports.styleHeaderRow = styleHeaderRow;
