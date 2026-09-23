const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, jornadaFixtures } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startTestServer(); });
test.after(async () => { await ctx.close(); });

test('jornada diaria: vende, cierra la caja y el dashboard cuadra', async () => {
  const { api } = ctx;
  const { ownerToken, cashierToken, panId, lecheId } = await jornadaFixtures(api);

  await api('PUT', '/api/auth/settings', {
    token: ownerToken, body: { transfer_limit: 500, usd_rate: 400 },
  });

  // El cajero cobra en efectivo y por transferencia por debajo del techo.
  const ventaEfectivo = await api('POST', '/api/sales', {
    token: cashierToken,
    body: {
      items: [{ product_id: panId, quantity: 2, unit_price: 100 }],
      payment_method: 'efectivo', client_sale_id: `dia-ef-${Date.now()}`,
    },
  });
  assert.equal(ventaEfectivo.status, 201);
  assert.equal(ventaEfectivo.body.total, 200);

  const ventaTransfer = await api('POST', '/api/sales', {
    token: cashierToken,
    body: {
      items: [{ product_id: lecheId, quantity: 1, unit_price: 200 }],
      payment_method: 'transferencia', client_sale_id: `dia-tr-${Date.now()}`,
    },
  });
  assert.equal(ventaTransfer.status, 201);

  // El conteo es a ciegas: el período abierto no muestra el esperado.
  const current = await api('GET', '/api/cash-closes/current', { token: cashierToken });
  assert.equal(current.status, 200);
  assert.ok(!('expected_cash' in current.body));

  // Cierra contando solo el efectivo (200) + fondo 0.
  const cierre = await api('POST', '/api/cash-closes', {
    token: cashierToken,
    body: { counted_cash: 200, opening_float: 0, client_close_id: `cierre-${Date.now()}` },
  });
  assert.equal(cierre.status, 201);
  assert.equal(cierre.body.difference, 0);
  assert.equal(cierre.body.expected_transfer, 200);

  // El dashboard del dueño ve el día completo.
  const dash = await api('GET', '/api/dashboard', { token: ownerToken });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.today.count, 2);
  assert.equal(dash.body.today.sales, 400);

  // Un segundo cierre sin ventas nuevas no recontabiliza lo ya cerrado.
  const cierre2 = await api('POST', '/api/cash-closes', {
    token: cashierToken,
    body: { counted_cash: 0, opening_float: 0, client_close_id: `cierre2-${Date.now()}` },
  });
  assert.equal(cierre2.status, 201);
  assert.equal(cierre2.body.sales_count, 0);
});

test('la transferencia por encima del techo se bloquea en el servidor', async () => {
  const { api } = ctx;
  const { ownerToken, cashierToken, lecheId } = await jornadaFixtures(api);
  await api('PUT', '/api/auth/settings', {
    token: ownerToken, body: { transfer_limit: 150 },
  });

  const bloqueada = await api('POST', '/api/sales', {
    token: cashierToken,
    body: {
      items: [{ product_id: lecheId, quantity: 1, unit_price: 200 }],
      payment_method: 'transferencia', client_sale_id: `tr-block-${Date.now()}`,
    },
  });
  assert.equal(bloqueada.status, 403);
  assert.match(String(bloqueada.body.error), /transferencia/i);

  // El mismo importe en efectivo sí pasa: el techo solo limita transferencias.
  const enEfectivo = await api('POST', '/api/sales', {
    token: cashierToken,
    body: {
      items: [{ product_id: lecheId, quantity: 1, unit_price: 200 }],
      payment_method: 'efectivo', client_sale_id: `ef-ok-${Date.now()}`,
    },
  });
  assert.equal(enEfectivo.status, 201);

  // El total exacto en el techo pasa (límite inclusivo).
  const alLimite = await api('POST', '/api/sales', {
    token: cashierToken,
    body: {
      items: [{ product_id: lecheId, quantity: 1, unit_price: 150 }],
      payment_method: 'transferencia', client_sale_id: `tr-lim-${Date.now()}`,
    },
  });
  assert.equal(alLimite.status, 201);

  // Sin techo configurado, la transferencia pasa.
  await api('PUT', '/api/auth/settings', {
    token: ownerToken, body: { transfer_limit: null },
  });
  const sinTecho = await api('POST', '/api/sales', {
    token: cashierToken,
    body: {
      items: [{ product_id: lecheId, quantity: 1, unit_price: 200 }],
      payment_method: 'transferencia', client_sale_id: `tr-free-${Date.now()}`,
    },
  });
  assert.equal(sinTecho.status, 201);

  // La venta bloqueada no descontó stock: el bloqueo es antes del descuento.
  const productos = await api('GET', '/api/products', { token: ownerToken });
  const leche = productos.body.find((p) => p.name === 'Leche');
  assert.equal(leche.stock, 5 - 3);
});

test('variantes del cobro que no pueden romper el día', async () => {
  const { api } = ctx;
  const { ownerToken, cashierToken, panId, agotadoId } = await jornadaFixtures(api);

  const casos400 = [
    [{ product_id: panId, quantity: 0, unit_price: 100 }],
    [{ product_id: panId, quantity: -1, unit_price: 100 }],
    [{ product_id: panId, quantity: 1.5, unit_price: 100 }],
    [{ product_id: panId, quantity: 1, unit_price: -5 }],
    [{ product_id: 999999, quantity: 1, unit_price: 100 }],
  ];
  for (const items of casos400) {
    const r = await api('POST', '/api/sales', {
      token: cashierToken, body: { items, client_sale_id: `bad-${Date.now()}-${Math.random()}` },
    });
    assert.equal(r.status, 400, JSON.stringify({ items, r }));
  }

  const sinStock = await api('POST', '/api/sales', {
    token: cashierToken,
    body: { items: [{ product_id: agotadoId, quantity: 1, unit_price: 50 }], client_sale_id: `ag-${Date.now()}` },
  });
  assert.equal(sinStock.status, 409);

  const formaPagoMala = await api('POST', '/api/sales', {
    token: cashierToken,
    body: { items: [{ product_id: panId, quantity: 1, unit_price: 100 }], payment_method: 'tarjeta', client_sale_id: `pm-${Date.now()}` },
  });
  assert.equal(formaPagoMala.status, 400);

  // Producto de otra tienda no existe para este cajero.
  const otraTienda = await jornadaFixtures(api);
  const cruzada = await api('POST', '/api/sales', {
    token: cashierToken,
    body: { items: [{ product_id: otraTienda.panId, quantity: 1, unit_price: 100 }], client_sale_id: `x-${Date.now()}` },
  });
  assert.equal(cruzada.status, 400);

  // Reintento con el mismo id no cobra dos veces.
  const id = `reintento-${Date.now()}`;
  const primera = await api('POST', '/api/sales', {
    token: cashierToken,
    body: { items: [{ product_id: panId, quantity: 1, unit_price: 100 }], client_sale_id: id },
  });
  assert.equal(primera.status, 201);
  const reintento = await api('POST', '/api/sales', {
    token: cashierToken,
    body: { items: [{ product_id: panId, quantity: 1, unit_price: 100 }], client_sale_id: id },
  });
  assert.equal(reintento.status, 200);
  assert.equal(reintento.body.idempotent_replay, true);
  void ownerToken;
});
