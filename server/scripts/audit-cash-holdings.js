#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');
const { paymentSplit, purchaseSplit, withdrawalSplit, round2 } = require('../lib/payment');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

async function rows(tx, sql, args = []) {
  return (await tx.execute({ sql, args })).rows;
}

function emptyTotals() {
  return { cash: 0, transfer: 0, usd: 0, eur: 0 };
}

function addTotals(target, parts) {
  for (const key of Object.keys(target)) target[key] += Number(parts[key]) || 0;
}

function roundedTotals(totals) {
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round2(value)]));
}

function groupedSales(sales) {
  const groups = {};
  for (const sale of sales) {
    const method = sale.payment_method || 'desconocido';
    groups[method] ||= emptyTotals();
    addTotals(groups[method], paymentSplit(sale));
  }
  return Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, roundedTotals(value)]));
}

function groupedWithdrawals(withdrawals) {
  const groups = {};
  for (const withdrawal of withdrawals) {
    const method = withdrawal.method || 'desconocido';
    groups[method] ||= emptyTotals();
    addTotals(groups[method], withdrawalSplit(withdrawal));
  }
  return Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, roundedTotals(value)]));
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch {}
  if (!url || !/^(libsql|https?):\/\//i.test(url) || !authToken
      || ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) {
    throw new Error('Se requiere TURSO_DATABASE_URL remota y TURSO_AUTH_TOKEN en server/.env.');
  }

  const client = createClient({ url, authToken });
  let tx;
  try {
    tx = await client.transaction('read');
    const candidates = await rows(tx, `
      SELECT id, email, store_name, owner_id, role FROM users
      WHERE lower(coalesce(email, '')) LIKE '%monte%'
         OR lower(coalesce(store_name, '')) LIKE '%monte%'
      ORDER BY id
    `);

    const stores = [];
    const seenStoreIds = new Set();
    for (const candidate of candidates) {
      const shopUserId = Number(candidate.owner_id || candidate.id);
      if (!Number.isSafeInteger(shopUserId) || seenStoreIds.has(shopUserId)) continue;
      seenStoreIds.add(shopUserId);

      const resolvedAccount = (await rows(tx,
        'SELECT id, email, store_name, owner_id, role FROM users WHERE id = ?', [shopUserId]))[0] || null;
      const latestClose = (await rows(tx, `
        SELECT id, opened_at, closed_at, opening_float, expected_cash, counted_cash,
               difference, expected_transfer, sales_count, expected_usd, counted_usd,
               difference_usd, expected_eur, counted_eur, difference_eur,
               account_id, account_email, register_id
        FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC LIMIT 1
      `, [shopUserId]))[0] || null;

      const sales = await rows(tx, `
        SELECT id, client_sale_id, created_at, payment_method, total, transfer_amount,
               foreign_currency, foreign_amount, exchange_rate, account_email, register_id
        FROM sales WHERE user_id = ? AND cash_close_id IS NULL
        ORDER BY created_at, id
      `, [shopUserId]);
      const saleItems = new Map();
      if (sales.length) {
        const saleIds = sales.map((sale) => Number(sale.id));
        const placeholders = saleIds.map(() => '?').join(',');
        const items = await rows(tx, `
          SELECT sale_id, product_name, quantity, unit_price
          FROM sale_items WHERE sale_id IN (${placeholders}) ORDER BY sale_id, id
        `, saleIds);
        for (const item of items) {
          const saleId = Number(item.sale_id);
          if (!saleItems.has(saleId)) saleItems.set(saleId, []);
          saleItems.get(saleId).push({
            product_name: item.product_name,
            quantity: item.quantity,
            unit_price: item.unit_price,
          });
        }
      }
      const salesTotals = emptyTotals();
      const salesWithCash = sales.map((sale) => {
        const split = paymentSplit(sale);
        addTotals(salesTotals, split);
        return {
          ...sale,
          items: saleItems.get(Number(sale.id)) || [],
          cash_contribution: round2(split.cash),
          payment_split: roundedTotals(split),
        };
      });

      const purchases = await rows(tx, `
        SELECT id, client_purchase_id, created_at, foreign_currency, foreign_amount,
               exchange_rate, cup_amount, account_email, register_id
        FROM currency_purchases WHERE user_id = ? AND cash_close_id IS NULL
        ORDER BY created_at, id
      `, [shopUserId]);
      const purchaseTotals = emptyTotals();
      const purchasesWithCash = purchases.map((purchase) => {
        const split = purchaseSplit(purchase);
        addTotals(purchaseTotals, split);
        return { ...purchase, cash_contribution: round2(split.cash), payment_split: roundedTotals(split) };
      });

      // Include voids even if already linked to a close; only open, non-voided
      // rows affect dashboard holdings.
      const withdrawals = await rows(tx, `
        SELECT id, client_withdrawal_id, created_at, method, amount, note,
               cash_close_id, voided_at, account_email, register_id
        FROM cash_withdrawals WHERE user_id = ? AND (cash_close_id IS NULL OR voided_at IS NOT NULL)
        ORDER BY created_at DESC, id DESC
      `, [shopUserId]);
      const withdrawalTotals = emptyTotals();
      const withdrawalsWithCash = withdrawals.map((withdrawal) => {
        const isDashboardOpen = withdrawal.cash_close_id == null && !withdrawal.voided_at;
        const split = isDashboardOpen ? withdrawalSplit(withdrawal) : emptyTotals();
        addTotals(withdrawalTotals, split);
        return {
          ...withdrawal,
          cash_contribution: round2(split.cash),
          payment_split: roundedTotals(split),
          included_in_dashboard_holdings: isDashboardOpen,
        };
      });

      const dashboardHoldings = roundedTotals({
        cash: salesTotals.cash + purchaseTotals.cash + withdrawalTotals.cash,
        transfer: salesTotals.transfer + purchaseTotals.transfer + withdrawalTotals.transfer,
        usd: salesTotals.usd + purchaseTotals.usd + withdrawalTotals.usd,
        eur: salesTotals.eur + purchaseTotals.eur + withdrawalTotals.eur,
      });
      const openingFloat = latestClose ? Number(latestClose.opening_float) || 0 : 0;

      stores.push({
        candidate_accounts: candidates.filter((account) => Number(account.owner_id || account.id) === shopUserId),
        resolved_store_account: resolvedAccount,
        shop_user_id: shopUserId,
        latest_cash_close: latestClose,
        open_sales: salesWithCash,
        open_purchases: purchasesWithCash,
        open_and_voided_withdrawals: withdrawalsWithCash,
        totals: {
          sales_by_payment_method: groupedSales(sales),
          open_sales: roundedTotals(salesTotals),
          open_purchases: roundedTotals(purchaseTotals),
          open_withdrawals_by_method: groupedWithdrawals(withdrawals),
          active_open_withdrawals: roundedTotals(withdrawalTotals),
          dashboard_holdings_exact: dashboardHoldings,
          latest_close_opening_float: round2(openingFloat),
          opening_float_contribution_to_dashboard_holdings: 0,
        },
      });
    }

    await tx.commit();
    tx = null;
    process.stdout.write(`${JSON.stringify({
      generated_at: new Date().toISOString(),
      calculation: 'dashboard_holdings_exact suma movimientos abiertos usando paymentSplit, purchaseSplit y withdrawalSplit. opening_float se informa desde el último cierre, pero su contribución al holding es 0.',
      candidate_accounts: candidates,
      stores,
    }, null, 2)}\n`);
  } finally {
    if (tx) await tx.rollback().catch(() => {});
    await client.close();
  }
}

main().catch((error) => {
  let message = String(error.message || error);
  for (const secret of [process.env.TURSO_AUTH_TOKEN, process.env.TURSO_DATABASE_URL]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
