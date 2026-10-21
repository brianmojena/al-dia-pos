const crypto = require('crypto');

// Alfabeto sin caracteres ambiguos (I, L, O, U) para códigos legibles
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const RESET_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutos

// Normaliza el código: mayúsculas, sin espacios ni guiones
const normalizeResetCode = (value) => String(value == null ? '' : value)
  .toUpperCase()
  .replace(/[^0-9A-Z]/g, '');

// Genera el hash SHA-256 del código normalizado
const hashResetCode = (code) => crypto.createHash('sha256')
  .update(normalizeResetCode(code))
  .digest('hex');

/**
 * Genera un código de recuperación único y lo guarda en la base.
 * Devuelve { code, expires_at } con el código en claro.
 * Un código nuevo reemplaza al anterior.
 */
async function issueResetCode(db, userId) {
  // Generar 8 caracteres del alfabeto Crockford
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }

  const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS).toISOString();
  const codeHash = hashResetCode(code);

  // Guardar el hash y fecha de vencimiento; limpiar intentos previos
  await db.execute({
    sql: `UPDATE users
          SET reset_code_hash = ?, reset_code_expires_at = ?, reset_attempts = 0
          WHERE id = ?`,
    args: [codeHash, expiresAt, userId],
  });

  return { code, expires_at: expiresAt };
}

/**
 * Canjea un código de recuperación y cambia la contraseña.
 * Devuelve true si tuvo éxito, false si el código es inválido, vencido o fue rechazado.
 *
 * Reglas:
 * - Si reset_code_hash es NULL (no hay código) → false
 * - Si el código venció → false
 * - Si reset_attempts >= 5 → false
 * - Si el hash no coincide → incrementa reset_attempts (si llega a 5 borra el código) y false
 * - Si coincide → reclama atómicamente con UPDATE condicional y true
 *
 * Nunca distingue en el resultado entre "email no existe", "código mal", o "vencido".
 */
async function redeemResetCode(db, email, code, newPasswordHash) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedCode = normalizeResetCode(code);

  // Buscar el usuario por email que tenga un código guardado
  const userResult = await db.execute({
    sql: 'SELECT id, reset_code_hash, reset_code_expires_at, reset_attempts FROM users WHERE email = ?',
    args: [normalizedEmail],
  });
  const user = userResult.rows[0];

  // Usuario no existe o no tiene código
  if (!user || !user.reset_code_hash) return false;

  // Código vencido
  if (!Number.isFinite(Date.parse(user.reset_code_expires_at)) || Date.parse(user.reset_code_expires_at) <= Date.now()) {
    return false;
  }

  // Demasiados intentos
  if (Number(user.reset_attempts) >= 5) return false;

  const providedHash = hashResetCode(normalizedCode);
  if (typeof user.reset_code_hash !== 'string' || user.reset_code_hash.length !== providedHash.length) return false;
  const hashesMatch = crypto.timingSafeEqual(
    Buffer.from(user.reset_code_hash),
    Buffer.from(providedHash)
  );

  if (!hashesMatch) {
    // La base suma los intentos: solicitudes concurrentes no pueden pisarlos,
    // ni una respuesta antigua invalidar un código recién emitido.
    await db.execute({
      sql: `UPDATE users SET
              reset_attempts = reset_attempts + 1,
              reset_code_hash = CASE WHEN reset_attempts >= 4 THEN NULL ELSE reset_code_hash END,
              reset_code_expires_at = CASE WHEN reset_attempts >= 4 THEN NULL ELSE reset_code_expires_at END
            WHERE id = ? AND reset_code_hash = ? AND reset_attempts < 5`,
      args: [user.id, user.reset_code_hash],
    });
    return false;
  }

  // El código es válido: reclama atómicamente con UPDATE condicional
  // para garantizar que solo se use una vez aunque lleguen dos peticiones a la vez
  const claim = await db.execute({
    sql: `UPDATE users
          SET password_hash = ?, reset_code_hash = NULL, reset_code_expires_at = NULL, reset_attempts = 0
          WHERE id = ? AND reset_code_hash = ? AND reset_attempts < 5
            AND reset_code_expires_at > ?`,
    args: [newPasswordHash, user.id, user.reset_code_hash, new Date().toISOString()],
  });

  return claim.rowsAffected === 1;
}

module.exports = { issueResetCode, redeemResetCode };
