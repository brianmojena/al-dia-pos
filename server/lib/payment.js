/**
 * Formas de cobro y cómo se reparte una venta entre la gaveta y el banco.
 *
 * Una venta 'mixto' es UNA sola venta que el cliente pagó en parte por
 * transferencia y en parte en efectivo. Se guarda solo la parte transferida
 * (`transfer_amount`); el efectivo es siempre el resto del total. Guardar las
 * dos cifras permitiría que no sumen el total, y entonces el cierre de caja y
 * el Excel contarían historias distintas.
 *
 * Todo lo que separa efectivo de transferencias (el arqueo, el histórico por
 * días, el Excel) tiene que pasar por paymentSplit: si alguien vuelve a
 * preguntar `payment_method === 'transferencia'` a mano, la parte en efectivo
 * de una venta mixta se pierde de la gaveta.
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

function paymentLabel(sale) {
  if (sale.payment_method === 'transferencia') return 'Transferencia';
  if (sale.payment_method === 'mixto') return 'Mixto';
  return 'Efectivo';
}

module.exports = { PAYMENT_METHODS, paymentSplit, paymentLabel, round2 };
