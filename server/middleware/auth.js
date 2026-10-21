const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { getDb } = require('../db/database');

const OWNER = 'dueño';
const CASHIER = 'cajero';

/**
 * Resuelve quién está pidiendo y sobre qué tienda.
 *
 * La distinción importa: `userId` es el ÁMBITO (la tienda), y `accountId` es
 * QUIÉN inició sesión. Para un dueño coinciden; para un cajero, `userId` es el
 * id de su dueño. Gracias a eso, las consultas de productos, ventas, dashboard
 * y cierres siguen filtrando por `user_id` exactamente igual que antes — un
 * cajero ve el inventario de su tienda, no uno vacío.
 *
 * Los tokens emitidos antes de que existieran los roles solo llevan `userId`.
 * Se interpretan como dueño, que es lo que eran: nadie tiene que volver a
 * iniciar sesión por este cambio.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch (_) { return res.status(401).json({ error: 'Sesión inválida o expirada' }); }
  try {
    if (payload.deviceId) {
      const result = await require('../lib/sharedDevices').validateSharedToken(payload);
      if (!result.device) return res.status(result.status).json({ error: result.error, code: result.code });
      req.sharedDevice = result.device;
    }
    // La cuenta se relee en cada petición: el token de 30 días no puede seguir
    // autorizando a un cajero que el dueño acaba de borrar, ni conservar un rol
    // o una tienda que cambiaron después de emitirse. La pertenencia se toma
    // de la base, no del JWT.
    const accountId = payload.accountId ?? payload.userId;
    const accountResult = await getDb().execute({
      sql: 'SELECT id, role, owner_id FROM users WHERE id = ?',
      args: [accountId],
    });
    const account = accountResult.rows[0];
    if (!account) {
      return res.status(401).json({ error: 'Sesión inválida o expirada', code: 'ACCOUNT_REVOKED' });
    }
    req.userId    = account.owner_id ?? account.id;
    req.accountId = account.id;
    req.role      = account.role ?? OWNER;
    next();
  } catch (error) { next(error); }
}

/**
 * Cierra el paso a todo lo que le diría a un cajero cuánto dinero debería
 * haber en la caja: el dashboard y los reportes agregados de la tienda.
 * Las rutas de ventas y cierres aplican su propio alcance por cuenta y período.
 */
function requireOwner(req, res, next) {
  if (req.role !== OWNER) {
    return res.status(403).json({ error: 'Solo el dueño puede ver esto' });
  }
  next();
}

/**
 * El panel de administración se protege con el flag `is_admin` de la cuenta,
 * no con el correo: el privilegio se aprovisiona explícitamente
 * (`npm run admin:grant`) y no puede reclamarse registrándose con un correo
 * que figure en ADMIN_EMAILS.
 */
async function requireAdmin(req, res, next) {
  try {
    const result = await getDb().execute({
      sql: 'SELECT is_admin FROM users WHERE id = ?',
      args: [req.accountId],
    });
    if (Number(result.rows[0]?.is_admin) !== 1) {
      return res.status(403).json({ error: 'Solo la cuenta de administración puede hacer esto' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, requireOwner, requireAdmin, OWNER, CASHIER };
