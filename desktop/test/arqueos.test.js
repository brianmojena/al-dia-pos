const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startLocalDb, crearProductoSincronizado, marcarVentasSincronizadas, outboxDe,
} = require('./helpers');
const { buildRequest } = require('../src/sync/syncWorker');

/**
 * Los arqueos en la caja de escritorio: se calculan y se guardan sin red, y
 * después suben por el outbox. La parte delicada no es el cálculo —espeja al
 * servidor— sino CÓMO viaja el cierre: ver el test del final.
 */

test('arqueos en la caja de escritorio', async (t) => {
  await t.test('el período abierto no revela cuánto debería haber', async () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 100 });
      ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 3, unit_price: 100 }],
        payment_method: 'efectivo',
      });

      const periodo = ctx.queries.getCurrentCashPeriod();

      assert.equal(periodo.has_sales, true);
      assert.equal(periodo.is_first_close, true);
      // Si el monto esperado llegara a la pantalla antes de declarar lo
      // contado, el conteo a ciegas no serviría de nada.
      assert.ok(!('expected_cash' in periodo), 'no puede venir el efectivo esperado');
      assert.ok(!('sales_count' in periodo), 'ni la cantidad de ventas, que también lo insinúa');
    } finally {
      ctx.close();
    }
  });

  await t.test('el cierre suma el efectivo y deja fuera las transferencias', async () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 20, sale_price: 100 });
      ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 3, unit_price: 100 }],
        payment_method: 'efectivo',
      });
      ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 5, unit_price: 100 }],
        payment_method: 'transferencia',
      });

      const cierre = ctx.queries.createCashCloseLocal({ counted_cash: 1300, opening_float: 1000 });

      assert.equal(cierre.expected_cash, 1300, 'fondo 1000 + 300 en efectivo');
      assert.equal(cierre.expected_transfer, 500, 'la transferencia va aparte: no está en la gaveta');
      assert.equal(cierre.difference, 0);
      assert.equal(cierre.sales_count, 2);
      assert.equal(cierre.account_email, 'cajera@mitienda.cu', 'queda registrado quién cerró');
    } finally {
      ctx.close();
    }
  });

  await t.test('el segundo cierre no vuelve a contar las ventas del primero', async () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 50, sale_price: 100 });

      ctx.queries.createSaleLocal({ items: [{ product_id: producto.id, quantity: 2, unit_price: 100 }] });
      const primero = ctx.queries.createCashCloseLocal({ counted_cash: 200 });
      assert.equal(primero.difference, 0);

      // La frontera entre cierres tiene resolución de un segundo.
      await new Promise((r) => setTimeout(r, 1100));

      ctx.queries.createSaleLocal({ items: [{ product_id: producto.id, quantity: 1, unit_price: 100 }] });
      const segundo = ctx.queries.createCashCloseLocal({ counted_cash: 100 });

      assert.equal(segundo.expected_cash, 100, 'solo la venta nueva');
      assert.equal(segundo.sales_count, 1);
      assert.equal(segundo.difference, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('el arqueo de inventario ajusta el stock y guarda la evidencia', async () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 750 });

      const arqueo = ctx.queries.createInventoryCountLocal({
        items: [{ product_id: producto.id, counted: 8 }],
      });

      assert.equal(arqueo.units_missing, 2);
      assert.equal(arqueo.value_missing, 1500, 'a precio de venta');
      assert.equal(arqueo.items[0].expected, 10);
      assert.equal(arqueo.items[0].counted, 8);

      const stock = ctx.db.prepare('SELECT stock FROM products WHERE id = ?').get(producto.id).stock;
      assert.equal(stock, 8, 'el stock queda en lo contado');

      // Y la evidencia sobrevive al ajuste: sin esto, corregir sería tapar.
      const linea = ctx.db.prepare('SELECT * FROM inventory_count_items WHERE product_id = ?').get(producto.id);
      assert.equal(linea.difference, -2);
    } finally {
      ctx.close();
    }
  });

  await t.test('un conteo inválido no deja el inventario a medio ajustar', async () => {
    const ctx = startLocalDb();
    try {
      const bueno = crearProductoSincronizado(ctx.queries, { name: 'Leche', stock: 15 });

      assert.throws(() => ctx.queries.createInventoryCountLocal({
        items: [
          { product_id: bueno.id, counted: 10 },
          { product_id: 999999, counted: 5 },
        ],
      }));

      const stock = ctx.db.prepare('SELECT stock FROM products WHERE id = ?').get(bueno.id).stock;
      assert.equal(stock, 15, 'el ajuste del primero debe revertirse');
      assert.equal(outboxDe('inventory_count.create').length, 0);
    } finally {
      ctx.close();
    }
  });

  await t.test('el rol se guarda en la sesión local', async () => {
    const ctx = startLocalDb();
    try {
      // Mismo error que costó la 1.0.1: el login recibe el campo del servidor y
      // si la sesión no tiene columna se descarta antes de tocar disco. Sin
      // esto, un cajero vería el panel del dueño en la caja.
      assert.equal(ctx.queries.getSession().role, 'cajero');
    } finally {
      ctx.close();
    }
  });

  /**
   * El test que justifica todo el diseño del payload.
   *
   * El servidor le pone a cada venta sincronizada su propia hora de llegada,
   * no la hora real del cobro. Si el cierre viajara con un rango de fechas, del
   * otro lado no encontraría ninguna de las ventas que acá ocurrieron horas
   * antes, y el descuadre saldría inventado. Por eso viaja con los
   * client_sale_id que cubrió — y por eso espera a que todos estén arriba.
   */
  await t.test('el cierre espera a que sus ventas hayan subido, y viaja con sus ids', async () => {
    const ctx = startLocalDb();
    try {
      const producto = crearProductoSincronizado(ctx.queries, { stock: 20, sale_price: 100 });
      const venta = ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 2, unit_price: 100 }],
        payment_method: 'efectivo',
      });
      ctx.queries.createCashCloseLocal({ counted_cash: 200 });

      const fila = outboxDe('cash_close.create')[0];
      assert.ok(fila, 'el cierre se encola para subir');

      // Todavía sin sincronizar la venta: el servidor calcularía el esperado
      // sin ella y el descuadre saldría mal. Mejor esperar.
      const antes = buildRequest(ctx.db, fila);
      assert.equal(antes.skip, true, 'se pospone hasta que la venta esté arriba');

      marcarVentasSincronizadas();

      const despues = buildRequest(ctx.db, fila);
      assert.ok(!despues.skip, 'ahora sí puede subir');
      assert.equal(despues.path, '/api/cash-closes');
      assert.deepEqual(despues.body.client_sale_ids, [venta.client_sale_id]);
      assert.equal(despues.body.counted_cash, 200);
      // El esperado NO viaja: lo recalcula el servidor. Si lo aceptara del
      // cliente, cualquiera podría mandar contado y esperado iguales y hacer
      // que la caja cuadre siempre.
      assert.ok(!('expected_cash' in despues.body), 'el esperado lo calcula el servidor');
      assert.ok(!('difference' in despues.body), 'y la diferencia también');
    } finally {
      ctx.close();
    }
  });

  await t.test('el router local expone las mismas rutas que el servidor', async () => {
    const ctx = startLocalDb();
    try {
      const { routeRequest } = require('../src/router');
      const producto = crearProductoSincronizado(ctx.queries, { stock: 10, sale_price: 100 });
      ctx.queries.createSaleLocal({
        items: [{ product_id: producto.id, quantity: 2, unit_price: 100 }],
        payment_method: 'efectivo',
      });

      const periodo = await routeRequest('GET', '/api/cash-closes/current');
      assert.equal(periodo.status, 200);
      assert.equal(periodo.data.has_sales, true);
      assert.ok(!('expected_cash' in periodo.data), 'tampoco por esta vía se filtra el esperado');

      const cierre = await routeRequest('POST', '/api/cash-closes', { counted_cash: 150 });
      assert.equal(cierre.status, 201);
      assert.equal(cierre.data.difference, -50);

      const historial = await routeRequest('GET', '/api/cash-closes');
      assert.equal(historial.data.length, 1);

      const resumen = await routeRequest('GET', '/api/cash-closes/summary');
      assert.equal(resumen.data[0].account_email, 'cajera@mitienda.cu');
      assert.equal(resumen.data[0].times_short, 1);

      const arqueo = await routeRequest('POST', '/api/inventory-counts', {
        items: [{ product_id: producto.id, counted: 6 }],
      });
      assert.equal(arqueo.status, 201);
      assert.equal(arqueo.data.units_missing, 2);

      const detalle = await routeRequest('GET', `/api/inventory-counts/${arqueo.data.id}`);
      assert.equal(detalle.data.items.length, 1);

      const me = await routeRequest('GET', '/api/auth/me');
      assert.equal(me.data.user.role, 'cajero', 'la caja sabe que quien entró es un cajero');
    } finally {
      ctx.close();
    }
  });

  await t.test('el arqueo de inventario espera a que sus productos hayan subido', async () => {
    const ctx = startLocalDb();
    try {
      // Producto creado offline: todavía no tiene server_id.
      const producto = ctx.queries.createProduct({ name: 'Nuevo', stock: 10, sale_price: 50 });
      ctx.queries.createInventoryCountLocal({ items: [{ product_id: producto.id, counted: 7 }] });

      const fila = outboxDe('inventory_count.create')[0];
      assert.equal(buildRequest(ctx.db, fila).skip, true, 'sin server_id del producto no se puede armar el POST');

      ctx.db.prepare('UPDATE products SET server_id = 555 WHERE id = ?').run(producto.id);

      const step = buildRequest(ctx.db, fila);
      assert.equal(step.path, '/api/inventory-counts');
      assert.deepEqual(step.body.items, [{ product_id: 555, counted: 7 }]);
    } finally {
      ctx.close();
    }
  });
});
