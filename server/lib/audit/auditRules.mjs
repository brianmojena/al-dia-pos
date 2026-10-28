/**
 * Reglas deterministas de auditoría de caja.
 *
 * Este módulo es la única fuente de verdad de los números que ve la IA. El
 * cron externo, el procesador local y las pruebas importan exactamente el
 * mismo archivo: si una regla cambia, cambia para todos.
 *
 * No usa APIs de Node ni de Deno. Recibe filas ya consultadas y devuelve un
 * snapshot con métricas y señales. La IA solo redacta sobre ese snapshot; no
 * calcula saldos ni diferencias.
 */

export const PROMPT_VERSION = '2026-10-27.1';

export const SEVERITY_ORDER = { ok: 0, info: 1, warning: 2, critical: 3 };

export const DEFAULT_THRESHOLDS = {
  squareCash: 0.5,
  squareForeign: 0.005,
  criticalAbsoluteCash: 500,
  criticalRelativeCash: 0.02,
  criticalForeign: 5,
  surplusWarning: 100,
  repeatedShortfallsWarning: 2,
  repeatedShortfallsCritical: 3,
  offRateCriticalGap: 500,
  withdrawalWindowMinutes: 30,
  openingFloatMinGap: 500,
  openingFloatRelative: 0.2,
  maxPeriodHours: 24,
  minPeriodMinutes: 3,
  duplicateCloseMinutes: 5,
};

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const abs = (value) => Math.abs(number(value));

const round2 = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;

const sum = (rows, pick) => round2(rows.reduce((total, row) => total + number(pick(row)), 0));

const percent = (part, whole) => {
  if (!whole) return null;
  return round2((number(part) / number(whole)) * 100);
};

const parseDate = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};

const hoursBetween = (from, to) => {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) return null;
  return round2((end.getTime() - start.getTime()) / 36e5);
};

const minutesBetween = (from, to) => {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) return null;
  return round2((end.getTime() - start.getTime()) / 6e4);
};

const cashierKey = (row) => {
  if (row?.account_id != null) return `id:${row.account_id}`;
  const email = String(row?.account_email || '').trim().toLowerCase();
  return email ? `email:${email}` : 'unknown';
};

const cashierSeed = (row) => ({
  account_id: row?.account_id == null ? null : Number(row.account_id),
  account_email: row?.account_email || null,
  sales_count: 0,
  sales_total: 0,
  usd_sales: 0,
  eur_sales: 0,
  off_rate_sales: 0,
  off_rate_gap_cup: 0,
  closes_30d: 0,
  shortfalls_30d: 0,
  total_difference_30d: 0,
  worst_difference_30d: 0,
  last_close_at: null,
  is_closing_cashier: false,
});

const ensureCashier = (map, row) => {
  const key = cashierKey(row);
  if (!map.has(key)) map.set(key, { key, ...cashierSeed(row) });
  const cashier = map.get(key);
  if (cashier.account_id == null && row?.account_id != null) cashier.account_id = Number(row.account_id);
  if (!cashier.account_email && row?.account_email) cashier.account_email = row.account_email;
  return cashier;
};

