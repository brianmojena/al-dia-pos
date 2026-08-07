// Entry point para desarrollo local (npm run dev). En Vercel se usa api/index.js.
require('dotenv').config();
const { initDb } = require('./db/database');
const app = require('./app');

const PORT = process.env.PORT || 3001;

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
}

start();
