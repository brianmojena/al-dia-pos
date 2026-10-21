const { getDb } = require('../db/database');

function deviceFromRequest(req) {
  const id = req.headers['x-device-id'];
  const platform = req.headers['x-device-platform'];
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(id)) return null;
  if (!['web', 'desktop'].includes(platform)) return null;
  const ua = req.headers['user-agent'] || '';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS'
      : /Linux/i.test(ua) ? 'Linux' : 'Otro sistema';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Navegador';
  return { id, platform, label: platform === 'desktop' ? `App de escritorio · ${os}` : `${browser} · ${os}` };
}

// Una instalación por cuenta, aunque abra varias pestañas o renueve el login.
// Mantener la primera conexión permite distinguir altas nuevas de reintentos.
async function recordDevice(req, accountId) {
  const device = deviceFromRequest(req);
  if (!device) return;
  await getDb().execute({
    sql: `INSERT INTO account_devices (account_id, device_id, platform, label)
          SELECT id, ?, ?, ? FROM users WHERE id = ?
          ON CONFLICT(account_id, device_id) DO UPDATE SET
            platform = excluded.platform, label = excluded.label,
            last_seen_at = datetime('now')
          WHERE account_devices.last_seen_at < datetime('now', '-5 minutes')`,
    args: [device.id, device.platform, device.label, accountId],
  });
}

// La telemetría nunca debe impedir cobrar, sincronizar o iniciar sesión.
async function observeDevice(req, accountId) {
  try { await recordDevice(req, accountId); }
  catch (_) { console.warn('[devices] No se pudo actualizar el registro de dispositivos'); }
}

async function deviceReport() {
  const db = getDb();
  const accounts = await db.execute(`
    SELECT u.id, u.email, u.role, u.owner_id, u.created_at,
           COALESCE(shop.store_name, u.store_name) AS store_name
    FROM users u LEFT JOIN users shop ON shop.id = u.owner_id
    ORDER BY u.email COLLATE NOCASE
  `);
  const devices = await db.execute(`
    SELECT d.account_id, d.device_id, d.platform, d.label, d.first_seen_at, d.last_seen_at,
           (d.last_seen_at >= datetime('now', '-30 days')) AS seen_recently
    FROM account_devices d JOIN users u ON u.id = d.account_id
    ORDER BY d.last_seen_at DESC, d.device_id
  `);
  const byAccount = new Map();
  for (const row of devices.rows) {
    const id = Number(row.account_id);
    if (!byAccount.has(id)) byAccount.set(id, []);
    byAccount.get(id).push({
      device_id: row.device_id, platform: row.platform, label: row.label,
      first_seen_at: row.first_seen_at, last_seen_at: row.last_seen_at,
      seen_recently: Boolean(row.seen_recently),
    });
  }
  return {
    generated_at: new Date().toISOString(),
    accounts: accounts.rows.map(row => {
      const linked = byAccount.get(Number(row.id)) || [];
      return {
        id: Number(row.id), email: row.email, role: row.role,
        owner_id: row.owner_id == null ? null : Number(row.owner_id),
        store_name: row.store_name, created_at: row.created_at,
        device_count: linked.length,
        recent_device_count: linked.filter(device => device.seen_recently).length,
        devices: linked,
      };
    }),
    unique_device_count: new Set(devices.rows.map(row => row.device_id)).size,
  };
}

module.exports = { deviceFromRequest, recordDevice, observeDevice, deviceReport };