const computeStats = (values) => {
  if (!values.length) return { mean: null, stddev: null, count: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return { mean: round2(mean), stddev: round2(Math.sqrt(variance)), count: values.length };
};

const isShortfall = (row, thresholds) =>
  number(row.difference) < -thresholds.squareCash
  || number(row.difference_usd) < -thresholds.squareForeign
  || number(row.difference_eur) < -thresholds.squareForeign;

const isForeignDifference = (row, thresholds) =>
  abs(row.difference_usd) > thresholds.squareForeign
  || abs(row.difference_eur) > thresholds.squareForeign;

const signal = ({ id, severity, title, evidence, amount = null, currency = 'CUP', subjectLabel = null, details = null }) => ({
  id,
  severity,
  title,
  evidence,
  amount: amount == null ? null : round2(amount),
  currency,
  subject_label: subjectLabel,
  details,
});

const maxSeverity = (signals) => signals.reduce(
  (worst, item) => (SEVERITY_ORDER[item.severity] > SEVERITY_ORDER[worst] ? item.severity : worst),
  'ok',
);

/**
 * Construye la foto determinista del cierre.
 *
 * `priorCloses` debe traer los cierres de los últimos 30 días de la tienda,
 * sin incluir el cierre actual. `rejectedSales` son las ventas rechazadas sin
 * revisar cercanas al período. `corrections` son las correcciones del cierre.
 */
export function buildAuditSnapshot({
  close = {},
  sales = [],
  purchases = [],
  withdrawals = [],
  corrections = [],
  priorCloses = [],
  rejectedSales = [],
  context = {},
  thresholds = {},
} = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const cashiers = new Map();
  const closing = ensureCashier(cashiers, close);
  closing.is_closing_cashier = true;

  const purchaseUsd = sum(purchases.filter((p) => p.foreign_currency === 'USD'), (p) => p.foreign_amount);
  const purchaseEur = sum(purchases.filter((p) => p.foreign_currency === 'EUR'), (p) => p.foreign_amount);
  const purchasesCup = sum(purchases, (p) => p.cup_amount);

  const withdrawnCash = sum(withdrawals, (w) => (w.method === 'efectivo' && !w.voided_at ? w.amount : 0));
  const withdrawnTransfer = sum(withdrawals, (w) => (w.method === 'transferencia' && !w.voided_at ? w.amount : 0));
  const withdrawnUsd = sum(withdrawals, (w) => (w.method === 'USD' && !w.voided_at ? w.amount : 0));
  const withdrawnEur = sum(withdrawals, (w) => (w.method === 'EUR' && !w.voided_at ? w.amount : 0));

  // El cierre ya guarda el esperado por apartado. Se despeja la venta bruta
  // en vez de volver a repartir cada venta: así la auditoría usa exactamente
  // la misma aritmética con la que se cerró la caja.
  const cashSales = round2(number(close.expected_cash) - number(close.opening_float) + purchasesCup + withdrawnCash);
  const transferSales = round2(number(close.expected_transfer) + withdrawnTransfer);
  const usdSales = round2(number(close.expected_usd) - purchaseUsd + withdrawnUsd);
  const eurSales = round2(number(close.expected_eur) - purchaseEur + withdrawnEur);

  const offRateSales = sales.filter((sale) => sale.payment_method === 'divisa'
    && sale.shop_rate != null
    && abs(number(sale.exchange_rate) - number(sale.shop_rate)) > limits.squareForeign);
  const offRateGap = sum(offRateSales, (sale) => number(sale.foreign_amount) * (number(sale.exchange_rate) - number(sale.shop_rate)));

  const offRatePurchases = purchases.filter((purchase) => purchase.shop_rate != null
    && abs(number(purchase.exchange_rate) - number(purchase.shop_rate)) > limits.squareForeign);
  const offRatePurchaseGap = sum(offRatePurchases, (purchase) => number(purchase.foreign_amount)
    * (number(purchase.exchange_rate) - number(purchase.shop_rate)));

  for (const sale of sales) {
    const cashier = ensureCashier(cashiers, sale);
    cashier.sales_count += 1;
    cashier.sales_total = round2(cashier.sales_total + number(sale.total));
    if (sale.payment_method === 'divisa') {
      if (sale.foreign_currency === 'USD') cashier.usd_sales = round2(cashier.usd_sales + number(sale.foreign_amount));
      if (sale.foreign_currency === 'EUR') cashier.eur_sales = round2(cashier.eur_sales + number(sale.foreign_amount));
      if (sale.shop_rate != null && abs(number(sale.exchange_rate) - number(sale.shop_rate)) > limits.squareForeign) {
        cashier.off_rate_sales += 1;
        cashier.off_rate_gap_cup = round2(cashier.off_rate_gap_cup
          + number(sale.foreign_amount) * (number(sale.exchange_rate) - number(sale.shop_rate)));
      }
    }
  }

  for (const purchase of purchases) ensureCashier(cashiers, purchase);
  for (const withdrawal of withdrawals) ensureCashier(cashiers, withdrawal);
  for (const correction of corrections) ensureCashier(cashiers, correction);

  for (const prior of priorCloses) {
    const cashier = ensureCashier(cashiers, prior);
    cashier.closes_30d += 1;
    cashier.total_difference_30d = round2(cashier.total_difference_30d + number(prior.difference));
    cashier.worst_difference_30d = Math.min(cashier.worst_difference_30d, number(prior.difference));
    if (isShortfall(prior, limits)) cashier.shortfalls_30d += 1;
    if (!cashier.last_close_at || String(prior.closed_at) > String(cashier.last_close_at)) {
      cashier.last_close_at = prior.closed_at || null;
    }
  }

  const closingValues = priorCloses
    .filter((prior) => cashierKey(prior) === closing.key)
    .map((prior) => number(prior.difference));
  const closingStats = computeStats(closingValues);

  const ordered = [...cashiers.values()].sort((left, right) => {
    if (left.is_closing_cashier !== right.is_closing_cashier) return left.is_closing_cashier ? -1 : 1;
    const activity = (right.sales_count + right.closes_30d) - (left.sales_count + left.closes_30d);
    return activity || String(left.account_email || '').localeCompare(String(right.account_email || ''));
  });

  ordered.forEach((cashier, index) => {
    cashier.label = `Cajero ${index + 1}`;
    cashier.avg_difference_30d = cashier.closes_30d
      ? round2(cashier.total_difference_30d / cashier.closes_30d) : null;
    cashier.z_score = cashier.is_closing_cashier && closingStats.count >= 3 && closingStats.stddev
      ? round2((number(close.difference) - closingStats.mean) / closingStats.stddev) : null;
  });

  const closingLabel = closing.label || 'Cajero 1';
  const periodHours = hoursBetween(close.opened_at, close.closed_at);

  const previousClose = context.previousClose || null;
  const cashWithdrawals = withdrawals.filter((w) => w.method === 'efectivo' && !w.voided_at);
  const previousRegisterClose = context.previousRegisterClose || null;
  const duplicateMinutes = previousRegisterClose
    ? minutesBetween(previousRegisterClose.closed_at, close.closed_at) : null;

  const rejectedTotal = sum(rejectedSales, (sale) => sale.total);
  const rejectionCount = rejectedSales.length;

  const metrics = {
    close: {
      id: Number(close.id),
      opened_at: close.opened_at || null,
      closed_at: close.closed_at || null,
      register_id: close.register_id || null,
      sales_count: Number(close.sales_count) || 0,
      opening_float: round2(close.opening_float),
      expected_cash: round2(close.expected_cash),
      counted_cash: round2(close.counted_cash),
      difference: round2(close.difference),
      expected_transfer: round2(close.expected_transfer),
      expected_usd: round2(close.expected_usd),
      counted_usd: round2(close.counted_usd),
      difference_usd: round2(close.difference_usd),
      expected_eur: round2(close.expected_eur),
      counted_eur: round2(close.counted_eur),
      difference_eur: round2(close.difference_eur),
      withdrawn_cash: round2(close.withdrawn_cash),
      withdrawn_transfer: round2(close.withdrawn_transfer),
      withdrawn_usd: round2(close.withdrawn_usd),
      withdrawn_eur: round2(close.withdrawn_eur),
      overlap_sales: Number(close.overlap_sales) || 0,
      correction_revision: Number(close.correction_revision) || 0,
      shared_register: String(close.register_id || '').startsWith('shared:'),
      closing_cashier_label: closingLabel,
      closing_actor_label: closingLabel,
    },
    period: {
      hours: periodHours,
      sales_count: sales.length,
      total_sales: sum(sales, (sale) => sale.total),
      // Separar de forma explícita la persona que registró ventas de quien
      // cerró la caja: el autor del cierre no se atribuye ventas por defecto.
      sales_operators: ordered.filter((cashier) => cashier.sales_count > 0).map((cashier) => ({
        label: cashier.label,
        sales_count: cashier.sales_count,
        sales_total: cashier.sales_total,
      })),
      cash_sales: cashSales,
      transfer_sales: transferSales,
      usd_sales: usdSales,
      eur_sales: eurSales,
      purchases_count: purchases.length,
      purchases_cup: purchasesCup,
      withdrawals_count: withdrawals.length,
      withdrawals_cash: withdrawnCash,
      withdrawals_transfer: withdrawnTransfer,
      withdrawals_usd: withdrawnUsd,
      withdrawals_eur: withdrawnEur,
      off_rate_sales: offRateSales.length,
      off_rate_gap_cup: offRateGap,
      off_rate_purchases: offRatePurchases.length,
      off_rate_purchase_gap_cup: offRatePurchaseGap,
    },
    differences: {
      cash: round2(close.difference),
      cash_percent: percent(close.difference, close.expected_cash),
      usd: round2(close.difference_usd),
      eur: round2(close.difference_eur),
    },
    cashiers: ordered.map((cashier) => ({
      label: cashier.label,
      account_id: cashier.account_id,
      account_email: cashier.account_email,
      is_closing_cashier: cashier.is_closing_cashier,
      sales_count: cashier.sales_count,
      sales_total: cashier.sales_total,
      usd_sales: cashier.usd_sales,
      eur_sales: cashier.eur_sales,
      off_rate_sales: cashier.off_rate_sales,
      off_rate_gap_cup: cashier.off_rate_gap_cup,
      closes_30d: cashier.closes_30d,
      shortfalls_30d: cashier.shortfalls_30d,
      total_difference_30d: cashier.total_difference_30d,
      avg_difference_30d: cashier.avg_difference_30d,
      worst_difference_30d: cashier.worst_difference_30d,
      z_score: cashier.z_score,
      this_close_difference: cashier.is_closing_cashier ? round2(close.difference) : null,
      last_close_at: cashier.last_close_at,
    })),
    context: {
      prior_close: previousClose ? {
        id: previousClose.id,
        closed_at: previousClose.closed_at,
        counted_cash: round2(previousClose.counted_cash),
        opening_float: round2(previousClose.opening_float),
      } : null,
      previous_register_close_at: previousRegisterClose?.closed_at || null,
      previous_register_close_minutes: duplicateMinutes,
      same_register_closes_today: Number(context.sameRegisterClosesToday) || 0,
      corrections_count: corrections.length,
      rejected_sales_count: rejectionCount,
      rejected_sales_total: rejectedTotal,
      open_sales_older_than_24h: Number(context.openSalesOlderThan24h) || 0,
      inventory_check: context.inventoryCheck ? {
        available: context.inventoryCheck.available,
        verdict: context.inventoryCheck.verdict,
        message: context.inventoryCheck.message,
        products_counted: context.inventoryCheck.products_counted ?? null,
        products_total: context.inventoryCheck.products_total ?? null,
        units_missing: context.inventoryCheck.units_missing ?? null,
        units_extra: context.inventoryCheck.units_extra ?? null,
        value_missing: context.inventoryCheck.value_missing ?? null,
        value_extra: context.inventoryCheck.value_extra ?? null,
        net_missing_value: context.inventoryCheck.net_missing_value ?? null,
        value_basis: 'valoración de mercancía; no equivale a efectivo',
        cash_difference: context.inventoryCheck.cash_difference ?? null,
        minutes_before_close: context.inventoryCheck.minutes_before_close ?? null,
        counted_at: context.inventoryCheck.counted_at ?? null,
        count_id: context.inventoryCheck.count_id ?? null,
        closed_by: context.inventoryCheck.closed_by ? closingLabel : null,
        uncounted_sold_products: context.inventoryCheck.uncounted_sold_products ?? [],
        uncounted_sold_products_count: context.inventoryCheck.uncounted_sold_products_count ?? 0,
        stock_adjustments_count: context.inventoryCheck.stock_adjustments_count ?? 0,
        stock_adjustments_before_count: context.inventoryCheck.stock_adjustments_before_count ?? 0,
        stock_adjustments_after_count: context.inventoryCheck.stock_adjustments_after_count ?? 0,
        stock_adjustment_units_in: context.inventoryCheck.stock_adjustment_units_in ?? 0,
        stock_adjustment_units_out: context.inventoryCheck.stock_adjustment_units_out ?? 0,
        linked_sales_count: context.inventoryCheck.linked_sales_count ?? 0,
        counted_after_close: context.inventoryCheck.counted_after_close ?? false,
        timing_uncertain: context.inventoryCheck.timing_uncertain ?? false,
        stock_tracking_history_known: context.inventoryCheck.stock_tracking_history_known ?? null,
      } : null,
    },
  };

  const signals = [];
  const diff = number(close.difference);
  const expected = number(close.expected_cash);
  const usdDiff = number(close.difference_usd);
  const eurDiff = number(close.difference_eur);
  const square = abs(diff) <= limits.squareCash
    && abs(usdDiff) <= limits.squareForeign
    && abs(eurDiff) <= limits.squareForeign;

  if (!square && (diff < -limits.squareCash || diff > limits.squareCash)) {
    const shortfall = diff < 0;
    const relative = expected ? abs(diff) / expected : 0;
    const critical = shortfall
      ? abs(diff) >= Math.max(limits.criticalAbsoluteCash, expected * limits.criticalRelativeCash)
      : false;
    signals.push(signal({
      id: 'S01',
      severity: critical ? 'critical' : (shortfall ? 'warning' : (abs(diff) >= limits.surplusWarning ? 'warning' : 'info')),
      title: shortfall ? 'Faltante en el cierre' : 'Sobrante en el cierre',
      evidence: `${shortfall ? 'Faltan' : 'Sobran'} ${round2(abs(diff))} CUP: se esperaban ${round2(expected)} y se contaron ${round2(close.counted_cash)}.`,
      amount: abs(diff),
      currency: 'CUP',
      subjectLabel: closingLabel,
      details: { relative_percent: percent(diff, expected) },
    }));
  }

  if (diff < -limits.squareCash && expected) {
    const relative = abs(diff) / expected;
    if (relative >= limits.criticalRelativeCash / 2) {
      // La señal relativa explica el peso del faltante, pero no puede adelantar
      // a S01: un 2% de una caja pequeña no es "riesgo alto" por sí solo.
      const critical = abs(diff) >= Math.max(limits.criticalAbsoluteCash, expected * limits.criticalRelativeCash);
      signals.push(signal({
        id: 'S02',
        severity: critical ? 'critical' : 'warning',
        title: 'Faltante material respecto a lo esperado',
        evidence: `El faltante representa ${round2(abs(percent(diff, expected)))}% del efectivo esperado (${round2(expected)} CUP).`,
        amount: abs(diff),
        currency: 'CUP',
        subjectLabel: closingLabel,
      }));
    }
  }

  if (isForeignDifference(close, limits)) {
    const worst = Math.max(abs(usdDiff), abs(eurDiff));
    signals.push(signal({
      id: 'S15',
      severity: worst >= limits.criticalForeign ? 'critical' : 'warning',
      title: 'Diferencia en billetes de divisa',
      evidence: `USD: diferencia ${round2(usdDiff)}; EUR: diferencia ${round2(eurDiff)}.`,
      amount: worst,
      currency: abs(usdDiff) >= abs(eurDiff) ? 'USD' : 'EUR',
      subjectLabel: closingLabel,
    }));
  }

  const closingCashier = ordered.find((cashier) => cashier.is_closing_cashier);
  const recentShortfalls = closingCashier ? closingCashier.shortfalls_30d + 1 : 0;
  const recentCloses = closingCashier ? closingCashier.closes_30d + 1 : 0;
  const recentDifference = closingCashier
    ? round2(closingCashier.total_difference_30d + diff) : 0;
  if (closingCashier && isShortfall(close, limits) && recentShortfalls >= limits.repeatedShortfallsWarning) {
    signals.push(signal({
      id: 'S03',
      severity: recentShortfalls >= limits.repeatedShortfallsCritical ? 'critical' : 'warning',
      title: 'Patrón de faltantes en cierres realizados por la misma persona',
      evidence: `${closingCashier.label} registró ${recentShortfalls} cierres con faltantes entre ${recentCloses} cierres de los últimos 30 días (saldo acumulado ${recentDifference} CUP). Esto describe cierres, no identifica quién registró sus ventas.`,
      amount: abs(recentDifference),
      currency: 'CUP',
      subjectLabel: closingCashier.label,
    }));
  }

  if (isShortfall(close, limits) && closingCashier?.z_score != null && closingCashier.z_score <= -2) {
    signals.push(signal({
      id: 'S04',
      severity: 'warning',
      title: 'Descuadre fuera del comportamiento habitual',
      evidence: `El faltante de este cierre está ${abs(closingCashier.z_score)} desviaciones por debajo del promedio de cierres registrados por ${closingCashier.label}; esto no identifica quién registró las ventas.`,
      amount: abs(diff),
      currency: 'CUP',
      subjectLabel: closingCashier.label,
    }));
  }

  if (offRateSales.length > 0) {
    signals.push(signal({
      id: 'S05',
      severity: abs(offRateGap) >= limits.offRateCriticalGap ? 'critical' : 'warning',
      title: 'Ventas en divisa a tasa distinta a la de la tienda',
      evidence: `${offRateSales.length} venta(s) usaron una tasa distinta a la configurada. Diferencia estimada: ${round2(offRateGap)} CUP.`,
      amount: abs(offRateGap),
      currency: 'CUP',
    }));
  }

  if (rejectionCount > 0) {
    signals.push(signal({
      id: 'S06',
      severity: 'warning',
      title: 'Ventas rechazadas sin revisar',
      evidence: `Hay ${rejectionCount} venta(s) rechazada(s) por ${round2(rejectedTotal)} CUP sin revisar. El efectivo pudo entrar a la gaveta sin quedar registrado como venta.`,
      amount: rejectedTotal,
      currency: 'CUP',
    }));
  }

  const nearClose = withdrawals.filter((withdrawal) => {
    if (withdrawal.voided_at) return false;
    const minutes = minutesBetween(withdrawal.created_at, close.closed_at);
    return minutes != null && minutes >= 0 && minutes <= limits.withdrawalWindowMinutes;
  });
  if (nearClose.length > 0) {
    const nearCash = nearClose.filter((withdrawal) => withdrawal.method === 'efectivo');
    const nearCashTotal = sum(nearCash, (withdrawal) => withdrawal.amount);
    const otherCount = nearClose.length - nearCash.length;
    const detail = [
      nearCashTotal ? `${round2(nearCashTotal)} CUP en efectivo` : null,
      otherCount ? `${otherCount} en otros apartados` : null,
    ].filter(Boolean).join(' y ');
    signals.push(signal({
      id: 'S07',
      severity: 'warning',
      title: 'Extracciones registradas cerca del cierre',
      evidence: `${nearClose.length} extracción(es) ocurrieron en los ${limits.withdrawalWindowMinutes} minutos previos al cierre${detail ? `: ${detail}` : ''}.`,
      amount: nearCashTotal || null,
      currency: 'CUP',
    }));
  }

  if (offRatePurchases.length > 0) {
    signals.push(signal({
      id: 'S08',
      severity: abs(offRatePurchaseGap) >= limits.offRateCriticalGap ? 'critical' : 'warning',
      title: 'Compras de divisa a tasa distinta a la de la tienda',
      evidence: `${offRatePurchases.length} compra(s) usaron una tasa distinta a la configurada. Diferencia estimada: ${round2(offRatePurchaseGap)} CUP.`,
      amount: abs(offRatePurchaseGap),
      currency: 'CUP',
    }));
  }

  if (corrections.length > 0) {
    const latest = [...corrections].sort((left, right) => Number(right.correction_revision) - Number(left.correction_revision))[0];
    signals.push(signal({
      id: 'S09',
      severity: 'warning',
      title: 'El cierre fue corregido después del conteo',
      evidence: `El cierre tiene ${corrections.length} corrección(es). La última es la revisión ${latest?.correction_revision ?? 'desconocida'} y cambió el resultado original.`,
      subjectLabel: latest?.account_email ? 'Administrador' : null,
    }));
  }

  if (previousClose && cashWithdrawals.length === 0) {
    const gap = round2(number(close.opening_float) - number(previousClose.counted_cash));
    const limit = Math.max(limits.openingFloatMinGap, number(previousClose.counted_cash) * limits.openingFloatRelative);
    if (abs(gap) > limit) {
      signals.push(signal({
        id: 'S10',
        severity: 'warning',
        title: 'El fondo inicial no coincide con el cierre anterior',
        evidence: `El fondo inicial fue ${round2(close.opening_float)} CUP y el cierre anterior contó ${round2(previousClose.counted_cash)} CUP. No hay extracciones en efectivo que expliquen la diferencia.`,
        amount: abs(gap),
        currency: 'CUP',
      }));
    }
  }

  if (periodHours != null && periodHours > limits.maxPeriodHours) {
    signals.push(signal({
      id: 'S11',
      severity: 'warning',
      title: 'Período de caja demasiado largo',
      evidence: `El período abarcó ${periodHours} horas, más de las ${limits.maxPeriodHours} esperadas entre cierres.`,
    }));
  }
  if (duplicateMinutes != null && duplicateMinutes >= 0 && duplicateMinutes <= limits.duplicateCloseMinutes) {
    signals.push(signal({
      id: 'S17',
      severity: 'warning',
      title: 'Dos cierres de la misma caja muy seguidos',
      evidence: `El cierre anterior de esta caja fue ${duplicateMinutes} minutos antes. Revisa si se cerró dos veces el mismo período.`,
    }));
  }

  if (sales.length === 0) {
    signals.push(signal({
      id: 'S12',
      severity: 'info',
      title: 'Cierre sin ventas',
      evidence: purchases.length || withdrawals.length
        ? 'No hubo ventas, pero sí compras de divisa o extracciones en el período.'
        : 'No hubo ventas ni movimientos en el período.',
    }));
  }

  if (Number(close.overlap_sales) > 0) {
    signals.push(signal({
      id: 'S13',
      severity: 'warning',
      title: 'Ventas ya cubiertas por otro cierre',
      evidence: `${close.overlap_sales} venta(s) de este cierre ya estaban cubiertas por otro arqueo. Puede explicar un sobrante.`,
      amount: 0,
      currency: 'CUP',
    }));
  }

  if (String(close.register_id || '').startsWith('shared:')) {
    signals.push(signal({
      id: 'S14',
      severity: square ? 'info' : 'warning',
      title: 'Cierre de caja compartida',
      evidence: 'La caja es compartida entre varios cajeros: el descuadre corresponde al período completo y no prueba por sí solo quién lo causó.',
    }));
  }

  if (Number(context.openSalesOlderThan24h) > 0) {
    signals.push(signal({
      id: 'S16',
      severity: 'info',
      title: 'Ventas abiertas de días anteriores',
      evidence: `Hay ${context.openSalesOlderThan24h} venta(s) sin cierre de más de 24 horas. El efectivo puede estar en la gaveta sin arquear.`,
    }));
  }

  // Cruce de inventario con cierre de caja
  const inventoryCheck = context.inventoryCheck || null;
  if (inventoryCheck && inventoryCheck.available) {
    const { verdict, message, net_missing_value, cash_difference } = inventoryCheck;
    let severity = 'info';
    let title = '';

    if (verdict === 'respaldo') {
      severity = 'warning';
      title = 'Diferencias de inventario y caja por conciliar';
    } else if (verdict === 'cuadra') {
      if (abs(cash_difference) > limits.squareCash) {
        severity = 'info';
        title = 'Inventario contado sin diferencias; caja por conciliar';
      }
    } else if (verdict === 'diferencias') {
      severity = 'warning';
      title = 'Inventario con diferencias';
    } else if (verdict === 'parcial') {
      severity = 'info';
      title = 'Arqueo de inventario incompleto';
    }

    // Generar la señal solo si es relevante: debe haber una diferencia visible
    // o el veredicto indica conclusiones importantes
    const hasInventoryDifference = abs(net_missing_value) > limits.squareCash
      || (verdict === 'cuadra' && abs(cash_difference) > limits.squareCash);
    // Un arqueo incompleto solo merece aviso si la caja tampoco cuadró: en un
    // cierre limpio sería ruido en cada informe.
    const isExplicitVerdict = verdict === 'respaldo' || verdict === 'diferencias'
      || (verdict === 'parcial' && (abs(cash_difference) > limits.squareCash
        || Number(inventoryCheck.stock_adjustments_count) > 0
        || Number(inventoryCheck.uncounted_sold_products_count) > 0
        || inventoryCheck.timing_uncertain === true
        || inventoryCheck.stock_tracking_history_known === false));

    if (hasInventoryDifference || isExplicitVerdict) {
      signals.push(signal({
        id: 'S18',
        severity,
        title,
        evidence: message,
        // La valoración del inventario es mercancía, no una pérdida de
        // efectivo. La coincidencia entre ambas cifras tampoco demuestra causa.
        amount: null,
        currency: 'CUP',
      }));
    }
  }

  signals.sort((left, right) => SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity]
    || left.id.localeCompare(right.id));

  return {
    metrics,
    signals,
    severity: maxSeverity(signals),
    closing_cashier_label: closingLabel,
  };
}

