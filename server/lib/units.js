// Productos fraccionados (se venden por peso). Un producto con `unit` tiene su
// precio, su costo y su stock expresados en ESA unidad: "pollo, $900 el kg,
// 12.5 kg en el almacén". Sin `unit` es un producto por pieza y todo sigue
// siendo entero, como siempre.
const UNITS = ['kg', 'g', 'lb'];

// Tres decimales alcanzan para una balanza (1 g = 0.001 kg) y evitan que la
// aritmética de coma flotante deje stocks como 2.3499999999.
const roundQty = (n) => Math.round(Number(n) * 1000) / 1000;

/** undefined = no vino; null = por pieza; 'kg' | 'g' | 'lb'; false = inválida. */
function parseUnit(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const unit = String(value).trim().toLowerCase();
  return UNITS.includes(unit) ? unit : false;
}

/** ¿Es `value` una cantidad/stock válida (>= min) para ese producto? */
function validQuantity(value, unit, { min = 0 } = {}) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < min) return false;
  return unit ? Math.abs(roundQty(n) - n) < 1e-9 : Number.isInteger(n);
}

/** 1 o 0. Solo un producto por peso puede dejar de llevar stock; el resto siempre lo lleva. */
function trackStockFor(unit, value, fallback = 0) {
  if (!unit) return 1;
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

// Venta por paquete: "Popular", 20 cigarros por cajetilla. El stock, el costo
// y el precio de venta siguen siendo del SUELTO; pack_size dice cuántos sueltos
// trae el paquete y pack_price lo que cuesta llevárselo entero. Solo productos
// por pieza: un producto por peso no se vende en paquetes.
const MAX_PACK_SIZE = 10000;

/**
 * Lee pack_size/pack_price de un alta o edición.
 * undefined = no vino (se conserva lo que había); { pack_size: null, pack_price: null }
 * = no se vende por paquete; { error } = datos inválidos.
 */
function parsePack(body, unit) {
  if (!body || body.pack_size === undefined) return undefined;
  const raw = body.pack_size;
  if (raw === null || raw === '' || Number(raw) === 0) return { pack_size: null, pack_price: null };
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 2 || size > MAX_PACK_SIZE) {
    return { error: 'El paquete debe traer un número entero de unidades (2 o más)' };
  }
  if (unit) return { error: 'Un producto por peso no se vende por paquete' };
  const price = Number(body.pack_price);
  if (body.pack_price === null || body.pack_price === undefined || body.pack_price === '' || !Number.isFinite(price) || price < 0) {
    return { error: 'Falta el precio del paquete' };
  }
  return { pack_size: size, pack_price: price };
}

/** Sueltos que salen del stock por una línea de venta: 2 paquetes de 20 son 40. */
const lineUnits = (item) => roundQty(Number(item.quantity) * (Number(item.pack_size) > 1 ? Number(item.pack_size) : 1));

module.exports = { UNITS, roundQty, parseUnit, validQuantity, trackStockFor, parsePack, lineUnits };
