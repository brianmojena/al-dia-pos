// Express 4 no reenvía rechazos de promesas a next() automáticamente.
// Envuelve cada handler async para que los errores lleguen al middleware de errores.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { asyncHandler };