const CAUSES = {
  S01: 'Error de conteo, vuelto mal entregado o un movimiento no registrado.',
  S02: 'El tamaño del faltante sugiere que no fue un simple error de redondeo.',
  S03: 'Patrón repetido en los cierres de la misma persona; revisar su procedimiento.',
  S04: 'El resultado se aparta de su comportamiento habitual; puede haber un hecho puntual.',
  S05: 'Ventas en divisa a una tasa distinta a la de la tienda; posible retención de la diferencia.',
  S06: 'Ventas rechazadas sin revisar: el efectivo cobrado pudo entrar a la gaveta sin venta registrada.',
  S07: 'Extracciones cerca del cierre: el retiro pudo no registrarse o registrarse a destiempo.',
  S08: 'Compras de divisa a una tasa distinta a la de la tienda; posible pérdida o desvío.',
  S09: 'El cierre fue corregido después del conteo original; el resultado actual puede ocultar el original.',
  S10: 'El fondo inicial no coincide con el cierre anterior y no hay extracciones que lo expliquen.',
  S11: 'El período de caja es más largo de lo normal; revisar si quedó incompleto o abierto de más.',
  S12: 'Cierre sin ventas; confirmar que la caja no quedó abierta por error.',
  S13: 'Ventas que ya estaban en otro cierre; puede explicar un sobrante.',
  S14: 'Caja compartida: la atribución individual es limitada.',
  S15: 'Diferencia en billetes de dólares o euros; revisar el conteo de divisa.',
  S16: 'Ventas antiguas sin cerrar; el efectivo puede estar fuera del arqueo.',
  S17: 'Dos cierres de la misma caja muy seguidos; puede ser un doble cierre del mismo período.',
  S18: 'El cruce muestra diferencias de inventario; por sí solo no establece si hubo ventas sin registrar, duplicadas o mercancía dañada.',
};

