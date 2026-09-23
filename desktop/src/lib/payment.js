/**
 * Formas de cobro y cómo se reparte una venta entre la gaveta y el banco.
 *
 * Copia deliberada de server/lib/payment.js, igual que businessDay.js: la caja
 * tiene que cuadrar sin red con exactamente la misma regla que el servidor
 * usa al recalcular el cierre. Si cambia una, cambia la otra.
 *
 * Una venta 'mixto' guarda solo la parte transferida (`transfer_amount`); el
 * efectivo es siempre el resto del total.
 */

const PAYMENT_METHODS = ['efectivo', 'transferencia', 'mixto'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function paymentSplit(sale) {
  const total = Number(sale.total) || 0;
  if (sale.payment_method === 'transferencia') return { cash: 0, transfer: total };
  if (sale.payment_method === 'mixto') {
    const transfer = round2(sale.transfer_amount);
    return { cash: round2(total - transfer), transfer };
  }
  return { cash: total, transfer: 0 };
}

module.exports = { PAYMENT_METHODS, paymentSplit, round2 };
