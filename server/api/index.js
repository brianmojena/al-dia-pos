// Entry point serverless para Vercel. Reutiliza la misma app Express que index.js,
// pero en vez de app.listen() exportamos un handler (req, res).
const { initDb } = require('../db/database');
const app = require('../app');

// Memoizado a nivel de módulo: en invocaciones "warm" del mismo contenedor,
// initDb() ya corrió y no se repite. Evita condiciones de carrera en cold start
// si llegan varias requests a la vez.
let dbReady;

module.exports = async (req, res) => {
  if (!dbReady) dbReady = initDb();
  await dbReady;
  return app(req, res);
};