const RECOMMENDATIONS = {
  S01: 'Repetir el conteo con otra persona y revisar vueltos y movimientos del período.',
  S02: 'Revisar los movimientos del período antes de aceptar el resultado.',
  S03: 'Comparar los cierres de la persona y observar el procedimiento en la próxima jornada.',
  S04: 'Revisar qué cambió en ese cierre respecto a los anteriores.',
  S05: 'Verificar las ventas en divisa y la tasa aplicada en cada una.',
  S06: 'Revisar la lista de ventas rechazadas y conciliar el efectivo.',
  S07: 'Confirmar cada extracción y su comprobante antes del cierre.',
  S08: 'Revisar la tasa y el monto de cada compra de divisa.',
  S09: 'Comparar el resultado original con el corregido y documentar el motivo.',
  S10: 'Cuadrar el fondo inicial con el cierre anterior y las extracciones.',
  S11: 'Confirmar que el período cerrado sea el correcto y que la caja no haya quedado abierta de más.',
  S12: 'Confirmar que la caja no quedó abierta sin actividad.',
  S13: 'Revisar el cierre anterior para descartar doble conteo.',
  S14: 'Revisar el período completo de la caja compartida, no solo a una persona.',
  S15: 'Repetir el conteo de billetes de divisa.',
  S16: 'Cerrar las ventas pendientes y conciliar el efectivo.',
  S17: 'Revisar el cierre anterior para descartar un doble cierre del mismo período.',
  S18: 'Revisar el arqueo de inventario contra las ventas del período y comprobar que ambas cierren coherentes.',
};

