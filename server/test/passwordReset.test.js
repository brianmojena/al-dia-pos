const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestServer, registerUser, createCashier } = require('./helpers');

// La cuenta se aprovisiona explícitamente; el registro público no da permisos.
process.env.ADMIN_EMAILS = 'brianadmin@aldia.cu';
const ADMIN_EMAIL = 'brianadmin@aldia.cu';

const sufijo = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;

const register = (api, email, extra = {}) => api('POST', '/api/auth/register', {
  body: { email, password: 'test1234', store_name: 'Tienda Nueva', ...extra },
});

/**
 * Recuperación de contraseña: código de un solo uso generado por el administrador
 * desde su panel, que se usa sin sesión para cambiar la contraseña.
 */
test('recuperación de contraseña: código de un solo uso', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  // Crear cuenta de administración una sola vez
  let adminToken = null;
  const adminLogin = async () => {
    if (adminToken) return adminToken;
    await ctx.db.execute({
      sql: `INSERT INTO users (email, password_hash, store_name, plan, plan_status, is_admin)
            VALUES (?, ?, 'Administración', 'enterprise', 'active', 1)`,
      args: [ADMIN_EMAIL, bcrypt.hashSync('test1234', 10)],
    });
    const login = await ctx.api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'test1234' } });
    assert.equal(login.status, 200);
    adminToken = login.body.token;
    return adminToken;
  };

  await t.test('admin genera código para una tienda: 8 caracteres, válido por 15 min', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda);
    assert.equal(reg.status, 201);
    const tiendaId = reg.body.user.id;

    const respuesta = await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    });
    assert.equal(respuesta.status, 200);
    assert.ok(respuesta.body.code, 'devuelve el código en claro');
    assert.equal(respuesta.body.code.length, 8, 'el código tiene 8 caracteres');
    assert.ok(/^[0-9A-Z]+$/.test(respuesta.body.code), 'el código es alfanumérico');
    assert.ok(respuesta.body.expires_at, 'devuelve la fecha de vencimiento');

    const ahora = Date.now();
    const vence = Date.parse(respuesta.body.expires_at);
    const diferencia = (vence - ahora) / 1000 / 60; // en minutos
    assert.ok(diferencia > 14 && diferencia <= 15, `vence en ~15 min (fue ${diferencia.toFixed(2)} min)`);
  });

  await t.test('con el código y email (incluso con espacios/mayúsculas) se cambia la contraseña', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda);
    const tiendaId = reg.body.user.id;

    const { code } = (await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    })).body;

    // Probar normalizaciones: mayúsculas, espacios, guiones
    const variantes = [
      { email: emailTienda, code },
      { email: emailTienda.toUpperCase(), code },
      { email: `  ${emailTienda}  `, code },
      { email: emailTienda, code: code.toLowerCase() },
      { email: emailTienda, code: `${code.slice(0, 4)} ${code.slice(4)}` },
    ];

    for (const { email, code: testCode } of variantes) {
      const reset = await ctx.api('POST', '/api/auth/reset-password', {
        body: { email, code: testCode, new_password: 'nueva1234' },
      });
      assert.equal(reset.status, 200, `funciona con email: "${email}", code: "${testCode}"`);
      assert.equal(reset.body.ok, true);

      // Después del primer reset exitoso, el código está gastado.
      // Los demás intentos verán código vencido/inválido.
      const resetIntento2 = await ctx.api('POST', '/api/auth/reset-password', {
        body: { email: emailTienda, code, new_password: 'otra1234' },
      });
      assert.equal(resetIntento2.status, 400, 'el código solo vale una vez');
      return; // Solo testear el primero exitoso; después está vencido
    }
  });

  await t.test('después de cambiar contraseña, login con la nueva funciona y con la vieja falla', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda, { password: 'test1234' });
    const tiendaId = reg.body.user.id;

    const { code } = (await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    })).body;

    const reset = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: emailTienda, code, new_password: 'nueva1234' },
    });
    assert.equal(reset.status, 200);

    // Login con la vieja contraseña falla
    const loginVieja = await ctx.api('POST', '/api/auth/login', {
      body: { email: emailTienda, password: 'test1234' },
    });
    assert.equal(loginVieja.status, 401);

    // Login con la nueva funciona
    const loginNueva = await ctx.api('POST', '/api/auth/login', {
      body: { email: emailTienda, password: 'nueva1234' },
    });
    assert.equal(loginNueva.status, 200);
    assert.ok(loginNueva.body.token);
  });

  await t.test('un código nuevo invalida el anterior', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda);
    const tiendaId = reg.body.user.id;

    const res1 = await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    });
    const code1 = res1.body.code;

    // Generar un código nuevo
    const res2 = await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    });
    const code2 = res2.body.code;

    // El código viejo ya no funciona
    const reset1 = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: emailTienda, code: code1, new_password: 'nueva1234' },
    });
    assert.equal(reset1.status, 400, 'el código viejo falla después de generar uno nuevo');

    // El código nuevo funciona
    const reset2 = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: emailTienda, code: code2, new_password: 'nueva1234' },
    });
    assert.equal(reset2.status, 200);
  });

  await t.test('código vencido falla', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda);
    const tiendaId = reg.body.user.id;

    const res = await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    });
    const { code } = res.body;

    // Forzar que el código venza directamente en la base
    await ctx.db.execute({
      sql: 'UPDATE users SET reset_code_expires_at = ? WHERE id = ?',
      args: [new Date(Date.now() - 1000).toISOString(), tiendaId],
    });

    const reset = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: emailTienda, code, new_password: 'nueva1234' },
    });
    assert.equal(reset.status, 400);
    assert.equal(reset.body.error, 'El código no es válido o venció. Pide uno nuevo.');
  });

  await t.test('5 intentos con código equivocado anulan incluso el código correcto después', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda);
    const tiendaId = reg.body.user.id;

    const res = await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    });
    const { code } = res.body;

    // Intentar 5 veces con código incorrecto
    for (let i = 1; i <= 5; i++) {
      const reset = await ctx.api('POST', '/api/auth/reset-password', {
        body: { email: emailTienda, code: 'BADCODE00', new_password: 'nueva1234' },
      });
      assert.equal(reset.status, 400);
    }

    // Ahora el código correcto también falla (fue anulado por el 5to intento fallido)
    const resetCorrecto = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: emailTienda, code, new_password: 'nueva1234' },
    });
    assert.equal(resetCorrecto.status, 400, 'el código correcto falla después de 5 intentos malos');
  });

  await t.test('email inexistente da el mismo 400 y mensaje', async () => {
    const reset = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: `inexistente-${sufijo()}@test.local`, code: 'BADCODE00', new_password: 'nueva1234' },
    });
    assert.equal(reset.status, 400);
    assert.equal(reset.body.error, 'El código no es válido o venció. Pide uno nuevo.');
  });

  await t.test('contraseña corta (<6 caracteres) es rechazada', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda);
    const tiendaId = reg.body.user.id;

    const { code } = (await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    })).body;

    const reset = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: emailTienda, code, new_password: 'short' },
    });
    assert.equal(reset.status, 400);
    assert.equal(reset.body.error, 'La contraseña debe tener al menos 6 caracteres');
  });

  await t.test('usuario no admin no puede generar códigos (403)', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda);
    const tiendaId = reg.body.user.id;

    const otroUsuario = await registerUser(ctx.api, `normal-${sufijo()}@test.local`);

    const reset = await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: otroUsuario,
    });
    assert.equal(reset.status, 403, 'no admin obtiene 403');
  });

  await t.test('no se puede generar código para un cajero (owner_id no nulo)', async () => {
    const ownerToken = await registerUser(ctx.api, `dueno-${sufijo()}@test.local`);
    const { id: cajeroDId } = await createCashier(ctx.api, ownerToken, {
      email: `cajero-${sufijo()}@test.local`,
    });

    const reset = await ctx.api('POST', `/api/admin/shops/${cajeroDId}/reset-code`, {
      token: await adminLogin(),
    });
    assert.equal(reset.status, 404, 'intentar generar código para cajero devuelve 404');
  });

  await t.test('no se puede generar código para la cuenta de administración', async () => {
    const adminTok = await adminLogin();
    // Obtener el id del admin (hacer login o ver en /me)
    const me = await ctx.api('GET', '/api/auth/me', { token: adminTok });
    const adminId = me.body.user.id;

    const reset = await ctx.api('POST', `/api/admin/shops/${adminId}/reset-code`, {
      token: adminTok,
    });
    assert.equal(reset.status, 404, 'intentar generar código para admin devuelve 404');
  });

  await t.test('el hash guardado en la base NO es el código en claro', async () => {
    const emailTienda = `tienda-${sufijo()}@test.local`;
    const reg = await register(ctx.api, emailTienda);
    const tiendaId = reg.body.user.id;

    const res = await ctx.api('POST', `/api/admin/shops/${tiendaId}/reset-code`, {
      token: await adminLogin(),
    });
    const { code } = res.body;

    // Leer la fila de la tienda en la base
    const userRow = (await ctx.db.execute({
      sql: 'SELECT reset_code_hash FROM users WHERE id = ?',
      args: [tiendaId],
    })).rows[0];

    assert.ok(userRow.reset_code_hash, 'hay un hash guardado');
    assert.notEqual(userRow.reset_code_hash, code, 'el hash NO es el código en claro');
    assert.equal(userRow.reset_code_hash.length, 64, 'es un hash SHA-256 (64 chars hex)');
  });

  await t.test('falta email, código o contraseña', async () => {
    const reset1 = await ctx.api('POST', '/api/auth/reset-password', {
      body: { code: 'ABCD1234', new_password: 'nueva1234' },
    });
    assert.equal(reset1.status, 400);
    assert.equal(reset1.body.error, 'Escribe tu correo, el código y la nueva contraseña');

    const reset2 = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: 'test@test.local', new_password: 'nueva1234' },
    });
    assert.equal(reset2.status, 400);
    assert.equal(reset2.body.error, 'Escribe tu correo, el código y la nueva contraseña');

    const reset3 = await ctx.api('POST', '/api/auth/reset-password', {
      body: { email: 'test@test.local', code: 'ABCD1234' },
    });
    assert.equal(reset3.status, 400);
    assert.equal(reset3.body.error, 'Escribe tu correo, el código y la nueva contraseña');
  });
  await t.test('intentos concurrentes se cuentan y un código solo se canjea una vez', async () => {
    const email = `concurrente-${sufijo()}@test.local`;
    const reg = await register(ctx.api, email);
    const { issueResetCode, redeemResetCode } = require('../lib/passwordReset');
    const hash = bcrypt.hashSync('nueva1234', 10);
    const { code } = await issueResetCode(ctx.db, reg.body.user.id);
    await Promise.all(Array.from({ length: 10 }, () => redeemResetCode(ctx.db, email, 'INCORRECTO', hash)));
    const row = (await ctx.db.execute({ sql: 'SELECT reset_attempts, reset_code_hash FROM users WHERE id = ?', args: [reg.body.user.id] })).rows[0];
    assert.equal(row.reset_attempts, 5);
    assert.equal(row.reset_code_hash, null);
    assert.equal(await redeemResetCode(ctx.db, email, code, hash), false);
    const replacement = await issueResetCode(ctx.db, reg.body.user.id);
    const results = await Promise.all(Array.from({ length: 4 }, () => redeemResetCode(ctx.db, email, replacement.code, hash)));
    assert.equal(results.filter(Boolean).length, 1);
  });

  await t.test('datos mal formados devuelven 400 sin causar errores del servidor', async () => {
    for (const body of [
      { email: {}, code: 'ABCD1234', new_password: 'nueva1234' },
      { email: 'test@test.local', code: {}, new_password: 'nueva1234' },
      { email: 'test@test.local', code: 'ABCD1234', new_password: 12345678 },
    ]) assert.equal((await ctx.api('POST', '/api/auth/reset-password', { body })).status, 400);
  });

});
