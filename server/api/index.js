// Entry point serverless para Vercel. Reutiliza la misma app Express que index.js,
// pero en vez de app.listen() exportamos un handler (req, res).
const { initDb } = require('../db/database');
const { assertConfig } = require('../config');
const app = require('../app');

// Falla el arranque serverless si falta la configuración crítica (JWT_SECRET),
// en vez de aceptar sesiones firmadas con una clave conocida.
assertConfig();

// Memoizado a nivel de módulo: en invocaciones "warm" del mismo contenedor,
// initDb() ya corrió y no se repite. Evita condiciones de carrera en cold start
// si llegan varias requests a la vez.
let dbReady;

module.exports = async (req, res) => {
  if (!dbReady) dbReady = initDb();
  await dbReady;
  return app(req, res);
};
