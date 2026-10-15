/**
 * Formas de cobro y cómo se reparte una venta entre la gaveta y el banco.
 *
 * Una venta 'mixto' es UNA sola venta que el cliente pagó en parte por
 * transferencia y en parte en efectivo. Se guarda solo la parte transferida
 * (`transfer_amount`); el efectivo es siempre el resto del total. Guardar las
 * dos cifras permitiría que no sumen el total, y entonces el cierre de caja y
 * el Excel contarían historias distintas.
 *
 * Una venta 'divisa' es una venta pagada con dólares o euros en billetes. Se
 * guarda cuántos billetes entraron (`foreign_amount` en `foreign_currency`) y a
 * qué tasa los tomó el cajero (`exchange_rate`, pesos por 1 unidad). Lo que
 * falte hasta el total lo puso el cliente en pesos; si los billetes valen más
 * que el total, la diferencia salió de la gaveta como vuelto en pesos. Las dos
 * cosas son la misma cuenta: el efectivo en pesos que la venta deja en la
 * gaveta es `total - foreign_amount * exchange_rate`, y es negativo cuando hubo
 * vuelto. `shop_rate` es la tasa de la tienda que conocía el aparato en ese
 * momento: si no coincide con `exchange_rate`, el dueño lo ve marcado.
 *
 * Todo lo que separa efectivo de transferencias y divisas (el arqueo, el
 * histórico por días, el Excel) tiene que pasar por paymentSplit: si alguien
 * vuelve a preguntar `payment_method === 'transferencia'` a mano, la parte en
 * efectivo de una venta mixta, o el vuelto de una en divisa, se pierde de la
 * gaveta.
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

/**
 * Compra de divisa: la tienda le compra dólares o euros en billetes a alguien
 * y le paga en pesos de la gaveta. Es el movimiento contrario a cobrar una
 * venta en divisa: la gaveta pierde `foreign_amount * exchange_rate` pesos
 * (`cup_amount`, que se guarda ya redondeado para que el arqueo y el Excel
 * sumen lo mismo) y gana los billetes. Como la venta en divisa, queda cubierta
 * por el arqueo de la caja que la hizo.
 */
function purchaseSplit(purchase) {
  const amount = round2(purchase.foreign_amount);
  return {
    cash: -round2(purchase.cup_amount),
    transfer: 0,
    usd: purchase.foreign_currency === 'USD' ? amount : 0,
    eur: purchase.foreign_currency === 'EUR' ? amount : 0,
  };
}

// Valida y normaliza el cuerpo de una compra de divisa, o lanza con un mensaje
// para el cajero. `cup_amount` lo calcula el servidor: no se acepta el del cliente.
function purchaseFields(body) {
  const currency = body.foreign_currency;
  if (!CURRENCIES.includes(currency)) throw new Error('Moneda inválida: solo USD o EUR');
  const amount = Number(body.foreign_amount);
  if (body.foreign_amount == null || !Number.isFinite(amount) || round2(amount) <= 0) {
    throw new Error('Falta cuántos dólares o euros se compran');
  }
  const rate = Number(body.exchange_rate);
  if (body.exchange_rate == null || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Falta la tasa de la compra');
  }
  const shopRate = body.shop_rate == null ? null : Number(body.shop_rate);
  return {
    foreign_currency: currency,
    foreign_amount: round2(amount),
    exchange_rate: rate,
    shop_rate: Number.isFinite(shopRate) && shopRate > 0 ? shopRate : null,
    cup_amount: round2(round2(amount) * rate),
  };
}

/**
 * Extracciones de caja: el dueño retira dinero en cualquiera de sus 4 apartados
 * (efectivo, transferencia, dólares, euros). La lógica es similar a las compras
 * de divisa: restan del apartado que corresponde en el arqueo.
 */
const WITHDRAWAL_METHODS = ['efectivo', 'transferencia', 'USD', 'EUR'];

// Lo que una extracción le quita a cada apartado. Anulada = no quita nada.
function withdrawalSplit(w) {
  const amount = w.voided_at ? 0 : round2(w.amount);
  return {
    cash: w.method === 'efectivo' ? -amount : 0,
    transfer: w.method === 'transferencia' ? -amount : 0,
    usd: w.method === 'USD' ? -amount : 0,
    eur: w.method === 'EUR' ? -amount : 0,
  };
}

// Valida y normaliza; lanza Error con mensaje en español para el dueño.
function withdrawalFields(body) {
  if (!WITHDRAWAL_METHODS.includes(body.method)) throw new Error('Apartado inválido');
  const amount = Number(body.amount);
  if (body.amount == null || body.amount === '' || !Number.isFinite(amount) || round2(amount) <= 0) throw new Error('Falta cuánto dinero se extrae');
  const note = body.note == null ? null : String(body.note).trim().slice(0, 200) || null;
  return { method: body.method, amount: round2(amount), note };
}

module.exports = {
  PAYMENT_METHODS, CURRENCIES, paymentSplit, paymentLabel, offShopRate, foreignFields, round2,
  purchaseSplit, purchaseFields,
  WITHDRAWAL_METHODS, withdrawalSplit, withdrawalFields,
};
