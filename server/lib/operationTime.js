// Las operaciones offline conservan el día real del negocio al sincronizar.
// Los clientes anteriores omiten el campo y siguen usando datetime('now').
function operationTime(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new Error('Fecha de operación inválida');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Fecha de operación inválida');
  if (time > Date.now() + 300_000) {
    // Un reloj adelantado es recuperable: los clientes antiguos conservan los 503.
    const error = new Error('El reloj del dispositivo está adelantado. Activa la hora automática; la operación sigue pendiente.');
    error.status = 503;
    error.code = 'CLOCK_AHEAD';
    error.server_time = new Date().toISOString();
    throw error;
  }
  return new Date(time).toISOString().slice(0, 19).replace('T', ' ');
}
function operationTimeFailure(res, error) {
  return res.status(error.status || 400).json({ error: error.message,
    ...(error.code && { code: error.code, server_time: error.server_time }) });
}
module.exports = { operationTime, operationTimeFailure };
