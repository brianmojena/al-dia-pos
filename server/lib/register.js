/**
 * Normaliza la identidad de la caja sin aceptar que el navegador invente una
 * caja web para otra cuenta. La cuenta autenticada es la única autoridad para
 * completar el prefijo `web:`.
 */
function resolveRegisterId(req, value) {
  if (value === 'web') return `web:${req.accountId}`;
  if (typeof value === 'string' && /^desk-[A-Za-z0-9-]{1,59}$/.test(value)) return value;
  return null;
}

module.exports = { resolveRegisterId };