const moneyText = (amount, currency = 'CUP') => `${round2(amount)} ${currency}`;

const headlineFor = (snapshot) => {
  const diff = snapshot.metrics.close.difference;
  const shortfall = diff < -DEFAULT_THRESHOLDS.squareCash;
  if (snapshot.severity === 'critical') {
    return shortfall
      ? `Riesgo alto: faltante de ${moneyText(abs(diff))}`
      : 'Riesgo alto en el cierre de caja';
  }
  if (snapshot.severity === 'warning') {
    return shortfall
      ? `Cierre con faltante de ${moneyText(abs(diff))}`
      : 'Cierre con señales para revisar';
  }
  if (snapshot.severity === 'info') return 'Cierre sin descuadre, con observaciones';
  return 'Cierre cuadrado';
};

const summaryFor = (snapshot) => {
  const { metrics, signals } = snapshot;
  const close = metrics.close;
  const diff = close.difference;
  const shortfall = diff < -DEFAULT_THRESHOLDS.squareCash;
  const intro = shortfall
    ? `El cierre del ${close.closed_at || 'período'} dejó un faltante de ${moneyText(abs(diff))}`
    : diff > DEFAULT_THRESHOLDS.squareCash
      ? `El cierre del ${close.closed_at || 'período'} dejó un sobrante de ${moneyText(diff)}`
      : `El cierre del ${close.closed_at || 'período'} cuadró dentro del margen de redondeo`;
  if (signals.length === 0) {
    return `${intro}. No se detectaron anomalías monetarias en las ventas, extracciones ni compras de divisa.`;
  }
  return `${intro}. Se detectaron ${signals.length} señal(es): ${signals.map((item) => item.title).join('; ')}.`;
};

