const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

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
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId    = payload.userId;
    req.accountId = payload.accountId ?? payload.userId;
    req.role      = payload.role ?? OWNER;
    next();
  } catch (_) {
    res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

/**
 * Cierra el paso a todo lo que le diría a un cajero cuánto dinero debería
 * haber en la caja: el dashboard, el historial de ventas y el historial de
 * cierres. Sin esto el conteo a ciegas sería decorativo — bastaría con abrir
 * otra pantalla para ver el total antes de declarar lo contado.
 */
function requireOwner(req, res, next) {
  if (req.role !== OWNER) {
    return res.status(403).json({ error: 'Solo el dueño puede ver esto' });
  }
  next();
}

module.exports = { requireAuth, requireOwner, OWNER, CASHIER };
