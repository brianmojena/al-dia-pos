// Usar una copia de desktop con better-sqlite3 compilado para el Node anfitrión.
// node diagnosticos-desktop.cjs /ruta/desktop [ruta-resultados.json]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const desktop = path.resolve(process.argv[2] || path.join(__dirname, '../../desktop'));
const apiPath = require.resolve(path.join(desktop, 'src/sync/apiClient'));
let respond = async () => ({ ok: false, status: 404, data: {} });
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: { apiRequest: (...args) => respond(...args) } };
const { startLocalDb, crearProductoSincronizado } = require(path.join(desktop, 'test/helpers'));
const { syncOnce, buildRequest } = require(path.join(desktop, 'src/sync/syncWorker'));
const auth = require(path.join(desktop, 'src/auth'));
const results = { environment: { node: process.version, native_copy: desktop }, diagnostics: {} };
async function main() {
  const ctx = startLocalDb();
  try {
    const { queries: q, db } = ctx;
    const product = crearProductoSincronizado(q, { stock: 1000 });
    db.prepare("UPDATE outbox SET status='synced'").run();
    const sale = q.createSaleLocal({ client_sale_id: 'provided-by-ui', items: [{ product_id: product.id, quantity: 1, unit_price: 100 }] });
    db.prepare("UPDATE sales SET created_at='2026-10-15 14:00:00' WHERE id=?").run(sale.id);
    const row = db.prepare("SELECT * FROM outbox WHERE op_type='sale.create' ORDER BY id LIMIT 1").get();
    const request = buildRequest(db, row);
    results.diagnostics.sale_timestamp = { local_created_at: '2026-10-15 14:00:00', sent_sold_at: request.body.sold_at ?? null, original_ui_id: 'provided-by-ui', stored_sale_id: sale.client_sale_id };
    const repeat = q.createSaleLocal({ client_sale_id: 'provided-by-ui', items: [{ product_id: product.id, quantity: 1, unit_price: 100 }] });
    results.diagnostics.local_sale_idempotency = { supplied_same_id: true, first_saved_id: sale.client_sale_id, second_saved_id: repeat.client_sale_id, rows: db.prepare('SELECT COUNT(*) n FROM sales').get().n };

    const packBefore = q.listProducts()[0].stock;
    const pack = q.createSaleLocal({ items: [{ product_id: product.id, quantity: 1, unit_price: 1000, pack_size: 12 }] });
    results.diagnostics.pack_contract = { initial_stock: packBefore, requested_pack_size: 12, quantity: 1, expected_stock: packBefore - 12, actual_stock: q.listProducts()[0].stock, expected_cost: 12 * product.purchase_price, actual_profit: pack.profit, note: 'El esquema de productos local tampoco almacena pack_size/pack_price' };

    // El router puede llamar syncOnce mientras el loop periódico sigue activo.
    db.prepare("UPDATE outbox SET status='synced'").run();
    q.updateProduct(product.id, { add_stock:5 });
    let arrived, release;
    const firstArrived = new Promise(resolve => { arrived = resolve; });
    const firstReleased = new Promise(resolve => { release = resolve; });
    let additions = 0;
    respond = async (method, pathname) => {
      if (method === 'PUT' && pathname.startsWith('/api/products/')) {
        additions++;
        if (additions === 1) { arrived(); await firstReleased; }
        return { ok:true, status:200, data:{ id:1000+product.id } };
      }
      return { ok:false, status:404, data:{} };
    };
    const firstSync = syncOnce();
    await firstArrived;
    await syncOnce();
    release();
    await firstSync;
    results.diagnostics.overlapping_sync = { local_addition:5, put_requests:additions, same_outbox_operation:true, note:'resetStuckSyncing rescata una operación todavía en vuelo en la otra pasada' };
    assert.equal(additions,2);

    // 50 conflictos ocupan la ventana FIFO; la venta 51 permanece pendiente.
    db.prepare("UPDATE outbox SET status='synced'").run();
    for (let i = 0; i < 51; i++) q.createSaleLocal({ items: [{ product_id: product.id, quantity: 1, unit_price: 100 }] });
    const selected = q.getPendingOutbox();
    for (const item of selected) db.prepare("UPDATE outbox SET status='conflict' WHERE id=?").run(item.id);
    const last = db.prepare("SELECT id FROM outbox WHERE status='pending' ORDER BY id DESC LIMIT 1").get();
    const attempted = [];
    respond = async (method, pathname, opts) => {
      if (method === 'POST' && pathname === '/api/sales') { attempted.push(opts.body.client_sale_id); return { ok:false, status:409, data:{ error:'Conflicto de stock' } }; }
      return { ok:false, status:404, data:{} };
    };
    const tick1 = await syncOnce(), tick2 = await syncOnce();
    results.diagnostics.conflict_starvation = { conflicts_at_head: 50, requests_after_two_ticks: attempted.length, pending_last_id: last.id, pending_last_status: db.prepare('SELECT status FROM outbox WHERE id=?').get(last.id).status, first_tick_processed: tick1.processed, second_tick_processed: tick2.processed, selected_again: q.getPendingOutbox().some(r => r.id === last.id) };

    // El guard de login compara accountId de la sesión anterior, no el ownerId.
    respond = async (method, pathname) => {
      if (pathname === '/api/auth/login') return { ok:true, status:200, data:{ token:'other-test-token', user:{ id:2, email:'second@test.local', role:'cajero', store_name:'Misma tienda', plan:'basic' } } };
      return { ok:false, status:503, data:{} };
    };
    let refused = null;
    try { await auth.login('second@test.local','test-only'); } catch (e) { refused = e.message; }
    results.diagnostics.cashier_change = { existing_account_id:q.getSession().user_id, new_account_id:2, message:refused, note:'publicUser.id es accountId; el perfil no expone owner_id' };
    auth.logout();
    await auth.login('second@test.local','test-only');
    results.diagnostics.account_guard_after_logout = { session_user_id:q.getSession().user_id, old_products_still_visible:q.listProducts().length, old_sales_still_present:db.prepare('SELECT COUNT(*) n FROM sales').get().n, note:'Llamada directa al logout exportado; la UI no invoca este logout de SQLite' };

    assert.equal(results.diagnostics.conflict_starvation.pending_last_status,'pending');
    assert.equal(results.diagnostics.local_sale_idempotency.rows,2);
  } finally { ctx.close(); }
  fs.writeFileSync(path.resolve(process.argv[3] || '/private/tmp/mypimes-audit-desktop-results.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
}
main().catch(error => { console.error(error); process.exitCode=1; });