export function summarizeSnapshot(snapshot) {
  return {
    severity: snapshot.severity,
    headline: headlineFor(snapshot),
    summary: summaryFor(snapshot),
  };
}

export function buildFallbackFindings(snapshot) {
  return snapshot.signals.map((item) => ({
    probable_cause: CAUSES[item.id] || item.title,
    confidence: item.severity === 'critical' ? 'alta' : item.severity === 'warning' ? 'media' : 'baja',
    evidence: [item.evidence],
    impact: item.amount == null ? '' : moneyText(item.amount, item.currency),
    recommendation: RECOMMENDATIONS[item.id] || 'Revisar el cierre y sus movimientos.',
  }));
}

export function buildFallbackReport(snapshot) {
  const summary = summarizeSnapshot(snapshot);
  return {
    ...summary,
    findings: buildFallbackFindings(snapshot),
    questions: snapshot.severity === 'ok' ? [] : ['¿Algún movimiento del período no quedó registrado?'],
    next_step: snapshot.severity === 'critical'
      ? 'Revisar el cierre con el responsable y comparar los movimientos del período.'
      : 'Revisar las señales y confirmar el conteo.',
  };
}

/**
 * Quita cualquier dato identificable antes de enviar el snapshot al modelo.
 * Los correos y los IDs de cuenta se quedan en Turso; el prompt solo ve
 * etiquetas como "Cajero 1".
 */
