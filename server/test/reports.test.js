const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startTestServer, registerUser, createProduct } = require('./helpers');
const { monthBounds, businessCurrentMonth } = require('../lib/businessDay');

/**
 * El histórico de días pasados (GET /api/reports/days) y su descarga en Excel
 * (GET /api/reports/export) son para el "económico" que revisa el negocio
 * DESPUÉS de que pasó, no para quien está parado en la caja. Estos tests
 * cubren lo mismo que le importa a esa revisión: que cada venta y cada cierre
 * caigan en el día que le corresponde EN CUBA (no en UTC), que efectivo y
 * transferencia no se mezclen, y que un mes no se cuele en otro.
 */

const crearCajero = async (api, tokenDueño, email, password = 'cajero1234') => {
  const res = await api('POST', '/api/auth/cashiers', { token: tokenDueño, body: { email, password } });
  if (res.status !== 201) throw new Error(`No se pudo crear el cajero: ${res.status} ${JSON.stringify(res.body)}`);
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  return login.body.token;
};

const venta = (api, token, { productId, quantity = 1, unit_price = 100, payment_method = 'efectivo' }) =>
  api('POST', '/api/sales', { token, body: { items: [{ product_id: productId, quantity, unit_price }], payment_method } });

// Mueve la venta/cierre ya creado a un instante UTC explícito — es la única
// forma de controlar en qué día local cae, sin depender de la hora real en la
// que corre el test.
const setTimestamp = (db, table, column, id, sqlUtc) =>
  db.execute({ sql: `UPDATE ${table} SET ${column} = ? WHERE id = ?`, args: [sqlUtc, id] });

