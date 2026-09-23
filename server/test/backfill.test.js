const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, registerUser, createProduct } = require('./helpers');

/**
 * El backfill de sales.cash_close_id corre una sola vez al desplegar. Si se
 * equivoca, el primer cierre nuevo se lleva todo el historial (ventas que
 * quedaron sin marcar) o deja fuera ventas del período abierto (marcadas de
 * más). Aquí se reconstruye una base "de antes" y se vuelve a correr initDb.
 */
test('backfill de cierres al desplegar', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const { initDb, getDb } = require('../db/database');
  const db = getDb();

  const token = await registerUser(ctx.api);
  const product = await createProduct(ctx.api, token, { name: 'Pan', stock: 20, sale_price: 100 });
  const vender = async (clientSaleId) => {
    const res = await ctx.api('POST', '/api/sales', {
      token,
      body: { client_sale_id: clientSaleId, items: [{ product_id: product, quantity: 1, unit_price: 100 }] },
    });
    assert.equal(res.status, 201);
    return Number(res.body.id);
  };

  const antes = await vender('antes-del-cierre');
  const cierre = await ctx.api('POST', '/api/cash-closes', { token, body: { counted_cash: 100 } });
  assert.equal(cierre.status, 201);
  const despues = await vender('despues-del-cierre');

  // Base "de antes del despliegue": horas como las dejaba el servidor viejo y
  // ninguna venta marcada, sin la marca de migración aplicada.
  await db.execute({ sql: "UPDATE sales SET created_at = '2026-09-20 10:00:00' WHERE id = ?", args: [antes] });
  await db.execute({ sql: "UPDATE sales SET created_at = '2026-09-20 12:00:00' WHERE id = ?", args: [despues] });
  await db.execute({ sql: "UPDATE cash_closes SET closed_at = '2026-09-20 11:00:00' WHERE id = ?", args: [cierre.body.id] });
  await db.execute('UPDATE sales SET cash_close_id = NULL');
  await db.execute("DELETE FROM schema_migrations WHERE key = 'sales_cash_close_id_v1'");

  await t.test('dos arranques en frío a la vez no rompen initDb', async () => {
    // Ambos ven la migración pendiente y ambos la corren: el segundo no puede
    // fallar contra la PRIMARY KEY de schema_migrations.
    await Promise.all([initDb(), initDb()]);
    const marca = await db.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE key = 'sales_cash_close_id_v1'");
    assert.equal(Number(marca.rows[0].n), 1);
  });

  await t.test('lo anterior al cierre queda cubierto y lo posterior sigue abierto', async () => {
    const filas = await db.execute({
      sql: 'SELECT id, cash_close_id FROM sales WHERE id IN (?, ?) ORDER BY id',
      args: [antes, despues],
    });
    assert.equal(Number(filas.rows[0].cash_close_id), Number(cierre.body.id));
    assert.equal(filas.rows[1].cash_close_id, null);

    const siguiente = await ctx.api('POST', '/api/cash-closes', { token, body: { counted_cash: 100 } });
    assert.equal(siguiente.status, 201);
    assert.equal(Number(siguiente.body.sales_count), 1, 'el primer cierre nuevo no se lleva el historial');
    assert.equal(Number(siguiente.body.expected_cash), 100);
  });

  await t.test('no se repite: un arranque posterior no toca ventas ya abiertas', async () => {
    const abierta = await vender('abierta-tras-desplegar');
    await db.execute({ sql: "UPDATE sales SET created_at = '2026-09-20 10:30:00' WHERE id = ?", args: [abierta] });
    await initDb();
    const fila = await db.execute({ sql: 'SELECT cash_close_id FROM sales WHERE id = ?', args: [abierta] });
    assert.equal(fila.rows[0].cash_close_id, null, 'con la marca puesta el backfill no vuelve a correr');
  });
});
