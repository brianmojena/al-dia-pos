const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

const suffix = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;

const registerWith = (api, email, store_name = 'Tienda Test') => api('POST', '/api/auth/register', {
  body: { email, password: 'test1234', store_name },
});

const loginWith = (api, email, password = 'test1234') => api('POST', '/api/auth/login', {
  body: { email, password },
});

/**
 * Validación de email en registro y login:
 * - Normalización (trim + lowercase)
 * - Validación de formato
 * - Manejo de duplicados con distinto casing/espacios
 */

test('validación de email en registro y login', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('email inválido ("noesemail") rechaza el registro con 400', async () => {
    const res = await registerWith(ctx.api, 'noesemail');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Escribe un correo válido, por ejemplo nombre@gmail.com');
  });

  await t.test('email inválido no crea cuenta, login falla después con 401', async () => {
    const res = await loginWith(ctx.api, 'noesemail');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Email o contraseña incorrectos');
  });

  await t.test('email con espacios y mayúsculas se normaliza a lowercase', async () => {
    const s = suffix();
    const emailOrig = ` Juan@Test.Local `;
    const emailNorm = 'juan@test.local';

    const res = await registerWith(ctx.api, emailOrig);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, emailNorm, 'el email se normaliza a lowercase');

    // Puedo loguear con el email normalizado
    const login = await loginWith(ctx.api, emailNorm);
    assert.equal(login.status, 200);
  });

  await t.test('login con email en mayúsculas y espacios funciona', async () => {
    const s = suffix();
    const emailOrig = `USUARIO${s}@GMAIL.COM`;

    // Registro con mayúsculas
    const reg = await registerWith(ctx.api, emailOrig);
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.email, emailOrig.toLowerCase());

    // Login con espacios y mayúsculas
    const login = await loginWith(ctx.api, `  ${emailOrig}  `);
    assert.equal(login.status, 200);
  });

  await t.test('email duplicado con distinto casing/espacios rechaza con 409', async () => {
    const s = suffix();
    const email1 = `test${s}@ejemplo.com`;
    const email2 = `  TEST${s}@EJEMPLO.COM  `; // distinto casing y espacios

    const reg1 = await registerWith(ctx.api, email1);
    assert.equal(reg1.status, 201);

    const reg2 = await registerWith(ctx.api, email2);
    assert.equal(reg2.status, 409);
    assert.equal(reg2.body.error, 'Ya existe una cuenta con ese email');
  });

  await t.test('email vacío después de trim rechaza con 400', async () => {
    const res = await registerWith(ctx.api, '   ');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Email, contraseña y nombre de la tienda son requeridos');
  });

  await t.test('store_name vacío después de trim rechaza con 400', async () => {
    const s = suffix();
    const res = await ctx.api('POST', '/api/auth/register', {
      body: { email: `test${s}@ejemplo.com`, password: 'test1234', store_name: '   ' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Email, contraseña y nombre de la tienda son requeridos');
  });

  await t.test('email con otro formato inválido rechaza: sin @', async () => {
    const res = await registerWith(ctx.api, 'nodomiinio.com');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Escribe un correo válido, por ejemplo nombre@gmail.com');
  });

  await t.test('email con otro formato inválido rechaza: sin dominio', async () => {
    const res = await registerWith(ctx.api, 'usuario@');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Escribe un correo válido, por ejemplo nombre@gmail.com');
  });

  await t.test('email con otro formato inválido rechaza: sin extensión', async () => {
    const res = await registerWith(ctx.api, 'usuario@dominio');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Escribe un correo válido, por ejemplo nombre@gmail.com');
  });
});
