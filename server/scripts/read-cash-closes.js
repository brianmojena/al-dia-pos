#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');
const { paymentSplit, purchaseSplit, withdrawalSplit, round2 } = require('../lib/payment');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

function sumSplit(rows, split) {
  return rows.reduce((total, row) => {
    const parts = split(row);
    total.cash += parts.cash;
    total.transfer += parts.transfer;
    total.usd += parts.usd;
    total.eur += parts.eur;
    return total;
  }, { cash: 0, transfer: 0, usd: 0, eur: 0 });
}

function rounded(parts) {
  return Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, round2(value)]));
}

async function rows(tx, sql, args = []) {
  return (await tx.execute({ sql, args })).rows;
}

async function main() {
  const email = option('--email');
  if (!email) throw new Error('Uso: node scripts/read-cash-closes.js --email cuenta@tienda.cu');

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !/^(libsql|https?):\/\//i.test(url) || !authToken) {
    throw new Error('Se requiere TURSO_DATABASE_URL remota y TURSO_AUTH_TOKEN en server/.env.');
  }

  const client = createClient({ url, authToken });
  let tx;
  try {
    tx = await client.transaction('read');
    const accounts = await rows(tx,
      `SELECT id, email, store_name, owner_id, role
         FROM users WHERE lower(trim(email)) = lower(trim(?))`, [email]);
    if (accounts.length !== 1) {
      throw new Error(accounts.length ? 'El email coincide con más de una cuenta.' : 'No se encontró la cuenta indicada.');
    }

    const account = accounts[0];
    const shopUserId = Number(account.owner_id || account.id);
    const closes = await rows(tx,
      'SELECT * FROM cash_closes WHERE user_id = ? ORDER BY closed_at DESC, id DESC', [shopUserId]);

    const linkedMovements = [];
    for (const close of closes) {
      const args = [shopUserId, Number(close.id)];
      const sales = await rows(tx,
        `SELECT total, payment_method, transfer_amount, foreign_currency, foreign_amount, exchange_rate
           FROM sales WHERE user_id = ? AND cash_close_id = ?`, args);
      const purchases = await rows(tx,
        `SELECT foreign_currency, foreign_amount, cup_amount
           FROM currency_purchases WHERE user_id = ? AND cash_close_id = ?`, args);
      const withdrawals = await rows(tx,
        `SELECT method, amount, voided_at FROM cash_withdrawals
          WHERE user_id = ? AND cash_close_id = ?`, args);

      const salesTotals = rounded(sumSplit(sales, paymentSplit));
      const purchaseTotals = rounded(sumSplit(purchases, purchaseSplit));
      const withdrawalTotals = rounded(sumSplit(withdrawals, withdrawalSplit));
      const expectedFromLinked = rounded({
        cash: Number(close.opening_float || 0) + salesTotals.cash + purchaseTotals.cash + withdrawalTotals.cash,
        transfer: salesTotals.transfer + purchaseTotals.transfer + withdrawalTotals.transfer,
        usd: salesTotals.usd + purchaseTotals.usd + withdrawalTotals.usd,
        eur: salesTotals.eur + purchaseTotals.eur + withdrawalTotals.eur,
      });

      linkedMovements.push({
        cash_close_id: Number(close.id),
        stored_sales_count: Number(close.sales_count || 0),
        linked_sales_count: sales.length,
        linked_purchase_count: purchases.length,
        linked_withdrawal_count: withdrawals.length,
        sales: salesTotals,
        purchases: purchaseTotals,
        withdrawals: withdrawalTotals,
        expected_from_linked_movements: expectedFromLinked,
      });
    }

    await tx.commit();
    tx = null;
    process.stdout.write(`${JSON.stringify({ account, shop_user_id: shopUserId, cash_closes: closes, linked_movements: linkedMovements }, null, 2)}\n`);
  } finally {
    if (tx) await tx.rollback().catch(() => {});
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
