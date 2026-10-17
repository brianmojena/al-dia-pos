const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createCashier } = require('./helpers');

const suffix = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;

const registerWith = (api, email, plan) => api('POST', '/api/auth/register', {
  body: { email, password: 'test1234', store_name: 'Tienda Test', ...(plan ? { plan } : {}) },
});

const intentarCajero = (api, token, email) =>
  api('POST', '/api/auth/cashiers', { token, body: { email, password: 'cajero1234' } });

/**
 * Los planes Basic ($10, 5 usuarios) y Enterprise (10 usuarios) reemplazaron a
 * Premium/Dev. El registro ya no acepta los viejos — guardarlos sería dejar a
 * una tienda con un plan que ya no existe — y el tope de usuarios lo decide la
 * escritura en la base, no un conteo previo en JavaScript.
 */

test('planes: Basic, Enterprise y tope de usuarios', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('el registro guarda el plan elegido; un plan viejo o inventado cae a Basic', async () => {
    const s = suffix();

    const sinPlan = await registerWith(ctx.api, `p-sinplan-${s}@test.local`);
    assert.equal(sinPlan.status, 201);
    assert.equal(sinPlan.body.user.plan, 'basic', 'sin plan explícito queda Basic');

    const enterprise = await registerWith(ctx.api, `p-ent-${s}@test.local`, 'enterprise');
    assert.equal(enterprise.status, 201);
    assert.equal(enterprise.body.user.plan, 'enterprise');

    for (const viejo of ['premium', 'dev', 'gratis']) {
      const res = await registerWith(ctx.api, `p-${viejo}-${s}@test.local`, viejo);
      assert.equal(res.body.user.plan, 'basic', `'${viejo}' ya no es un plan válido`);
    }

    const me = await ctx.api('GET', '/api/auth/me', { token: enterprise.body.token });
    assert.equal(me.body.user.plan, 'enterprise', '/me devuelve el plan de la tienda');
  });

  await t.test('un cajero hereda el plan de la tienda', async () => {
    const s = suffix();
    const emailTienda = `p-ent2-${s}@test.local`;
    const emailCajero = `p-caj-${s}@test.local`;
    const registrado = await registerWith(ctx.api, emailTienda, 'enterprise');
    assert.equal((await intentarCajero(ctx.api, registrado.body.token, emailCajero)).status, 201);

    const login = await ctx.api('POST', '/api/auth/login', { body: { email: emailCajero, password: 'cajero1234' } });
    assert.equal(login.body.user.plan, 'enterprise');
  });

  await t.test('Plan Basic: 5 usuarios por tienda, la cuenta principal incluida', async () => {
    const s = suffix();
    const registrado = await registerWith(ctx.api, `tope-basic-${s}@test.local`);
    assert.equal(registrado.body.user.plan, 'basic');

    for (let i = 1; i <= 4; i++) {
      await createCashier(ctx.api, registrado.body.token, { email: `tope-basic-c${i}-${s}@test.local` });
    }

    const deMas = await intentarCajero(ctx.api, registrado.body.token, `tope-basic-c5-${s}@test.local`);
    assert.equal(deMas.status, 409, 'la sexta cuenta (dueño + 5) se rechaza');
    assert.match(deMas.body.error, /Plan Basic permite hasta 5 usuarios/);

    // Quitar un cajero libera la plaza.
    const lista = await ctx.api('GET', '/api/auth/cashiers', { token: registrado.body.token });
    assert.equal(lista.body.length, 4);
    const borrar = await ctx.api('DELETE', `/api/auth/cashiers/${lista.body[0].id}`, { token: registrado.body.token });
    assert.equal(borrar.status, 200);
    assert.equal((await intentarCajero(ctx.api, registrado.body.token, `tope-basic-c6-${s}@test.local`)).status, 201);
  });

  await t.test('Plan Enterprise: 10 usuarios por tienda', async () => {
    const s = suffix();
    const registrado = await registerWith(ctx.api, `tope-ent-${s}@test.local`, 'enterprise');

    for (let i = 1; i <= 9; i++) {
      await createCashier(ctx.api, registrado.body.token, { email: `tope-ent-c${i}-${s}@test.local` });
    }

    const deMas = await intentarCajero(ctx.api, registrado.body.token, `tope-ent-c10-${s}@test.local`);
    assert.equal(deMas.status, 409, 'la undécima cuenta (dueño + 10) se rechaza');
    assert.match(deMas.body.error, /Plan Enterprise permite hasta 10 usuarios/);
  });
});