export function toPromptPayload(snapshot) {
  const { metrics, signals } = snapshot;
  return {
    prompt_version: PROMPT_VERSION,
    close: { ...metrics.close },
    period: { ...metrics.period },
    differences: { ...metrics.differences },
    cashiers: metrics.cashiers.map(({ account_id, account_email, ...rest }) => rest),
    context: { ...metrics.context },
    signals: signals.map(({ subject_label, ...rest }) => ({ ...rest, subject_label })),
  };
}

const cleanText = (value, limit) => String(value == null ? '' : value).trim().slice(0, limit);

/**
 * Valida la respuesta del modelo y la deja en la forma que guarda la base.
 * Si falta lo esencial, devuelve null para que el worker use el informe
 * determinista. La severidad NO se toma del modelo: sale de las reglas.
 */
export function validateModelOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const headline = cleanText(raw.headline, 240);
  const summary = cleanText(raw.summary, 4000);
  if (!headline || !summary) return null;
  const findings = Array.isArray(raw.findings) ? raw.findings.slice(0, 10).map((finding) => ({
    probable_cause: cleanText(finding?.probable_cause, 800),
    confidence: ['alta', 'media', 'baja'].includes(finding?.confidence) ? finding.confidence : 'media',
    evidence: Array.isArray(finding?.evidence)
      ? finding.evidence.slice(0, 6).map((item) => cleanText(item, 800)).filter(Boolean) : [],
    impact: cleanText(finding?.impact, 500),
    recommendation: cleanText(finding?.recommendation, 800),
  })).filter((finding) => finding.probable_cause) : [];
  if (findings.length === 0) return null;
  const questions = Array.isArray(raw.questions)
    ? raw.questions.slice(0, 6).map((question) => cleanText(question, 500)).filter(Boolean) : [];
  return {
    headline,
    summary,
    findings,
    questions,
    next_step: cleanText(raw.next_step, 800),
  };
}

export const __test__ = { parseDate, hoursBetween, minutesBetween, cashierKey, computeStats };
