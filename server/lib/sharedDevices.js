const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { JWT_SECRET } = require('../config');
const { publicUser } = require('./userProfile');
const DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const ENROLL_CODE_TTL_MS = 30 * 60 * 1000;
// Alfabeto tipo Crockford: sin letras ambiguas (I, L, O, U). Al leer se corrigen
// los errores de tecleo más comunes (I/L→1, O→0) antes de comparar.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;

const publicDevice = (d) => ({ id: d.id, owner_id: Number(d.owner_id), name: d.name, continuous: Number(d.continuous) === 1, expires_at: d.expires_at });

// El código de activación se guarda cifrado (SHA-256): quien lea la base no
// puede activar la caja con él. Solo se acepta en minúsculas/espacios de más,
// con los caracteres que Crockford considera equivalentes.
const normalizeEnrollCode = (value) => String(value == null ? '' : value)
  .toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
const hashEnrollCode = (code) => crypto.createHash('sha256').update(normalizeEnrollCode(code)).digest('hex');
function generateEnrollCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  // 256 % 32 === 0: tomar el módulo 32 no introduce sesgo.
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}
const registerOf = (device, accountId) => `shared:${device.id}${device.continuous ? '' : `:${accountId}`}`;
const sharedOperationMatches = (req, row) => !req.sharedDevice || (row.register_id === registerOf(req.sharedDevice, req.accountId) && Number(row.account_id) === Number(req.accountId));
const sharedSaleResponse = (req, row) => {
  if (!req.sharedDevice) return row;
  const { profit, ...safe } = row;
  return safe;
};

async function enrollment(db, device, { withPins = false } = {}) {
  const shop = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ? AND owner_id IS NULL', args: [device.owner_id] })).rows[0];
  if (!shop) throw new Error('Tienda no encontrada');
  const rows = (await db.execute({
    sql: `SELECT u.*, m.display_name, m.pin_salt, m.pin_hash, m.pin_iterations FROM shared_device_cashiers m JOIN users u ON u.id = m.account_id
          WHERE m.device_id = ? AND m.active = 1 AND u.owner_id = ? AND u.role = 'cajero' ORDER BY u.id`,
    args: [device.id, device.owner_id],
  })).rows;
  return {
    device: publicDevice(device),
    cashiers: rows.map((row) => {
      const cashier = {
        id: Number(row.id), email: row.email, display_name: row.display_name,
        user: publicUser(row, shop),
        token: jwt.sign({ userId: Number(device.owner_id), accountId: Number(row.id), role: 'cajero', deviceId: device.id,
          deviceVersion: Number(device.version), exp: Math.floor(Date.parse(device.expires_at) / 1000) }, JWT_SECRET),
      };
      // El PIN ya viene cifrado por el navegador del administrador: solo la
      // activación remota lo entrega para instalar la caja sin teclear nada.
      if (withPins && row.pin_salt && row.pin_hash) {
        cashier.pin = { salt: row.pin_salt, hash: row.pin_hash, iterations: Number(row.pin_iterations) };
      }
      return cashier;
    }),
  };
}

// Canjea un código de activación de un solo uso. Devuelve el bundle con los
// PIN ya cifrados o null si el código no existe, ya se usó o venció. El UPDATE
// condicional es lo que garantiza el "un solo uso" aunque dos aparatos lo
// enviaran a la vez.
async function redeemEnrollCode(db, code) {
  const normalized = normalizeEnrollCode(code);
  if (normalized.length !== CODE_LENGTH) return null;
  const device = (await db.execute({
    sql: 'SELECT * FROM shared_devices WHERE enroll_code_hash = ? AND active = 1 AND enroll_used = 0',
    args: [hashEnrollCode(normalized)],
  })).rows[0];
  if (!device || !device.enroll_expires_at || Date.parse(device.enroll_expires_at) <= Date.now()) return null;
  const claim = await db.execute({ sql: 'UPDATE shared_devices SET enroll_used = 1 WHERE id = ? AND active = 1 AND enroll_used = 0', args: [device.id] });
  if (!claim.rowsAffected) return null;
  return enrollment(db, device, { withPins: true });
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

module.exports = { DURATION_MS, ENROLL_CODE_TTL_MS, CODE_LENGTH, publicDevice, registerOf, enrollment, validateSharedToken, renewEnrollment, sharedOperationMatches, sharedSaleResponse, generateEnrollCode, normalizeEnrollCode, hashEnrollCode, redeemEnrollCode };
