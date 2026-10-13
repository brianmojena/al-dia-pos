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

module.exports = { UNITS, roundQty, parseUnit, validQuantity };
