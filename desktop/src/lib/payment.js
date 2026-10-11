/**
 * Formas de cobro y cómo se reparte una venta entre la gaveta, el banco y los
 * billetes en divisa.
 *
 * Copia deliberada de server/lib/payment.js, igual que businessDay.js: la caja
 * tiene que cuadrar sin red con exactamente la misma regla que el servidor
 * usa al recalcular el cierre. Si cambia una, cambia la otra. La explicación
 * de cada forma de cobro está allá.
 */

const PAYMENT_METHODS = ['efectivo', 'transferencia', 'mixto', 'divisa'];
const CURRENCIES = ['USD', 'EUR'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// cash: pesos que la venta deja en la gaveta (negativo si se dio vuelto).
// transfer: pesos que entraron al banco. usd / eur: billetes en divisa.
// foreign_cup: lo que valen esos billetes en pesos, a la tasa del cobro.
function paymentSplit(sale) {
  const total = Number(sale.total) || 0;
  const split = { cash: total, transfer: 0, usd: 0, eur: 0, foreign_cup: 0 };
  if (sale.payment_method === 'transferencia') return { ...split, cash: 0, transfer: total };
  if (sale.payment_method === 'mixto') {
    const transfer = round2(sale.transfer_amount);
    return { ...split, cash: round2(total - transfer), transfer };
  }
  if (sale.payment_method === 'divisa') {
    const amount = round2(sale.foreign_amount);
    const foreignCup = round2(amount * (Number(sale.exchange_rate) || 0));
    return {
      ...split,
      cash: round2(total - foreignCup),
      usd: sale.foreign_currency === 'USD' ? amount : 0,
      eur: sale.foreign_currency === 'EUR' ? amount : 0,
      foreign_cup: foreignCup,
    };
  }
  return split;
}

// La tasa del cobro no es la de la tienda. Sin tasa de tienda conocida no hay
// contra qué comparar, así que no se marca.
function offShopRate(sale) {
  if (sale.payment_method !== 'divisa' || sale.shop_rate == null) return false;
  return Math.abs(Number(sale.exchange_rate) - Number(sale.shop_rate)) > 0.005;
}

function paymentLabel(sale) {
  if (sale.payment_method === 'transferencia') return 'Transferencia';
  if (sale.payment_method === 'mixto') return 'Mixto';
  if (sale.payment_method === 'divisa') return sale.foreign_currency === 'EUR' ? 'Euros' : 'Dólares';
  return 'Efectivo';
}

/**
 * Valida y normaliza la parte en divisa de un cobro. Devuelve los campos que
 * se guardan en la venta, o lanza con un mensaje para el cajero. Si no es un
 * cobro en divisa devuelve los cuatro en null: así ninguna otra forma de
 * cobro arrastra una tasa que no usó.
 */
function foreignFields(body) {
  if (body.payment_method !== 'divisa') {
    return { foreign_currency: null, foreign_amount: null, exchange_rate: null, shop_rate: null };
  }
  const currency = body.foreign_currency;
  if (!CURRENCIES.includes(currency)) throw new Error('Moneda inválida: solo USD o EUR');
  const amount = Number(body.foreign_amount);
  if (body.foreign_amount == null || !Number.isFinite(amount) || round2(amount) <= 0) {
    throw new Error('Falta cuántos dólares o euros entregó el cliente');
  }
  const rate = Number(body.exchange_rate);
  if (body.exchange_rate == null || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Falta la tasa de cambio del cobro');
  }
  const shopRate = body.shop_rate == null ? null : Number(body.shop_rate);
  return {
    foreign_currency: currency,
    foreign_amount: round2(amount),
    exchange_rate: rate,
    shop_rate: Number.isFinite(shopRate) && shopRate > 0 ? shopRate : null,
  };
}

module.exports = {
  PAYMENT_METHODS, CURRENCIES, paymentSplit, paymentLabel, offShopRate, foreignFields, round2,
};
