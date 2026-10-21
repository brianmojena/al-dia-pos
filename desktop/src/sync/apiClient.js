// Cliente HTTP delgado hacia el backend real (Vercel + Turso). Usa el fetch
// nativo de Node (Electron 33 trae Node 20+, no hace falta node-fetch).
const API_BASE = process.env.MYPIMES_API_URL || 'https://server-three-orcin-11.vercel.app';

async function apiRequest(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // El proceso principal usa la identidad persistida en SQLite, también en sync.
  // No depender del localStorage del renderer evita contar dos veces la caja.
  try {
    const id = require('../db/queries').getRegisterId();
    if (id) {
      headers['X-Device-Id'] = id;
      headers['X-Device-Platform'] = 'desktop';
      headers['User-Agent'] = `MiTienda-Desktop (${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'})`;
    }
  } catch (_) { /* No hay base local todavía: continuar sin telemetría. */ }
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Sin red, DNS caído, timeout, etc. — lo normalizamos para que el sync
    // worker lo distinga claramente de un error de aplicación (4xx/5xx).
    const e = new Error(`Sin conexión: ${err.message}`);
    e.isNetworkError = true;
    throw e;
  }

  let data = null;
  try { data = await res.json(); } catch (_) { /* respuesta sin body */ }

  return { ok: res.ok, status: res.status, data };
}

module.exports = { apiRequest, API_BASE };
