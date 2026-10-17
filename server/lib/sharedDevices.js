const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const { JWT_SECRET } = require('../config');
const { publicUser } = require('./userProfile');
const DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const publicDevice = (d) => ({ id: d.id, owner_id: Number(d.owner_id), name: d.name, continuous: Number(d.continuous) === 1, expires_at: d.expires_at });
const registerOf = (device, accountId) => `shared:${device.id}${device.continuous ? '' : `:${accountId}`}`;
const sharedOperationMatches = (req, row) => !req.sharedDevice || (row.register_id === registerOf(req.sharedDevice, req.accountId) && Number(row.account_id) === Number(req.accountId));
const sharedSaleResponse = (req, row) => {
  if (!req.sharedDevice) return row;
  const { profit, ...safe } = row;
  return safe;
};

async function enrollment(db, device) {
  const shop = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ? AND owner_id IS NULL', args: [device.owner_id] })).rows[0];
  if (!shop) throw new Error('Tienda no encontrada');
  const rows = (await db.execute({
    sql: `SELECT u.*, m.display_name FROM shared_device_cashiers m JOIN users u ON u.id = m.account_id
          WHERE m.device_id = ? AND m.active = 1 AND u.owner_id = ? AND u.role = 'cajero' ORDER BY u.id`,
    args: [device.id, device.owner_id],
  })).rows;
  return {
    device: publicDevice(device),
    cashiers: rows.map((row) => ({
      id: Number(row.id), email: row.email, display_name: row.display_name,
      user: publicUser(row, shop),
      token: jwt.sign({ userId: Number(device.owner_id), accountId: Number(row.id), role: 'cajero', deviceId: device.id,
        deviceVersion: Number(device.version), exp: Math.floor(Date.parse(device.expires_at) / 1000) }, JWT_SECRET),
    })),
  };
}

async function validateSharedToken(payload) {
  const db = getDb();
  const row = (await db.execute({ sql: 'SELECT * FROM shared_devices WHERE id = ?', args: [payload.deviceId] })).rows[0];
  if (!row || !row.active || Number(row.version) !== Number(payload.deviceVersion)
    || Number(row.owner_id) !== Number(payload.userId) || payload.role !== 'cajero') {
    return { status: 403, code: 'DEVICE_REVOKED', error: 'El acceso de esta caja fue retirado. Contacta al administrador.' };
  }
  if (Date.parse(row.expires_at) <= Date.now()) return { status: 401, code: 'DEVICE_EXPIRED', error: 'Los accesos de esta caja vencieron. Contacta al administrador para renovarlos.' };
  const member = (await db.execute({
    sql: `SELECT u.id FROM shared_device_cashiers m JOIN users u ON u.id = m.account_id
          WHERE m.device_id = ? AND m.account_id = ? AND m.active = 1 AND u.owner_id = ? AND u.role = 'cajero'`,
    args: [row.id, payload.accountId, row.owner_id],
  })).rows[0];
  if (!member) return { status: 403, code: 'MEMBER_REVOKED', error: 'Este cajero ya no está autorizado en la caja.' };
  return { device: publicDevice(row), row };
}

async function renewEnrollment(id) {
  const db = getDb();
  const row = (await db.execute({ sql: 'SELECT * FROM shared_devices WHERE id = ? AND active = 1', args: [id] })).rows[0];
  if (!row) return null;
  const expires = new Date(Date.now() + DURATION_MS).toISOString();
  await db.execute({ sql: 'UPDATE shared_devices SET expires_at = ? WHERE id = ? AND active = 1', args: [expires, id] });
  return enrollment(db, { ...row, expires_at: expires });
}

module.exports = { DURATION_MS, publicDevice, registerOf, enrollment, validateSharedToken, renewEnrollment, sharedOperationMatches, sharedSaleResponse };
