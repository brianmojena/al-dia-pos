// Las operaciones offline conservan el día real del negocio al sincronizar.
// Los clientes anteriores omiten el campo y siguen usando datetime('now').
function operationTime(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new Error('Fecha de operación inválida');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > Date.now() + 300_000) throw new Error('Fecha de operación inválida');
  return new Date(time).toISOString().slice(0, 19).replace('T', ' ');
}
module.exports = { operationTime };