test('reportes: histórico por día y exportación a Excel', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  await t.test('una venta cerca de la medianoche UTC cae en el día correcto de Cuba', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Ron', stock: 10, sale_price: 500, purchase_price: 300 });

    const res = await venta(ctx.api, token, { productId, quantity: 1, unit_price: 500 });
    assert.equal(res.status, 201);

    // 2026-09-15 02:00:00 UTC son las 22:00 del 14 en Cuba (UTC-4 en septiembre).
    await setTimestamp(ctx.db, 'sales', 'created_at', res.body.id, '2026-09-15 02:00:00');

    const dias = await ctx.api('GET', '/api/reports/days?month=2026-09', { token });
    assert.equal(dias.status, 200);
    assert.equal(dias.body.days.length, 1);
    assert.equal(dias.body.days[0].date, '2026-09-14', 'la venta pertenece a la noche del 14 en Cuba, no al 15 UTC');
  });

  await t.test('separa efectivo de transferencia y suma la ganancia', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Cerveza', stock: 20, sale_price: 100, purchase_price: 60 });

    const a = await venta(ctx.api, token, { productId, quantity: 3, unit_price: 100, payment_method: 'efectivo' });
    const b = await venta(ctx.api, token, { productId, quantity: 2, unit_price: 100, payment_method: 'transferencia' });
    await setTimestamp(ctx.db, 'sales', 'created_at', a.body.id, '2026-09-10 15:00:00');
    await setTimestamp(ctx.db, 'sales', 'created_at', b.body.id, '2026-09-10 15:05:00');

    const dias = await ctx.api('GET', '/api/reports/days?month=2026-09', { token });
    const dia = dias.body.days.find((d) => d.date === '2026-09-10');
    assert.ok(dia, 'el día debe aparecer');
    assert.equal(dia.sales_count, 2);
    assert.equal(dia.total, 500, '3*100 + 2*100');
    assert.equal(dia.cash_total, 300);
    assert.equal(dia.transfer_total, 200);
    assert.equal(dia.profit, 200, '(100-60)*3 + (100-60)*2');

    assert.equal(dias.body.totals.cash_total, 300);
    assert.equal(dias.body.totals.transfer_total, 200);
    assert.equal(dias.body.totals.profit, 200);
  });

  await t.test('los cierres se agrupan en el día correcto y marcan faltante', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Pan', stock: 20, sale_price: 100, purchase_price: 50 });

    await venta(ctx.api, token, { productId, quantity: 5, unit_price: 100 });
    const cierre = await ctx.api('POST', '/api/cash-closes', { token, body: { counted_cash: 300 } }); // faltan 200
    assert.equal(cierre.status, 201);
    await setTimestamp(ctx.db, 'cash_closes', 'closed_at', cierre.body.id, '2026-09-12 18:00:00');

    const dias = await ctx.api('GET', '/api/reports/days?month=2026-09', { token });
    const dia = dias.body.days.find((d) => d.date === '2026-09-12');
    assert.ok(dia);
    assert.ok(dia.closes, 'el día del cierre debe traer su resumen');
    assert.equal(dia.closes.count, 1);
    assert.equal(dia.closes.difference, -200);
    assert.equal(dia.closes.short, true);

    // Un día con ventas pero sin cierre no debe traer closes.
    const diaSinCierre = dias.body.days.find((d) => d.date !== '2026-09-12');
    if (diaSinCierre) assert.equal(diaSinCierre.closes, null);
  });

  await t.test('un cierre con diferencia positiva o cero no queda marcado como "short"', async () => {
    const token = await registerUser(ctx.api);
    const cierre = await ctx.api('POST', '/api/cash-closes', { token, body: { counted_cash: 0 } });
    await setTimestamp(ctx.db, 'cash_closes', 'closed_at', cierre.body.id, '2026-09-13 12:00:00');

    const dias = await ctx.api('GET', '/api/reports/days?month=2026-09', { token });
    const dia = dias.body.days.find((d) => d.date === '2026-09-13');
    assert.equal(dia.closes.short, false);
  });

  await t.test('los días vienen del más reciente al más antiguo, y los días sin actividad no aparecen', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Sal', stock: 20, sale_price: 50 });

    const v1 = await venta(ctx.api, token, { productId, quantity: 1, unit_price: 50 });
    const v2 = await venta(ctx.api, token, { productId, quantity: 1, unit_price: 50 });
    const v3 = await venta(ctx.api, token, { productId, quantity: 1, unit_price: 50 });
    await setTimestamp(ctx.db, 'sales', 'created_at', v1.body.id, '2026-09-05 15:00:00');
    await setTimestamp(ctx.db, 'sales', 'created_at', v2.body.id, '2026-09-20 15:00:00');
    await setTimestamp(ctx.db, 'sales', 'created_at', v3.body.id, '2026-09-12 15:00:00');

    const dias = await ctx.api('GET', '/api/reports/days?month=2026-09', { token });
    const fechas = dias.body.days.map((d) => d.date);
    assert.deepEqual(fechas, ['2026-09-20', '2026-09-12', '2026-09-05'], 'de más reciente a más antiguo');
    assert.equal(dias.body.days.length, 3, 'ningún otro día del mes tiene actividad');
  });

  await t.test('respeta la frontera del mes en hora de Cuba, no en UTC', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Café', stock: 20, sale_price: 100 });

    const bordeSept = monthBounds('2026-09');
    const bordeOct = monthBounds('2026-10');
    assert.equal(bordeSept.end, bordeOct.start, 'septiembre termina justo donde empieza octubre');

    // Un segundo antes de la frontera: el último instante de septiembre.
    const ultimoSegundoSept = new Date(new Date(bordeSept.end.replace(' ', 'T') + 'Z').getTime() - 1000)
      .toISOString().slice(0, 19).replace('T', ' ');

    const vDentro = await venta(ctx.api, token, { productId, quantity: 1, unit_price: 100 });
    const vFuera  = await venta(ctx.api, token, { productId, quantity: 1, unit_price: 100 });
    await setTimestamp(ctx.db, 'sales', 'created_at', vDentro.body.id, ultimoSegundoSept);
    await setTimestamp(ctx.db, 'sales', 'created_at', vFuera.body.id, bordeSept.end); // ya es octubre

    const septiembre = await ctx.api('GET', '/api/reports/days?month=2026-09', { token });
    assert.equal(septiembre.body.totals.sales_count, 1, 'solo la venta de dentro del mes');

    const octubre = await ctx.api('GET', '/api/reports/days?month=2026-10', { token });
    assert.equal(octubre.body.totals.sales_count, 1, 'la otra venta pertenece a octubre');
  });

  await t.test('sin mes en el query, usa el mes actual del negocio', async () => {
    const token = await registerUser(ctx.api);
    const res = await ctx.api('GET', '/api/reports/days', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.month, businessCurrentMonth());
  });

  await t.test('un mes con forma inválida responde 400', async () => {
    const token = await registerUser(ctx.api);
    for (const mes of ['2026-13', 'abc', '2026', '2026-9', '']) {
      const url = mes === '' ? '/api/reports/days?month=' : `/api/reports/days?month=${mes}`;
      const res = await ctx.api('GET', url, { token });
      assert.equal(res.status, 400, `mes "${mes}" debería ser inválido`);
      assert.equal(res.body.error, 'Mes inválido');
    }
  });

  await t.test('un cajero no puede ver el histórico ni descargar el Excel', async () => {
    const dueño = await registerUser(ctx.api);
    const cajero = await crearCajero(ctx.api, dueño, `eco1${Date.now()}@test.local`);

    const dias = await ctx.api('GET', '/api/reports/days', { token: cajero });
    assert.equal(dias.status, 403);

    const excel = await ctx.api('GET', '/api/reports/export', { token: cajero });
    assert.equal(excel.status, 403);
  });

  await t.test('las ventas de una tienda no se cuelan en el histórico de otra', async () => {
    const tokenA = await registerUser(ctx.api);
    const tokenB = await registerUser(ctx.api);
    const productoA = await createProduct(ctx.api, tokenA, { name: 'Arroz', stock: 20, sale_price: 100 });
    const productoB = await createProduct(ctx.api, tokenB, { name: 'Arroz', stock: 20, sale_price: 100 });

    const vA = await venta(ctx.api, tokenA, { productId: productoA, quantity: 1, unit_price: 100 });
    const vB = await venta(ctx.api, tokenB, { productId: productoB, quantity: 1, unit_price: 100 });
    await setTimestamp(ctx.db, 'sales', 'created_at', vA.body.id, '2026-09-08 15:00:00');
    await setTimestamp(ctx.db, 'sales', 'created_at', vB.body.id, '2026-09-08 15:00:00');

    const diasA = await ctx.api('GET', '/api/reports/days?month=2026-09', { token: tokenA });
    assert.equal(diasA.body.totals.sales_count, 1, 'A no ve la venta de B');
  });

  await t.test('GET /api/sales?date= sigue funcionando (no lo tocó esta ruta)', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Huevos', stock: 20, sale_price: 30 });
    const v = await venta(ctx.api, token, { productId, quantity: 1, unit_price: 30 });
    await setTimestamp(ctx.db, 'sales', 'created_at', v.body.id, '2026-09-07 15:00:00');

    const res = await ctx.api('GET', '/api/sales?date=2026-09-07', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, v.body.id);
  });

  await t.test('el Excel trae las tres hojas con las ventas y cierres del mes', async () => {
    const token = await registerUser(ctx.api);
    const productId = await createProduct(ctx.api, token, { name: 'Refresco', stock: 20, sale_price: 80, purchase_price: 50 });

    // Una venta con dos líneas -> dos filas en "Ventas".
    const v1 = await ctx.api('POST', '/api/sales', {
      token,
      body: {
        items: [
          { product_id: productId, quantity: 2, unit_price: 80 },
        ],
        payment_method: 'efectivo',
      },
    });
    const v2 = await venta(ctx.api, token, { productId, quantity: 1, unit_price: 80, payment_method: 'transferencia' });
    await setTimestamp(ctx.db, 'sales', 'created_at', v1.body.id, '2026-09-06 14:00:00');
    await setTimestamp(ctx.db, 'sales', 'created_at', v2.body.id, '2026-09-06 15:00:00');

    const cierre = await ctx.api('POST', '/api/cash-closes', { token, body: { counted_cash: 160 } });
    await setTimestamp(ctx.db, 'cash_closes', 'closed_at', cierre.body.id, '2026-09-06 16:00:00');

    const res = await fetch(`${ctx.baseUrl}/api/reports/export?month=2026-09`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="ventas-2026-09\.xlsx"/);

    const buffer = Buffer.from(await res.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const nombres = workbook.worksheets.map((s) => s.name);
    assert.deepEqual(nombres, ['Resumen por día', 'Ventas', 'Cierres de caja']);

    const ventas = workbook.getWorksheet('Ventas');
    // Encabezado + 2 líneas de venta (una de la venta de 2 unidades, otra de la de transferencia).
    assert.equal(ventas.rowCount, 3);
    assert.equal(ventas.getRow(1).getCell(1).value, 'Fecha');

    const cierres = workbook.getWorksheet('Cierres de caja');
    assert.equal(cierres.rowCount, 2, 'encabezado + 1 cierre');

    const resumen = workbook.getWorksheet('Resumen por día');
    // Al menos el día con actividad + la fila de "Total del mes".
    assert.ok(resumen.rowCount >= 3);
    const ultimaFila = resumen.getRow(resumen.rowCount);
    assert.equal(ultimaFila.getCell(1).value, 'Total del mes');
  });

  await t.test('un mes vacío exporta un libro válido con encabezados y totales en cero', async () => {
    const token = await registerUser(ctx.api);
    const res = await fetch(`${ctx.baseUrl}/api/reports/export?month=2020-01`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);

    const buffer = Buffer.from(await res.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const resumen = workbook.getWorksheet('Resumen por día');
    assert.equal(resumen.rowCount, 2, 'solo encabezado + fila de total en cero');
    assert.equal(resumen.getRow(2).getCell(1).value, 'Total del mes');
    assert.equal(resumen.getRow(2).getCell(2).value, 0);

    const ventas = workbook.getWorksheet('Ventas');
    assert.equal(ventas.rowCount, 1, 'solo el encabezado');
  });
});
