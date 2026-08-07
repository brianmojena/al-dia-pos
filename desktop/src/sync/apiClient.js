// Cliente HTTP delgado hacia el backend real (Vercel + Turso). Usa el fetch
// nativo de Node (Electron 33 trae Node 20+, no hace falta node-fetch).
const API_BASE = process.env.MYPIMES_API_URL || 'https://server-three-orcin-11.vercel.app';

async function apiRequest(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
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
