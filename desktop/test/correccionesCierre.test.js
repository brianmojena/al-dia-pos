const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalDb } = require('./helpers');

test('correcciones de cierres en Electron', async (t) => {
  await t.test('detalle GET y PUT owner-only traducen ID local a ID servidor y actualizan caché', async () => {
    const ctx = startLocalDb();
    const apiClient = require('../src/sync/apiClient');
    const previousRequest = apiClient.apiRequest;
    try {
      ctx.queries.setSession({ user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 'owner-token', role: 'dueño' });
      const local = ctx.queries.createCashCloseLocal({ opening_float: 100, counted_cash: 125, counted_usd: 0, counted_eur: 0 });
      const otherLocal = ctx.queries.createCashCloseLocal({ opening_float: 20, counted_cash: 20, counted_usd: 0, counted_eur: 0 });
      const remoteId = Number(otherLocal.id);
      ctx.db.prepare('UPDATE cash_closes SET server_id = 77 WHERE id = ?').run(otherLocal.id);
      ctx.db.prepare('UPDATE cash_closes SET server_id = ?, expected_cash = 120, difference = 5, correction_revision = 0 WHERE id = ?').run(remoteId, local.id);
      const serverClose = {
        id: remoteId, client_close_id: local.client_close_id, opened_at: local.opened_at, closed_at: local.closed_at,
        opening_float: 100, expected_cash: 120, counted_cash: 125, difference: 5,
        expected_transfer: 0, sales_count: 0, expected_usd: 0, counted_usd: 0, difference_usd: 0,
        expected_eur: 0, counted_eur: 0, difference_eur: 0, withdrawn_cash: 0,
        withdrawn_transfer: 0, withdrawn_usd: 0, withdrawn_eur: 0, note: null,
        corrected_at: null, original_expected_cash: null, original_difference: null, correction_revision: 0,
        corrections: [],
      };
      const correction = { id: 501, cash_close_id: remoteId, correction_revision: 1, account_id: 1,
        account_email: 'dueno@mitienda.cu', before: { counted_cash: 125, opening_float: 100 },
        after: { counted_cash: 120, opening_float: 100 }, created_at: '2026-10-15 12:00:00' };
      const revised = { ...serverClose, expected_cash: 120, counted_cash: 120, difference: 0,
        original_expected_cash: 120, original_difference: 5, corrected_at: '2026-10-15 12:00:00', correction_revision: 1 };
      const requests = [];
      apiClient.apiRequest = async (method, path, options = {}) => {
        requests.push({ method, path, options });
        if (method === 'GET') return { ok: true, status: 200, data: { ...serverClose, corrections: [] } };
        const serverId = Number(path.split('/').at(-1));
        const row = serverId === remoteId ? revised : { ...revised, id: 77, client_close_id: otherLocal.client_close_id };
        const audit = serverId === remoteId ? correction : { ...correction, id: 502, cash_close_id: 77 };
        return { ok: true, status: 200, data: { cash_close: { ...row, corrections: [audit] }, correction: audit } };
      };
      const { routeRequest } = require('../src/router');
      const detail = await routeRequest('GET', `/api/cash-closes/${local.id}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(requests[0], { method: 'GET', path: `/api/cash-closes/${remoteId}`, options: { token: 'owner-token' } });
      assert.equal(detail.data.id, local.id, 'el detalle mantiene la identidad local seleccionada');
      assert.equal(detail.data.server_id, remoteId);
      const body = { opening_float: 100, counted_cash: 120, counted_usd: 0, counted_eur: 0, note: null, correction_revision: 0 };
      const saved = await routeRequest('PUT', `/api/cash-closes/${local.id}`, body);
      assert.equal(saved.status, 200);
      assert.equal(requests[1].method, 'PUT');
      assert.equal(requests[1].path, `/api/cash-closes/${remoteId}`);
      assert.deepEqual(requests[1].options.body, body);
      const cache = ctx.queries.getCashClose(local.id);
      assert.equal(cache.difference, 0);
      assert.equal(cache.correction_revision, 1);
      assert.equal(cache.original_difference, 5);
      assert.equal(ctx.queries.getCashCloseDetail(local.id).corrections[0].id, 501);
      assert.equal(saved.data.cash_close.id, local.id);
      assert.equal(saved.data.cash_close.server_id, remoteId);
      const secondSaved = await routeRequest('PUT', `/api/cash-closes/${otherLocal.id}`, body);
      assert.equal(secondSaved.status, 200);
      assert.equal(requests[2].path, '/api/cash-closes/77', 'la ruta usa el ID local y reenvía el server_id de esa fila');
      assert.equal(secondSaved.data.cash_close.id, otherLocal.id);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 2, 'solo quedan encolados ambos cierres, no las correcciones');
    } finally {
      apiClient.apiRequest = previousRequest;
      ctx.close();
    }
  });

  await t.test('cajero no puede editar y cierre pendiente se ve local sin reenvío', async () => {
    const ctx = startLocalDb();
    const apiClient = require('../src/sync/apiClient');
    const previousRequest = apiClient.apiRequest;
    try {
      const local = ctx.queries.createCashCloseLocal({ opening_float: 50, counted_cash: 40, counted_usd: 0, counted_eur: 0 });
      let calls = 0;
      apiClient.apiRequest = async () => { calls++; throw new Error('no debe llamar al servidor'); };
      const { routeRequest } = require('../src/router');
      const detail = await routeRequest('GET', `/api/cash-closes/${local.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.data.pending, true);
      const denied = await routeRequest('PUT', `/api/cash-closes/${local.id}`, {
        opening_float: 0, counted_cash: 0, counted_usd: 0, counted_eur: 0, note: null, correction_revision: 0,
      });
      assert.equal(denied.status, 403);
      assert.equal(calls, 0);
      ctx.queries.setSession({ user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 'owner-token', role: 'dueño' });
      const ownerPending = await routeRequest('PUT', `/api/cash-closes/${local.id}`, {
        opening_float: 0, counted_cash: 0, counted_usd: 0, counted_eur: 0, note: null, correction_revision: 0,
      });
      assert.equal(ownerPending.status, 409, 'no se corrige hasta confirmar server_id');
      assert.equal(calls, 0);
    } finally {
      apiClient.apiRequest = previousRequest;
      ctx.close();
    }
  });

  await t.test('delta aplica auditoría nueva aunque ya pasó el cursor del cierre', () => {
    const ctx = startLocalDb();
    try {
      ctx.queries.setSession({ user_id: 1, email: 'dueno@mitienda.cu', store_name: 'Tienda', plan: 'dev', token: 'owner-token', role: 'dueño' });
      const local = ctx.queries.createCashCloseLocal({ opening_float: 10, counted_cash: 25, counted_usd: 0, counted_eur: 0 });
      ctx.db.prepare('UPDATE cash_closes SET server_id = 7, correction_revision = 0 WHERE id = ?').run(local.id);
      const close = { id: 7, client_close_id: local.client_close_id, opened_at: local.opened_at, closed_at: local.closed_at,
        opening_float: 10, expected_cash: 20, counted_cash: 20, difference: 0, expected_transfer: 0,
        sales_count: 0, note: 'actualizada', expected_usd: 0, counted_usd: 0, difference_usd: 0,
        expected_eur: 0, counted_eur: 0, difference_eur: 0, withdrawn_cash: 0, withdrawn_transfer: 0,
        withdrawn_usd: 0, withdrawn_eur: 0, corrected_at: '2026-10-15 12:00:00',
        original_expected_cash: 20, original_difference: 5, correction_revision: 1 };
      const correction = { id: 22, cash_close_id: 7, correction_revision: 1, account_id: 1,
        account_email: 'dueno@mitienda.cu', before: JSON.stringify({ difference: 5 }),
        after: JSON.stringify({ difference: 0 }), created_at: close.corrected_at, cash_close: close };
      const stats = ctx.queries.applyServerDelta({ sales: [], cash_closes: [], inventory_counts: [],
        cash_close_corrections: [correction],
        cursors: { sale: 0, close: 7, count: 0, close_correction: 22 }, has_more: false });
      assert.equal(stats.close_corrections, 1);
      assert.equal(ctx.queries.getCashClose(local.id).difference, 0);
      assert.equal(ctx.queries.getCashClose(local.id).note, 'actualizada');
      assert.equal(ctx.queries.getCashClose(local.id).correction_revision, 1);
      assert.equal(ctx.queries.getSyncState('delta_after_close_correction'), '22');
      assert.equal(ctx.queries.getCashCloseDetail(local.id).corrections[0].id, 22);
    } finally { ctx.close(); }
  });
});
