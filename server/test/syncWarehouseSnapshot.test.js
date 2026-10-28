const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestServer, registerUser, createProduct, createCashier } = require('./helpers');

process.env.ADMIN_EMAILS = 'brianadmin@aldia.cu';
const suffix = () => `${Date.now()}${Math.random().toString(36).slice(2)}`;
const NEW = 'after_warehouse=0&after_warehouse_state=0&after_warehouse_transfer=0&after_stock_entry=0';

test('snapshot S5: almacén y entradas de stock', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const snap = (token, qs) => ctx.api('GET', `/api/sync/snapshot?${qs}`, { token });
  const shop = async () => {
    const owner = await registerUser(ctx.api);
    const cashier = await createCashier(ctx.api, owner);
    await createProduct(ctx.api, owner, { name: 'Pan', stock: 5 });
    return { owner, cashier };
  };
  const addItem = async (token, name) => (await ctx.api('POST', '/api/warehouse', { token, body: { name, cost: 3, quantity: 10 } })).body;

  await t.test('cliente sin los cursores nuevos: ni campos ni cursores nuevos', async () => {
    const { owner } = await shop();
    await addItem(owner, 'Aceite');
    const r = await snap(owner, 'after_sale=0');
    assert.equal(r.status, 200);
    for (const k of ['warehouse_items', 'warehouse_states', 'warehouse_transfers', 'stock_entries', 'warehouse_live_ids']) assert.equal(k in r.body, false, k);
    assert.deepEqual(Object.keys(r.body.cursors).sort(), ['close', 'close_correction', 'correction', 'count', 'purchase', 'purchase_state', 'sale', 'sale_state', 'withdrawal', 'withdrawal_state']);
  });

  await t.test('dueño: paginación, cursores monótonos y borrados', async () => {
    const { owner } = await shop();
    const a = await addItem(owner, 'Aceite'); const b = await addItem(owner, 'Arroz'); await addItem(owner, 'Sal');
    const p1 = await snap(owner, `${NEW}&limit=2`);
    assert.equal(p1.body.warehouse_items.length, 2);
    assert.equal(p1.body.has_more, true);
    const c1 = p1.body.cursors.warehouse;
    assert.equal(c1, Number(b.id));
    const p2 = await snap(owner, `after_warehouse=${c1}&limit=2`);
    assert.equal(p2.body.warehouse_items.length, 1);
    assert.ok(p2.body.cursors.warehouse > c1);
    assert.equal(p2.body.cursors.warehouse_state, undefined);
    // Estados + ids vivos en la pasada completa; borrar se ve por ausencia.
    const full = await snap(owner, 'after_warehouse_state=0');
    assert.equal(full.body.warehouse_states.length, 3);
    assert.deepEqual(Object.keys(full.body.warehouse_states[0]).sort(), ['cost', 'id', 'name', 'quantity', 'unit']);
    assert.deepEqual(full.body.warehouse_live_ids.length, 3);
    await ctx.api('DELETE', `/api/warehouse/${a.id}`, { token: owner });
    const after = await snap(owner, 'after_warehouse_state=0');
    assert.equal(after.body.warehouse_live_ids.includes(Number(a.id)), false);
    const cont = await snap(owner, `after_warehouse_state=${after.body.cursors.warehouse_state}`);
    assert.equal('warehouse_live_ids' in cont.body, false);
    // Un cambio de cantidad aparece en estados.
    await ctx.api('PUT', `/api/warehouse/${b.id}`, { token: owner, body: { name: 'Arroz', cost: 3, quantity: 4 } });
    const st = await snap(owner, 'after_warehouse_state=0');
    assert.equal(st.body.warehouse_states.find((s) => s.id === Number(b.id)).quantity, 4);
  });

  await t.test('transferencias y entradas de stock con cursor propio', async () => {
    const { owner } = await shop();
    const item = await addItem(owner, 'Harina');
    for (let i = 0; i < 2; i++) {
      const tr = await ctx.api('POST', '/api/warehouse/transfer', { token: owner, body: { warehouse_item_id: item.id, quantity: 1, sale_price: 10, client_transfer_id: `t${i}` } });
      assert.ok(tr.status < 300, JSON.stringify(tr.body));
    }
    const p = await snap(owner, `${NEW}&limit=1`);
    assert.equal(p.body.warehouse_transfers.length, 1);
    assert.equal(p.body.stock_entries.length, 1);
    const q = await snap(owner, `after_warehouse_transfer=${p.body.cursors.warehouse_transfer}&after_stock_entry=${p.body.cursors.stock_entry}`);
    assert.equal(q.body.warehouse_transfers.length, 1);
    assert.ok(q.body.cursors.warehouse_transfer > p.body.cursors.warehouse_transfer);
    assert.ok(q.body.stock_entries.every((e) => e.id > p.body.cursors.stock_entry));
    const end = await snap(owner, `after_warehouse_transfer=${q.body.cursors.warehouse_transfer}`);
    assert.deepEqual(end.body.warehouse_transfers, []);
    assert.equal(end.body.cursors.warehouse_transfer, q.body.cursors.warehouse_transfer);
  });

  await t.test('cajero no los recibe', async () => {
    const { owner, cashier } = await shop();
    await addItem(owner, 'Aceite');
    const r = await snap(cashier.token, NEW);
    assert.equal(r.status, 200);
    for (const k of ['warehouse_items', 'warehouse_states', 'warehouse_transfers', 'stock_entries']) assert.equal(k in r.body, false, k);
    for (const k of ['warehouse', 'warehouse_state', 'warehouse_transfer', 'stock_entry']) assert.equal(k in r.body.cursors, false, k);
  });

  await t.test('almacén deshabilitado: sin artículos ni pases, pero sí entradas de stock', async () => {
    const { owner } = await shop();
    await addItem(owner, 'Aceite');
    const me = await ctx.api('GET', '/api/auth/me', { token: owner });
    await ctx.db.execute({ sql: 'UPDATE users SET warehouse_enabled = 0 WHERE id = ?', args: [me.body.user.id] });
    const r = await snap(owner, NEW);
    assert.equal('warehouse_items' in r.body, false);
    assert.equal('warehouse_transfers' in r.body, false);
    assert.ok(Array.isArray(r.body.stock_entries));
  });

  await t.test('dueño en caja central sí; cajero del aparato no', async () => {
    const admin = 'brianadmin@aldia.cu';
    await ctx.db.execute({
      sql: `INSERT INTO users (email, password_hash, store_name, plan, plan_status, is_admin) VALUES (?, ?, 'Admin', 'enterprise', 'active', 1)`,
      args: [admin, bcrypt.hashSync('test1234', 10)],
    });
    const adminToken = (await ctx.api('POST', '/api/auth/login', { body: { email: admin, password: 'test1234' } })).body.token;
    const s = suffix();
    const owner = await registerUser(ctx.api, `d-${s}@test.local`);
    const ownerId = Number((await ctx.api('GET', '/api/auth/me', { token: owner })).body.user.id);
    const cashier = await createCashier(ctx.api, owner, { email: `c-${s}@test.local` });
    await addItem(owner, 'Aceite');
    const dev = await ctx.api('POST', '/api/admin/shared-devices', {
      token: adminToken,
      body: { owner_id: ownerId, name: 'Caja', continuous: true, central: true, owner: { display_name: 'Dueño' },
        cashiers: [{ id: Number(cashier.id), display_name: 'Ana' }] },
    });
    assert.equal(dev.status, 201, JSON.stringify(dev.body));
    const ot = dev.body.cashiers.find((c) => c.role === 'dueño').token;
    const ct = dev.body.cashiers.find((c) => c.role === 'cajero').token;
    const o = await snap(ot, NEW);
    assert.equal(o.body.warehouse_items.length, 1);
    assert.ok(o.body.shared_device.central);
    const c = await snap(ct, NEW);
    assert.equal('warehouse_items' in c.body, false);
    assert.equal('stock_entries' in c.body, false);
  });
});
